/**
 * Diagnostics Manager Module
 *
 * Handles diagnostics bundle generation and progress reporting.
 */

// Imports
const { ipcRenderer, shell } = require('electron');
const logger = require('../utils/logger');
const consoleBuffer = require('../utils/console-log-buffer');
const state = require('./state');

// Status labels
const DIAGNOSTICS_STAGE_LABELS = {
  initializing: 'Preparing workspace',
  'system-info': 'Collecting system info',
  logs: 'Gathering logs',
  'settings-files': 'Gathering settings files',
  'settings-snapshot': 'Capturing settings snapshot',
  'activity-logs': 'Bundling activity history',
  complete: 'Complete'
};

let diagnosticsButtonDefaultLabel = 'Generate Zip';
let uploadLogsButtonDefaultLabel = 'Upload Logs';
let uploadLogsCopyTimeout = null;
let initialized = false;

// Formatting helpers
function formatBytes(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  const digits = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

// UI helpers
function setDiagnosticsStatusMessage(message, statusState = 'info') {
  if (!state.diagnosticsStatusEl) return;
  state.diagnosticsStatusEl.textContent = message;
  state.diagnosticsStatusEl.dataset.state = statusState;
}

function setUploadStatusMessage(message, statusState = 'info') {
  if (!state.uploadLogsStatusEl) return;
  state.uploadLogsStatusEl.textContent = message;
  state.uploadLogsStatusEl.dataset.state = statusState;
}

function setUploadStatusLink(url) {
  if (!state.uploadLogsStatusEl) return;
  state.uploadLogsStatusEl.textContent = '';
  const link = document.createElement('a');
  link.href = url;
  link.textContent = url;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    shell.openExternal(url);
  });
  state.uploadLogsStatusEl.appendChild(document.createTextNode('Uploaded. Share link: '));
  state.uploadLogsStatusEl.appendChild(link);
  state.uploadLogsStatusEl.dataset.state = 'success';
}

async function copyToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Update diagnostics status UI based on progress payload.
 */
function updateDiagnosticsStatus(progress) {
  if (!state.diagnosticsStatusEl) return;
  const label = DIAGNOSTICS_STAGE_LABELS[progress.stage] || progress.stage;

  if (progress.stage === 'complete') {
    const sizeText = typeof progress.bytes === 'number' ? ` (${formatBytes(progress.bytes)})` : '';
    state.diagnosticsStatusEl.textContent = `${label}${sizeText}`;
    state.diagnosticsStatusEl.dataset.state = 'success';
    return;
  }

  const total = Number(progress.total) || 0;
  const completed = Number(progress.completed) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  const percentText = percent ? ` (${percent}%)` : '';
  state.diagnosticsStatusEl.textContent = `${label}${percentText}`;
  state.diagnosticsStatusEl.dataset.state = 'progress';
}

// Action handlers
async function handleDiagnosticsGeneration() {
  if (state.diagnosticsInProgress) return;

  const targetPath = await ipcRenderer.invoke('show-diagnostics-save-dialog');
  if (!targetPath) {
    setDiagnosticsStatusMessage('Diagnostics generation cancelled.', 'info');
    return;
  }

  state.diagnosticsInProgress = true;
  setDiagnosticsStatusMessage('Preparing diagnostics bundle...', 'progress');

  if (state.generateDiagnosticsBtn) {
    state.generateDiagnosticsBtn.disabled = true;
    state.generateDiagnosticsBtn.textContent = 'Generating...';
  }

  try {
    const response = await ipcRenderer.invoke('generate-diagnostics-zip', targetPath);

    if (!response?.success) {
      throw new Error(response?.error || 'Unknown error');
    }

    const sizeText = typeof response.size === 'number' ? ` (${formatBytes(response.size)})` : '';
    setDiagnosticsStatusMessage(`Diagnostics saved to: ${response.zipPath}${sizeText}`, 'success');
  } catch (error) {
    logger.error('Failed to generate diagnostics bundle:', error);
    setDiagnosticsStatusMessage(`Failed to generate diagnostics: ${error.message}`, 'error');
  } finally {
    state.diagnosticsInProgress = false;
    if (state.generateDiagnosticsBtn) {
      state.generateDiagnosticsBtn.disabled = false;
      state.generateDiagnosticsBtn.textContent = diagnosticsButtonDefaultLabel;
    }
  }
}

async function handleLogsUpload() {
  if (state.uploadLogsInProgress) return;

  state.uploadLogsInProgress = true;
  setUploadStatusMessage('Uploading logs...', 'progress');

  if (state.uploadLogsBtn) {
    state.uploadLogsBtn.disabled = true;
    state.uploadLogsBtn.textContent = 'Uploading...';
  }

  try {
    const rendererConsoleLogs = consoleBuffer.getBufferText();
    const response = await ipcRenderer.invoke('upload-session-logs', {
      rendererConsoleLogs
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Unknown error');
    }

    if (response.url) {
      setUploadStatusLink(response.url);
      const copied = await copyToClipboard(response.url);
      if (copied && state.uploadLogsBtn) {
        state.uploadLogsBtn.textContent = 'Link Copied!';
        if (uploadLogsCopyTimeout) clearTimeout(uploadLogsCopyTimeout);
        uploadLogsCopyTimeout = setTimeout(() => {
          if (state.uploadLogsBtn) {
            state.uploadLogsBtn.textContent = uploadLogsButtonDefaultLabel;
          }
        }, 30000);
      }
    } else if (response.raw) {
      setUploadStatusMessage(`Uploaded. Response: ${response.raw}`, 'success');
    } else {
      setUploadStatusMessage('Uploaded. Share link not provided.', 'success');
    }
  } catch (error) {
    logger.error('Failed to upload session logs:', error);
    setUploadStatusMessage(`Upload failed: ${error.message}`, 'error');
  } finally {
    state.uploadLogsInProgress = false;
    if (state.uploadLogsBtn) {
      state.uploadLogsBtn.disabled = false;
      state.uploadLogsBtn.textContent = uploadLogsButtonDefaultLabel;
    }
  }
}

// Module API
function init({ generateDiagnosticsBtn, diagnosticsStatusEl, uploadLogsBtn, uploadLogsStatusEl } = {}) {
  if (initialized) return;

  if (generateDiagnosticsBtn) state.generateDiagnosticsBtn = generateDiagnosticsBtn;
  if (diagnosticsStatusEl) state.diagnosticsStatusEl = diagnosticsStatusEl;
  if (uploadLogsBtn) state.uploadLogsBtn = uploadLogsBtn;
  if (uploadLogsStatusEl) state.uploadLogsStatusEl = uploadLogsStatusEl;

  if (state.generateDiagnosticsBtn) {
    diagnosticsButtonDefaultLabel = state.generateDiagnosticsBtn.textContent || diagnosticsButtonDefaultLabel;
    state.generateDiagnosticsBtn.addEventListener('click', handleDiagnosticsGeneration);
  }

  if (state.uploadLogsBtn) {
    uploadLogsButtonDefaultLabel = state.uploadLogsBtn.textContent || uploadLogsButtonDefaultLabel;
    state.uploadLogsBtn.addEventListener('click', handleLogsUpload);
  }

  ipcRenderer.on('diagnostics-progress', (event, progress) => {
    if (!state.diagnosticsInProgress) return;
    updateDiagnosticsStatus(progress);
  });

  initialized = true;
}

module.exports = {
  init,
  handleDiagnosticsGeneration
};
