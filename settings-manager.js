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
  exportQuality: 'discord',
  // Whether to desaturate game icons in the clip list
  iconGreyscale: false,
  // Default keybindings – users can override any of these in settings.json
  keybindings: {
    playPause: 'Space',
    frameBackward: ',',
    frameForward: '.',
    skipBackward: 'ArrowLeft',
    skipForward: 'ArrowRight',
    navigatePrev: 'Ctrl+ArrowLeft',
    navigateNext: 'Ctrl+ArrowRight',
    volumeUp: 'ArrowUp',
    volumeDown: 'ArrowDown',
    exportDefault: 'e',
    exportVideo: 'Ctrl+E',
    exportAudioFile: 'Ctrl+Shift+E',
    exportAudioClipboard: 'Shift+E',
    fullscreen: 'f',
    deleteClip: 'Delete',
    setTrimStart: '[',
    setTrimEnd: ']',
    focusTitle: 'Tab',
    closePlayer: 'Escape'
  }
};

async function loadSettings() {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf8');
    
    // Parse the settings
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
    
    // Merge with defaults, but be more careful about what we consider "invalid"
    const mergedSettings = { ...DEFAULT_SETTINGS };
    let needsSave = false;
    
    // Only override defaults with valid values, and track if we actually need to save
    for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
      // If the setting exists and is of the same type as the default
      if (key in settings && typeof settings[key] === typeof defaultValue) {
        // For numbers, check if it's a valid number and within reasonable bounds
        if (typeof defaultValue === 'number') {
          if (!isNaN(settings[key]) && isFinite(settings[key])) {
            mergedSettings[key] = settings[key];
            continue;
          }
        } else {
          mergedSettings[key] = settings[key];
          continue;
        }
      }
      // If we get here, the setting was invalid or missing
      needsSave = true;
    }
    
    // Only save if we actually had to fix something
    if (needsSave) {
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

module.exports = { loadSettings, saveSettings, DEFAULT_SETTINGS };