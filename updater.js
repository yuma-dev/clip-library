const { app } = require('electron');
const axios = require('axios');
const semver = require('semver');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const logger = require('./logger');

const GITHUB_API_URL = 'https://api.github.com/repos/yuma-dev/clip-library/releases/latest';

async function checkForUpdates(mainWindow) {
  try {
    logger.info('Checking for updates...');
    const response = await axios.get(GITHUB_API_URL);
    const latestVersion = response.data.tag_name.replace('v', '');
    const currentVersion = app.getVersion();

    logger.info(`Current version: ${currentVersion}`);
    logger.info(`Latest version: ${latestVersion}`);

    if (semver.gt(latestVersion, currentVersion)) {
      logger.info('Update available, showing notification');
      
      // Wait for window to be ready
      if (!mainWindow.isVisible()) {
        logger.info('Waiting for window to be visible...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Send message to renderer to show notification
      mainWindow.webContents.send('show-update-notification', {
        currentVersion,
        latestVersion
      });

      // Add IPC handler for the update
      mainWindow.webContents.ipc.handle('start-update', async () => {
        logger.info('Starting update download process');
        const assetUrl = response.data.assets.find(asset => asset.name.endsWith('.exe'))?.browser_download_url;
        if (assetUrl) {
          logger.info(`Found update asset URL: ${assetUrl}`);
          await downloadUpdate(assetUrl);
        } else {
          const error = 'No suitable download asset found';
          logger.error(error);
          throw new Error(error);
        }
      });
    } else {
      logger.info('Application is up to date');
    }
  } catch (error) {
    logger.error('Error checking for updates:', error);
  }
}

async function downloadUpdate(url) {
  try {
    logger.info('Starting update download...');
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream'
    });

    const tempPath = path.join(app.getPath('temp'), 'clip-library-update.exe');
    logger.info(`Writing update to temporary path: ${tempPath}`);
    
    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    logger.info('Update downloaded successfully, launching installer');
    await shell.openPath(tempPath);
    logger.info('Quitting application for update');
    app.quit();
  } catch (error) {
    logger.error('Error downloading update:', error);
  }
}

// Clean up any existing settings related to ignored versions
const { loadSettings, saveSettings } = require('./settings-manager');
(async () => {
  try {
    const settings = await loadSettings();
    if (settings.ignoredVersion) {
      logger.info('Cleaning up ignored version from settings');
      delete settings.ignoredVersion;
      await saveSettings(settings);
    }
  } catch (error) {
    logger.error('Error cleaning up settings:', error);
  }
})();

module.exports = { checkForUpdates };