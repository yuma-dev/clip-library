/**
 * Export Manager Module
 *
 * Handles all export operations:
 * - Video exports (full and trimmed)
 * - Audio exports
 * - Export progress tracking
 */

// Imports
const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');
const state = require('./state');

// Dependencies (injected)
let videoPlayerModule, showExportProgress, showCustomAlert, getFfmpegVersion, getPlaybackRate;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the export manager with required dependencies
 */
function init(dependencies) {
  videoPlayerModule = dependencies.videoPlayerModule;
  showExportProgress = dependencies.showExportProgress;
  showCustomAlert = dependencies.showCustomAlert;
  getFfmpegVersion = dependencies.getFfmpegVersion;
  getPlaybackRate = dependencies.getPlaybackRate;
}

function getCurrentPlaybackRate() {
  if (typeof getPlaybackRate === 'function') {
    const rate = Number(getPlaybackRate());
    if (Number.isFinite(rate) && rate > 0) {
      return rate;
    }
  }
  return 1;
}

// ============================================================================
// EXPORT OPERATIONS
// ============================================================================

async function exportVideo(savePath = null) {
  try {
    const volume = await videoPlayerModule.loadVolume(state.currentClip.originalName);
    const speed = getCurrentPlaybackRate();
    showExportProgress(0, 100, !savePath);
    const result = await ipcRenderer.invoke(
      "export-video",
      state.currentClip.originalName,
      state.trimStartTime,
      state.trimEndTime,
      volume,
      speed,
      savePath
    );
    if (result.success) {
      logger.info(`Video exported successfully via ${result.encoder || 'unknown encoder'}:`, result.path);
      if (result.benchmark) {
        logger.info('[export] benchmark:', result.benchmark);
      }
      showExportProgress(100, 100, !savePath); // Pass true for clipboard export when no savePath
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting video:", error);
    showCustomAlert("Export failed: " + error.message);
  }
}

/**
 * Export audio to file or clipboard.
 */
async function exportAudio(savePath = null) {
  try {
    const volume = await videoPlayerModule.loadVolume(state.currentClip.originalName);
    const speed = getCurrentPlaybackRate();
    showExportProgress(0, 100, !savePath);
    const result = await ipcRenderer.invoke(
      "export-audio",
      state.currentClip.originalName,
      state.trimStartTime,
      state.trimEndTime,
      volume,
      speed,
      savePath
    );
    if (result.success) {
      logger.info("Audio exported successfully:", result.path);
      if (result.benchmark) {
        logger.info('[export] benchmark:', result.benchmark);
      }
      showExportProgress(100, 100, !savePath); // Pass true for clipboard export when no savePath
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting audio:", error);
    showCustomAlert("Audio export failed: " + error.message);
  }
}

/**
 * Export the current trim to clipboard.
 */
async function exportTrimmedVideo() {
  if (!state.currentClip) return;

  try {
    await getFfmpegVersion();
    const volume = await videoPlayerModule.loadVolume(state.currentClip.originalName);
    const speed = getCurrentPlaybackRate();
    logger.info(`Exporting video: ${state.currentClip.originalName}`);
    logger.info(`Trim start: ${state.trimStartTime}, Trim end: ${state.trimEndTime}`);
    logger.info(`Volume: ${volume}, Speed: ${speed}`);

    showExportProgress(0, 100, true); // Show initial progress

    const result = await ipcRenderer.invoke(
      "export-trimmed-video",
      state.currentClip.originalName,
      state.trimStartTime,
      state.trimEndTime,
      volume,
      speed
    );

    if (result.success) {
      logger.info(`Trimmed video exported successfully via ${result.encoder || 'unknown encoder'}:`, result.path);
      if (result.benchmark) {
        logger.info('[export] benchmark:', result.benchmark);
      }
      showExportProgress(100, 100, true); // Always clipboard export for trimmed video
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting video:", error);
    logger.error("Error details:", error.stack);
    await showCustomAlert(`Export failed: ${error.message}. Please check the console for more details.`);
  }
}

/**
 * Show a notice when software encoding is used.
 */
function showFallbackNotice() {
  const notice = document.createElement('div');
  notice.className = 'fallback-notice';
  notice.innerHTML = `
    <p>Your video is being exported using software encoding, which may be slower.</p>
    <p>For faster exports, consider installing NVIDIA CUDA Runtime and updated graphics drivers.</p>
    <button id="close-notice">Close</button>
  `;
  document.body.appendChild(notice);

  document.getElementById('close-notice').addEventListener('click', () => {
    notice.remove();
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Initialization
  init,

  // Export operations
  exportVideo,
  exportAudio,
  exportTrimmedVideo,
  showFallbackNotice
};
