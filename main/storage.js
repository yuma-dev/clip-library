'use strict';
/**
 * Settings > Storage: where the clip folder's bytes go, the lists behind the cleanup tools, the
 * lossless "shrink to trim" cut, and one queue that runs every long storage job one at a time.
 * overlap detection and merging live in ./overlaps.js.
 */
const path = require('path');
const fs = require('fs').promises;
const { app, shell } = require('electron');
const logger = require('../utils/logger');
const media = require('./clip-media');
const overlaps = require('./overlaps');
const { mapLimit } = require('../utils/pool');

const SUMMARY_TTL_MS = 2 * 60 * 1000;
// long jobs keep the warmer and the library listen out of ffmpeg's way, lifted when done
const PAUSE_MS = 60 * 60 * 1000;
// same budget deleteClip gives a file held by the player or antivirus
const TRASH_RETRIES = 50;
const TRASH_RETRY_MS = 100;

let deps = null;
let summaryCache = { location: null, at: 0, value: null };
let chain = Promise.resolve();
let jobSeq = 0;
let current = null;

async function dirSize(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const sizes = await mapLimit(entries, 32, async (e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return dirSize(full);
    if (!e.isFile()) return 0;
    try {
      return (await fs.stat(full)).size;
    } catch {
      return 0;
    }
  });
  return sizes.reduce((a, b) => a + b, 0);
}

async function summary(force = false) {
  const settings = await deps.getSettings();
  const location = settings?.clipLocation;
  if (!location) return null;
  const now = Date.now();
  if (!force && summaryCache.location === location && now - summaryCache.at < SUMMARY_TTL_MS) return summaryCache.value;

  const meta = path.join(location, '.clip_metadata');
  const userData = app.getPath('userData');
  const [total, clips, metaTotal, analysis, tracks1, tracks2, tracks3, layersMedia, icons, thumbnails, speech, disk, subtitles] = await Promise.all([
    dirSize(location),
    overlaps.scanLibrary(location),
    dirSize(meta),
    dirSize(path.join(meta, 'analysis_v1')),
    dirSize(path.join(meta, 'audio_tracks')),
    dirSize(path.join(meta, 'audio_tracks_v2')),
    dirSize(path.join(meta, 'audio_tracks_v3')),
    dirSize(path.join(meta, 'layers_media')),
    dirSize(path.join(location, 'icons')),
    dirSize(path.join(userData, 'thumbnail-cache')),
    dirSize(path.join(userData, 'whisper')),
    fs.statfs ? fs.statfs(location).catch(() => null) : Promise.resolve(null),
    require('./subtitles').status().catch(() => ({ installed: false })),
  ]);
  const clipBytes = clips.reduce((a, c) => a + c.size, 0);
  const audioTracks = tracks1 + tracks2 + tracks3;
  const value = {
    location,
    total,
    clips: { bytes: clipBytes, count: clips.length },
    metadata: {
      bytes: metaTotal,
      analysis,
      audioTracks,
      layersMedia,
      other: Math.max(0, metaTotal - analysis - audioTracks - layersMedia),
    },
    icons,
    otherFiles: Math.max(0, total - clipBytes - metaTotal - icons),
    thumbnails,
    speechModel: { bytes: speech, installed: Boolean(subtitles?.installed) },
    disk: disk ? { free: disk.bavail * disk.bsize, size: disk.blocks * disk.bsize } : null,
    at: now,
  };
  summaryCache = { location, at: now, value };
  return value;
}

async function readTrims(location, names) {
  const meta = path.join(location, '.clip_metadata');
  let present;
  try {
    present = new Set((await fs.readdir(meta)).map((f) => f.toLowerCase()));
  } catch {
    return new Map();
  }
  const trims = new Map();
  await mapLimit(names, 16, async (name) => {
    const file = `${name.replace(/\//g, '--')}.trim`;
    if (!present.has(file.toLowerCase())) return;
    try {
      const t = JSON.parse(await fs.readFile(path.join(meta, file), 'utf8'));
      if (Number.isFinite(t?.start) && Number.isFinite(t?.end) && t.end > t.start) trims.set(name, { start: t.start, end: t.end });
    } catch {
      /* unreadable trim, the player treats it as untrimmed too */
    }
  });
  return trims;
}

/** size, cached duration and trim per clip; durations never spawn ffprobe here */
async function rows() {
  const settings = await deps.getSettings();
  const location = settings?.clipLocation;
  if (!location) return [];
  await overlaps.loadCache(location);
  const clips = await overlaps.scanLibrary(location);
  const trims = await readTrims(location, clips.map((c) => c.name));
  const durations = await mapLimit(clips, 16, (c) => overlaps.cheapDuration(location, c));
  return clips.map((c, i) => ({
    name: c.name,
    size: c.size,
    mtimeMs: c.mtimeMs,
    duration: durations[i],
    trim: trims.get(c.name) || null,
  }));
}

/** probes the rows the page is showing that had no cached duration */
async function durations(names) {
  const settings = await deps.getSettings();
  const location = settings?.clipLocation;
  const out = {};
  if (!location || !Array.isArray(names)) return out;
  await overlaps.loadCache(location);
  await mapLimit(names.slice(0, 60), 2, async (name) => {
    try {
      const st = await fs.stat(path.join(location, name));
      out[name] = (await overlaps.fullProbe(location, { name, size: st.size, mtimeMs: st.mtimeMs })).duration;
    } catch {
      out[name] = null;
    }
  });
  return out;
}

async function trashFile(file) {
  let lastError = null;
  for (let i = 0; i < TRASH_RETRIES; i++) {
    try {
      await shell.trashItem(file);
      return;
    } catch (error) {
      lastError = error;
      // electron reports a locked file as a generic failure, so any error gets the retry budget
      await new Promise((r) => setTimeout(r, TRASH_RETRY_MS));
    }
  }
  throw lastError || new Error('Could not move the original to the Recycle Bin');
}

/**
 * lossless cut to the saved trim: starts on the keyframe at or before trim start, so up to one
 * gop before it stays and the trim is rewritten relative to the new file. layers shift with it
 */
async function shrinkOne(name) {
  const settings = await deps.getSettings();
  const location = settings.clipLocation;
  const full = path.join(location, name);
  const metadata = require('./metadata');
  const layers = require('./layers');

  const trim = await metadata.getTrimData(name, deps.getSettings).catch(() => null);
  if (!trim || !(trim.end > trim.start)) return { name, skipped: 'no_trim' };
  const before = await fs.stat(full);
  const info = await media.probeMedia(full);
  const dur = info.duration;
  const start = Math.max(0, Math.min(dur, trim.start));
  const end = Math.max(start, Math.min(dur, trim.end));
  const kf = await media.keyframeAtOrBefore(full, start);
  if (kf < 0.05 && end > dur - 0.25) return { name, skipped: 'nothing_to_cut' };

  // .part keeps the folder watcher from announcing it as a new clip
  const tmp = `${full}.shrink.part`;
  let trashed = false;
  try {
    await media.streamCopyCut(full, kf, end, tmp);
    const out = await media.probeMedia(tmp);
    const expected = end - kf;
    const sameStreams = out.streams === info.streams && Boolean(out.video) === Boolean(info.video) && out.audio.length === info.audio.length;
    if (!sameStreams || out.duration < expected - 0.5 || out.duration > expected + 1.5) {
      throw new Error(`Cut did not check out (${out.duration.toFixed(2)} s, expected ${expected.toFixed(2)} s)`);
    }
    await trashFile(full);
    trashed = true;
    await fs.rename(tmp, full);
    const newDur = out.duration;
    // mtime is the save time the library sorts by and overlap detection reads as the end
    const birth = before.birthtimeMs > 0 ? before.birthtimeMs : before.mtimeMs;
    const newEnd = Math.min(birth, before.mtimeMs) - Math.max(0, dur - end) * 1000;
    await fs.utimes(full, new Date(), new Date(newEnd)).catch(() => undefined);

    const ns = Math.max(0, start - kf);
    const ne = Math.min(newDur, end - kf);
    const trimCleared = ns < 0.05 && ne >= newDur - 0.1;
    if (trimCleared) await metadata.deleteTrimData(name, deps.getSettings);
    else await metadata.saveTrimData(name, { start: ns, end: ne }, deps.getSettings);

    const items = (await layers.getLayers(name, deps.getSettings).catch(() => ({ items: [] }))).items || [];
    if (items.length > 0) await layers.saveLayers(name, overlaps.shiftLayers(items, -kf, newDur), deps.getSettings);

    await invalidate(name);
    const after = (await fs.stat(full)).size;
    return { name, freed: Math.max(0, before.size - after), keyframe: kf, trimCleared };
  } catch (error) {
    // once the original is in the recycle bin the cut is the only copy left in the library
    if (!trashed) await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}

// everything keyed on the old file: same steps as "Reset cached metadata" plus the listen
async function invalidate(name) {
  const clipWarmer = require('./clip-warmer');
  const analysis = require('./audio-analysis');
  const ffmpegModule = require('./ffmpeg');
  const thumbnails = require('./thumbnails');
  clipWarmer.forget(name);
  await analysis.forget(name).catch(() => undefined);
  await ffmpegModule.resetClipCache(name, deps.getSettings, thumbnails).catch(() => undefined);
  analysis.enqueue(name);
}

function progress(job, patch) {
  Object.assign(job, patch);
  if (deps.send) deps.send('storage-progress', { ...job });
}

async function execute(job, spec) {
  const clipWarmer = require('./clip-warmer');
  const analysis = require('./audio-analysis');
  const heavy = spec.kind === 'merge' || spec.kind === 'shrink';
  if (heavy) {
    clipWarmer.pause(PAUSE_MS);
    analysis.pause(PAUSE_MS);
  }
  current = job;
  progress(job, { state: 'running', progress: 0 });
  try {
    let result;
    if (spec.kind === 'merge' || spec.kind === 'keep-longer') {
      const run = spec.kind === 'merge' ? overlaps.merge : overlaps.keepLonger;
      result = await run(String(spec.key), (p) => progress(job, { progress: p.progress, phase: p.phase }));
    } else if (spec.kind === 'delete' || spec.kind === 'shrink') {
      const names = (Array.isArray(spec.names) ? spec.names : []).filter((n) => typeof n === 'string');
      const done = [];
      const failed = [];
      const skipped = [];
      let freed = 0;
      for (let i = 0; i < names.length; i++) {
        progress(job, { index: i, total: names.length, name: names[i], progress: i / names.length });
        try {
          if (spec.kind === 'delete') {
            const size = (await fs.stat(path.join((await deps.getSettings()).clipLocation, names[i])).catch(() => ({ size: 0 }))).size;
            const r = await overlaps.deleteClipLikeApp(names[i]);
            if (r?.success) {
              done.push(names[i]);
              freed += size;
            } else {
              failed.push({ name: names[i], error: r?.error || 'failed' });
            }
          } else {
            const r = await shrinkOne(names[i]);
            if (r.skipped) skipped.push({ name: names[i], reason: r.skipped });
            else {
              done.push(r);
              freed += r.freed;
            }
          }
        } catch (error) {
          logger.warn(`[storage] ${spec.kind} failed for ${names[i]}: ${error.message}`);
          failed.push({ name: names[i], error: error.message });
        }
      }
      if (spec.kind === 'delete') overlaps.forgetClips(done);
      result = spec.kind === 'delete' ? { removed: done, failed, bytesFreed: freed } : { shrunk: done, skipped, failed, bytesFreed: freed };
    } else {
      throw new Error(`Unknown storage job: ${spec.kind}`);
    }
    summaryCache.at = 0;
    progress(job, { state: 'done', progress: 1 });
    return result;
  } catch (error) {
    progress(job, { state: 'failed', error: error.message });
    throw error;
  } finally {
    current = null;
    if (heavy) {
      clipWarmer.resume();
      analysis.resume();
    }
  }
}

/** queued behind whatever job is running, so two ffmpeg jobs never race for the same files */
function runJob(spec) {
  const job = { id: ++jobSeq, kind: spec?.kind, state: 'queued', progress: 0, label: typeof spec?.label === 'string' ? spec.label.slice(0, 120) : '' };
  const p = chain.then(() => execute(job, spec || {}));
  chain = p.catch(() => undefined);
  return p;
}

function init(d) {
  deps = d;
  overlaps.init({ getSettings: d.getSettings, send: d.send });
  const { ipcMain } = d;
  ipcMain.handle('storage-summary', (_e, force) => summary(Boolean(force)));
  ipcMain.handle('storage-rows', () => rows());
  ipcMain.handle('storage-durations', (_e, names) => durations(names));
  ipcMain.handle('storage-overlaps', (_e, startIfIdle) => {
    const snap = overlaps.snapshot();
    // the storage page opened before the deferred startup scan; the library only listens
    if (startIfIdle && !snap.scanned && !snap.scanning) overlaps.start(0);
    return snap;
  });
  ipcMain.handle('storage-overlaps-rescan', () => {
    void overlaps.detect();
    return overlaps.snapshot();
  });
  ipcMain.handle('storage-overlap-dismiss', (_e, key) => overlaps.dismiss(String(key)));
  ipcMain.handle('storage-run', (_e, spec) => runJob(spec));
  ipcMain.handle('storage-job', () => (current ? { ...current } : null));
}

module.exports = {
  init,
  start: (ms) => overlaps.start(ms),
  onNewClip: (name) => overlaps.onNewClip(name),
  summary,
  rows,
  shrinkOne,
  runJob,
};
