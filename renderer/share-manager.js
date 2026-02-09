/**
 * Share Manager Module
 *
 * Handles:
 * - Sharing auth status verification
 * - Sharing settings UI controls
 * - One-click clip sharing flow
 */

const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');
const state = require('./state');

const DEFAULT_SERVER_URL = 'https://friends.cliplib.app';

let showCustomAlert = null;
let getSharePayload = null;
let updateSettingValue = null;

let shareButton = null;
let statusDotEl = null;
let statusTextEl = null;
let serverUrlInputEl = null;
let apiTokenInputEl = null;
let pasteTokenBtnEl = null;
let testConnectionBtnEl = null;

let isSharing = false;
let shareToastTimeout = null;
let controlsInitialized = false;

let authState = {
  configured: false,
  connected: false,
  verifying: false,
  displayName: '',
  error: ''
};

function normalizeServerUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return DEFAULT_SERVER_URL;
  return raw.replace(/\/+$/, '');
}

function resolveSharingSettingsFromState() {
  const sharing = state.settings?.sharing || {};
  return {
    serverUrl: normalizeServerUrl(sharing.serverUrl),
    apiToken: typeof sharing.apiToken === 'string' ? sharing.apiToken.trim() : ''
  };
}

function getStatusElements() {
  if (!statusDotEl) statusDotEl = document.getElementById('shareConnectionDot');
  if (!statusTextEl) statusTextEl = document.getElementById('shareConnectionStatus');
  return { statusDotEl, statusTextEl };
}

function getSettingsElements() {
  if (!serverUrlInputEl) serverUrlInputEl = document.getElementById('shareServerUrl');
  if (!apiTokenInputEl) apiTokenInputEl = document.getElementById('shareApiToken');
  if (!pasteTokenBtnEl) pasteTokenBtnEl = document.getElementById('pasteShareTokenBtn');
  if (!testConnectionBtnEl) testConnectionBtnEl = document.getElementById('testShareConnectionBtn');
  return { serverUrlInputEl, apiTokenInputEl, pasteTokenBtnEl, testConnectionBtnEl };
}

function ensureShareButton() {
  if (!shareButton) {
    shareButton = document.getElementById('share-button');
  }
  return shareButton;
}

function setConnectionUi(stateName, message) {
  const { statusDotEl: dotEl, statusTextEl: textEl } = getStatusElements();
  if (!dotEl || !textEl) return;

  dotEl.dataset.state = stateName;
  textEl.dataset.state = stateName;
  textEl.textContent = message;
}

function updateShareButtonUi() {
  const button = ensureShareButton();
  if (!button) return;

  const visible = authState.connected;
  button.classList.toggle('share-hidden', !visible);

  if (isSharing) {
    button.disabled = true;
    button.classList.add('is-sharing');
    button.textContent = 'Sharing...';
    return;
  }

  button.classList.remove('is-sharing');
  button.disabled = !authState.connected;
  button.textContent = 'Share';
}

function updateAuthStatusUi() {
  if (authState.verifying) {
    setConnectionUi('progress', 'Checking connection...');
    updateShareButtonUi();
    return;
  }

  if (!authState.configured) {
    setConnectionUi('disconnected', 'Not configured');
    updateShareButtonUi();
    return;
  }

  if (authState.connected) {
    setConnectionUi('connected', `Connected as ${authState.displayName}`);
    updateShareButtonUi();
    return;
  }

  setConnectionUi('disconnected', authState.error || 'Invalid API token');
  updateShareButtonUi();
}

function setButtonLoading(button, isLoading, loadingText, normalText) {
  if (!button) return;
  button.disabled = isLoading;
  button.textContent = isLoading ? loadingText : normalText;
}

function ensureSharingDefaults() {
  if (!state.settings) return;
  if (!state.settings.sharing || typeof state.settings.sharing !== 'object') {
    state.settings.sharing = {
      serverUrl: DEFAULT_SERVER_URL,
      apiToken: ''
    };
  }
  if (typeof state.settings.sharing.serverUrl !== 'string' || !state.settings.sharing.serverUrl.trim()) {
    state.settings.sharing.serverUrl = DEFAULT_SERVER_URL;
  }
  if (typeof state.settings.sharing.apiToken !== 'string') {
    state.settings.sharing.apiToken = '';
  }
}

async function persistSharingSettings(serverUrl, apiToken) {
  if (!updateSettingValue) {
    throw new Error('Share manager is missing updateSettingValue dependency.');
  }

  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const normalizedToken = typeof apiToken === 'string' ? apiToken.trim() : '';

  await updateSettingValue('sharing.serverUrl', normalizedServerUrl);
  await updateSettingValue('sharing.apiToken', normalizedToken);
}

function syncSettingsUiFromState() {
  ensureSharingDefaults();
  const { serverUrl, apiToken } = resolveSharingSettingsFromState();
  const { serverUrlInputEl, apiTokenInputEl } = getSettingsElements();

  if (serverUrlInputEl) {
    serverUrlInputEl.value = serverUrl;
  }
  if (apiTokenInputEl) {
    apiTokenInputEl.value = apiToken;
  }

  updateAuthStatusUi();
}

async function refreshAuthState({ forceVerify = false, overrides = null } = {}) {
  ensureSharingDefaults();

  const fromState = resolveSharingSettingsFromState();
  const serverUrl = normalizeServerUrl(overrides?.serverUrl || fromState.serverUrl);
  const apiToken = typeof (overrides?.apiToken ?? fromState.apiToken) === 'string'
    ? (overrides?.apiToken ?? fromState.apiToken).trim()
    : '';

  authState.configured = Boolean(apiToken);
  authState.error = '';

  if (!authState.configured) {
    authState.connected = false;
    authState.displayName = '';
    authState.verifying = false;
    updateAuthStatusUi();
    return { ...authState };
  }

  if (!forceVerify && authState.connected) {
    updateAuthStatusUi();
    return { ...authState };
  }

  authState.verifying = true;
  updateAuthStatusUi();

  if (testConnectionBtnEl) {
    setButtonLoading(testConnectionBtnEl, true, 'Testing...', 'Test Connection');
  }

  try {
    const result = await ipcRenderer.invoke('test-share-connection', { serverUrl, apiToken });
    authState.verifying = false;

    if (result?.success) {
      authState.connected = true;
      authState.displayName = result.displayName || 'Unknown user';
      authState.error = '';
    } else {
      authState.connected = false;
      authState.displayName = '';
      authState.error = result?.error || 'Connection failed';
    }

    updateAuthStatusUi();
    return { ...authState };
  } catch (error) {
    authState.verifying = false;
    authState.connected = false;
    authState.displayName = '';
    authState.error = `Connection failed: ${error.message}`;
    updateAuthStatusUi();
    return { ...authState };
  } finally {
    if (testConnectionBtnEl) {
      setButtonLoading(testConnectionBtnEl, false, 'Testing...', 'Test Connection');
    }
  }
}

function showShareToast(message) {
  let toast = document.getElementById('share-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'share-toast';
    toast.className = 'share-toast';
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.add('show');

  if (shareToastTimeout) {
    clearTimeout(shareToastTimeout);
  }

  shareToastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

async function handleShareClick() {
  if (isSharing) return;

  if (!authState.connected) {
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert('Sharing is not connected. Configure your API token in Settings > Sharing.');
    }
    return;
  }

  if (typeof getSharePayload !== 'function') {
    logger.error('Missing share payload callback.');
    return;
  }

  let payload = null;
  try {
    payload = await getSharePayload();
  } catch (error) {
    logger.error('Failed to build share payload:', error);
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert(`Share failed: ${error.message}`);
    }
    return;
  }

  if (!payload) {
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert('No clip selected for sharing.');
    }
    return;
  }

  isSharing = true;
  updateShareButtonUi();

  try {
    const result = await ipcRenderer.invoke('share-clip', payload);
    if (result?.success) {
      showShareToast('Clip shared!');
      return;
    }

    const errorMessage = result?.error || 'Share failed.';
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert(errorMessage);
    }

    if (result?.status === 401) {
      await refreshAuthState({ forceVerify: true });
    }
  } catch (error) {
    logger.error('Share failed:', error);
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert(`Share failed: ${error.message}`);
    }
  } finally {
    isSharing = false;
    updateShareButtonUi();
  }
}

async function handlePasteTokenClick() {
  const { apiTokenInputEl } = getSettingsElements();
  if (!apiTokenInputEl) return;

  try {
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      if (typeof text === 'string') {
        apiTokenInputEl.value = text.trim();
      }
    }
  } catch (error) {
    logger.warn('Paste token failed:', error.message);
  }
}

async function saveInputsAndVerify() {
  const { serverUrlInputEl, apiTokenInputEl } = getSettingsElements();
  if (!serverUrlInputEl || !apiTokenInputEl) return;

  const serverUrl = normalizeServerUrl(serverUrlInputEl.value);
  const apiToken = apiTokenInputEl.value.trim();

  serverUrlInputEl.value = serverUrl;
  apiTokenInputEl.value = apiToken;

  await persistSharingSettings(serverUrl, apiToken);
  await refreshAuthState({ forceVerify: true });
}

function initializeSettingsControls({ updateSettingValue: updateSettingValueFn }) {
  updateSettingValue = updateSettingValueFn;

  const { serverUrlInputEl, apiTokenInputEl, pasteTokenBtnEl, testConnectionBtnEl } = getSettingsElements();
  if (!serverUrlInputEl || !apiTokenInputEl || !testConnectionBtnEl) {
    return;
  }

  if (controlsInitialized) {
    syncSettingsUiFromState();
    return;
  }

  serverUrlInputEl.addEventListener('change', async () => {
    try {
      await saveInputsAndVerify();
    } catch (error) {
      logger.error('Failed saving share server URL:', error);
    }
  });

  apiTokenInputEl.addEventListener('change', async () => {
    try {
      await saveInputsAndVerify();
    } catch (error) {
      logger.error('Failed saving share API token:', error);
    }
  });

  if (pasteTokenBtnEl) {
    pasteTokenBtnEl.addEventListener('click', async () => {
      await handlePasteTokenClick();
      try {
        await saveInputsAndVerify();
      } catch (error) {
        logger.error('Failed saving pasted share API token:', error);
      }
    });
  }

  testConnectionBtnEl.addEventListener('click', async () => {
    try {
      await saveInputsAndVerify();
    } catch (error) {
      logger.error('Failed to test share connection:', error);
      if (typeof showCustomAlert === 'function') {
        await showCustomAlert(`Connection test failed: ${error.message}`);
      }
    }
  });

  controlsInitialized = true;
  syncSettingsUiFromState();
}

function init(dependencies = {}) {
  showCustomAlert = dependencies.showCustomAlert;
  getSharePayload = dependencies.getSharePayload;

  const button = ensureShareButton();
  if (button) {
    button.addEventListener('click', handleShareClick);
  }

  updateShareButtonUi();
}

module.exports = {
  init,
  initializeSettingsControls,
  syncSettingsUiFromState,
  refreshAuthState
};
