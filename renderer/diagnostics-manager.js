/**
 * Diagnostics Manager Module
 *
 * Handles diagnostics bundle generation and progress reporting.
 */

const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');
const state = require('./state');

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
let initialized = false;

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

function setDiagnosticsStatusMessage(message, statusState = 'info') {
  if (!state.diagnosticsStatusEl) return;
  state.diagnosticsStatusEl.textContent = message;
  state.diagnosticsStatusEl.dataset.state = statusState;
}

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

function init({ generateDiagnosticsBtn, diagnosticsStatusEl } = {}) {
  if (initialized) return;

  if (generateDiagnosticsBtn) state.generateDiagnosticsBtn = generateDiagnosticsBtn;
  if (diagnosticsStatusEl) state.diagnosticsStatusEl = diagnosticsStatusEl;

  if (state.generateDiagnosticsBtn) {
    diagnosticsButtonDefaultLabel = state.generateDiagnosticsBtn.textContent || diagnosticsButtonDefaultLabel;
    state.generateDiagnosticsBtn.addEventListener('click', handleDiagnosticsGeneration);
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
