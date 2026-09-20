'use strict';
/**
 * Pre-runs the slow, cacheable part of opening a clip: ffprobe (~250ms) and
 * for multi-track clips, audio extraction (~200-350ms), cached to thumbnail
 * .meta and .clip_metadata/audio_tracks_v3, then hands the clip to the audio
 * analysis queue. One clip at a time with a gap, so it never competes with the user.
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

/** user opened a clip: keep ffmpeg out of its way */
function pause(ms = PAUSE_ON_OPEN_MS) {
  pausedUntil = Math.max(pausedUntil, Date.now() + ms);
}

/** lift a long pause early (an export finished) */
function resume() {
  pausedUntil = 0;
}

/** `priority` puts it at the front of the queue (hover) */
function warm(clipName, priority = false) {
  if (typeof clipName !== 'string' || !clipName || done.has(clipName) || inFlight.has(clipName)) return;
  queue = queue.filter((name) => name !== clipName);
  if (priority) queue.unshift(clipName);
  else queue.push(clipName);
  if (!running) void drain();
}

/** first `count` names, newest first */
function warmMany(names, count) {
  if (!Array.isArray(names)) return;
  for (const name of names.slice(0, count)) warm(name);
}

/** clip changed on disk (re-recorded, trimmed): allow warming it again */
function forget(clipName) {
  done.delete(clipName);
}

async function warmOne(clipName) {
  const ffmpeg = require('./ffmpeg');
  const thumbnails = require('./thumbnails');
  const info = await ffmpeg.getClipInfo(clipName, getSettings, thumbnails);
  const tracks = Array.isArray(info?.audioTracks) ? info.audioTracks : [];
  if (tracks.length > 1) await ffmpeg.extractAudioTracks(clipName, getSettings, thumbnails);
  // the listen has its own queue and pause; not awaited so the gap here stays short
  void require('./audio-analysis').warm(clipName);
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
        // unprobeable clip fails on open too; don't retry it in a loop
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
