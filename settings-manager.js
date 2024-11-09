const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULT_SETTINGS = {
  clipLocation: app.getPath('videos'),
  enableDiscordRPC: false,
  ignoredVersion: null,
  previewVolume: 0.1 // 10% volume
};

async function loadSettings() {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf8');
    const userSettings = JSON.parse(data);
    // Merge with default settings to ensure all properties exist
    return { ...DEFAULT_SETTINGS, ...userSettings };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return DEFAULT_SETTINGS;
    }
    throw error;
  }
}

async function saveSettings(settings) {
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

module.exports = { loadSettings, saveSettings };