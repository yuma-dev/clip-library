'use strict';
/**
 * One listen per clip, kept in .clip_metadata/analysis_v1/<safe-clipname>.json: a level
 * envelope per audio track for the player timeline (10 windows per second, peak and rms in
 * dBFS) and the integrated loudness of what the player mixes by default (Mix track, the lone
 * track, or all tracks summed). One ffmpeg pass does both: every stream decodes once, the
 * envelope side goes to 8 kHz mono pcm in a temp dir, the loudness side through ebur128.
 * ~0.6 s for a 60 s four-track clip, decode bound. The loudness index (main/loudness.js) is
 * fed from here. The library is scanned once in the background at idle priority; opening a
 * clip puts it at the front and skips the open pause, the result lands via analysis-ready.
 */
const { execFile } = require('child_process');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const VERSION = 1;
const DIR = 'analysis_v1';
// windows per second; the timeline resamples to its own bin count
const RATE = 10;
// the envelope only needs the shape, so decode plus resample stays near the bare decode cost
const SAMPLE_RATE = 8000;
const WINDOW = SAMPLE_RATE / RATE;
const SILENCE_DB = -90;
// scaling is near linear up to the physical core count; hyperthreads add little and would pin
// the whole CPU while browsing
const WORKERS = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
// warm-queue jobs wait this long after a clip opens; the opened clip's own job does not
const PAUSE_ON_OPEN_MS = 8000;
const PROGRESS_MS = 250;
// completion timestamps of the last few clips; the eta follows the actual pace
const RATE_WINDOW = 40;
// ebur128 summary is a couple of KB with framelog=verbose keeping the per-100ms lines out
const MAX_STDERR = 4 * 1024 * 1024;

let getSettings = null;
let getClipInfo = null;
let getClipNames = null;
let loudness = null;
let send = null;

// urgent (opened clip) ahead of warm (hovered, newest, library scan); a name sits in one at most
const urgent = [];
const warmQueue = [];
const queued = new Set();
const inFlight = new Set();
let workersRunning = 0;
let pausedUntil = 0;
let scanTotal = 0;
let scanDone = 0;
const recentDone = [];
let lastProgressAt = 0;
let progressTimer = null;

function init(deps) {
  getSettings = deps.getSettings;
  getClipInfo = deps.getClipInfo;
  getClipNames = deps.getClipNames;
  loudness = deps.loudness;
  send = deps.send;
}

function dirFor(location) {
  return path.join(location, '.clip_metadata', DIR);
}

function sidecarPath(location, clipName) {
  const safeName = clipName.replace(/\//g, '--').replace(/\\/g, '--');
  return path.join(dirFor(location), `${safeName}.json`);
}

function isCurrent(entry, stat) {
  return !!entry && entry.v === VERSION && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size
    && Array.isArray(entry.tracks) && entry.loudness && typeof entry.loudness === 'object';
}

async function readSidecar(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn(`[analysis] sidecar unreadable, redoing: ${error.message}`);
    return null;
  }
}

function waveformOf(entry) {
  return { rate: entry.rate, tracks: entry.tracks };
}

/** the stored waveform, or null with the clip queued at the front */
async function get(clipName) {
  const settings = await getSettings();
  const clipPath = path.join(settings.clipLocation, clipName);
  let stat;
  try {
    stat = await fs.stat(clipPath);
  } catch (_) {
    return null;
  }
  const entry = await readSidecar(sidecarPath(settings.clipLocation, clipName));
  if (isCurrent(entry, stat)) return waveformOf(entry);
  enqueue(clipName, true);
  return null;
}

function dbOf(linear) {
  if (linear <= 0) return SILENCE_DB;
  return Math.max(SILENCE_DB, Math.round(20 * Math.log10(linear) * 10) / 10);
}

/** peak and rms in dBFS per window from s16le mono pcm */
function envelope(buf) {
  const samples = buf.length >> 1;
  const windows = Math.ceil(samples / WINDOW);
  const peak = new Array(windows);
  const rms = new Array(windows);
  for (let w = 0; w < windows; w++) {
    const start = w * WINDOW;
    const end = Math.min(samples, start + WINDOW);
    let max = 0;
    let sum = 0;
    for (let i = start; i < end; i++) {
      const s = buf.readInt16LE(i * 2) / 32768;
      const a = s < 0 ? -s : s;
      if (a > max) max = a;
      sum += s * s;
    }
    peak[w] = dbOf(max);
    rms[w] = dbOf(Math.sqrt(sum / Math.max(1, end - start)));
  }
  return { peak, rms };
}

function parseLoudness(stderr) {
  // per-frame lines also print "I:", and amix graphs can print a second, empty summary
  // (-70 LUFS, -inf peak) before the real one, so the last match wins for both
  const last = (re) => {
    const all = stderr.match(re);
    return all ? all[all.length - 1].match(/(-?[\d.]+|-inf)/)[1] : null;
  };
  const num = (s) => (s == null || s === '-inf' ? null : Number(s));
  return { lufs: num(last(/I:\s+(-?[\d.]+|-inf)\s+LUFS/g)), peak: num(last(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/g)) };
}

/** one graph: each stream split into an envelope leg (raw file) and a loudness leg (ebur128 on
 * the Mix track, the lone track, or all tracks summed) */
function buildGraph(tracks, raws) {
  const mix = tracks.find((t) => t.name === 'Mix');
  const parts = [];
  const loudInputs = [];
  tracks.forEach((t, i) => {
    const forLoud = mix ? t === mix : true;
    if (forLoud) {
      parts.push(`[0:${t.streamIndex}]asplit=2[e${i}][l${i}]`);
      loudInputs.push(`[l${i}]`);
    } else {
      parts.push(`[0:${t.streamIndex}]anull[e${i}]`);
    }
    parts.push(`[e${i}]aformat=channel_layouts=mono,aresample=${SAMPLE_RATE}[o${i}]`);
  });
  const meter = 'ebur128=peak=sample:framelog=verbose';
  let mode = 'single';
  if (mix) {
    mode = 'mix';
    parts.push(`${loudInputs[0]}${meter}[loud]`);
  } else if (loudInputs.length === 1) {
    parts.push(`${loudInputs[0]}${meter}[loud]`);
  } else {
    mode = 'sum';
    const fmt = loudInputs.map((l, i) => `${l}aformat=sample_rates=48000:channel_layouts=stereo[s${i}]`);
    parts.push(...fmt);
    parts.push(`${loudInputs.map((_, i) => `[s${i}]`).join('')}amix=inputs=${loudInputs.length}:normalize=0,${meter}[loud]`);
  }
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info', '-vn', '-y', '-filter_complex', parts.join(';')];
  tracks.forEach((_, i) => args.push('-map', `[o${i}]`, '-f', 's16le', raws[i]));
  args.push('-map', '[loud]', '-f', 'null', '-');
  return { args, mode };
}

function runFfmpeg(args, lowPriority) {
  return new Promise((resolve, reject) => {
    const child = execFile(ffmpegPath, args, { maxBuffer: MAX_STDERR, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(Object.assign(new Error(error.message), { stderr: stderr || '' }));
      else resolve(stderr || '');
    });
    if (lowPriority) {
      try {
        if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
      } catch (_) { /* priority is a nicety */ }
    }
  });
}

async function measure(clipName, lowPriority) {
  const settings = await getSettings();
  const clipPath = path.join(settings.clipLocation, clipName);
  const file = sidecarPath(settings.clipLocation, clipName);
  const stat = await fs.stat(clipPath);
  const existing = await readSidecar(file);
  if (isCurrent(existing, stat)) return { entry: existing, fresh: false };

  const info = await getClipInfo(clipName);
  const tracks = Array.isArray(info?.audioTracks) ? info.audioTracks : [];
  let out = [];
  let loud = { lufs: null, peak: null, mode: 'none' };
  if (tracks.length > 0) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplib-analysis-'));
    try {
      const raws = tracks.map((_, i) => path.join(tmp, `${i}.raw`));
      const { args, mode } = buildGraph(tracks, raws);
      // -vn before -i skips the video decoder entirely
      const stderr = await runFfmpeg([...args.slice(0, 5), '-i', clipPath, ...args.slice(5)], lowPriority);
      loud = { ...parseLoudness(stderr), mode };
      out = await Promise.all(tracks.map(async (t, i) => ({
        ordinal: t.ordinal,
        streamIndex: t.streamIndex,
        ...envelope(await fs.readFile(raws[i]))
      })));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const entry = { v: VERSION, mtimeMs: stat.mtimeMs, size: stat.size, rate: RATE, tracks: out, loudness: loud };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(entry));
  await fs.rename(tmpFile, file);
  return { entry, fresh: true };
}

function enqueue(clipName, isUrgent = false) {
  if (typeof clipName !== 'string' || !clipName || inFlight.has(clipName)) return;
  if (queued.has(clipName)) {
    if (!isUrgent) return;
    // promote: a hovered or scanned clip that just got opened
    const at = warmQueue.indexOf(clipName);
    if (at === -1) return;
    warmQueue.splice(at, 1);
    urgent.push(clipName);
    return;
  }
  queued.add(clipName);
  (isUrgent ? urgent : warmQueue).push(clipName);
  scanTotal += 1;
  startWorkers();
}

/** clip-warmer hook: analyzed at idle so the open is a cache hit */
function warm(clipName) {
  enqueue(clipName, false);
}

/** queue every clip without a current sidecar; runs at startup and after a reset */
async function scanAll() {
  const settings = await getSettings();
  const names = await getClipNames();
  const location = settings.clipLocation;
  let added = 0;
  for (const name of names) {
    if (queued.has(name) || inFlight.has(name)) continue;
    let stat;
    try {
      stat = await fs.stat(path.join(location, name));
    } catch (_) {
      continue;
    }
    if (isCurrent(await readSidecar(sidecarPath(location, name)), stat)) continue;
    queued.add(name);
    warmQueue.push(name);
    added += 1;
  }
  if (added === 0) return;
  scanTotal += added;
  logger.info(`[analysis] queued ${added} clip(s)`);
  startWorkers();
}

/** drops every sidecar and the loudness index, then listens to the whole library again */
async function resetAll() {
  const settings = await getSettings();
  urgent.length = 0;
  warmQueue.length = 0;
  queued.clear();
  await fs.rm(dirFor(settings.clipLocation), { recursive: true, force: true }).catch(() => undefined);
  if (loudness) await loudness.resetIndex();
  scanTotal = 0;
  scanDone = 0;
  recentDone.length = 0;
  await scanAll();
  emitProgress(true);
}

function pause(ms = PAUSE_ON_OPEN_MS) {
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
}

function resume() {
  pausedUntil = 0;
}

function startWorkers() {
  const pending = urgent.length + warmQueue.length;
  while (workersRunning < WORKERS && pending > workersRunning) {
    workersRunning += 1;
    void worker();
  }
  emitProgress();
}

async function worker() {
  try {
    while (urgent.length || warmQueue.length) {
      let clipName;
      let isUrgent = false;
      if (urgent.length) {
        clipName = urgent.shift();
        isUrgent = true;
      } else {
        const wait = pausedUntil - Date.now();
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 1000)));
          continue;
        }
        clipName = warmQueue.shift();
      }
      queued.delete(clipName);
      inFlight.add(clipName);
      const startedAt = Date.now();
      try {
        const { entry, fresh } = await measure(clipName, !isUrgent);
        if (fresh) logger.info(`[analysis] ${clipName}: ${entry.tracks.length} track(s), ${entry.loudness.lufs} LUFS (${entry.loudness.mode}) in ${Date.now() - startedAt} ms`);
        if (loudness) await loudness.record(clipName, entry, fresh);
        if (send) send('analysis-ready', { clipName, waveform: waveformOf(entry) });
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger.warn(`[analysis] failed for ${clipName}: ${error.message}`);
          telemetry.event('analysis_failed', {
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
    if (workersRunning === 0 && urgent.length === 0 && warmQueue.length === 0) {
      scanTotal = 0;
      scanDone = 0;
      recentDone.length = 0;
      emitProgress(true);
    }
  }
}

function progressPayload() {
  const pending = urgent.length + warmQueue.length + inFlight.size;
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
  send('analysis-progress', progressPayload());
}

/** how many clips have a current sidecar; the settings page shows it next to the library size */
async function countAnalyzed() {
  const settings = await getSettings();
  try {
    const files = await fs.readdir(dirFor(settings.clipLocation));
    return files.filter((f) => f.endsWith('.json')).length;
  } catch (_) {
    return 0;
  }
}

async function removeSidecar(clipName) {
  const settings = await getSettings();
  await fs.rm(sidecarPath(settings.clipLocation, clipName), { force: true }).catch(() => undefined);
}

/** clip re-recorded or trimmed on disk: drop it and listen again */
async function forget(clipName) {
  await removeSidecar(clipName);
  if (loudness) await loudness.remove(clipName);
  enqueue(clipName, true);
}

async function remove(clipName) {
  await removeSidecar(clipName);
  if (loudness) await loudness.remove(clipName);
}

module.exports = { init, get, warm, enqueue, scanAll, resetAll, pause, resume, forget, remove, progressPayload, countAnalyzed, envelope, RATE };
