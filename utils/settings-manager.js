const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');
const telemetry = require('../main/telemetry');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

// Default settings structure
const DEFAULT_SETTINGS = {
  clipLocation: app.getPath('videos'),
  enableDiscordRPC: false,
  ignoredVersion: null,
  previewVolume: 0.1,
  exportQuality: 'high',
  exportPreset: 'balanced',
  exportSizeGoal: 'medium_50mb',
  exportQualityBias: 'balanced',
  exportSpeedBias: 'balanced',
  uiFont: 'modern_ui',
  // Clip sharing integration settings (friends.cliplib.app)
  sharing: {
    serverUrl: 'https://friends.cliplib.app',
    apiToken: ''
  },
  // Integrated clipdip (the bundled binary). Only library-side keys
  // live here — clipdip's own settings are in its TOML config, bridged
  // by main/clipdip.js.
  clipdip: {
    enabled: false,
    autostart: false,
    // Dev/advanced override; empty -> resources/clipdip/clipdip.exe
    binaryPath: ''
  },
  // Anonymous diagnostics for the library app itself. Opt-out, mirroring
  // clipdip's telemetry.enabled. Off means off: no heartbeat, no events, no
  // metrics, no daily rollup, and the local queue file is deleted.
  // See docs/telemetry-cliplib-api.md and TELEMETRY.md.
  telemetry: {
    enabled: true
  },
  // Highest onboarding wizard version the user has completed/dismissed.
  // 0 = never seen; the 3.0 wizard sets this to 3. Bump the constant in
  // src/renderer/onboarding/OnboardingWizard.tsx to re-show for a release.
  onboardingVersion: 0,
  // Whether to desaturate game icons in the clip list
  iconGreyscale: false,
  // Whether to show new clips indicators (green lines and group styling)
  showNewClipsIndicators: true,
  // Card hover glow. Mirrors CARD_GLOW_DEFAULTS in
  // src/renderer/library/glowConfig.ts — the renderer writes this key, so it
  // has to exist here too (unknown keys are preserved now, but a known key
  // also gets type validation and shows up in a fresh settings.json).
  cardGlow: {
    enabled: true,
    opacity: 0.6,
    blur: 45,
    saturate: 1.6,
    brightness: 1.0
  },
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
      let backupWritten = false;
      if (data.trim()) {
        logger.error('Settings file is corrupted:', parseError);
        logger.info('Creating backup of corrupted settings file');
        const backupPath = `${SETTINGS_FILE}.backup-${Date.now()}`;
        try {
          await fs.writeFile(backupPath, data);
          backupWritten = true;
        } catch (backupError) {
          // The corrupt file is overwritten with defaults right below, so a
          // failed backup loses it for good. This throws to the outer catch,
          // where it is logged as a generic "unexpected error loading settings".
          telemetry.event('settings_backup_failed', {
            kind: telemetry.KIND.DATA_LOSS,
            severity: telemetry.SEVERITY.ERROR,
            context: { errno: backupError.code },
            error: backupError
          });
          throw backupError;
        }
        logger.info(`Backup created at: ${backupPath}`);
      }
      logger.warn('Restoring default settings due to parse error');
      // Destructive: everything the user configured is gone after this save.
      // Deliberately NOT passing parseError: V8's "Unexpected token" message
      // quotes a ~30 char excerpt of the source around the fault, and this
      // source is settings.json, which holds clipLocation and sharing.apiToken.
      telemetry.event('settings_corrupt_reset', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.ERROR,
        context: {
          file_bytes: Buffer.byteLength(data, 'utf8'),
          backup_written: backupWritten,
          error_name: parseError && parseError.name
        }
      });
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
    // Keys the user's file carried that were reverted to a default because the
    // stored value had the wrong type. Names only, never values: these are our
    // own fixed identifiers.
    const revertedKeys = [];

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
      if (key in settings) revertedKeys.push(key);
      needsSave = true;
    }

    // Keys the user's file has that DEFAULT_SETTINGS doesn't know about used to
    // be dropped here (cardGlow, written by the renderer, reset on every
    // launch). They are carried through untouched now, so a key the renderer
    // adds ahead of main can never be lost again. Preserving costs nothing on
    // disk — the value is already in the file — so needsSave stays as is and
    // launches don't rewrite settings.json.
    const unknownKeys = Object.keys(settings).filter((key) => !(key in DEFAULT_SETTINGS));
    for (const key of unknownKeys) {
      mergedSettings[key] = settings[key];
    }
    if (unknownKeys.length) {
      logger.info(`Preserved ${unknownKeys.length} unknown settings key(s): ${unknownKeys.join(', ')}`);
    }

    if (revertedKeys.length) {
      telemetry.event('settings_keys_reverted', {
        kind: telemetry.KIND.DATA_LOSS,
        severity: telemetry.SEVERITY.WARNING,
        context: {
          count: revertedKeys.length,
          keys: revertedKeys,
          // Informational: keys that would have been lost before the fix.
          preserved_unknown: unknownKeys.length
        },
        coalesceMs: 3600000
      });
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
    // The user's real settings never apply this session, and the next save
    // writes these defaults over them.
    telemetry.event('settings_load_failed', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      context: { errno: error.code },
      error
    });
    // Don't reset settings on unexpected errors, just return defaults for this session
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(newSettings) {
  let payloadBytes = 0;
  try {
    // Validate before saving
    if (!newSettings || typeof newSettings !== 'object') {
      throw new Error('Invalid settings format');
    }
    
    // Merge with defaults to ensure completeness
    const completeSettings = { ...DEFAULT_SETTINGS, ...newSettings };
    
    const payload = JSON.stringify(completeSettings, null, 2);
    payloadBytes = Buffer.byteLength(payload, 'utf8');

    await fs.writeFile(SETTINGS_FILE, payload);
    logger.info('Settings saved successfully');
    return true;
  } catch (error) {
    logger.error('Error saving settings:', error);
    telemetry.event('settings_save_failed', {
      kind: telemetry.KIND.ERROR,
      severity: telemetry.SEVERITY.ERROR,
      context: { errno: error.code, bytes: payloadBytes },
      error
    });
    throw error;
  }
}

/**
 * Get default keybindings
 * @returns {Object} Default keybindings from DEFAULT_SETTINGS
 */
function getDefaultKeybindings() {
  return DEFAULT_SETTINGS.keybindings;
}

/**
 * Update settings and return the new settings
 * This is a wrapper around saveSettings for IPC handlers
 * @param {Object} newSettings - The new settings to save
 * @returns {Promise<Object>} The saved settings
 */
async function updateSettings(newSettings) {
  await saveSettings(newSettings);
  return newSettings;
}

/**
 * Get clip location from settings
 * @param {Function} getSettings - Function that returns current settings
 * @returns {Promise<string>} The clip location path
 */
async function getClipLocation(getSettings) {
  const settings = await getSettings();
  return settings.clipLocation;
}

/**
 * Update clip location in settings
 * @param {Function} getSettings - Function that returns current settings
 * @param {string} newLocation - The new clip location path
 * @returns {Promise<string>} The updated clip location
 */
async function setClipLocation(getSettings, newLocation) {
  const settings = await getSettings();
  settings.clipLocation = newLocation;
  await saveSettings(settings);
  return settings.clipLocation;
}

module.exports = {
  loadSettings,
  saveSettings,
  updateSettings,
  getDefaultKeybindings,
  getClipLocation,
  setClipLocation,
  DEFAULT_SETTINGS
};
