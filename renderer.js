const { ipcRenderer } = require("electron");
const path = require("path");
const { Titlebar, TitlebarColor } = require("custom-electron-titlebar");
const logger = require('./utils/logger');
const fs = require('fs').promises;

// Keybinding manager to centralise shortcuts
const keybinds = require('./renderer/keybinding-manager');

// Gamepad manager for controller support
const gamepadManagerModule = require('./renderer/gamepad-manager');

// Centralized state management
const state = require('./renderer/state');

// Video player module
const videoPlayerModule = require('./renderer/video-player');

// Tag manager module
const tagManagerModule = require('./renderer/tag-manager');

// Search manager module
const searchManagerModule = require('./renderer/search-manager');

// Export manager module
const exportManagerModule = require('./renderer/export-manager');

// Grid navigation module
const gridNavigationModule = require('./renderer/grid-navigation');

// Settings manager module
const settingsManagerUiModule = require('./renderer/settings-manager-ui');

// Clip grid module
const clipGridModule = require('./renderer/clip-grid');

// Benchmark mode detection and harness initialization
const isBenchmarkMode = typeof process !== 'undefined' && process.env && process.env.CLIPS_BENCHMARK === '1';
let benchmarkHarness = null;
if (isBenchmarkMode) {
  try {
    const { getRendererHarness } = require('./benchmark/renderer-harness');
    benchmarkHarness = getRendererHarness();
    logger.info('[Benchmark] Renderer harness initialized');
  } catch (e) {
    logger.error('[Benchmark] Failed to load harness:', e);
  }
}

const clipGrid = document.getElementById("clip-grid");
const fullscreenPlayer = document.getElementById("fullscreen-player");
const videoPlayer = document.getElementById("video-player");
const clipTitle = document.getElementById("clip-title");
const progressBarContainer = document.getElementById("progress-bar-container");
const progressBar = document.getElementById("progress-bar");
const trimStart = document.getElementById("trim-start");
const trimEnd = document.getElementById("trim-end");
const playhead = document.getElementById("playhead");
const loadingOverlay = document.getElementById("loading-overlay");
const playerOverlay = document.getElementById("player-overlay");
const videoClickTarget = document.getElementById("video-click-target");
const ambientGlowCanvas = document.getElementById("ambient-glow-canvas");
const MAX_FRAME_RATE = 10;
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds
const volumeButton = document.getElementById("volume-button");
const volumeSlider = document.getElementById("volume-slider");
const volumeContainer = document.getElementById("volume-container");
const speedButton = document.getElementById("speed-button");
const speedSlider = document.getElementById("speed-slider");
const speedContainer = document.getElementById("speed-container");
const speedText = document.getElementById("speed-text");
const volumeIcons = {
  normal: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M760-481q0-83-44-151.5T598-735q-15-7-22-21.5t-2-29.5q6-16 21.5-23t31.5 0q97 43 155 131.5T840-481q0 108-58 196.5T627-153q-16 7-31.5 0T574-176q-5-15 2-29.5t22-21.5q74-34 118-102.5T760-481ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm380-120q0 42-19 79.5T591-339q-10 6-20.5.5T560-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM400-606l-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`,
  muted: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="m720-424-76 76q-11 11-28 11t-28-11q-11-11-11-28t11-28l76-76-76-76q-11-11-11-28t11-28q11-11 28-11t28 11l76 76 76-76q11-11 28-11t28 11q11 11 11 28t-11 28l-76 76 76 76q11 11 11 28t-11 28q-11 11-28 11t-28-11l-76-76Zm-440 64H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`,
  low: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M360-360H240q-17 0-28.5-11.5T200-400v-160q0-17 11.5-28.5T240-600h120l132-132q19-19 43.5-8.5T560-703v446q0 27-24.5 37.5T492-228L360-360Zm380-120q0 42-19 79.5T671-339q-10 6-20.5.5T640-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM480-606l-86 86H280v80h114l86 86v-252ZM380-480Z"/></svg>`,
  high: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M760-440h-80q-17 0-28.5-11.5T640-480q0-17 11.5-28.5T680-520h80q17 0 28.5 11.5T800-480q0 17-11.5 28.5T760-440ZM584-288q10-14 26-16t30 8l64 48q14 10 16 26t-8 30q-10 14-26 16t-30-8l-64-48q-14-10-16-26t8-30Zm120-424-64 48q-14 10-30 8t-26-16q-10-14-8-30t16-26l64-48q14-10 30-8t26 16q10 14 8 30t-16 26ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`
};
const THUMBNAIL_RETRY_DELAY = 2000; // 2 seconds
const THUMBNAIL_INIT_DELAY = 1000; // 1 second delay before first validation

// All state variables moved to renderer/state.js
// Access via state.getXxx() and state.setXxx() methods



/**
 * Get cached clip data or load fresh
 */
async function getCachedClipData(originalName) {
  const cached = state.clipDataCache.get(originalName);
  if (cached && (Date.now() - cached.timestamp) < state.CACHE_EXPIRY_MS) {
    return cached.data;
  }
  return null;
}









// Grid navigation functions



// Initialize gamepad manager with proper callbacks
async function initializeGamepadManager() {
  try {
    state.gamepadManager = new gamepadManagerModule.GamepadManager();
    
    // Inject dependencies for module functions
    gamepadManagerModule.dependencies = {
        videoPlayer: document.getElementById("video-player"),
        playerOverlay: document.getElementById("player-overlay"),
        clipTitle: document.getElementById("clip-title"),
        videoPlayerModule,
        navigateToVideo,
        exportAudioWithFileSelection,
        exportVideoWithFileSelection,
        exportAudioToClipboard,
        exportManagerModule,
        confirmAndDeleteClip: clipGridModule.confirmAndDeleteClip,
        closePlayer,
        enableGridNavigation: clipGridModule.enableGridNavigation,
        disableGridNavigation: clipGridModule.disableGridNavigation,
        openCurrentGridSelection: clipGridModule.openCurrentGridSelection,
        moveGridSelection: gridNavigationModule.moveGridSelection,
        state
    };
    
    // Get controller state.settings from main state.settings
    const appSettings = await ipcRenderer.invoke('get-settings');
    const controllerSettings = appSettings?.controller;
    
    if (controllerSettings) {
      // Apply custom mappings if they exist
      if (controllerSettings.buttonMappings) {
        Object.entries(controllerSettings.buttonMappings).forEach(([buttonIndex, action]) => {
          state.gamepadManager.setButtonMapping(parseInt(buttonIndex), action);
        });
      }
      
      // Apply sensitivity state.settings
      if (controllerSettings.seekSensitivity !== undefined) {
        state.gamepadManager.seekSensitivity = controllerSettings.seekSensitivity;
      }
      if (controllerSettings.volumeSensitivity !== undefined) {
        state.gamepadManager.volumeSensitivity = controllerSettings.volumeSensitivity;
      }
      
      // Enable/disable controller based on state.settings
      if (controllerSettings.enabled) {
        state.gamepadManager.enable();
      } else {
        state.gamepadManager.disable();
      }
    } else {
      // Default: enable controller support
      state.gamepadManager.enable();
    }
    
    // Set up action callback for button presses
    state.gamepadManager.setActionCallback((action) => {
      gamepadManagerModule.handleControllerAction(action);
    });
    
    // Set up navigation callback for analog sticks
    state.gamepadManager.setNavigationCallback((type, value) => {
      gamepadManagerModule.handleControllerNavigation(type, value);
    });
    
    // Set up raw navigation callback for grid scrolling
    state.gamepadManager.setRawNavigationCallback((type, value) => {
      handleControllerRawNavigation(type, value);
    });
    
    // Set up connection callback for UI updates
    state.gamepadManager.setConnectionCallback((connected, gamepadId) => {
      handleControllerConnection(connected, gamepadId);
    });
    
    logger.info('Gamepad manager initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize gamepad manager:', error);
  }
}



// Handle raw controller navigation (for grid scrolling)
function handleControllerRawNavigation(type, value) {
  const isPlayerActive = playerOverlay.style.display === "block";
  
  // Only handle raw navigation in grid view
  if (!isPlayerActive) {
    switch (type) {
      case 'seekRaw':
        // Right stick X - horizontal scrolling in grid
        if (Math.abs(value) > 0.3) { // Reasonable threshold for raw values
          const scrollAmount = value * 15; // Smooth scrolling sensitivity
          window.scrollBy(scrollAmount, 0);
        }
        break;
        
      case 'volumeRaw':
        // Right stick Y - vertical scrolling in grid
        if (Math.abs(value) > 0.3) { // Reasonable threshold for raw values
          const scrollAmount = value * 15; // Smooth scrolling sensitivity
          window.scrollBy(0, scrollAmount);
        }
        break;
        
      default:
        // Unknown raw navigation type
        break;
    }
  }
}

// Handle controller connection/disconnection
function handleControllerConnection(connected, gamepadId) {
  const indicator = document.getElementById('controller-indicator');
  
  if (connected) {
    // Only log the first controller connection to reduce spam
    if (state.gamepadManager && state.gamepadManager.getConnectedGamepads().length === 1) {
      logger.info(`Controller connected: ${gamepadId}`);
    }
    
    if (indicator) {
      indicator.style.display = 'flex';
      indicator.classList.add('visible');
      indicator.title = `Controller Connected: ${gamepadId}`;
    }
    
    // Enable grid navigation if we're not in video player and have clips
    // Only do this once to prevent multiple triggers
    const isPlayerActive = playerOverlay.style.display === "block";
    if (!isPlayerActive && clipGridModule.getVisibleClips().length > 0 && !state.gridNavigationEnabled) {
      setTimeout(() => {
        clipGridModule.enableGridNavigation();
      }, 500); // Small delay to let everything settle
    }
  } else {
    // Only log when all controllers are disconnected
    if (state.gamepadManager && !state.gamepadManager.isGamepadConnected()) {
      logger.info(`All controllers disconnected`);
    }
    
    if (indicator && state.gamepadManager && !state.gamepadManager.isGamepadConnected()) {
      // Only hide if no controllers are connected
      indicator.classList.remove('visible');
      indicator.title = 'Controller Disconnected';
      setTimeout(() => { if (!indicator.classList.contains('visible')) indicator.style.display = 'none'; }, 250);
    }
  }
}

// Variables for watch session tracking
let currentSessionStartTime = null;
let currentSessionActiveDuration = 0;
let lastPlayTimestamp = null;

const previewElement = document.getElementById('timeline-preview');

previewElement.style.display = 'none';;

// Create a temporary video element for previews
const tempVideo = document.createElement('video');
tempVideo.crossOrigin = 'anonymous';
tempVideo.preload = 'auto';
tempVideo.muted = true;
tempVideo.style.display = 'none'; // Hide the temp video
document.body.appendChild(tempVideo); // Add to DOM

ipcRenderer.on('log', (event, { type, message }) => {
  console[type](`[Main Process] ${message}`);
});

const DIAGNOSTICS_STAGE_LABELS = {
  initializing: 'Preparing workspace',
  'system-info': 'Collecting system info',
  logs: 'Gathering logs',
  'settings-files': 'Gathering state.settings files',
  'settings-snapshot': 'Capturing state.settings snapshot',
  'activity-logs': 'Bundling activity history',
  complete: 'Complete'
};

ipcRenderer.on('diagnostics-progress', (event, progress) => {
  if (!state.diagnosticsInProgress) return;
  updateDiagnosticsStatus(progress);
});

function formatBytes(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  const digits = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function setDiagnosticsStatusMessage(message, state = 'info') {
  if (!state.diagnosticsStatusEl) return;
  state.diagnosticsStatusEl.textContent = message;
  state.diagnosticsStatusEl.dataset.state = state;
}

function updateDiagnosticsStatus(progress) {
  if (!state.diagnosticsStatusEl) return;
  const label = DIAGNOSTICS_STAGE_LABELS[progress.stage] || progress.stage;

  if (progress.stage === 'complete') {
    const sizeText = typeof progress.bytes === 'number' ? ` (${formatBytes(progress.bytes)})` : '';
    state.diagnosticsStatusEl.textContent = `${label}${sizeText}`;
    state.diagnosticsStatusEl.dataset.state = 'success';
    return;
  }

  const total = Number(progress.total) || 0;
  const completed = Number(progress.completed) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  const percentText = percent ? ` (${percent}%)` : '';
  state.diagnosticsStatusEl.textContent = `${label}${percentText}`;
  state.diagnosticsStatusEl.dataset.state = 'progress';
}

async function handleDiagnosticsGeneration() {
  if (state.diagnosticsInProgress) return;

  const targetPath = await ipcRenderer.invoke('show-diagnostics-save-dialog');
  if (!targetPath) {
    setDiagnosticsStatusMessage('Diagnostics generation cancelled.', 'info');
    return;
  }

  state.diagnosticsInProgress = true;
  setDiagnosticsStatusMessage('Preparing diagnostics bundle...', 'progress');

  if (state.generateDiagnosticsBtn) {
    state.generateDiagnosticsBtn.disabled = true;
    state.generateDiagnosticsBtn.textContent = 'Generating...';
  }

  try {
    const response = await ipcRenderer.invoke('generate-diagnostics-zip', targetPath);

    if (!response?.success) {
      throw new Error(response?.error || 'Unknown error');
    }

    const sizeText = typeof response.size === 'number' ? ` (${formatBytes(response.size)})` : '';
    setDiagnosticsStatusMessage(`Diagnostics saved to: ${response.zipPath}${sizeText}`, 'success');
  } catch (error) {
    logger.error('Failed to generate diagnostics bundle:', error);
    setDiagnosticsStatusMessage(`Failed to generate diagnostics: ${error.message}`, 'error');
  } finally {
    state.diagnosticsInProgress = false;
    if (state.generateDiagnosticsBtn) {
      state.generateDiagnosticsBtn.disabled = false;
      state.generateDiagnosticsBtn.textContent = diagnosticsButtonDefaultLabel;
    }
  }
}

const settingsModal = document.createElement("div");
settingsModal.id = "settingsModal";
settingsModal.className = "settings-modal";
settingsModal.innerHTML = `
<div class="settings-modal-content">
    <div class="settings-tabs">
      <div class="settings-tab active" data-tab="general">General</div>
      <div class="settings-tab" data-tab="display">Display</div>
      <div class="settings-tab" data-tab="exportImport">Export/Import</div>
      <div class="settings-tab" data-tab="about">About</div>
    </div>

    <div class="settings-tab-content active" data-tab="general">
      <div class="settings-group">
        <h3 class="settings-group-title">Clip Library Location</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Current Location</div>
            <div class="settings-item-description" id="currentClipLocation">Loading...</div>
          </div>
          <div class="settings-control">
            <button id="changeLocationBtn" class="settings-button settings-button-primary">Change Location</button>
          </div>
        </div>
      </div>



      <div class="settings-group">
        <h3 class="settings-group-title">Integration</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Discord Rich Presence</div>
            <div class="settings-item-description">Show your current activity in Discord</div>
          </div>
          <div class="settings-control">
            <label class="settings-switch">
              <input type="checkbox" id="enableDiscordRPC">
              <span class="settings-switch-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h3 class="settings-group-title">Tag Management</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Manage Tags</div>
            <div class="settings-item-description">Edit and organize your clip tags</div>
          </div>
          <div class="settings-control">
            <button id="manageTagsBtn" class="settings-button settings-button-secondary">Manage Tags</button>
          </div>
        </div>
      </div>

    </div>

    <div class="settings-tab-content" data-tab="display">
      <div class="settings-group">
        <h3 class="settings-group-title">Visual Indicators</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Show New Clips Indicators</div>
            <div class="settings-item-description">Display green lines and highlights to show new clips since last session</div>
          </div>
          <div class="settings-control">
            <label class="settings-switch">
              <input type="checkbox" id="showNewClipsIndicators">
              <span class="settings-switch-slider"></span>
            </label>
          </div>
        </div>

        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Greyscale Icons</div>
            <div class="settings-item-description">Display clip icons in greyscale</div>
          </div>
          <div class="settings-control">
            <label class="settings-switch">
              <input type="checkbox" id="greyscaleIcons">
              <span class="settings-switch-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h3 class="settings-group-title">Playback</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Preview Volume</div>
            <div class="settings-item-description">Set the default volume for clip previews</div>
          </div>
          <div class="settings-control">
            <input type="range" id="previewVolumeSlider" class="settings-range" min="0" max="1" step="0.01" value="0.1">
            <span id="previewVolumeValue">10%</span>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h3 class="settings-group-title">Ambient Glow</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Enable Ambient Glow</div>
            <div class="settings-item-description">Show a colorful glow behind the video player that matches the video content</div>
          </div>
          <div class="settings-control">
            <label class="settings-switch">
              <input type="checkbox" id="ambientGlowEnabled">
              <span class="settings-switch-slider"></span>
            </label>
          </div>
        </div>

        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Smoothing</div>
            <div class="settings-item-description">How smoothly the glow transitions between colors (lower = smoother)</div>
          </div>
          <div class="settings-control">
            <input type="range" id="ambientGlowSmoothing" class="settings-range" min="0.1" max="1" step="0.1" value="0.5">
            <span id="ambientGlowSmoothingValue">0.5</span>
          </div>
        </div>

        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Update Rate</div>
            <div class="settings-item-description">How often the glow updates (higher = smoother but uses more CPU)</div>
          </div>
          <div class="settings-control">
            <select id="ambientGlowFps" class="settings-select">
              <option value="15">15 fps</option>
              <option value="24">24 fps</option>
              <option value="30" selected>30 fps</option>
              <option value="60">60 fps</option>
            </select>
          </div>
        </div>

        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Blur Amount</div>
            <div class="settings-item-description">How blurry the glow effect appears</div>
          </div>
          <div class="settings-control">
            <input type="range" id="ambientGlowBlur" class="settings-range" min="40" max="120" step="10" value="80">
            <span id="ambientGlowBlurValue">80px</span>
          </div>
        </div>

        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Opacity</div>
            <div class="settings-item-description">How visible the glow effect is</div>
          </div>
          <div class="settings-control">
            <input type="range" id="ambientGlowOpacity" class="settings-range" min="0.3" max="1" step="0.1" value="0.7">
            <span id="ambientGlowOpacityValue">70%</span>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-tab-content" data-tab="exportImport">
      <div class="settings-group">
        <h3 class="settings-group-title">Export Settings</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Export Quality</div>
            <div class="settings-item-description">Choose the default quality for exported clips</div>
          </div>
          <div class="settings-control">
            <select id="exportQuality" class="settings-select">
              <option value="discord">Discord (~10MB)</option>
              <option value="high">High Quality (~30MB)</option>
              <option value="lossless">Lossless</option>
            </select>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h3 class="settings-group-title">Import Options</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Import from SteelSeries</div>
            <div class="settings-item-description">Select your SteelSeries Moments folder</div>
          </div>
          <div class="settings-control">
            <button id="importSteelSeriesBtn" class="settings-button settings-button-primary">Import Clips</button>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-tab-content" data-tab="about">
      <div class="settings-group">
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Clip Library</div>
            <div class="settings-item-description">A modern, fast, and efficient way to manage your clip collection.</div>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h3 class="settings-group-title">Updates</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Check for Updates</div>
            <div class="settings-item-description">Manually check if a newer version is available.</div>
            <div id="updateCheckStatus" class="settings-item-description update-check-status"></div>
          </div>
          <div class="settings-control">
            <button id="checkForUpdatesBtn" class="settings-button settings-button-primary">Check Now</button>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h3 class="settings-group-title">Diagnostics</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Generate Diagnostics Zip</div>
            <div class="settings-item-description">Bundle logs, settings, and system info to share for troubleshooting.</div>
            <div id="diagnosticsStatus" class="settings-item-description diagnostics-status"></div>
          </div>
          <div class="settings-control">
            <button id="generateDiagnosticsBtn" class="settings-button settings-button-secondary">Generate Zip</button>
          </div>
        </div>
      </div>

      <div class="settings-version">
        <p>Version: <span id="app-version">Loading...</span></p>
      </div>
    </div>
    <div class="settings-footer">
      <button id="closeSettingsBtn" class="settings-save-button">
        Save Settings
      </button>
    </div>
  </div>
`;

const container = document.querySelector('.cet-container') || document.body;
container.appendChild(settingsModal);

const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const currentClipLocationSpan = document.getElementById("currentClipLocation");
state.generateDiagnosticsBtn = document.getElementById('state.generateDiagnosticsBtn');
state.diagnosticsStatusEl = document.getElementById('diagnosticsStatus');

if (state.generateDiagnosticsBtn) {
  diagnosticsButtonDefaultLabel = state.generateDiagnosticsBtn.textContent || diagnosticsButtonDefaultLabel;
  state.generateDiagnosticsBtn.addEventListener('click', handleDiagnosticsGeneration);
}

// Check for Updates button handler
const checkForUpdatesBtn = document.getElementById('checkForUpdatesBtn');
const updateCheckStatusEl = document.getElementById('updateCheckStatus');

if (checkForUpdatesBtn) {
  checkForUpdatesBtn.addEventListener('click', handleManualUpdateCheck);
}

async function handleManualUpdateCheck() {
  const btn = document.getElementById('checkForUpdatesBtn');
  const statusEl = document.getElementById('updateCheckStatus');
  
  if (!btn || !statusEl) return;
  
  const originalText = btn.textContent;
  btn.textContent = 'Checking...';
  btn.disabled = true;
  statusEl.textContent = '';
  statusEl.className = 'settings-item-description update-check-status';
  
  try {
    logger.info('Manual update check initiated');
    const result = await ipcRenderer.invoke('check-for-updates');
    
    if (result.updateAvailable) {
      statusEl.textContent = `Update available: v${result.latestVersion}`;
      statusEl.classList.add('update-available');
      
      // Show the update notification
      ipcRenderer.emit('show-update-notification', null, {
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        changelog: result.changelog
      });
      logger.info(`Update found: ${result.currentVersion} -> ${result.latestVersion}`);
    } else if (result.error === 'network_unavailable') {
      statusEl.textContent = 'Could not connect. Check your internet connection.';
      statusEl.classList.add('update-error');
      logger.warn('Update check failed: network unavailable');
    } else if (result.error === 'rate_limited') {
      statusEl.textContent = 'Too many requests. Please try again later.';
      statusEl.classList.add('update-error');
      logger.warn('Update check failed: rate limited');
    } else if (result.error) {
      statusEl.textContent = `Check failed: ${result.error}`;
      statusEl.classList.add('update-error');
      logger.error(`Update check failed: ${result.error}`);
    } else {
      statusEl.textContent = `You're up to date! (v${result.currentVersion})`;
      statusEl.classList.add('update-current');
      logger.info('Application is up to date');
    }
  } catch (error) {
    statusEl.textContent = 'Failed to check for updates';
    statusEl.classList.add('update-error');
    logger.error('Update check error:', error);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function fetchSettings() {
  state.settings = await ipcRenderer.invoke('get-settings');
  logger.info('Fetched settings:', state.settings);  // Log the fetched settings
  
  // Set defaults if not present
  if (state.settings.previewVolume === undefined) state.settings.previewVolume = 0.1;
  if (state.settings.exportQuality === undefined) state.settings.exportQuality = 'discord';
  if (state.settings.iconGreyscale === undefined) state.settings.iconGreyscale = false;
  await ipcRenderer.invoke('save-settings', state.settings);
  logger.info('Settings after defaults:', state.settings);  // Log after setting defaults
  return state.settings;
}

/**
 * Helper to update a nested setting value and save to disk.
 * @param {string} path - Dot-separated path to the setting (e.g., 'ambientGlow.fps')
 * @param {*} value - The new value to set
 * @returns {Promise<object>} The updated state.settings object
 */
async function updateSettingValue(path, value) {
  const currentSettings = await ipcRenderer.invoke('get-settings');
  const keys = path.split('.');
  let target = currentSettings;
  
  // Navigate to parent object, creating nested objects if needed
  for (let i = 0; i < keys.length - 1; i++) {
    target[keys[i]] = target[keys[i]] || {};
    target = target[keys[i]];
  }
  
  // Set the value
  target[keys[keys.length - 1]] = value;
  
  await ipcRenderer.invoke('save-settings', currentSettings);
  state.settings = currentSettings;
  return state.settings;
}

let newClipsInfo = { newClips: [], totalNewCount: 0 }; // Track new clips info



function hideLoadingScreen() {
  if (state.loadingScreen) {
    // Add the fade-out class to trigger the animations
    state.loadingScreen.classList.add('fade-out');
    
    // Remove the element after the animation completes
    setTimeout(() => {
      state.loadingScreen.style.display = 'none';
    }, 1000); // Match this with the animation duration (1s)
  }
}

async function updateVersionDisplay() {
  try {
    const version = await ipcRenderer.invoke('get-app-version');
    const versionElement = document.getElementById('app-version');
    if (versionElement) {
      versionElement.textContent = `Version: ${version}`;
    }
  } catch (error) {
    logger.error('Failed to get app version:', error);
  }
}


ipcRenderer.on('new-clip-added', async (event, fileName) => {
  // Wait for state.settings to be loaded if they haven't been yet
  if (!state.settings) {
    try {
      state.settings = await ipcRenderer.invoke('get-settings');
    } catch (error) {
      logger.error('Failed to load state.settings:', error);
      return;
    }
  }
  
  await addNewClipToLibrary(fileName);
  tagManagerModule.updateFilterDropdown();
});

ipcRenderer.on("thumbnail-validation-start", (event, { total }) => {
  // Always reset state when validation starts
  state.isGeneratingThumbnails = false;
  state.currentGenerationTotal = 0;
  state.completedThumbnails = 0;
  state.thumbnailGenerationStartTime = null;
  
  if (total > 0) {
    showThumbnailGenerationText(total);
  }
});

ipcRenderer.on("thumbnail-progress", (event, { current, total, clipName }) => {
  if (state.isGeneratingThumbnails) {
    updateThumbnailGenerationText(total - current);
  }
  logger.info(`Thumbnail generation progress: (${current}/${total}) - Processing: ${clipName}`);
});

ipcRenderer.on("thumbnail-generation-complete", () => {
  hideThumbnailGenerationText();
  state.isGeneratingThumbnails = false;
  // Clear any existing timeouts here as well
  if (window.thumbnailGenerationTimeout) {
    clearTimeout(window.thumbnailGenerationTimeout);
    window.thumbnailGenerationTimeout = null;
  }
});

function showThumbnailGenerationText(totalToGenerate) {
  if (totalToGenerate <= 12) return;
  
  // Reset all state variables
  state.isGeneratingThumbnails = true;
  state.currentGenerationTotal = totalToGenerate;
  state.completedThumbnails = 0;
  state.thumbnailGenerationStartTime = Date.now();
  
  let textElement = document.getElementById("thumbnail-generation-text");
  
  if (!textElement) {
    textElement = document.createElement("div");
    textElement.id = "thumbnail-generation-text";
    textElement.style.position = "fixed";
    textElement.style.top = "100px";
    textElement.style.left = "50%";
    textElement.style.transform = "translateX(-50%)";
    textElement.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
    textElement.style.color = "white";
    textElement.style.padding = "10px 20px";
    textElement.style.borderRadius = "20px";
    textElement.style.zIndex = "10000";
    textElement.style.fontWeight = "normal";
    textElement.style.display = "block";
    document.body.appendChild(textElement);
  }
  
  updateThumbnailGenerationText(totalToGenerate);
}

function updateClipCounter(count) {
  const counter = document.getElementById('clip-counter');
  if (counter) {
    counter.textContent = `Clips: ${count}`;
  }
}

function updateThumbnailGenerationText(remaining) {
  if (!state.isGeneratingThumbnails) return;
  
  const textElement = document.getElementById("thumbnail-generation-text");
  if (!textElement) return;

  textElement.style.display = "block";
  
  if (remaining <= 0) {
    hideThumbnailGenerationText();
    return;
  }

  state.completedThumbnails = state.currentGenerationTotal - remaining;
  const percentage = Math.round((state.completedThumbnails / state.currentGenerationTotal) * 100);
  
  // Calculate time estimate based on actual progress
  let estimatedTimeRemaining = 0;
  if (state.completedThumbnails > 0) {
    state.elapsedTime = (Date.now() - state.thumbnailGenerationStartTime) / 1000; // in seconds
    const averageTimePerThumbnail = state.elapsedTime / state.completedThumbnails;
    // Calculate remaining time and convert to minutes, rounding up
    estimatedTimeRemaining = Math.ceil((averageTimePerThumbnail * remaining) / 60);
    
    // Ensure we show at least 1 minute if there's any time remaining
    if (remaining > 0 && estimatedTimeRemaining === 0) {
      estimatedTimeRemaining = 1;
    }
  }

  textElement.textContent = `Generating thumbnails... ${state.completedThumbnails}/${state.currentGenerationTotal} (${percentage}%) - Est. ${estimatedTimeRemaining} min remaining`;
}

function hideThumbnailGenerationText() {
  const textElement = document.getElementById("thumbnail-generation-text");
  if (textElement) {
    textElement.remove();
  }
  state.isGeneratingThumbnails = false;
  state.currentGenerationTotal = 0;
  state.completedThumbnails = 0;
}

function positionNewClipsIndicators() {
  console.log('Attempting to position new clips indicators...');
  
  // Remove any existing positioned indicators first
  document.querySelectorAll('.new-clips-indicator.positioned').forEach(el => el.remove());
  
  // Check if new clips indicators are disabled
  if (!state.settings || state.settings.showNewClipsIndicators === false) {
    console.log('New clips indicators are disabled in state.settings');
    return;
  }
  
  // Find all content areas that need indicators
  const contentAreas = document.querySelectorAll('.clip-group-content[data-needs-indicator="true"]');
  console.log('Found content areas needing indicators:', contentAreas.length);
  
  contentAreas.forEach(content => {
    const lastNewIndex = parseInt(content.dataset.lastNewIndex);
    const firstOldIndex = parseInt(content.dataset.firstOldIndex);
    
    console.log(`Processing content area - lastNew: ${lastNewIndex}, firstOld: ${firstOldIndex}`);
    
    const clipItems = content.querySelectorAll('.clip-item');
    console.log('Clip items found:', clipItems.length);
    
    if (clipItems.length === 0) return;
    
    const lastNewClip = clipItems[lastNewIndex];
    const firstOldClip = firstOldIndex >= 0 ? clipItems[firstOldIndex] : null;
    
    if (!lastNewClip) {
      console.log('Missing lastNewClip');
      return;
    }
    
    if (firstOldClip) {
      console.log('Creating indicator between clips:', lastNewClip.dataset.originalName, 'and', firstOldClip.dataset.originalName);
    } else {
      console.log('Creating end-of-group indicator after clip:', lastNewClip.dataset.originalName);
    }
    
    // Get positions relative to the container
    const containerRect = content.getBoundingClientRect();
    const lastNewRect = lastNewClip.getBoundingClientRect();
    
    // Calculate relative positions
    const lastNewLeft = lastNewRect.left - containerRect.left;
    const lastNewTop = lastNewRect.top - containerRect.top;
    const lastNewRight = lastNewLeft + lastNewRect.width;
    const lastNewBottom = lastNewTop + lastNewRect.height;
    
    // Create the indicator
    const indicator = document.createElement('div');
    indicator.className = 'new-clips-indicator positioned';
    
    if (firstOldClip) {
      // Normal case: indicator between two clips
      const firstOldRect = firstOldClip.getBoundingClientRect();
      const firstOldLeft = firstOldRect.left - containerRect.left;
      const firstOldTop = firstOldRect.top - containerRect.top;
      
      // Determine if clips are on same row or different rows
      const sameRow = Math.abs(lastNewTop - firstOldTop) < 10; // Allow small differences
      
      console.log('Same row?', sameRow, 'Y diff:', Math.abs(lastNewTop - firstOldTop));
      
      if (sameRow) {
        // Vertical line between clips in same row
        const midX = (lastNewRight + firstOldLeft) / 2;
        
        console.log('Creating vertical line at X:', midX);
        
        indicator.innerHTML = `<div class="new-clips-line vertical"></div>`;
        indicator.style.cssText = `
          position: absolute;
          left: ${midX - 1}px;
          top: ${lastNewTop}px;
          width: 2px;
          height: ${lastNewRect.height}px;
          z-index: 10;
          pointer-events: none;
        `;
      } else {
        // Horizontal line between rows
        const midY = (lastNewBottom + firstOldTop) / 2;
        
        console.log('Creating horizontal line at Y:', midY);
        
        indicator.innerHTML = `<div class="new-clips-line horizontal"></div>`;
        indicator.style.cssText = `
          position: absolute;
          left: 0;
          top: ${midY - 1}px;
          width: 100%;
          height: 2px;
          z-index: 10;
          pointer-events: none;
        `;
      }
    } else {
      // End of group case: show line after the last new clip
      console.log('Creating end-of-group line after last new clip');
      
      indicator.innerHTML = `<div class="new-clips-line vertical"></div>`;
      indicator.style.cssText = `
        position: absolute;
        left: ${lastNewRight + 10}px;
        top: ${lastNewTop}px;
        width: 2px;
        height: ${lastNewRect.height}px;
        z-index: 10;
        pointer-events: none;
      `;
    }
    
    // Ensure container has relative positioning and is not part of grid
    content.style.position = 'relative';
    
    // Add indicator to the content but not as a grid item
    indicator.style.pointerEvents = 'none';
    indicator.style.position = 'absolute';
    content.appendChild(indicator);
    
    console.log('Indicator created and added to content');
  });
}

// Call after DOM changes to reposition indicators
function updateIndicatorsOnChange() {
  // Debounce to avoid excessive calls
  clearTimeout(window.indicatorUpdateTimeout);
  window.indicatorUpdateTimeout = setTimeout(positionNewClipsIndicators, 50);
}

// Function to update new clips indicators when clips are added/removed
function updateNewClipsIndicators() {
  // Check if new clips indicators are disabled
  if (state.settings.showNewClipsIndicators === false) {
    console.log('New clips indicators are disabled, removing all indicators');
    document.querySelectorAll('.new-clips-indicator').forEach(el => el.remove());
    document.querySelectorAll('.clip-group.new-clips-group').forEach(group => {
      group.classList.remove('new-clips-group');
    });
    return;
  }

  // Check if we still have new clips visible
  if (state.currentClipList && state.currentClipList.length > 0) {
    const hasVisibleNewClips = state.currentClipList.some(clip => clip.isNewSinceLastSession);
    
    if (!hasVisibleNewClips) {
      // No new clips visible, remove all indicators
      document.querySelectorAll('.new-clips-indicator').forEach(el => el.remove());
      return;
    }
    
    // Re-render the current clips to update indicators
    clipGridModule.renderClips(state.currentClipList);
  } else {
    // Remove all indicators if no clips
    document.querySelectorAll('.new-clips-indicator').forEach(el => el.remove());
  }
}

window.addEventListener('beforeunload', () => {
  if (window.thumbnailGenerationTimeout) {
    clearTimeout(window.thumbnailGenerationTimeout);
  }
  hideThumbnailGenerationText();
});

// Add window resize listener to reposition indicators
window.addEventListener('resize', () => {
  updateIndicatorsOnChange();
});

// Dev console debugging function
window.setNewClipsCount = function(count) {
  if (!state.allClips || state.allClips.length === 0) {
    console.log('No clips loaded yet');
    return;
  }
  
  if (count < 0 || count > state.allClips.length) {
    console.log(`Invalid count. Must be between 0 and ${state.allClips.length}`);
    return;
  }
  
  // Reset all clips to not new
  state.allClips.forEach(clip => {
    clip.isNewSinceLastSession = false;
  });
  
  // Mark the first 'count' clips as new
  for (let i = 0; i < count; i++) {
    state.allClips[i].isNewSinceLastSession = true;
  }
  
  // Update the global newClipsInfo
  newClipsInfo = {
    newClips: state.allClips.slice(0, count).map(clip => clip.originalName),
    totalNewCount: count
  };
  
  // Also update state.currentClipList if it exists
  if (state.currentClipList && state.currentClipList.length > 0) {
    state.currentClipList.forEach(clip => {
      clip.isNewSinceLastSession = state.allClips.find(ac => ac.originalName === clip.originalName)?.isNewSinceLastSession || false;
    });
  }
  
  // Re-render to show the changes
  if (state.currentClipList) {
    clipGridModule.renderClips(state.currentClipList);
    
    // Position indicators after render completes
    setTimeout(() => {
      positionNewClipsIndicators();
    }, 100);
  }
  
  console.log(`Set ${count} clips as new. Green line should appear after clip ${count} (if visible).`);
  console.log('New clips:', newClipsInfo.newClips);
};

// Also add a helper to see current state
window.debugNewClips = function() {
  console.log('Current new clips info:', newClipsInfo);
  console.log('Clips marked as new:', state.allClips.filter(clip => clip.isNewSinceLastSession).map(c => c.originalName));
  console.log('Total clips loaded:', state.allClips.length);
  console.log('Current filtered clips:', state.currentClipList.length);
};

// And a helper to reset
window.resetNewClips = function() {
  setNewClipsCount(0);
  console.log('Reset all clips to not new');
};

// Debug helper to check data attributes
window.checkIndicatorData = function() {
  const contentAreas = document.querySelectorAll('.clip-group-content');
  console.log('All content areas:', contentAreas.length);
  
  contentAreas.forEach((content, index) => {
    console.log(`Content ${index}:`, {
      needsIndicator: content.dataset.needsIndicator,
      lastNewIndex: content.dataset.lastNewIndex,
      firstOldIndex: content.dataset.firstOldIndex,
      clipCount: content.querySelectorAll('.clip-item').length
    });
  });
  
  // Also try positioning
  positionNewClipsIndicators();
};

console.log('Dev functions available:');
console.log('  setNewClipsCount(n) - Mark first n clips as new');
console.log('  debugNewClips() - Show current state');  
console.log('  resetNewClips() - Mark all clips as not new');
console.log('  checkIndicatorData() - Debug data attributes and positioning');

ipcRenderer.on("thumbnail-generation-failed", (event, { clipName, error }) => {
  logger.error(`Failed to generate thumbnail for ${clipName}: ${error}`);
});

ipcRenderer.on("thumbnail-generated", (event, { clipName, thumbnailPath }) => {
  // Update cache with newly generated thumbnail
  state.thumbnailPathCache.set(clipName, thumbnailPath);
  updateClipThumbnail(clipName, thumbnailPath);
});

async function getFfmpegVersion() {
  try {
    await ipcRenderer.invoke('get-ffmpeg-version');
  } catch (error) {
    logger.error('Failed to get FFmpeg version:', error);
  }
}

function updateClipThumbnail(clipName, thumbnailPath) {
  const clipElement = document.querySelector(
    `.clip-item[data-original-name="${clipName}"]`
  );
  if (clipElement) {
    const imgElement = clipElement.querySelector("img");
    if (imgElement) {
      // Create a new image element
      const newImg = new Image();
      newImg.onload = () => {
        // Only replace the src after the new image has loaded
        imgElement.src = newImg.src;
      };
      // Add cache busting and random number to ensure unique URL
      newImg.src = `file://${thumbnailPath}?t=${Date.now()}-${Math.random()}`;
    } else {
      logger.warn(`Image element not found for clip: ${clipName}`);
    }
  } else {
    logger.warn(`Clip element not found for: ${clipName}`);
  }
}

function getTimeGroup(timestamp) {
  const now = new Date();
  const date = new Date(timestamp);
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'This Week';
  if (diffDays <= 30) return 'This Month';
  
  if (date.getFullYear() === now.getFullYear()) {
    return 'This Year';
  }
  
  // Return the specific year for any past year
  return date.getFullYear().toString();
}

function getGroupOrder(groupName) {
  // Handle special groups first
  const specialGroups = {
    'Today': 0,
    'Yesterday': 1,
    'This Week': 2,
    'This Month': 3,
    'This Year': 4
  };

  if (groupName in specialGroups) {
    return specialGroups[groupName];
  }

  // For year groups, make them ordered after special groups
  const year = parseInt(groupName);
  if (!isNaN(year)) {
    // Start years at 100 to ensure they come after special groups
    // Subtract from a future year (e.g., 3000) to make recent years come first
    return 100 + (3000 - year);
  }

  return 999; // Fallback for any unexpected group names
}

function loadCollapsedState() {
  try {
    return JSON.parse(localStorage.getItem('clipGroupsCollapsed')) || {};
  } catch {
    return {};
  }
}

function saveCollapsedState(state) {
  localStorage.setItem('clipGroupsCollapsed', JSON.stringify(state));
}


function setupContextMenu() {
  const contextMenu = document.getElementById("context-menu");
  const contextMenuExport = document.getElementById("context-menu-export");
  const contextMenuDelete = document.getElementById("context-menu-delete");
  const contextMenuReveal = document.getElementById("context-menu-reveal");
  const contextMenuTags = document.getElementById("context-menu-tags");
  const contextMenuResetTrim = document.getElementById("context-menu-reset-trim");
  const tagsDropdown = document.getElementById("tags-dropdown");
  const tagSearchInput = document.getElementById("tag-search-input");
  const addTagButton = document.getElementById("add-tag-button");

  if (
    !contextMenu ||
    !contextMenuExport ||
    !contextMenuDelete ||
    !contextMenuReveal) {
    logger.error("One or more context menu elements not found");
    return;
  }

  document.addEventListener("click", (e) => {
    if (!contextMenu.contains(e.target)) {
      contextMenu.style.display = "none";
      state.isTagsDropdownOpen = false;
      tagsDropdown.style.display = "none";
    }
  });

  contextMenuExport.addEventListener("click", () => {
    logger.info("Export clicked for clip:", state.contextMenuClip?.originalName);
    if (state.contextMenuClip) {
      videoPlayerModule.exportClipFromContextMenu(state.contextMenuClip);
    }
    contextMenu.style.display = "none";
  });

  contextMenuReveal.addEventListener("click", () => {
    logger.info("Reveal in Explorer clicked for clip:", state.contextMenuClip?.originalName);
    if (state.contextMenuClip) {
      ipcRenderer.invoke('reveal-clip', state.contextMenuClip.originalName);
    }
    contextMenu.style.display = "none";
  });

  contextMenuTags.addEventListener("click", (e) => {
    e.stopPropagation();
    state.isTagsDropdownOpen = !state.isTagsDropdownOpen;
    const tagsDropdown = document.getElementById("tags-dropdown");
    tagsDropdown.style.display = state.isTagsDropdownOpen ? "block" : "none";
    if (state.isTagsDropdownOpen) {
      const tagSearchInput = document.getElementById("tag-search-input");
      tagSearchInput.focus();
      tagManagerModule.updateTagList();
    }
  });

  addTagButton.addEventListener("click", async () => {
    const tagSearchInput = document.getElementById("tag-search-input");
    const newTag = tagSearchInput.value.trim();
    if (newTag && !tagManagerModule.getGlobalTags().includes(newTag)) {
      await tagManagerModule.addGlobalTag(newTag);
      if (state.contextMenuClip) {
        await tagManagerModule.toggleClipTag(state.contextMenuClip, newTag);
      }
      tagSearchInput.value = "";
      tagManagerModule.updateTagList();
    }
  });

  tagSearchInput.addEventListener("input", () => {
     tagManagerModule.updateTagList();
  });
  
  tagSearchInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const searchTerm = tagSearchInput.value.trim().toLowerCase();
      
      // Find the closest matching tag
      const matchingTag = tagManagerModule.getGlobalTags().find(tag => 
        tag.toLowerCase() === searchTerm ||
        tag.toLowerCase().startsWith(searchTerm)
      );
      
      if (matchingTag && state.contextMenuClip) {
        await tagManagerModule.toggleClipTag(state.contextMenuClip, matchingTag);
        tagSearchInput.value = "";
        tagManagerModule.updateTagList();
      }
    }
  });

  tagsDropdown.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  contextMenuDelete.addEventListener("click", async () => {
    logger.info("Delete clicked for clip:", state.contextMenuClip?.originalName);
    if (state.contextMenuClip) {
      await clipGridModule.confirmAndDeleteClip(state.contextMenuClip);
    }
    contextMenu.style.display = "none";
  });

  if (contextMenuResetTrim) {
    contextMenuResetTrim.addEventListener("click", async () => {
      logger.info("Reset trim clicked for clip:", state.contextMenuClip?.originalName);
      if (state.contextMenuClip) {
        await videoPlayerModule.resetClipTrimTimes(state.contextMenuClip);
      }
      contextMenu.style.display = "none";
    });
  }

  // Close context menu when clicking outside
  document.addEventListener("click", () => {
    contextMenu.style.display = "none";
  });
}

document.getElementById('manageTagsBtn').addEventListener('click', searchManagerModule.openTagManagement);












const toast = document.getElementById('export-toast');
const content = toast.querySelector('.export-toast-content');
const progressText = toast.querySelector('.export-progress-text');
const title = toast.querySelector('.export-title');

function showExportProgress(current, total, isClipboardExport = false) {
  if (!toast.classList.contains('show')) {
    toast.classList.add('show');
  }

  const percentage = Math.min(Math.round((current / total) * 100), 100);
  content.style.setProperty('--progress', `${percentage}%`);
  progressText.textContent = `${percentage}%`;

  if (percentage >= 100) {
    content.classList.add('complete');
    if (isClipboardExport) {
      title.textContent = 'Copied to clipboard!';
    } else {
      title.textContent = 'Export complete!';
    }

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        title.textContent = 'Exporting...';
        content.style.setProperty('--progress', '0%');
        progressText.textContent = '0%';
        content.classList.remove('complete');
      }, 300);
    }, 3000);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Ensure keybindings are loaded before we attach any listeners that use them
  await keybinds.initKeybindings();

  // Load state.settings before any initialization that depends on them
  await fetchSettings();

  // Initialize video player module with DOM elements and callbacks
  videoPlayerModule.init({
    videoPlayer: document.getElementById("video-player"),
    clipTitle: document.getElementById("clip-title"),
    progressBarContainer: document.getElementById("progress-bar-container"),
    progressBar: document.getElementById("progress-bar"),
    trimStart: document.getElementById("trim-start"),
    trimEnd: document.getElementById("trim-end"),
    playhead: document.getElementById("playhead"),
    loadingOverlay: document.getElementById("loading-overlay"),
    playerOverlay: document.getElementById("player-overlay"),
    videoClickTarget: document.getElementById("video-click-target"),
    ambientGlowCanvas: document.getElementById("ambient-glow-canvas"),
    fullscreenPlayer: document.getElementById("fullscreen-player"),
    videoControls: document.getElementById("video-controls"),
    volumeButton: document.getElementById("volume-button"),
    volumeSlider: document.getElementById("volume-slider"),
    volumeContainer: document.getElementById("volume-container"),
    speedButton: document.getElementById("speed-button"),
    speedSlider: document.getElementById("speed-slider"),
    speedContainer: document.getElementById("speed-container"),
    speedText: document.getElementById("speed-text"),
    currentTimeDisplay: document.getElementById("current-time"),
    totalTimeDisplay: document.getElementById("total-time"),
  }, {
    // Callbacks for module to trigger renderer.js functions
    logCurrentWatchSession: logCurrentWatchSession,
    initializeVolumeControls: initializeVolumeControls,
    getCachedClipData: getCachedClipData,
    getThumbnailPath: clipGridModule.getThumbnailPath,
    updateDiscordPresenceForClip: updateDiscordPresenceForClip,
    updateNavigationButtons: updateNavigationButtons,
    showCustomAlert: showCustomAlert,
    showVolumeControls: showVolumeControls,
    updateVolumeControlsPosition: updateVolumeControlsPosition,
    showExportProgress: showExportProgress,
    showCustomConfirm: showCustomConfirm,
    isBenchmarkMode: isBenchmarkMode,
    updateDiscordPresence: updateDiscordPresence,
  });

  // Initialize search manager with dependencies
  searchManagerModule.init({
    state: state,
    renderClips: clipGridModule.renderClips,
    updateClipCounter: updateClipCounter,
    updateNavigationButtons: updateNavigationButtons,
    filterClips: filterClips,
    tagManagerModule: tagManagerModule,
    videoPlayerModule: videoPlayerModule
  });

  // Initialize export manager with dependencies
  exportManagerModule.init({
    videoPlayerModule: videoPlayerModule,
    showExportProgress: showExportProgress,
    showCustomAlert: showCustomAlert,
    getFfmpegVersion: getFfmpegVersion
  });

  // Initialize settings manager with dependencies
  settingsManagerUiModule.init({
    videoPlayerModule: videoPlayerModule,
    searchManagerModule: searchManagerModule,
    fetchSettings: fetchSettings,
    updateSettingValue: updateSettingValue,
    toggleDiscordRPC: toggleDiscordRPC,
    applyIconGreyscale: applyIconGreyscale,
    renderClips: clipGridModule.renderClips,
    updateVersionDisplay: updateVersionDisplay,
    changeClipLocation: changeClipLocation,
    updateAllPreviewVolumes: updateAllPreviewVolumes,
    populateKeybindingList: populateKeybindingList
  });

  // Initialize grid navigation module
  gridNavigationModule.init({});

  // Initialize clip grid module with dependencies
  clipGridModule.init({
    showCustomConfirm: showCustomConfirm,
    showCustomAlert: showCustomAlert,
    updateClipCounter: updateClipCounter,
    getTimeGroup: getTimeGroup,
    getGroupOrder: getGroupOrder,
    loadCollapsedState: loadCollapsedState,
    saveCollapsedState: saveCollapsedState,
    removeDuplicates: removeDuplicates,
    getRelativeTimeString: getRelativeTimeString,
    showDeletionTooltip: showDeletionTooltip,
    hideDeletionTooltip: hideDeletionTooltip,
    updateNewClipsIndicators: updateNewClipsIndicators,
    newClipsInfo: newClipsInfo,
    showThumbnailGenerationText: showThumbnailGenerationText,
    hideThumbnailGenerationText: hideThumbnailGenerationText,
    updateThumbnailGenerationText: updateThumbnailGenerationText,
    updateClipThumbnail: updateClipThumbnail,
    handleClipSelection: handleClipSelection,
    clearSelection: clearSelection,
    handleKeyPress: handleKeyPress,
    handleKeyRelease: handleKeyRelease,
    closePlayer: closePlayer,
    disableVideoThumbnail: disableVideoThumbnail,
    saveTitleChange: saveTitleChange,
    showContextMenu: clipGridModule.showContextMenu,
    closeContextMenu: clipGridModule.closeContextMenu,
    filterClips: filterClips,
    setupClipTitleEditing: setupClipTitleEditing,
    positionNewClipsIndicators: positionNewClipsIndicators,
    hideLoadingScreen: hideLoadingScreen,
    currentClipLocationSpan: currentClipLocationSpan,
    clipGrid: clipGrid
  });

  // Initialize state.settings modal and enhanced search
  searchManagerModule.initializeEnhancedSearch();
  await settingsManagerUiModule.initializeSettingsModal();
  
  // Initialize gamepad manager
  await initializeGamepadManager();
  const settingsButton = document.getElementById("settingsButton");
  if (settingsButton) {
    settingsButton.addEventListener("click", settingsManagerUiModule.openSettingsModal);
  } else {
    logger.error("Settings button not found");
  }

  const changeLocationBtn = document.getElementById("changeLocationBtn");
  const manageTagsBtn = document.getElementById("manageTagsBtn");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");

  if (changeLocationBtn) {
    changeLocationBtn.addEventListener("click", changeClipLocation);
  } else {
    logger.error("Change Location button not found");
  }

  if (manageTagsBtn) {
    manageTagsBtn.addEventListener("click", searchManagerModule.openTagManagement);
    logger.info("Manage Tags button listener added");
  } else {
    logger.error("Manage Tags button not found");
  }

  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener("click", settingsManagerUiModule.closeSettingsModal);
  } else {
    logger.error("Close Settings button not found");
  }

  document.getElementById('importSteelSeriesBtn').addEventListener('click', async () => {
    try {
      const importBtn = document.getElementById('importSteelSeriesBtn');
      importBtn.disabled = true;
      importBtn.textContent = 'Importing...';
  
      const sourcePath = await ipcRenderer.invoke('open-folder-dialog-steelseries');
      if (!sourcePath) {
        importBtn.disabled = false;
        importBtn.textContent = 'Import SteelSeries Clips';
        return;
      }
  
      showExportProgress(0, 100);
  
      const progressHandler = (event, { current, total }) => {
        showExportProgress(current, total);
      };
  
      const logHandler = (event, { type, message }) => {
        logger.info(`[SteelSeries] ${message}`);
      };
  
      ipcRenderer.on('steelseries-progress', progressHandler);
      ipcRenderer.on('steelseries-log', logHandler);
  
      const result = await ipcRenderer.invoke('import-steelseries-clips', sourcePath);
  
      if (result.success) {
        // Add "Imported" to state.selectedTags if not already present
        if (!state.selectedTags.has("Imported")) {
          state.selectedTags.add("Imported");
          await saveTagPreferences();
        }
  
        await showCustomAlert('Import completed successfully!');
        // Reload clips to show new imports
        await clipGridModule.loadClips();
        updateFilterDropdown(); // Update the dropdown with new tag
      } else {
        await showCustomAlert(`Import failed: ${result.error}`);
      }
  
      ipcRenderer.removeListener('steelseries-progress', progressHandler);
      ipcRenderer.removeListener('steelseries-log', logHandler);
  
    } catch (error) {
      logger.error('Error during SteelSeries import:', error);
      await showCustomAlert(`Import failed: ${error.message}`);
    } finally {
      const importBtn = document.getElementById('importSteelSeriesBtn');
      importBtn.disabled = false;
      importBtn.textContent = 'Import SteelSeries Clips';
    }
  });

  const titlebarOptions = {
    backgroundColor: TitlebarColor.fromHex("#1e1e1e"),
    menu: null,
    titleHorizontalAlignment: "center",
    unfocusEffect: false,
  };

  new Titlebar(titlebarOptions);

  // Register app functions for benchmark harness
  if (benchmarkHarness) {
    benchmarkHarness.registerFunctions({
      loadClips,
      renderClips: clipGridModule.renderClips,
      openClip,
      closePlayer,
      performSearch,
      allClips: () => state.allClips  // Getter function for current clips
    });
  }

  // Run loadClips with benchmark timing if enabled
  if (benchmarkHarness) {
    await benchmarkHarness.metrics.measure('initialLoadClips', clipGridModule.loadClips);
  } else {
    clipGridModule.loadClips();
  }
  searchManagerModule.setupSearch();

  // Volume event listeners are now handled by videoPlayerModule.init()

  setupContextMenu();
  tagManagerModule.loadGlobalTags();
  applyIconGreyscale(state.settings?.iconGreyscale);

  tagManagerModule.setFilterUpdateCallback(() => filterClips());

  // Create and setup the tag filter UI
  tagManagerModule.createTagFilterUI();
  // Load initial tag preferences
  await tagManagerModule.loadTagPreferences();

  updateDiscordPresence('Browsing clips', `Total clips: ${state.currentClipList.length}`);

  state.loadingScreen = document.getElementById('loading-screen');

  // Run benchmark scenarios if in benchmark mode
  if (isBenchmarkMode && benchmarkHarness) {
    // Allow UI to fully render before running benchmarks
    setTimeout(async () => {
      try {
        logger.info('[Benchmark] Starting automated benchmark scenarios');
        
        // Parse scenarios from environment
        const scenariosJson = process.env.CLIPS_BENCHMARK_SCENARIOS;
        let scenarioIds = ['load_clips', 'open_clip', 'close_player', 'search_simple'];
        
        if (scenariosJson) {
          try {
            scenarioIds = JSON.parse(scenariosJson);
          } catch (e) {
            logger.warn('[Benchmark] Failed to parse scenarios, using defaults');
          }
        }
        
        logger.info(`[Benchmark] Scenarios to run: ${scenarioIds.join(', ')}`);
        
        // Map scenario IDs to harness methods
        const scenarioMap = {
          'load_clips': () => benchmarkHarness.benchmarkLoadClips(),
          'render_clips': () => benchmarkHarness.benchmarkRenderClips(),
          'startup_detailed': () => benchmarkHarness.benchmarkStartupDetailed(),
          'grid_performance': () => benchmarkHarness.benchmarkGridPerformance(),
          'open_clip': () => benchmarkHarness.benchmarkOpenClip(0),
          'open_clip_detailed': () => benchmarkHarness.benchmarkOpenClipDetailed({ iterations: 5, warmupRuns: 1 }),
          'video_metadata': () => benchmarkHarness.benchmarkVideoMetadata(),
          'video_seek': () => benchmarkHarness.benchmarkSeek(),
          'close_player': () => benchmarkHarness.benchmarkClosePlayer(),
          'search_simple': () => benchmarkHarness.benchmarkSearch('clip'),
          'search_complex': () => benchmarkHarness.benchmarkSearch('gameplay video 2024'),
          'thumbnail_batch': () => benchmarkHarness.benchmarkThumbnailGeneration()
        };
        
        // Run each requested scenario
        for (const scenarioId of scenarioIds) {
          const scenarioFn = scenarioMap[scenarioId];
          if (scenarioFn) {
            try {
              logger.info(`[Benchmark] Running scenario: ${scenarioId}`);
              
              const startTime = performance.now();
              const result = await scenarioFn();
              const duration = performance.now() - startTime;
              
              const resultData = {
                scenario: scenarioId,
                duration: result?.duration || duration,
                memory: result?.memory || { heapUsedDelta: 0 },
                details: result
              };
              
              // Send result to main process for stdout output
              await ipcRenderer.invoke('benchmark:outputResult', resultData);
              
              logger.info(`[Benchmark] Scenario ${scenarioId} completed in ${duration.toFixed(1)}ms`);
              
              // Small delay between scenarios
              await new Promise(r => setTimeout(r, 500));
            } catch (error) {
              logger.error(`[Benchmark] Scenario ${scenarioId} failed:`, error);
              
              // Send error result to main
              await ipcRenderer.invoke('benchmark:outputResult', {
                scenario: scenarioId,
                error: error.message
              });
            }
          } else {
            logger.warn(`[Benchmark] Unknown scenario: ${scenarioId}`);
          }
        }
        
        // Get final results from main process
        const mainResults = await ipcRenderer.invoke('benchmark:getResults');
        
        // Send complete signal to main for stdout output
        await ipcRenderer.invoke('benchmark:outputComplete', {
          renderer: benchmarkHarness.getMetrics(),
          main: mainResults
        });
        
        logger.info('[Benchmark] All scenarios completed');
        
        // Close app after benchmarks complete (with delay for output flushing)
        setTimeout(() => {
          ipcRenderer.invoke('benchmark:quit');
        }, 1000);
        
      } catch (error) {
        logger.error('[Benchmark] Benchmark execution failed:', error);
      }
    }, 3000); // Wait 3 seconds for initial load to complete
  }
});





async function changeClipLocation() {
  const newLocation = await ipcRenderer.invoke("open-folder-dialog");
  if (newLocation) {
    try {
      await ipcRenderer.invoke("set-clip-location", newLocation);
      state.clipLocation = newLocation;
      currentClipLocationSpan.textContent = newLocation;
      await clipGridModule.loadClips(); // Reload clips with the new location
    } catch (error) {
      logger.error("Error changing clip location:", error);
      await showCustomAlert(`Failed to change clip location: ${error.message}`);
    }
  }
}


function updateAllPreviewVolumes(newVolume) {
  // Find all video elements inside clip-item elements
  const previewVideos = document.querySelectorAll('.clip-item video');
  previewVideos.forEach(video => {
    video.volume = newVolume;
  });
}

document
  .getElementById("settingsButton")
  .addEventListener("click", settingsManagerUiModule.openSettingsModal);
closeSettingsBtn.addEventListener("click", settingsManagerUiModule.closeSettingsModal);
document
  .getElementById("changeLocationBtn")
  .addEventListener("click", changeClipLocation);

// Add click-outside-to-close functionality for state.settings modal
document.addEventListener('click', (e) => {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal && settingsModal.style.display !== 'none') {
    // Check if we clicked on the modal background (settingsModal div) and not inside the content
    if (e.target.id === 'settingsModal' && !e.target.closest('.settings-modal-content')) {
      settingsManagerUiModule.closeSettingsModal();
    }
  }
});

// Add this function to calculate relative time
function getRelativeTimeString(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffInSeconds = Math.floor((now - date) / 1000);

  const intervals = [
    { label: "year", seconds: 31536000 },
    { label: "month", seconds: 2592000 },
    { label: "day", seconds: 86400 },
    { label: "hour", seconds: 3600 },
    { label: "minute", seconds: 60 },
    { label: "second", seconds: 1 },
  ];

  for (let i = 0; i < intervals.length; i++) {
    const interval = intervals[i];
    const count = Math.floor(diffInSeconds / interval.seconds);
    if (count >= 1) {
      return count === 1
        ? `1 ${interval.label} ago`
        : `${count} ${interval.label}s ago`;
    }
  }

  return "just now";
}





const exportButton = document.getElementById("export-button");
const deleteButton = document.getElementById("delete-button");

deleteButton.addEventListener("click", () => clipGridModule.confirmAndDeleteClip());
exportButton.addEventListener("click", (e) => {
  if (e.ctrlKey && e.shiftKey) {
    exportAudioWithFileSelection();
  } else if (e.ctrlKey) {
    exportVideoWithFileSelection();
  } else if (e.shiftKey) {
    exportAudioToClipboard();
  } else {
    exportManagerModule.exportTrimmedVideo();
  }
});

ipcRenderer.on("close-video-player", () => {
  // Stop ambient glow effect
  if (ambientGlowManager) {
    ambientGlowManager.stop();
  }
  if (videoPlayer) {
    videoPlayer.pause();
    videoPlayer.removeAttribute('src');
    // Don't call load() with empty src - causes MEDIA_ERR_SRC_NOT_SUPPORTED error
  }
});

function updateNavigationButtons() {
  const currentIndex = state.currentClipList.findIndex(clip => clip.originalName === state.currentClip.originalName);
  document.getElementById('prev-video').disabled = currentIndex <= 0;
  document.getElementById('next-video').disabled = currentIndex >= state.currentClipList.length - 1;
}


function navigateToVideo(direction) {
  const currentIndex = state.currentClipList.findIndex(clip => clip.originalName === state.currentClip.originalName);
  const newIndex = currentIndex + direction;
  if (newIndex >= 0 && newIndex < state.currentClipList.length) {
    const nextClip = state.currentClipList[newIndex];
    videoPlayerModule.openClip(nextClip.originalName, nextClip.customName);
  }
}

document.getElementById('prev-video').addEventListener('click', (e) => {
  e.stopPropagation();
  navigateToVideo(-1);
});

document.getElementById('next-video').addEventListener('click', (e) => {
  e.stopPropagation();
  navigateToVideo(1);
});


function showDeletionTooltip() {
  if (!state.deletionTooltip) {
    state.deletionTooltip = document.createElement('div');
    state.deletionTooltip.className = 'deletion-tooltip';
    state.deletionTooltip.textContent = 'Deleting files...';
    document.body.appendChild(state.deletionTooltip);
  }
  
  // Force a reflow to ensure the initial state is applied
  state.deletionTooltip.offsetHeight;
  
  state.deletionTooltip.classList.add('show');
  
  if (state.deletionTimeout) {
    clearTimeout(state.deletionTimeout);
  }
  
  state.deletionTimeout = setTimeout(() => {
    hideDeletionTooltip();
  }, 5000);
}

function hideDeletionTooltip() {
  if (state.deletionTooltip) {
    state.deletionTooltip.classList.remove('show');
  }
  if (state.deletionTimeout) {
    clearTimeout(state.deletionTimeout);
    state.deletionTimeout = null;
  }
}

function disableVideoThumbnail(clipName) {
  const clipElement = document.querySelector(
    `.clip-item[data-original-name="${clipName}"]`,
  );
  if (!clipElement) return;

  // Remove the video element if it exists
  const videoElement = clipElement.querySelector("video");
  if (videoElement) {
    videoElement.remove();
  }

  // Remove event listeners that trigger video preview
  clipElement.removeEventListener(
    "mouseenter",
    clipElement.videoPreviewHandler,
  );
  clipElement.removeEventListener(
    "mouseleave",
    clipElement.videoPreviewHandler,
  );

  // Add a class to indicate that video preview is disabled
  clipElement.classList.add("video-preview-disabled");

  // Add a visual indicator that the clip is being deleted
  const deletingIndicator = document.createElement("div");
  deletingIndicator.className = "deleting-indicator";
  deletingIndicator.textContent = "Deleting...";
  clipElement.appendChild(deletingIndicator);
}



async function exportVideoWithFileSelection() {
  if (!state.currentClip) return;
  const savePath = await ipcRenderer.invoke("open-save-dialog", "video", state.currentClip.originalName, state.currentClip.customName);
  if (savePath) {
    await exportManagerModule.exportVideo(savePath);
  }
}

async function exportAudioWithFileSelection() {
  if (!state.currentClip) return;
  const savePath = await ipcRenderer.invoke("open-save-dialog", "audio", state.currentClip.originalName, state.currentClip.customName);
  if (savePath) {
    await exportManagerModule.exportAudio(savePath);
  }
}

async function exportAudioToClipboard() {
  if (!state.currentClip) return;
  await exportManagerModule.exportAudio();
}



ipcRenderer.on("export-progress", (event, progress) => {
  showExportProgress(progress, 100);
});

// Add this new function to handle overlay clicks
function handleOverlayClick(e) {
  if (e.target === playerOverlay && !window.justFinishedDragging) {
    closePlayer();
  }
}


function setupClipTitleEditing() {
  clipTitle.removeEventListener("focus", clipTitleFocusHandler);
  clipTitle.removeEventListener("blur", clipTitleBlurHandler);
  clipTitle.removeEventListener("keydown", clipTitleKeydownHandler);
  clipTitle.removeEventListener("input", clipTitleInputHandler);

  clipTitle.addEventListener("focus", clipTitleFocusHandler);
  clipTitle.addEventListener("blur", clipTitleBlurHandler);
  clipTitle.addEventListener("keydown", clipTitleKeydownHandler);
  clipTitle.addEventListener("input", clipTitleInputHandler);
}

function clipTitleInputHandler() {
  if (state.currentClip) {
    saveTitleChange(
      state.currentClip.originalName,
      state.currentClip.customName,
      clipTitle.value,
      false,
    );
  }
}

function clipTitleFocusHandler() {
  isRenamingActive = true;

  clipTitle.dataset.originalValue = clipTitle.value;
  updateDiscordPresence('Editing clip title', state.currentClip.customName);
  logger.info(
    "Clip title focused. Original value:",
    clipTitle.dataset.originalValue,
  );
}

function clipTitleBlurHandler() {
  isRenamingActive = false;
  if (state.currentClip) {
    saveTitleChange(
      state.currentClip.originalName,
      state.currentClip.customName,
      clipTitle.value,
      false,
    );
  }
}

function clipTitleKeydownHandler(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    clipTitle.blur();
  }
}

function closePlayer() {
  if (window.justFinishedDragging) {
    return; // Don't close the player if we just finished dragging
  }

  // Log the session before closing
  logCurrentWatchSession(); // Use await if it becomes async later

  if (saveTitleTimeout) {
    clearTimeout(saveTitleTimeout);
    saveTitleTimeout = null;
  }

  // Remove keyboard event listeners for video player controls
  document.removeEventListener("keydown", handleKeyPress);
  document.removeEventListener("keyup", handleKeyRelease);

  // Capture necessary information before resetting state.currentClip
  const originalName = state.currentClip ? state.currentClip.originalName : null;
  const oldCustomName = state.currentClip ? state.currentClip.customName : null;
  const newCustomName = clipTitle.value;

  // Save any pending changes immediately
  saveTitleChange(originalName, oldCustomName, newCustomName, true).then(() => {
    // Stop ambient glow effect
    const ambientGlowManager = videoPlayerModule.getAmbientGlowManager();
    if (ambientGlowManager) {
      ambientGlowManager.stop();
    }

    playerOverlay.style.display = "none";
    fullscreenPlayer.style.display = "none";
    videoPlayer.pause();
    videoPlayer.removeEventListener("canplay", videoPlayerModule.handleVideoCanPlay);
    videoPlayer.removeEventListener("progress", videoPlayerModule.updateLoadingProgress);
    videoPlayer.removeEventListener("waiting", videoPlayerModule.showLoadingOverlay);
    videoPlayer.removeEventListener("playing", videoPlayerModule.hideLoadingOverlay);
    videoPlayer.removeEventListener("seeked", videoPlayerModule.handleVideoSeeked);
    videoPlayer.removeAttribute('src');

    clipTitle.removeEventListener("focus", clipTitleFocusHandler);
    clipTitle.removeEventListener("blur", clipTitleBlurHandler);
    clipTitle.removeEventListener("keydown", clipTitleKeydownHandler);
    clipTitle.removeEventListener("input", clipTitleInputHandler);

    playerOverlay.removeEventListener("click", handleOverlayClick);

    const clipTitleElement = document.getElementById("clip-title");
    if (clipTitleElement) {
      clipTitleElement.value = "";
    }

    // Remove last-opened class from any previously highlighted clip
    document.querySelectorAll('.clip-item.last-opened').forEach(clip => {
      clip.classList.remove('last-opened');
    });

    // Update the clip's display in the grid and highlight it
    if (originalName) {
      updateClipDisplay(originalName);
      const clipElement = document.querySelector(`.clip-item[data-original-name="${originalName}"]`);
      if (clipElement) {
        logger.info('Found clip element to scroll to:', {
          originalName,
          elementExists: !!clipElement,
          elementPosition: clipElement.getBoundingClientRect()
        });

        // Add highlight class
        clipElement.classList.add('last-opened');
        
        // Small delay to ensure DOM updates have processed
        setTimeout(() => {
          smoothScrollToElement(clipElement);
        }, 50);
      } else {
        logger.warn('Clip element not found for scrolling:', originalName);
      }
    }

    // Reset current clip
    state.currentClip = null;
    if (state.currentCleanup) {
      state.currentCleanup();
      state.currentCleanup = null;
    }
  });

  clearInterval(state.discordPresenceInterval);
  updateDiscordPresence('Browsing clips', `Total: ${state.currentClipList.length}`);
  
  // Re-enable grid navigation if controller is connected
  if (state.gamepadManager && state.gamepadManager.isGamepadConnected() && clipGridModule.getVisibleClips().length > 0) {
    setTimeout(() => {
      clipGridModule.enableGridNavigation();
    }, 200); // Small delay to ensure player overlay is hidden
  }
}

// Make sure this event listener is present on the fullscreenPlayer
fullscreenPlayer.addEventListener("click", (e) => {
  e.stopPropagation();
});

playerOverlay.addEventListener("click", closePlayer);

function handleKeyRelease(e) {
  if (e.key === "," || e.key === ".") {
    state.isFrameStepping = false;
    state.frameStepDirection = 0;
  }

  // Handle Space release for temporary speed boost or tap-to-toggle
  if (e.key === ' ' || e.code === 'Space') {
    const isClipTitleFocused = document.activeElement === clipTitle;
    const isSearching = document.activeElement === document.getElementById("search-input");
    const isPlayerActive = playerOverlay.style.display === "block";
    if (!isPlayerActive || isClipTitleFocused || isSearching) return;

    if (state.spaceHoldTimeoutId) {
      clearTimeout(state.spaceHoldTimeoutId);
      state.spaceHoldTimeoutId = null;
    }

    if (state.wasSpaceHoldBoostActive) {
      // Restore previous playback rate without saving/updating UI
      videoPlayer.playbackRate = state.speedBeforeSpaceHold;
    } else {
      // Treat as tap: toggle play/pause
      if (videoPlayer.src) videoPlayerModule.togglePlayPause();
    }

    state.isSpaceHeld = false;
    state.wasSpaceHoldBoostActive = false;
  }
}

function handleKeyPress(e) {
  const isClipTitleFocused = document.activeElement === clipTitle;
  const isSearching = document.activeElement === document.getElementById("search-input");
  const isPlayerActive = playerOverlay.style.display === "block";

  videoPlayerModule.showControls();

  // Special handling for Space: hold to 2x while pressed (no metadata/UI update)
  if (!isClipTitleFocused && !isSearching && (e.key === ' ' || e.code === 'Space')) {
    e.preventDefault();
    if (!state.isSpaceHeld) {
      state.isSpaceHeld = true;
      state.wasSpaceHoldBoostActive = false;
      // Start a short delay to distinguish tap vs hold
      state.spaceHoldTimeoutId = setTimeout(() => {
        // Only boost if still held and video is playing
        if (state.isSpaceHeld && !videoPlayer.paused) {
          state.wasSpaceHoldBoostActive = true;
          state.speedBeforeSpaceHold = videoPlayer.playbackRate;
          videoPlayer.playbackRate = 2;
        }
      }, 200);
    }
    // Do not process further as a keybinding here
    return;
  }

  // Resolve action from keybindings
  if (!isClipTitleFocused && !isSearching) {
    const action = keybinds.getActionFromEvent(e);
    if (!action) return;

    // Prevent default for handled keys unless explicitly allowed
    e.preventDefault();

    if (isPlayerActive) {
      // Handle actions when player is active
      switch (action) {
        case 'closePlayer':
          closePlayer();
          break;
        case 'playPause':
          if (videoPlayer.src) videoPlayerModule.togglePlayPause();
          break;
        case 'frameBackward':
          videoPlayerModule.moveFrame(-1);
          break;
        case 'frameForward':
          videoPlayerModule.moveFrame(1);
          break;
        case 'navigatePrev':
          navigateToVideo(-1);
          break;
        case 'navigateNext':
          navigateToVideo(1);
          break;
        case 'skipBackward':
          videoPlayerModule.skipTime(-1);
          break;
        case 'skipForward':
          videoPlayerModule.skipTime(1);
          break;
        case 'volumeUp':
          videoPlayerModule.changeVolume(0.1);
          break;
        case 'volumeDown':
          videoPlayerModule.changeVolume(-0.1);
          break;
        case 'exportAudioFile':
          exportAudioWithFileSelection();
          break;
        case 'exportVideo':
          exportVideoWithFileSelection();
          break;
        case 'exportAudioClipboard':
          exportAudioToClipboard();
          break;
        case 'exportDefault':
          exportManagerModule.exportTrimmedVideo();
          break;
        case 'fullscreen':
          videoPlayerModule.toggleFullscreen();
          break;
        case 'deleteClip':
          clipGridModule.confirmAndDeleteClip();
          break;
        case 'setTrimStart':
          videoPlayerModule.setTrimPoint('start');
          break;
        case 'setTrimEnd':
          videoPlayerModule.setTrimPoint('end');
          break;
        case 'focusTitle':
          clipTitle.focus();
          break;
        default:
          // Unknown action - do nothing
          break;
      }
    } else {
      // Handle actions when player is NOT active (grid view mode)
      // Enable grid navigation if not already enabled
      if (!state.gridNavigationEnabled) {
        clipGridModule.enableGridNavigation();
      }
      
      switch (action) {
        case 'playPause':
          // In grid view, play/pause opens the selected clip
          clipGridModule.openCurrentGridSelection();
          break;
        case 'skipBackward':
          // Left arrow - navigate left in grid
          gridNavigationModule.moveGridSelection('left');
          break;
        case 'skipForward':
          // Right arrow - navigate right in grid
          gridNavigationModule.moveGridSelection('right');
          break;
        case 'volumeUp':
          // Up arrow - navigate up in grid
          gridNavigationModule.moveGridSelection('up');
          break;
        case 'volumeDown':
          // Down arrow - navigate down in grid
          gridNavigationModule.moveGridSelection('down');
          break;
        case 'closePlayer':
          // Escape - disable grid navigation
          clipGridModule.disableGridNavigation();
          break;
        case 'exportDefault':
          // 'e' key - open selected clip
          clipGridModule.openCurrentGridSelection();
          break;
        default:
          // Other actions are ignored in grid view
          break;
      }
    }
  }
}

async function updateClipDisplay(originalName) {
  return
}

let saveTitleTimeout = null;

async function saveTitleChange(originalName, oldCustomName, newCustomName, immediate = false) {
  if (saveTitleTimeout) {
    clearTimeout(saveTitleTimeout);
  }

  const saveOperation = async () => {
    if (newCustomName === oldCustomName) return;

    try {
      const result = await ipcRenderer.invoke(
        "save-custom-name",
        originalName,
        newCustomName
      );
      if (result.success) {
        clipGridModule.updateClipNameInLibrary(originalName, newCustomName);
        logger.info(`Title successfully changed to: ${newCustomName}`);
        
        // Update the state.currentClip object
        if (state.currentClip && state.currentClip.originalName === originalName) {
          state.currentClip.customName = newCustomName;
        }
        
        // Update the clip in state.allClips array
        const clipIndex = state.allClips.findIndex(clip => clip.originalName === originalName);
        if (clipIndex !== -1) {
          state.allClips[clipIndex].customName = newCustomName;
        }

        // Update the clip element in the grid
        const clipElement = document.querySelector(`.clip-item[data-original-name="${originalName}"]`);
        if (clipElement) {
          const clipNameElement = clipElement.querySelector('.clip-name');
          if (clipNameElement) {
            clipNameElement.textContent = newCustomName;
          }
        }
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      logger.error("Error saving custom name:", error);
      await showCustomAlert(
        `Failed to save custom name. Please try again later. Error: ${error.message}`
      );
      // Revert to the original name in the grid
      const clipElement = document.querySelector(`.clip-item[data-original-name="${originalName}"]`);
      if (clipElement) {
        const clipNameElement = clipElement.querySelector('.clip-name');
        if (clipNameElement) {
          clipNameElement.textContent = oldCustomName;
        }
      }
    }
  };

  if (immediate) {
    await saveOperation();
  } else {
    saveTitleTimeout = setTimeout(saveOperation, 500); // 500ms debounce
  }
}


clipTitle.addEventListener("focus", () => {
  isRenamingActive = true;
});

clipTitle.addEventListener("blur", () => {
  isRenamingActive = false;
  saveTitleChange();
});

clipTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clipTitle.blur();
  }
});


function showCustomAlert(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-modal");
    const modalMessage = document.getElementById("modal-message");
    const modalOk = document.getElementById("modal-ok");
    const modalCancel = document.getElementById("modal-cancel");

    modalMessage.textContent = message;
    modalCancel.style.display = "none";
    modal.style.display = "block";

    modalOk.onclick = () => {
      modal.style.display = "none";
      resolve();
    };
  });
}

function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-modal");
    const modalMessage = document.getElementById("modal-message");
    const modalOk = document.getElementById("modal-ok");
    const modalCancel = document.getElementById("modal-cancel");

    modalMessage.textContent = message;
    modalCancel.style.display = "inline-block";
    modal.style.display = "block";

    modalOk.onclick = () => {
      modal.style.display = "none";
      resolve(true);
    };

    modalCancel.onclick = () => {
      modal.style.display = "none";
      resolve(false);
    };
  });
}


const debouncedFilterClips = videoPlayerModule.debounce((filter) => {
  logger.info("Filtering clips with filter:", filter);
  logger.info("state.allClips length before filtering:", state.allClips.length);
  
  let filteredClips = [...state.allClips];

  if (filter === "all") {
    filteredClips = filteredClips.filter(clip => !clip.tags.includes("Private"));
  } else if (filter === "Private") {
    filteredClips = filteredClips.filter(clip => clip.tags.includes("Private"));
  } else {
    filteredClips = filteredClips.filter(clip => 
      clip.tags.includes(filter) && !clip.tags.includes("Private")
    );
  }

  filteredClips = removeDuplicates(filteredClips);
  filteredClips.sort((a, b) => b.createdAt - a.createdAt);

  logger.info("Filtered clips length:", filteredClips.length);

  state.currentClipList = filteredClips;
  clipGridModule.renderClips(state.currentClipList);

  if (state.currentClip) {
    updateNavigationButtons();
  }

  validateClipLists();
  updateClipCounter(filteredClips.length);
  updateDiscordPresence('Browsing clips', `Filter: ${filter}, Total: ${state.currentClipList.length}`);
}, 300);  // 300ms debounce time

function filterClips() {
  if (state.selectedTags.size === 0) {
    state.currentClipList = [];
  } else {
    state.currentClipList = state.allClips.filter(clip => {
      // Check if clip is unnamed
      const baseFileName = clip.originalName.replace(/\.[^/.]+$/, '');
      const isUnnamed = clip.customName === baseFileName;
      
      // Check if clip is untagged
      const isUntagged = !clip.tags || clip.tags.length === 0;

      // Handle system tag filtering
      let matchesSystemTag = false;
      
      // Handle untagged clips
      if (state.selectedTags.has('Untagged') && isUntagged) {
        matchesSystemTag = true;
      }

      // Handle unnamed clips
      if (state.selectedTags.has('Unnamed') && isUnnamed) {
        matchesSystemTag = true;
      }

      // If clip is untagged and "Untagged" is not selected, exclude it
      if (isUntagged && !state.selectedTags.has('Untagged')) {
        return false;
      }

      // If clip is unnamed and "Unnamed" is not selected, exclude it
      if (isUnnamed && !state.selectedTags.has('Unnamed')) {
        return false;
      }

      // If it matches a system tag, show it
      if (matchesSystemTag) {
        return true;
      }

      // For clips with tags, check regular tag filtering
      if (clip.tags && clip.tags.length > 0) {
        if (state.isInTemporaryMode) {
          // In temporary mode (focus mode), show clips that have ANY of the temporary selected tags
          return clip.tags.some(tag => state.temporaryTagSelections.has(tag));
        } else {
          // In normal mode, clips must have ALL their tags selected to be shown
          return clip.tags.every(tag => state.selectedTags.has(tag));
        }
      }

      return false;
    });
  }
  
  state.currentClipList = removeDuplicates(state.currentClipList);
  clipGridModule.renderClips(state.currentClipList);
  updateClipCounter(state.currentClipList.length);
}

// Helper function to remove duplicates
function removeDuplicates(clips) {
  const seen = new Map();
  return clips.filter(clip => {
    const key = clip.originalName;
    return !seen.has(key) && seen.set(key, true);
  });
}




function updateDiscordPresenceBasedOnState() {
  if (state.currentClip) {
    updateDiscordPresenceForClip(state.currentClip, !videoPlayer.paused);
  } else {
    const publicClipCount = state.currentClipList.filter(clip => !clip.tags.includes('Private')).length;
    updateDiscordPresence('Browsing clips', `Total: ${publicClipCount}`);
  }
}

function updateDiscordPresence(details, state = null) {
  if (state.settings && state.settings.enableDiscordRPC) {
    ipcRenderer.invoke('update-discord-presence', details, state);
  }
}

async function toggleDiscordRPC(enable) {
  await ipcRenderer.invoke('toggle-discord-rpc', enable);
  if (enable) {
    updateDiscordPresenceBasedOnState();
  }
}

document.addEventListener('mousemove', () => {
  state.lastActivityTime = Date.now();
});

document.addEventListener('keydown', () => {
  state.lastActivityTime = Date.now();
});

setInterval(() => {
  if (Date.now() - state.lastActivityTime > IDLE_TIMEOUT && !videoPlayer.playing) {
    ipcRenderer.invoke('clear-discord-presence');
  }
}, 60000); // Check every minute

ipcRenderer.on('check-activity-state', () => {
  if (Date.now() - state.lastActivityTime <= IDLE_TIMEOUT || videoPlayer.playing) {
    updateDiscordPresenceBasedOnState();
  }
});

function updateDiscordPresenceForClip(clip, isPlaying = true) {
  if (state.settings && state.settings.enableDiscordRPC) {
    clearInterval(state.discordPresenceInterval);
    
    if (clip.tags && clip.tags.includes('Private')) {
      logger.info('Private clip detected. Clearing presence');
      updateDiscordPresence('Download Clip Library now!', '');
    } else {
      if (isPlaying) {
        state.clipStartTime = Date.now() - (state.elapsedTime * 1000);
      }
      
      const updatePresence = () => {
        if (isPlaying) {
          state.elapsedTime = Math.floor((Date.now() - state.clipStartTime) / 1000);
        }
        const totalDuration = Math.floor(videoPlayer.duration);
        const timeString = `${videoPlayerModule.formatTime(state.elapsedTime)}/${videoPlayerModule.formatTime(totalDuration)}`;
        updateDiscordPresence(`${clip.customName}`, `${timeString}`);
      };

      updatePresence(); // Initial update
      
      if (isPlaying) {
        state.discordPresenceInterval = setInterval(updatePresence, 1000); // Update every second
      }
    }
  }
}

// Update preview position and content
function updatePreview(e) {
  const rect = progressBarContainer.getBoundingClientRect();
  const position = (e.clientX - rect.left) / rect.width;
  const time = videoPlayer.duration * position;
  
  // Position directly based on cursor location within progress bar
  const cursorXRelative = e.clientX - rect.left;
  const previewWidth = previewElement.offsetWidth;
  
  previewElement.style.position = 'absolute';
  previewElement.style.left = `${cursorXRelative - (previewWidth/2)}px`;
  previewElement.style.bottom = '20px';
  
  // Update timestamp
  const previewTimestamp = document.getElementById('preview-timestamp');
  previewTimestamp.textContent = videoPlayerModule.formatTime(time);

  // Update video frame if ready
  if (tempVideo.readyState >= 2) {
    tempVideo.currentTime = time;
  }
}

// Use a more efficient throttling mechanism
let lastUpdateTime = 0;
const UPDATE_INTERVAL = 16; // About 60fps

progressBarContainer.addEventListener('mousemove', (e) => {
  // Add this check - if we're hovering over volume controls, don't show preview
  if (e.target.classList.contains('volume-start') || 
      e.target.classList.contains('volume-end') || 
      e.target.classList.contains('volume-region') ||
      e.target.classList.contains('volume-drag-control') ||
      e.target.parentElement?.classList.contains('volume-drag-control')) {
    return;
  }
  
  const now = performance.now();
  
  // Just show the preview initially
  previewElement.style.display = 'block';
  
  // Only update position and content when throttle interval has passed
  if (now - lastUpdateTime >= UPDATE_INTERVAL) {
    lastUpdateTime = now;
    updatePreview(e);
  }
});

// Optimize the seeked event handler
tempVideo.addEventListener('seeked', () => {
  const previewCanvas = document.getElementById('preview-canvas');
  const ctx = previewCanvas?.getContext('2d');
  if (ctx && tempVideo.readyState >= 2) {
    ctx.drawImage(tempVideo, 0, 0, previewCanvas.width, previewCanvas.height);
  }
});

// Add this function after tempVideo creation
async function initializePreviewVideo(videoSource) {
  return new Promise((resolve) => {
    tempVideo.src = videoSource;
    tempVideo.addEventListener('loadedmetadata', () => {
      const previewCanvas = document.getElementById('preview-canvas');
      if (previewCanvas) {
        previewCanvas.width = 160;  // Set fixed preview width
        previewCanvas.height = 90;  // Set fixed preview height
      }
      resolve();
    }, { once: true });
  });
}

// Modify the video player's loadedmetadata event handler
videoPlayer.addEventListener('loadedmetadata', async () => {
  await initializePreviewVideo(videoPlayer.src);
  // Hide preview by default when loading a new video
  previewElement.style.display = 'none';
});

// Add this after the mousemove event listener for progressBarContainer
progressBarContainer.addEventListener('mouseleave', () => {
  const previewElement = document.getElementById('timeline-preview');
  if (previewElement) {
    previewElement.style.display = 'none';
  }
  // Reset temp video
  tempVideo.currentTime = 0;
});

const selectionActions = document.createElement('div');
selectionActions.id = 'selection-actions';
selectionActions.classList.add('hidden');
selectionActions.innerHTML = `
  <span id="selection-count"></span>
  <button id="delete-selected" class="action-button">Delete Selected</button>
  <button id="clear-selection" class="action-button">Clear Selection</button>
`;
document.body.appendChild(selectionActions);

let lastSelectedClip = null;

function handleClipSelection(clipItem, event) {
  // Get all visible clip items
  const clipItems = Array.from(document.querySelectorAll('.clip-item:not([style*="display: none"])'));
  const currentIndex = clipItems.indexOf(clipItem);

  if (event.shiftKey && lastSelectedClip) {
    // Get index of last selected clip
    const lastSelectedIndex = clipItems.indexOf(lastSelectedClip);
    
    if (currentIndex >= 0 && lastSelectedIndex >= 0) {
      // Clear existing selection
      clearSelection(false); // Don't reset lastSelectedClip
      
      // Select all clips between last selected and current
      const [start, end] = [lastSelectedIndex, currentIndex].sort((a, b) => a - b);
      
      for (let i = start; i <= end; i++) {
        if (i >= 0 && i < clipItems.length) {
          const clip = clipItems[i];
          if (isClipSelectable(clip)) {
            state.selectedClips.add(clip.dataset.originalName);
            clip.classList.add('selected');
          }
        }
      }
    }
  } else {
    // Single selection with Ctrl/Cmd
    if (currentIndex >= 0) {
      const originalName = clipItem.dataset.originalName;
      
      if (!event.ctrlKey && !event.metaKey) {
        // Clear other selections if not using Ctrl/Cmd
        clearSelection(false);
      }
      
      if (state.selectedClips.has(originalName) && (event.ctrlKey || event.metaKey)) {
        // Deselect if already selected and using Ctrl/Cmd
        state.selectedClips.delete(originalName);
        clipItem.classList.remove('selected');
        
        // Update lastSelectedClip to the previous selected clip if exists
        const selectedElements = Array.from(document.querySelectorAll('.clip-item.selected'));
        lastSelectedClip = selectedElements[selectedElements.length - 1] || null;
      } else {
        // Select the clip
        state.selectedClips.add(originalName);
        clipItem.classList.add('selected');
        lastSelectedClip = clipItem;
      }
    }
  }

  updateSelectionUI();
}

// Modified clear selection to optionally preserve lastSelectedClip
function clearSelection(resetLastSelected = true) {
  document.querySelectorAll('.clip-item.selected').forEach(clip => {
    clip.classList.remove('selected');
  });
  state.selectedClips.clear();
  if (resetLastSelected) {
    lastSelectedClip = null;
  }
  updateSelectionUI();
}

// Helper function to check if a clip is selectable
function isClipSelectable(clip) {
  return clip && 
         clip.dataset && 
         clip.dataset.originalName && 
         !clip.classList.contains('deleting') && 
         !clip.classList.contains('video-preview-disabled');
}

// Add this to your document event listeners
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    clearSelection(true); // Reset lastSelectedClip when using Escape
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.isInTemporaryMode) {
    tagManagerModule.exitTemporaryMode();
    tagManagerModule.updateTagSelectionUI();
    filterClips();
  }
});

function updateSelectionUI() {
  const selectionActions = document.getElementById('selection-actions');
  const selectionCount = document.getElementById('selection-count');

  if (state.selectedClips.size > 0) {
    selectionActions.classList.remove('hidden');
    selectionCount.textContent = `${state.selectedClips.size} clip${state.selectedClips.size !== 1 ? 's' : ''} selected`;
  } else {
    selectionActions.classList.add('hidden');
  }
}

function clearSelection() {
  document.querySelectorAll('.clip-item.selected').forEach(clip => {
    clip.classList.remove('selected');
  });
  state.selectedClips.clear();
  state.selectionStartIndex = -1;
  updateSelectionUI();
}

// Add keyboard handler for Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selectedClips.size > 0) {
    clearSelection();
  }
});

async function deleteSelectedClips() {
  if (state.selectedClips.size === 0) return;

  const isConfirmed = await showCustomConfirm(
    `Are you sure you want to delete ${state.selectedClips.size} clip${state.selectedClips.size !== 1 ? 's' : ''}? This action cannot be undone.`
  );

  if (!isConfirmed) return;

  const totalClips = state.selectedClips.size;
  let completed = 0;

  // Show initial progress
  showDeletionTooltip();

  try {
    const clipsToDelete = Array.from(state.selectedClips);
    
    for (const originalName of clipsToDelete) {
      const clipElement = document.querySelector(
        `.clip-item[data-original-name="${originalName}"]`
      );

      if (clipElement) {
        // Update group before removing the clip
        updateGroupAfterDeletion(clipElement);
        
        // Immediately add visual feedback
        disableVideoThumbnail(originalName);

        try {
          const result = await ipcRenderer.invoke('delete-clip', originalName);
          if (!result.success) {
            throw new Error(result.error);
          }

          // Remove from data structures
          const allClipsIndex = state.allClips.findIndex(clip => clip.originalName === originalName);
          const currentClipListIndex = state.currentClipList.findIndex(clip => clip.originalName === originalName);
          
          if (allClipsIndex > -1) state.allClips.splice(allClipsIndex, 1);
          if (currentClipListIndex > -1) state.currentClipList.splice(currentClipListIndex, 1);

          // Remove from UI
          clipElement.remove();
          
          completed++;
          updateDeletionProgress(completed, totalClips);
          
        } catch (error) {
          logger.error(`Error deleting clip ${originalName}:`, error);
          await showCustomAlert(`Failed to delete clip: ${error.message}`);
        }
      }
    }
  } finally {
    clearSelection();
    updateClipCounter(state.currentClipList.length);
    hideDeletionTooltip();
    
    // Update new clips indicators after bulk deletion
    updateNewClipsIndicators();
    
    // Save clip list immediately after bulk deletion
    try {
      await ipcRenderer.invoke('save-clip-list-immediately');
    } catch (error) {
      logger.error('Failed to save clip list after bulk deletion:', error);
    }
  }
}

// Update deletion tooltip to show progress
function updateDeletionProgress(completed, total) {
  state.deletionTooltip = document.querySelector('.deletion-tooltip');
  if (state.deletionTooltip) {
    state.deletionTooltip.textContent = `Deleting clips... ${completed}/${total}`;
  }
}

// Add event listeners for the action buttons
document.getElementById('delete-selected')?.addEventListener('click', deleteSelectedClips);
document.getElementById('clear-selection')?.addEventListener('click', clearSelection);

// Add these helper functions to renderer.js






async function updateVersionDisplay() {
  try {
    const version = await ipcRenderer.invoke('get-app-version');
    const versionElement = document.getElementById('app-version');
    if (versionElement) {
      versionElement.textContent = version;
    }
  } catch (error) {
    logger.error('Failed to get app version:', error);
  }
}

// Add this near the other ipcRenderer listeners
ipcRenderer.on('show-update-notification', (event, data) => {
  console.log('[UPDATE] show-update-notification received:', data);
  logger.info('[UPDATE] Received show-update-notification IPC message');
  
  try {
    // Validate incoming data
    if (!data || typeof data !== 'object') {
      logger.error('Invalid update notification data received:', data);
      console.error('[UPDATE] Invalid data:', data);
      return;
    }
    
    const { currentVersion, latestVersion, changelog } = data;
    
    logger.info(`Renderer received update notification: ${currentVersion} -> ${latestVersion}`);
    
    // Don't create duplicate notifications
    if (document.querySelector('.update-notification')) {
      logger.info('Update notification already exists, skipping');
      return;
    }
    
    const notification = document.createElement('div');
    notification.className = 'update-notification';
    notification.innerHTML = `
      <div class="update-notification-content">
        <span class="update-text">Update available (${latestVersion || 'unknown'})</span>
        <button class="update-close" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="changelog-container">
        <div class="changelog"></div>
      </div>
    `;

    // Parse and sanitize markdown (with fallbacks if libraries aren't loaded)
    const changelogContainer = notification.querySelector('.changelog');
    if (changelog) {
      try {
        if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
          const parsed = marked.parse(changelog);
          changelogContainer.innerHTML = DOMPurify.sanitize(parsed);
        } else {
          // Fallback: show raw text
          changelogContainer.textContent = changelog;
          logger.warn('marked or DOMPurify not available, showing raw changelog');
        }
      } catch (parseError) {
        logger.error('Error parsing changelog:', parseError);
        changelogContainer.textContent = changelog;
      }
    } else {
      changelogContainer.textContent = 'No release notes available';
    }
    
    document.body.appendChild(notification);
    logger.info('Update notification element added to DOM');
    console.log('[UPDATE] Notification element added to DOM:', notification);
    console.log('[UPDATE] Notification parent:', notification.parentElement);
    
    // Show notification with slight delay
    setTimeout(() => {
      notification.classList.add('show');
      logger.info('Update notification shown');
      console.log('[UPDATE] .show class added, notification should be visible');
      console.log('[UPDATE] Notification classList:', notification.className);
      console.log('[UPDATE] Notification computed style visibility:', window.getComputedStyle(notification).visibility);
    }, 100);

    // Add event listeners
    notification.querySelector('.update-close').addEventListener('click', (e) => {
      e.stopPropagation();
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
      logger.info('Update notification dismissed');
    });

    notification.querySelector('.update-notification-content').addEventListener('click', async (e) => {
      if (e.target.closest('.update-close')) return;
      
      const content = e.currentTarget;
      const updateText = content.querySelector('.update-text');
      const originalText = updateText.textContent;
      
      // Prevent multiple clicks
      if (content.classList.contains('downloading')) return;
      
      // Update text to show downloading state
      updateText.textContent = 'Downloading update...';
      
      // Add progress bar
      const progressBar = document.createElement('div');
      progressBar.className = 'download-progress';
      progressBar.innerHTML = '<div class="progress-fill"></div>';
      content.appendChild(progressBar);
      content.classList.add('downloading');
      
      // Progress handler
      const onProgress = (_, progress) => {
        const roundedProgress = Math.round(progress);
        progressBar.querySelector('.progress-fill').style.width = `${progress}%`;
        updateText.textContent = `Downloading update... ${roundedProgress}%`;
      };
      
      // Error handler
      const onError = (_, errorMessage) => {
        logger.error('Update download failed:', errorMessage);
        updateText.textContent = 'Download failed. Click to retry.';
        content.classList.remove('downloading');
        progressBar.remove();
        cleanup();
      };
      
      // Cleanup function
      const cleanup = () => {
        ipcRenderer.removeListener('download-progress', onProgress);
        ipcRenderer.removeListener('update-download-error', onError);
      };
      
      // Listen for progress updates and errors
      ipcRenderer.on('download-progress', onProgress);
      ipcRenderer.on('update-download-error', onError);
    
      try {
        // Start update
        await ipcRenderer.invoke('start-update');
      } catch (error) {
        logger.error('Update invocation failed:', error);
        updateText.textContent = 'Download failed. Click to retry.';
        content.classList.remove('downloading');
        progressBar.remove();
        cleanup();
      }
    });
  } catch (error) {
    logger.error('Error creating update notification:', error);
  }
});

// Test utility for update notification popup
window.updateNotificationTest = {
  show: (options = {}) => {
    const { 
      currentVersion = '1.0.0', 
      latestVersion = '2.0.0', 
      changelog = '## What\'s New\\n- Feature 1\\n- Feature 2\\n- Bug fixes' 
    } = options;
    
    // Remove existing notification if present
    const existing = document.querySelector('.update-notification');
    if (existing) existing.remove();
    
    // Trigger the show-update-notification event
    const event = new CustomEvent('test-update-notification');
    ipcRenderer.emit('show-update-notification', event, { currentVersion, latestVersion, changelog });
    
    console.log('Update notification shown. Click on it to simulate downloading.');
    return 'Update notification displayed';
  },
  
  simulateDownload: (durationMs = 5000) => {
    const notification = document.querySelector('.update-notification');
    if (!notification) {
      console.error('No update notification found. Call updateNotificationTest.show() first.');
      return;
    }
    
    const content = notification.querySelector('.update-notification-content');
    if (content.classList.contains('downloading')) {
      console.log('Already downloading');
      return;
    }
    
    const updateText = content.querySelector('.update-text');
    updateText.textContent = 'Downloading update...';
    
    // Add progress bar
    const progressBar = document.createElement('div');
    progressBar.className = 'download-progress';
    progressBar.innerHTML = '<div class="progress-fill"></div>';
    content.appendChild(progressBar);
    content.classList.add('downloading');
    
    // Simulate progress
    let progress = 0;
    const interval = setInterval(() => {
      progress += Math.random() * 15;
      if (progress >= 100) {
        progress = 100;
        clearInterval(interval);
        updateText.textContent = 'Download complete!';
        setTimeout(() => {
          notification.classList.remove('show');
          setTimeout(() => notification.remove(), 300);
        }, 1500);
      }
      progressBar.querySelector('.progress-fill').style.width = `${progress}%`;
      updateText.textContent = `Downloading update... ${Math.round(progress)}%`;
    }, durationMs / 10);
    
    console.log(`Simulating download over ${durationMs}ms`);
    return 'Download simulation started';
  },
  
  hide: () => {
    const notification = document.querySelector('.update-notification');
    if (notification) {
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
      return 'Update notification hidden';
    }
    return 'No notification to hide';
  }
};

window.loadingScreenTest = {
  show: () => {
    state.loadingScreen = document.getElementById('loading-screen');
    if (!state.loadingScreen) {
      // Create the loading screen if it doesn't exist
      const newLoadingScreen = document.createElement('div');
      newLoadingScreen.id = 'loading-screen';
      newLoadingScreen.innerHTML = `
        <div class="loading-content">
          <div class="logo-container">
            <img src="assets/title.png" alt="App Logo and Title" class="app-logo-title">
          </div>
        </div>
      `;
      document.body.appendChild(newLoadingScreen);
      
      // Force a reflow to ensure the animation starts
      newLoadingScreen.offsetHeight;
      
    } else {
      state.loadingScreen.style.display = 'flex';
      state.loadingScreen.style.opacity = '1';
    }
  },
  
  hide: () => {
    state.loadingScreen = document.getElementById('loading-screen');
    if (state.loadingScreen) {
      state.loadingScreen.style.opacity = '0';
      setTimeout(() => {
        state.loadingScreen.style.display = 'none';
      }, 1000);
    }
  },
  
  toggle: () => {
    state.loadingScreen = document.getElementById('loading-screen');
    if (state.loadingScreen && (state.loadingScreen.style.display === 'none' || state.loadingScreen.style.opacity === '0')) {
      window.loadingScreenTest.show();
    } else {
      window.loadingScreenTest.hide();
    }
  }
};

// Optional: Add keyboard shortcut for quick testing
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + Shift + L to toggle loading screen
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
    window.loadingScreenTest.toggle();
  }
});

function initializeVolumeControls() {
  // Create elements if they don't exist
  if (!state.volumeStartElement) {
    state.volumeStartElement = document.createElement('div');
    state.volumeStartElement.className = 'volume-start';
  }
  
  if (!state.volumeEndElement) {
    state.volumeEndElement = document.createElement('div');
    state.volumeEndElement.className = 'volume-end';
  }
  
  if (!state.volumeRegionElement) {
    state.volumeRegionElement = document.createElement('div');
    state.volumeRegionElement.className = 'volume-region';
  }

  if (!state.volumeDragControl) {
    state.volumeDragControl = document.createElement('div');
    state.volumeDragControl.className = 'volume-drag-control';
    const volumeInput = document.createElement('input');
    volumeInput.type = 'range';
    volumeInput.min = '0';
    volumeInput.max = '1';
    volumeInput.step = '0.1';
    volumeInput.value = '0';
    state.volumeDragControl.appendChild(volumeInput);
  }
  
  const progressBarContainer = document.getElementById('progress-bar-container');
  if (!progressBarContainer.contains(state.volumeStartElement)) {
    progressBarContainer.appendChild(state.volumeStartElement);
    progressBarContainer.appendChild(state.volumeEndElement);
    progressBarContainer.appendChild(state.volumeRegionElement);
    progressBarContainer.appendChild(state.volumeDragControl);
  }

  videoPlayerModule.hideVolumeControls();
  setupVolumeControlListeners();
}

const debouncedSaveVolumeLevel = videoPlayerModule.debounce(async () => {
  if (!state.currentClip || !state.isVolumeControlsVisible) return;
  
  const volumeData = {
    start: state.volumeStartTime,
    end: state.volumeEndTime,
    level: state.volumeLevel || 0
  };
  
  try {
    await ipcRenderer.invoke('save-volume-range', state.currentClip.originalName, volumeData);
    logger.info('Volume data saved with new level:', volumeData);
  } catch (error) {
    logger.error('Error saving volume data:', error);
  }
}, 300);

function setupVolumeControlListeners() {
  // Clean up existing listeners first
  state.volumeStartElement.removeEventListener('mousedown', handleVolumeStartDrag);
  state.volumeEndElement.removeEventListener('mousedown', handleVolumeEndDrag);
  document.removeEventListener('mousemove', handleVolumeDrag);
  document.removeEventListener('mouseup', videoPlayerModule.endVolumeDrag);

  function handleVolumeStartDrag(e) {
    if (e.button !== 0) return; // Only handle left mouse button
    e.stopPropagation();
    state.isVolumeDragging = 'start';
    showVolumeDragControl(e);
    document.addEventListener('mousemove', handleVolumeDrag);
    document.addEventListener('mouseup', videoPlayerModule.endVolumeDrag);
  }

  function handleVolumeEndDrag(e) {
    if (e.button !== 0) return; // Only handle left mouse button
    e.stopPropagation();
    state.isVolumeDragging = 'end';
    showVolumeDragControl(e);
    document.addEventListener('mousemove', handleVolumeDrag);
    document.addEventListener('mouseup', videoPlayerModule.endVolumeDrag);
  }

  state.volumeDragControl.querySelector('input').addEventListener('input', (e) => {
    e.stopPropagation();
    state.volumeLevel = parseFloat(e.target.value);
    debouncedSaveVolumeLevel();
  });

  state.volumeDragControl.querySelector('input').addEventListener('change', (e) => {
    e.stopPropagation();
    state.volumeLevel = parseFloat(e.target.value);
    // Force an immediate save
    debouncedSaveVolumeLevel.flush?.() || debouncedSaveVolumeLevel();
  });

  state.volumeStartElement.addEventListener('mousedown', handleVolumeStartDrag);
  state.volumeEndElement.addEventListener('mousedown', handleVolumeEndDrag);

  // Force cleanup if window loses focus
  window.addEventListener('blur', () => {
    if (state.isVolumeDragging) {
      videoPlayerModule.endVolumeDrag();
    }
  });
}

function handleVolumeDrag(e) {
  if (!state.isVolumeDragging) return;

  document.body.classList.add('dragging');

  const progressBarContainer = document.getElementById('progress-bar-container');
  const rect = progressBarContainer.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const timePosition = (x / rect.width) * videoPlayer.duration;

  if (state.isVolumeDragging === 'start') {
    state.volumeStartTime = Math.min(timePosition, state.volumeEndTime - 0.1);
  } else if (state.isVolumeDragging === 'end') {
    state.volumeEndTime = Math.max(timePosition, state.volumeStartTime + 0.1);
  }

  // Keep volume control visible and centered during drag
  updateVolumeControlsPosition();
  state.volumeDragControl.style.display = 'flex';
  
  // Ensure volume input stays visible
  const volumeInput = state.volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.style.display = 'block';
  }

  debouncedSaveVolumeData();
}

function showVolumeDragControl(e) {
  if (!state.isVolumeControlsVisible) return;

  const rect = progressBarContainer.getBoundingClientRect();
  state.volumeDragControl.style.display = 'flex';

  // If dragging, use event position
  if (e) {
    const x = e.clientX - rect.left;
    state.volumeDragControl.style.left = `${x}px`;
  } else {
    // Otherwise position in middle of volume range
    const startPercent = (state.volumeStartTime / videoPlayer.duration) * 100;
    const endPercent = (state.volumeEndTime / videoPlayer.duration) * 100;
    const middlePercent = (startPercent + endPercent) / 2;
    state.volumeDragControl.style.left = `${middlePercent}%`;
  }

  // Ensure input is visible and set to current level
  const volumeInput = state.volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.value = state.volumeLevel;
    volumeInput.style.display = 'block';
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.isVolumeDragging) {
    videoPlayerModule.endVolumeDrag();
  }
});

function updateVolumeControlsPosition() {
  if (!videoPlayer.duration || !state.isVolumeControlsVisible) return;

  const startPercent = (state.volumeStartTime / videoPlayer.duration) * 100;
  const endPercent = (state.volumeEndTime / videoPlayer.duration) * 100;

  state.volumeStartElement.style.left = `${startPercent}%`;
  state.volumeEndElement.style.left = `${endPercent}%`;
  state.volumeRegionElement.style.left = `${startPercent}%`;
  state.volumeRegionElement.style.width = `${endPercent - startPercent}%`;

  // Update volume drag control position
  if (state.volumeDragControl) {
    const middlePercent = (startPercent + endPercent) / 2;
    state.volumeDragControl.style.left = `${middlePercent}%`;
    state.volumeDragControl.style.display = 'flex';
  }
}

const debouncedSaveVolumeData = videoPlayerModule.debounce(async () => {
  if (!state.currentClip || !state.isVolumeControlsVisible) return;
  
  const volumeData = {
    start: state.volumeStartTime,
    end: state.volumeEndTime,
    level: state.volumeLevel || 0
  };
  
  try {
    logger.info('Saving volume data:', volumeData);
    await ipcRenderer.invoke('save-volume-range', state.currentClip.originalName, volumeData);
    logger.info('Volume data saved successfully');
  } catch (error) {
    logger.error('Error saving volume data:', error);
  }
}, 300); // 300ms debounce time

function saveVolumeData() {
  debouncedSaveVolumeData();
}

function showVolumeControls() {
  state.isVolumeControlsVisible = true;
  state.volumeStartElement.style.display = 'block';
  state.volumeEndElement.style.display = 'block';
  state.volumeRegionElement.style.display = 'block';
  updateVolumeControlsPosition();
  showVolumeDragControl();
}

function toggleVolumeControls() {
  if (!videoPlayer.duration) return;

  if (!state.isVolumeControlsVisible) {
    if (state.volumeStartTime === 0 && state.volumeEndTime === 0) {
      state.volumeStartTime = videoPlayer.duration / 3;
      state.volumeEndTime = (videoPlayer.duration / 3) * 2;
      state.volumeLevel = 0;
    }
    showVolumeControls();
  } else {
    videoPlayerModule.hideVolumeControls();
  }
}

// Add this to your video timeupdate event listener
videoPlayer.addEventListener('timeupdate', () => {
  if (!state.audioContext || !state.gainNode || !state.isVolumeControlsVisible) return;
  
  const currentVolume = volumeSlider.value;
  if (videoPlayer.currentTime >= state.volumeStartTime && videoPlayer.currentTime <= state.volumeEndTime) {
    state.gainNode.gain.setValueAtTime(state.volumeLevel * currentVolume, state.audioContext.currentTime);
  } else {
    state.gainNode.gain.setValueAtTime(currentVolume, state.audioContext.currentTime);
  }
});

document.addEventListener('keydown', (e) => {
  const isInputFocused = document.activeElement.tagName === 'INPUT' || 
                        document.activeElement.tagName === 'TEXTAREA' ||
                        document.activeElement.isContentEditable;
                        
  if (!isInputFocused && (e.key === 'v' || e.key === 'V')) {
    e.preventDefault();
    toggleVolumeControls();
  }
});

function smoothScrollToElement(element) {
  if (!element) {
    logger.warn('smoothScrollToElement called with no element');
    return;
  }

  logger.info('Attempting to scroll to element:', {
    elementExists: !!element,
    elementRect: element.getBoundingClientRect(),
    currentScroll: window.pageYOffset,
    windowHeight: window.innerHeight
  });

  // Try both approaches - first the native scrollIntoView
  try {
    element.scrollIntoView({ behavior: "smooth", block: "end", inline: "nearest" });
    logger.info('Used native scrollIntoView');
    return;
  } catch (error) {
    logger.error('Native scrollIntoView failed, falling back to custom implementation:', error);
  }
}


async function logCurrentWatchSession() {
  if (!currentSessionStartTime) {
    return; // No active session to log
  }

  // If the video was playing when the session ended, add the last active interval
  if (lastPlayTimestamp) {
    currentSessionActiveDuration += Date.now() - lastPlayTimestamp;
    lastPlayTimestamp = null; // Ensure it's reset
  }

  const durationSeconds = Math.round(currentSessionActiveDuration / 1000);

  // Only log if duration is meaningful (e.g., > 1 second)
  if (durationSeconds > 1 && state.currentClip) {
    try {
      await ipcRenderer.invoke('log-watch-session', {
        originalName: state.currentClip.originalName,
        customName: clipTitle.value, // Use current title value
        durationSeconds: durationSeconds,
      });
    } catch (error) {
      logger.error('Failed to log watch session:', error);
    }
  }

  // Reset session state
  currentSessionStartTime = null;
  currentSessionActiveDuration = 0;
  lastPlayTimestamp = null;
}

function applyIconGreyscale(enabled) {
  document.querySelectorAll('.game-icon').forEach(icon => {
    icon.classList.toggle('greyscale-icon', enabled);
  });
}

// inside DOMContentLoaded handler after state.settings loaded
tagManagerModule.loadGlobalTags();
applyIconGreyscale(state.settings?.iconGreyscale);

// ------------------ Keybinding (Shortcuts) Settings UI ------------------
if (!settingsModal.querySelector('.settings-tab[data-tab="shortcuts"]')) {
  // Create tab button
  const tabsContainer = settingsModal.querySelector('.settings-tabs');
  const shortcutsTab = document.createElement('div');
  shortcutsTab.className = 'settings-tab';
  shortcutsTab.dataset.tab = 'shortcuts';
  shortcutsTab.textContent = 'Shortcuts';
  tabsContainer.appendChild(shortcutsTab);

  // Create tab content skeleton
  const contentWrapper = settingsModal.querySelector('.settings-modal-content');
  const shortcutsContent = document.createElement('div');
  shortcutsContent.className = 'settings-tab-content';
  shortcutsContent.dataset.tab = 'shortcuts';
  shortcutsContent.innerHTML = `
    <div class="settings-group">
      <div id="keybinding-list" class="keybinding-list"></div>
      <p class="kb-hint">Click the key box, then press your new combination.</p>
      <div style="margin-top: 15px;">
        <button id="resetKeybindsBtn" class="settings-button settings-button-secondary">Reset to Defaults</button>
      </div>
    </div>`;

  // Insert before the footer so the save button stays at the bottom
  const footer = contentWrapper.querySelector('.settings-footer');
  contentWrapper.insertBefore(shortcutsContent, footer);
}

// Friendly labels for displaying actions
const ACTION_INFO = {
  playPause:             { t: 'Play / Pause',            d: 'Toggle video playback',                     i: 'play_arrow' },
  frameBackward:         { t: 'Frame Backward',          d: 'Step one frame back',                       i: 'keyboard_arrow_left' },
  frameForward:          { t: 'Frame Forward',           d: 'Step one frame forward',                    i: 'keyboard_arrow_right' },
  skipBackward:          { t: 'Skip Backward',           d: 'Jump back 3% of duration',                 i: 'replay' },
  skipForward:           { t: 'Skip Forward',            d: 'Jump forward 3% of duration',              i: 'forward_media' },
  navigatePrev:          { t: 'Previous Clip',           d: 'Open previous clip in list',               i: 'skip_previous' },
  navigateNext:          { t: 'Next Clip',               d: 'Open next clip in list',                   i: 'skip_next' },
  volumeUp:              { t: 'Volume Up',               d: 'Increase playback volume',                 i: 'volume_up' },
  volumeDown:            { t: 'Volume Down',             d: 'Decrease playback volume',                 i: 'volume_down' },
  exportDefault:         { t: 'Export Trimmed Video',    d: 'Export current trim to clipboard',         i: 'smart_display' },
  exportVideo:           { t: 'Export Video (file)',     d: 'Export full video to file',                i: 'video_file' },
  exportAudioFile:       { t: 'Export Audio (file)',     d: 'Export audio to file',                     i: 'audio_file' },
  exportAudioClipboard:  { t: 'Export Audio (clipboard)',d: 'Copy audio to clipboard',                  i: 'music_video' },
  fullscreen:            { t: 'Toggle Fullscreen',       d: 'Enter/exit fullscreen player',             i: 'fullscreen' },
  deleteClip:            { t: 'Delete Clip',             d: 'Delete current clip',                      i: 'delete' },
  setTrimStart:          { t: 'Set Trim Start',          d: 'Mark trim start at playhead',              i: 'line_start' },
  setTrimEnd:            { t: 'Set Trim End',            d: 'Mark trim end at playhead',                i: 'line_end' },
  focusTitle:            { t: 'Focus Title',             d: 'Begin editing title',                      i: 'edit' },
  closePlayer:           { t: 'Close Player',            d: 'Close the fullscreen player',              i: 'close' }
};

// Inject minimal CSS for prettier list
if (false && !document.getElementById('kb-style')) {
  const s = document.createElement('style');
  s.id = 'kb-style';
  s.textContent = `
    .keybinding-list{display:flex;flex-direction:column;gap:10px;margin-top:8px;}
    .kb-row{display:flex;justify-content:space-between;align-items:center;background:#1e1e1e;border:1px solid #333;padding:10px 14px;border-radius:6px;}
    .kb-info{display:flex;flex-direction:column;}
    .kb-label{font-size:14px;font-weight:600;color:#e8e8e8;}
    .kb-desc{font-size:12px;color:#9a9a9a;margin-top:2px;}
    .kb-box{min-width:120px;text-align:center;padding:6px 12px;background:#2b2b2b;color:#e8e8e8;border:1px solid #555;border-radius:4px;cursor:pointer;transition:background 0.2s;}
    .kb-box:hover{background:#353535;}
    .kb-box.editing{background:#444;color:#ffa726;border-color:#ffa726;}
  `;
  document.head.appendChild(s);
}

function buildCombo(ev){
  const parts=[]; if(ev.ctrlKey||ev.metaKey)parts.push('Ctrl'); if(ev.shiftKey)parts.push('Shift'); if(ev.altKey)parts.push('Alt'); let k=ev.key===' '? 'Space':(ev.key.length===1?ev.key.toUpperCase():ev.key); parts.push(k); return parts.join('+'); }

function populateKeybindingList(){
  const list=document.getElementById('keybinding-list'); if(!list) return; list.innerHTML=''; const bindings=require('./renderer/keybinding-manager').getAll();
  Object.entries(ACTION_INFO).forEach(([action,info])=>{ 
    const row=document.createElement('div'); row.className='kb-row'; 
    let displayBinding=bindings[action]||''; if(displayBinding){displayBinding=displayBinding.split('+').map(p=>p.length===1?p.toUpperCase():p).join('+');}
    row.innerHTML=`<div class="kb-info"><div class="kb-label"><span class="kb-icon material-symbols-rounded">${info.i}</span>${info.t}</div><div class="kb-desc">${info.d}</div></div><div class="kb-box" tabindex="0" data-action="${action}" id="kb-box-${action}">${displayBinding}</div>`; 
    list.appendChild(row);
  });
  list.querySelectorAll('.kb-box').forEach(box=>box.addEventListener('click', startKeyCapture));
}

let captureBox=null; let pressed=new Set(); let captureAction=null;
function startKeyCapture(e){
  captureBox=e.currentTarget; captureAction=captureBox.dataset.action; pressed.clear(); captureBox.classList.add('editing'); captureBox.textContent='Waiting for keys...';
  document.addEventListener('keydown', captureKey, true); document.addEventListener('keyup', releaseKey,true);
}

function captureKey(ev){ if(!captureBox) return; ev.preventDefault(); pressed.add(ev.code); const combo=buildCombo(ev); captureBox.textContent=combo; }

function releaseKey(ev){ if(!captureBox) return; pressed.delete(ev.code); if(pressed.size===0){ // all released
    const displayCombo=captureBox.textContent; 
    // Convert the combo to normalized form for storage (single letters as lowercase)
    const normalizedCombo = displayCombo.split('+').map(part => part.length === 1 ? part.toLowerCase() : part).join('+');
    require('./renderer/keybinding-manager').setKeybinding(captureAction, normalizedCombo); 

    captureBox.classList.remove('editing');
    document.removeEventListener('keydown', captureKey, true); document.removeEventListener('keyup', releaseKey, true); captureBox=null; captureAction=null; }
}

// Add reset keybinds button functionality
document.addEventListener('click', async (e) => {
  if (e.target.id === 'resetKeybindsBtn') {
    const confirmed = await showCustomConfirm('Reset all keyboard shortcuts to default values?');
    if (confirmed) {
      // Get default keybindings from settings-manager via IPC
      const defaultKeybindings = await ipcRenderer.invoke('get-default-keybindings');
      const keybindManager = require('./renderer/keybinding-manager');
      
      // Reset each keybinding
      for (const [action, defaultCombo] of Object.entries(defaultKeybindings)) {
        await keybindManager.setKeybinding(action, defaultCombo);
      }
      
      // Refresh the keybinding list display
      populateKeybindingList();
    }
  }
});

// After initial requires
if(document && document.fonts){
  document.fonts.load('24px "Material Symbols Rounded"').then(()=>{
    document.body.classList.add('icons-ready');
  }).catch(()=>{
    document.body.classList.add('icons-ready');
  });
}

// Secret Easter Egg - F6 toggle
document.addEventListener('keydown', (e) => {
  if (e.key === 'F6') {
    const overlay = document.getElementById('secret-overlay');
    if (overlay) {
      overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
    }
  }
});