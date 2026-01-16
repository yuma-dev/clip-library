const { app, ipcMain } = require('electron');
const axios = require('axios');
const semver = require('semver');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const logger = require('../utils/logger');

const GITHUB_API_URL = 'https://api.github.com/repos/yuma-dev/clip-library/releases/latest';

// Track if the start-update handler has been registered
let updateHandlerRegistered = false;
// Store the latest release data for download
let latestReleaseData = null;

/**
 * Check for updates from GitHub releases
 * @param {BrowserWindow} mainWindow - The main application window
 * @param {Object} options - Options for the check
 * @param {boolean} options.silent - If true, don't show notification (for manual checks)
 * @returns {Object} Result object with updateAvailable, currentVersion, latestVersion
 */
async function checkForUpdates(mainWindow, options = {}) {
  const { silent = false } = options;
  
  try {
    // Validate mainWindow
    if (!mainWindow || mainWindow.isDestroyed()) {
      logger.warn('Main window not available, skipping update check');
      return { updateAvailable: false, error: 'Window not available' };
    }

    logger.info('Checking for updates...');
    
    const response = await axios.get(GITHUB_API_URL, { 
      timeout: 10000, // 10 second timeout
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'clip-library-updater'
      }
    });

    // Validate response data
    if (!response.data || !response.data.tag_name) {
      logger.error('Invalid response from GitHub API - missing tag_name');
      return { updateAvailable: false, error: 'Invalid API response' };
    }

    // Parse version, handling both "v1.0.0" and "1.0.0" formats
    const tagName = response.data.tag_name;
    const latestVersion = tagName.startsWith('v') ? tagName.slice(1) : tagName;
    const currentVersion = app.getVersion();

    logger.info(`Current version: ${currentVersion}`);
    logger.info(`Latest version: ${latestVersion}`);

    // Validate versions are valid semver
    if (!semver.valid(latestVersion)) {
      logger.error(`Invalid latest version format: ${latestVersion}`);
      return { updateAvailable: false, error: 'Invalid version format', currentVersion };
    }

    if (!semver.valid(currentVersion)) {
      logger.error(`Invalid current version format: ${currentVersion}`);
      return { updateAvailable: false, error: 'Invalid current version', currentVersion };
    }

    // Store release data for later download
    latestReleaseData = response.data;

    // Register the update handler if not already registered
    registerUpdateHandler(mainWindow);

    if (semver.gt(latestVersion, currentVersion)) {
      logger.info('Update available');
      
      const result = {
        updateAvailable: true,
        currentVersion,
        latestVersion,
        changelog: response.data.body || 'No release notes available'
      };

      // Show notification unless silent mode
      if (!silent) {
        // Check if webContents is ready to receive messages
        if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
          logger.info('Sending update notification to renderer...');
          logger.info(`  Window visible: ${mainWindow.isVisible()}`);
          logger.info(`  Window destroyed: ${mainWindow.isDestroyed()}`);
          logger.info(`  WebContents ID: ${mainWindow.webContents.id}`);
          
          mainWindow.webContents.send('show-update-notification', {
            currentVersion,
            latestVersion,
            changelog: result.changelog
          });
          logger.info('Update notification sent successfully');
        } else {
          logger.warn('WebContents not ready, could not send notification');
          logger.warn(`  mainWindow.webContents: ${!!mainWindow.webContents}`);
          logger.warn(`  isDestroyed: ${mainWindow.webContents?.isDestroyed?.()}`);
        }
      } else {
        logger.info('Silent mode enabled, not showing notification');
      }

      return result;
    } else {
      logger.info('Application is up to date');
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion
      };
    }
  } catch (error) {
    return handleUpdateError(error);
  }
}

/**
 * Register the start-update IPC handler (only once)
 */
function registerUpdateHandler(mainWindow) {
  if (updateHandlerRegistered) {
    return;
  }

  ipcMain.handle('start-update', async () => {
    logger.info('Starting update download process');
    
    if (!latestReleaseData) {
      const error = 'No update data available - please check for updates first';
      logger.error(error);
      throw new Error(error);
    }

    const assets = latestReleaseData.assets || [];
    const exeAsset = assets.find(asset => 
      asset.name && asset.name.toLowerCase().endsWith('.exe')
    );
    
    if (!exeAsset || !exeAsset.browser_download_url) {
      const error = 'No suitable download asset found in release';
      logger.error(error);
      throw new Error(error);
    }

    logger.info(`Found update asset URL: ${exeAsset.browser_download_url}`);
    await downloadUpdate(exeAsset.browser_download_url, mainWindow);
  });

  updateHandlerRegistered = true;
  logger.info('Update handler registered');
}

/**
 * Handle errors from update check
 */
function handleUpdateError(error) {
  // Network-related errors that indicate no/poor connectivity
  const networkErrorCodes = [
    'ECONNABORTED',  // Connection aborted (timeout)
    'ENETUNREACH',   // Network unreachable
    'ENOTFOUND',     // DNS lookup failed
    'ETIMEDOUT',     // Connection timed out
    'ECONNRESET',    // Connection reset by peer
    'ECONNREFUSED',  // Connection refused
    'EAI_AGAIN',     // DNS lookup timed out
    'EHOSTUNREACH',  // Host unreachable
    'EPIPE',         // Broken pipe
    'ENETDOWN'       // Network is down
  ];

  const isNetworkError = networkErrorCodes.includes(error.code) || 
                         error.message?.includes('timeout') ||
                         error.message?.includes('network');

  if (isNetworkError) {
    logger.warn('Network unavailable, skipping update check:', error.code || error.message);
    return { updateAvailable: false, error: 'network_unavailable' };
  }

  // GitHub API rate limiting
  if (error.response?.status === 403 || error.response?.status === 429) {
    logger.warn('GitHub API rate limited');
    return { updateAvailable: false, error: 'rate_limited' };
  }

  // Other errors
  logger.error('Error checking for updates:', error.message || error);
  return { updateAvailable: false, error: error.message || 'Unknown error' };
}

/**
 * Download and install update
 */
async function downloadUpdate(url, mainWindow) {
  try {
    logger.info('Starting update download...');
    
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 300000, // 5 minute timeout for download
      headers: {
        'User-Agent': 'clip-library-updater'
      }
    });

    const totalLength = parseInt(response.headers['content-length'], 10) || 0;
    let downloadedLength = 0;
    
    response.data.on('data', (chunk) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      downloadedLength += chunk.length;
      
      if (totalLength > 0) {
        const progress = Math.round((downloadedLength / totalLength) * 100);
        mainWindow.webContents.send('download-progress', progress);
      }
    });

    const tempPath = path.join(app.getPath('temp'), 'clip-library-update.exe');
    logger.info(`Writing update to temporary path: ${tempPath}`);
    
    // Remove existing file if present
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (unlinkErr) {
        logger.warn('Could not remove existing temp file:', unlinkErr.message);
      }
    }

    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', (err) => {
        logger.error('Write stream error:', err);
        reject(err);
      });
      response.data.on('error', (err) => {
        logger.error('Download stream error:', err);
        reject(err);
      });
    });

    // Verify the file was written
    if (!fs.existsSync(tempPath)) {
      throw new Error('Downloaded file not found after write');
    }

    const stats = fs.statSync(tempPath);
    if (stats.size === 0) {
      throw new Error('Downloaded file is empty');
    }

    logger.info(`Update downloaded successfully (${stats.size} bytes), launching installer`);
    
    // Notify renderer that download is complete
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', 100);
      mainWindow.webContents.send('update-download-complete');
    }

    await shell.openPath(tempPath);
    logger.info('Quitting application for update');
    
    // Small delay to ensure installer starts
    setTimeout(() => {
      app.quit();
    }, 1000);
    
  } catch (error) {
    logger.error('Error downloading update:', error.message || error);
    
    // Notify renderer of download failure
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-download-error', error.message || 'Download failed');
    }
    
    throw error; // Re-throw so the IPC handler can catch it
  }
}

module.exports = { checkForUpdates };
