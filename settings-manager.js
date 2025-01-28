const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

// Default settings structure
const DEFAULT_SETTINGS = {
  clipLocation: app.getPath('videos'),
  enableDiscordRPC: false,
  ignoredVersion: null,
  previewVolume: 0.1,
  exportQuality: 'discord'
};

async function loadSettings() {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf8');
    
    // Handle empty file case
    if (!data.trim()) {
      logger.warn('Settings file is empty, restoring defaults');
      await saveSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    
    const settings = JSON.parse(data);
    
    // Validate basic structure
    if (!settings || typeof settings !== 'object') {
      throw new Error('Invalid settings format');
    }
    
    return { ...DEFAULT_SETTINGS, ...settings };
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.info('Settings file not found, creating defaults');
      await saveSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    
    logger.error('Error loading settings:', error);
    logger.info('Restoring default settings due to error');
    await saveSettings(DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }
}

async function saveSettings(newSettings) {
  try {
    // Validate before saving
    if (!newSettings || typeof newSettings !== 'object') {
      throw new Error('Invalid settings format');
    }
    
    // Merge with defaults to ensure completeness
    const completeSettings = { ...DEFAULT_SETTINGS, ...newSettings };
    
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(completeSettings, null, 2));
    logger.info('Settings saved successfully');
    return true;
  } catch (error) {
    logger.error('Error saving settings:', error);
    throw error;
  }
}

module.exports = { loadSettings, saveSettings };