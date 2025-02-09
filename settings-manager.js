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
    
    // Parse the settings, but don't immediately assume empty file means invalid
    let settings;
    try {
      settings = JSON.parse(data);
    } catch (parseError) {
      // Only reset if the file is actually corrupted, not just empty
      if (data.trim()) {
        logger.error('Settings file is corrupted:', parseError);
        logger.info('Creating backup of corrupted settings file');
        const backupPath = `${SETTINGS_FILE}.backup-${Date.now()}`;
        await fs.writeFile(backupPath, data);
        logger.info(`Backup created at: ${backupPath}`);
      }
      logger.warn('Restoring default settings due to parse error');
      await saveSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    
    // Validate settings structure
    if (!settings || typeof settings !== 'object') {
      logger.error('Invalid settings structure:', settings);
      return { ...DEFAULT_SETTINGS };
    }
    
    // Merge with defaults, but preserve all existing valid settings
    const mergedSettings = { ...DEFAULT_SETTINGS };
    
    // Only override defaults with valid values
    for (const [key, value] of Object.entries(settings)) {
      if (value !== null && value !== undefined) {
        mergedSettings[key] = value;
      }
    }
    
    // If the merged settings differ from what's in the file, save the corrected version
    if (JSON.stringify(mergedSettings) !== JSON.stringify(settings)) {
      logger.info('Updating settings file with merged settings');
      await saveSettings(mergedSettings);
    }
    
    return mergedSettings;
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.info('Settings file not found, creating with defaults');
      await saveSettings(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    
    logger.error('Unexpected error loading settings:', error);
    // Don't reset settings on unexpected errors, just return defaults for this session
    return { ...DEFAULT_SETTINGS };
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