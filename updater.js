const { app, dialog, shell } = require('electron');
const axios = require('axios');
const semver = require('semver');
const fs = require('fs');
const path = require('path');
const { loadSettings, saveSettings } = require('./settings-manager');

const GITHUB_API_URL = 'https://api.github.com/repos/yuma-dev/clip-library/releases/latest';

async function checkForUpdates() {
  try {
    const settings = await loadSettings();
    const response = await axios.get(GITHUB_API_URL);
    const latestVersion = response.data.tag_name.replace('v', '');
    const currentVersion = app.getVersion();

    if (semver.gt(latestVersion, currentVersion) && latestVersion !== settings.ignoredVersion) {
      const { response: buttonIndex, checkboxChecked } = await dialog.showMessageBox({
        type: 'info',
        title: 'Update Available',
        message: `A new version (${latestVersion}) is available. Would you like to update?`,
        buttons: ['Yes', 'No'],
        checkboxLabel: 'Don\'t ask me about this version again',
        checkboxChecked: false
      });

      if (checkboxChecked) {
        settings.ignoredVersion = latestVersion;
        await saveSettings(settings);
      }

      if (buttonIndex === 0) {
        const assetUrl = response.data.assets.find(asset => asset.name.endsWith('.exe'))?.browser_download_url;
        if (assetUrl) {
          await downloadUpdate(assetUrl);
        } else {
          throw new Error('No suitable download asset found');
        }
      }
    } else {
      console.log('Application is up to date or update ignored');
    }
  } catch (error) {
    console.error('Error checking for updates:', error);
    dialog.showErrorBox('Update Check Failed', 'Failed to check for updates. Please try again later.');
  }
}

async function downloadUpdate(url) {
  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream'
    });

    const tempPath = path.join(app.getPath('temp'), 'clip-library-update.exe');
    const writer = fs.createWriteStream(tempPath);

    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    await shell.openPath(tempPath);
    app.quit();
  } catch (error) {
    console.error('Error downloading update:', error);
    dialog.showErrorBox('Update Error', 'Failed to download the update. Please try again later.');
  }
}

module.exports = { checkForUpdates };