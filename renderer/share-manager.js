/**
 * Share Manager Module
 *
 * Handles:
 * - Sharing auth status verification
 * - ClipLib one-click connect/disconnect flow
 * - One-click clip sharing flow
 */

const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');

const NOT_CONFIGURED_ERROR = 'API token is not configured.';
const FALLBACK_AVATAR_SRC = 'icon.ico';

let showCustomAlert = null;
let getSharePayload = null;

let shareButton = null;
let authButtonEl = null;
let authButtonAvatarEl = null;
let authButtonTitleEl = null;
let authButtonSubtitleEl = null;

let isSharing = false;
let isConnecting = false;
let shareToastTimeout = null;
let controlsInitialized = false;
let ipcListenersInitialized = false;

let authState = {
  configured: false,
  connected: false,
  verifying: false,
  username: '',
  avatarUrl: '',
  error: ''
};

function getSettingsElements() {
  if (!authButtonEl) authButtonEl = document.getElementById('cliplibAuthBtn');
  if (!authButtonAvatarEl) authButtonAvatarEl = document.getElementById('cliplibAuthBtnAvatar');
  if (!authButtonTitleEl) authButtonTitleEl = document.getElementById('cliplibAuthBtnTitle');
  if (!authButtonSubtitleEl) authButtonSubtitleEl = document.getElementById('cliplibAuthBtnSubtitle');
  return { authButtonEl, authButtonAvatarEl, authButtonTitleEl, authButtonSubtitleEl };
}

function ensureShareButton() {
  if (!shareButton) {
    shareButton = document.getElementById('share-button');
  }
  return shareButton;
}

function firstDefinedString(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function buildDiscordAvatarUrl(discordIdRaw, avatarHashRaw) {
  const discordId = firstDefinedString(discordIdRaw);
  const avatarHash = firstDefinedString(avatarHashRaw);
  if (!discordId || !avatarHash) {
    return '';
  }
  const encodedId = encodeURIComponent(discordId);
  const encodedHash = encodeURIComponent(avatarHash);
  return `https://cdn.discordapp.com/avatars/${encodedId}/${encodedHash}.webp?size=64`;
}

function extractProfile(result) {
  const user = result?.user && typeof result.user === 'object' ? result.user : {};
  const username = firstDefinedString(
    user.username,
    user.displayName,
    user.name,
    result?.displayName,
    user.discordId
  ) || 'ClipLib User';

  const avatarUrl = buildDiscordAvatarUrl(
    firstDefinedString(user.discordId, user.discordID, user.discord_id),
    firstDefinedString(user.avatarHash, user.avatar_hash, user.discordAvatarHash)
  );

  return { username, avatarUrl };
}

function setButtonAvatar(url) {
  const { authButtonAvatarEl } = getSettingsElements();
  if (!authButtonAvatarEl) return;

  authButtonAvatarEl.onerror = () => {
    if (authButtonAvatarEl.src.endsWith(FALLBACK_AVATAR_SRC)) return;
    authButtonAvatarEl.src = FALLBACK_AVATAR_SRC;
  };

  authButtonAvatarEl.src = url || FALLBACK_AVATAR_SRC;
}

function updateShareButtonUi() {
  const button = ensureShareButton();
  if (!button) return;

  button.classList.toggle('share-hidden', !authState.connected);

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

function updateAuthButtonUi() {
  const { authButtonEl, authButtonTitleEl, authButtonSubtitleEl } = getSettingsElements();
  if (!authButtonEl || !authButtonTitleEl || !authButtonSubtitleEl) return;

  authButtonEl.disabled = authState.verifying || isConnecting;
  authButtonEl.classList.toggle('is-connected', authState.connected && !authState.verifying && !isConnecting);
  authButtonEl.classList.toggle('is-disconnected', !authState.connected && !authState.verifying && !isConnecting);
  authButtonEl.classList.toggle('is-busy', authState.verifying || isConnecting);

  if (isConnecting) {
    authButtonTitleEl.textContent = 'Continue in Browser';
    authButtonSubtitleEl.textContent = 'Waiting for ClipLib authorization...';
    setButtonAvatar(FALLBACK_AVATAR_SRC);
    return;
  }

  if (authState.verifying) {
    authButtonTitleEl.textContent = 'Checking ClipLib';
    authButtonSubtitleEl.textContent = 'Validating your session...';
    setButtonAvatar(authState.avatarUrl || FALLBACK_AVATAR_SRC);
    return;
  }

  if (authState.connected) {
    authButtonTitleEl.textContent = authState.username || 'ClipLib User';
    authButtonSubtitleEl.textContent = 'Connected to ClipLib · Click to disconnect';
    setButtonAvatar(authState.avatarUrl || FALLBACK_AVATAR_SRC);
    return;
  }

  authButtonTitleEl.textContent = 'Continue with ClipLib';
  authButtonSubtitleEl.textContent = authState.error && authState.error !== NOT_CONFIGURED_ERROR
    ? authState.error
    : 'Sign in to share clips';
  setButtonAvatar(FALLBACK_AVATAR_SRC);
}

function updateAuthStatusUi() {
  updateAuthButtonUi();
  updateShareButtonUi();
}

async function refreshAuthState({ forceVerify = false } = {}) {
  if (!forceVerify && authState.connected && !authState.error) {
    updateAuthStatusUi();
    return { ...authState };
  }

  authState.verifying = true;
  authState.error = '';
  updateAuthStatusUi();

  try {
    const result = await ipcRenderer.invoke('test-share-connection');
    authState.verifying = false;

    if (result?.success) {
      const profile = extractProfile(result);
      authState.configured = true;
      authState.connected = true;
      authState.username = profile.username;
      authState.avatarUrl = profile.avatarUrl;
      authState.error = '';
    } else {
      authState.connected = false;
      authState.username = '';
      authState.avatarUrl = '';
      authState.error = result?.error || 'Connection failed';
      authState.configured = authState.error !== NOT_CONFIGURED_ERROR;
    }

    updateAuthStatusUi();
    return { ...authState };
  } catch (error) {
    authState.verifying = false;
    authState.configured = false;
    authState.connected = false;
    authState.username = '';
    authState.avatarUrl = '';
    authState.error = `Connection failed: ${error.message}`;
    updateAuthStatusUi();
    return { ...authState };
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
      await showCustomAlert('Sharing is not connected. Use Settings > General > Continue with ClipLib.');
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

async function startConnectFlow() {
  isConnecting = true;
  updateAuthStatusUi();

  try {
    const result = await ipcRenderer.invoke('start-cliplib-auth');
    if (!result?.success) {
      isConnecting = false;
      updateAuthStatusUi();
      if (typeof showCustomAlert === 'function') {
        await showCustomAlert(result?.error || 'Failed to open ClipLib login.');
      }
    }
  } catch (error) {
    isConnecting = false;
    updateAuthStatusUi();
    logger.error('Failed to start ClipLib login flow:', error);
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert(`Failed to start ClipLib login: ${error.message}`);
    }
  }
}

async function startDisconnectFlow() {
  isConnecting = true;
  updateAuthStatusUi();

  try {
    const result = await ipcRenderer.invoke('disconnect-cliplib-auth');
    isConnecting = false;
    if (!result?.success) {
      updateAuthStatusUi();
      if (typeof showCustomAlert === 'function') {
        await showCustomAlert(result?.error || 'Failed to disconnect ClipLib account.');
      }
      return;
    }
    await refreshAuthState({ forceVerify: true });
    showShareToast('ClipLib disconnected');
  } catch (error) {
    isConnecting = false;
    updateAuthStatusUi();
    logger.error('Failed disconnecting ClipLib auth:', error);
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert(`Failed to disconnect ClipLib account: ${error.message}`);
    }
  }
}

async function handleAuthButtonClick() {
  if (isConnecting || authState.verifying) return;
  if (authState.connected) {
    await startDisconnectFlow();
    return;
  }
  await startConnectFlow();
}

async function handleCliplibAuthEvent(event, payload) {
  if (!payload || typeof payload !== 'object') return;

  isConnecting = false;

  if (payload.status === 'success') {
    await refreshAuthState({ forceVerify: true });
    return;
  }

  await refreshAuthState({ forceVerify: true });
  if (typeof showCustomAlert === 'function') {
    await showCustomAlert(payload.message || 'ClipLib login failed.');
  }
}

function initializeSettingsControls() {
  const { authButtonEl } = getSettingsElements();
  if (!authButtonEl) return;

  if (controlsInitialized) {
    updateAuthStatusUi();
    return;
  }

  authButtonEl.addEventListener('click', async () => {
    await handleAuthButtonClick();
  });

  controlsInitialized = true;
  updateAuthStatusUi();
}

function syncSettingsUiFromState() {
  updateAuthStatusUi();
}

function init(dependencies = {}) {
  showCustomAlert = dependencies.showCustomAlert;
  getSharePayload = dependencies.getSharePayload;

  if (!ipcListenersInitialized) {
    ipcRenderer.on('cliplib-auth-event', handleCliplibAuthEvent);
    ipcListenersInitialized = true;
  }

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
