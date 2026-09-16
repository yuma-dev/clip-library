// detects new clips landing in the clip folder: one native recursive fs.watch
// (ReadDirectoryChangesW), replacing chokidar's per-file watches which cost
// ~7s of main-thread work at launch on a 2,800-clip library, blocking the window

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm']);
// clip counts as finished once size hasn't changed for this long
const STABILITY_MS = 2000;
const POLL_MS = 250;

let watcher = null;
let watcherAlive = false;
let currentLocation = '';
let onNewClipCallback = null;
let onOverflowCallback = null;
// filePath -> { size, stableSince, since, timer }
const pending = new Map();
// announced files, so a burst of events after (rename/change pair for one create) doesn't double-announce
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
      // deleted or replaced before it settled: not a new clip
      pending.delete(filePath);
      return;
    }
    const now = Date.now();
    if (stats.size !== entry.size) {
      entry.size = stats.size;
      entry.stableSince = now;
    }
    // a recording written straight into the library keeps growing; announce only once it stops
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
    // still being written, poller keeps watching its size
    return;
  }
  const now = Date.now();
  const entry = { size: -1, stableSince: now, since: now, timer: null };
  pending.set(filePath, entry);
  entry.timer = setTimeout(() => poll(filePath), POLL_MS);
}

// a directory move/rename fires one rename event for itself, none for its clips
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
    // ReadDirectoryChangesW overflow, events dropped: let owner rescan
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
    // create, move-in, or delete; the stat in poll() tells them apart
    if (announced.has(filePath)) {
      fs.stat(filePath, (error) => {
        if (error) announced.delete(filePath);
      });
      return;
    }
    track(filePath);
  } else if (pending.has(filePath)) {
    // bytes still arriving for a tracked file, poller notices the growing size
  }
}

/**
 * @param {string} clipLocation
 * @param {object} options
 * @param {Function} options.onNewClip - (fileName, filePath)
 * @param {Function} [options.onOverflow] - events were lost, should rescan
 * @returns {object|null}
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
    // nothing restarts the watcher: a network share or removed drive stops detection for the session
    telemetry.event('watcher_error', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      context: {
        errno: error?.code,
        ms_since_setup: Date.now() - setupAtMs
      }
    });
  });

  telemetry.metric('watcher_ready_ms', Date.now() - setupAtMs, { unit: 'ms' });
  logger.info(`File watcher set up for: ${clipLocation}`);
  return watcher;
}

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

/** @returns {boolean} */
function isWatcherAlive() {
  return watcherAlive;
}

module.exports = {
  setupFileWatcher,
  stopFileWatcher,
  isWatcherAlive
};
