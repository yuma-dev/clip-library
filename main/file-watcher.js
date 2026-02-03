/**
 * File watcher module - handles chokidar setup for new clips.
 *
 * Watches the clip folder and notifies the caller when new clips are added.
 */

// Imports
const chokidar = require('chokidar');
const path = require('path');
const logger = require('../utils/logger');

// Constants
const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mov', '.mkv', '.webm']);

// Module state
let watcher = null;

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
    return null;
  }

  if (watcher) {
    watcher.close().catch((error) => {
      logger.warn('Error closing existing file watcher:', error);
    });
  }

  watcher = chokidar.watch(clipLocation, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true, // Don't fire events for existing files
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    }
  });

  watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) {
      return;
    }

    const fileName = path.basename(filePath);
    if (typeof onNewClip === 'function') {
      onNewClip(fileName, filePath);
    }
  });

  watcher.on('error', (error) => {
    logger.error('File watcher error:', error);
  });

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

  watcher.close().catch((error) => {
    logger.warn('Error closing file watcher:', error);
  });
  watcher = null;
}

module.exports = {
  setupFileWatcher,
  stopFileWatcher
};
