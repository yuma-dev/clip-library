// fills the `game` field for clips that don't have one: clips from before game detection, saves
// where the foreground app wasn't a game yet, and clips with no .gameinfo at all (then the
// filename's [app] part is all there is). matching runs in clipdip's --resolve-games so the
// library and the recorder never disagree. progress lives in userData so a pass only reads
// clips it hasn't seen; misses are retried every few days since Discord's list grows.
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const metadata = require('./metadata');

const STATE_FILE = 'game-backfill.json';
// bump when the matching rules change in a way old misses should see
const RESOLVER_REV = 1;
const RETRY_MISSES_MS = 3 * 24 * 60 * 60 * 1000;
// placeholders recorders put where the app name goes
const NOT_APPS = new Set(['desktop', 'replay', 'clip', 'recording']);

let deps = null;
let timer = null;
let running = false;
let rerun = false;
// clips announced by the watcher since the last full list, lastClipNames lags behind them
const fresh = new Set();

/**
 * @param {{
 *   getSettings: () => Promise<{clipLocation: string}>,
 *   getClipNames: () => Promise<string[]>,
 *   resolveGames: (items: object[]) => Promise<object>,
 *   userDataDir: string,
 *   onUpdated: (clipNames: string[]) => void
 * }} options
 */
function init(options) {
  deps = options;
}

function schedule(delayMs) {
  if (!deps) return;
  clearTimeout(timer);
  timer = setTimeout(() => void run(), delayMs);
}

function noteNewClip(name) {
  if (typeof name === 'string' && name) fresh.add(name);
}

async function loadState() {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(deps.userDataDir, STATE_FILE), 'utf8'));
    if (raw && raw.rev === RESOLVER_REV) {
      return {
        resolved: new Set(Array.isArray(raw.resolved) ? raw.resolved : []),
        missed: new Set(Array.isArray(raw.missed) ? raw.missed : []),
        missedAt: Number(raw.missedAt) || 0
      };
    }
  } catch {
    /* first run or unreadable, start over */
  }
  return { resolved: new Set(), missed: new Set(), missedAt: 0 };
}

async function saveState(state) {
  const body = JSON.stringify({
    rev: RESOLVER_REV,
    resolved: [...state.resolved],
    missed: [...state.missed],
    missedAt: state.missedAt
  });
  await metadata.writeFileAtomically(path.join(deps.userDataDir, STATE_FILE), body);
}

/** "Abiotic Factor 2026.05.10 - 15.45.48.02.DVR" gives "Abiotic Factor", null without a date/time */
function appFromFilename(clipName) {
  const base = path.basename(clipName, path.extname(clipName));
  const m = base.match(/^(.+?)\s+\d{1,4}[.-]\d{1,2}[.-]\d{1,4}/);
  if (!m) return null;
  const app = m[1].trim();
  return app && !NOT_APPS.has(app.toLowerCase()) ? app : null;
}

function stemOf(info) {
  if (typeof info.icon_file === 'string' && info.icon_file) return info.icon_file.replace(/\.png$/i, '');
  if (typeof info.exe_path === 'string' && info.exe_path) {
    return path.win32.basename(info.exe_path).replace(/\.exe$/i, '');
  }
  return null;
}

async function readGameInfo(metadataFolder, clipName) {
  const file = path.join(metadataFolder, `${metadata.metadataSafeName(clipName)}.gameinfo`);
  try {
    return { file, info: JSON.parse(await fs.readFile(file, 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return { file, info: null };
    // unparseable sidecar: leave it alone rather than overwrite what we can't read
    return { file, info: undefined };
  }
}

async function run(opts = {}) {
  if (!deps) return null;
  if (running) {
    rerun = true;
    return null;
  }
  running = true;
  try {
    return await pass(opts);
  } catch (error) {
    logger.warn(`Game backfill failed: ${error.message}`);
    return { error: error.message };
  } finally {
    running = false;
    if (rerun) {
      rerun = false;
      schedule(5000);
    }
  }
}

/** @returns {Promise<{tagged: number, without: number}|{error: string}|null>} */
async function pass(opts) {
  const settings = await deps.getSettings();
  const clipLocation = settings?.clipLocation;
  if (!clipLocation) return null;
  const metadataFolder = metadata.getMetadataFolder(clipLocation);

  const listed = await deps.getClipNames();
  const names = [...new Set([...(Array.isArray(listed) ? listed : []), ...fresh])];
  if (names.length === 0) return { tagged: 0, without: 0 };

  const state = await loadState();
  const present = new Set(names);
  // deleted clips drop out so the state file can't grow forever
  for (const set of [state.resolved, state.missed]) {
    for (const n of set) if (!present.has(n)) set.delete(n);
  }
  const retryMisses = opts.retryMisses === true || Date.now() - state.missedAt > RETRY_MISSES_MS;
  const todo = names.filter(
    (n) => !state.resolved.has(n) && (retryMisses || !state.missed.has(n))
  );
  if (todo.length === 0) return { tagged: 0, without: state.missed.size };

  // one resolver input per exe + title, many clips share one
  const items = new Map();
  const pending = [];
  for (const clipName of todo) {
    const { file, info } = await readGameInfo(metadataFolder, clipName);
    if (info === undefined) continue;
    // a game, or false from a manual 'not a game', both are final
    if (info && (info.game === false || (info.game && typeof info.game.id === 'string'))) {
      state.resolved.add(clipName);
      state.missed.delete(clipName);
      continue;
    }
    let item;
    const stem = info ? stemOf(info) : null;
    if (stem) {
      item = {
        stem,
        exe_path: typeof info.exe_path === 'string' ? info.exe_path : undefined,
        title: typeof info.window_title === 'string' ? info.window_title : undefined
      };
    } else {
      const app = appFromFilename(clipName);
      // the filename part doubles as the title so the title-and-name rule can fire
      if (app) item = { stem: app, title: app };
    }
    if (!item) {
      state.missed.add(clipName);
      continue;
    }
    const key = JSON.stringify([item.stem, item.exe_path ?? null, item.title ?? null]);
    if (!items.has(key)) items.set(key, { key, ...item });
    pending.push({ clipName, file, info, key });
  }

  const updated = [];
  if (items.size > 0) {
    const res = await deps.resolveGames([...items.values()]);
    if (!res || res.ok !== true || !res.results) {
      logger.warn(`Game backfill: resolver unavailable (${res?.error || 'no result'})`);
      return { error: res?.error || 'resolver unavailable' };
    }
    for (const p of pending) {
      const game = res.results[p.key];
      if (!game || typeof game.id !== 'string') {
        state.missed.add(p.clipName);
        continue;
      }
      // re-read right before writing, clipdip may have written the sidecar in the meantime
      const latest = await readGameInfo(metadataFolder, p.clipName);
      if (latest.info === undefined) continue;
      if (latest.info?.game || latest.info?.game === false) {
        state.resolved.add(p.clipName);
        continue;
      }
      const next = { ...(latest.info || {}), game };
      await metadata.writeFileAtomically(p.file, JSON.stringify(next, null, 2));
      state.resolved.add(p.clipName);
      state.missed.delete(p.clipName);
      updated.push(p.clipName);
    }
  }
  if (retryMisses) state.missedAt = Date.now();
  for (const n of todo) fresh.delete(n);
  await saveState(state);

  if (updated.length > 0) {
    logger.info(`Game backfill: tagged ${updated.length} clips, ${state.missed.size} without a game`);
    deps.onUpdated(updated);
  }
  return { tagged: updated.length, without: state.missed.size };
}

/** settings button: retries every clip without a game right away */
function runNow() {
  clearTimeout(timer);
  return run({ retryMisses: true });
}

module.exports = { init, schedule, noteNewClip, runNow, appFromFilename };
