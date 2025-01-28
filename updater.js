const { app } = require('electron');
const axios = require('axios');
const semver = require('semver');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const logger = require('./logger');

const GITHUB_API_URL = 'https://api.github.com/repos/yuma-dev/clip-library/releases/latest';

async function checkForUpdates(mainWindow) { // Ensure mainWindow is properly passed
  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      logger.warn('Main window not available, skipping update check');
      return;
    }

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
        logger.warn('Main window not visible!');
        return
      }

      // Send message to renderer to show notification
      mainWindow.webContents.send('show-update-notification', {
        currentVersion,
        latestVersion,
        changelog: response.data.body
      });

      // Add IPC handler for the update
      mainWindow.webContents.ipc.handle('start-update', async () => {
        logger.info('Starting update download process');
        const assetUrl = response.data.assets.find(asset => asset.name.endsWith('.exe'))?.browser_download_url;
        if (assetUrl) {
          logger.info(`Found update asset URL: ${assetUrl}`);
          await downloadUpdate(assetUrl, mainWindow); // Add mainWindow as second argument
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

async function downloadUpdate(url, mainWindow) {
  try {
    logger.info('Starting update download...');
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream'
    });

    const totalLength = response.headers['content-length'];
    let downloadedLength = 0;
    
    response.data.on('data', (chunk) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      downloadedLength += chunk.length;
      const progress = Math.round((downloadedLength / totalLength) * 100);
      mainWindow.webContents.send('download-progress', progress);
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

module.exports = { checkForUpdates };