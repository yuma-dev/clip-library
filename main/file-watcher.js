/**
 * File watcher module - detects new clips landing in the clip folder.
 *
 * One native recursive watch on the clip folder (fs.watch with `recursive`,
 * backed by ReadDirectoryChangesW on Windows). This replaced chokidar, which
 * registered a separate fs.watch per file: on a 2,800-clip library that was
 * about 7 seconds of synchronous native work on the main thread at every
 * launch, during which the browser thread could not bring up the window.
 *
 * A new file is announced only once it has stopped growing (write-finish
 * detection), the way chokidar's awaitWriteFinish did.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm']);
// A clip counts as finished once its size has not changed for this long.
const STABILITY_MS = 2000;
const POLL_MS = 250;

let watcher = null;
let watcherAlive = false;
let currentLocation = '';
let onNewClipCallback = null;
let onOverflowCallback = null;
// filePath -> { size, stableSince, since, timer }
const pending = new Map();
// Announced files, so a burst of change events after the announcement (or a
// rename/change pair for the same create) does not announce twice.
const announced = new Set();

function isHidden(relative) {
  return relative.split('/').some((part) => part.startsWith('.'));
}

function clearPending() {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  announced.clear();
}

function announce(filePath) {
  announced.add(filePath);
  const fileName = path.relative(currentLocation, filePath).replace(/\\/g, '/');
  if (typeof onNewClipCallback === 'function') onNewClipCallback(fileName, filePath);
}

function poll(filePath) {
  const entry = pending.get(filePath);
  if (!entry) return;
  fs.stat(filePath, (error, stats) => {
    if (!pending.has(filePath)) return;
    if (error || !stats.isFile()) {
      // Deleted or replaced before it settled: not a new clip.
      pending.delete(filePath);
      return;
    }
    const now = Date.now();
    if (stats.size !== entry.size) {
      entry.size = stats.size;
      entry.stableSince = now;
    }
    // A file that keeps growing (a recording written straight into the
    // library) is announced only once it stops, however long that takes.
    if (now - entry.stableSince >= STABILITY_MS) {
      pending.delete(filePath);
      announce(filePath);
      return;
    }
    entry.timer = setTimeout(() => poll(filePath), POLL_MS);
  });
}

function track(filePath) {
  if (announced.has(filePath)) return;
  const existing = pending.get(filePath);
  if (existing) {
    // Still being written: the poller keeps watching its size.
    return;
  }
  const now = Date.now();
  const entry = { size: -1, stableSince: now, since: now, timer: null };
  pending.set(filePath, entry);
  entry.timer = setTimeout(() => poll(filePath), POLL_MS);
}

// A directory moved or renamed into the library arrives as one rename event
// for the directory; the clips inside get no events of their own. Walk it.
function trackDirectory(dirPath) {
  fs.readdir(dirPath, { withFileTypes: true }, (error, entries) => {
    if (error) return;
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'icons') trackDirectory(full);
      } else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        track(full);
      }
    }
  });
}

function onFsEvent(eventType, filename) {
  if (!filename) {
    // ReadDirectoryChangesW buffer overflow: events were dropped. Let the
    // owner rescan rather than miss a clip until the next launch.
    if (typeof onOverflowCallback === 'function') {
      Promise.resolve().then(onOverflowCallback).catch((error) => logger.warn(`Watcher rescan failed: ${error.message}`));
    }
    return;
  }
  const relative = String(filename).replace(/\\/g, '/');
  if (isHidden(relative)) return;
  const filePath = path.join(currentLocation, String(filename));
  if (!VIDEO_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
    if (eventType !== 'rename' || relative.split('/').includes('icons')) return;
    fs.stat(filePath, (error, stats) => {
      if (!error && stats.isDirectory()) trackDirectory(filePath);
    });
    return;
  }
  if (eventType === 'rename') {
    // Create, move-in, or delete. A delete drops any pending entry; a create
    // starts tracking. The stat in poll() tells the two apart.
    if (announced.has(filePath)) {
      fs.stat(filePath, (error) => {
        if (error) announced.delete(filePath);
      });
      return;
    }
    track(filePath);
  } else if (pending.has(filePath)) {
    // Bytes still arriving for a tracked file: nothing to do, the poller
    // notices the growing size. Untracked change events (an existing clip
    // rewritten in place) are not new clips.
  }
}

/**
 * Set up the file watcher for the clip location.
 * @param {string} clipLocation - Base clip folder path.
 * @param {object} options - Optional callbacks.
 * @param {Function} options.onNewClip - Called with (fileName, filePath) on new clip.
 * @param {Function} [options.onOverflow] - Called when events were lost; should rescan.
 * @returns {object|null} Watcher instance or null if not started.
 */
function setupFileWatcher(clipLocation, { onNewClip, onOverflow } = {}) {
  if (!clipLocation) {
    logger.warn('No clip location provided for file watcher');
    telemetry.event('watcher_not_started', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING
    });
    return null;
  }

  stopFileWatcher();
  const setupAtMs = Date.now();
  currentLocation = clipLocation;
  onNewClipCallback = onNewClip;
  onOverflowCallback = onOverflow;

  try {
    watcher = fs.watch(clipLocation, { persistent: true, recursive: true }, onFsEvent);
  } catch (error) {
    logger.error('File watcher failed to start:', error);
    watcherAlive = false;
    telemetry.event('watcher_error', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      context: { errno: error?.code, ms_since_setup: 0 }
    });
    return null;
  }
  watcherAlive = true;

  watcher.on('error', (error) => {
    logger.error('File watcher error:', error);
    watcherAlive = false;
    // Nothing restarts the watcher after this: on a network share or a removed
    // drive new clip detection stops for the rest of the session.
    telemetry.event('watcher_error', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      context: {
        errno: error?.code,
        ms_since_setup: Date.now() - setupAtMs
      }
    });
  });

  // One directory handle, ready as soon as it is opened.
  telemetry.metric('watcher_ready_ms', Date.now() - setupAtMs, { unit: 'ms' });
  logger.info(`File watcher set up for: ${clipLocation}`);
  return watcher;
}

/**
 * Stop and clear the file watcher.
 */
function stopFileWatcher() {
  clearPending();
  if (!watcher) return;
  try {
    watcher.close();
  } catch (error) {
    logger.warn('Error closing file watcher:', error);
    telemetry.event('watcher_close_failed', {
      kind: telemetry.KIND.DEGRADED,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno: error?.code }
    });
  }
  watcher = null;
  watcherAlive = false;
}

/**
 * Whether a watcher is currently running and has not errored out.
 * @returns {boolean}
 */
function isWatcherAlive() {
  return watcherAlive;
}

module.exports = {
  setupFileWatcher,
  stopFileWatcher,
  isWatcherAlive
};
