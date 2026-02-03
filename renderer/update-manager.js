/**
 * Update Manager Module
 *
 * Handles manual update checks and update notifications.
 */

// Imports
const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');

// Module state
let initialized = false;

/**
 * Handle a manual update check and update status UI.
 */
async function handleManualUpdateCheck() {
  const btn = document.getElementById('checkForUpdatesBtn');
  const statusEl = document.getElementById('updateCheckStatus');

  if (!btn || !statusEl) return;

  const originalText = btn.textContent;
  btn.textContent = 'Checking...';
  btn.disabled = true;
  statusEl.textContent = '';
  statusEl.className = 'settings-item-description update-check-status';

  try {
    logger.info('Manual update check initiated');
    const result = await ipcRenderer.invoke('check-for-updates');

    if (result.updateAvailable) {
      statusEl.textContent = `Update available: v${result.latestVersion}`;
      statusEl.classList.add('update-available');

      ipcRenderer.emit('show-update-notification', null, {
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        changelog: result.changelog
      });
      logger.info(`Update found: ${result.currentVersion} -> ${result.latestVersion}`);
    } else if (result.error === 'network_unavailable') {
      statusEl.textContent = 'Could not connect. Check your internet connection.';
      statusEl.classList.add('update-error');
      logger.warn('Update check failed: network unavailable');
    } else if (result.error === 'rate_limited') {
      statusEl.textContent = 'Too many requests. Please try again later.';
      statusEl.classList.add('update-error');
      logger.warn('Update check failed: rate limited');
    } else if (result.error) {
      statusEl.textContent = `Check failed: ${result.error}`;
      statusEl.classList.add('update-error');
      logger.error(`Update check failed: ${result.error}`);
    } else {
      statusEl.textContent = `You're up to date! (v${result.currentVersion})`;
      statusEl.classList.add('update-current');
      logger.info('Application is up to date');
    }
  } catch (error) {
    statusEl.textContent = 'Failed to check for updates';
    statusEl.classList.add('update-error');
    logger.error('Update check error:', error);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

/**
 * Render the current app version in the settings UI.
 */
async function updateVersionDisplay() {
  try {
    const version = await ipcRenderer.invoke('get-app-version');
    const versionElement = document.getElementById('app-version');
    if (versionElement) {
      versionElement.textContent = version;
    }
  } catch (error) {
    logger.error('Failed to get app version:', error);
  }
}

// Module API
function init() {
  if (initialized) return;

  const checkForUpdatesBtn = document.getElementById('checkForUpdatesBtn');
  if (checkForUpdatesBtn) {
    checkForUpdatesBtn.addEventListener('click', handleManualUpdateCheck);
  }

  ipcRenderer.on('show-update-notification', (event, data) => {
    console.log('[UPDATE] show-update-notification received:', data);
    logger.info('[UPDATE] Received show-update-notification IPC message');

    try {
      if (!data || typeof data !== 'object') {
        logger.error('Invalid update notification data received:', data);
        console.error('[UPDATE] Invalid data:', data);
        return;
      }

      const { currentVersion, latestVersion, changelog } = data;

      logger.info(`Renderer received update notification: ${currentVersion} -> ${latestVersion}`);

      if (document.querySelector('.update-notification')) {
        logger.info('Update notification already exists, skipping');
        return;
      }

      const notification = document.createElement('div');
      notification.className = 'update-notification';
      notification.innerHTML = `
        <div class="update-notification-content">
          <span class="update-text">Update available (${latestVersion || 'unknown'})</span>
          <button class="update-close" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="changelog-container">
          <div class="changelog"></div>
        </div>
      `;

      const changelogContainer = notification.querySelector('.changelog');
      if (changelog) {
        try {
          if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
            const parsed = marked.parse(changelog);
            changelogContainer.innerHTML = DOMPurify.sanitize(parsed);
          } else {
            changelogContainer.textContent = changelog;
            logger.warn('marked or DOMPurify not available, showing raw changelog');
          }
        } catch (parseError) {
          logger.error('Error parsing changelog:', parseError);
          changelogContainer.textContent = changelog;
        }
      } else {
        changelogContainer.textContent = 'No release notes available';
      }

      document.body.appendChild(notification);
      logger.info('Update notification element added to DOM');
      console.log('[UPDATE] Notification element added to DOM:', notification);
      console.log('[UPDATE] Notification parent:', notification.parentElement);

      setTimeout(() => {
        notification.classList.add('show');
        logger.info('Update notification shown');
        console.log('[UPDATE] .show class added, notification should be visible');
        console.log('[UPDATE] Notification classList:', notification.className);
        console.log('[UPDATE] Notification computed style visibility:', window.getComputedStyle(notification).visibility);
      }, 100);

      notification.querySelector('.update-close').addEventListener('click', (e) => {
        e.stopPropagation();
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
        logger.info('Update notification dismissed');
      });

      notification.querySelector('.update-notification-content').addEventListener('click', async (e) => {
        if (e.target.closest('.update-close')) return;

        const content = e.currentTarget;
        const updateText = content.querySelector('.update-text');

        if (content.classList.contains('downloading')) return;

        updateText.textContent = 'Downloading update...';

        const progressBar = document.createElement('div');
        progressBar.className = 'download-progress';
        progressBar.innerHTML = '<div class="progress-fill"></div>';
        content.appendChild(progressBar);
        content.classList.add('downloading');

        const onProgress = (_, progress) => {
          const roundedProgress = Math.round(progress);
          progressBar.querySelector('.progress-fill').style.width = `${progress}%`;
          updateText.textContent = `Downloading update... ${roundedProgress}%`;
        };

        const onError = (_, errorMessage) => {
          logger.error('Update download failed:', errorMessage);
          updateText.textContent = 'Download failed. Click to retry.';
          content.classList.remove('downloading');
          progressBar.remove();
          cleanup();
        };

        const cleanup = () => {
          ipcRenderer.removeListener('download-progress', onProgress);
          ipcRenderer.removeListener('update-download-error', onError);
        };

        ipcRenderer.on('download-progress', onProgress);
        ipcRenderer.on('update-download-error', onError);

        try {
          await ipcRenderer.invoke('start-update');
        } catch (error) {
          logger.error('Update invocation failed:', error);
          updateText.textContent = 'Download failed. Click to retry.';
          content.classList.remove('downloading');
          progressBar.remove();
          cleanup();
        }
      });
    } catch (error) {
      logger.error('Error creating update notification:', error);
    }
  });

  window.updateNotificationTest = {
    show: (options = {}) => {
      const {
        currentVersion = '1.0.0',
        latestVersion = '2.0.0',
        changelog = '## What\'s New\\n- Feature 1\\n- Feature 2\\n- Bug fixes'
      } = options;

      const existing = document.querySelector('.update-notification');
      if (existing) existing.remove();

      const event = new CustomEvent('test-update-notification');
      ipcRenderer.emit('show-update-notification', event, { currentVersion, latestVersion, changelog });

      console.log('Update notification shown. Click on it to simulate downloading.');
      return 'Update notification displayed';
    },

    simulateDownload: (durationMs = 5000) => {
      const notification = document.querySelector('.update-notification');
      if (!notification) {
        console.error('No update notification found. Call updateNotificationTest.show() first.');
        return;
      }

      const content = notification.querySelector('.update-notification-content');
      if (content.classList.contains('downloading')) {
        console.log('Already downloading');
        return;
      }

      const updateText = content.querySelector('.update-text');
      updateText.textContent = 'Downloading update...';

      const progressBar = document.createElement('div');
      progressBar.className = 'download-progress';
      progressBar.innerHTML = '<div class="progress-fill"></div>';
      content.appendChild(progressBar);
      content.classList.add('downloading');

      let progress = 0;
      const interval = setInterval(() => {
        progress += Math.random() * 15;
        if (progress >= 100) {
          progress = 100;
          clearInterval(interval);
          updateText.textContent = 'Download complete!';
          setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => notification.remove(), 300);
          }, 1500);
        }
        progressBar.querySelector('.progress-fill').style.width = `${progress}%`;
        updateText.textContent = `Downloading update... ${Math.round(progress)}%`;
      }, durationMs / 10);

      console.log(`Simulating download over ${durationMs}ms`);
      return 'Download simulation started';
    },

    hide: () => {
      const notification = document.querySelector('.update-notification');
      if (notification) {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
        return 'Update notification hidden';
      }
      return 'No notification to hide';
    }
  };

  initialized = true;
}

module.exports = {
  init,
  handleManualUpdateCheck,
  updateVersionDisplay
};
