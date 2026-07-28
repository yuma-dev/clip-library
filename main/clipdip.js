// Integrated clipdip (the recorder binary) — process lifecycle + config bridge.
//
// Clipdip is a standalone tray app: we spawn it fully detached so it
// survives the library quitting, and control the running instance through
// its single-instance guard (`clipdip.exe --reload` / `--quit` forward the
// flag into the running process and exit). Its settings live in a TOML file
// (%APPDATA%\clipdip\config\config.toml) that we read/write directly; the
// running clipdip picks changes up via --reload.
const { app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { spawn, execFile } = require('child_process');
const net = require('net');
const TOML = require('smol-toml');
const logger = require('../utils/logger');

const EXE_NAME = 'clipdip.exe';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ClipLib';
const RUN_VALUE_LEGACY = 'ClipDip';

const configPath = () =>
  path.join(app.getPath('appData'), 'clipdip', 'config', 'config.toml');

// Written by the running clipdip primary instance ({port, token, pid});
// best-effort deleted on its exit, so treat it as possibly stale.
const controlJsonPath = () =>
  path.join(path.dirname(configPath()), 'control.json');

let getSettings = async () => ({});

function init(settingsGetter) {
  getSettings = settingsGetter;
}

async function resolveBinaryPath() {
  const settings = await getSettings();
  const override = settings?.clipdip?.binaryPath;
  if (override && typeof override === 'string' && override.trim()) {
    const p = override.trim();
    // The picker hands us a folder; a direct exe path also works.
    return p.toLowerCase().endsWith('.exe') ? p : path.join(p, EXE_NAME);
  }
  if (!app.isPackaged) {
    // Dev convenience: use the in-repo cargo build (clipdip/ subtree) or the
    // vendored copy, so clipdip works without configuring a path.
    const candidates = [
      path.resolve(__dirname, '..', 'clipdip', 'target', 'release', EXE_NAME),
      path.resolve(__dirname, '..', 'vendor', 'clipdip', EXE_NAME)
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return path.join(process.resourcesPath, 'clipdip', EXE_NAME);
}

async function binaryFound() {
  try {
    await fsp.access(await resolveBinaryPath(), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------- config bridge --------------------------------------------------

async function getConfig() {
  try {
    const raw = await fsp.readFile(configPath(), 'utf8');
    return { exists: true, config: TOML.parse(raw) };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(`Clipdip config read failed: ${error.message}`);
    }
    return { exists: false, config: {} };
  }
}

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      // Mode-tagged enum tables (rate_control, recording_quality) must be
      // replaced whole: merging would leave stale variant fields (e.g. a qp
      // key inside {mode = "match_clips"}) that serde rejects.
      !('mode' in value) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

// smol-toml drops comments on rewrite — keep a one-time snapshot of the
// user's original file as a courtesy.
async function snapshotOnce(file) {
  const bak = `${file}.bak`;
  try {
    await fsp.access(bak);
  } catch {
    try {
      await fsp.copyFile(file, bak);
    } catch {
      /* no original file — nothing to snapshot */
    }
  }
}

let reloadTimer = null;
// Highest reload level needed by the patches since the last flush.
// 0 = none (clipdip re-reads these sections per operation), 1 = hotkeys only,
// 2 = full pipeline restart (clears the replay buffer — only when capture
// settings actually changed).
let pendingReload = 0;

// Output keys the pipeline captures at start (used at mux time from the
// startup snapshot). directory/filename_stem are re-read per save and need
// no reload.
const OUTPUT_RESTART_KEYS = ['audio_bitrate_bps', 'ffmpeg_path', 'keep_sidecars'];

function reloadLevelFor(patch) {
  let level = 0;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'video' || key === 'audio' || key === 'replay_seconds') return 2;
    if (key === 'output' && value && typeof value === 'object' &&
        OUTPUT_RESTART_KEYS.some((k) => k in value)) {
      return 2;
    }
    if (key === 'hotkey') level = Math.max(level, 1);
  }
  return level;
}

async function setConfig(patch) {
  const file = configPath();
  await snapshotOnce(file);
  const { config } = await getConfig();
  deepMerge(config, patch);
  const serialized = TOML.stringify(config);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, serialized, 'utf8');
  await fsp.rename(tmp, file);

  // Debounce the reload: a full restart clears clipdip's replay buffer,
  // so a burst of settings edits should cost one restart, not one each.
  pendingReload = Math.max(pendingReload, reloadLevelFor(patch));
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    const level = pendingReload;
    pendingReload = 0;
    if (level === 0) return;
    isRunning()
      .then((running) =>
        running ? sendControlFlag(level === 2 ? '--reload' : '--reload-hotkeys') : null
      )
      .catch((error) => logger.warn(`Clipdip reload failed: ${error.message}`));
  }, 1500);

  return { success: true };
}

// ---------- process lifecycle ----------------------------------------------

let runningCache = { value: false, at: 0 };

function isRunning() {
  if (Date.now() - runningCache.at < 2000) {
    return Promise.resolve(runningCache.value);
  }
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true },
      (error, stdout) => {
        const running = !error && typeof stdout === 'string' && stdout.toLowerCase().includes(EXE_NAME);
        runningCache = { value: running, at: Date.now() };
        resolve(running);
      }
    );
  });
}

// clipdip needs an ffmpeg for muxing, but we don't ship one next to it —
// the library already bundles ffmpeg-static. Point clipdip's config at it
// whenever the configured path is missing or stale (e.g. after an app update
// moved the unpacked asar path). Deliberate user overrides that still exist
// on disk are left alone.
async function ensureFfmpegPath() {
  let libFfmpeg;
  try {
    libFfmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
  } catch {
    return; // clipdip falls back to a sibling ffmpeg or PATH
  }
  if (!fs.existsSync(libFfmpeg)) return;
  const { config } = await getConfig();
  const current = config?.output?.ffmpeg_path;
  if (current && current !== libFfmpeg && fs.existsSync(current)) return;
  if (current === libFfmpeg) return;
  logger.info(`Pointing clipdip at the library ffmpeg: ${libFfmpeg}`);
  // clipdip's own startup may rewrite the config at the same moment (its
  // one-time migration save fires on the first post-update launch, and an
  // autostarted clipdip races this exact boot). A lost write here would
  // resurrect the dead pre-update ffmpeg path until the next settings-
  // driven restart, so verify the write landed and re-apply if not.
  for (let attempt = 0; attempt < 3; attempt++) {
    await setConfig({ output: { ffmpeg_path: libFfmpeg } });
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    const check = await getConfig().catch(() => null);
    if (check?.config?.output?.ffmpeg_path === libFfmpeg) return;
    logger.warn('ffmpeg path write did not stick, retrying');
  }
  logger.warn('ffmpeg path kept reverting; giving up until next start');
}

// Clipdip must always save somewhere that exists — its save pipeline fails
// outright when the output directory is missing, and its own default
// (Videos\Clipdip) is never created up front. Whenever the configured
// directory is unset or gone from disk, aim it at the library's clip folder
// so clips land in the library. Folders that exist (e.g. a pre-merge
// standalone clipdip setup or a deliberate override) are left alone.
async function ensureOutputDirectory() {
  const settings = await getSettings();
  const clipLocation = settings?.clipLocation;
  if (!clipLocation || !fs.existsSync(clipLocation)) return;
  const { config } = await getConfig();
  const current = config?.output?.directory;
  if (current && fs.existsSync(current)) return;
  logger.info(`Pointing clipdip output at the library clips folder: ${clipLocation}`);
  await setConfig({ output: { directory: clipLocation } });
}

async function start() {
  // Repair runs even when clipdip is already up: it re-reads the output
  // directory on every save, so no reload is needed for it to take effect.
  await ensureOutputDirectory().catch((e) =>
    logger.warn(`Clipdip output folder sync failed: ${e.message}`)
  );
  if (await isRunning()) return { success: true, alreadyRunning: true };
  const exe = await resolveBinaryPath();
  try {
    await fsp.access(exe, fs.constants.X_OK);
  } catch {
    return { success: false, error: `Clipdip binary not found at ${exe}` };
  }
  await ensureFfmpegPath().catch((e) => logger.warn(`ffmpeg path sync failed: ${e.message}`));
  // detached + unref + ignored stdio: clipdip must outlive the library —
  // it is its own tray app the user may rely on with the library closed.
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(exe),
    windowsHide: false
  });
  child.unref();
  runningCache = { value: true, at: Date.now() };
  logger.info(`Clipdip started (${exe})`);
  return { success: true };
}

function sendControlFlag(flag) {
  return resolveBinaryPath().then(
    (exe) =>
      new Promise((resolve) => {
        // The secondary instance forwards the flag to the running one and
        // exits on its own; fire and forget.
        execFile(exe, [flag], { windowsHide: true }, () => resolve());
      })
  );
}

async function quit() {
  if (!(await isRunning())) return { success: true, alreadyStopped: true };
  await sendControlFlag('--quit');
  // Graceful path first; hard-kill only if the process is still around.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    runningCache = { value: false, at: 0 }; // force fresh checks
    if (!(await isRunning())) return { success: true };
    await new Promise((r) => setTimeout(r, 400));
  }
  logger.warn('Clipdip did not exit after --quit; force-killing');
  await new Promise((resolve) => {
    execFile('taskkill', ['/F', '/IM', EXE_NAME], { windowsHide: true }, () => resolve());
  });
  runningCache = { value: false, at: 0 };
  return { success: true, forced: true };
}

async function restart() {
  await quit();
  return start();
}

// ---------- stateless CLI queries -------------------------------------------
// Clipdip handles these flags before its tauri/single-instance init: it
// prints one JSON line to stdout and exits, no running instance needed.

// The exe may log noise before/after the payload; take the last line that
// parses as JSON.
function lastJsonLine(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* not the payload line */
    }
  }
  return null;
}

async function query(flag, extraArgs = []) {
  let exe;
  try {
    exe = await resolveBinaryPath();
    await fsp.access(exe, fs.constants.X_OK);
  } catch {
    return { ok: false, error: 'binary_not_found' };
  }
  return new Promise((resolve) => {
    execFile(
      exe,
      [flag, ...extraArgs],
      { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        const parsed = lastJsonLine(stdout);
        if (parsed) return resolve(parsed);
        const message = error ? error.message : `no JSON output from ${flag}`;
        logger.warn(`Clipdip query ${flag} failed: ${message}`);
        resolve({ ok: false, error: message });
      }
    );
  });
}

const listAudioDevices = () => query('--list-audio-devices');
const listMonitors = () => query('--list-monitors');
const getFilenameVariables = () => query('--filename-variables');
const previewFilename = (template) => query('--preview-filename', [String(template ?? '')]);

// ---------- control server client (running instance) ------------------------
// The primary clipdip instance listens on 127.0.0.1 (ephemeral port, token in
// control.json next to config.toml), JSON-lines: one request line in, one
// response line out, connection closes. Never throws to the renderer.

const NOT_RUNNING = { ok: false, error: 'not_running' };

async function control(cmd, args) {
  let info;
  try {
    info = JSON.parse(await fsp.readFile(controlJsonPath(), 'utf8'));
  } catch {
    return { ...NOT_RUNNING };
  }
  if (!info || typeof info.port !== 'number' || typeof info.token !== 'string') {
    return { ...NOT_RUNNING };
  }
  return new Promise((resolve) => {
    let settled = false;
    let connectTimer = null;
    let responseTimer = null;
    const socket = net.connect({ host: '127.0.0.1', port: info.port });
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      socket.destroy();
      resolve(result);
    };
    connectTimer = setTimeout(() => done({ ...NOT_RUNNING }), 500);
    socket.on('connect', () => {
      clearTimeout(connectTimer);
      responseTimer = setTimeout(() => done({ ...NOT_RUNNING }), 5000);
      const request = { token: info.token, cmd: String(cmd) };
      if (args && typeof args === 'object') request.args = args;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, nl));
        done(parsed && typeof parsed === 'object' ? parsed : { ok: false, error: 'bad response' });
      } catch {
        done({ ok: false, error: 'bad response' });
      }
    });
    // Stale control.json (dead pid) surfaces as ECONNREFUSED here.
    socket.on('error', () => done({ ...NOT_RUNNING }));
    socket.on('close', () => done({ ...NOT_RUNNING }));
  });
}

// ---------- autostart (registry Run value, points at clipdip exe) ------

function regQuery(valueName) {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', RUN_KEY, '/v', valueName],
      { windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout)
    );
  });
}

async function getAutostart() {
  for (const name of [RUN_VALUE, RUN_VALUE_LEGACY]) {
    const out = await regQuery(name);
    if (out && out.toLowerCase().includes(EXE_NAME)) return true;
  }
  return false;
}

function regRun(args) {
  return new Promise((resolve, reject) => {
    execFile('reg', args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

async function setAutostart(enabled) {
  // Drop the pre-rebrand value either way so we never leave two entries.
  await regRun(['delete', RUN_KEY, '/v', RUN_VALUE_LEGACY, '/f']).catch(() => {});
  if (enabled) {
    const exe = await resolveBinaryPath();
    await regRun(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${exe}"`, '/f']);
  } else {
    await regRun(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']).catch(() => {});
  }
  return { success: true };
}

// ---------- platform support -------------------------------------------------
// Clipdip captures with Windows Graphics Capture and encodes with NVENC, so
// it needs Windows + an NVIDIA GPU. Checked once per app run; a failed
// detection counts as supported (never lock users out on a flaky query —
// clipdip itself surfaces a pipeline error if NVENC is really absent).

let supportPromise = null;

function detectSupport() {
  if (supportPromise) return supportPromise;
  supportPromise = (async () => {
    if (process.platform !== 'win32') {
      return { supported: false, reason: 'Clipdip only runs on Windows.' };
    }
    try {
      const gpus = await new Promise((resolve, reject) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command',
            '(Get-CimInstance Win32_VideoController | ForEach-Object Name) -join "\n"'],
          { windowsHide: true, timeout: 10000 },
          (error, stdout) => (error ? reject(error) : resolve(String(stdout)))
        );
      });
      if (!/nvidia|geforce|quadro|\brtx\b/i.test(gpus)) {
        return {
          supported: false,
          reason: 'Clipdip needs an NVIDIA GPU — it records with NVENC, the encoder on NVIDIA cards.'
        };
      }
      return { supported: true, reason: null };
    } catch (error) {
      logger.warn(`Clipdip GPU detection failed (assuming supported): ${error.message}`);
      return { supported: true, reason: null };
    }
  })();
  return supportPromise;
}

// ---------- status + startup hook -------------------------------------------

async function getStatus() {
  const [running, found, autostart, { exists }, support] = await Promise.all([
    isRunning(),
    binaryFound(),
    getAutostart(),
    getConfig(),
    detectSupport()
  ]);
  return {
    running,
    binaryFound: found,
    configExists: exists,
    autostart,
    supported: support.supported,
    unsupportedReason: support.reason
  };
}

// Called once from main.js after app ready: if clipdip is enabled but not
// running (e.g. library launched manually, autostart off), bring it up.
async function ensureStartedIfEnabled() {
  try {
    const settings = await getSettings();
    if (!settings?.clipdip?.enabled) return;
    // No isRunning early-return: start() no-ops on a running instance but
    // still repairs a missing output folder.
    const result = await start();
    if (!result.success) logger.warn(`Clipdip autostart-on-launch failed: ${result.error}`);
  } catch (error) {
    logger.warn(`Clipdip startup hook failed: ${error.message}`);
  }
}

// Clipdip is opt-OUT: on the first launch where the user has never made a
// choice (no clipdip.enabled key), enable it automatically — but only when
// the machine supports it (Windows + NVIDIA) and the binary is present.
// `persistEnabled` writes clipdip.enabled to settings.json; recording the
// outcome either way means this runs at most once. On failure (spawn error,
// or the process dying right after start) it records `false` so a broken
// setup never retries on every launch.
async function autoEnableIfUnconfigured(persistEnabled) {
  const settings = await getSettings();
  if (settings?.clipdip && 'enabled' in settings.clipdip) return false; // already decided
  if (!(await binaryFound())) return false; // no binary yet (dev) — stay undecided
  const support = await detectSupport();
  if (!support.supported) {
    logger.info(`Clipdip auto-enable skipped: ${support.reason}`);
    return false; // stays undecided; the settings UI explains why
  }

  // First-time output folder setup happens inside start() (see
  // ensureOutputDirectory): clips aim straight at the library unless clipdip
  // already has its own existing folder (pre-merge standalone users).

  // Start-with-Windows is opt-out too.
  await setAutostart(true).catch((e) => logger.warn(`Clipdip autostart enable failed: ${e.message}`));

  const result = await start();
  if (!result.success) {
    logger.warn(`Clipdip auto-enable failed (${result.error}) — recording opt-out`);
    await setAutostart(false).catch(() => {});
    await persistEnabled(false);
    return false;
  }
  await persistEnabled(true);
  logger.info('Clipdip auto-enabled (opt-out default)');
  // Discord authorization needs no nudge from here: an enabled clipdip
  // prompts for it on its own at every start until authorized (see
  // clipdip_discord::spawn's auto_authorize).

  // Fail-safe: if the process dies within its first seconds (crash on init),
  // flip the setting off so it doesn't zombie-start on every launch.
  setTimeout(() => {
    runningCache = { value: false, at: 0 };
    isRunning().then(async (alive) => {
      if (alive) return;
      logger.warn('Clipdip exited right after auto-enable — disabling it');
      await setAutostart(false).catch(() => {});
      await persistEnabled(false).catch(() => {});
    });
  }, 8000);
  return true;
}

// ---------- diagnostics ------------------------------------------------------
// Everything a bug report about the recorder needs, gathered from clipdip's
// own on-disk state plus a live snapshot from its control server. Secrets
// are deliberately excluded: control.json (auth token) and
// discord_tokens.json never appear in the candidate list.

const dataDirPath = () =>
  path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'clipdip',
    'data'
  );

function diagnosticFileCandidates() {
  const logsDir = path.join(dataDirPath(), 'logs');
  return [
    { name: 'clipdip.log', path: path.join(logsDir, 'clipdip.log'), description: 'Clipdip rolling log (current generation)' },
    { name: 'clipdip.log.old', path: path.join(logsDir, 'clipdip.log.old'), description: 'Clipdip rolling log (previous generation)' },
    { name: 'config.toml', path: configPath(), description: 'Clipdip configuration' },
    { name: 'notification-history.json', path: path.join(dataDirPath(), 'notification-history.json'), description: 'Recent clipdip notifications (capped at 200)' },
    { name: 'diag-queue.jsonl', path: path.join(dataDirPath(), 'diag-queue.jsonl'), description: 'Clipdip crash/capture-failure events not yet flushed to telemetry' },
    { name: 'install_id', path: path.join(dataDirPath(), 'install_id'), description: 'Anonymous install id (join key for server-side telemetry)' }
  ];
}

async function collectDiagnosticFiles() {
  const found = [];
  for (const candidate of diagnosticFileCandidates()) {
    try {
      const stat = await fsp.stat(candidate.path);
      if (stat.isFile()) found.push({ ...candidate, size: stat.size });
    } catch {
      /* absent — clipdip may never have run on this machine */
    }
  }
  return found;
}

// Live state that exists nowhere on disk — ring buffer usage vs budget,
// pipeline running/error — comes from the running instance's control server;
// the bridge-level status covers the not-running case.
async function getDiagnosticsSnapshot() {
  const [bridgeStatus, liveStatus] = await Promise.all([
    getStatus().catch((error) => ({ error: error.message })),
    control('status')
  ]);
  return {
    generatedAt: new Date().toISOString(),
    bridge: bridgeStatus,
    live: liveStatus
  };
}

// Explicit enable/disable side effects (called from the IPC handler).
async function setEnabled(enabled) {
  if (enabled) {
    const result = await start();
    const settings = await getSettings();
    // Autostart is opt-out: enabling clipdip brings it along unless the
    // user explicitly turned it off.
    if (settings?.clipdip?.autostart !== false) {
      await setAutostart(true).catch((e) => logger.warn(`Autostart enable failed: ${e.message}`));
    }
    return result;
  }
  await setAutostart(false).catch((e) => logger.warn(`Autostart disable failed: ${e.message}`));
  return quit();
}

module.exports = {
  init,
  getConfig,
  setConfig,
  getStatus,
  isRunning,
  start,
  quit,
  restart,
  getAutostart,
  setAutostart,
  setEnabled,
  ensureStartedIfEnabled,
  autoEnableIfUnconfigured,
  detectSupport,
  resolveBinaryPath,
  listAudioDevices,
  listMonitors,
  getFilenameVariables,
  previewFilename,
  control,
  collectDiagnosticFiles,
  getDiagnosticsSnapshot
};
