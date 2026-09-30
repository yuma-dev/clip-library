/** per-clip layers: volume changes per track, text, gifs and images on a time range.
 * one <safe>.layers json per clip in .clip_metadata, media the layers point at lives in
 * .clip_metadata/layers_media/<safe>/ so a save can drop what nothing references anymore.
 * an old single .volumerange migrates into one all-tracks volume layer on first read. */
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const { app } = require('electron');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');
const metadata = require('./metadata');

const VERSION = 1;
const KINDS = new Set(['volume', 'text', 'gif', 'image', 'zoom', 'speed', 'blur', 'sound']);
const ANIMS = new Set(['none', 'fade', 'pop', 'zoom', 'slide', 'drop', 'side', 'wipe', 'type']);
const STYLES = new Set(['clean', 'outline', 'box', 'loud']);
// what a zoom takes along, see ZoomFollow in src/types/clips.d.ts
const FOLLOW = new Set(['text', 'subtitles', 'media']);
const SOUND_EXTS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus'];
// subtitles on a long clip are a few hundred lines
const MAX_ITEMS = 1000;
const MAX_TEXT = 200;
// model.ts in the player caps it the same, every key is a term in the export's ffmpeg expression
const MAX_ZOOM_KEYS = 24;

const safeName = (clipName) => clipName.replace(/\//g, '--');

async function paths(clipName, getSettings) {
  const settings = await getSettings();
  const folder = metadata.getMetadataFolder(settings.clipLocation);
  const safe = safeName(clipName);
  return {
    file: path.join(folder, `${safe}.layers`),
    legacyRange: path.join(folder, `${safe}.volumerange`),
    media: path.join(folder, 'layers_media', safe),
  };
}

const num = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** drops anything malformed; the file is user data, the renderer is not trusted blindly */
function sanitize(raw, mediaDir) {
  if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;
  const start = num(raw.start, 0, 86400, NaN);
  const end = num(raw.end, 0, 86400, NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.05) return null;
  const base = { id: str(raw.id, 40) || crypto.randomBytes(6).toString('hex'), kind: raw.kind, start, end };
  if (raw.kind === 'volume') {
    const track = raw.track === 'all' ? 'all' : Number.isInteger(raw.track) && raw.track >= 0 && raw.track < 64 ? raw.track : 'all';
    return { ...base, track, level: num(raw.level, 0, 4, 1), fade: num(raw.fade, 0, 5, 0) };
  }
  // media must sit in this clip's media folder, a layers file never points ffmpeg elsewhere
  const inMedia = (p) => typeof p === 'string' && path.dirname(path.resolve(p)) === path.resolve(mediaDir);
  if (raw.kind === 'zoom') {
    const zoom = { ...base, x: num(raw.x, 0, 100, 50), y: num(raw.y, 0, 100, 50), scale: num(raw.scale, 1.1, 4, 1.6), ease: num(raw.ease, 0, 2, 0.4) };
    // t counts from the layer's start and may fall outside it after a trim, the path still runs through it
    const keys = (Array.isArray(raw.keys) ? raw.keys : [])
      .filter((k) => k && Number.isFinite(Number(k.t)))
      .map((k) => ({ t: num(k.t, -86400, 86400, 0), x: num(k.x, 0, 100, 50), y: num(k.y, 0, 100, 50), scale: num(k.scale, 1.1, 4, 1.6) }))
      .sort((a, b) => a.t - b.t)
      .filter((k, i, all) => i === 0 || k.t - all[i - 1].t > 0.001)
      .slice(0, MAX_ZOOM_KEYS);
    const follow = Array.isArray(raw.follow) ? [...new Set(raw.follow.filter((f) => FOLLOW.has(f)))] : null;
    return { ...zoom, ...(keys.length ? { keys } : {}), ...(follow ? { follow } : {}) };
  }
  if (raw.kind === 'speed') return { ...base, rate: num(raw.rate, 0.25, 4, 0.5), ...(raw.sounds === false ? { sounds: false } : {}) };
  if (raw.kind === 'blur') {
    return {
      ...base,
      x: num(raw.x, 0, 100, 50),
      y: num(raw.y, 0, 100, 50),
      w: num(raw.w, 1, 100, 20),
      h: num(raw.h, 1, 100, 12),
      mode: raw.mode === 'pixelate' ? 'pixelate' : 'blur',
      strength: num(raw.strength, 0, 1, 0.6),
    };
  }
  if (raw.kind === 'sound') {
    return {
      ...base,
      file: inMedia(raw.file) ? raw.file : null,
      name: str(raw.name, 120),
      level: num(raw.level, 0, 2, 1),
      fade: num(raw.fade, 0, 5, 0),
      duration: num(raw.duration, 0, 86400, 0),
    };
  }
  // details stay unset unless given, unset means the default the player and export share
  const opt = (key, lo, hi) => (Number.isFinite(Number(raw[key])) && raw[key] !== null ? { [key]: num(raw[key], lo, hi, lo) } : {});
  const visual = {
    ...base,
    x: num(raw.x, 0, 100, 50),
    y: num(raw.y, 0, 100, 50),
    ain: ANIMS.has(raw.ain) ? raw.ain : 'fade',
    aout: ANIMS.has(raw.aout) && raw.aout !== 'type' ? raw.aout : 'fade',
    ...opt('din', 0.05, 3),
    ...opt('dout', 0.05, 3),
    ...opt('opacity', 0, 1),
  };
  if (raw.kind === 'text') {
    const raster = raw.raster && inMedia(raw.raster.file)
      ? {
          file: raw.raster.file,
          w: num(raw.raster.w, 1, 16384, 1),
          h: num(raw.raster.h, 1, 16384, 1),
          refW: num(raw.raster.refW, 16, 16384, 1920),
          // what it was rendered from, the player re-renders when this stops matching
          key: str(raw.raster.key, 400),
        }
      : null;
    return {
      ...visual,
      text: str(raw.text, MAX_TEXT),
      style: STYLES.has(raw.style) ? raw.style : 'clean',
      color: /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#ffffff',
      size: num(raw.size, 0.5, 60, 4.6),
      ...opt('outline', 0, 0.6),
      ...opt('shadow', 0, 3),
      ...opt('boxOpacity', 0, 1),
      ...opt('spacing', -0.1, 0.5),
      raster,
      ...(raw.source === 'subtitles' ? { source: 'subtitles' } : {}),
      ...(Number.isInteger(raw.speaker) && raw.speaker >= 0 && raw.speaker < 64 ? { speaker: raw.speaker } : {}),
    };
  }
  const file = inMedia(raw.file) ? raw.file : null;
  // no upper cap that matters: a gif blown up past the frame is a choice, not an error
  const media = { ...visual, w: num(raw.w, 0.5, 1000, 16), file, aspect: num(raw.aspect, 0.05, 20, 1) };
  if (raw.kind === 'gif') {
    return { ...media, gif: { id: str(raw.gif?.id, 40), title: str(raw.gif?.title, 120), url: str(raw.gif?.url, 500) } };
  }
  return media;
}

async function readLegacyRange(p) {
  try {
    const r = JSON.parse(await fs.readFile(p.legacyRange, 'utf8'));
    if (r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start) {
      return [{ id: 'range', kind: 'volume', start: r.start, end: r.end, track: 'all', level: Number.isFinite(r.level) ? r.level : 0, fade: 0 }];
    }
  } catch {
    /* none or unreadable, nothing to migrate */
  }
  return [];
}

async function getLayers(clipName, getSettings) {
  const p = await paths(clipName, getSettings);
  let raw;
  try {
    raw = await fs.readFile(p.file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { items: await readLegacyRange(p) };
  }
  try {
    const data = JSON.parse(raw);
    const items = (Array.isArray(data?.items) ? data.items : []).map((i) => sanitize(i, p.media)).filter(Boolean);
    return { items };
  } catch {
    // keep the broken file next to it instead of deleting the user's work
    logger.error(`Corrupt layers file for ${clipName}; moved aside`);
    telemetry.event('layers_file_corrupt', {
      kind: telemetry.KIND.DATA_LOSS,
      severity: telemetry.SEVERITY.WARNING,
      context: { file_bytes: Buffer.byteLength(raw, 'utf8') }
    });
    await fs.rename(p.file, `${p.file}.corrupt`).catch(() => {});
    return { items: [] };
  }
}

/** removes media files no layer points at anymore. extra: files the player's undo history can
 * still bring back */
async function collectMedia(mediaDir, items, extra = []) {
  let names;
  try {
    names = await fs.readdir(mediaDir);
  } catch {
    return;
  }
  const keep = new Set((Array.isArray(extra) ? extra : []).filter((f) => typeof f === 'string').map((f) => path.basename(f)));
  for (const i of items) {
    if (i.file) keep.add(path.basename(i.file));
    if (i.raster?.file) keep.add(path.basename(i.raster.file));
  }
  await Promise.all(names.filter((n) => !keep.has(n)).map((n) => fs.unlink(path.join(mediaDir, n)).catch(() => {})));
  if (keep.size === 0) await fs.rmdir(mediaDir).catch(() => {});
}

async function saveLayers(clipName, items, getSettings, keep = []) {
  const p = await paths(clipName, getSettings);
  const clean = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS).map((i) => sanitize(i, p.media)).filter(Boolean);
  try {
    if (clean.length === 0) await fs.unlink(p.file).catch((e) => { if (e.code !== 'ENOENT') throw e; });
    else await metadata.writeFileAtomically(p.file, JSON.stringify({ version: VERSION, items: clean }));
    // the range lives on as a layer now, left in place export would apply it twice
    await fs.unlink(p.legacyRange).catch(() => {});
    await collectMedia(p.media, clean, keep);
    return { success: true };
  } catch (error) {
    logger.error(`Error saving layers for ${clipName}:`, error);
    return { success: false, error: error.message };
  }
}

/** text layers come in as png bytes rendered by the player, same fonts as on screen */
async function writeTextRaster(clipName, id, bytes, getSettings) {
  const p = await paths(clipName, getSettings);
  const buf = Buffer.from(bytes);
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  const file = path.join(p.media, `text-${safeName(String(id)).replace(/[^\w-]/g, '')}-${hash}.png`);
  await fs.mkdir(p.media, { recursive: true });
  await fs.writeFile(file, buf);
  return { file };
}

async function importImage(clipName, sourcePath, getSettings) {
  const p = await paths(clipName, getSettings);
  const ext = path.extname(sourcePath).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) throw new Error('Unsupported image type');
  const buf = await fs.readFile(sourcePath);
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  const file = path.join(p.media, `img-${hash}${ext}`);
  await fs.mkdir(p.media, { recursive: true });
  await fs.writeFile(file, buf);
  return { file };
}

async function importSound(clipName, sourcePath, getSettings) {
  const p = await paths(clipName, getSettings);
  const ext = path.extname(sourcePath).toLowerCase();
  if (!SOUND_EXTS.includes(ext)) throw new Error('Unsupported audio type');
  const stat = await fs.stat(sourcePath);
  // a sound effect, not an album; export mixes the whole file in
  if (stat.size > 50 * 1024 * 1024) throw new Error('That file is over 50 MB. Pick a shorter sound.');
  const buf = await fs.readFile(sourcePath);
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  const file = path.join(p.media, `snd-${hash}${ext}`);
  await fs.mkdir(p.media, { recursive: true });
  await fs.writeFile(file, buf);
  return { file, name: path.basename(sourcePath, ext).slice(0, 120) };
}

/** paste from another clip: its media lives in that clip's folder, which cleans up on its own */
async function copyMedia(clipName, sourceFile, getSettings) {
  const p = await paths(clipName, getSettings);
  const root = path.resolve(path.dirname(p.media));
  const src = path.resolve(String(sourceFile || ''));
  // only files some clip's layers own, never an arbitrary path from the renderer
  if (path.dirname(path.dirname(src)) !== root) throw new Error('Not a layer media file');
  if (path.dirname(src) === path.resolve(p.media)) return { file: src };
  const file = path.join(p.media, path.basename(src));
  await fs.mkdir(p.media, { recursive: true });
  await fs.copyFile(src, file);
  return { file };
}

// klipy

let klipyKey;
function getKlipyKey() {
  if (klipyKey !== undefined) return klipyKey;
  try {
    klipyKey = require('./klipy-key.generated.json').key || null;
  } catch {
    klipyKey = null;
  }
  if (!klipyKey) klipyKey = process.env.KLIPY_API_KEY || null;
  return klipyKey;
}

// klipy keys recents per customer; a random id per install, nothing tied to the user
let customerId;
async function getCustomerId() {
  if (customerId) return customerId;
  const file = path.join(app.getPath('userData'), 'klipy.json');
  try {
    customerId = JSON.parse(await fs.readFile(file, 'utf8')).customerId;
  } catch {
    /* first use */
  }
  if (!customerId) {
    customerId = crypto.randomUUID();
    await fs.writeFile(file, JSON.stringify({ customerId })).catch(() => {});
  }
  return customerId;
}

function pickFile(files, sizes, formats) {
  for (const s of sizes) for (const f of formats) if (files?.[s]?.[f]?.url) return files[s][f];
  return null;
}

async function searchGifs({ q = '', page = 1 } = {}, locale) {
  const key = getKlipyKey();
  if (!key) return { items: [], hasNext: false, error: 'no_key' };
  const params = new URLSearchParams({ page: String(page), per_page: '24', customer_id: await getCustomerId() });
  if (locale) params.set('locale', locale);
  const query = String(q).trim().slice(0, 100);
  if (query) params.set('q', query);
  const url = `https://api.klipy.com/api/v1/${encodeURIComponent(key)}/gifs/${query ? 'search' : 'trending'}?${params}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { items: [], hasNext: false, error: `http_${res.status}` };
    const body = await res.json();
    const list = Array.isArray(body?.data?.data) ? body.data.data : [];
    const items = list
      .filter((i) => i && i.type !== 'ad')
      .map((i) => {
        const files = i.file || i.files;
        const preview = pickFile(files, ['sm', 'xs', 'md'], ['webp', 'gif']);
        const full = pickFile(files, ['md', 'hd', 'sm'], ['gif']);
        if (!preview || !full) return null;
        return { id: String(i.id), title: str(i.title, 120), preview: preview.url, url: full.url, width: full.width, height: full.height };
      })
      .filter(Boolean);
    return { items, hasNext: Boolean(body?.data?.has_next) };
  } catch (error) {
    logger.warn(`[klipy] ${query ? 'search' : 'trending'} failed: ${error.message}`);
    return { items: [], hasNext: false, error: error.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** export needs a local file, the picker only had a cdn url */
async function downloadGif(clipName, gif, getSettings) {
  const url = String(gif?.url || '');
  if (!/^https:\/\/([a-z0-9-]+\.)*klipy\.com\//i.test(url)) throw new Error('Not a KLIPY url');
  const p = await paths(clipName, getSettings);
  const file = path.join(p.media, `gif-${String(gif.id).replace(/[^\w-]/g, '').slice(0, 40) || crypto.randomBytes(6).toString('hex')}.gif`);
  try {
    await fs.access(file);
    return { file };
  } catch {
    /* not cached yet */
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`GIF download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(p.media, { recursive: true });
    await fs.writeFile(file, buf);
    return { file };
  } finally {
    clearTimeout(timer);
  }
}

async function removeClipLayers(clipName, getSettings) {
  const p = await paths(clipName, getSettings);
  await fs.rm(p.media, { recursive: true, force: true }).catch(() => {});
}

module.exports = {
  getLayers,
  saveLayers,
  writeTextRaster,
  importImage,
  importSound,
  copyMedia,
  SOUND_EXTS,
  searchGifs,
  downloadGif,
  removeClipLayers,
  layersPath: async (clipName, getSettings) => (await paths(clipName, getSettings)).file,
};
