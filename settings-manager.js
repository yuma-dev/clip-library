const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

async function loadSettings() {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist, return default settings
      return { 
        clipLocation: app.getPath('videos'), 
        enableDiscordRPC: false,
        ignoredVersion: null,  // Add this line
        previewVolume: 0.1,
        exportQuality: 'discord'
      };
    }
    throw error;
  }
}

async function saveSettings(newSettings) {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2));
    return true;
  } catch (error) {
    logger.error('Error saving settings:', error);
    throw error;
  }
}

module.exports = { loadSettings, saveSettings };