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
  // Whether to show new clips indicators (green lines and group styling)
  showNewClipsIndicators: true,
  // Ambient glow settings (YouTube-style background glow behind video player)
  ambientGlow: {
    enabled: true,
    smoothing: 0.5,     // Blend factor (0.1-1.0) - higher = more responsive
    fps: 30,            // Update rate
    blur: 80,           // CSS blur in px
    saturation: 1.5,    // Color saturation
    opacity: 0.7        // Glow opacity
  },
  // Controller settings
  controller: {
    enabled: true,
    seekSensitivity: 0.5,
    volumeSensitivity: 0.1,
    buttonMappings: {
      // Face buttons (A, B, X, Y)
      0: 'playPause',        // A button - play/pause
      1: 'closePlayer',      // B button - close/back
      2: 'exportDefault',    // X button - export
      3: 'fullscreen',       // Y button - fullscreen
      
      // Shoulder buttons
      4: 'navigatePrev',     // LB - previous clip
      5: 'navigateNext',     // RB - next clip
      6: 'setTrimStart',     // LT - set trim start
      7: 'setTrimEnd',       // RT - set trim end
      
      // Special buttons
      8: 'focusTitle',       // Back/Select - focus title
      9: 'exportVideo',      // Start/Menu - export menu
      10: null,              // Left stick click
      11: null,              // Right stick click
      
      // D-pad
      12: 'volumeUp',        // D-pad up - volume up
      13: 'volumeDown',      // D-pad down - volume down
      14: 'skipBackward',    // D-pad left - skip backward
      15: 'skipForward'      // D-pad right - skip forward
    },
    analogMappings: {
      leftStick: {
        xAxis: 0,    // Left stick X (horizontal navigation)
        yAxis: 1,    // Left stick Y (vertical navigation)
        deadzone: 0.2
      },
      rightStick: {
        xAxis: 2,    // Right stick X (timeline seeking)
        yAxis: 3,    // Right stick Y (volume control)
        deadzone: 0.2
      }
    }
  },
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