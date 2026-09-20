'use strict';
/**
 * Integrated loudness per clip, measured once from the original audio and kept in
 * .clip_metadata/loudness_v1.json. Gains are derived at read time from the target, so
 * changing the target or turning the feature off never touches a clip's own files.
 * Clips with a custom .volume keep it; a value of exactly 1 counts as no custom level.
 */
const { execFile } = require('child_process');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const INDEX_FILE = 'loudness_v1.json';
const ANALYSIS_VERSION = 2;
// scaling is near linear up to the physical core count (~74 ms/clip effective at 8 on an
// 8c/16t part); hyperthreads add little and would pin the whole CPU while browsing
const WORKERS = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
// user opened a clip: keep ffmpeg away from its decode for a while
const PAUSE_ON_OPEN_MS = 15000;
// peak headroom and gain limits; a quiet clip with hot peaks lands under target instead of clipping.
// ebur128 measures the sample peak: true peak costs 4x oversampling (+170 ms per clip, 40% of the
// run) and sat at most 0.6 dB above sample peak across 40 clips, so a 1 dB margin covers it
const HEADROOM_DBTP = -1;
const SAMPLE_PEAK_MARGIN_DB = 1;
const MAX_GAIN_DB = 12;
const DEFAULT_TARGET_LUFS = -16;
const SAVE_DEBOUNCE_MS = 1500;
const PROGRESS_MS = 250;
// framelog=verbose keeps the per-100ms lines out of stderr, the summary is a couple of KB
const MAX_STDERR = 4 * 1024 * 1024;

let getSettings = null;
let getClipNames = null;
let getClipInfo = null;
let send = null;

// { location, clips: { [name]: { v, mtimeMs, size, lufs, peak, mode } } }
let index = null;
let indexPromise = null;
let saveTimer = null;
let medianCache = null;

const queue = [];
const queued = new Set();
const inFlight = new Set();
let workersRunning = 0;
let pausedUntil = 0;
let scanTotal = 0;
let scanDone = 0;
// completion timestamps of the last few clips; the eta comes from that window, so it
// follows the actual pace (cold disk, long clips, other load) instead of a guess
const RATE_WINDOW = 40;
const recentDone = [];
let lastProgressAt = 0;
let progressTimer = null;

function init(deps) {
  getSettings = deps.getSettings;
  getClipNames = deps.getClipNames;
  getClipInfo = deps.getClipInfo;
  send = deps.send;
}

function isEnabled(settings) {
  return !!(settings && settings.loudness && settings.loudness.enabled);
}

function indexPath(location) {
  return path.join(location, '.clip_metadata', INDEX_FILE);
}

async function loadIndex() {
  const settings = await getSettings();
  const location = settings.clipLocation;
  if (index && index.location === location) return index;
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    let clips = {};
    try {
      const raw = await fs.readFile(indexPath(location), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.clips === 'object') clips = parsed.clips;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`[loudness] index unreadable, starting empty: ${error.message}`);
        telemetry.event('loudness_index_corrupt', {
          kind: telemetry.KIND.DATA_LOSS,
          severity: telemetry.SEVERITY.WARNING,
          context: { errno: error?.code }
        });
      }
    }
    index = { location, clips };
    medianCache = null;
    indexPromise = null;
    return index;
  })();
  return indexPromise;
}

function scheduleSave() {
  medianCache = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveIndex();
  }, SAVE_DEBOUNCE_MS);
}

async function saveIndex() {
  if (!index) return;
  const file = indexPath(index.location);
  const tmp = `${file}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify({ version: ANALYSIS_VERSION, clips: index.clips }));
    await fs.rename(tmp, file);
  } catch (error) {
    logger.error(`[loudness] index save failed: ${error.message}`);
  }
}

/** flushes a pending debounced save (app quit) */
async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    await saveIndex();
  }
}

function entryIsCurrent(entry, stat) {
  return entry && entry.v === ANALYSIS_VERSION && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size;
}

function parseSummary(stderr) {
  // per-frame lines also print "I:", and amix graphs can print a second, empty summary
  // (-70 LUFS, -inf peak) before the real one, so the last match wins for both
  const last = (re) => {
    const all = stderr.match(re);
    return all ? all[all.length - 1].match(/(-?[\d.]+|-inf)/)[1] : null;
  };
  const num = (s) => (s == null || s === '-inf' ? null : Number(s));
  return { lufs: num(last(/I:\s+(-?[\d.]+|-inf)\s+LUFS/g)), peak: num(last(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/g)) };
}

/** Mix track when the recorder wrote one, else the lone track, else all tracks summed;
 * what the player mixes by default is what gets measured. */
function buildArgs(clipPath, tracks) {
  const mix = tracks.find((t) => t.name === 'Mix');
  const base = ['-hide_banner', '-nostats', '-loglevel', 'info', '-i', clipPath];
  const meter = 'ebur128=peak=sample:framelog=verbose';
  if (mix || tracks.length === 1) {
    const t = mix || tracks[0];
    return { mode: mix ? 'mix' : 'single', args: [...base, '-map', `0:${t.streamIndex}`, '-af', meter, '-f', 'null', '-'] };
  }
  const labels = tracks.map((_, i) => `[a${i}]`);
  const fmt = tracks.map((t, i) => `[0:${t.streamIndex}]aformat=sample_rates=48000:channel_layouts=stereo${labels[i]}`).join(';');
  const graph = `${fmt};${labels.join('')}amix=inputs=${tracks.length}:normalize=0,${meter}[out]`;
  return { mode: 'sum', args: [...base, '-filter_complex', graph, '-map', '[out]', '-f', 'null', '-'] };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = execFile(ffmpegPath, args, { maxBuffer: MAX_STDERR, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(error.message), { stderr: stderr || '' }));
      else resolve(stderr || '');
    });
    try {
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
    } catch (_) { /* priority is a nicety */ }
  });
}

async function measure(clipName) {
  const settings = await getSettings();
  const clipPath = path.join(settings.clipLocation, clipName);
  const stat = await fs.stat(clipPath);
  const idx = await loadIndex();
  if (entryIsCurrent(idx.clips[clipName], stat)) return idx.clips[clipName];

  const info = await getClipInfo(clipName);
  const tracks = Array.isArray(info?.audioTracks) ? info.audioTracks : [];
  let result = { lufs: null, peak: null, mode: 'none' };
  if (tracks.length > 0) {
    const { mode, args } = buildArgs(clipPath, tracks);
    const stderr = await runFfmpeg(args);
    result = { ...parseSummary(stderr), mode };
  }
  const entry = { v: ANALYSIS_VERSION, mtimeMs: stat.mtimeMs, size: stat.size, ...result };
  idx.clips[clipName] = entry;
  scheduleSave();
  return entry;
}

function targetFor(settings) {
  const raw = settings?.loudness?.targetLufs;
  if (Number.isFinite(raw)) return raw;
  const median = libraryMedian();
  return Number.isFinite(median) ? median : DEFAULT_TARGET_LUFS;
}

function libraryMedian() {
  if (medianCache !== null) return medianCache;
  if (!index) return NaN;
  const values = Object.values(index.clips).map((e) => e.lufs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  medianCache = values.length ? values[Math.floor(values.length / 2)] : NaN;
  return medianCache;
}

/** gain for one measured entry at a target; capped by true peak headroom and +-MAX_GAIN_DB */
function gainFromEntry(entry, targetLufs) {
  if (!entry || !Number.isFinite(entry.lufs)) return { gain: 1, gainDb: 0, capped: false, silent: true };
  const wanted = targetLufs - entry.lufs;
  let gainDb = wanted;
  if (Number.isFinite(entry.peak)) gainDb = Math.min(gainDb, HEADROOM_DBTP - SAMPLE_PEAK_MARGIN_DB - entry.peak);
  gainDb = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, gainDb));
  return { gain: Math.pow(10, gainDb / 20), gainDb, capped: gainDb < wanted - 0.05, silent: false };
}

/**
 * Effective volume for a clip. rawVolume is the .volume file value (1 when absent).
 * @returns {{volume:number, source:'custom'|'normalized'|'default', gain?:number, gainDb?:number, lufs?:number, capped?:boolean, measured:boolean}}
 */
async function resolveVolume(clipName, rawVolume) {
  const raw = Number(rawVolume);
  if (Number.isFinite(raw) && raw !== 1) return { volume: raw, source: 'custom', measured: false };
  const settings = await getSettings();
  if (!isEnabled(settings)) return { volume: 1, source: 'default', measured: false };
  const idx = await loadIndex();
  const entry = idx.clips[clipName];
  if (!entry) {
    enqueue(clipName, true);
    return { volume: 1, source: 'default', measured: false };
  }
  const { gain, gainDb, capped, silent } = gainFromEntry(entry, targetFor(settings));
  if (silent) return { volume: 1, source: 'default', measured: true };
  return { volume: gain, source: 'normalized', gain, gainDb, lufs: entry.lufs, capped, measured: true };
}

/** clip re-recorded or trimmed on disk: drop it and measure again */
async function forget(clipName) {
  const idx = await loadIndex();
  if (idx.clips[clipName]) {
    delete idx.clips[clipName];
    scheduleSave();
  }
  const settings = await getSettings();
  if (isEnabled(settings)) enqueue(clipName, true);
}

async function remove(clipName) {
  const idx = await loadIndex();
  if (idx.clips[clipName]) {
    delete idx.clips[clipName];
    scheduleSave();
  }
}

function pause(ms = PAUSE_ON_OPEN_MS) {
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
}

function resume() {
  pausedUntil = 0;
}

function enqueue(clipName, priority = false) {
  if (typeof clipName !== 'string' || !clipName || queued.has(clipName) || inFlight.has(clipName)) return;
  queued.add(clipName);
  if (priority) queue.unshift(clipName);
  else queue.push(clipName);
  scanTotal += 1;
  startWorkers();
}

/** queue every clip without a current entry; called on enable and at startup */
async function scanAll() {
  const settings = await getSettings();
  if (!isEnabled(settings)) return;
  const idx = await loadIndex();
  const names = await getClipNames();
  let added = 0;
  for (const name of names) {
    if (idx.clips[name]) continue;
    if (queued.has(name) || inFlight.has(name)) continue;
    queued.add(name);
    queue.push(name);
    added += 1;
  }
  if (added === 0) return;
  scanTotal += added;
  logger.info(`[loudness] queued ${added} clip(s) for measurement`);
  startWorkers();
}

function startWorkers() {
  while (workersRunning < WORKERS && queue.length > workersRunning) {
    workersRunning += 1;
    void worker();
  }
  emitProgress();
}

async function worker() {
  try {
    while (queue.length) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      const settings = await getSettings();
      if (!isEnabled(settings)) {
        // disabled mid-scan: drop the backlog, nothing was written that needs undoing
        queue.length = 0;
        queued.clear();
        break;
      }
      const clipName = queue.shift();
      queued.delete(clipName);
      inFlight.add(clipName);
      const startedAt = Date.now();
      try {
        const entry = await measure(clipName);
        logger.info(`[loudness] ${clipName}: ${entry.lufs} LUFS, peak ${entry.peak} dBFS (${entry.mode}) in ${Date.now() - startedAt} ms`);
        if (send) {
          const { gain, gainDb } = gainFromEntry(entry, targetFor(settings));
          send('loudness-measured', { clipName, gain, gainDb, lufs: entry.lufs });
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger.warn(`[loudness] measure failed for ${clipName}: ${error.message}`);
          telemetry.event('loudness_measure_failed', {
            kind: telemetry.KIND.DEGRADED,
            severity: telemetry.SEVERITY.WARNING,
            context: { errno: error?.code, stderr_tail: String(error?.stderr || '').slice(-200) },
            coalesceMs: 60000
          });
        }
      } finally {
        inFlight.delete(clipName);
        scanDone += 1;
        recentDone.push(Date.now());
        if (recentDone.length > RATE_WINDOW) recentDone.shift();
        emitProgress();
      }
    }
  } finally {
    workersRunning -= 1;
    if (workersRunning === 0 && queue.length === 0) {
      scanTotal = 0;
      scanDone = 0;
      recentDone.length = 0;
      emitProgress(true);
    }
  }
}

function progressPayload() {
  const pending = queue.length + inFlight.size;
  // clips per ms over the recent window; null until three have finished
  let etaSeconds = null;
  if (recentDone.length >= 3) {
    const span = recentDone[recentDone.length - 1] - recentDone[0];
    if (span > 0) etaSeconds = Math.round((pending * span) / (recentDone.length - 1) / 1000);
  }
  return {
    running: workersRunning > 0 && pending > 0,
    paused: pausedUntil > Date.now(),
    pending,
    total: scanTotal,
    done: scanDone,
    etaSeconds
  };
}

function emitProgress(force = false) {
  if (!send) return;
  const now = Date.now();
  if (!force && now - lastProgressAt < PROGRESS_MS) {
    if (!progressTimer) {
      progressTimer = setTimeout(() => {
        progressTimer = null;
        emitProgress(true);
      }, PROGRESS_MS);
    }
    return;
  }
  lastProgressAt = now;
  send('loudness-progress', progressPayload());
}

/** everything the settings page draws from: entries, median, effective target, scan state */
async function getSummary() {
  const settings = await getSettings();
  const idx = await loadIndex();
  const entries = [];
  for (const [name, e] of Object.entries(idx.clips)) {
    if (Number.isFinite(e.lufs)) entries.push({ name, lufs: e.lufs, peak: Number.isFinite(e.peak) ? e.peak : null });
  }
  const median = libraryMedian();
  return {
    enabled: isEnabled(settings),
    targetLufs: Number.isFinite(settings?.loudness?.targetLufs) ? settings.loudness.targetLufs : null,
    effectiveTarget: targetFor(settings),
    median: Number.isFinite(median) ? median : null,
    // what the page mirrors in its gain math: the sample peak cap including the margin
    headroomDbtp: HEADROOM_DBTP - SAMPLE_PEAK_MARGIN_DB,
    maxGainDb: MAX_GAIN_DB,
    measured: Object.keys(idx.clips).length,
    entries,
    scan: progressPayload()
  };
}

async function onSettingsChanged() {
  const settings = await getSettings();
  if (isEnabled(settings)) await scanAll();
}

module.exports = {
  init,
  isEnabled,
  resolveVolume,
  gainFromEntry,
  forget,
  remove,
  enqueue,
  scanAll,
  pause,
  resume,
  flush,
  getSummary,
  onSettingsChanged
};
