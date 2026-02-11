// Imports
const { app, ipcMain, shell } = require('electron');
const axios = require('axios');
const semver = require('semver');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Constants
const GITHUB_OWNER = 'yuma-dev';
const GITHUB_REPO = 'clip-library';
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_LATEST_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASES_PREFIX = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
const REQUEST_HEADERS = {
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'clip-library-updater'
};
const DOWNLOAD_RETRY_ATTEMPTS = 3;

// Module state
let updateHandlerRegistered = false;
let openUpdatePageHandlerRegistered = false;
let latestReleaseData = null;
let latestResolvedVersion = null;
let currentMainWindow = null;

function init(mainWindow) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    currentMainWindow = mainWindow;
  }
  ensureIpcHandlers();
}

function ensureIpcHandlers() {
  registerUpdateHandler();
  registerOpenUpdatePageHandler();
}

function isWindowUsable(windowRef) {
  return !!(
    windowRef &&
    !windowRef.isDestroyed() &&
    windowRef.webContents &&
    !windowRef.webContents.isDestroyed()
  );
}

function getActiveWindow(windowRef) {
  if (isWindowUsable(windowRef)) return windowRef;
  if (isWindowUsable(currentMainWindow)) return currentMainWindow;
  return null;
}

function sendToRenderer(channel, payload, windowRef) {
  const targetWindow = getActiveWindow(windowRef);
  if (!targetWindow) return false;

  targetWindow.webContents.send(channel, payload);
  return true;
}

function normalizeVersionTag(tagName) {
  if (typeof tagName !== 'string') return null;
  const trimmed = tagName.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

function normalizeGitHubUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString.trim()) return null;
  const trimmed = urlString.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  if (trimmed.startsWith('/')) {
    return `https://github.com${trimmed}`;
  }
  return null;
}

function extractTagNameFromReleaseUrl(urlString) {
  const normalizedUrl = normalizeGitHubUrl(urlString);
  if (!normalizedUrl) return null;

  const match = normalizedUrl.match(/\/releases\/tag\/([^/?#]+)/i);
  if (!match || !match[1]) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch (error) {
    return match[1];
  }
}

function buildReleaseTagUrl(version) {
  if (!version) return GITHUB_RELEASES_LATEST_URL;
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${version}`;
}

function getManualUpdateUrl(releaseData = latestReleaseData, latestVersion = latestResolvedVersion) {
  if (releaseData && typeof releaseData.html_url === 'string' && releaseData.html_url.trim()) {
    return releaseData.html_url;
  }
  if (latestVersion) {
    return buildReleaseTagUrl(latestVersion);
  }
  return GITHUB_RELEASES_LATEST_URL;
}

function getAllowedManualUpdateUrl(requestedUrl) {
  const normalized = normalizeGitHubUrl(requestedUrl);
  if (!normalized) return getManualUpdateUrl();
  if (normalized.startsWith(GITHUB_RELEASES_PREFIX)) return normalized;
  return getManualUpdateUrl();
}

async function fetchLatestReleaseFromApi() {
  const response = await axios.get(GITHUB_API_URL, {
    timeout: 10000,
    headers: REQUEST_HEADERS
  });

  if (!response.data || !response.data.tag_name) {
    throw new Error('Invalid API response');
  }

  return response.data;
}

async function fetchLatestReleaseFromRedirectFallback() {
  const response = await axios.get(GITHUB_RELEASES_LATEST_URL, {
    timeout: 10000,
    maxRedirects: 0,
    headers: REQUEST_HEADERS,
    validateStatus: (status) => status >= 200 && status < 400
  });

  const location = response.headers?.location || response.request?.res?.responseUrl || '';
  const tagName = extractTagNameFromReleaseUrl(location);

  if (!tagName) {
    throw new Error('Fallback release redirect did not contain a tag');
  }

  const normalizedUrl = normalizeGitHubUrl(location) || buildReleaseTagUrl(normalizeVersionTag(tagName));
  return {
    tag_name: tagName,
    body: '',
    assets: [],
    html_url: normalizedUrl
  };
}

function isNetworkError(error) {
  const networkErrorCodes = [
    'ECONNABORTED',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'EPIPE',
    'ENETDOWN'
  ];

  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  return (
    networkErrorCodes.includes(error?.code) ||
    message.includes('timeout') ||
    message.includes('network')
  );
}

function handleUpdateError(primaryError, fallbackError = null) {
  if (fallbackError) {
    logger.warn('Fallback update check also failed:', fallbackError.message || fallbackError);
  }

  const errors = [primaryError, fallbackError].filter(Boolean);
  const isRateLimited = errors.some((err) => err?.response?.status === 403 || err?.response?.status === 429);
  const hasNetworkIssue = errors.some((err) => isNetworkError(err));
  const lastError = errors[errors.length - 1];

  if (hasNetworkIssue) {
    logger.warn('Network unavailable, skipping update check');
    return {
      updateAvailable: false,
      error: 'network_unavailable',
      manualUpdateUrl: getManualUpdateUrl()
    };
  }

  if (isRateLimited) {
    logger.warn('GitHub API rate limited');
    return {
      updateAvailable: false,
      error: 'rate_limited',
      manualUpdateUrl: getManualUpdateUrl()
    };
  }

  logger.error('Error checking for updates:', lastError?.message || lastError || primaryError);
  return {
    updateAvailable: false,
    error: lastError?.message || primaryError?.message || 'Unknown error',
    manualUpdateUrl: getManualUpdateUrl()
  };
}

function notifyUpdateDownloadError(message, manualUpdateUrl, windowRef) {
  sendToRenderer('update-download-error', {
    message: message || 'Download failed',
    manualUpdateUrl: manualUpdateUrl || getManualUpdateUrl()
  }, windowRef);
}

function selectWindowsInstallerAsset(releaseData) {
  const assets = Array.isArray(releaseData?.assets) ? releaseData.assets : [];
  return assets.find((asset) => {
    if (!asset?.name || !asset?.browser_download_url) return false;
    const name = asset.name.toLowerCase();
    return (
      name.endsWith('.exe') &&
      !name.endsWith('.blockmap') &&
      !name.includes('delta')
    );
  }) || null;
}

function sanitizeVersionForFilename(version) {
  return String(version || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDownloadError(error) {
  return isNetworkError(error) || error?.response?.status >= 500;
}

async function downloadUpdateOnce({ url, mainWindow, expectedSize = 0, version = null }) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 300000,
    maxRedirects: 5,
    headers: {
      'User-Agent': REQUEST_HEADERS['User-Agent']
    }
  });

  const totalLength = parseInt(response.headers['content-length'], 10) || 0;
  let downloadedLength = 0;

  response.data.on('data', (chunk) => {
    downloadedLength += chunk.length;
    if (totalLength > 0) {
      const progress = Math.round((downloadedLength / totalLength) * 100);
      sendToRenderer('download-progress', progress, mainWindow);
    }
  });

  const timestamp = Date.now();
  const versionToken = sanitizeVersionForFilename(version || 'latest');
  const tempPath = path.join(app.getPath('temp'), `clip-library-update-${versionToken}-${timestamp}.exe`);

  logger.info(`Writing update to temporary path: ${tempPath}`);
  const writer = fs.createWriteStream(tempPath);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    const fail = (error) => reject(error);
    writer.on('finish', resolve);
    writer.on('error', fail);
    response.data.on('error', fail);
  });

  if (!fs.existsSync(tempPath)) {
    throw new Error('Downloaded file not found after write');
  }

  const stats = fs.statSync(tempPath);
  if (stats.size <= 0) {
    throw new Error('Downloaded file is empty');
  }

  if (expectedSize > 0 && stats.size !== expectedSize) {
    throw new Error(`Downloaded file size mismatch (${stats.size} !== ${expectedSize})`);
  }

  sendToRenderer('download-progress', 100, mainWindow);
  sendToRenderer('update-download-complete', { path: tempPath }, mainWindow);

  const openResult = await shell.openPath(tempPath);
  if (openResult) {
    throw new Error(`Failed to launch installer: ${openResult}`);
  }

  logger.info(`Update downloaded successfully (${stats.size} bytes), installer launched`);

  setTimeout(() => {
    app.quit();
  }, 1000);
}

async function downloadUpdateWithRetries(options) {
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRY_ATTEMPTS; attempt += 1) {
    try {
      logger.info(`Starting update download (attempt ${attempt}/${DOWNLOAD_RETRY_ATTEMPTS})...`);
      await downloadUpdateOnce(options);
      return;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableDownloadError(error);
      const canRetry = retryable && attempt < DOWNLOAD_RETRY_ATTEMPTS;
      logger.warn(`Update download attempt ${attempt} failed: ${error.message || error}`);
      if (canRetry) {
        await delay(800 * attempt);
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Download failed');
}

function registerUpdateHandler() {
  if (updateHandlerRegistered) {
    return;
  }

  ipcMain.handle('start-update', async () => {
    logger.info('Starting update download process');
    const activeWindow = getActiveWindow();

    if (!latestReleaseData?.tag_name) {
      logger.warn('No cached release metadata available, attempting a fresh update check');
      const refreshResult = await checkForUpdates(activeWindow, { silent: true });
      if (!refreshResult.updateAvailable) {
        const message = refreshResult.error
          ? `Unable to prepare update: ${refreshResult.error}`
          : 'No update available';
        const manualUpdateUrl = refreshResult.manualUpdateUrl || getManualUpdateUrl();
        notifyUpdateDownloadError(message, manualUpdateUrl, activeWindow);
        throw new Error(message);
      }
    }

    const releaseData = latestReleaseData;
    const manualUpdateUrl = getManualUpdateUrl(releaseData, latestResolvedVersion);
    const exeAsset = selectWindowsInstallerAsset(releaseData);

    if (!exeAsset || !exeAsset.browser_download_url) {
      const message = 'No suitable installer asset found in release';
      notifyUpdateDownloadError(message, manualUpdateUrl, activeWindow);
      throw new Error(message);
    }

    try {
      await downloadUpdateWithRetries({
        url: exeAsset.browser_download_url,
        expectedSize: Number(exeAsset.size) || 0,
        version: latestResolvedVersion,
        mainWindow: activeWindow
      });
      return { success: true };
    } catch (error) {
      const message = error?.message || 'Download failed';
      notifyUpdateDownloadError(message, manualUpdateUrl, activeWindow);
      throw new Error(message);
    }
  });

  updateHandlerRegistered = true;
  logger.info('Update handler registered');
}

function registerOpenUpdatePageHandler() {
  if (openUpdatePageHandlerRegistered) {
    return;
  }

  ipcMain.handle('open-update-page', async (_event, requestedUrl = null) => {
    const targetUrl = getAllowedManualUpdateUrl(requestedUrl);
    try {
      await shell.openExternal(targetUrl);
      return { success: true, url: targetUrl };
    } catch (error) {
      logger.error('Failed to open update page:', error.message || error);
      return {
        success: false,
        url: targetUrl,
        error: error.message || 'Failed to open browser'
      };
    }
  });

  openUpdatePageHandlerRegistered = true;
  logger.info('Open update page handler registered');
}

/**
 * Check for updates from GitHub releases
 * @param {BrowserWindow} mainWindow - The main application window
 * @param {Object} options - Options for the check
 * @param {boolean} options.silent - If true, don't show notification (for manual checks)
 * @returns {Object} Result object with updateAvailable, currentVersion, latestVersion
 */
async function checkForUpdates(mainWindow, options = {}) {
  const { silent = false } = options;
  ensureIpcHandlers();

  if (mainWindow && !mainWindow.isDestroyed()) {
    currentMainWindow = mainWindow;
  }

  try {
    logger.info('Checking for updates...');

    let releaseData = null;
    let checkSource = 'api';

    try {
      releaseData = await fetchLatestReleaseFromApi();
    } catch (primaryError) {
      logger.warn(`Primary update check failed, trying redirect fallback: ${primaryError.message || primaryError}`);
      try {
        releaseData = await fetchLatestReleaseFromRedirectFallback();
        checkSource = 'redirect_fallback';
        logger.info('Fallback release check succeeded');
      } catch (fallbackError) {
        return handleUpdateError(primaryError, fallbackError);
      }
    }

    if (!releaseData?.tag_name) {
      logger.error('Invalid release metadata - missing tag_name');
      return {
        updateAvailable: false,
        error: 'Invalid API response',
        manualUpdateUrl: getManualUpdateUrl()
      };
    }

    const latestVersion = normalizeVersionTag(releaseData.tag_name);
    const currentVersion = app.getVersion();

    if (!semver.valid(latestVersion)) {
      logger.error(`Invalid latest version format: ${latestVersion}`);
      return {
        updateAvailable: false,
        error: 'Invalid version format',
        currentVersion,
        manualUpdateUrl: getManualUpdateUrl(releaseData)
      };
    }

    if (!semver.valid(currentVersion)) {
      logger.error(`Invalid current version format: ${currentVersion}`);
      return {
        updateAvailable: false,
        error: 'Invalid current version',
        currentVersion,
        manualUpdateUrl: getManualUpdateUrl(releaseData, latestVersion)
      };
    }

    latestReleaseData = releaseData;
    latestResolvedVersion = latestVersion;

    const manualUpdateUrl = getManualUpdateUrl(releaseData, latestVersion);
    const baseResult = {
      currentVersion,
      latestVersion,
      manualUpdateUrl,
      checkSource
    };

    if (semver.gt(latestVersion, currentVersion)) {
      logger.info(`Update available: ${currentVersion} -> ${latestVersion}`);
      const result = {
        updateAvailable: true,
        ...baseResult,
        changelog: releaseData.body || 'No release notes available'
      };

      if (!silent) {
        sendToRenderer('show-update-notification', {
          currentVersion,
          latestVersion,
          changelog: result.changelog,
          manualUpdateUrl
        }, mainWindow);
      }

      return result;
    }

    logger.info('Application is up to date');
    return {
      updateAvailable: false,
      ...baseResult
    };
  } catch (error) {
    return handleUpdateError(error);
  }
}

module.exports = {
  init,
  checkForUpdates
};
