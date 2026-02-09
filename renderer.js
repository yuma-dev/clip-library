// Imports
const { ipcRenderer } = require("electron");
const path = require("path");
const { Titlebar, TitlebarColor } = require("custom-electron-titlebar");
const logger = require('./utils/logger');
const consoleBuffer = require('./utils/console-log-buffer');
consoleBuffer.patchConsole();
const fs = require('fs').promises;

// Keybinding manager to centralise shortcuts
const keybinds = require('./renderer/keybinding-manager');
const keybindingUiModule = require('./renderer/keybinding-ui');

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
const debugToolsModule = require('./renderer/debug-tools');
const volumeRangeControlsModule = require('./renderer/volume-range-controls');

// Discord/diagnostics/update managers
const discordManagerModule = require('./renderer/discord-manager');
const diagnosticsManagerModule = require('./renderer/diagnostics-manager');
const updateManagerModule = require('./renderer/update-manager');
const shareManagerModule = require('./renderer/share-manager');

// Clip grid module
const clipGridModule = require('./renderer/clip-grid');

// Benchmark harness
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

// DOM references
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
const previewElement = document.getElementById('timeline-preview');

// UI blur manager (reference-counted)
const uiBlur = (() => {
  let count = 0;
  return {
    enable() {
      count += 1;
      if (count === 1) {
        document.body.classList.add('ui-blur');
      }
    },
    disable() {
      count = Math.max(0, count - 1);
      if (count === 0) {
        document.body.classList.add('ui-blur-exit');
        document.body.classList.remove('ui-blur');
        requestAnimationFrame(() => {
          document.body.classList.remove('ui-blur-exit');
        });
      }
    }
  };
})();
window.uiBlur = uiBlur;

// UI constants
const MAX_FRAME_RATE = 10;
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds
const volumeButton = document.getElementById("volume-button");
const volumeSlider = document.getElementById("volume-slider");
const volumeContainer = document.getElementById("volume-container");
const speedButton = document.getElementById("speed-button");
const speedSlider = document.getElementById("speed-slider");
const speedContainer = document.getElementById("speed-container");
const speedText = document.getElementById("speed-text");
const THUMBNAIL_RETRY_DELAY = 2000; // 2 seconds
const THUMBNAIL_INIT_DELAY = 1000; // 1 second delay before first validation

// Renderer-level state
let settingsModal = null;
let currentClipLocationSpan = null;
let newClipsInfo = { newClips: [], totalNewCount: 0 }; // Track new clips info
let currentSessionStartTime = null;
let currentSessionActiveDuration = 0;
let lastPlayTimestamp = null;
let lastSelectedClip = null;

// Preview state
let lastPreviewUpdateTime = 0;
const PREVIEW_UPDATE_INTERVAL = 100; // Throttle frame updates, not positioning
let previewHalfWidth = 0;
let previewNeedsMeasure = true;
let lastPreviewMoveTime = 0;
let lastPreviewMoveX = 0;
let previewFrameTimeout = null;
let lastPreviewEvent = null;
const PREVIEW_VELOCITY_THRESHOLD = 1.2; // px/ms (~1200 px/s)
const PREVIEW_IDLE_DELAY = 90; // ms after last move

// DOM scaffolding
previewElement.style.display = 'none';

// Create a temporary video element for previews
const tempVideo = document.createElement('video');
tempVideo.crossOrigin = 'anonymous';
tempVideo.preload = 'auto';
tempVideo.muted = true;
tempVideo.style.display = 'none'; // Hide the temp video
document.body.appendChild(tempVideo); // Add to DOM

const selectionActions = document.createElement('div');
selectionActions.id = 'selection-actions';
selectionActions.classList.add('hidden');
selectionActions.innerHTML = `
  <span id="selection-count"></span>
  <button id="delete-selected" class="action-button">Delete Selected</button>
  <button id="clear-selection" class="action-button">Clear Selection</button>
`;
document.body.appendChild(selectionActions);

// All state variables moved to renderer/state.js
// Access via state.getXxx() and state.setXxx() methods
// Cache helpers
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


// Settings modal

/**
 * Load the settings modal markup from templates/settings-modal.html
 * and wire the diagnostics controls once inserted.
 */
async function loadSettingsModalTemplate() {
  const templatePath = path.join(__dirname, 'templates', 'settings-modal.html');
  let templateHtml = '';

  try {
    templateHtml = await fs.readFile(templatePath, 'utf8');
  } catch (error) {
    logger.error('Failed to load settings modal template:', error);
    templateHtml = '<div class="settings-modal-content"></div>';
  }

  settingsModal = document.createElement('div');
  settingsModal.id = 'settingsModal';
  settingsModal.className = 'settings-modal';
  settingsModal.innerHTML = templateHtml;

  const container = document.querySelector('.cet-container') || document.body;
  container.appendChild(settingsModal);

  currentClipLocationSpan = settingsModal.querySelector('#currentClipLocation');
  state.generateDiagnosticsBtn = settingsModal.querySelector('#generateDiagnosticsBtn');
  state.diagnosticsStatusEl = settingsModal.querySelector('#diagnosticsStatus');
  state.uploadLogsBtn = settingsModal.querySelector('#uploadLogsBtn');
  state.uploadLogsStatusEl = settingsModal.querySelector('#uploadLogsStatus');

  diagnosticsManagerModule.init({
    generateDiagnosticsBtn: state.generateDiagnosticsBtn,
    diagnosticsStatusEl: state.diagnosticsStatusEl,
    uploadLogsBtn: state.uploadLogsBtn,
    uploadLogsStatusEl: state.uploadLogsStatusEl
  });
}


/**
 * Load settings from disk and ensure defaults.
 */
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

/**
 * Fade out and hide the loading overlay.
 */
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

// IPC handlers
ipcRenderer.on('log', (event, { type, message }) => {
  console[type](`[Main Process] ${message}`);
});

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
  
  await clipGridModule.addNewClipToLibrary(fileName);
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

ipcRenderer.on("thumbnail-generation-failed", (event, { clipName, error }) => {
  logger.error(`Failed to generate thumbnail for ${clipName}: ${error}`);
});

ipcRenderer.on("thumbnail-generated", (event, { clipName, thumbnailPath }) => {
  // Update cache with newly generated thumbnail
  state.thumbnailPathCache.set(clipName, thumbnailPath);
  updateClipThumbnail(clipName, thumbnailPath);
});

/**
 * Show thumbnail generation progress for large batches.
 */
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

// Thumbnail generation status
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

// New clips indicators
/**
 * Reposition "new clips" divider indicators within each group.
 */
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
/**
 * Refresh new-clip indicators after list changes.
 */
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

// Window events
window.addEventListener('beforeunload', () => {
  if (window.thumbnailGenerationTimeout) {
    clearTimeout(window.thumbnailGenerationTimeout);
  }
  hideThumbnailGenerationText();
});

// Resize: preview + indicator layout
window.addEventListener('resize', () => {
  previewNeedsMeasure = true;
  updateIndicatorsOnChange();
});

// Dev helpers
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

/**
 * Trigger FFmpeg version lookup (for UI display).
 */
async function getFfmpegVersion() {
  try {
    await ipcRenderer.invoke('get-ffmpeg-version');
  } catch (error) {
    logger.error('Failed to get FFmpeg version:', error);
  }
}

/**
 * Replace a clip's thumbnail image after generation.
 */
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

// Time grouping helpers
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





// Export progress toast
const toast = document.getElementById('export-toast');
const content = toast.querySelector('.export-toast-content');
const progressText = toast.querySelector('.export-progress-text');
const title = toast.querySelector('.export-title');

/**
 * Update the export progress toast.
 */
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
  await loadSettingsModalTemplate();
  debugToolsModule.init({ state });
  keybindingUiModule.init({
    settingsModal,
    showCustomConfirm
  });

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
    previewElement: previewElement,
    tempVideo: tempVideo,
  }, {
    // Callbacks for module to trigger renderer.js functions
    logCurrentWatchSession: logCurrentWatchSession,
      initializeVolumeControls: null,
    getCachedClipData: getCachedClipData,
    getThumbnailPath: clipGridModule.getThumbnailPath,
    updateDiscordPresenceForClip: discordManagerModule.updateDiscordPresenceForClip,
    updateNavigationButtons: updateNavigationButtons,
    showCustomAlert: showCustomAlert,
    showExportProgress: showExportProgress,
    showCustomConfirm: showCustomConfirm,
    isBenchmarkMode: isBenchmarkMode,
    updateDiscordPresence: discordManagerModule.updateDiscordPresence,
    getActionFromEvent: keybinds.getActionFromEvent,
    navigateToVideo: navigateToVideo,
    exportAudioWithFileSelection: exportAudioWithFileSelection,
    exportVideoWithFileSelection: exportVideoWithFileSelection,
    exportAudioToClipboard: exportAudioToClipboard,
    exportDefault: exportManagerModule.exportTrimmedVideo,
    confirmAndDeleteClip: clipGridModule.confirmAndDeleteClip,
    enableGridNavigation: clipGridModule.enableGridNavigation,
    disableGridNavigation: clipGridModule.disableGridNavigation,
    openCurrentGridSelection: clipGridModule.openCurrentGridSelection,
    moveGridSelection: gridNavigationModule.moveGridSelection,
    saveTitleChange: saveTitleChange,
    clearSaveTitleTimeout: clearSaveTitleTimeout,
    removeClipTitleEditingListeners: removeClipTitleEditingListeners,
    updateClipDisplay: updateClipDisplay,
    smoothScrollToElement: smoothScrollToElement,
    getVisibleClips: clipGridModule.getVisibleClips
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

  // Initialize share manager (button + auth state + upload flow)
  shareManagerModule.init({
    showCustomAlert,
    getSharePayload: buildSharePayload
  });

  await shareManagerModule.refreshAuthState({ forceVerify: true });

  // Initialize settings manager with dependencies
  settingsManagerUiModule.init({
    videoPlayerModule: videoPlayerModule,
    searchManagerModule: searchManagerModule,
    fetchSettings: fetchSettings,
    updateSettingValue: updateSettingValue,
    toggleDiscordRPC: discordManagerModule.toggleDiscordRPC,
    applyIconGreyscale: applyIconGreyscale,
    renderClips: clipGridModule.renderClips,
    updateVersionDisplay: updateManagerModule.updateVersionDisplay,
    changeClipLocation: changeClipLocation,
    updateAllPreviewVolumes: updateAllPreviewVolumes,
    populateKeybindingList: keybindingUiModule.populateKeybindingList,
    shareManagerModule
  });

  discordManagerModule.init({
    videoPlayer: videoPlayer,
    videoPlayerModule: videoPlayerModule,
    idleTimeoutMs: IDLE_TIMEOUT
  });

  updateManagerModule.init();

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
    handleKeyPress: videoPlayerModule.handleKeyPress,
    handleKeyRelease: videoPlayerModule.handleKeyRelease,
    closePlayer: videoPlayerModule.closePlayer,
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
  await gamepadManagerModule.init({
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
    closePlayer: videoPlayerModule.closePlayer,
    enableGridNavigation: clipGridModule.enableGridNavigation,
    disableGridNavigation: clipGridModule.disableGridNavigation,
    openCurrentGridSelection: clipGridModule.openCurrentGridSelection,
    moveGridSelection: gridNavigationModule.moveGridSelection,
    clipGridModule,
    state
  });
  const settingsButton = document.getElementById("settingsButton");
  if (settingsButton) {
    settingsButton.addEventListener("click", settingsManagerUiModule.openSettingsModal);
  } else {
    logger.error("Settings button not found");
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
      closePlayer: videoPlayerModule.closePlayer,
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

  volumeRangeControlsModule.init({
    videoPlayer,
    progressBarContainer,
    volumeSlider,
    toggleVolumeControls: videoPlayerModule.toggleVolumeControls,
    showVolumeDragControl: videoPlayerModule.showVolumeDragControl,
    handleVolumeDrag: videoPlayerModule.handleVolumeDrag,
    endVolumeDrag: videoPlayerModule.endVolumeDrag,
    debounce: videoPlayerModule.debounce
  });

  setupContextMenu();
  tagManagerModule.loadGlobalTags();
  applyIconGreyscale(state.settings?.iconGreyscale);

  tagManagerModule.setFilterUpdateCallback(() => filterClips());

  // Create and setup the tag filter UI
  tagManagerModule.createTagFilterUI();
  // Load initial tag preferences
  await tagManagerModule.loadTagPreferences();

  discordManagerModule.updateDiscordPresence('Browsing clips', `Total clips: ${state.currentClipList.length}`);

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


// Settings modal UI
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

/**
 * Format a timestamp into a relative "time ago" string.
 */
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





// Player navigation / export
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
  videoPlayerModule.releaseVideoElement();
});

/**
 * Enable/disable prev/next buttons based on current clip index.
 */
function updateNavigationButtons() {
  const currentIndex = state.currentClipList.findIndex(clip => clip.originalName === state.currentClip.originalName);
  document.getElementById('prev-video').disabled = currentIndex <= 0;
  document.getElementById('next-video').disabled = currentIndex >= state.currentClipList.length - 1;
}


/**
 * Open the adjacent clip in the current list.
 */
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

// Deletion tooltip UI
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



async function buildSharePayload() {
  if (!state.currentClip) return null;

  const clipName = state.currentClip.originalName;
  const titleFromInput = (clipTitle?.value || '').trim();
  const title = titleFromInput || state.currentClip.customName || '';
  const tags = Array.isArray(state.currentClip.tags) ? state.currentClip.tags : [];

  let game = null;
  try {
    const gameInfo = await ipcRenderer.invoke('get-game-icon', clipName);
    if (gameInfo && typeof gameInfo.title === 'string' && gameInfo.title.trim()) {
      game = gameInfo.title.trim();
    }
  } catch (error) {
    logger.warn('Failed to fetch game metadata for sharing:', error);
  }

  const volume = await videoPlayerModule.loadVolume(clipName);
  const speed = videoPlayer.playbackRate;

  return {
    clipName,
    start: state.trimStartTime,
    end: state.trimEndTime,
    volume,
    speed,
    metadata: {
      title,
      tags,
      game
    }
  };
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

// Export progress IPC
ipcRenderer.on("export-progress", (event, progress) => {
  showExportProgress(progress, 100);
});

// Clip title editing
// Add this new function to handle overlay clicks
function handleOverlayClick(e) {
  if (e.target === playerOverlay && !window.justFinishedDragging) {
    videoPlayerModule.closePlayer();
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

function removeClipTitleEditingListeners() {
  clipTitle.removeEventListener("focus", clipTitleFocusHandler);
  clipTitle.removeEventListener("blur", clipTitleBlurHandler);
  clipTitle.removeEventListener("keydown", clipTitleKeydownHandler);
  clipTitle.removeEventListener("input", clipTitleInputHandler);
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
  discordManagerModule.updateDiscordPresence('Editing clip title', state.currentClip.customName);
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

// Make sure this event listener is present on the fullscreenPlayer
fullscreenPlayer.addEventListener("click", (e) => {
  e.stopPropagation();
});

playerOverlay.addEventListener("click", videoPlayerModule.closePlayer);
async function updateClipDisplay(originalName) {
  return
}

let saveTitleTimeout = null;

function clearSaveTitleTimeout() {
  if (saveTitleTimeout) {
    clearTimeout(saveTitleTimeout);
    saveTitleTimeout = null;
  }
}

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


/**
 * Show a simple alert modal.
 */
// Modal dialogs
function showCustomAlert(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-modal");
    const modalMessage = document.getElementById("modal-message");
    const modalOk = document.getElementById("modal-ok");
    const modalCancel = document.getElementById("modal-cancel");

    modalMessage.textContent = message;
    modalCancel.style.display = "none";
    modal.style.display = "block";
    if (window.uiBlur) window.uiBlur.enable();

    modalOk.onclick = () => {
      modal.style.display = "none";
      if (window.uiBlur) window.uiBlur.disable();
      resolve();
    };
  });
}

/**
 * Show a confirm modal and resolve to true/false.
 */
function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-modal");
    const modalMessage = document.getElementById("modal-message");
    const modalOk = document.getElementById("modal-ok");
    const modalCancel = document.getElementById("modal-cancel");

    modalMessage.textContent = message;
    modalCancel.style.display = "inline-block";
    modal.style.display = "block";
    if (window.uiBlur) window.uiBlur.enable();

    modalOk.onclick = () => {
      modal.style.display = "none";
      if (window.uiBlur) window.uiBlur.disable();
      resolve(true);
    };

    modalCancel.onclick = () => {
      modal.style.display = "none";
      if (window.uiBlur) window.uiBlur.disable();
      resolve(false);
    };
  });
}


// Clip filtering
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
  discordManagerModule.updateDiscordPresence('Browsing clips', `Filter: ${filter}, Total: ${state.currentClipList.length}`);
}, 300);  // 300ms debounce time

/**
 * Apply tag/temporary selection filters to build the visible list.
 */
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

/**
 * Remove duplicate clips by original name.
 */
function removeDuplicates(clips) {
  const seen = new Map();
  return clips.filter(clip => {
    const key = clip.originalName;
    return !seen.has(key) && seen.set(key, true);
  });
}




// Preview hover handling
progressBarContainer.addEventListener('mousemove', (e) => {
  // Add this check - if we're hovering over volume controls, don't show preview
  if (e.target.classList.contains('volume-start') || 
      e.target.classList.contains('volume-end') || 
      e.target.classList.contains('volume-region') ||
      e.target.classList.contains('volume-drag-control') ||
      e.target.parentElement?.classList.contains('volume-drag-control')) {
    return;
  }

  previewElement.style.display = 'block';
  if (!previewElement.style.willChange) {
    previewElement.style.willChange = 'transform';
  }

  if (previewNeedsMeasure) {
    const width = previewElement.offsetWidth;
    if (width > 0) {
      previewHalfWidth = width / 2;
      previewNeedsMeasure = false;
    }
  }

  // Position immediately for responsive hover (use transform to avoid layout churn)
  const rect = progressBarContainer.getBoundingClientRect();
  const cursorXRelative = e.clientX - rect.left;
  previewElement.style.position = 'absolute';
  previewElement.style.left = '0px';
  previewElement.style.bottom = '20px';
  previewElement.style.transform = `translate3d(${cursorXRelative - previewHalfWidth}px, 0, 0)`;

  // Throttle preview frame/time updates
  const now = performance.now();
  const deltaTime = now - lastPreviewMoveTime;
  const deltaX = Math.abs(e.clientX - lastPreviewMoveX);
  const velocity = deltaTime > 0 ? (deltaX / deltaTime) : 0;
  lastPreviewMoveTime = now;
  lastPreviewMoveX = e.clientX;
  lastPreviewEvent = { clientX: e.clientX };

  if (previewFrameTimeout) {
    clearTimeout(previewFrameTimeout);
  }
  previewFrameTimeout = setTimeout(() => {
    previewFrameTimeout = null;
    if (lastPreviewEvent) {
      lastPreviewUpdateTime = performance.now();
      videoPlayerModule.updatePreview(lastPreviewEvent, { skipPosition: true });
    }
  }, PREVIEW_IDLE_DELAY);

  if (now - lastPreviewUpdateTime >= PREVIEW_UPDATE_INTERVAL) {
    if (velocity <= PREVIEW_VELOCITY_THRESHOLD) {
      lastPreviewUpdateTime = now;
      videoPlayerModule.updatePreview(e, { skipPosition: true });
    }
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

/**
 * Prepare the hidden preview video and canvas sizing.
 */
async function initializePreviewVideo(videoSource) {
  return new Promise((resolve) => {
    tempVideo.src = videoSource;
    tempVideo.addEventListener('loadedmetadata', () => {
      const previewCanvas = document.getElementById('preview-canvas');
      if (previewCanvas) {
        previewCanvas.width = 160;
        previewCanvas.height = 90;
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
  if (previewFrameTimeout) {
    clearTimeout(previewFrameTimeout);
    previewFrameTimeout = null;
  }
  // Reset temp video
  tempVideo.currentTime = 0;
});

/**
 * Apply multi-select rules for a clip item click.
 */
// Selection helpers
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

/**
 * Clear current selection.
 * @param {boolean} resetLastSelected - Whether to reset the range anchor.
 */
function clearSelection(resetLastSelected = true) {
  document.querySelectorAll('.clip-item.selected').forEach(clip => {
    clip.classList.remove('selected');
  });
  state.selectedClips.clear();
  state.selectionStartIndex = -1;
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

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  clearSelection(true);
  if (state.isInTemporaryMode) {
    tagManagerModule.exitTemporaryMode();
    tagManagerModule.updateTagSelectionUI();
    filterClips();
  }
});

/**
 * Update the selection action bar UI.
 */
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

/**
 * Delete all currently selected clips with progress UI.
 */
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

/**
 * Smoothly scroll to the given element if possible.
 */
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


/**
 * Persist the current watch session duration for the active clip.
 */
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

/**
 * Toggle greyscale styling for game icons.
 */
function applyIconGreyscale(enabled) {
  document.querySelectorAll('.game-icon').forEach(icon => {
    icon.classList.toggle('greyscale-icon', enabled);
  });
}

// Startup side effects
// inside DOMContentLoaded handler after state.settings loaded
tagManagerModule.loadGlobalTags();
applyIconGreyscale(state.settings?.iconGreyscale);

// After initial requires
if (document && document.fonts) {
  document.fonts.load('24px "Material Symbols Rounded"').then(()=>{
    document.body.classList.add('icons-ready');
  }).catch(()=>{
    document.body.classList.add('icons-ready');
  });
}
