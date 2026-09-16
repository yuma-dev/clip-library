// export operations: full/trimmed video, audio, progress tracking
const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');
const state = require('./state');

let videoPlayerModule, showExportProgress, showCustomAlert, getFfmpegVersion, getPlaybackRate;

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

// per-track volume/hide/mute state for the main process to mix in; null if single-track
function getActiveAudioMix() {
  if (!videoPlayerModule || typeof videoPlayerModule.getActiveAudioTracksManager !== 'function') {
    return null;
  }
  const manager = videoPlayerModule.getActiveAudioTracksManager();
  if (!manager || typeof manager.getExportMix !== 'function') return null;
  try {
    return manager.getExportMix();
  } catch (err) {
    logger.warn('Failed to snapshot audio mix for export:', err);
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
      savePath,
      getActiveAudioMix()
    );
    if (result.success) {
      logger.info(`Video exported successfully via ${result.encoder || 'unknown encoder'}:`, result.path);
      if (result.benchmark) {
        logger.info('[export] benchmark:', result.benchmark);
      }
      showExportProgress(100, 100, !savePath); // no savePath means clipboard export
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting video:", error);
    showCustomAlert("Export failed: " + error.message);
  }
}

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
      savePath,
      getActiveAudioMix()
    );
    if (result.success) {
      logger.info("Audio exported successfully:", result.path);
      if (result.benchmark) {
        logger.info('[export] benchmark:', result.benchmark);
      }
      showExportProgress(100, 100, !savePath); // no savePath means clipboard export
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting audio:", error);
    showCustomAlert("Audio export failed: " + error.message);
  }
}

async function exportTrimmedVideo() {
  if (!state.currentClip) return;

  try {
    await getFfmpegVersion();
    const volume = await videoPlayerModule.loadVolume(state.currentClip.originalName);
    const speed = getCurrentPlaybackRate();
    logger.info(`Exporting video: ${state.currentClip.originalName}`);
    logger.info(`Trim start: ${state.trimStartTime}, Trim end: ${state.trimEndTime}`);
    logger.info(`Volume: ${volume}, Speed: ${speed}`);

    showExportProgress(0, 100, true);

    const result = await ipcRenderer.invoke(
      "export-trimmed-video",
      state.currentClip.originalName,
      state.trimStartTime,
      state.trimEndTime,
      volume,
      speed,
      getActiveAudioMix()
    );

    if (result.success) {
      logger.info(`Trimmed video exported successfully via ${result.encoder || 'unknown encoder'}:`, result.path);
      if (result.benchmark) {
        logger.info('[export] benchmark:', result.benchmark);
      }
      showExportProgress(100, 100, true); // trimmed export is always clipboard
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting video:", error);
    logger.error("Error details:", error.stack);
    await showCustomAlert(`Export failed: ${error.message}. Please check the console for more details.`);
  }
}

function showFallbackNotice() {
  const existing = document.getElementById('export-fallback-notice');
  if (existing) existing.remove();
  const notice = document.createElement('div');
  notice.id = 'export-fallback-notice';
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

function showDecodeFallbackNotice(payload = {}) {
  const existing = document.getElementById('decode-fallback-notice');
  if (existing) existing.remove();

  const sourceCodec = typeof payload.sourceCodec === 'string' && payload.sourceCodec
    ? payload.sourceCodec.toUpperCase()
    : 'Unknown';
  const attempts = Array.isArray(payload.decodeAttempts)
    ? payload.decodeAttempts.filter((item) => item && item !== 'none')
    : [];
  const errors = payload.decodeErrors && typeof payload.decodeErrors === 'object'
    ? payload.decodeErrors
    : {};
  const firstError = Object.values(errors).find((value) => typeof value === 'string' && value.trim().length > 0) || null;
  const attemptText = attempts.length > 0 ? attempts.join(', ') : 'hardware decode';
  const shortError = firstError ? String(firstError).slice(0, 180) : null;
  const safeSourceCodec = escapeHtml(sourceCodec);
  const safeAttemptText = escapeHtml(attemptText);
  const safeShortError = shortError ? escapeHtml(shortError) : null;

  const notice = document.createElement('div');
  notice.id = 'decode-fallback-notice';
  notice.className = 'fallback-notice';
  notice.innerHTML = `
    <p>Hardware decode fallback: using software decode for ${safeSourceCodec} source.</p>
    <p>Tried: ${safeAttemptText}. Export still works, but may be slower.</p>
    ${safeShortError ? `<p>Last decode error: ${safeShortError}</p>` : ''}
    <p>Try updating NVIDIA drivers, keeping Windows GPU drivers up to date, and closing overlays/recorders that hook video decode.</p>
    <button id="close-decode-notice">Close</button>
  `;
  document.body.appendChild(notice);

  const closeButton = document.getElementById('close-decode-notice');
  if (closeButton) {
    closeButton.addEventListener('click', () => {
      notice.remove();
    });
  }
}

module.exports = {
  init,

  exportVideo,
  exportAudio,
  exportTrimmedVideo,
  showFallbackNotice,
  showDecodeFallbackNotice
};
