'use strict';
/**
 * Per-track level envelope for the player timeline, 10 windows per second, kept in
 * .clip_metadata/waveform_v1/<safe-clipname>.json. One ffmpeg pass decodes every audio stream
 * to 8 kHz mono pcm in a temp dir (~540 ms for a 60 s four-track clip, decode bound), the
 * peak and rms per window are computed here. Opening a clip reads the file; a miss goes to
 * the front of the queue, skips the open pause and lands through the waveform-ready event.
 */
const { execFile } = require('child_process');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

const VERSION = 1;
const DIR = 'waveform_v1';
// windows per second; the timeline resamples to its own bin count
const RATE = 10;
// the envelope only needs the shape, so decode plus resample stays near the bare decode cost
const SAMPLE_RATE = 8000;
const WINDOW = SAMPLE_RATE / RATE;
const SILENCE_DB = -90;
// warm-queue jobs wait this long after a clip opens; the opened clip's own job does not
const PAUSE_ON_OPEN_MS = 8000;
const MAX_STDERR = 1024 * 1024;

let getSettings = null;
let getClipInfo = null;
let send = null;

// urgent (opened clip) ahead of warm (hovered, newest); a name sits in one of them at most
const urgent = [];
const warmQueue = [];
const queued = new Set();
const inFlight = new Set();
let running = false;
let pausedUntil = 0;

function init(deps) {
  getSettings = deps.getSettings;
  getClipInfo = deps.getClipInfo;
  send = deps.send;
}

function sidecarPath(location, clipName) {
  const safeName = clipName.replace(/\//g, '--').replace(/\\/g, '--');
  return path.join(location, '.clip_metadata', DIR, `${safeName}.json`);
}

function isCurrent(entry, stat) {
  return !!entry && entry.v === VERSION && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size
    && Array.isArray(entry.tracks);
}

async function readSidecar(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn(`[waveform] sidecar unreadable, redoing: ${error.message}`);
    return null;
  }
}

function toPayload(entry) {
  return { rate: entry.rate, tracks: entry.tracks };
}

/** the stored envelope, or null with the clip queued at the front */
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
  if (isCurrent(entry, stat)) return toPayload(entry);
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

function runFfmpeg(args, lowPriority) {
  return new Promise((resolve, reject) => {
    const child = execFile(ffmpegPath, args, { maxBuffer: MAX_STDERR, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(Object.assign(new Error(error.message), { stderr: stderr || '' }));
      else resolve();
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
  if (isCurrent(existing, stat)) return existing;

  const info = await getClipInfo(clipName);
  const tracks = Array.isArray(info?.audioTracks) ? info.audioTracks : [];
  let out = [];
  if (tracks.length > 0) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplib-wave-'));
    try {
      const raws = tracks.map((_, i) => path.join(tmp, `${i}.raw`));
      const graph = tracks
        .map((t, i) => `[0:${t.streamIndex}]aformat=channel_layouts=mono,aresample=${SAMPLE_RATE}[o${i}]`)
        .join(';');
      // -vn before -i skips the video decoder entirely
      const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-vn', '-i', clipPath, '-filter_complex', graph];
      tracks.forEach((_, i) => args.push('-map', `[o${i}]`, '-f', 's16le', raws[i]));
      await runFfmpeg(args, lowPriority);
      out = await Promise.all(tracks.map(async (t, i) => ({
        ordinal: t.ordinal,
        streamIndex: t.streamIndex,
        ...envelope(await fs.readFile(raws[i]))
      })));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const entry = { v: VERSION, mtimeMs: stat.mtimeMs, size: stat.size, rate: RATE, tracks: out };
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(entry));
  await fs.rename(tmpFile, file);
  return entry;
}

function enqueue(clipName, isUrgent = false) {
  if (typeof clipName !== 'string' || !clipName || inFlight.has(clipName)) return;
  if (queued.has(clipName)) {
    if (!isUrgent) return;
    // promote: a hovered clip that just got opened
    const at = warmQueue.indexOf(clipName);
    if (at === -1) return;
    warmQueue.splice(at, 1);
    urgent.push(clipName);
    return;
  }
  queued.add(clipName);
  (isUrgent ? urgent : warmQueue).push(clipName);
  if (!running) void drain();
}

/** clip-warmer hook: measured at idle so the open is a cache hit */
function warm(clipName) {
  enqueue(clipName, false);
}

function pause(ms = PAUSE_ON_OPEN_MS) {
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
}

function resume() {
  pausedUntil = 0;
}

async function drain() {
  running = true;
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
        const entry = await measure(clipName, !isUrgent);
        logger.info(`[waveform] ${clipName}: ${entry.tracks.length} track(s) in ${Date.now() - startedAt} ms`);
        if (send) send('waveform-ready', { clipName, waveform: toPayload(entry) });
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          logger.warn(`[waveform] failed for ${clipName}: ${error.message}`);
          telemetry.event('waveform_measure_failed', {
            kind: telemetry.KIND.DEGRADED,
            severity: telemetry.SEVERITY.WARNING,
            context: { errno: error?.code, stderr_tail: String(error?.stderr || '').slice(-200) },
            coalesceMs: 60000
          });
        }
      } finally {
        inFlight.delete(clipName);
      }
    }
  } finally {
    running = false;
  }
}

async function removeSidecar(clipName) {
  const settings = await getSettings();
  await fs.rm(sidecarPath(settings.clipLocation, clipName), { force: true }).catch(() => undefined);
}

/** clip re-recorded or trimmed on disk: drop it, the next open measures again */
async function forget(clipName) {
  await removeSidecar(clipName);
}

async function remove(clipName) {
  await removeSidecar(clipName);
}

module.exports = { init, get, warm, enqueue, pause, resume, forget, remove, envelope, RATE };
