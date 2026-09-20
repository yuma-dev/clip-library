'use strict';
/**
 * Loudness matching on top of the audio analysis (main/audio-analysis.js): the per-clip
 * integrated loudness lands here as a compact index, .clip_metadata/loudness_v1.json, so the
 * library median is one read. Gains are derived at read time from the target, so changing the
 * target or turning the feature off never touches a clip's own files. Clips with a custom
 * .volume keep it; a value of exactly 1 counts as no custom level.
 */
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');

const INDEX_FILE = 'loudness_v1.json';
const INDEX_VERSION = 3;
// peak headroom and gain limits; a quiet clip with hot peaks lands under target instead of clipping.
// ebur128 measures the sample peak: true peak costs 4x oversampling (+170 ms per clip, 40% of the
// run) and sat at most 0.6 dB above sample peak across 40 clips, so a 1 dB margin covers it
const HEADROOM_DBTP = -1;
const SAMPLE_PEAK_MARGIN_DB = 1;
const MAX_GAIN_DB = 12;
const DEFAULT_TARGET_LUFS = -16;
const SAVE_DEBOUNCE_MS = 1500;

let getSettings = null;
let analysis = null;
let send = null;

// { location, clips: { [name]: { v, mtimeMs, size, lufs, peak, mode } } }
let index = null;
let indexPromise = null;
let saveTimer = null;
let medianCache = null;

function init(deps) {
  getSettings = deps.getSettings;
  analysis = deps.analysis;
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
    await fs.writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, clips: index.clips }));
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

/** an analysis landed (or was found on disk); pushes the matched gain to an open player */
async function record(clipName, entry, fresh) {
  const idx = await loadIndex();
  const prev = idx.clips[clipName];
  const loud = entry.loudness || {};
  if (!prev || prev.mtimeMs !== entry.mtimeMs || prev.size !== entry.size || prev.v !== INDEX_VERSION) {
    idx.clips[clipName] = { v: INDEX_VERSION, mtimeMs: entry.mtimeMs, size: entry.size, lufs: loud.lufs ?? null, peak: loud.peak ?? null, mode: loud.mode || 'none' };
    scheduleSave();
  }
  if (!fresh || !send) return;
  const settings = await getSettings();
  if (!isEnabled(settings)) return;
  const { gain, gainDb } = gainFromEntry(idx.clips[clipName], targetFor(settings));
  send('loudness-measured', { clipName, gain, gainDb, lufs: idx.clips[clipName].lufs });
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
    // the open-state batch already asks the analysis for this clip; nothing more to queue
    return { volume: 1, source: 'default', measured: false };
  }
  const { gain, gainDb, capped, silent } = gainFromEntry(entry, targetFor(settings));
  if (silent) return { volume: 1, source: 'default', measured: true };
  return { volume: gain, source: 'normalized', gain, gainDb, lufs: entry.lufs, capped, measured: true };
}

async function remove(clipName) {
  const idx = await loadIndex();
  if (idx.clips[clipName]) {
    delete idx.clips[clipName];
    scheduleSave();
  }
}

/** analysis reset: the index goes with the sidecars */
async function resetIndex() {
  const idx = await loadIndex();
  idx.clips = {};
  medianCache = null;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await saveIndex();
}

/** everything the settings page draws from: entries, median, effective target */
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
    scan: analysis ? analysis.progressPayload() : { running: false, paused: false, pending: 0, total: 0, done: 0, etaSeconds: null }
  };
}

module.exports = { init, isEnabled, record, resolveVolume, gainFromEntry, remove, resetIndex, flush, getSummary };
