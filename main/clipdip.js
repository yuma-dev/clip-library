// Integrated clipdip (the recorder binary): process lifecycle + config bridge.
// Spawned fully detached so it outlives the library; controlled via its
// single-instance guard (--reload/--quit) and a TOML config at %APPDATA%\clipdip\config\config.toml.
const { app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { spawn, execFile } = require('child_process');
const net = require('net');
const TOML = require('smol-toml');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');
const { ffmpegPath } = require('./ffmpeg-binaries');

const EXE_NAME = 'clipdip.exe';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ClipLib';
const RUN_VALUE_LEGACY = 'ClipDip';

const configPath = () =>
  path.join(app.getPath('appData'), 'clipdip', 'config', 'config.toml');

// {port, token, pid}, written by the running primary; deleted best-effort on
// exit, so treat it as possibly stale
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
    // picker gives a folder; a direct exe path also works
    return p.toLowerCase().endsWith('.exe') ? p : path.join(p, EXE_NAME);
  }
  if (!app.isPackaged) {
    // dev: fall back to the in-repo cargo build or vendored copy, no path config needed
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

// config bridge

async function getConfig() {
  let raw = null;
  try {
    raw = await fsp.readFile(configPath(), 'utf8');
    return { exists: true, config: TOML.parse(raw) };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn(`Clipdip config read failed: ${error.message}`);
      // empty config here is what the next setConfig merges into, so an unreadable file becomes overwritten
      telemetry.event('clipdip_config_parse_failed', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.ERROR,
        context: {
          file_bytes: typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : 0,
          errno: error?.code
        }
      });
    }
    return { exists: false, config: {} };
  }
}

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      // mode-tagged tables (rate_control, recording_quality) replace whole: merging leaves stale
      // variant fields serde rejects
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

// smol-toml drops comments on rewrite; snapshot the original once as a courtesy
async function snapshotOnce(file) {
  const bak = `${file}.bak`;
  try {
    await fsp.access(bak);
  } catch {
    try {
      await fsp.copyFile(file, bak);
    } catch {
      /* no original file, nothing to snapshot */
    }
  }
}

let reloadTimer = null;
// highest reload level needed since the last flush:
// 0 = none, 1 = hotkeys only, 2 = full restart (clears replay buffer)
let pendingReload = 0;

// keys captured at start (used at mux time); directory/filename_stem are re-read per save, no reload needed
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

  // debounce: a full restart clears the replay buffer, so a burst of edits costs one, not one each
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

// process lifecycle

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
        if (error) {
          // failed probe reads as "not running" everywhere for the rest of the session
          telemetry.event('clipdip_isrunning_probe_failed', {
            kind: telemetry.KIND.SILENT_FAILURE,
            severity: telemetry.SEVERITY.WARNING,
            context: { errno: error?.code },
            coalesceMs: 600000
          });
        }
        runningCache = { value: running, at: Date.now() };
        resolve(running);
      }
    );
  });
}

function writtenByClipLib(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase().replaceAll('/', '\\');
  return ['ffmpeg-static', 'ffmpeg-cache', '\\resources\\clipdip\\', '\\resources\\ffmpeg\\', 'vendor\\ffmpeg']
    .some((fragment) => normalized.includes(fragment));
}

function pickFfmpegPath({ current, target, exists }) {
  if (current === target) return current;
  if (current && exists(current) && !writtenByClipLib(current)) return current;
  return target;
}

// both apps share bundled ffmpeg; existing user overrides take precedence
async function ensureFfmpegPath() {
  const { config } = await getConfig();
  const current = config?.output?.ffmpeg_path;
  const libFfmpeg = pickFfmpegPath({ current, target: ffmpegPath, exists: fs.existsSync });
  if (current === libFfmpeg) return;
  logger.info(`Pointing clipdip at the library ffmpeg: ${libFfmpeg}`);
  // clipdip's own migration-save can race this write on first post-update launch; verify it landed
  // and retry, or the dead path resurrects
  for (let attempt = 0; attempt < 3; attempt++) {
    await setConfig({ output: { ffmpeg_path: libFfmpeg } });
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    const check = await getConfig().catch(() => null);
    if (check?.config?.output?.ffmpeg_path === libFfmpeg) return;
    logger.warn('ffmpeg path write did not stick, retrying');
  }
  logger.warn('ffmpeg path kept reverting; giving up until next start');
  telemetry.event('clipdip_ffmpeg_path_unstable', {
    kind: telemetry.KIND.DEGRADED,
    severity: telemetry.SEVERITY.WARNING,
    context: { attempts: 3 }
  });
}

// clipdip's save fails outright if the output dir is missing and its default (Videos\Clipdip) is
// never created; aim it at the library folder unless one exists
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
  // runs even when clipdip is already up: output dir is re-read per save, no reload needed
  await ensureOutputDirectory().catch((e) =>
    logger.warn(`Clipdip output folder sync failed: ${e.message}`)
  );
  if (await isRunning()) return { success: true, alreadyRunning: true };
  const exe = await resolveBinaryPath();
  try {
    await fsp.access(exe, fs.constants.X_OK);
  } catch (error) {
    telemetry.event('clipdip_start_failed', {
      kind: telemetry.KIND.ERROR,
      severity: telemetry.SEVERITY.ERROR,
      context: { binary_found: false, errno: error?.code }
    });
    return { success: false, error: `Clipdip binary not found at ${exe}` };
  }
  await ensureFfmpegPath().catch((e) => logger.warn(`ffmpeg path sync failed: ${e.message}`));
  // detached + unref + ignored stdio: clipdip outlives the library as its own tray app
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
        // secondary instance forwards the flag then exits on its own; fire and forget
        execFile(exe, [flag], { windowsHide: true }, () => resolve());
      })
  );
}

async function quit() {
  if (!(await isRunning())) return { success: true, alreadyStopped: true };
  await sendControlFlag('--quit');
  // Graceful path first; hard-kill only if the process is still around
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

// stateless CLI queries: handled before tauri/single-instance init, prints one JSON line and exits,
// no running instance needed

// exe may log noise around the payload; take the last line that parses as JSON
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

// control server client: primary listens on 127.0.0.1 (port+token in control.json), JSON-lines
// request/response, connection closes; never throws to renderer

const NOT_RUNNING = { ok: false, error: 'not_running' };

// six failure modes all answer not_running (hung looks like stopped); mode is reported via
// telemetry. missing control.json is skipped, that's genuinely not running
function reportControlFailure(mode) {
  telemetry.event('clipdip_control_failed', {
    kind: telemetry.KIND.SILENT_FAILURE,
    severity: telemetry.SEVERITY.ERROR,
    context: { mode },
    fingerprint: telemetry.hash32(`clipdip_control|${mode}`),
    coalesceMs: 300000
  });
}

async function control(cmd, args) {
  let info;
  try {
    info = JSON.parse(await fsp.readFile(controlJsonPath(), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') reportControlFailure('stale_json');
    return { ...NOT_RUNNING };
  }
  if (!info || typeof info.port !== 'number' || typeof info.token !== 'string') {
    reportControlFailure('stale_json');
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
    connectTimer = setTimeout(() => {
      reportControlFailure('connect_timeout');
      done({ ...NOT_RUNNING });
    }, 500);
    socket.on('connect', () => {
      clearTimeout(connectTimer);
      responseTimer = setTimeout(() => {
        reportControlFailure('response_timeout');
        done({ ...NOT_RUNNING });
      }, 5000);
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
        if (!parsed || typeof parsed !== 'object') reportControlFailure('bad_json');
        done(parsed && typeof parsed === 'object' ? parsed : { ok: false, error: 'bad response' });
      } catch {
        reportControlFailure('bad_json');
        done({ ok: false, error: 'bad response' });
      }
    });
    // Stale control.json (dead pid) surfaces as ECONNREFUSED here
    socket.on('error', (error) => {
      if (!settled) reportControlFailure(error?.code === 'ECONNREFUSED' ? 'econnrefused' : 'socket_error');
      done({ ...NOT_RUNNING });
    });
    socket.on('close', () => {
      if (!settled) reportControlFailure('socket_error');
      done({ ...NOT_RUNNING });
    });
  });
}

// autostart (registry Run value points at clipdip exe)

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
  // Drop the pre-rebrand value either way so we never leave two entries
  await regRun(['delete', RUN_KEY, '/v', RUN_VALUE_LEGACY, '/f']).catch(() => {});
  if (enabled) {
    const exe = await resolveBinaryPath();
    await regRun(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${exe}"`, '/f']);
  } else {
    await regRun(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']).catch(() => {});
  }
  return { success: true };
}

// platform support: needs Windows + an NVIDIA GPU (WGC capture, NVENC encode)
// checked once per run; a failed detection counts as supported, clipdip itself errors if NVENC is
// truly absent

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

// status + startup hook

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

// called once from main.js after app ready: bring clipdip up if enabled but not running
async function ensureStartedIfEnabled() {
  try {
    const settings = await getSettings();
    if (!settings?.clipdip?.enabled) return;
    // no isRunning early-return: start() no-ops if already running but still repairs a missing output folder
    const result = await start();
    if (!result.success) logger.warn(`Clipdip autostart-on-launch failed: ${result.error}`);
  } catch (error) {
    logger.warn(`Clipdip startup hook failed: ${error.message}`);
  }
}

// opt-out: auto-enables on first launch (no clipdip.enabled key) if Windows+NVIDIA and the binary
// is present; persistEnabled always records an outcome so this runs at most once
async function autoEnableIfUnconfigured(persistEnabled) {
  const settings = await getSettings();
  if (settings?.clipdip && 'enabled' in settings.clipdip) return false; // already decided
  if (!(await binaryFound())) return false; // no binary yet (dev), stay undecided
  const support = await detectSupport();
  if (!support.supported) {
    logger.info(`Clipdip auto-enable skipped: ${support.reason}`);
    return false; // stays undecided; the settings UI explains why
  }

  // output folder setup happens inside start() (see ensureOutputDirectory)

  // start-with-Windows is opt-out too
  await setAutostart(true).catch((e) => logger.warn(`Clipdip autostart enable failed: ${e.message}`));

  const startedAt = Date.now();
  const result = await start();
  if (!result.success) {
    logger.warn(`Clipdip auto-enable failed (${result.error}) — recording opt-out`);
    await setAutostart(false).catch(() => {});
    await persistEnabled(false);
    return false;
  }
  await persistEnabled(true);
  logger.info('Clipdip auto-enabled (opt-out default)');
  // discord auth needs no nudge here: enabled clipdip prompts every start until authorized
  // (clipdip_discord::spawn's auto_authorize)

  // fail-safe: flip the setting off if it dies within seconds of start (crash on init)
  setTimeout(() => {
    runningCache = { value: false, at: 0 };
    isRunning().then(async (alive) => {
      if (alive) return;
      logger.warn('Clipdip exited right after auto-enable — disabling it');
      telemetry.event('clipdip_died_after_start', {
        kind: telemetry.KIND.CRASH,
        severity: telemetry.SEVERITY.ERROR,
        context: { ms_to_death: Date.now() - startedAt }
      });
      await setAutostart(false).catch(() => {});
      await persistEnabled(false).catch(() => {});
    });
  }, 8000);
  return true;
}

// diagnostics: recorder state from clipdip's on-disk files plus a live control-server snapshot;
// control.json and discord_tokens.json never appear here

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
      /* absent, clipdip may never have run on this machine */
    }
  }
  return found;
}

// ring buffer usage and pipeline running/error state exist only in the running instance (control
// server); bridge status covers the not-running case
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

// Explicit enable/disable side effects (called from the IPC handler)
async function setEnabled(enabled) {
  if (enabled) {
    const result = await start();
    const settings = await getSettings();
    // autostart is opt-out: comes along unless the user explicitly disabled it
    if (settings?.clipdip?.autostart !== false) {
      await setAutostart(true).catch((e) => logger.warn(`Autostart enable failed: ${e.message}`));
    }
    return result;
  }
  await setAutostart(false).catch((e) => logger.warn(`Autostart disable failed: ${e.message}`));
  return quit();
}

module.exports = {
  writtenByClipLib,
  pickFfmpegPath,
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
