'use strict';
/**
 * Clip open warmer: does the slow, cacheable part of opening a clip ahead of
 * the click. A cold open pays an ffprobe (~250 ms) and, for multi-track
 * clips, a one-time audio track extraction (~200 to 350 ms); both results
 * are cached on disk (thumbnail .meta and .clip_metadata/audio_tracks_v3),
 * so doing them at idle makes the later open a cache hit.
 *
 * One clip at a time, with a breathing gap, so it never competes with the
 * user: the newest clips are queued a few seconds after the library is on
 * screen, a hovered card jumps the queue, and the queue pauses while a clip
 * is being opened.
 */
const logger = require('../utils/logger');

const GAP_MS = 400;
const PAUSE_ON_OPEN_MS = 6000;

let getSettings = null;
let queue = [];
let running = false;
let pausedUntil = 0;
const done = new Set();
const inFlight = new Set();

function init(settingsGetter) {
  getSettings = settingsGetter;
}

/** Called when the user is opening a clip: keep ffmpeg out of its way. */
function pause(ms = PAUSE_ON_OPEN_MS) {
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
}

/** Lift a long pause early (an export finished). */
function resume() {
  pausedUntil = 0;
}

/** Queue one clip; `priority` puts it at the front (hover). */
function warm(clipName, priority = false) {
  if (typeof clipName !== 'string' || !clipName || done.has(clipName) || inFlight.has(clipName)) return;
  queue = queue.filter((name) => name !== clipName);
  if (priority) queue.unshift(clipName);
  else queue.push(clipName);
  if (!running) void drain();
}

/** Queue the first `count` names in library order (newest first). */
function warmMany(names, count) {
  if (!Array.isArray(names)) return;
  for (const name of names.slice(0, count)) warm(name);
}

/** A clip changed on disk (re-recorded, trimmed): allow warming it again. */
function forget(clipName) {
  done.delete(clipName);
}

async function warmOne(clipName) {
  const ffmpeg = require('./ffmpeg');
  const thumbnails = require('./thumbnails');
  const info = await ffmpeg.getClipInfo(clipName, getSettings, thumbnails);
  const tracks = Array.isArray(info?.audioTracks) ? info.audioTracks : [];
  if (tracks.length > 1) await ffmpeg.extractAudioTracks(clipName, getSettings, thumbnails);
}

async function drain() {
  running = true;
  try {
    while (queue.length && getSettings) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      const clipName = queue.shift();
      if (done.has(clipName)) continue;
      inFlight.add(clipName);
      const startedAt = Date.now();
      try {
        await warmOne(clipName);
        done.add(clipName);
        logger.info(`Warmed clip open in ${Date.now() - startedAt} ms: ${clipName}`);
      } catch (error) {
        // A clip that cannot be probed will fail on open too; nothing to do
        // here but not retry in a loop.
        done.add(clipName);
        logger.warn(`Clip warm failed for ${clipName}: ${error?.message || error}`);
      } finally {
        inFlight.delete(clipName);
      }
      await new Promise((resolve) => setTimeout(resolve, GAP_MS));
    }
  } finally {
    running = false;
  }
}

module.exports = { init, warm, warmMany, forget, pause, resume };
