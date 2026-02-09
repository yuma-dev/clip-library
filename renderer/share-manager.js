/**
 * Share Manager Module
 *
 * Handles:
 * - Sharing auth status verification
 * - ClipLib one-click connect/disconnect flow
 * - Clip publish flow with share modal + featuring picker
 */

const { ipcRenderer } = require('electron');
const { pathToFileURL } = require('url');
const logger = require('../utils/logger');

const NOT_CONFIGURED_ERROR = 'API token is not configured.';
const FALLBACK_AVATAR_SRC = 'icon.ico';
const SHARE_MODAL_ID = 'clip-share-modal';
const MENTION_USERS_CACHE_TTL_MS = 30 * 60 * 1000;

let showCustomAlert = null;
let getSharePayload = null;
let getSharePreviewData = null;

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
let mentionUsersCache = null;
let mentionUsersCacheTime = 0;
let mentionUsersInFlight = null;

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

function ensureShareModal() {
  let modal = document.getElementById(SHARE_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = SHARE_MODAL_ID;
  modal.className = 'clip-share-modal';
  modal.setAttribute('aria-hidden', 'true');
  modal.innerHTML = `
    <div class="clip-share-modal__backdrop" data-role="cancel"></div>
    <div class="clip-share-modal__panel" role="dialog" aria-modal="true" aria-labelledby="clip-share-modal-title">
      <div class="clip-share-modal__header">
        <h2 id="clip-share-modal-title">Publish to ClipLib</h2>
        <button type="button" class="clip-share-modal__x" data-role="cancel" aria-label="Close publish modal">x</button>
      </div>
      <div class="clip-share-modal__body">
        <label class="clip-share-modal__field">
          <span class="clip-share-modal__label">Title</span>
          <input id="clip-share-modal-title-input" type="text" maxlength="120" placeholder="Clip title" />
        </label>
        <div class="clip-share-modal__preview-shell">
          <img id="clip-share-modal-preview" class="clip-share-modal__preview" alt="Clip thumbnail preview" />
        </div>
        <div class="clip-share-modal__field">
          <div class="clip-share-modal__label-row">
            <span class="clip-share-modal__label">Featuring</span>
            <span id="clip-share-modal-feature-count" class="clip-share-modal__hint">0 selected</span>
          </div>
          <input id="clip-share-modal-user-search" type="text" maxlength="80" placeholder="Search users..." />
          <div id="clip-share-modal-users" class="clip-share-modal__users"></div>
          <div id="clip-share-modal-users-status" class="clip-share-modal__status"></div>
        </div>
      </div>
      <div class="clip-share-modal__footer">
        <button id="clip-share-modal-cancel" type="button" class="clip-share-modal__cancel" data-role="cancel">Cancel</button>
        <button id="clip-share-modal-submit" type="button" class="clip-share-modal__submit">Publish</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  return modal;
}

function clearMentionUsersCache() {
  mentionUsersCache = null;
  mentionUsersCacheTime = 0;
  mentionUsersInFlight = null;
}

function toFileSource(value) {
  if (typeof value !== 'string') return '';
  const source = value.trim();
  if (!source) return '';
  if (/^(https?:|file:)/i.test(source)) {
    return source;
  }
  try {
    return pathToFileURL(source).toString();
  } catch (_) {
    return '';
  }
}

function normalizeMentionUser(rawUser = {}) {
  const id = typeof rawUser.id === 'string' ? rawUser.id.trim() : '';
  if (!id) return null;

  const username = typeof rawUser.username === 'string' ? rawUser.username.trim() : '';
  const displayNameRaw = typeof rawUser.displayName === 'string' ? rawUser.displayName.trim() : '';
  const displayName = displayNameRaw || username || id;
  const avatarUrl = typeof rawUser.avatarUrl === 'string' ? rawUser.avatarUrl.trim() : '';

  return {
    id,
    username,
    displayName,
    avatarUrl
  };
}

async function getMentionUsers({ forceRefresh = false } = {}) {
  const cacheStillValid =
    mentionUsersCache &&
    (Date.now() - mentionUsersCacheTime) < MENTION_USERS_CACHE_TTL_MS;

  if (!forceRefresh && cacheStillValid) {
    return mentionUsersCache;
  }

  if (mentionUsersInFlight) {
    return mentionUsersInFlight;
  }

  mentionUsersInFlight = (async () => {
    const result = await ipcRenderer.invoke('get-share-users');
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to load ClipLib users.');
    }

    const users = Array.isArray(result.users)
      ? result.users.map(normalizeMentionUser).filter(Boolean)
      : [];

    users.sort((a, b) => a.displayName.localeCompare(b.displayName));
    mentionUsersCache = users;
    mentionUsersCacheTime = Date.now();
    return users;
  })();

  try {
    return await mentionUsersInFlight;
  } finally {
    mentionUsersInFlight = null;
  }
}

function renderMentionUsersList({
  users,
  selectedIds,
  searchTerm,
  usersContainer,
  statusEl,
  selectedCountEl
}) {
  const normalizedSearch = typeof searchTerm === 'string' ? searchTerm.trim().toLowerCase() : '';
  const visibleUsers = normalizedSearch
    ? users.filter((user) => {
      return user.displayName.toLowerCase().includes(normalizedSearch) ||
        user.username.toLowerCase().includes(normalizedSearch);
    })
    : users;

  usersContainer.innerHTML = '';
  selectedCountEl.textContent = `${selectedIds.size} selected`;

  if (visibleUsers.length === 0) {
    const emptyState = document.createElement('div');
    emptyState.className = 'clip-share-modal__users-empty';
    emptyState.textContent = users.length === 0
      ? 'No users available.'
      : 'No users match your search.';
    usersContainer.appendChild(emptyState);
    return;
  }

  for (const user of visibleUsers) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'clip-share-modal__user';
    row.title = user.username ? `@${user.username}` : user.displayName;
    const isSelected = selectedIds.has(user.id);
    row.classList.toggle('is-selected', isSelected);
    row.setAttribute('aria-pressed', isSelected ? 'true' : 'false');

    row.addEventListener('click', () => {
      if (selectedIds.has(user.id)) {
        selectedIds.delete(user.id);
      } else {
        selectedIds.add(user.id);
      }
      const nowSelected = selectedIds.has(user.id);
      row.classList.toggle('is-selected', nowSelected);
      row.setAttribute('aria-pressed', nowSelected ? 'true' : 'false');
      selectedCountEl.textContent = `${selectedIds.size} selected`;
      statusEl.textContent = '';
    });

    const avatar = document.createElement('img');
    avatar.className = 'clip-share-modal__user-avatar';
    avatar.alt = user.displayName;
    avatar.src = user.avatarUrl || FALLBACK_AVATAR_SRC;
    avatar.onerror = () => {
      avatar.src = FALLBACK_AVATAR_SRC;
    };

    const textWrap = document.createElement('div');
    textWrap.className = 'clip-share-modal__user-text';

    const titleEl = document.createElement('div');
    titleEl.className = 'clip-share-modal__user-title';
    titleEl.textContent = user.displayName;

    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'clip-share-modal__user-subtitle';
    subtitleEl.textContent = user.username ? `@${user.username}` : user.id;

    textWrap.appendChild(titleEl);
    textWrap.appendChild(subtitleEl);

    row.appendChild(avatar);
    row.appendChild(textWrap);
    usersContainer.appendChild(row);
  }
}

async function showPublishModal(initialState = {}) {
  const modal = ensureShareModal();
  const previewEl = modal.querySelector('#clip-share-modal-preview');
  const titleInput = modal.querySelector('#clip-share-modal-title-input');
  const userSearchInput = modal.querySelector('#clip-share-modal-user-search');
  const usersContainer = modal.querySelector('#clip-share-modal-users');
  const statusEl = modal.querySelector('#clip-share-modal-users-status');
  const selectedCountEl = modal.querySelector('#clip-share-modal-feature-count');
  const submitBtn = modal.querySelector('#clip-share-modal-submit');
  const cancelTargets = modal.querySelectorAll('[data-role="cancel"]');

  if (!previewEl || !titleInput || !userSearchInput || !usersContainer || !statusEl || !selectedCountEl || !submitBtn) {
    throw new Error('Publish modal failed to initialize.');
  }

  const initialTitle = typeof initialState.title === 'string' ? initialState.title.trim() : '';
  const initialMentions = Array.isArray(initialState.mentions) ? initialState.mentions : [];
  const selectedIds = new Set(
    initialMentions
      .filter((id) => typeof id === 'string')
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );

  titleInput.value = initialTitle;
  const previewSrc = toFileSource(initialState.thumbnailPath) || FALLBACK_AVATAR_SRC;
  previewEl.src = previewSrc;
  previewEl.onerror = () => {
    previewEl.src = FALLBACK_AVATAR_SRC;
  };

  let mentionUsers = [];
  let settled = false;

  return new Promise((resolve) => {
    const cleanup = () => {
      document.removeEventListener('keydown', handleEsc);
      userSearchInput.oninput = null;
      submitBtn.onclick = null;
      cancelTargets.forEach((node) => {
        node.onclick = null;
      });
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
    };

    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const handleEsc = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        settle(null);
      }
    };

    const renderUsers = () => {
      renderMentionUsersList({
        users: mentionUsers,
        selectedIds,
        searchTerm: userSearchInput.value,
        usersContainer,
        statusEl,
        selectedCountEl
      });
    };

    cancelTargets.forEach((node) => {
      node.onclick = () => settle(null);
    });

    userSearchInput.value = '';
    userSearchInput.oninput = renderUsers;

    submitBtn.onclick = () => {
      const chosenTitle = titleInput.value.trim();
      settle({
        title: chosenTitle,
        mentions: Array.from(selectedIds)
      });
    };

    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', handleEsc);

    selectedCountEl.textContent = `${selectedIds.size} selected`;
    usersContainer.innerHTML = '<div class="clip-share-modal__users-empty">Loading users...</div>';
    statusEl.textContent = '';

    setTimeout(() => {
      titleInput.focus();
      titleInput.select();
    }, 0);

    getMentionUsers()
      .then((users) => {
        if (settled) return;
        mentionUsers = users;
        renderUsers();
      })
      .catch((error) => {
        if (settled) return;
        logger.error('Failed to load mentionable users:', error);
        mentionUsers = [];
        renderUsers();
        statusEl.textContent = `Could not load users: ${error.message}`;
      });
  });
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

  const avatarFromApi = firstDefinedString(
    user.avatarUrl,
    result?.avatarUrl
  );

  const avatarUrl = avatarFromApi || buildDiscordAvatarUrl(
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
  button.title = isSharing ? 'Publishing...' : 'Publish';
  button.setAttribute('aria-label', isSharing ? 'Publishing...' : 'Publish');

  if (isSharing) {
    button.disabled = true;
    button.classList.add('is-sharing');
    return;
  }

  button.classList.remove('is-sharing');
  button.disabled = !authState.connected;
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
    : 'Sign in to publish clips';
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
      clearMentionUsersCache();
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
    clearMentionUsersCache();
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
      await showCustomAlert('Publishing is not connected. Use Settings > General > Continue with ClipLib.');
    }
    return;
  }

  if (typeof getSharePayload !== 'function') {
    logger.error('Missing share payload callback.');
    return;
  }

  let previewData = {};
  if (typeof getSharePreviewData === 'function') {
    try {
      previewData = await getSharePreviewData() || {};
    } catch (error) {
      logger.warn('Failed to build publish preview data:', error);
      previewData = {};
    }
  }

  if (!previewData || !previewData.clipName) {
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert('No clip selected for publishing.');
    }
    return;
  }

  const modalResult = await showPublishModal(previewData);
  if (!modalResult) {
    return;
  }

  let payload = null;
  try {
    payload = await getSharePayload({
      title: modalResult.title,
      mentions: modalResult.mentions
    });
  } catch (error) {
    logger.error('Failed to build publish payload:', error);
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert(`Publish failed: ${error.message}`);
    }
    return;
  }

  if (!payload) {
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert('No clip selected for publishing.');
    }
    return;
  }

  isSharing = true;
  updateShareButtonUi();

  try {
    const result = await ipcRenderer.invoke('share-clip', payload);
    if (result?.success) {
      showShareToast('Clip published!');
      return;
    }

    const errorMessage = result?.error || 'Publish failed.';
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert(errorMessage);
    }

    if (result?.status === 401) {
      await refreshAuthState({ forceVerify: true });
    }
  } catch (error) {
    logger.error('Publish failed:', error);
    if (typeof showCustomAlert === 'function') {
      await showCustomAlert(`Publish failed: ${error.message}`);
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
    clearMentionUsersCache();
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
  clearMentionUsersCache();

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
  getSharePreviewData = dependencies.getSharePreviewData;

  if (!ipcListenersInitialized) {
    ipcRenderer.on('cliplib-auth-event', handleCliplibAuthEvent);
    ipcListenersInitialized = true;
  }

  const button = ensureShareButton();
  if (button && button.dataset.publishHandlerAttached !== 'true') {
    button.addEventListener('click', handleShareClick);
    button.dataset.publishHandlerAttached = 'true';
  }

  updateShareButtonUi();
}

module.exports = {
  init,
  initializeSettingsControls,
  syncSettingsUiFromState,
  refreshAuthState
};
