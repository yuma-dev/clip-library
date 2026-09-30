'use strict';
/** overlapping replay saves: two saves within one buffer window share footage. a clip ends at
 * min(birthtime, mtime): clipdip muxes to .part and renames, so birthtime is the mux start ~0.1 s
 * after the hotkey; a copied-in clip keeps only its mtime. .gameinfo has no time and filename
 * templates vary. start = end - probed duration. file times land within ~0.3 s (p90) on real
 * pairs, audio pins the rest (clip-media.js). cache: .clip_metadata/storage_v1.json */
const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');
const logger = require('../utils/logger');
const media = require('./clip-media');
const { mapLimit } = require('../utils/pool');

const CACHE_FILE = 'storage_v1.json';
const CACHE_VERSION = 1;
// same set the library lists (main/clips.js)
const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mov']);
// no replay buffer runs longer than this, so saves further apart can't share footage
const MAX_GAP_MS = 15 * 60 * 1000;
const OVERLAP_SLACK_S = 1;
const FPS_TOLERANCE = 0.5;
const NEW_CLIP_DEBOUNCE_MS = 8000;
const SAVE_DEBOUNCE_MS = 2000;

let deps = null;
let cache = null;
let cacheLocation = null;
let saveTimer = null;
let pairs = [];
let scanning = false;
let rescanQueued = false;
let rescanTimer = null;
let scannedOnce = false;
// clips removed while a scan was already past its folder walk; name -> removal time
const gone = new Map();

function init(d) {
  deps = d;
}

const safeName = (name) => name.replace(/\//g, '--').replace(/\\/g, '--');
const metaDir = (location) => path.join(location, '.clip_metadata');

function emit() {
  if (deps?.send) deps.send('overlaps-changed', snapshot());
}

function snapshot() {
  const dismissed = new Set(cache?.dismissed || []);
  return { pairs: pairs.filter((p) => !dismissed.has(p.key)), scanning, scanned: scannedOnce };
}

async function loadCache(location) {
  if (cache && cacheLocation === location) return cache;
  let parsed = null;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(metaDir(location), CACHE_FILE), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn(`[overlaps] cache unreadable, starting over: ${error.message}`);
  }
  cache = parsed && parsed.v === CACHE_VERSION
    ? { v: CACHE_VERSION, probes: parsed.probes || {}, aligns: parsed.aligns || {}, dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [] }
    : { v: CACHE_VERSION, probes: {}, aligns: {}, dismissed: [] };
  cacheLocation = location;
  pairs = [];
  return cache;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!cache || !cacheLocation) return;
    const file = path.join(metaDir(cacheLocation), CACHE_FILE);
    const tmp = `${file}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(cache));
      await fs.rename(tmp, file);
    } catch (error) {
      logger.warn(`[overlaps] cache save failed: ${error.message}`);
      await fs.unlink(tmp).catch(() => undefined);
    }
  }, SAVE_DEBOUNCE_MS);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

/** every library clip with size and file times; skips dot dirs and icons like the library walk */
async function scanLibrary(location) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = [];
    const dirs = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'icons') dirs.push(path.join(dir, e.name));
      } else if (e.isFile() && VIDEO_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
        files.push(path.join(dir, e.name));
      }
    }
    const stats = await mapLimit(files, 32, async (full) => {
      try {
        const st = await fs.stat(full);
        const birth = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
        return {
          name: path.relative(location, full).replace(/\\/g, '/'),
          size: st.size,
          mtimeMs: st.mtimeMs,
          birthtimeMs: birth,
          end: Math.min(birth, st.mtimeMs),
        };
      } catch {
        return null;
      }
    });
    for (const s of stats) if (s) out.push(s);
    for (const d of dirs) await walk(d);
  }
  if (location) await walk(location);
  return out;
}

const fresh = (entry, clip) => !!entry && entry.size === clip.size && entry.mtimeMs === clip.mtimeMs;

/** duration without spawning anything: our probe cache, else the audio analysis sidecar */
async function cheapDuration(location, clip) {
  const hit = cache.probes[clip.name];
  if (fresh(hit, clip) && hit.duration > 0) return hit.duration;
  try {
    const entry = JSON.parse(await fs.readFile(path.join(metaDir(location), 'analysis_v1', `${safeName(clip.name)}.json`), 'utf8'));
    if (entry && entry.mtimeMs === clip.mtimeMs && entry.size === clip.size && entry.rate > 0 && Array.isArray(entry.tracks)) {
      const windows = Math.max(0, ...entry.tracks.map((t) => (Array.isArray(t.peak) ? t.peak.length : 0)));
      if (windows > 0) {
        const duration = windows / entry.rate;
        cache.probes[clip.name] = { size: clip.size, mtimeMs: clip.mtimeMs, duration, full: false };
        scheduleSave();
        return duration;
      }
    }
  } catch {
    /* not analyzed yet */
  }
  return null;
}

async function fullProbe(location, clip, background = true) {
  const hit = cache.probes[clip.name];
  if (fresh(hit, clip) && hit.full) return hit.info;
  const info = await media.probeMedia(path.join(location, clip.name), { background });
  cache.probes[clip.name] = { size: clip.size, mtimeMs: clip.mtimeMs, duration: info.duration, full: true, info };
  scheduleSave();
  return info;
}

function sameFormat(a, b) {
  if (!a.video || !b.video) return false;
  return a.video.width === b.video.width
    && a.video.height === b.video.height
    && Math.abs((a.video.fps || 0) - (b.video.fps || 0)) < FPS_TOLERANCE
    && a.audio.length === b.audio.length;
}

const pairKey = (a, b) => `${a.name}:${a.size}|${b.name}:${b.size}`;

function describe(a, b, ai, bi, align) {
  const d = align.offset;
  const overlap = Math.min(ai.duration, d + bi.duration) - Math.max(0, d);
  const mergedDuration = Math.max(ai.duration, d + bi.duration) - Math.min(0, d);
  return {
    key: pairKey(a, b),
    earlier: a.name,
    later: b.name,
    earlierSize: a.size,
    laterSize: b.size,
    earlierDuration: ai.duration,
    laterDuration: bi.duration,
    offset: d,
    overlap,
    mergedDuration,
    // one save holds all of the other
    contained: mergedDuration <= Math.max(ai.duration, bi.duration) + 0.1,
    method: align.method,
    confidence: align.confidence ?? null,
  };
}

// audio said the two share nothing, or the aligned overlap is too thin to matter
const isReal = (p) => p.method !== 'none' && p.overlap >= OVERLAP_SLACK_S && !gone.has(p.earlier) && !gone.has(p.later);

async function detect() {
  if (!deps) return;
  if (scanning) {
    rescanQueued = true;
    return;
  }
  scanning = true;
  emit();
  const startedAt = Date.now();
  try {
    const settings = await deps.getSettings();
    const location = settings?.clipLocation;
    if (!location) return;
    await loadCache(location);
    const walkedAt = Date.now();
    const clips = (await scanLibrary(location)).sort((x, y) => x.end - y.end);
    for (const [name, at] of gone) if (at < walkedAt) gone.delete(name);

    // only clips with a neighbor close enough to share footage need a duration
    const need = new Set();
    for (let i = 0; i < clips.length; i++) {
      for (let j = i + 1; j < clips.length && clips[j].end - clips[i].end < MAX_GAP_MS; j++) {
        need.add(i);
        need.add(j);
      }
    }
    const durations = new Map();
    await mapLimit([...need], 2, async (i) => {
      const clip = clips[i];
      let d = await cheapDuration(location, clip);
      if (d == null) {
        try {
          d = (await fullProbe(location, clip)).duration;
        } catch (error) {
          logger.warn(`[overlaps] probe failed for ${clip.name}: ${error.message}`);
        }
      }
      if (d > 0) durations.set(i, d);
    });

    const candidates = [];
    for (let i = 0; i < clips.length; i++) {
      const da = durations.get(i);
      if (!da) continue;
      for (let j = i + 1; j < clips.length && clips[j].end - clips[i].end < MAX_GAP_MS; j++) {
        const db = durations.get(j);
        if (!db) continue;
        const laterStart = clips[j].end - db * 1000;
        if (laterStart < clips[i].end - OVERLAP_SLACK_S * 1000) candidates.push([clips[i], clips[j], da, db]);
      }
    }

    const found = [];
    const toAlign = [];
    for (const [a, b] of candidates) {
      let ai;
      let bi;
      try {
        ai = await fullProbe(location, a);
        bi = await fullProbe(location, b);
      } catch (error) {
        logger.warn(`[overlaps] probe failed: ${error.message}`);
        continue;
      }
      if (!sameFormat(ai, bi)) continue;
      const estimate = (b.end / 1000 - bi.duration) - (a.end / 1000 - ai.duration);
      const key = pairKey(a, b);
      const cached = cache.aligns[key];
      const align = cached || { offset: estimate, method: 'timestamp', confidence: null };
      const entry = { a, b, ai, bi, estimate, key };
      found.push(entry);
      if (!cached) toAlign.push(entry);
      entry.pair = describe(a, b, ai, bi, align);
    }
    pairs = found.map((e) => e.pair).filter(isReal);
    scannedOnce = true;
    emit();

    // audio pass, slow part, one pair at a time at low priority
    let sinceEmit = 0;
    for (const e of toAlign) {
      let align;
      try {
        align = await media.alignPair(
          { path: path.join(location, e.a.name), info: e.ai },
          { path: path.join(location, e.b.name), info: e.bi },
          e.estimate,
          { background: true }
        );
      } catch (error) {
        logger.warn(`[overlaps] align failed for ${e.a.name}: ${error.message}`);
        align = { offset: e.estimate, method: 'timestamp', confidence: null, reason: 'error' };
      }
      cache.aligns[e.key] = { offset: align.offset, method: align.method, confidence: align.confidence ?? null, reason: align.reason };
      e.pair = describe(e.a, e.b, e.ai, e.bi, cache.aligns[e.key]);
      scheduleSave();
      if (++sinceEmit >= 8) {
        sinceEmit = 0;
        pairs = found.map((x) => x.pair).filter(isReal);
        emit();
      }
    }
    pairs = found.map((x) => x.pair).filter(isReal);
    pruneCache(clips, new Set(found.map((x) => x.key)));
    logger.info(`[overlaps] ${pairs.length} overlapping pair(s) in ${clips.length} clips, ${toAlign.length} aligned, ${Date.now() - startedAt} ms`);
  } catch (error) {
    logger.warn(`[overlaps] scan failed: ${error.message}`);
  } finally {
    scanning = false;
    emit();
    if (rescanQueued) {
      rescanQueued = false;
      scheduleDetect(1000);
    }
  }
}

// entries for clips that no longer exist
function pruneCache(clips, live) {
  const names = new Set(clips.map((c) => c.name));
  for (const name of Object.keys(cache.probes)) if (!names.has(name)) delete cache.probes[name];
  for (const key of Object.keys(cache.aligns)) {
    const [a, b] = key.split('|').map((s) => s.slice(0, s.lastIndexOf(':')));
    if (!names.has(a) || !names.has(b)) delete cache.aligns[key];
    else if (!live.has(key) && !cache.dismissed.includes(key)) delete cache.aligns[key];
  }
  cache.dismissed = cache.dismissed.filter((key) => key.split('|').every((s) => names.has(s.slice(0, s.lastIndexOf(':')))));
  scheduleSave();
}

function scheduleDetect(ms = NEW_CLIP_DEBOUNCE_MS) {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => void detect(), ms);
  if (typeof rescanTimer.unref === 'function') rescanTimer.unref();
}

function onNewClip() {
  scheduleDetect();
}

/** drops pairs that involve removed clips right away; the next scan settles the rest */
function forgetClips(names) {
  const now = Date.now();
  for (const name of names) gone.set(name, now);
  const before = pairs.length;
  pairs = pairs.filter(isReal);
  if (pairs.length !== before) emit();
  scheduleDetect(3000);
}

async function dismiss(key) {
  const settings = await deps.getSettings();
  await loadCache(settings.clipLocation);
  if (!cache.dismissed.includes(key)) cache.dismissed.push(key);
  scheduleSave();
  emit();
  return snapshot();
}

function findPair(key) {
  const pair = pairs.find((p) => p.key === key);
  if (!pair) throw new Error('That pair is no longer in the list. It may have changed on disk.');
  return pair;
}

// same steps as the delete-clip handler in main.js: trash the file and its sidecars, drop the
// analysis and loudness entry, then the layer media
async function deleteClipLikeApp(name) {
  const analysis = require('./audio-analysis');
  const clips = require('./clips');
  const thumbnails = require('./thumbnails');
  const layers = require('./layers');
  analysis.remove(name).catch(() => undefined);
  const result = await clips.deleteClip(name, deps.getSettings, thumbnails, null);
  if (result?.success) await layers.removeClipLayers(name, deps.getSettings).catch(() => undefined);
  return result;
}

async function readWatchedSet() {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'watched-clips.json'), 'utf8'));
    return new Set(Array.isArray(parsed.watched) ? parsed.watched : []);
  } catch {
    return null;
  }
}

/** copies every media file a layer points at into toDir and rewrites the paths, whatever the kind */
function remapMedia(value, fromDir, toDir, copies) {
  if (typeof value === 'string') {
    if (path.isAbsolute(value) && path.dirname(path.resolve(value)) === path.resolve(fromDir)) {
      const dest = path.join(toDir, path.basename(value));
      copies.set(value, dest);
      return dest;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => remapMedia(v, fromDir, toDir, copies));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = remapMedia(v, fromDir, toDir, copies);
    return out;
  }
  return value;
}

/** layers of one source moved onto the new timeline; layers only share start/end in seconds */
function shiftLayers(items, shift, total) {
  const out = [];
  for (const item of items) {
    if (!item || !Number.isFinite(item.start) || !Number.isFinite(item.end)) continue;
    const start = Math.max(0, item.start + shift);
    const end = Math.min(total, item.end + shift);
    if (end - start < 0.05) continue;
    out.push({ ...item, start, end });
  }
  return out;
}

async function uniqueName(location, dir, base, ext) {
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base}${n === 1 ? '' : ` ${n}`}${ext}`;
    const rel = dir ? `${dir}/${candidate}` : candidate;
    try {
      await fs.access(path.join(location, rel));
    } catch {
      return rel;
    }
  }
  throw new Error('No free file name for the merged clip');
}

async function copyIfPresent(from, to) {
  try {
    await fs.copyFile(from, to);
    return true;
  } catch {
    return false;
  }
}

async function statClip(location, name) {
  const st = await fs.stat(path.join(location, name));
  const birth = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
  return { name, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: birth, end: Math.min(birth, st.mtimeMs) };
}

/**
 * one clip covering both saves. the earlier save's name, custom name and sidecars carry over,
 * tags are the union, layers from both land on the merged timeline, trims reset. originals go
 * to the recycle bin only after the merged file is verified and in place
 */
async function merge(key, onProgress = () => undefined) {
  const pair = findPair(key);
  const settings = await deps.getSettings();
  const location = settings.clipLocation;
  const metadata = require('./metadata');
  const layers = require('./layers');
  const clipsModule = require('./clips');
  const ffmpegModule = require('./ffmpeg');

  const [a, b] = await Promise.all([statClip(location, pair.earlier), statClip(location, pair.later)]);
  if (pairKey(a, b) !== key) throw new Error('One of the clips changed on disk. Run the check again.');
  const [ai, bi] = await Promise.all([fullProbe(location, a, false), fullProbe(location, b, false)]);
  const A = { ...a, path: path.join(location, a.name), info: ai };
  const B = { ...b, path: path.join(location, b.name), info: bi };

  // the background pass may not have reached this pair yet
  let d = pair.offset;
  if (!cache.aligns[key]) {
    onProgress({ phase: 'align', progress: 0 });
    const estimate = (b.end / 1000 - bi.duration) - (a.end / 1000 - ai.duration);
    const align = await media.alignPair(A, B, estimate).catch(() => ({ offset: estimate, method: 'timestamp', confidence: null }));
    cache.aligns[key] = { offset: align.offset, method: align.method, confidence: align.confidence ?? null, reason: align.reason };
    scheduleSave();
    Object.assign(pair, describe(a, b, ai, bi, cache.aligns[key]));
    d = pair.offset;
  }
  if (pair.method === 'none') {
    pairs = pairs.filter((p) => p.key !== key);
    emit();
    throw new Error('The audio says these two do not share footage after all.');
  }
  if (pair.contained) return keepLonger(key, onProgress);

  const [first, second, offset] = d >= 0 ? [A, B, d] : [B, A, -d];

  const dir = path.posix.dirname(a.name) === '.' ? '' : path.posix.dirname(a.name);
  const base = path.posix.basename(a.name, path.posix.extname(a.name)).replace(/ \(merged( \d+)?\)$/, '');
  const mergedName = await uniqueName(location, dir, `${base} (merged)`, '.mp4');
  const mergedPath = path.join(location, mergedName);
  // .part is not a video extension, so the folder watcher ignores it until the rename
  const tempPath = `${mergedPath}.merging.part`;

  const nvenc = await ffmpegModule.getNvencStatus().catch(() => ({ available: false }));
  const audioEncoder = await (ffmpegModule.getAudioEncoder ? ffmpegModule.getAudioEncoder() : Promise.resolve('aac'));
  onProgress({ phase: 'encode', progress: 0 });
  let plan;
  try {
    plan = await media.encodeMerge({
      first,
      second,
      offset,
      output: tempPath,
      nvencAvailable: Boolean(nvenc?.available),
      audioEncoder,
      onProgress: (p) => onProgress({ phase: 'encode', progress: p * 0.95 }),
    });
    const out = await media.probeMedia(tempPath);
    if (!out.video || out.audio.length !== first.info.audio.length || Math.abs(out.duration - plan.expected) > 1) {
      throw new Error(`Merged file did not check out (${out.duration.toFixed(2)} s, expected ${plan.expected.toFixed(2)} s)`);
    }
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
  onProgress({ phase: 'finish', progress: 0.96 });

  const folder = metaDir(location);
  await fs.mkdir(folder, { recursive: true });
  const newSafe = safeName(mergedName);

  // layers: each source's content lands at (its time - its first kept second) + where it starts
  const t0 = first.info.video.startTime || 0;
  const total = plan.expected;
  const newMedia = path.join(folder, 'layers_media', newSafe);
  const copies = new Map();
  const collected = [];
  const ids = new Set();
  for (const [src, shift] of [[first, -t0], [second, plan.cut - t0 - plan.from]]) {
    let items = [];
    try {
      items = (await layers.getLayers(src.name, deps.getSettings)).items || [];
    } catch (error) {
      logger.warn(`[overlaps] layers unreadable for ${src.name}: ${error.message}`);
    }
    const fromDir = path.join(folder, 'layers_media', safeName(src.name));
    for (const item of shiftLayers(items, shift, total)) {
      const moved = remapMedia(item, fromDir, newMedia, copies);
      // both sources may carry the same id, the migrated volume range is always "range"
      let id = String(moved.id || 'layer');
      while (ids.has(id)) id = `${id}-b`;
      ids.add(id);
      collected.push({ ...moved, id });
    }
  }
  if (collected.length > 0) {
    await fs.mkdir(newMedia, { recursive: true });
    for (const [from, to] of copies) await copyIfPresent(from, to);
    await layers.saveLayers(mergedName, collected, deps.getSettings);
  }

  const customName = (await metadata.getCustomName(a.name, deps.getSettings).catch(() => null))
    || (await metadata.getCustomName(b.name, deps.getSettings).catch(() => null))
    || base;
  await metadata.saveCustomName(mergedName, customName, deps.getSettings);
  const tags = [...new Set([
    ...(await metadata.getClipTags(a.name, deps.getSettings).catch(() => [])),
    ...(await metadata.getClipTags(b.name, deps.getSettings).catch(() => [])),
  ])];
  if (tags.length) await metadata.saveClipTags(mergedName, tags, deps.getSettings);
  for (const ext of ['.gameinfo', '.volume', '.speed', '.trackstate', '.favorite']) {
    const to = path.join(folder, `${newSafe}${ext}`);
    if (!(await copyIfPresent(path.join(folder, `${safeName(a.name)}${ext}`), to))) {
      await copyIfPresent(path.join(folder, `${safeName(b.name)}${ext}`), to);
    }
  }
  // the library sorts by .date, else mtime; both say "saved when the later one was"
  const endMs = Math.max(a.end, b.end);
  await fs.writeFile(path.join(folder, `${newSafe}.date`), new Date(endMs).toISOString()).catch(() => undefined);

  await fs.rename(tempPath, mergedPath);
  await fs.utimes(mergedPath, new Date(), new Date(endMs)).catch(() => undefined);

  const watched = await readWatchedSet();
  const removed = [];
  const failed = [];
  for (const name of [a.name, b.name]) {
    const r = await deleteClipLikeApp(name);
    if (r?.success) removed.push(name);
    else failed.push(name);
  }
  if (watched && watched.has(a.name) && watched.has(b.name)) await clipsModule.markClipsWatched([mergedName]).catch(() => undefined);

  const mergedSize = (await fs.stat(mergedPath)).size;
  forgetClips(removed);
  if (deps.send) deps.send('new-clip-added', mergedName);
  require('./audio-analysis').enqueue(mergedName, true);
  logger.info(`[overlaps] merged ${a.name} + ${b.name} into ${mergedName} with ${plan.videoEncoder}, offset ${pair.offset.toFixed(4)} s (${pair.method})`);
  onProgress({ phase: 'done', progress: 1 });
  return {
    merged: mergedName,
    removed,
    failed,
    bytesBefore: a.size + b.size,
    bytesAfter: mergedSize,
    encoder: plan.videoEncoder,
  };
}

/** keeps the longer save (the later one on a tie) and moves the other to the recycle bin,
 * tags carry over so nothing the user typed is lost */
async function keepLonger(key, onProgress = () => undefined) {
  const pair = findPair(key);
  const metadata = require('./metadata');
  const keepEarlier = pair.earlierDuration > pair.laterDuration + 0.05;
  const keep = keepEarlier ? pair.earlier : pair.later;
  const drop = keepEarlier ? pair.later : pair.earlier;
  const dropSize = keepEarlier ? pair.laterSize : pair.earlierSize;
  onProgress({ phase: 'delete', progress: 0.3 });
  const [keepTags, dropTags] = await Promise.all([
    metadata.getClipTags(keep, deps.getSettings).catch(() => []),
    metadata.getClipTags(drop, deps.getSettings).catch(() => []),
  ]);
  const union = [...new Set([...keepTags, ...dropTags])];
  if (union.length > keepTags.length) await metadata.saveClipTags(keep, union, deps.getSettings);
  const r = await deleteClipLikeApp(drop);
  if (!r?.success) throw new Error(r?.error || 'Could not move the clip to the Recycle Bin');
  forgetClips([drop]);
  onProgress({ phase: 'done', progress: 1 });
  return { kept: keep, removed: [drop], failed: [], bytesFreed: dropSize, tags: union.length > keepTags.length ? union : null };
}

function start(delayMs = 20000) {
  scheduleDetect(delayMs);
}

module.exports = {
  init,
  start,
  detect,
  onNewClip,
  forgetClips,
  snapshot,
  dismiss,
  merge,
  keepLonger,
  scanLibrary,
  loadCache,
  cheapDuration,
  fullProbe,
  deleteClipLikeApp,
  readWatchedSet,
  shiftLayers,
  remapMedia,
  getCache: () => cache,
  scheduleSave,
};
