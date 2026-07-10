// Integrated clipper (the clipdip binary) — process lifecycle + config bridge.
//
// The clipper is a standalone tray app: we spawn it fully detached so it
// survives the library quitting, and control the running instance through
// its single-instance guard (`clipdip.exe --reload` / `--quit` forward the
// flag into the running process and exit). Its settings live in a TOML file
// (%APPDATA%\clipdip\config\config.toml) that we read/write directly; the
// running clipper picks changes up via --reload.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn, execFile } = require('child_process');
const TOML = require('smol-toml');
const logger = require('../utils/logger');

const EXE_NAME = 'clipdip.exe';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'ClipLib';
const RUN_VALUE_LEGACY = 'ClipDip';

const configPath = () =>
  path.join(app.getPath('appData'), 'clipdip', 'config', 'config.toml');

let getSettings = async () => ({});

function init(settingsGetter) {
  getSettings = settingsGetter;
}

async function resolveBinaryPath() {
  const settings = await getSettings();
  const override = settings?.clipper?.binaryPath;
  if (override && typeof override === 'string' && override.trim()) {
    const p = override.trim();
    // The picker hands us a folder; a direct exe path also works.
    return p.toLowerCase().endsWith('.exe') ? p : path.join(p, EXE_NAME);
  }
  if (!app.isPackaged) {
    // Dev convenience: use the sibling clipdip repo's release build (or the
    // vendored copy) so the clipper works without configuring a path.
    const candidates = [
      path.resolve(__dirname, '..', 'vendor', 'clipper', EXE_NAME),
      path.resolve(__dirname, '..', '..', 'clipdip', 'target', 'release', EXE_NAME)
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return path.join(process.resourcesPath, 'clipper', EXE_NAME);
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
      logger.warn(`Clipper config read failed: ${error.message}`);
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
// 0 = none (clipper re-reads these sections per operation), 1 = hotkeys only,
// 2 = full pipeline restart (clears the replay buffer — only when capture
// settings actually changed).
let pendingReload = 0;

function reloadLevelFor(patch) {
  let level = 0;
  for (const key of Object.keys(patch)) {
    if (key === 'video' || key === 'audio' || key === 'replay_seconds') return 2;
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

  // Debounce the reload: a full restart clears the clipper's replay buffer,
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
      .catch((error) => logger.warn(`Clipper reload failed: ${error.message}`));
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

async function start() {
  if (await isRunning()) return { success: true, alreadyRunning: true };
  const exe = await resolveBinaryPath();
  try {
    await fsp.access(exe, fs.constants.X_OK);
  } catch {
    return { success: false, error: `Clipper binary not found at ${exe}` };
  }
  // detached + unref + ignored stdio: the clipper must outlive the library —
  // it is its own tray app the user may rely on with the library closed.
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(exe),
    windowsHide: false
  });
  child.unref();
  runningCache = { value: true, at: Date.now() };
  logger.info(`Clipper started (${exe})`);
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
  logger.warn('Clipper did not exit after --quit; force-killing');
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

// ---------- autostart (registry Run value, points at the clipper exe) ------

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

// ---------- status + startup hook -------------------------------------------

async function getStatus() {
  const [running, found, autostart, { exists }] = await Promise.all([
    isRunning(),
    binaryFound(),
    getAutostart(),
    getConfig()
  ]);
  return { running, binaryFound: found, configExists: exists, autostart };
}

// Called once from main.js after app ready: if the clipper is enabled but not
// running (e.g. library launched manually, autostart off), bring it up.
async function ensureStartedIfEnabled() {
  try {
    const settings = await getSettings();
    if (!settings?.clipper?.enabled) return;
    if (await isRunning()) return;
    const result = await start();
    if (!result.success) logger.warn(`Clipper autostart-on-launch failed: ${result.error}`);
  } catch (error) {
    logger.warn(`Clipper startup hook failed: ${error.message}`);
  }
}

// Explicit enable/disable side effects (called from the IPC handler).
async function setEnabled(enabled) {
  if (enabled) {
    const result = await start();
    const settings = await getSettings();
    if (settings?.clipper?.autostart) {
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
  resolveBinaryPath
};
