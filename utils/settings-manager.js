const { app } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');
const telemetry = require('../main/telemetry');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

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
  // integrated clipdip (bundled binary); only library-side keys live here, its
  // own settings are in its TOML config, bridged by main/clipdip.js
  clipdip: {
    enabled: false,
    autostart: false,
    // dev/advanced override; empty means resources/clipdip/clipdip.exe
    binaryPath: ''
  },
  // anonymous diagnostics, opt-out (mirrors clipdip's telemetry.enabled). off means
  // no heartbeat/events/metrics/rollup and the queue file is deleted; see TELEMETRY.md
  telemetry: {
    enabled: true
  },
  // onboarding wizard version completed/dismissed; 0 = never seen. bump the
  // constant in OnboardingWizard.tsx to re-show for a release
  onboardingVersion: 0,
  // the one-time audio analysis card for people past the tour; the tour sets it too
  analysisIntroSeen: false,
  iconGreyscale: false,
  // loudness matching: clips without a custom volume play at targetLufs; null target
  // means the library median. levels come from the audio analysis every clip gets once
  // (<clips>/.clip_metadata/analysis_v1), indexed in loudness_v1.json
  loudness: {
    enabled: true,
    targetLufs: null
  },
  // green lines + group styling for new clips
  showNewClipsIndicators: true,
  // mirrors CARD_GLOW_DEFAULTS in glowConfig.ts; must exist here too for type
  // validation and to show up in a fresh settings.json
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
    smoothing: 0.5,     // Blend factor (0.1-1.0), higher = more responsive
    fps: 30,
    blur: 80,           // CSS blur in px
    saturation: 1.5,
    opacity: 0.7
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
  // default keybindings; users can override any of these in settings.json
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
          // corrupt file gets overwritten with defaults below, so a failed backup loses it
          // for good; rethrows to the outer catch, logged as "unexpected error loading settings"
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
      // destructive: user's settings are gone after this. parseError isn't passed on:
      // V8 quotes ~30 chars of the source, and this source holds sharing.apiToken
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
    
    if (!settings || typeof settings !== 'object') {
      logger.error('Invalid settings structure:', settings);
      return { ...DEFAULT_SETTINGS };
    }
    
    const mergedSettings = { ...DEFAULT_SETTINGS };
    let needsSave = false;
    // keys reverted to default because the stored value had the wrong type;
    // names only, never values (these are our own fixed identifiers, not user data)
    const revertedKeys = [];

    for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
      if (key in settings && typeof settings[key] === typeof defaultValue) {
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
      if (key in settings) revertedKeys.push(key);
      needsSave = true;
    }

    // unknown keys used to be dropped (cardGlow reset every launch); now carried
    // through untouched, so a renderer key added ahead of main is never lost
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
          // keys that would've been lost before the unknown-key fix
          preserved_unknown: unknownKeys.length
        },
        coalesceMs: 3600000
      });
    }

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
    // user's real settings never apply this session; next save overwrites them with defaults
    telemetry.event('settings_load_failed', {
      kind: telemetry.KIND.SILENT_FAILURE,
      severity: telemetry.SEVERITY.ERROR,
      context: { errno: error.code },
      error
    });
    // don't reset settings on unexpected errors; just use defaults for this session
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(newSettings) {
  let payloadBytes = 0;
  try {
    if (!newSettings || typeof newSettings !== 'object') {
      throw new Error('Invalid settings format');
    }

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

/** @returns {Object} */
function getDefaultKeybindings() {
  return DEFAULT_SETTINGS.keybindings;
}

/** Wrapper around saveSettings for IPC handlers.
 * @param {Object} newSettings
 * @returns {Promise<Object>} */
async function updateSettings(newSettings) {
  await saveSettings(newSettings);
  return newSettings;
}

/**
 * @param {Function} getSettings
 * @returns {Promise<string>}
 */
async function getClipLocation(getSettings) {
  const settings = await getSettings();
  return settings.clipLocation;
}

/**
 * @param {Function} getSettings
 * @param {string} newLocation
 * @returns {Promise<string>}
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
