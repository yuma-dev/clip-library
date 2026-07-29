/**
 * File watcher module - handles chokidar setup for new clips.
 *
 * Watches the clip folder and notifies the caller when new clips are added.
 */

// Imports
const chokidar = require('chokidar');
const path = require('path');
const logger = require('../utils/logger');
const telemetry = require('./telemetry');

// Constants
const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm']);
// A watcher that never reaches 'ready' looks exactly like a watcher over an
// empty folder: no events, no errors, no new clips ever detected.
const READY_TIMEOUT_MS = 60000;

// Module state
let watcher = null;
let readyTimer = null;
// `watcher` alone cannot answer "is new clip detection still working": the
// error handler deliberately leaves the instance in place, so a dead watcher
// would still read as one. This flag tracks liveness explicitly.
let watcherAlive = false;

function clearReadyTimer() {
  if (!readyTimer) return;
  clearTimeout(readyTimer);
  readyTimer = null;
}

/**
 * Set up the file watcher for the clip location.
 * @param {string} clipLocation - Base clip folder path.
 * @param {object} options - Optional callbacks.
 * @param {Function} options.onNewClip - Called with (fileName, filePath) on new clip.
 * @returns {object|null} Chokidar watcher instance or null if not started.
 */
function setupFileWatcher(clipLocation, { onNewClip } = {}) {
  if (!clipLocation) {
    logger.warn('No clip location provided for file watcher');
    telemetry.event('watcher_not_started', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.WARNING
    });
    return null;
  }

  if (watcher) {
    watcher.close().catch((error) => {
      logger.warn('Error closing existing file watcher:', error);
      telemetry.event('watcher_close_failed', {
        kind: telemetry.KIND.DEGRADED,
        severity: telemetry.SEVERITY.WARNING,
        context: { errno: error?.code }
      });
    });
  }

  clearReadyTimer();
  const setupAtMs = Date.now();

  watcher = chokidar.watch(clipLocation, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true, // Don't fire events for existing files
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    }
  });
  watcherAlive = true;

  watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) {
      return;
    }

    const fileName = path.relative(clipLocation, filePath).replace(/\\/g, '/');
    if (typeof onNewClip === 'function') {
      onNewClip(fileName, filePath);
    }
  });

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

  watcher.on('ready', () => {
    clearReadyTimer();
    telemetry.metric('watcher_ready_ms', Date.now() - setupAtMs, { unit: 'ms' });
  });

  readyTimer = setTimeout(() => {
    readyTimer = null;
    telemetry.event('watcher_never_ready', {
      kind: telemetry.KIND.DEGRADED,
      severity: telemetry.SEVERITY.WARNING,
      context: { ms: READY_TIMEOUT_MS }
    });
  }, READY_TIMEOUT_MS);
  if (typeof readyTimer.unref === 'function') readyTimer.unref();

  logger.info(`File watcher set up for: ${clipLocation}`);
  return watcher;
}

/**
 * Stop and clear the file watcher.
 */
function stopFileWatcher() {
  if (!watcher) {
    return;
  }

  clearReadyTimer();
  watcher.close().catch((error) => {
    logger.warn('Error closing file watcher:', error);
    telemetry.event('watcher_close_failed', {
      kind: telemetry.KIND.DEGRADED,
      severity: telemetry.SEVERITY.WARNING,
      context: { errno: error?.code }
    });
  });
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
