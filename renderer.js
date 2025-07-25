const { ipcRenderer } = require("electron");
const path = require("path");
const { Titlebar, TitlebarColor } = require("custom-electron-titlebar");
const logger = require('./logger');
const fs = require('fs').promises;

// Keybinding manager to centralise shortcuts
const keybinds = require('./keybinding-manager');

// Gamepad manager for controller support
const GamepadManager = require('./gamepad-manager');

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

let audioContext, gainNode;
let initialPlaybackTime = 0;
let lastActivityTime = Date.now();
let currentClipList = [];
let currentClip = null;
let trimStartTime = 0;
let trimEndTime = 0;
let isDragging = null;
let isDraggingTrim = false;
let dragStartX = 0;
let dragThreshold = 5; // pixels
let lastMousePosition = { x: 0, y: 0 };
let isMouseDown = false;
let clipLocation;
let isLoading = false;
let currentCleanup = null;
let allClips = [];
let contextMenuClip = null;
let isTagsDropdownOpen = false;
let isFrameStepping = false;
let frameStepDirection = 0;
let lastFrameStepTime = 0;
let pendingFrameStep = false;
let controlsTimeout;
let isMouseOverControls = false;
let isRendering = false;
let deletionTooltip = null;
let deletionTimeout = null;
let settings;
let discordPresenceInterval;
let clipStartTime;
let elapsedTime = 0;
let loadingScreen;
let processingTimeout = null;
let activePreview = null;
let previewCleanupTimeout = null;
let isGeneratingThumbnails = false;
let currentGenerationTotal = 0;
let completedThumbnails = 0;
let thumbnailGenerationStartTime = 0;
let selectedClips = new Set();
let selectionStartIndex = -1;
let selectedTags = new Set();
let volumeStartTime = 0;
let volumeEndTime = 0;
let volumeLevel = 0; // Volume level for the range
let isVolumeDragging = null;
let volumeStartElement = null;
let volumeEndElement = null;
let volumeRegionElement = null;
let volumeDragControl = null;
let isVolumeControlsVisible = false;
let savedTagSelections = new Set(); // Permanent selections that are saved
let temporaryTagSelections = new Set(); // Temporary (Ctrl+click) selections
let isInTemporaryMode = false; // Whether we're in temporary selection mode

// Variables for managing auto-seek behavior
let isAutoResetDisabled = false; // True when user manually seeked outside bounds

// Gamepad manager instance
let gamepadManager = null;
let wasLastSeekManual = false; // Track if the last seek was manual

// Grid navigation state
let currentGridFocusIndex = 0; // Currently selected clip index in the grid
let gridNavigationEnabled = false; // Whether grid navigation is active
let lastGridNavigationTime = 0; // Throttle grid navigation
const GRID_NAVIGATION_THROTTLE = 200; // 200ms between movements
let mouseKeyboardListenersSetup = false; // Track if we've set up mouse/keyboard listeners

// Grid navigation functions
function enableGridNavigation() {
  gridNavigationEnabled = true;
  currentGridFocusIndex = 0;
  updateGridSelection();
  setupMouseKeyboardDetection(); // Set up detection to hide on mouse/keyboard use
}

function disableGridNavigation() {
  gridNavigationEnabled = false;
  // Remove focus from all clips
  document.querySelectorAll('.clip-item').forEach(clip => {
    clip.classList.remove('controller-focused');
  });
  removeMouseKeyboardDetection(); // Clean up listeners when disabling
}

function getVisibleClips() {
  // Get all visible clip items (not display: none)
  return Array.from(document.querySelectorAll('.clip-item')).filter(clip => {
    const style = window.getComputedStyle(clip);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function updateGridSelection() {
  if (!gridNavigationEnabled) return;
  
  const visibleClips = getVisibleClips();
  if (visibleClips.length === 0) return;
  
  // Clamp the focus index to valid range
  currentGridFocusIndex = Math.max(0, Math.min(currentGridFocusIndex, visibleClips.length - 1));
  
  // Remove focus from all clips
  visibleClips.forEach(clip => {
    clip.classList.remove('controller-focused');
  });
  
  // Add focus to current clip
  if (visibleClips[currentGridFocusIndex]) {
    visibleClips[currentGridFocusIndex].classList.add('controller-focused');
    
    // Scroll to keep the focused clip visible
    visibleClips[currentGridFocusIndex].scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'nearest'
    });
  }
}

function moveGridSelection(direction) {
  if (!gridNavigationEnabled) return;
  
  // Throttle navigation to prevent spam
  const now = Date.now();
  if (now - lastGridNavigationTime < GRID_NAVIGATION_THROTTLE) {
    return;
  }
  lastGridNavigationTime = now;
  
  const visibleClips = getVisibleClips();
  if (visibleClips.length === 0) return;
  
  const currentClip = visibleClips[currentGridFocusIndex];
  if (!currentClip) return;
  
  let newIndex = currentGridFocusIndex;
  
  switch (direction) {
    case 'left':
      // Simple: move to previous clip
      if (currentGridFocusIndex > 0) {
        newIndex = currentGridFocusIndex - 1;
      }
      break;
      
    case 'right':
      // Simple: move to next clip
      if (currentGridFocusIndex < visibleClips.length - 1) {
        newIndex = currentGridFocusIndex + 1;
      }
      break;
      
    case 'up':
      // Find closest clip above
      newIndex = findClipInDirection(visibleClips, currentGridFocusIndex, 'up');
      break;
      
    case 'down':
      // Find closest clip below
      newIndex = findClipInDirection(visibleClips, currentGridFocusIndex, 'down');
      break;
  }
  
  if (newIndex !== currentGridFocusIndex && newIndex >= 0 && newIndex < visibleClips.length) {
    currentGridFocusIndex = newIndex;
    updateGridSelection();
  }
}

function findClipInDirection(visibleClips, currentIndex, direction) {
  const currentClip = visibleClips[currentIndex];
  if (!currentClip) return currentIndex;
  
  const currentRect = currentClip.getBoundingClientRect();
  const currentCenterX = currentRect.left + currentRect.width / 2;
  const currentCenterY = currentRect.top + currentRect.height / 2;
  
  let bestIndex = currentIndex;
  let bestDistance = Infinity;
  
  for (let i = 0; i < visibleClips.length; i++) {
    if (i === currentIndex) continue;
    
    const clipRect = visibleClips[i].getBoundingClientRect();
    const clipCenterX = clipRect.left + clipRect.width / 2;
    const clipCenterY = clipRect.top + clipRect.height / 2;
    
    let isValidDirection = false;
    let distance = 0;
    
    if (direction === 'up') {
      // Clip must be above current clip
      isValidDirection = clipCenterY < currentCenterY - 10; // 10px threshold
      if (isValidDirection) {
        // Prefer clips that are closer horizontally and vertically
        const horizontalDistance = Math.abs(clipCenterX - currentCenterX);
        const verticalDistance = Math.abs(clipCenterY - currentCenterY);
        distance = horizontalDistance * 0.5 + verticalDistance; // Weight vertical more
      }
    } else if (direction === 'down') {
      // Clip must be below current clip
      isValidDirection = clipCenterY > currentCenterY + 10; // 10px threshold
      if (isValidDirection) {
        const horizontalDistance = Math.abs(clipCenterX - currentCenterX);
        const verticalDistance = Math.abs(clipCenterY - currentCenterY);
        distance = horizontalDistance * 0.5 + verticalDistance; // Weight vertical more
      }
    }
    
    if (isValidDirection && distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  
  return bestIndex;
}

function openCurrentGridSelection() {
  if (!gridNavigationEnabled) return;
  
  const visibleClips = getVisibleClips();
  if (visibleClips.length === 0 || currentGridFocusIndex >= visibleClips.length) return;
  
  const selectedClip = visibleClips[currentGridFocusIndex];
  if (!selectedClip) return;
  
  const originalName = selectedClip.dataset.originalName;
  const customName = selectedClip.dataset.customName || originalName;
  
  if (originalName) {
    disableGridNavigation(); // Disable grid navigation when opening clip
    openClip(originalName, customName);
  }
}

// Mouse and keyboard detection to hide controller selection
function setupMouseKeyboardDetection() {
  if (mouseKeyboardListenersSetup) return; // Already set up
  
  // Mouse movement detection
  document.addEventListener('mousemove', hideControllerSelectionOnInput, { passive: true });
  
  // Mouse click detection
  document.addEventListener('mousedown', hideControllerSelectionOnInput, { passive: true });
  
  // Keyboard detection (but exclude controller-related keys in video player)
  document.addEventListener('keydown', hideControllerSelectionOnKeyboard, { passive: true });
  
  mouseKeyboardListenersSetup = true;
}

function removeMouseKeyboardDetection() {
  if (!mouseKeyboardListenersSetup) return;
  
  document.removeEventListener('mousemove', hideControllerSelectionOnInput);
  document.removeEventListener('mousedown', hideControllerSelectionOnInput);
  document.removeEventListener('keydown', hideControllerSelectionOnKeyboard);
  
  mouseKeyboardListenersSetup = false;
}

function hideControllerSelectionOnInput() {
  if (gridNavigationEnabled) {
    disableGridNavigation();
  }
}

function hideControllerSelectionOnKeyboard(e) {
  // Don't hide on controller-mapped keys or special keys
  const isPlayerActive = playerOverlay.style.display === "block";
  
  if (isPlayerActive) {
    // In video player, only hide on specific non-controller keys
    const allowedKeys = [
      'Tab', 'Enter', 'Escape', // Navigation keys
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', // Arrow keys
    ];
    
    // Hide if it's a letter/number key or other non-controller key
    if (!allowedKeys.includes(e.key) && 
        e.key.length === 1 && // Single character keys (letters, numbers)
        gridNavigationEnabled) {
      disableGridNavigation();
    }
  } else {
    // In grid view, hide on most keyboard input except controller actions
    const controllerKeys = [
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', // D-pad equivalent
    ];
    
    if (!controllerKeys.includes(e.key) && gridNavigationEnabled) {
      disableGridNavigation();
    }
  }
}

// Global function for resetting controls timeout (needed for fullscreen handlers)
function resetControlsTimeout() {
  if (typeof showControls === 'function') {
    showControls();
  }
  clearTimeout(controlsTimeout);
  if (videoPlayer && !videoPlayer.paused && !document.activeElement.closest('#video-controls')) {
    controlsTimeout = setTimeout(() => {
      if (typeof hideControls === 'function') {
        hideControls();
      }
    }, 3000);
  }
}

// Initialize gamepad manager with proper callbacks
async function initializeGamepadManager() {
  try {
    gamepadManager = new GamepadManager();
    
    // Get controller settings from main settings
    const appSettings = await ipcRenderer.invoke('get-settings');
    const controllerSettings = appSettings?.controller;
    
    if (controllerSettings) {
      // Apply custom mappings if they exist
      if (controllerSettings.buttonMappings) {
        Object.entries(controllerSettings.buttonMappings).forEach(([buttonIndex, action]) => {
          gamepadManager.setButtonMapping(parseInt(buttonIndex), action);
        });
      }
      
      // Apply sensitivity settings
      if (controllerSettings.seekSensitivity !== undefined) {
        gamepadManager.seekSensitivity = controllerSettings.seekSensitivity;
      }
      if (controllerSettings.volumeSensitivity !== undefined) {
        gamepadManager.volumeSensitivity = controllerSettings.volumeSensitivity;
      }
      
      // Enable/disable controller based on settings
      if (controllerSettings.enabled) {
        gamepadManager.enable();
      } else {
        gamepadManager.disable();
      }
    } else {
      // Default: enable controller support
      gamepadManager.enable();
    }
    
    // Set up action callback for button presses
    gamepadManager.setActionCallback((action) => {
      handleControllerAction(action);
    });
    
    // Set up navigation callback for analog sticks
    gamepadManager.setNavigationCallback((type, value) => {
      handleControllerNavigation(type, value);
    });
    
    // Set up raw navigation callback for grid scrolling
    gamepadManager.setRawNavigationCallback((type, value) => {
      handleControllerRawNavigation(type, value);
    });
    
    // Set up connection callback for UI updates
    gamepadManager.setConnectionCallback((connected, gamepadId) => {
      handleControllerConnection(connected, gamepadId);
    });
    
    logger.info('Gamepad manager initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize gamepad manager:', error);
  }
}

// Handle controller button actions
function handleControllerAction(action) {
  logger.info('Controller action:', action);
  
  // Check if we're in the video player
  const isPlayerActive = playerOverlay.style.display === "block";
  
  if (isPlayerActive) {
    // Use existing keyboard action handler for consistency
    const fakeEvent = {
      preventDefault: () => {},
      key: '', // We'll use the action directly
      code: ''
    };
    
    // Map the action to the existing switch case logic
    switch (action) {
      case 'closePlayer':
        // If in fullscreen, exit fullscreen first before closing player
        if (document.fullscreenElement) {
          try {
            if (document.exitFullscreen) {
              document.exitFullscreen();
            } else if (document.mozCancelFullScreen) {
              document.mozCancelFullScreen();
            } else if (document.webkitExitFullscreen) {
              document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) {
              document.msExitFullscreen();
            }
            // Small delay to let fullscreen exit complete before closing player
            setTimeout(() => {
              closePlayer();
            }, 100);
          } catch (error) {
            logger.error('Error exiting fullscreen before closing player:', error);
            closePlayer(); // Fallback to just closing
          }
        } else {
          closePlayer();
        }
        break;
      case 'playPause':
        if (videoPlayer.src) togglePlayPause();
        break;
      case 'frameBackward':
        moveFrame(-1);
        break;
      case 'frameForward':
        moveFrame(1);
        break;
      case 'navigatePrev':
        navigateToVideo(-1);
        break;
      case 'navigateNext':
        navigateToVideo(1);
        break;
      case 'skipBackward':
        skipTime(-1);
        break;
      case 'skipForward':
        skipTime(1);
        break;
      case 'volumeUp':
        changeVolume(0.1);
        break;
      case 'volumeDown':
        changeVolume(-0.1);
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
        exportTrimmedVideo();
        break;
      case 'fullscreen':
        toggleFullscreen();
        break;
      case 'deleteClip':
        confirmAndDeleteClip();
        break;
      case 'setTrimStart':
        setTrimPoint('start');
        break;
      case 'setTrimEnd':
        setTrimPoint('end');
        break;
      case 'focusTitle':
        clipTitle.focus();
        break;
      default:
        logger.warn('Unknown controller action:', action);
        break;
    }
  } else {
    // Handle actions when in grid view
    if (!gridNavigationEnabled) {
      enableGridNavigation();
    }
    
    switch (action) {
      case 'closePlayer':
        // Exit grid navigation or open settings
        if (gridNavigationEnabled) {
          disableGridNavigation();
        }
        break;
      case 'playPause':
        // Open the currently selected clip
        openCurrentGridSelection();
        break;
      case 'exportDefault':
        // Also open the currently selected clip (alternative action)
        openCurrentGridSelection();
        break;
      case 'volumeUp':
        // D-pad up - navigate up in grid
        moveGridSelection('up');
        break;
      case 'volumeDown':
        // D-pad down - navigate down in grid
        moveGridSelection('down');
        break;
      case 'skipBackward':
        // D-pad left - navigate left in grid
        moveGridSelection('left');
        break;
      case 'skipForward':
        // D-pad right - navigate right in grid
        moveGridSelection('right');
        break;
      default:
        // Silently ignore unhandled actions to reduce spam
        break;
    }
  }
}

// Handle controller navigation (analog sticks)
function handleControllerNavigation(type, value) {
  const isPlayerActive = playerOverlay.style.display === "block";
  
  if (isPlayerActive && videoPlayer) {
    switch (type) {
      case 'seek':
        // Right stick X - timeline seeking
        if (Math.abs(value) > 0.1) { // Minimum threshold
          const newTime = Math.max(0, Math.min(videoPlayer.currentTime + value, videoPlayer.duration));
          
          // If seeking outside bounds, disable auto-reset
          if (newTime < trimStartTime || newTime > trimEndTime) {
            isAutoResetDisabled = true;
          }
          
          videoPlayer.currentTime = newTime;
          showControls();
        }
        break;
        
      case 'volume':
        // Right stick Y - volume control
        if (Math.abs(value) > 0.05) { // Minimum threshold
          changeVolume(value);
        }
        break;
        
      case 'navigate':
        // Left stick - UI navigation in video player
        logger.info('Navigation direction:', value);
        break;
        
      default:
        logger.warn('Unknown navigation type:', type);
        break;
    }
  } else {
    // Handle navigation in grid view
    switch (type) {
      case 'navigate':
        // Left stick - grid navigation
        if (!gridNavigationEnabled) {
          enableGridNavigation();
        }
        moveGridSelection(value);
        break;
        
      default:
        // Other navigation types handled by raw navigation
        break;
    }
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
    if (gamepadManager && gamepadManager.getConnectedGamepads().length === 1) {
      logger.info(`Controller connected: ${gamepadId}`);
    }
    
    if (indicator) {
      indicator.style.display = 'flex';
      indicator.title = `Controller Connected: ${gamepadId}`;
    }
    
    // Enable grid navigation if we're not in video player and have clips
    // Only do this once to prevent multiple triggers
    const isPlayerActive = playerOverlay.style.display === "block";
    if (!isPlayerActive && getVisibleClips().length > 0 && !gridNavigationEnabled) {
      setTimeout(() => {
        enableGridNavigation();
      }, 500); // Small delay to let everything settle
    }
  } else {
    // Only log when all controllers are disconnected
    if (gamepadManager && !gamepadManager.isGamepadConnected()) {
      logger.info(`All controllers disconnected`);
    }
    
    if (indicator && gamepadManager && !gamepadManager.isGamepadConnected()) {
      // Only hide if no controllers are connected
      indicator.style.display = 'none';
      indicator.title = 'Controller Disconnected';
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

const settingsModal = document.createElement("div");
settingsModal.id = "settingsModal";
settingsModal.className = "settings-modal";
settingsModal.innerHTML = `
<div class="settings-modal-content">
    <div class="settings-tabs">
      <div class="settings-tab active" data-tab="general">General</div>
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

async function fetchSettings() {
  settings = await ipcRenderer.invoke('get-settings');
  logger.info('Fetched settings:', settings);  // Log the fetched settings
  
  // Set defaults if not present
  if (settings.previewVolume === undefined) settings.previewVolume = 0.1;
  if (settings.exportQuality === undefined) settings.exportQuality = 'discord';
  if (settings.iconGreyscale === undefined) settings.iconGreyscale = false;
  await ipcRenderer.invoke('save-settings', settings);
  logger.info('Settings after defaults:', settings);  // Log after setting defaults
  return settings;
}

let newClipsInfo = { newClips: [], totalNewCount: 0 }; // Track new clips info

async function loadClips() {
  try {
    logger.info("Loading clips...");
    clipLocation = await ipcRenderer.invoke("get-clip-location");
    currentClipLocationSpan.textContent = clipLocation;
    
    // Get new clips info before loading all clips
    newClipsInfo = await ipcRenderer.invoke("get-new-clips-info");
    logger.info("New clips info:", newClipsInfo);
    
    allClips = await ipcRenderer.invoke("get-clips");
    logger.info("Clips received:", allClips.length);
    
    // Mark which clips are new
    allClips.forEach(clip => {
      clip.isNewSinceLastSession = newClipsInfo.newClips.includes(clip.originalName);
    });
    
    // Load tags for each clip in smaller batches
    const TAG_BATCH_SIZE = 50;
    for (let i = 0; i < allClips.length; i += TAG_BATCH_SIZE) {
      const batch = allClips.slice(i, i + TAG_BATCH_SIZE);
      await Promise.all(batch.map(async (clip) => {
        clip.tags = await ipcRenderer.invoke("get-clip-tags", clip.originalName);
      }));
      
      // Small delay between tag batches
      if (i + TAG_BATCH_SIZE < allClips.length) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    allClips = removeDuplicates(allClips);
    allClips.sort((a, b) => b.createdAt - a.createdAt);

    // Restore any missing global tags from clip tags (e.g., after PC reset)
    try {
      const restoreResult = await ipcRenderer.invoke("restore-missing-global-tags");
      if (restoreResult.success && restoreResult.restoredCount > 0) {
        logger.info(`Restored ${restoreResult.restoredCount} missing global tags:`, restoreResult.restoredTags);
        // Reload global tags to include the newly restored ones
        await loadGlobalTags();
      }
    } catch (error) {
      logger.error("Error during tag restoration:", error);
    }

    await loadTagPreferences(); // This will set up selectedTags
    filterClips(); // This will set currentClipList correctly
    
    logger.info("Initial currentClipList length:", currentClipList.length);
    updateClipCounter(currentClipList.length);
    renderClips(currentClipList);
    setupClipTitleEditing();
    validateClipLists();
    updateFilterDropdown();

    logger.info("Clips loaded and rendered.");
    
    // Show new clips notification if there are any
      // New clips indicator will be shown inline with clips
  
  // Position indicators after rendering is complete
  setTimeout(() => {
    positionNewClipsIndicators();
  }, 100);
  
  // Save current clip list after initial load
  try {
    await ipcRenderer.invoke('save-clip-list-immediately');
  } catch (error) {
    logger.error('Failed to save clip list after initial load:', error);
  }
    
    hideLoadingScreen();

    // Start thumbnail validation after a short delay
    setTimeout(() => {
      startThumbnailValidation();
    }, 1000);

  } catch (error) {
    logger.error("Error loading clips:", error);
    clipGrid.innerHTML = `<p class="error-message">Error loading clips. Please check your clip location in settings.</p>`;
    currentClipLocationSpan.textContent = "Error: Unable to load location";
    hideThumbnailGenerationText();
    hideLoadingScreen();
  }
}

async function startThumbnailValidation() {
  logger.info("Starting thumbnail validation for clips:", allClips.length);
  
  await new Promise(resolve => setTimeout(resolve, THUMBNAIL_INIT_DELAY));
  
  try {
    let timeoutId;
    
    const createTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      
      return new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("Thumbnail generation timeout"));
        }, 30000);
      });
    };

    let currentTimeout = createTimeout();

    // Add this line to collect pending clips
    const pendingClips = new Set(allClips.map(clip => clip.originalName));

    const generationPromise = new Promise((resolve) => {
      ipcRenderer.invoke("generate-thumbnails-progressively", Array.from(pendingClips))
      .then((result) => {
        if (result.needsGeneration > 0) {
          showThumbnailGenerationText(result.needsGeneration);

          ipcRenderer.on("thumbnail-progress", (event, { current, total, clipName }) => {
            currentTimeout = createTimeout();
            if (isGeneratingThumbnails) {
              updateThumbnailGenerationText(total - current);
            }
            
            // Remove from pending set when processed
            pendingClips.delete(clipName);
            
            ipcRenderer.invoke("get-thumbnail-path", clipName).then(thumbnailPath => {
              if (thumbnailPath) {
                updateClipThumbnail(clipName, thumbnailPath);
              }
            });
          });

          ipcRenderer.once("thumbnail-generation-complete", () => {
            // Check if any clips were missed
            if (pendingClips.size > 0) {
              // Process any remaining clips
              ipcRenderer.invoke("generate-thumbnails-progressively", Array.from(pendingClips));
            }
            clearTimeout(timeoutId);
            hideThumbnailGenerationText();
            resolve(result);
          });
        } else {
          hideThumbnailGenerationText();
          resolve(result);
        }
      });
    });

    await Promise.race([generationPromise, currentTimeout]);

  } catch (error) {
    logger.error("Error during thumbnail validation:", error);
    hideThumbnailGenerationText();
    
    setTimeout(() => {
      startThumbnailValidation();
    }, THUMBNAIL_RETRY_DELAY);
  }
}

function hideLoadingScreen() {
  if (loadingScreen) {
    // Add the fade-out class to trigger the animations
    loadingScreen.classList.add('fade-out');
    
    // Remove the element after the animation completes
    setTimeout(() => {
      loadingScreen.style.display = 'none';
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

async function addNewClipToLibrary(fileName) {
  try {
    // First check if the file exists
    const clipPath = path.join(settings.clipLocation, fileName);
    try {
      await fs.access(clipPath);
    } catch (error) {
      logger.info(`File no longer exists, skipping: ${fileName}`);
      return;
    }

    const newClipInfo = await ipcRenderer.invoke('get-new-clip-info', fileName);
    
    // Mark as new since it's being added during runtime
    newClipInfo.isNewSinceLastSession = true;
    
    // Update the newClipsInfo to include this clip
    if (!newClipsInfo.newClips.includes(fileName)) {
      newClipsInfo.newClips.push(fileName);
      newClipsInfo.totalNewCount++;
    }
    
    // Check if the clip already exists in allClips
    const existingClipIndex = allClips.findIndex(clip => clip.originalName === newClipInfo.originalName);
    
    if (existingClipIndex === -1) {
      // If it doesn't exist, add it to allClips
      allClips.unshift(newClipInfo);
      
      // Create clip element with a loading thumbnail first
      const newClipElement = await createClipElement({
        ...newClipInfo,
        thumbnailPath: "assets/loading-thumbnail.gif"
      });

      // Find or create the appropriate time group
      const timeGroup = getTimeGroup(newClipInfo.createdAt);
      
      // First try to find an existing group by looking at the header text content
      let groupElement = Array.from(document.querySelectorAll('.clip-group'))
        .find(group => {
          const headerText = group.querySelector('.clip-group-header h2.clip-group-title')?.textContent.trim();
          return headerText?.startsWith(timeGroup);
        });
      let content;
      
      if (groupElement) {
        // Use existing group
        content = groupElement.querySelector('.clip-group-content');
        
        // Update clip count
        const countElement = groupElement.querySelector('.clip-group-count');
        const currentCount = parseInt(countElement.textContent);
        countElement.textContent = `${currentCount + 1} clip${currentCount + 1 !== 1 ? 's' : ''}`;
      } else {
        // Create new group if it doesn't exist
        groupElement = document.createElement('div');
        groupElement.className = 'clip-group';
        groupElement.dataset.groupName = timeGroup;
        
        // Create group header
        const header = document.createElement('div');
        header.className = 'clip-group-header';
        header.innerHTML = `
          <h2 class="clip-group-title">
            ${timeGroup}
            <span class="clip-group-count">1 clip</span>
          </h2>
          <div class="clip-group-divider"></div>
        `;

        // Add click handler for collapse/expand
        const collapsedState = loadCollapsedState();
        if (collapsedState[timeGroup]) {
          groupElement.classList.add('collapsed');
        }
        
        header.addEventListener('click', () => {
          groupElement.classList.toggle('collapsed');
          const newState = loadCollapsedState();
          newState[timeGroup] = groupElement.classList.contains('collapsed');
          saveCollapsedState(newState);
        });

        // Create group content
        content = document.createElement('div');
        content.className = 'clip-group-content';
        
        groupElement.appendChild(header);
        groupElement.appendChild(content);

        // Insert the group in the correct position
        const groups = Array.from(document.querySelectorAll('.clip-group'));
        const insertIndex = groups.findIndex(g => 
          getGroupOrder(g.dataset.groupName) > getGroupOrder(timeGroup)
        );

        if (insertIndex === -1) {
          clipGrid.appendChild(groupElement);
        } else {
          clipGrid.insertBefore(groupElement, groups[insertIndex]);
        }
      }

      // Add the new clip to the group content at the beginning
      content.insertBefore(newClipElement, content.firstChild);
      
      // Force a clean state for the new clip
      const clipElement = newClipElement;
      if (clipElement) {
        clipElement.dataset.trimStart = undefined;
        clipElement.dataset.trimEnd = undefined;
      }

      // Generate thumbnail in the background without waiting
      setTimeout(async () => {
        try {
          await ipcRenderer.invoke("generate-thumbnails-progressively", [fileName]);
        } catch (error) {
          logger.error("Error in background thumbnail generation:", error);
        }
      }, 1000); // Give a slight delay to ensure file is fully written

    } else {
      // If it exists, update the existing clip info
      allClips[existingClipIndex] = newClipInfo;
      const existingElement = document.querySelector(`[data-original-name="${newClipInfo.originalName}"]`);
      if (existingElement) {
        const updatedElement = await createClipElement(newClipInfo);
        existingElement.replaceWith(updatedElement);
      }
    }
    
    updateFilterDropdown();
    
    // Update new clips indicators after adding clip
    updateNewClipsIndicators();
    
    // Save clip list immediately after adding clip
    try {
      await ipcRenderer.invoke('save-clip-list-immediately');
    } catch (error) {
      logger.error('Failed to save clip list after adding clip:', error);
    }

  } catch (error) {
    // Only log as info if it's a file not found error, otherwise log as error
    if (error.code === 'ENOENT') {
      logger.info(`Skipping non-existent file: ${fileName}`);
    } else {
      logger.error("Error adding new clip to library:", error);
    }
  }
}

ipcRenderer.on('new-clip-added', async (event, fileName) => {
  // Wait for settings to be loaded if they haven't been yet
  if (!settings) {
    try {
      settings = await ipcRenderer.invoke('get-settings');
    } catch (error) {
      logger.error('Failed to load settings:', error);
      return;
    }
  }
  
  await addNewClipToLibrary(fileName);
  updateFilterDropdown();
});

ipcRenderer.on("thumbnail-validation-start", (event, { total }) => {
  // Always reset state when validation starts
  isGeneratingThumbnails = false;
  currentGenerationTotal = 0;
  completedThumbnails = 0;
  thumbnailGenerationStartTime = null;
  
  if (total > 0) {
    showThumbnailGenerationText(total);
  }
});

ipcRenderer.on("thumbnail-progress", (event, { current, total, clipName }) => {
  if (isGeneratingThumbnails) {
    updateThumbnailGenerationText(total - current);
  }
  logger.info(`Thumbnail generation progress: (${current}/${total}) - Processing: ${clipName}`);
});

ipcRenderer.on("thumbnail-generation-complete", () => {
  hideThumbnailGenerationText();
  isGeneratingThumbnails = false;
  // Clear any existing timeouts here as well
  if (window.thumbnailGenerationTimeout) {
    clearTimeout(window.thumbnailGenerationTimeout);
    window.thumbnailGenerationTimeout = null;
  }
});

function showThumbnailGenerationText(totalToGenerate) {
  if (totalToGenerate <= 12) return;
  
  // Reset all state variables
  isGeneratingThumbnails = true;
  currentGenerationTotal = totalToGenerate;
  completedThumbnails = 0;
  thumbnailGenerationStartTime = Date.now();
  
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
  if (!isGeneratingThumbnails) return;
  
  const textElement = document.getElementById("thumbnail-generation-text");
  if (!textElement) return;

  textElement.style.display = "block";
  
  if (remaining <= 0) {
    hideThumbnailGenerationText();
    return;
  }

  completedThumbnails = currentGenerationTotal - remaining;
  const percentage = Math.round((completedThumbnails / currentGenerationTotal) * 100);
  
  // Calculate time estimate based on actual progress
  let estimatedTimeRemaining = 0;
  if (completedThumbnails > 0) {
    const elapsedTime = (Date.now() - thumbnailGenerationStartTime) / 1000; // in seconds
    const averageTimePerThumbnail = elapsedTime / completedThumbnails;
    // Calculate remaining time and convert to minutes, rounding up
    estimatedTimeRemaining = Math.ceil((averageTimePerThumbnail * remaining) / 60);
    
    // Ensure we show at least 1 minute if there's any time remaining
    if (remaining > 0 && estimatedTimeRemaining === 0) {
      estimatedTimeRemaining = 1;
    }
  }

  textElement.textContent = `Generating thumbnails... ${completedThumbnails}/${currentGenerationTotal} (${percentage}%) - Est. ${estimatedTimeRemaining} min remaining`;
}

function hideThumbnailGenerationText() {
  const textElement = document.getElementById("thumbnail-generation-text");
  if (textElement) {
    textElement.remove();
  }
  isGeneratingThumbnails = false;
  currentGenerationTotal = 0;
  completedThumbnails = 0;
}

function positionNewClipsIndicators() {
  console.log('Positioning new clips indicators...');
  
  // Remove any existing positioned indicators first
  document.querySelectorAll('.new-clips-indicator.positioned').forEach(el => el.remove());
  
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
  // Check if we still have new clips visible
  if (currentClipList && currentClipList.length > 0) {
    const hasVisibleNewClips = currentClipList.some(clip => clip.isNewSinceLastSession);
    
    if (!hasVisibleNewClips) {
      // No new clips visible, remove all indicators
      document.querySelectorAll('.new-clips-indicator').forEach(el => el.remove());
      return;
    }
    
    // Re-render the current clips to update indicators
    renderClips(currentClipList);
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
  if (!allClips || allClips.length === 0) {
    console.log('No clips loaded yet');
    return;
  }
  
  if (count < 0 || count > allClips.length) {
    console.log(`Invalid count. Must be between 0 and ${allClips.length}`);
    return;
  }
  
  // Reset all clips to not new
  allClips.forEach(clip => {
    clip.isNewSinceLastSession = false;
  });
  
  // Mark the first 'count' clips as new
  for (let i = 0; i < count; i++) {
    allClips[i].isNewSinceLastSession = true;
  }
  
  // Update the global newClipsInfo
  newClipsInfo = {
    newClips: allClips.slice(0, count).map(clip => clip.originalName),
    totalNewCount: count
  };
  
  // Also update currentClipList if it exists
  if (currentClipList && currentClipList.length > 0) {
    currentClipList.forEach(clip => {
      clip.isNewSinceLastSession = allClips.find(ac => ac.originalName === clip.originalName)?.isNewSinceLastSession || false;
    });
  }
  
  // Re-render to show the changes
  if (currentClipList) {
    renderClips(currentClipList);
    
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
  console.log('Clips marked as new:', allClips.filter(clip => clip.isNewSinceLastSession).map(c => c.originalName));
  console.log('Total clips loaded:', allClips.length);
  console.log('Current filtered clips:', currentClipList.length);
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

async function renderClips(clips) {
  if (isRendering) {
    logger.info("Render already in progress, skipping");
    return;
  }
  
  isRendering = true;
  logger.info("Rendering clips. Input length:", clips.length);
  
  const clipGrid = document.getElementById('clip-grid');
  clipGrid.innerHTML = '';

  if (!clips || clips.length === 0) {
    clipGrid.innerHTML = '<div class="error-message">No clips found</div>';
    isRendering = false;
    return;
  }

  // Remove duplicates
  clips = removeDuplicates(clips);
  logger.info("Clips to render after removing duplicates:", clips.length);

  // Group clips by time period
  const groups = {};
  clips.forEach(clip => {
    const group = getTimeGroup(clip.createdAt);
    if (!groups[group]) groups[group] = [];
    groups[group].push(clip);
  });

  // Get collapsed state
  const collapsedState = loadCollapsedState();

  // Sort groups by time (most recent first)
  const sortedGroups = Object.entries(groups).sort((a, b) => 
    getGroupOrder(a[0]) - getGroupOrder(b[0])
  );

  // Find where new clips begin for visual indicator
  let newClipsStartIndex = -1;
  if (newClipsInfo.totalNewCount > 0) {
    newClipsStartIndex = clips.findIndex(clip => clip.isNewSinceLastSession);
  }
  
  // Debug logging
  console.log('Debug - New clips info:', newClipsInfo);
  console.log('Debug - newClipsStartIndex:', newClipsStartIndex);
  console.log('Debug - clips with new status:', clips.map(c => ({ name: c.originalName, isNew: c.isNewSinceLastSession })).slice(0, 10));

  // Create and append groups
  let hasAddedNewClipsIndicator = false;
  
  for (const [groupName, groupClips] of sortedGroups) {
    // Check if this group contains the first new clip
    const groupHasFirstNewClip = newClipsStartIndex >= 0 && 
      groupClips.some(clip => clip.isNewSinceLastSession) &&
      !groupClips.every(clip => clip.isNewSinceLastSession);
    
    // Check if this entire group consists of new clips and we haven't added indicator yet
    const groupIsAllNewClips = groupClips.every(clip => clip.isNewSinceLastSession) && groupClips.length > 0;
    
    // Debug logging for this group
    console.log(`Debug - Group "${groupName}":`, {
      groupIsAllNewClips,
      hasAddedNewClipsIndicator,
      totalNewCount: newClipsInfo.totalNewCount,
      groupClips: groupClips.map(c => ({ name: c.originalName, isNew: c.isNewSinceLastSession }))
    });
    
    // Add inter-group indicator if this is the first group of all new clips
    if (groupIsAllNewClips && !hasAddedNewClipsIndicator && newClipsInfo.totalNewCount > 0) {
      console.log('Debug - Adding inter-group indicator for:', groupName);
      const interGroupIndicator = document.createElement('div');
      interGroupIndicator.className = 'new-clips-indicator inter-group';
      interGroupIndicator.innerHTML = `
        <div class="new-clips-line"></div>
        <div class="new-clips-text">New clips since last session</div>
        <div class="new-clips-line"></div>
      `;
      clipGrid.appendChild(interGroupIndicator);
      hasAddedNewClipsIndicator = true;
    }
    
    const groupElement = document.createElement('div');
    groupElement.className = `clip-group ${collapsedState[groupName] ? 'collapsed' : ''}`;
    groupElement.dataset.loaded = collapsedState[groupName] ? 'false' : 'true';
    groupElement.dataset.groupName = groupName;
    
    // Create group header
    const header = document.createElement('div');
    header.className = 'clip-group-header';
    header.innerHTML = `
      <h2 class="clip-group-title">
        ${groupName}
        <span class="clip-group-count">${groupClips.length} clip${groupClips.length !== 1 ? 's' : ''}</span>
      </h2>
      <div class="clip-group-divider"></div>
    `;

    // Create group content
    const content = document.createElement('div');
    content.className = 'clip-group-content';
    
    // Only create clip elements if the group is not collapsed
    if (!collapsedState[groupName]) {
      // Create clip elements
      const clipElements = await Promise.all(groupClips.map(createClipElement));
      
      // Add clips to content with new clips indicator
      for (let i = 0; i < clipElements.length; i++) {
        const clipElement = clipElements[i];
        const clip = groupClips[i];
        
        // Mark this content area for later indicator positioning
        if (i > 0 && groupClips[i-1].isNewSinceLastSession && !clip.isNewSinceLastSession && !hasAddedNewClipsIndicator) {
          console.log('Debug - Will add indicator after clip:', groupClips[i-1].originalName, 'before clip:', clip.originalName);
          console.log('Debug - Setting data attributes on content for group');
          content.dataset.needsIndicator = 'true';
          content.dataset.lastNewIndex = i - 1;
          content.dataset.firstOldIndex = i;
          hasAddedNewClipsIndicator = true;
        }
        
        content.appendChild(clipElement);
      }
      
      // Check if we need an indicator at the end of the group (last clip is new, no more clips)
      if (!hasAddedNewClipsIndicator && groupClips.length > 0) {
        const lastClip = groupClips[groupClips.length - 1];
        if (lastClip.isNewSinceLastSession) {
          console.log('Debug - Adding end-of-group indicator after last new clip:', lastClip.originalName);
          content.dataset.needsIndicator = 'true';
          content.dataset.lastNewIndex = groupClips.length - 1;
          content.dataset.firstOldIndex = -1; // Special case: no next clip
          hasAddedNewClipsIndicator = true;
        }
      }
    } else {
      // Store the clip data for lazy loading
      groupElement.dataset.clips = JSON.stringify(groupClips.map(clip => ({
        originalName: clip.originalName,
        customName: clip.customName,
        createdAt: clip.createdAt,
        tags: clip.tags || []
      })));
    }

    // Add click handler for collapse/expand with lazy loading
    header.addEventListener('click', async () => {
      const isCollapsed = groupElement.classList.contains('collapsed');
      
      // Toggle collapsed state
      groupElement.classList.toggle('collapsed');
      collapsedState[groupName] = !isCollapsed;
      saveCollapsedState(collapsedState);
      
      // If we're expanding and the content isn't loaded yet, load it now
      if (isCollapsed && groupElement.dataset.loaded === 'false') {
        try {
          let groupClips;
          
          // Get the clips data from the dataset
          if (groupElement.dataset.clips) {
            groupClips = JSON.parse(groupElement.dataset.clips);
          } else {
            // Fallback to find clips in the current list if data not stored
            groupClips = currentClipList.filter(
              clip => getTimeGroup(clip.createdAt) === groupName
            );
          }
          
          // Show a loading indicator if there are many clips
          if (groupClips.length > 50) {
            const loadingIndicator = document.createElement('div');
            loadingIndicator.className = 'loading-indicator';
            loadingIndicator.innerHTML = `
              <div class="loading-spinner"></div>
              <div style="margin-top: 10px;">Loading ${groupClips.length} clips...</div>
            `;
            content.appendChild(loadingIndicator);
          }
          
          // Create clip elements in batches to avoid UI freezing
          const batchSize = 20;
          for (let i = 0; i < groupClips.length; i += batchSize) {
            const batch = groupClips.slice(i, i + batchSize);
            
            // Add a small delay between batches to allow UI to update
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            
            const clipElements = await Promise.all(batch.map(createClipElement));
            
            // Remove loading indicator if it exists
            if (i === 0 && groupClips.length > 50) {
              content.innerHTML = '';
            }
            
            // Add clips with new clips indicator logic (similar to main render)
            for (let j = 0; j < clipElements.length; j++) {
              const clipElement = clipElements[j];
              const clipIndex = i + j;
              const clip = batch[j];
              
              // Mark for indicator positioning in lazy-loaded content
              if (clipIndex > 0 && !groupClips[clipIndex-1].isNewSinceLastSession && clip.isNewSinceLastSession) {
                content.dataset.needsIndicator = 'true';
                content.dataset.lastNewIndex = clipIndex - 1;
                content.dataset.firstOldIndex = clipIndex;
              }
              
              content.appendChild(clipElement);
            }
          }
          
          // Mark as loaded
          groupElement.dataset.loaded = 'true';
          
          // Remove stored clip data to free memory
          delete groupElement.dataset.clips;
          
          // Add event listeners to the newly created clip elements
          content.querySelectorAll('.clip-item').forEach(card => {
            card.addEventListener('mouseenter', handleMouseEnter);
            card.addEventListener('mouseleave', handleMouseLeave);
          });
          
          setupTooltips();
          
          // Position indicators for lazy-loaded content
          setTimeout(() => {
            positionNewClipsIndicators();
          }, 50);
        } catch (error) {
          logger.error("Error loading clips for group:", error);
          content.innerHTML = '<div class="error-message">Error loading clips</div>';
        }
      } else if (!isCollapsed && groupElement.dataset.loaded === 'true') {
        // If we're collapsing, optionally cleanup resources
        // This could be enabled for very large groups to free more memory
        // when collapsed, but would require reloading clips when expanded again
        
        // Uncomment the following code to enable cleanup on collapse
        /*
        if (groupClips.length > 100) {
          // Cleanup existing elements
          const clipElements = content.querySelectorAll('.clip-item');
          clipElements.forEach(el => {
            if (typeof el.cleanup === 'function') {
              el.cleanup();
            }
          });
          
          // Clear the content
          content.innerHTML = '';
          
          // Store the clip data again for future loading
          const groupClips = currentClipList.filter(
            clip => getTimeGroup(clip.createdAt) === groupName
          );
          groupElement.dataset.clips = JSON.stringify(groupClips.map(clip => ({
            originalName: clip.originalName,
            customName: clip.customName,
            createdAt: clip.createdAt,
            tags: clip.tags || []
          })));
          
          // Mark as not loaded
          groupElement.dataset.loaded = 'false';
        }
        */
      }
    });

    groupElement.appendChild(header);
    groupElement.appendChild(content);
    clipGrid.appendChild(groupElement);
  }

  setupTooltips();
  currentClipList = clips;
  addHoverEffect();

  // Add mouse enter/leave handlers
  document.querySelectorAll('.clip-item').forEach(card => {
    card.addEventListener('mouseenter', handleMouseEnter);
    card.addEventListener('mouseleave', handleMouseLeave);
  });

  logger.info("Rendered clips count:", clips.length);
  
  // Setup grid navigation if controller is connected
  if (gamepadManager && gamepadManager.isGamepadConnected() && clips.length > 0) {
    setTimeout(() => {
      if (!gridNavigationEnabled) {
        enableGridNavigation();
      } else {
        updateGridSelection();
      }
    }, 100); // Small delay to ensure DOM is updated
  }
  
  isRendering = false;
}

let currentHoveredCard = null;

function handleOnMouseMove(e) {
  if (!currentHoveredCard) return;

  const rect = currentHoveredCard.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const centerX = rect.width / 2;
  const centerY = rect.height / 2;

  const tiltX = (y - centerY) / centerY;
  const tiltY = (centerX - x) / centerX;

  requestAnimationFrame(() => {
    if (currentHoveredCard) {
      currentHoveredCard.style.setProperty("--mouse-x", `${x}px`);
      currentHoveredCard.style.setProperty("--mouse-y", `${y}px`);
      currentHoveredCard.style.setProperty("--tilt-x", `${tiltX * 5}deg`);
      currentHoveredCard.style.setProperty("--tilt-y", `${tiltY * 5}deg`);
    }
  });
}

function handleMouseEnter(e) {
  currentHoveredCard = e.currentTarget;
}

function handleMouseLeave(e) {
  const card = e.currentTarget;
  card.style.setProperty("--tilt-x", "0deg");
  card.style.setProperty("--tilt-y", "0deg");
  currentHoveredCard = null;
}

function addHoverEffect() {
  const wrapper = document.getElementById("clip-grid");
  wrapper.addEventListener("mousemove", handleOnMouseMove);
}

function setupSearch() {
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", debounce(performSearch, 300));
}

function performSearch() {
  const searchDisplay = document.getElementById('search-display');
  if (!searchDisplay) return;

  const searchText = searchDisplay.innerText.trim().toLowerCase();
  const searchTerms = parseSearchTerms(searchText);
  
  // Start with all clips
  let filteredClips = [...allClips];
  
  // Apply search terms if they exist
  if (searchTerms.tags.length > 0 || searchTerms.text.length > 0) {
    filteredClips = filteredClips.filter(clip => {
      // Check tag matches
      const hasMatchingTags = searchTerms.tags.length === 0 || 
        searchTerms.tags.every(searchTag => 
          clip.tags.some(clipTag => 
            clipTag.toLowerCase().includes(searchTag.toLowerCase().substring(1))
          )
        );

      // Check text matches
      const hasMatchingText = searchTerms.text.length === 0 ||
        searchTerms.text.every(word =>
          clip.customName.toLowerCase().includes(word) ||
          clip.originalName.toLowerCase().includes(word)
        );

      return hasMatchingTags && hasMatchingText;
    });
  }
  
  // Apply tag filter from dropdown
  if (selectedTags.size > 0) {
    filteredClips = filteredClips.filter(clip => {
      if (selectedTags.has('Untagged')) {
        if (!clip.tags || clip.tags.length === 0) {
          return true;
        }
      }
      return clip.tags && clip.tags.some(tag => selectedTags.has(tag));
    });
  }

  // Remove duplicates
  currentClipList = filteredClips.filter((clip, index, self) =>
    index === self.findIndex((t) => t.originalName === clip.originalName)
  );

  // Sort by creation date
  currentClipList.sort((a, b) => b.createdAt - a.createdAt);

  renderClips(currentClipList);
  updateClipCounter(currentClipList.length);

  if (currentClip) {
    updateNavigationButtons();
  }
}

function parseSearchTerms(searchText) {
  const terms = searchText.split(/\s+/).filter(term => term.length > 0);
  return {
    // Get all terms that start with @ (tags)
    tags: terms.filter(term => term.startsWith('@')),
    // Get all other terms (regular search)
    text: terms.filter(term => !term.startsWith('@'))
  };
}

// Debounce function to limit how often the search is performed
function debounce(func, delay) {
  let debounceTimer;
  return function () {
    const context = this;
    const args = arguments;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => func.apply(context, args), delay);
  };
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
      isTagsDropdownOpen = false;
      tagsDropdown.style.display = "none";
    }
  });

  contextMenuExport.addEventListener("click", () => {
    logger.info("Export clicked for clip:", contextMenuClip?.originalName);
    if (contextMenuClip) {
      exportClipFromContextMenu(contextMenuClip);
    }
    contextMenu.style.display = "none";
  });

  contextMenuReveal.addEventListener("click", () => {
    logger.info("Reveal in Explorer clicked for clip:", contextMenuClip?.originalName);
    if (contextMenuClip) {
      ipcRenderer.invoke('reveal-clip', contextMenuClip.originalName);
    }
    contextMenu.style.display = "none";
  });

  contextMenuTags.addEventListener("click", (e) => {
    e.stopPropagation();
    isTagsDropdownOpen = !isTagsDropdownOpen;
    const tagsDropdown = document.getElementById("tags-dropdown");
    tagsDropdown.style.display = isTagsDropdownOpen ? "block" : "none";
    if (isTagsDropdownOpen) {
      const tagSearchInput = document.getElementById("tag-search-input");
      tagSearchInput.focus();
      updateTagList();
    }
  });

  addTagButton.addEventListener("click", async () => {
    const tagSearchInput = document.getElementById("tag-search-input");
    const newTag = tagSearchInput.value.trim();
    if (newTag && !globalTags.includes(newTag)) {
      await addGlobalTag(newTag);
      if (contextMenuClip) {
        await toggleClipTag(contextMenuClip, newTag);
      }
      tagSearchInput.value = "";
      updateTagList();
    }
  });

  tagSearchInput.addEventListener("input", updateTagList);
  tagSearchInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const searchTerm = tagSearchInput.value.trim().toLowerCase();
      
      // Find the closest matching tag
      const matchingTag = globalTags.find(tag => 
        tag.toLowerCase() === searchTerm ||
        tag.toLowerCase().startsWith(searchTerm)
      );
      
      if (matchingTag && contextMenuClip) {
        await toggleClipTag(contextMenuClip, matchingTag);
        tagSearchInput.value = "";
        updateTagList();
      }
    }
  });

  tagsDropdown.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  contextMenuDelete.addEventListener("click", async () => {
    logger.info("Delete clicked for clip:", contextMenuClip?.originalName);
    if (contextMenuClip) {
      await confirmAndDeleteClip(contextMenuClip);
    }
    contextMenu.style.display = "none";
  });

  if (contextMenuResetTrim) {
    contextMenuResetTrim.addEventListener("click", async () => {
      logger.info("Reset trim clicked for clip:", contextMenuClip?.originalName);
      if (contextMenuClip) {
        await resetClipTrimTimes(contextMenuClip);
      }
      contextMenu.style.display = "none";
    });
  }

  // Close context menu when clicking outside
  document.addEventListener("click", () => {
    contextMenu.style.display = "none";
  });
}

document.getElementById('manageTagsBtn').addEventListener('click', openTagManagement);

let isTagManagementOpen = false;

function openTagManagement() {
  if (isTagManagementOpen) {
    logger.info("Tag management modal is already open");
    return;
  }

  const existingModal = document.getElementById('tagManagementModal');
  if (existingModal) {
    existingModal.remove();
  }

  const container = document.querySelector('.cet-container') || document.body;
  const modal = document.createElement('div');
  modal.id = 'tagManagementModal';
  modal.className = 'tagManagement-modal';

  modal.innerHTML = `
    <div class="tagManagement-content">
      <div class="tagManagement-header">
        <h2 class="tagManagement-title">Tag Management</h2>
      </div>
      
      <div class="tagManagement-search">
        <input type="text" 
               class="tagManagement-searchInput" 
               placeholder="Search tags..."
               id="tagManagementSearch">
      </div>

      <div class="tagManagement-list" id="tagManagementList">
        ${globalTags.length === 0 ? 
          '<div class="tagManagement-noTags">No tags created yet. Add your first tag below!</div>' : 
          ''}
      </div>

      <div class="tagManagement-footer">
        <button class="tagManagement-addBtn" id="tagManagementAddBtn">
          Add New Tag
        </button>
        <button class="tagManagement-closeBtn" id="tagManagementCloseBtn">
          Close
        </button>
      </div>
    </div>
  `;

  container.appendChild(modal);
  modal.style.display = 'block';
  isTagManagementOpen = true;

  // Render initial tags
  renderTagList(globalTags);

  // Setup event listeners
  const searchInput = document.getElementById('tagManagementSearch');
  const closeBtn = document.getElementById('tagManagementCloseBtn');
  const addBtn = document.getElementById('tagManagementAddBtn');

  searchInput.addEventListener('input', (e) => {
    const searchTerm = e.target.value.toLowerCase();
    const filteredTags = globalTags.filter(tag => 
      tag.toLowerCase().includes(searchTerm)
    );
    renderTagList(filteredTags);
  });

  addBtn.addEventListener('click', async () => {
    await addNewTag();
  });

  closeBtn.addEventListener('click', closeTagManagement);

  // Close on click outside
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeTagManagement();
    }
  });

  // Close on Escape key
  document.addEventListener('keydown', handleEscapeKey);
}

function renderTagList(tags) {
  const listElement = document.getElementById('tagManagementList');
  if (!listElement) return;

  listElement.innerHTML = tags.length === 0 ? 
    '<div class="tagManagement-noTags">No tags found</div>' :
    tags.map(tag => `
      <div class="tagManagement-item" data-tag="${tag}">
        <input type="text" 
               class="tagManagement-input" 
               value="${tag}" 
               data-original="${tag}">
        <button class="tagManagement-deleteBtn">Delete</button>
      </div>
    `).join('');

  // Add event listeners for input changes and delete buttons
  document.querySelectorAll('.tagManagement-input').forEach(input => {
    input.addEventListener('change', handleTagRename);
  });

  const deleteButtons = document.querySelectorAll('.tagManagement-deleteBtn');
  logger.info(`Setting up ${deleteButtons.length} delete button event listeners`);
  deleteButtons.forEach((btn, index) => {
    btn.addEventListener('click', handleTagDelete);
    logger.info(`Delete button ${index + 1} event listener attached`);
  });
}

function handleTagRename(e) {
  const input = e.target;
  const originalTag = input.dataset.original;
  const newTag = input.value.trim();

  if (newTag && newTag !== originalTag) {
    updateTag(originalTag, newTag);
  }
}

async function handleTagDelete(e) {
  const item = e.target.closest('.tagManagement-item');
  const tag = item.dataset.tag;

  if (tag) {
    logger.info(`Starting deletion of tag: "${tag}"`);
    try {
      await deleteTag(tag);
      logger.info(`Successfully deleted tag: "${tag}"`);
      item.remove();

      // Show no tags message if no tags left
      const listElement = document.getElementById('tagManagementList');
      if (listElement.children.length === 0) {
        listElement.innerHTML = '<div class="tagManagement-noTags">No tags found</div>';
      }
    } catch (error) {
      logger.error(`Error deleting tag "${tag}":`, error);
    }
  } else {
    logger.warn('No tag found for deletion');
  }
}

async function addNewTag() {
  const searchInput = document.getElementById('tagManagementSearch');
  const newTagName = searchInput.value.trim();

  if (newTagName && !globalTags.includes(newTagName)) {
    globalTags.push(newTagName);
    await saveGlobalTags();
    
    // Automatically enable the new tag
    selectedTags.add(newTagName);
    saveTagPreferences();
    
    searchInput.value = '';
    renderTagList(globalTags);
    updateFilterDropdown();
    filterClips();
  }
}

function handleEscapeKey(e) {
  if (e.key === 'Escape' && isTagManagementOpen) {
    closeTagManagement();
  }
}

function closeTagManagement() {
  const modal = document.getElementById('tagManagementModal');
  if (modal) {
    modal.style.opacity = '0';
    setTimeout(() => {
      modal.remove();
      document.removeEventListener('keydown', handleEscapeKey);
    }, 300);
  }
  isTagManagementOpen = false;
}

function updateTagList() {
  const tagList = document.getElementById("tag-list");
  const searchTerm = document.getElementById("tag-search-input").value.toLowerCase();
  
  let tagsToShow = [...globalTags];
  
  // Always include the "Private" tag
  if (!tagsToShow.includes("Private")) {
    tagsToShow.push("Private");
  }
  
  tagsToShow = tagsToShow.filter(tag => tag.toLowerCase().includes(searchTerm));
  
  // Sort tags by how closely they match the search term, but keep "Private" at the top
  tagsToShow.sort((a, b) => {
    if (a === "Private") return -1;
    if (b === "Private") return 1;
    const aIndex = a.toLowerCase().indexOf(searchTerm);
    const bIndex = b.toLowerCase().indexOf(searchTerm);
    if (aIndex === bIndex) {
      return a.localeCompare(b);
    }
    return aIndex - bIndex;
  });

  tagList.innerHTML = "";
  tagsToShow.forEach(tag => {
    const tagElement = document.createElement("div");
    tagElement.className = "tag-item";
    
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = contextMenuClip && contextMenuClip.tags && contextMenuClip.tags.includes(tag);
    checkbox.onclick = async (e) => {
      e.stopPropagation();
      if (contextMenuClip) {
        await toggleClipTag(contextMenuClip, tag);
      }
    };
    
    const tagText = document.createElement("span");
    tagText.textContent = truncateTag(tag);
    
    tagElement.appendChild(checkbox);
    tagElement.appendChild(tagText);
    
    tagElement.onclick = (e) => {
      e.stopPropagation();
      checkbox.click();
    };
    
    tagList.appendChild(tagElement);
  });
}

async function deleteTag(tag) {
  logger.info(`deleteTag called for: "${tag}"`);
  const index = globalTags.indexOf(tag);
  logger.info(`Tag index in globalTags: ${index}`);
  
  if (index > -1) {
    logger.info(`Removing tag from globalTags array`);
    globalTags.splice(index, 1);
    await saveGlobalTags();
    logger.info(`Global tags saved, current count: ${globalTags.length}`);

    // Remove the tag from all clips by reading files directly from disk (like restoration does)
    logger.info(`Starting to remove tag "${tag}" from all .tags files on disk...`);
    const result = await ipcRenderer.invoke("remove-tag-from-all-clips", tag);
    
    if (result.success) {
      logger.info(`Successfully removed tag "${tag}" from ${result.modifiedCount} clips on disk`);
      
      // Also update any clips in memory
      let memoryClipsModified = 0;
      allClips.forEach(clip => {
        const tagIndex = clip.tags.indexOf(tag);
        if (tagIndex > -1) {
          memoryClipsModified++;
          clip.tags.splice(tagIndex, 1);
          updateClipTags(clip);
        }
      });
      
      if (memoryClipsModified > 0) {
        logger.info(`Updated ${memoryClipsModified} clips in memory as well`);
      }
    } else {
      logger.error(`Failed to remove tag from clips: ${result.error}`);
    }

    updateFilterDropdown();
  } else {
    logger.warn(`Tag "${tag}" not found in globalTags for deletion`);
  }
}

let globalTags = [];

async function addGlobalTag(tag) {
  if (!globalTags.includes(tag)) {
    globalTags.push(tag);
    await saveGlobalTags();
    
    // Automatically enable the new tag
    selectedTags.add(tag);
    saveTagPreferences();
    
    updateFilterDropdown();
    filterClips(); // Re-filter to show clips with the new tag
  }
}

async function loadGlobalTags() {
  try {
    globalTags = await ipcRenderer.invoke("load-global-tags");
  } catch (error) {
    logger.error("Error loading global tags:", error);
    globalTags = [];
  }
}

async function saveGlobalTags() {
  try {
    const result = await ipcRenderer.invoke("save-global-tags", globalTags);
    logger.info("Global tags saved successfully:", result);
    return result;
  } catch (error) {
    logger.error("Error saving global tags:", error);
    throw error;
  }
}

function updateTagList() {
  const tagList = document.getElementById("tag-list");
  const searchTerm = document.getElementById("tag-search-input").value.toLowerCase();
  
  let tagsToShow = globalTags.filter(tag => tag.toLowerCase().includes(searchTerm));
  
  // Sort tags by how closely they match the search term
  tagsToShow.sort((a, b) => {
    const aIndex = a.toLowerCase().indexOf(searchTerm);
    const bIndex = b.toLowerCase().indexOf(searchTerm);
    if (aIndex === bIndex) {
      return a.localeCompare(b); // Alphabetical order if match position is the same
    }
    return aIndex - bIndex; // Earlier match comes first
  });

  tagList.innerHTML = "";
  tagsToShow.forEach(tag => {
    const tagElement = document.createElement("div");
    tagElement.className = "tag-item";
    
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = contextMenuClip && contextMenuClip.tags && contextMenuClip.tags.includes(tag);
    checkbox.onclick = async (e) => {
      e.stopPropagation();
      if (contextMenuClip) {
        await toggleClipTag(contextMenuClip, tag);
      }
    };
    
    const tagText = document.createElement("span");
    tagText.textContent = truncateTag(tag);
    
    tagElement.appendChild(checkbox);
    tagElement.appendChild(tagText);
    
    tagElement.onclick = (e) => {
      e.stopPropagation();
      checkbox.click();
    };
    
    tagList.appendChild(tagElement);
  });
}

async function toggleClipTag(clip, tag) {
  if (!clip.tags) clip.tags = [];
  const index = clip.tags.indexOf(tag);
  const wasPrivate = clip.tags.includes("Private");
  
  if (index > -1) {
    clip.tags.splice(index, 1);
  } else {
    clip.tags.push(tag);
  }
  
  updateClipTags(clip);
  await saveClipTags(clip);

  // If we're in a filtered view and this tag change would affect visibility,
  // re-filter and re-render the entire view
  if (selectedTags.size > 0) {
    // Check if this clip would be filtered out based on current tag selection
    const shouldBeVisible = () => {
      // Handle untagged clips
      if (selectedTags.has('Untagged')) {
        if (!clip.tags || clip.tags.length === 0) {
          return true;
        }
      }

      if (!clip.tags || clip.tags.length === 0) {
        return false;
      }

      if (isInTemporaryMode) {
        // In temporary mode (focus mode), show clips that have ANY of the temporary selected tags
        return clip.tags.some(tag => temporaryTagSelections.has(tag));
      } else {
        // In normal mode, clips must have ALL their tags selected to be shown
        return clip.tags.every(tag => selectedTags.has(tag));
      }
    };

    // If tag change would affect visibility, re-filter everything
    const nowVisible = shouldBeVisible();
    if (nowVisible === false) {
      // Clip should be hidden - re-filter everything to maintain group structure
      filterClips();
    }
  }
  
  updateFilterDropdown();
}

async function updateTag(originalTag, newTag) {
  if (originalTag === newTag) return; // No change, skip update

  const index = globalTags.indexOf(originalTag);
  if (index > -1) {
    logger.info(`Updating tag "${originalTag}" to "${newTag}"`);
    globalTags[index] = newTag;
    await saveGlobalTags();

    // Update the tag in all clips by reading files directly from disk
    logger.info(`Starting to update tag "${originalTag}" to "${newTag}" in all .tags files on disk...`);
    const result = await ipcRenderer.invoke("update-tag-in-all-clips", originalTag, newTag);
    
    if (result.success) {
      logger.info(`Successfully updated tag in ${result.modifiedCount} clips on disk`);
      
      // Also update any clips in memory
      let memoryClipsModified = 0;
      allClips.forEach(clip => {
        const tagIndex = clip.tags.indexOf(originalTag);
        if (tagIndex > -1) {
          memoryClipsModified++;
          clip.tags[tagIndex] = newTag;
          updateClipTags(clip);
        }
      });
      
      if (memoryClipsModified > 0) {
        logger.info(`Updated ${memoryClipsModified} clips in memory as well`);
      }
    } else {
      logger.error(`Failed to update tag in clips: ${result.error}`);
    }

    // Update the filter dropdown
    updateFilterDropdown();

    // If the current filter is the original tag, update it to the new tag
    const filterDropdown = document.getElementById("filter-dropdown");
    if (filterDropdown.value === originalTag) {
      filterDropdown.value = newTag;
      filterClips(newTag);
    }

    logger.info(`Tag "${originalTag}" updated to "${newTag}"`);
  } else {
    logger.warn(`Tag "${originalTag}" not found in globalTags`);
  }
}

async function loadTagPreferences() {
  try {
    const savedTags = await ipcRenderer.invoke('get-tag-preferences');
    if (savedTags && savedTags.length > 0) {
      savedTagSelections = new Set(savedTags);
    } else {
      // Default to all tags visible, including "Untagged"
      savedTagSelections = new Set(['Untagged', ...globalTags]);
    }
    selectedTags = new Set(savedTagSelections); // Initialize global selectedTags
  } catch (error) {
    logger.error('Error loading tag preferences:', error);
    savedTagSelections = new Set(['Untagged', ...globalTags]);
    selectedTags = new Set(savedTagSelections);
  }
  
  updateFilterDropdown();
  filterClips();
}

function updateClipTags(clip) {
  const clipElement = document.querySelector(`.clip-item[data-original-name="${clip.originalName}"]`);
  if (clipElement) {
    const tagContainer = clipElement.querySelector(".tag-container");
    tagContainer.innerHTML = "";
    
    const visibleTags = clip.tags.slice(0, 3);  // Show only first 3 tags
    visibleTags.forEach(tag => {
      const tagElement = document.createElement("span");
      tagElement.className = "tag";
      tagElement.textContent = truncateTag(tag);
      tagElement.title = tag; // Show full tag on hover
      tagContainer.appendChild(tagElement);
    });
    
    if (clip.tags.length > 3) {
      const moreTagsElement = document.createElement("span");
      moreTagsElement.className = "tag more-tags";
      moreTagsElement.textContent = `+${clip.tags.length - 3}`;
      
      // Create a tooltip element
      const tooltip = document.createElement("div");
      tooltip.className = "tags-tooltip";
      
      // Add remaining tags to the tooltip
      clip.tags.slice(3).forEach(tag => {
        const tooltipTag = document.createElement("span");
        tooltipTag.className = "tooltip-tag";
        tooltipTag.textContent = tag;
        tooltip.appendChild(tooltipTag);
      });
      
      moreTagsElement.appendChild(tooltip);
      tagContainer.appendChild(moreTagsElement);

      // Add event listeners
      moreTagsElement.addEventListener('mouseenter', (e) => showTooltip(e, tooltip));
      moreTagsElement.addEventListener('mouseleave', () => hideTooltip(tooltip));
    }
  }
}

function showTooltip(event, tooltip) {
  const rect = event.target.getBoundingClientRect();
  tooltip.style.display = 'flex';
  tooltip.style.position = 'fixed';
  tooltip.style.zIndex = '10000';  // Ensure this is higher than any other z-index in your app
  tooltip.style.left = `${rect.left}px`;
  tooltip.style.top = `${rect.bottom + 5}px`; // 5px below the tag

  // Ensure the tooltip doesn't go off-screen
  const tooltipRect = tooltip.getBoundingClientRect();
  if (tooltipRect.right > window.innerWidth) {
    tooltip.style.left = `${window.innerWidth - tooltipRect.width}px`;
  }
  if (tooltipRect.bottom > window.innerHeight) {
    tooltip.style.top = `${rect.top - tooltipRect.height - 5}px`;
  }

  // Move the tooltip to the body to ensure it's not constrained by any parent elements
  document.body.appendChild(tooltip);
}

function hideTooltip(tooltip) {
  tooltip.style.display = 'none';
  // Move the tooltip back to its original parent
  if (tooltip.parentElement === document.body) {
    const moreTagsElement = tooltip.previousElementSibling;
    if (moreTagsElement) {
      moreTagsElement.appendChild(tooltip);
    }
  }
}

async function saveClipTags(clip) {
  try {
    await ipcRenderer.invoke("save-clip-tags", clip.originalName, clip.tags);
  } catch (error) {
    logger.error("Error saving clip tags:", error);
  }
}

function truncateTag(tag, maxLength = 15) {
  if (tag.length <= maxLength) return tag;
  return tag.slice(0, maxLength - 1) + '..';
}

function setupTooltips() {
  document.querySelectorAll('.more-tags').forEach(moreTags => {
    const tooltip = moreTags.querySelector('.tags-tooltip');
    
    moreTags.addEventListener('mouseenter', (e) => {
      showTooltip(e, tooltip);
    });
    
    moreTags.addEventListener('mouseleave', () => {
      hideTooltip(tooltip);
    });
  });
}

// Add a new function to set up tooltips specifically for a single clip element
function setupTagTooltips(clipElement) {
  const moreTags = clipElement.querySelector('.more-tags');
  if (moreTags) {
    const tooltip = moreTags.querySelector('.tags-tooltip');
    if (tooltip) {
      moreTags.addEventListener('mouseenter', (e) => showTooltip(e, tooltip));
      moreTags.addEventListener('mouseleave', () => hideTooltip(tooltip));
    }
  }
}

function showContextMenu(e, clip) {
  e.preventDefault();
  e.stopPropagation();

  const contextMenu = document.getElementById("context-menu");
  const tagsDropdown = document.getElementById("tags-dropdown");

  if (contextMenu) {
    // Reset the context menu state
    contextMenu.style.display = "none";
    tagsDropdown.style.display = "none";
    isTagsDropdownOpen = false; 
    
    // Clear any checked checkboxes
    const checkboxes = tagsDropdown.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => checkbox.checked = false);
    
    // Clear the tag search input
    const tagSearchInput = document.getElementById("tag-search-input");
    if (tagSearchInput) tagSearchInput.value = '';

    // Set new position and show the menu
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;
    contextMenu.style.display = "block";

    // Update the contextMenuClip
    contextMenuClip = clip;

    logger.info("Context menu shown for clip:", clip.originalName);
    
    // Update the tag list for the new clip
    updateTagList();
    
    // Add a click event listener to the document to close the context menu
    document.addEventListener('click', closeContextMenu);
    
    // Add an overlay to block clicks outside the context menu
    const overlay = document.createElement('div');
    overlay.id = 'context-menu-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.zIndex = '1980'; // Just below the context menu
    clipGrid.appendChild(overlay);
  } else {
    logger.error("Context menu elements not found");
  }
}

function closeContextMenu(e) {
  const contextMenu = document.getElementById("context-menu");
  const tagsDropdown = document.getElementById("tags-dropdown");
  const overlay = document.getElementById('context-menu-overlay');
  
  if (!contextMenu.contains(e.target)) {
    contextMenu.style.display = "none";
    tagsDropdown.style.display = "none";
    isTagsDropdownOpen = false;
    document.removeEventListener('click', closeContextMenu);
    if (overlay) {
      overlay.remove();
    }
  }
}

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
      }, 300);
    }, 3000);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Ensure keybindings are loaded before we attach any listeners that use them
  await keybinds.initKeybindings();
  settings = ipcRenderer.invoke('get-settings');
  fetchSettings();
  
  // Initialize gamepad manager
  await initializeGamepadManager();
  const settingsButton = document.getElementById("settingsButton");
  if (settingsButton) {
    settingsButton.addEventListener("click", openSettingsModal);
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
    manageTagsBtn.addEventListener("click", openTagManagement);
    logger.info("Manage Tags button listener added");
  } else {
    logger.error("Manage Tags button not found");
  }

  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener("click", closeSettingsModal);
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
        // Add "Imported" to selectedTags if not already present
        if (!selectedTags.has("Imported")) {
          selectedTags.add("Imported");
          await saveTagPreferences();
        }
  
        await showCustomAlert('Import completed successfully!');
        // Reload clips to show new imports
        await loadClips();
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

  loadClips();
  setupSearch();

  
  volumeSlider.addEventListener("input", (e) => {
    const newVolume = parseFloat(e.target.value);
    if (!audioContext) setupAudioContext();
    gainNode.gain.setValueAtTime(newVolume, audioContext.currentTime);
    updateVolumeSlider(newVolume);
    updateVolumeIcon(newVolume);
    
    if (currentClip) {
      debouncedSaveVolume(currentClip.originalName, newVolume);
    }
  });

  
  volumeButton.addEventListener("click", () => {
    volumeSlider.classList.toggle("collapsed");
    clearTimeout(volumeContainer.timeout);
  });
  
  volumeContainer.addEventListener("mouseenter", () => {
    clearTimeout(volumeContainer.timeout);
    volumeSlider.classList.remove("collapsed");
  });
  
  volumeContainer.addEventListener("mouseleave", () => {
    volumeContainer.timeout = setTimeout(() => {
      volumeSlider.classList.add("collapsed");
    }, 2000);
  });

  setupContextMenu();
  loadGlobalTags();
  applyIconGreyscale(settings?.iconGreyscale);

  const enableDiscordRPCCheckbox = document.getElementById('enableDiscordRPC');
  enableDiscordRPCCheckbox.addEventListener('change', (e) => {
    toggleDiscordRPC(e.target.checked);
  });

  // Greyscale icons toggle (similar pattern to Discord RPC)
  const greyscaleIconsCheckbox = document.getElementById('greyscaleIcons');
  if (greyscaleIconsCheckbox) {
    greyscaleIconsCheckbox.addEventListener('change', async (e) => {
      const isEnabled = e.target.checked;
      try {
        // Update settings and save
        const updatedSettings = { ...settings, iconGreyscale: isEnabled };
        await ipcRenderer.invoke('save-settings', updatedSettings);
        settings = updatedSettings;
        
        // Apply the change immediately
        applyIconGreyscale(isEnabled);
        logger.info('Greyscale icons setting changed:', isEnabled);
      } catch (error) {
        logger.error('Error saving greyscale icons setting:', error);
        // Revert the checkbox state on error
        e.target.checked = !isEnabled;
      }
    });
  }

  // Create and setup the tag filter UI
  createTagFilterUI();
  // Load initial tag preferences
  await loadTagPreferences();

  updateDiscordPresence('Browsing clips', `Total clips: ${currentClipList.length}`);

  loadingScreen = document.getElementById('loading-screen');
});

async function saveSpeed(clipName, speed) {
  try {
    await ipcRenderer.invoke("save-speed", clipName, speed);
  } catch (error) {
    logger.error("Error saving speed:", error);
  }
}

async function loadSpeed(clipName) {
  try {
    const speed = await ipcRenderer.invoke("get-speed", clipName);
    logger.info(`Loaded speed for ${clipName}: ${speed}`);
    return speed;
  } catch (error) {
    logger.error("Error loading speed:", error);
    return 1;
  }
}

function changeSpeed(speed) {
  videoPlayer.playbackRate = speed;
  updateSpeedSlider(speed);
  updateSpeedText(speed);
  showSpeedContainer();
  
  if (currentClip) {
    debouncedSaveSpeed(currentClip.originalName, speed);
  }
}

function updateSpeedSlider(speed) {
  if (speedSlider) {
    speedSlider.value = speed;
  }
}

function updateSpeedText(speed) {
  let displaySpeed;
  if (Number.isInteger(speed)) {
    displaySpeed = `${speed}x`;
  } else if (speed * 10 % 1 === 0) {
    // This condition checks if the speed has only one decimal place
    displaySpeed = `${speed.toFixed(1)}x`;
  } else {
    displaySpeed = `${speed.toFixed(2)}x`;
  }
  speedText.textContent = displaySpeed;
}

function showSpeedContainer() {
  speedSlider.classList.remove("collapsed");
  
  clearTimeout(speedContainer.timeout);
  speedContainer.timeout = setTimeout(() => {
    speedSlider.classList.add("collapsed");
  }, 2000);
}

function showSpeedContainer() {
  speedSlider.classList.remove("collapsed");
  
  clearTimeout(speedContainer.timeout);
  speedContainer.timeout = setTimeout(() => {
    speedSlider.classList.add("collapsed");
  }, 2000);
}

const debouncedSaveSpeed = debounce(async (clipName, speed) => {
  try {
    await ipcRenderer.invoke("save-speed", clipName, speed);
    logger.info(`Speed saved for ${clipName}: ${speed}`);
  } catch (error) {
    logger.error('Error saving speed:', error);
  }
}, 300);

speedSlider.addEventListener("input", (e) => {
  const newSpeed = parseFloat(e.target.value);
  changeSpeed(newSpeed);
});

speedButton.addEventListener("click", () => {
  speedSlider.classList.toggle("collapsed");
  clearTimeout(speedContainer.timeout);
});

speedContainer.addEventListener("mouseenter", () => {
  clearTimeout(speedContainer.timeout);
  speedSlider.classList.remove("collapsed");
});

speedContainer.addEventListener("mouseleave", () => {
  speedContainer.timeout = setTimeout(() => {
    speedSlider.classList.add("collapsed");
  }, 2000);
});

function setupAudioContext() {
  if (audioContext) return; // If already set up, don't create a new context
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  gainNode = audioContext.createGain();
  const source = audioContext.createMediaElementSource(videoPlayer);
  source.connect(gainNode);
  gainNode.connect(audioContext.destination);
}

function changeVolume(delta) {
  if (!audioContext) setupAudioContext();
  
  const currentVolume = gainNode.gain.value;
  let newVolume = currentVolume + delta;
  
  newVolume = Math.round(newVolume * 100) / 100;
  newVolume = Math.min(Math.max(newVolume, 0), 2);
  
  gainNode.gain.setValueAtTime(newVolume, audioContext.currentTime);
  updateVolumeSlider(newVolume);
  updateVolumeIcon(newVolume);
  
  if (currentClip) {
    debouncedSaveVolume(currentClip.originalName, newVolume);
  }
  
  showVolumeContainer();
}

function updateVolumeSlider(volume) {
  const volumeSlider = document.getElementById("volume-slider");
  volumeSlider.value = volume;
  
  // Update visual feedback
  if (volume > 1) {
    volumeSlider.classList.add('boosted');
  } else {
    volumeSlider.classList.remove('boosted');
  }
  
  // Update volume button icon if needed
  updateVolumeIcon(volume);
}

function updateVolumeIcon(volume) {
  const volumeButton = document.getElementById("volume-button");
  if (volume === 0) {
    volumeButton.innerHTML = volumeIcons.muted;
  } else if (volume < 0.5) {
    volumeButton.innerHTML = volumeIcons.low;
  } else if (volume <= 1) {
    volumeButton.innerHTML = volumeIcons.normal; // We'll need to add this icon
  } else if (volume > 1) {
    volumeButton.innerHTML = volumeIcons.high;
  }
}

const debouncedSaveVolume = debounce(async (clipName, volume) => {
  try {
    await ipcRenderer.invoke("save-volume", clipName, volume);
    logger.info(`Volume saved for ${clipName}: ${volume}`);
  } catch (error) {
    logger.error('Error saving volume:', error);
  }
}, 300); // 300ms debounce time

async function saveVolume(clipName, volume) {
  try {
    await ipcRenderer.invoke("save-volume", clipName, volume);
  } catch (error) {
    logger.error("Error saving volume:", error);
  }
}

async function loadVolume(clipName) {
  try {
    const volume = await ipcRenderer.invoke("get-volume", clipName);
    logger.info(`Loaded volume for ${clipName}: ${volume}`);
    return volume;
  } catch (error) {
    logger.error("Error loading volume:", error);
    return 1; 
  }
}

function showVolumeContainer() {
  const volumeContainer = document.getElementById("volume-container");
  const volumeSlider = document.getElementById("volume-slider");
  
  volumeSlider.classList.remove("collapsed");
  
  clearTimeout(volumeContainer.timeout);
  volumeContainer.timeout = setTimeout(() => {
    volumeSlider.classList.add("collapsed");
  }, 2000); // Hide after 2 seconds
}

async function changeClipLocation() {
  const newLocation = await ipcRenderer.invoke("open-folder-dialog");
  if (newLocation) {
    try {
      await ipcRenderer.invoke("set-clip-location", newLocation);
      clipLocation = newLocation;
      currentClipLocationSpan.textContent = newLocation;
      await loadClips(); // Reload clips with the new location
    } catch (error) {
      logger.error("Error changing clip location:", error);
      await showCustomAlert(`Failed to change clip location: ${error.message}`);
    }
  }
}

const exportQualitySelect = document.getElementById('exportQuality');
exportQualitySelect.addEventListener('change', async (e) => {
  const newQuality = e.target.value;
  logger.info('Export quality changed to:', newQuality);
  
  try {
    // Update local settings first
    settings = {
      ...settings,
      exportQuality: newQuality
    };
    
    // Save settings and wait for completion
    const savedSettings = await ipcRenderer.invoke('save-settings', settings);
    
    // Update local settings with the returned saved settings
    settings = savedSettings;
    
    logger.info('Settings saved successfully:', settings);
  } catch (error) {
    logger.error('Error saving settings:', error);
    // Revert the select value if save failed
    e.target.value = settings.exportQuality;
    // Revert local settings
    settings = await fetchSettings();
  }
});

function initializeSettingsModal() {
  const settingsModal = document.getElementById('settingsModal');
  const tabs = document.querySelectorAll('.settings-tab');
  const tabContents = document.querySelectorAll('.settings-tab-content');

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      
      // Update active states
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      tab.classList.add('active');
      document.querySelector(`.settings-tab-content[data-tab="${targetTab}"]`).classList.add('active');
      if (typeof populateKeybindingList === 'function' && targetTab === 'shortcuts') {
        populateKeybindingList();
      }
    });
  });

  // Preview volume slider
  const previewVolumeSlider = document.getElementById('previewVolumeSlider');
  const previewVolumeValue = document.getElementById('previewVolumeValue');

  previewVolumeSlider.addEventListener('input', (e) => {
    const value = Math.round(e.target.value * 100);
    previewVolumeValue.textContent = `${value}%`;
    updateAllPreviewVolumes(e.target.value);
  });

  // Settings controls event handlers
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettingsModal);
  document.getElementById('changeLocationBtn').addEventListener('click', changeClipLocation);
  document.getElementById('manageTagsBtn').addEventListener('click', () => {
    closeSettingsModal();
    openTagManagement();
  });

  // Export quality change handler
  document.getElementById('exportQuality').addEventListener('change', async (e) => {
    const newQuality = e.target.value;
    logger.info('Export quality changed to:', newQuality);
    
    try {
      settings = {
        ...settings,
        exportQuality: newQuality
      };
      
      const savedSettings = await ipcRenderer.invoke('save-settings', settings);
      settings = savedSettings;
      
      logger.info('Settings saved successfully:', settings);
    } catch (error) {
      logger.error('Error saving settings:', error);
      e.target.value = settings.exportQuality;
      settings = await fetchSettings();
    }
  });

  // Discord RPC toggle handler
  const discordRPCToggle = document.getElementById('enableDiscordRPC');
  discordRPCToggle.addEventListener('change', async (e) => {
    const isEnabled = e.target.checked;
    try {
      await toggleDiscordRPC(isEnabled);
      settings = {
        ...settings,
        enableDiscordRPC: isEnabled
      };
      await ipcRenderer.invoke('save-settings', settings);
    } catch (error) {
      logger.error('Error toggling Discord RPC:', error);
      e.target.checked = !isEnabled;
    }
  });

  // Greyscale icons toggle
  const greyscaleToggle = document.getElementById('greyscaleIcons');

  if (greyscaleToggle) {
    greyscaleToggle.checked = Boolean(settings.iconGreyscale);
    greyscaleToggle.addEventListener('change', async (e) => {
      const isEnabled = e.target.checked;
      try {
        const updated = { ...settings, iconGreyscale: isEnabled };
        await ipcRenderer.invoke('save-settings', updated);
        settings = updated;
        applyIconGreyscale(isEnabled); // reflect instantly
      } catch (error) {
        logger.error('Error toggling Greyscale Icons:', error);
        // revert visual state
        e.target.checked = !isEnabled;
      }
    });
  } else {
    logger.error('Greyscale toggle element not found in DOM');
  }
}

async function openSettingsModal() {
  logger.debug('Opening settings modal. Current settings:', settings);
  
  // Fetch fresh settings
  settings = await fetchSettings();
  logger.debug('Fresh settings fetched:', settings);
  
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) {
    settingsModal.style.display = 'block';
    
    // Update version display
    updateVersionDisplay();
    
    // Update clip location
    const currentClipLocation = document.getElementById('currentClipLocation');
    if (currentClipLocation) {
      currentClipLocation.textContent = clipLocation || 'Not set';
    }
    
    // Set control values from settings
    const enableDiscordRPCToggle = document.getElementById('enableDiscordRPC');
    const exportQualitySelect = document.getElementById('exportQuality');
    const previewVolumeSlider = document.getElementById('previewVolumeSlider');
    const previewVolumeValue = document.getElementById('previewVolumeValue');

    logger.debug('Setting controls with values:', {
      enableDiscordRPC: settings.enableDiscordRPC,
      exportQuality: settings.exportQuality,
      previewVolume: settings.previewVolume
    });

    if (enableDiscordRPCToggle) {
      enableDiscordRPCToggle.checked = Boolean(settings.enableDiscordRPC);
    }
    
    if (exportQualitySelect) {
      exportQualitySelect.value = settings.exportQuality || 'discord';
    }

    // Refresh greyscale toggle to reflect persisted value
    const greyscaleToggleEl = document.getElementById('greyscaleIcons');
    if (greyscaleToggleEl) {
      greyscaleToggleEl.checked = Boolean(settings.iconGreyscale);
    }

    if (previewVolumeSlider && previewVolumeValue) {
      const savedVolume = settings.previewVolume ?? 0.1;
      previewVolumeSlider.value = savedVolume;
      previewVolumeValue.textContent = `${Math.round(savedVolume * 100)}%`;
    }

    // Set initial active tab
    const defaultTab = document.querySelector('.settings-tab[data-tab="general"]');
    if (defaultTab) {
      defaultTab.click();
    }
  }
}

function closeSettingsModal() {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) {
    // Add fade-out animation
    settingsModal.style.opacity = '0';
    setTimeout(() => {
      settingsModal.style.display = 'none';
      settingsModal.style.opacity = '1';
    }, 300);
  }
  
  // Save settings state
  updateSettings();
  
  // Update preview volumes
  const previewVolumeSlider = document.getElementById('previewVolumeSlider');
  if (previewVolumeSlider) {
    updateAllPreviewVolumes(parseFloat(previewVolumeSlider.value));
  }
}

document.getElementById('previewVolumeSlider').addEventListener('input', async (e) => {
  const value = parseFloat(e.target.value);
  // Round to 2 decimal places for display
  document.getElementById('previewVolumeValue').textContent = `${Math.round(value * 100)}%`;
  settings.previewVolume = value;
  await ipcRenderer.invoke('save-settings', settings);
  settings = await fetchSettings();
  // Update all currently playing preview videos
  updateAllPreviewVolumes(value);
});

async function updateSettings() {
  settings = await ipcRenderer.invoke('get-settings');
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
  .addEventListener("click", openSettingsModal);
closeSettingsBtn.addEventListener("click", closeSettingsModal);
document
  .getElementById("changeLocationBtn")
  .addEventListener("click", changeClipLocation);

// Add click-outside-to-close functionality for settings modal
document.addEventListener('click', (e) => {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal && settingsModal.style.display !== 'none') {
    // Check if we clicked on the modal background (settingsModal div) and not inside the content
    if (e.target.id === 'settingsModal' && !e.target.closest('.settings-modal-content')) {
      closeSettingsModal();
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

function createClipElement(clip) {
  return new Promise(async (resolve) => {
    const clipElement = document.createElement("div");
    clipElement.className = "clip-item";
    clipElement.dataset.originalName = clip.originalName;

    const contentElement = document.createElement("div");
    contentElement.className = "clip-item-content";

    let thumbnailPath = await ipcRenderer.invoke(
      "get-thumbnail-path",
      clip.originalName,
    );

    const relativeTime = getRelativeTimeString(clip.createdAt);

    // Create media container
    const mediaContainer = document.createElement("div");
    mediaContainer.className = "clip-item-media-container";

    // Create image element
    const imgElement = document.createElement("img");
    
    // Only create shimmer if we don't have a thumbnail
    if (thumbnailPath === null) {
      // Add loading class to container
      mediaContainer.classList.add('is-loading');
      
      // Create shimmer elements only for loading items
      const shimmerWrapper = document.createElement("div");
      shimmerWrapper.className = "shimmer-wrapper";
      const shimmerElement = document.createElement("div");
      shimmerElement.className = "shimmer";
      shimmerWrapper.appendChild(shimmerElement);
      mediaContainer.appendChild(shimmerWrapper);

      // Set src to loading thumbnail
      imgElement.src = "assets/loading-thumbnail.gif";
      
      // When the real thumbnail loads
      imgElement.addEventListener('load', () => {
        if (!imgElement.src.includes('loading-thumbnail.gif')) {
          // Remove shimmer elements completely from DOM
          const shimmerWrapper = mediaContainer.querySelector('.shimmer-wrapper');
          if (shimmerWrapper) {
            shimmerWrapper.remove();
          }
          mediaContainer.classList.remove('is-loading');
        }
      });
    } else {
      // We have a thumbnail, just set it directly
      imgElement.src = `file://${thumbnailPath}`;
    }

    imgElement.alt = clip.customName;
    imgElement.onerror = () => {
      imgElement.src = 'assets/fallback-image.jpg';
      // Remove shimmer if there's an error
      mediaContainer.classList.remove('is-loading');
      const shimmerWrapper = mediaContainer.querySelector('.shimmer-wrapper');
      if (shimmerWrapper) {
        shimmerWrapper.remove();
      }
    };

    mediaContainer.appendChild(imgElement);

    // Create tag container and add tags directly during clip element creation
    const tagContainer = document.createElement("div");
    tagContainer.className = "tag-container";
    
    // Add tags to the container if they exist
    if (clip.tags && clip.tags.length > 0) {
      const visibleTags = clip.tags.slice(0, 3);  // Show only first 3 tags
      visibleTags.forEach(tag => {
        const tagElement = document.createElement("span");
        tagElement.className = "tag";
        tagElement.textContent = truncateTag(tag);
        tagElement.title = tag; // Show full tag on hover
        tagContainer.appendChild(tagElement);
      });
      
      if (clip.tags.length > 3) {
        const moreTagsElement = document.createElement("span");
        moreTagsElement.className = "tag more-tags";
        moreTagsElement.textContent = `+${clip.tags.length - 3}`;
        
        // Create a tooltip element
        const tooltip = document.createElement("div");
        tooltip.className = "tags-tooltip";
        
        // Add remaining tags to the tooltip
        clip.tags.slice(3).forEach(tag => {
          const tooltipTag = document.createElement("span");
          tooltipTag.className = "tooltip-tag";
          tooltipTag.textContent = tag;
          tooltip.appendChild(tooltipTag);
        });
        
        moreTagsElement.appendChild(tooltip);
        tagContainer.appendChild(moreTagsElement);
      }
    }

    // Create the clip element structure
    clipElement.innerHTML = `
      ${mediaContainer.outerHTML}
      <div class="clip-info">
        <p class="clip-name" contenteditable="true">${clip.customName}</p>
        <p class="clip-time" title="${new Date(clip.createdAt).toLocaleString()}">${relativeTime}</p>
      </div>
    `;

    // Insert the tag container after mediaContainer
    clipElement.insertBefore(tagContainer, clipElement.querySelector('.clip-info'));

    let videoElement;

    const clipNameElement = clipElement.querySelector('.clip-name');
    clipNameElement.addEventListener('focus', (e) => {
      e.stopPropagation();
      handleClipTitleFocus(clipNameElement, clip);
    });
    clipNameElement.addEventListener('blur', (e) => {
      e.stopPropagation();
      handleClipTitleBlur(clipNameElement, clip);
    });
    clipNameElement.addEventListener('keydown', (e) => handleClipTitleKeydown(e, clipNameElement, clip));
    clipNameElement.addEventListener('click', (e) => e.stopPropagation());

    // Setup tooltip events for tags if needed
    setupTagTooltips(clipElement);

    function handleClipTitleFocus(titleElement, clip) {
      titleElement.dataset.originalValue = titleElement.textContent;
    }
    
    function handleClipTitleBlur(titleElement, clip) {
      const newTitle = titleElement.textContent.trim();
      if (newTitle !== titleElement.dataset.originalValue) {
        saveTitleChange(clip.originalName, clip.customName, newTitle);
      }
    }
    
    function handleClipTitleKeydown(e, titleElement, clip) {
      e.stopPropagation(); // Stop the event from bubbling up
      if (e.key === 'Enter') {
        e.preventDefault();
        titleElement.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        titleElement.textContent = titleElement.dataset.originalValue;
        titleElement.blur();
      }
    }

    function cleanupVideoPreview() {
      // Clear the timeout if it exists
      if (previewCleanupTimeout) {
        clearTimeout(previewCleanupTimeout);
        previewCleanupTimeout = null;
      }
    
      // Reset active preview
      activePreview = null;
    
      // Clean up video element if it exists
      if (videoElement) {
        videoElement.pause();
        videoElement.removeAttribute('src');
        videoElement.load();
        videoElement.remove();
        videoElement = null;
    
        // Restore thumbnail visibility
        const imgElement = clipElement.querySelector(".clip-item-media-container img");
        if (imgElement) {
          imgElement.style.display = "";
        }
      }
    }

    async function handleMouseEnter() {
      if (clipElement.classList.contains("video-preview-disabled")) return;
    
      // Clear any existing preview immediately
      cleanupVideoPreview();
    
      // Store the current preview context
      const currentPreviewContext = {};
      activePreview = currentPreviewContext;
    
      // Set a small delay before creating the preview
      previewCleanupTimeout = setTimeout(async () => {
        // Check if this preview is still the active one
        if (activePreview !== currentPreviewContext) return;
    
        try {
          const trimData = await ipcRenderer.invoke("get-trim", clip.originalName);
          const clipInfo = await ipcRenderer.invoke("get-clip-info", clip.originalName);
          
          // Check again if this preview is still active
          if (activePreview !== currentPreviewContext) return;
    
          let startTime;
          if (trimData) {
            startTime = trimData.start;
          } else {
            startTime = clipInfo.format.duration > 40 ? clipInfo.format.duration / 2 : 0;
          }
    
          // Final check before creating video element
          if (activePreview !== currentPreviewContext) return;
    
          // Get the current preview volume setting
          const currentPreviewVolume = document.getElementById('previewVolumeSlider')?.value ?? settings?.previewVolume ?? 0.1;
    
          videoElement = document.createElement("video");
          videoElement.src = `file://${path.join(clipLocation, clip.originalName)}`;
          videoElement.volume = currentPreviewVolume;
          videoElement.loop = true;
          videoElement.preload = "metadata";
          videoElement.style.zIndex = "1";
    
          const mediaContainer = clipElement.querySelector(".clip-item-media-container");
          const imgElement = mediaContainer.querySelector("img");
          
          // Set the video poster to the current thumbnail
          videoElement.poster = imgElement.src;
    
          // Store video element in the preview
          currentPreviewContext.videoElement = videoElement;
    
          // Add loadedmetadata event listener
          videoElement.addEventListener('loadedmetadata', () => {
            // Final check before playing
            if (activePreview !== currentPreviewContext || !clipElement.matches(':hover')) {
              cleanupVideoPreview();
              return;
            }
    
            imgElement.style.display = "none";
            videoElement.currentTime = startTime;
            videoElement.play().catch((error) => {
              if (error.name !== "AbortError") {
                logger.error("Error playing video:", error);
              }
              cleanupVideoPreview();
            });
          });
    
          mediaContainer.appendChild(videoElement);
        } catch (error) {
          logger.error("Error setting up preview:", error);
          cleanupVideoPreview();
        }
      }, 100);
    }

    function handleMouseLeave() {
      if (clipElement.classList.contains("video-preview-disabled")) return;
      cleanupVideoPreview();
    }

    clipElement.handleMouseEnter = handleMouseEnter;
    clipElement.addEventListener("mouseenter", handleMouseEnter);
    clipElement.addEventListener("mouseleave", handleMouseLeave);

    clipElement.addEventListener("click", (e) => handleClipClick(e, clip));

    clipElement.addEventListener("mousemove", handleOnMouseMove);

    clipElement.addEventListener("contextmenu", (e) => {
      e.preventDefault(); // Prevent the default context menu
      showContextMenu(e, clip);
    });
    clipElement.appendChild(contentElement);

    clipElement.cleanup = () => {
      cleanupVideoPreview();
      clipElement.removeEventListener("mouseenter", handleMouseEnter);
      clipElement.removeEventListener("mouseleave", handleMouseLeave);
    };

    // Fetch a potential game/application icon and append it to the clip-info
    try {
      const iconData = await ipcRenderer.invoke('get-game-icon', clip.originalName);
      const iconPath = iconData && typeof iconData === 'object' ? iconData.path : iconData;
      const iconTitle = iconData && typeof iconData === 'object' ? iconData.title : null;
      if (iconPath) {
        const clipInfo = clipElement.querySelector('.clip-info');
        if (clipInfo) {
          const iconImg = document.createElement('img');
          iconImg.className = 'game-icon';
          iconImg.src = `file://${iconPath}`;
          iconImg.alt = 'Application Icon';
          if (iconTitle) {
            iconImg.title = iconTitle;
          }
          if (settings?.iconGreyscale) {
            iconImg.classList.add('greyscale-icon');
          }
          clipInfo.appendChild(iconImg);
          clipInfo.classList.add('has-icon');
        }
      }
    } catch (error) {
      logger.error('Error loading game icon:', error);
    }

    resolve(clipElement);
  });
}

function handleClipClick(e, clip) {
  // Check if the clicked element is the title or its parent (the clip-info div)
  if (e.target.classList.contains('clip-name') || e.target.classList.contains('clip-info')) {
    // If it's the title or clip-info, don't open the clip
    return;
  }

  // Handle multi-select
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    handleClipSelection(e.target.closest('.clip-item'), e);
    return;
  }

  // Clear selection if clicking without modifier keys
  if (selectedClips.size > 0) {
    clearSelection();
    return;
  }

  // Otherwise, open the clip
  openClip(clip.originalName, clip.customName);
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

const exportButton = document.getElementById("export-button");
const deleteButton = document.getElementById("delete-button");

deleteButton.addEventListener("click", () => confirmAndDeleteClip());
exportButton.addEventListener("click", (e) => {
  if (e.ctrlKey && e.shiftKey) {
    exportAudioWithFileSelection();
  } else if (e.ctrlKey) {
    exportVideoWithFileSelection();
  } else if (e.shiftKey) {
    exportAudioToClipboard();
  } else {
    exportTrimmedVideo();
  }
});

ipcRenderer.on("close-video-player", () => {
  if (videoPlayer) {
    videoPlayer.pause();
    videoPlayer.src = "";
    videoPlayer.load();
  }
});

function updateNavigationButtons() {
  const currentIndex = currentClipList.findIndex(clip => clip.originalName === currentClip.originalName);
  document.getElementById('prev-video').disabled = currentIndex <= 0;
  document.getElementById('next-video').disabled = currentIndex >= currentClipList.length - 1;
}

function pauseVideoIfPlaying() {
  if (!videoPlayer.paused) {
    videoPlayer.pause();
  }
}

function navigateToVideo(direction) {
  const currentIndex = currentClipList.findIndex(clip => clip.originalName === currentClip.originalName);
  const newIndex = currentIndex + direction;
  if (newIndex >= 0 && newIndex < currentClipList.length) {
    const nextClip = currentClipList[newIndex];
    openClip(nextClip.originalName, nextClip.customName);
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

async function confirmAndDeleteClip(clipToDelete = null) {
  if (!clipToDelete && !currentClip) return;
  
  const clipInfo = clipToDelete || currentClip;
  
  const isConfirmed = await showCustomConfirm(`Are you sure you want to delete "${clipInfo.customName}"? This action cannot be undone.`);

  if (isConfirmed) {
    // Immediately remove the clip from UI
    const clipElement = document.querySelector(`.clip-item[data-original-name="${clipInfo.originalName}"]`);
    if (clipElement) {
      // Update group before removing the clip
      updateGroupAfterDeletion(clipElement);
      clipElement.remove();
    }

    // Remove from allClips and currentClipList
    const allClipsIndex = allClips.findIndex(clip => clip.originalName === clipInfo.originalName);
    const currentClipListIndex = currentClipList.findIndex(clip => clip.originalName === clipInfo.originalName);
    
    if (allClipsIndex > -1) allClips.splice(allClipsIndex, 1);
    if (currentClipListIndex > -1) currentClipList.splice(currentClipListIndex, 1);

    try {
      // Close the player if we're deleting the current clip
      if (currentClip && currentClip.originalName === clipInfo.originalName) {
        closePlayer();
      }
      
      disableVideoThumbnail(clipInfo.originalName);
      
      // Show deletion tooltip
      showDeletionTooltip();
      
      const result = await ipcRenderer.invoke('delete-clip', clipInfo.originalName);
      if (result.success) {
        logger.info('Clip deleted successfully');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      logger.error('Error deleting clip:', error);
      await showCustomAlert(`Failed to delete clip: ${error.message}`);
      
      // Revert the UI changes if deletion fails
      if (clipElement && clipElement.parentNode === null) {
        // Find or recreate the appropriate group
        const timeGroup = getTimeGroup(clipInfo.createdAt);
        let groupElement = document.querySelector(`.clip-group[data-group-name="${timeGroup}"]`);
        
        if (!groupElement) {
          // Recreate the group if it was removed
          groupElement = document.createElement('div');
          groupElement.className = 'clip-group';
          groupElement.dataset.groupName = timeGroup;
          
          const header = document.createElement('div');
          header.className = 'clip-group-header';
          header.innerHTML = `
            <h2 class="clip-group-title">
              ${timeGroup}
              <span class="clip-group-count">1 clip</span>
            </h2>
            <div class="clip-group-divider"></div>
          `;
          
          const content = document.createElement('div');
          content.className = 'clip-group-content';
          
          groupElement.appendChild(header);
          groupElement.appendChild(content);
          
          // Insert the group in the correct position
          const groups = Array.from(document.querySelectorAll('.clip-group'));
          const insertIndex = groups.findIndex(g => 
            getGroupOrder(g.dataset.groupName) > getGroupOrder(timeGroup)
          );

          if (insertIndex === -1) {
            clipGrid.appendChild(groupElement);
          } else {
            clipGrid.insertBefore(groupElement, groups[insertIndex]);
          }
        }
        
        // Add the clip back to the group
        const content = groupElement.querySelector('.clip-group-content');
        content.appendChild(clipElement);
        
        // Update the group count
        const countElement = groupElement.querySelector('.clip-group-count');
        const currentCount = content.querySelectorAll('.clip-item').length;
        countElement.textContent = `${currentCount} clip${currentCount !== 1 ? 's' : ''}`;
      }
      
      // Revert data changes
      if (allClipsIndex > -1) allClips.splice(allClipsIndex, 0, clipInfo);
      if (currentClipListIndex > -1) currentClipList.splice(currentClipListIndex, 0, clipInfo);
    } finally {
      // Hide deletion tooltip
      hideDeletionTooltip();
    }

    updateClipCounter(currentClipList.length);
    
    // Update new clips indicators after deletion
    updateNewClipsIndicators();
    
    // Save clip list immediately after deletion
    try {
      await ipcRenderer.invoke('save-clip-list-immediately');
    } catch (error) {
      logger.error('Failed to save clip list after deletion:', error);
    }
  }
}

function showDeletionTooltip() {
  if (!deletionTooltip) {
    deletionTooltip = document.createElement('div');
    deletionTooltip.className = 'deletion-tooltip';
    deletionTooltip.textContent = 'Deleting files...';
    document.body.appendChild(deletionTooltip);
  }
  
  // Force a reflow to ensure the initial state is applied
  deletionTooltip.offsetHeight;
  
  deletionTooltip.classList.add('show');
  
  if (deletionTimeout) {
    clearTimeout(deletionTimeout);
  }
  
  deletionTimeout = setTimeout(() => {
    hideDeletionTooltip();
  }, 5000);
}

function hideDeletionTooltip() {
  if (deletionTooltip) {
    deletionTooltip.classList.remove('show');
  }
  if (deletionTimeout) {
    clearTimeout(deletionTimeout);
    deletionTimeout = null;
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

function handleFullscreenMouseLeave() {
  if (document.fullscreenElement) {
    hideControls();
  }
}

document.addEventListener('mouseleave', handleFullscreenMouseLeave);

function handleFullscreenChange() {
  const fullscreenPlayer = document.getElementById('fullscreen-player');
  
  if (!fullscreenPlayer) {
    logger.warn('Fullscreen player element not found');
    return;
  }
  
  try {
    if (document.fullscreenElement) {
      // Entering fullscreen
      fullscreenPlayer.classList.add('custom-fullscreen');
      document.addEventListener('mousemove', handleFullscreenMouseMove);
      logger.info('Entered fullscreen mode');
    } else {
      // Exiting fullscreen
      fullscreenPlayer.classList.remove('custom-fullscreen');
      document.removeEventListener('mousemove', handleFullscreenMouseMove);
      fullscreenPlayer.style.top = '50%';
      fullscreenPlayer.style.left = '50%';
      fullscreenPlayer.style.transform = 'translate(-50%, -50%)';
      logger.info('Exited fullscreen mode');
    }
    
    // Ensure controls are visible and reset timeout
    if (typeof showControls === 'function') {
      showControls();
    }
    resetControlsTimeout();
  } catch (error) {
    logger.error('Error handling fullscreen change:', error);
  }
}

function handleFullscreenMouseMove(e) {
  try {
    if (e.clientY >= window.innerHeight - 1) {
      if (typeof hideControlsInstantly === 'function') {
        hideControlsInstantly();
      }
    } else {
      resetControlsTimeout();
    }
  } catch (error) {
    logger.error('Error in fullscreen mouse move handler:', error);
  }
}

document.addEventListener('fullscreenchange', handleFullscreenChange);

function toggleFullscreen() {
  const fullscreenPlayer = document.getElementById('fullscreen-player');
  
  try {
    if (!document.fullscreenElement) {
      // Entering fullscreen
      if (fullscreenPlayer.requestFullscreen) {
        fullscreenPlayer.requestFullscreen();
      } else if (fullscreenPlayer.mozRequestFullScreen) {
        fullscreenPlayer.mozRequestFullScreen();
      } else if (fullscreenPlayer.webkitRequestFullscreen) {
        fullscreenPlayer.webkitRequestFullscreen();
      } else if (fullscreenPlayer.msRequestFullscreen) {
        fullscreenPlayer.msRequestFullscreen();
      }
    } else {
      // Exiting fullscreen
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (document.mozCancelFullScreen) {
        document.mozCancelFullScreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      } else if (document.msExitFullscreen) {
        document.msExitFullscreen();
      }
    }
  } catch (error) {
    logger.error('Error toggling fullscreen:', error);
  }
  
  // Reset control visibility (the actual fullscreen change will be handled by the event listener)
  if (typeof showControls === 'function') {
    showControls();
  }
  resetControlsTimeout();
}

document
  .getElementById("fullscreen-button")
  .addEventListener("click", toggleFullscreen);

function isVideoInFullscreen(videoElement) {
  return (
    document.fullscreenElement === videoElement ||
    document.webkitFullscreenElement === videoElement || // for Safari
    document.mozFullScreenElement === videoElement || // for Firefox
    document.msFullscreenElement === videoElement // for IE/Edge
  );
}

async function exportVideoWithFileSelection() {
  if (!currentClip) return;
  const savePath = await ipcRenderer.invoke("open-save-dialog", "video", currentClip.originalName, currentClip.customName);
  if (savePath) {
    await exportVideo(savePath);
  }
}

async function exportAudioWithFileSelection() {
  if (!currentClip) return;
  const savePath = await ipcRenderer.invoke("open-save-dialog", "audio", currentClip.originalName, currentClip.customName);
  if (savePath) {
    await exportAudio(savePath);
  }
}

async function exportAudioToClipboard() {
  if (!currentClip) return;
  await exportAudio();
}

async function exportVideo(savePath = null) {
  try {
    const volume = await loadVolume(currentClip.originalName);
    const speed = videoPlayer.playbackRate;
    const result = await ipcRenderer.invoke(
      "export-video",
      currentClip.originalName,
      trimStartTime,
      trimEndTime,
      volume,
      speed,
      savePath
    );
    if (result.success) {
      logger.info("Video exported successfully:", result.path);
      showExportProgress(100, 100, !savePath); // Pass true for clipboard export when no savePath
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting video:", error);
    showCustomAlert("Export failed: " + error.message);
  }
}

ipcRenderer.on('show-fallback-notice', () => {
  showFallbackNotice();
});

function showFallbackNotice() {
  const notice = document.createElement('div');
  notice.className = 'fallback-notice';
  notice.innerHTML = `
    <p>Your video is being exported using software encoding, which may be slower.</p>
    <p>For faster exports, consider installing NVIDIA CUDA Runtime and updated graphics drivers.</p>
    <button id="close-notice">Close</button>
  `;
  document.body.appendChild(notice);

  document.getElementById('close-notice').addEventListener('click', () => {
    notice.remove();
  });
}

async function exportAudio(savePath = null) {
  try {
    const volume = await loadVolume(currentClip.originalName);
    const speed = videoPlayer.playbackRate;
    const result = await ipcRenderer.invoke(
      "export-audio",
      currentClip.originalName,
      trimStartTime,
      trimEndTime,
      volume,
      speed,
      savePath
    );
    if (result.success) {
      logger.info("Audio exported successfully:", result.path);
      showExportProgress(100, 100, !savePath); // Pass true for clipboard export when no savePath
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting audio:", error);
    showCustomAlert("Audio export failed: " + error.message);
  }
}

ipcRenderer.on('ffmpeg-error', (event, message) => {
  logger.error('FFmpeg Error:', message);
});

async function exportTrimmedVideo() {
  if (!currentClip) return;

  try {
    await getFfmpegVersion();
    const volume = await loadVolume(currentClip.originalName);
    const speed = videoPlayer.playbackRate;
    logger.info(`Exporting video: ${currentClip.originalName}`);
    logger.info(`Trim start: ${trimStartTime}, Trim end: ${trimEndTime}`);
    logger.info(`Volume: ${volume}, Speed: ${speed}`);

    showExportProgress(0, 100, true); // Show initial progress

    const result = await ipcRenderer.invoke(
      "export-trimmed-video",
      currentClip.originalName,
      trimStartTime,
      trimEndTime,
      volume,
      speed
    );

    if (result.success) {
      logger.info("Trimmed video exported successfully:", result.path);
      showExportProgress(100, 100, true); // Always clipboard export for trimmed video
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting video:", error);
    logger.error("Error details:", error.stack);
    await showCustomAlert(`Export failed: ${error.message}. Please check the console for more details.`);
  }
}

async function exportClipFromContextMenu(clip) {
  try {
    const clipInfo = await ipcRenderer.invoke("get-clip-info", clip.originalName);
    const trimData = await ipcRenderer.invoke("get-trim", clip.originalName);
    const start = trimData ? trimData.start : 0;
    const end = trimData ? trimData.end : clipInfo.format.duration;
    const volume = await loadVolume(clip.originalName);
    const speed = await loadSpeed(clip.originalName);

    showExportProgress(0, 100); // Show initial progress

    const result = await ipcRenderer.invoke(
      "export-trimmed-video",
      clip.originalName,
      start,
      end,
      volume,
      speed
    );
    if (result.success) {
      logger.info("Clip exported successfully:", result.path);
      showExportProgress(100, 100, true); // Always clipboard export for context menu
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting clip:", error);
    await showCustomAlert(`Failed to export clip. Error: ${error.message}`);
  }
}

ipcRenderer.on("export-progress", (event, progress) => {
  showExportProgress(progress, 100);
});

const currentTimeDisplay = document.getElementById("current-time");
const totalTimeDisplay = document.getElementById("total-time");

function updateTimeDisplay() {
  currentTimeDisplay.textContent = formatDuration(videoPlayer.currentTime);
  totalTimeDisplay.textContent = formatDuration(videoPlayer.duration);
}

videoPlayer.addEventListener("loadedmetadata", updateTimeDisplay);
videoPlayer.addEventListener("timeupdate", updateTimeDisplay);

async function openClip(originalName, customName) {
  logger.info(`Opening clip: ${originalName}`);
  elapsedTime = 0;

  // Reset auto-seek behavior for new clip
  isAutoResetDisabled = false;
  wasLastSeekManual = false;

  // Log the previous session if one was active
  await logCurrentWatchSession();

  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }

  // Remove last-opened class from any previously highlighted clip
  document.querySelectorAll('.clip-item.last-opened').forEach(clip => {
    clip.classList.remove('last-opened');
  });

  initializeVolumeControls();
  loadingOverlay.style.display = "none";

  // Create or get thumbnail overlay
  let thumbnailOverlay = document.getElementById('thumbnail-overlay');
  if (!thumbnailOverlay) {
    thumbnailOverlay = document.createElement('img');
    thumbnailOverlay.id = 'thumbnail-overlay';
    thumbnailOverlay.style.position = 'absolute';
    thumbnailOverlay.style.top = '0';
    thumbnailOverlay.style.left = '0';
    thumbnailOverlay.style.width = '100%';
    thumbnailOverlay.style.height = '100%';
    thumbnailOverlay.style.objectFit = 'contain';
    videoPlayer.parentElement.appendChild(thumbnailOverlay);
  }

  // Hide video and show thumbnail
  videoPlayer.style.opacity = '0';
  const thumbnailPath = await ipcRenderer.invoke("get-thumbnail-path", originalName);
  if (thumbnailPath) {
    thumbnailOverlay.src = `file://${thumbnailPath}`;
    thumbnailOverlay.style.display = 'block';
  }

  // Add cleanup for previous video element
  if(videoPlayer.src) {
    videoPlayer.pause();
    videoPlayer.removeAttribute('src');
    videoPlayer.load();
  }

  // Load all data first before setting up video
  let clipInfo, trimData, clipTags;
  try {
    [clipInfo, trimData, clipTags] = await Promise.all([
      ipcRenderer.invoke("get-clip-info", originalName),
      ipcRenderer.invoke("get-trim", originalName),
      ipcRenderer.invoke("get-clip-tags", originalName)
    ]);
  } catch (error) {
    logger.error("Error loading clip data:", error);
    return;
  }

  currentClip = { originalName, customName, tags: clipTags };

  // Set up trim points before video loads
  if (trimData) {
    trimStartTime = trimData.start;
    trimEndTime = trimData.end;
    initialPlaybackTime = trimData.start;
  } else {
    trimStartTime = 0;
    trimEndTime = clipInfo.format.duration;
    initialPlaybackTime = clipInfo.format.duration > 40 ? clipInfo.format.duration / 2 : 0;
  }

  // Create a promise to handle video loading and seeking
  const videoLoadPromise = new Promise((resolve) => {
    let isMetadataLoaded = false;
    let isSeeked = false;

    const checkComplete = () => {
      if (isMetadataLoaded && isSeeked) {
        resolve();
      }
    };

    const loadHandler = () => {
      isMetadataLoaded = true;
      updateTrimControls();
      videoPlayer.currentTime = initialPlaybackTime;
      videoPlayer.removeEventListener('loadedmetadata', loadHandler);
      checkComplete();
    };

    const seekHandler = () => {
      isSeeked = true;
      videoPlayer.removeEventListener('seeked', seekHandler);
      checkComplete();
    };

    videoPlayer.addEventListener('loadedmetadata', loadHandler);
    videoPlayer.addEventListener('seeked', seekHandler);
  });

  // Set video source
  videoPlayer.src = `file://${clipInfo.format.filename}`;

  // Wait for video to fully load and seek
  await videoLoadPromise;

  await loadVolumeData();

  // Show video and play when ready
  const playPromise = new Promise((resolve) => {
    const playHandler = () => {
      videoPlayer.style.opacity = '1';
      thumbnailOverlay.style.display = 'none';
      videoPlayer.removeEventListener('playing', playHandler);
      resolve();
    };
    videoPlayer.addEventListener('playing', playHandler);
    videoPlayer.play().catch(error => {
      if (error.name !== "AbortError") {
        logger.error("Error playing video:", error);
      }
    });
  });

  clipTitle.value = customName || path.basename(originalName, path.extname(originalName));
  clipTitle.dataset.originalName = originalName;

  // Load and set the volume before playing the video
  try {
    const savedVolume = await loadVolume(originalName);
    logger.info(`Loaded volume for ${originalName}: ${savedVolume}`);
    setupAudioContext();
    gainNode.gain.setValueAtTime(savedVolume, audioContext.currentTime);
    updateVolumeSlider(savedVolume);
  } catch (error) {
    logger.error('Error loading volume:', error);
    setupAudioContext();
    gainNode.gain.setValueAtTime(1, audioContext.currentTime);
    updateVolumeSlider(1); // Default to 100%
  }

  try {
    const savedSpeed = await loadSpeed(originalName);
    logger.info(`Loaded speed for ${originalName}: ${savedSpeed}`);
    videoPlayer.playbackRate = savedSpeed;
    updateSpeedSlider(savedSpeed);
    updateSpeedText(savedSpeed);
  } catch (error) {
    logger.error('Error loading speed:', error);
    videoPlayer.playbackRate = 1;
    updateSpeedSlider(1);
    updateSpeedText(1);
  }

  playerOverlay.style.display = "block";
  fullscreenPlayer.style.display = "block";

  document.addEventListener("keydown", handleKeyPress);
  document.addEventListener("keyup", handleKeyRelease);

  // Update the clip duration in the allClips array
  const clipIndex = allClips.findIndex(
    (clip) => clip.originalName === originalName,
  );
  if (clipIndex !== -1) {
    allClips[clipIndex].duration = clipInfo.format.duration;
  }

  showLoadingOverlay();

  videoPlayer.addEventListener("loadedmetadata", async () => {
    updateTrimControls();
    videoPlayer.currentTime = initialPlaybackTime;
  }, { once: true });
  videoPlayer.addEventListener("canplay", handleVideoCanPlay);
  videoPlayer.addEventListener("progress", updateLoadingProgress);
  videoPlayer.addEventListener("waiting", showLoadingOverlay);
  videoPlayer.addEventListener("playing", hideLoadingOverlay);
  videoPlayer.addEventListener("seeked", handleVideoSeeked);

  setupClipTitleEditing();

  playerOverlay.addEventListener("click", handleOverlayClick);

  const videoContainer = document.getElementById("video-container");
  const videoControls = document.getElementById("video-controls");

  function handleMouseMove(e) {
    // Only respond to actual mouse movements
    if (e.movementX !== 0 || e.movementY !== 0) {
      resetControlsTimeout();
    }
  }

  videoContainer.addEventListener("mousemove", handleMouseMove);
  videoContainer.addEventListener("mouseenter", () => {
    showControls();
  });
  videoContainer.addEventListener("mouseleave", () => {
    isMouseOverControls = false;
    if (!videoPlayer.paused && !document.activeElement.closest('#video-controls')) {
      controlsTimeout = setTimeout(hideControls, 3000);
    }
  });

  videoPlayer.addEventListener('ended', () => {
    videoPlayer.pause();
    isPlaying = false;
    videoPlayer.currentTime = trimStartTime;
  });

  videoPlayer.addEventListener('pause', () => {
    showControls();
    if (currentClip) {
      updateDiscordPresenceForClip(currentClip, false);
    }
    // Update active duration when paused
    if (lastPlayTimestamp) {
      currentSessionActiveDuration += Date.now() - lastPlayTimestamp;
      lastPlayTimestamp = null;
    }
  });
  videoPlayer.addEventListener("play", () => {
    if (currentClip) {
      updateDiscordPresenceForClip(currentClip, true);
    }
    // Start tracking active time
    lastPlayTimestamp = Date.now();
    // Set session start time if it hasn't been set yet for this session
    if (!currentSessionStartTime) {
      currentSessionStartTime = Date.now();
    }

    showControls();
    controlsTimeout = setTimeout(hideControls, 3000);
    resetControlsTimeout();
  });

  videoControls.addEventListener("mouseenter", () => {
    isMouseOverControls = true;
    showControls();
  });

  videoControls.addEventListener("mouseleave", () => {
    isMouseOverControls = false;
    if (!videoPlayer.paused) {
      controlsTimeout = setTimeout(hideControls, 3000);
    }
  });

  // Add this for all interactive elements within the controls
  const interactiveElements = videoControls.querySelectorAll('button, input, #clip-title');
  interactiveElements.forEach(element => {
    element.addEventListener('focus', () => {
      clearTimeout(controlsTimeout);
      showControls();
    });
  
    element.addEventListener('blur', (e) => {
      // Only hide controls if we're not focusing another interactive element
      if (!e.relatedTarget || !videoControls.contains(e.relatedTarget)) {
        if (!videoPlayer.paused && !isMouseOverControls) {
          controlsTimeout = setTimeout(hideControls, 3000);
        }
      }
    });
  });

  updateNavigationButtons();

  // Clean up function to remove event listeners
  currentCleanup = () => {
    document.removeEventListener("keydown", handleKeyPress);
    document.removeEventListener("keyup", handleKeyRelease);
    videoPlayer.removeEventListener("canplay", handleVideoCanPlay);
    videoPlayer.removeEventListener("progress", updateLoadingProgress);
    videoPlayer.removeEventListener("waiting", showLoadingOverlay);
    videoPlayer.removeEventListener("playing", hideLoadingOverlay);
    videoPlayer.removeEventListener("seeked", handleVideoSeeked);
    playerOverlay.removeEventListener("click", handleOverlayClick);
  };

  updateDiscordPresenceForClip({ originalName, customName, tags: clipTags }, false); // Start paused
}

const videoControls = document.getElementById("video-controls");

function showControls() {
  videoControls.style.transition = 'none';
  videoControls.classList.add("visible");
}

function hideControls() {
  if (!videoPlayer.paused && !isMouseOverControls && !document.activeElement.closest('#video-controls')) {
    videoControls.style.transition = 'opacity 0.5s';
    videoControls.classList.remove("visible");
  }
}

// Add this new function to handle overlay clicks
function handleOverlayClick(e) {
  if (e.target === playerOverlay && !window.justFinishedDragging) {
    closePlayer();
  }
}

function handleMouseLeave(e) {
  // Check if the mouse has truly left the window/document
  if (e.clientY <= 0 || e.clientX <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
    hideControlsInstantly();
  }
}

// Add this event listener to the document
document.addEventListener('mouseleave', handleMouseLeave);

function hideControlsInstantly() {
  videoControls.classList.remove("visible");
  clearTimeout(controlsTimeout);
}

function handleVideoSeeked() {
  if (currentClip) {
    elapsedTime = Math.floor(videoPlayer.currentTime);
    // Check if the clip is private before updating Discord presence
    logger.info('Current clip:', currentClip.tags);
    if (!currentClip.tags || !currentClip.tags.includes('Private')) {
      updateDiscordPresenceForClip(currentClip, !videoPlayer.paused);
    }
  }
}

function handleVideoCanPlay() {
  if (isLoading) {
    isLoading = false;
    hideLoadingOverlay();
    videoPlayer.currentTime = initialPlaybackTime;
  }
  // Ensure thumbnail hides when video becomes playable
  videoPlayer.style.opacity = '1';
  const thumbnailOverlay = document.getElementById('thumbnail-overlay');
  if (thumbnailOverlay) {
    thumbnailOverlay.style.display = 'none';
  }
  videoPlayer.removeEventListener('canplay', handleVideoCanPlay);
}

function updateLoadingProgress() {
  if (videoPlayer.buffered.length > 0) {
    const loadedPercentage =
      (videoPlayer.buffered.end(0) / videoPlayer.duration) * 100;
    progressBar.style.backgroundImage = `linear-gradient(to right, #c2c2c2 ${loadedPercentage}%, #3a3a3a ${loadedPercentage}%)`;
  }
}

function showLoadingOverlay() {
  loadingOverlay.style.display = "flex";
}

function hideLoadingOverlay() {
  loadingOverlay.style.display = "none";
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
  if (currentClip) {
    saveTitleChange(
      currentClip.originalName,
      currentClip.customName,
      clipTitle.value,
      false,
    );
  }
}

function clipTitleFocusHandler() {
  isRenamingActive = true;

  clipTitle.dataset.originalValue = clipTitle.value;
  updateDiscordPresence('Editing clip title', currentClip.customName);
  logger.info(
    "Clip title focused. Original value:",
    clipTitle.dataset.originalValue,
  );
}

function clipTitleBlurHandler() {
  isRenamingActive = false;
  if (currentClip) {
    saveTitleChange(
      currentClip.originalName,
      currentClip.customName,
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
    document.removeEventListener("keydown", handleKeyPress);
    document.removeEventListener("keyup", handleKeyRelease);
  }

  // Capture necessary information before resetting currentClip
  const originalName = currentClip ? currentClip.originalName : null;
  const oldCustomName = currentClip ? currentClip.customName : null;
  const newCustomName = clipTitle.value;

  // Save any pending changes immediately
  saveTitleChange(originalName, oldCustomName, newCustomName, true).then(() => {
    playerOverlay.style.display = "none";
    fullscreenPlayer.style.display = "none";
    videoPlayer.pause();
    videoPlayer.removeEventListener("canplay", handleVideoCanPlay);
    videoPlayer.removeEventListener("progress", updateLoadingProgress);
    videoPlayer.removeEventListener("waiting", showLoadingOverlay);
    videoPlayer.removeEventListener("playing", hideLoadingOverlay);
    videoPlayer.removeEventListener("seeked", handleVideoSeeked);
    videoPlayer.src = "";

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
    currentClip = null;
    if (currentCleanup) {
      currentCleanup();
      currentCleanup = null;
    }
  });

  clearInterval(discordPresenceInterval);
  updateDiscordPresence('Browsing clips', `Total: ${currentClipList.length}`);
  
  // Re-enable grid navigation if controller is connected
  if (gamepadManager && gamepadManager.isGamepadConnected() && getVisibleClips().length > 0) {
    setTimeout(() => {
      enableGridNavigation();
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
    isFrameStepping = false;
    frameStepDirection = 0;
  }
}

function handleKeyPress(e) {
  const isClipTitleFocused = document.activeElement === clipTitle;
  const isSearching = document.activeElement === document.getElementById("search-input");
  const isPlayerActive = playerOverlay.style.display === "block";

  if (!isPlayerActive) return;

  showControls();

  // Resolve action from keybindings
  if (!isClipTitleFocused && !isSearching) {
    const action = keybinds.getActionFromEvent(e);
    if (!action) return;

    // Prevent default for handled keys unless explicitly allowed
    e.preventDefault();

    switch (action) {
      case 'closePlayer':
        closePlayer();
        break;
      case 'playPause':
        if (videoPlayer.src) togglePlayPause();
        break;
      case 'frameBackward':
        moveFrame(-1);
        break;
      case 'frameForward':
        moveFrame(1);
        break;
      case 'navigatePrev':
        navigateToVideo(-1);
        break;
      case 'navigateNext':
        navigateToVideo(1);
        break;
      case 'skipBackward':
        skipTime(-1);
        break;
      case 'skipForward':
        skipTime(1);
        break;
      case 'volumeUp':
        changeVolume(0.1);
        break;
      case 'volumeDown':
        changeVolume(-0.1);
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
        exportTrimmedVideo();
        break;
      case 'fullscreen':
        toggleFullscreen();
        break;
      case 'deleteClip':
        confirmAndDeleteClip();
        break;
      case 'setTrimStart':
        setTrimPoint('start');
        break;
      case 'setTrimEnd':
        setTrimPoint('end');
        break;
      case 'focusTitle':
        clipTitle.focus();
        break;
      default:
        // Unknown action - do nothing
        break;
    }
  }
}

function moveFrame(direction) {
  pauseVideoIfPlaying();

  // Track manual seek
  wasLastSeekManual = true;

  if (!isFrameStepping) {
    isFrameStepping = true;
    frameStepDirection = direction;
    lastFrameStepTime = 0;
    pendingFrameStep = false;
    requestAnimationFrame(frameStep);
  } else {
    frameStepDirection = direction;
  }
}

function frameStep(timestamp) {
  if (!isFrameStepping) return;

  const minFrameDuration = 1000 / MAX_FRAME_RATE;
  const elapsedTime = timestamp - lastFrameStepTime;

  if (elapsedTime >= minFrameDuration) {
    if (!pendingFrameStep) {
      pendingFrameStep = true;
      const newTime = Math.max(0, Math.min(videoPlayer.currentTime + frameStepDirection * (1 / 30), videoPlayer.duration));
      
      // If frame stepping outside bounds, disable auto-reset
      if (newTime < trimStartTime || newTime > trimEndTime) {
        isAutoResetDisabled = true;
      }
      
      videoPlayer.currentTime = newTime;
    }
    showControls();
  }

  requestAnimationFrame(frameStep);
}

videoPlayer.addEventListener('seeked', function() {
  if (pendingFrameStep) {
    lastFrameStepTime = performance.now();
    pendingFrameStep = false;
    updateVideoDisplay();
  }
});

function updateVideoDisplay() {
  if (videoPlayer.paused) {
    const canvas = document.createElement('canvas');
    canvas.width = videoPlayer.videoWidth;
    canvas.height = videoPlayer.videoHeight;
    canvas.getContext('2d').drawImage(videoPlayer, 0, 0, canvas.width, canvas.height);
    
    // Force a repaint of the video element
    videoPlayer.style.display = 'none';
    videoPlayer.offsetHeight; // Trigger a reflow
    videoPlayer.style.display = '';
  }
}

function calculateSkipTime(videoDuration) {
  const skipPercentage = 0.03; // 5% of total duration
  return videoDuration * skipPercentage;
}

function skipTime(direction) {
  const skipDuration = calculateSkipTime(videoPlayer.duration);
  logger.info(`Video duration: ${videoPlayer.duration.toFixed(2)}s, Skip duration: ${skipDuration.toFixed(2)}s`);
  
  // Track manual seek
  wasLastSeekManual = true;
  
  const newTime = Math.max(0, Math.min(videoPlayer.currentTime + (direction * skipDuration), videoPlayer.duration));
  
  // If seeking outside bounds, disable auto-reset
  if (newTime < trimStartTime || newTime > trimEndTime) {
    isAutoResetDisabled = true;
  }
  
  videoPlayer.currentTime = newTime;
  
  showControls();
}

function setTrimPoint(point) {
  if (point === "start") {
    trimStartTime = videoPlayer.currentTime;
  } else {
    trimEndTime = videoPlayer.currentTime;
  }
  
  // When setting trim points, we're adjusting the bounds to match current position,
  // so re-enable auto-reset since we're now inside the new bounds
  isAutoResetDisabled = false;
  wasLastSeekManual = true;
  
  updateTrimControls();
  saveTrimChanges();
}

function togglePlayPause() {
  if (!isVideoInFullscreen(videoPlayer)) {
    if (videoPlayer.paused) {
      // If the video is at the end (current time is at or very close to duration)
      // ensure we start from the trim start point
      if (Math.abs(videoPlayer.currentTime - videoPlayer.duration) < 0.1) {
        videoPlayer.currentTime = trimStartTime;
      }
      videoPlayer.play();
      isPlaying = true;
    } else {
      videoPlayer.pause();
      isPlaying = false;
    }
  }
}

videoClickTarget.addEventListener("click", (e) => {
  e.stopPropagation(); // Prevent the click from bubbling up to the overlay
  togglePlayPause();
});

function updateTrimControls() {
  const duration = videoPlayer.duration;
  const startPercent = (trimStartTime / duration) * 100;
  const endPercent = (trimEndTime / duration) * 100;

  trimStart.style.left = `${startPercent}%`;
  trimEnd.style.right = `${100 - endPercent}%`;
  progressBar.style.left = `${startPercent}%`;
  progressBar.style.right = `${100 - endPercent}%`;
}

function updatePlayhead() {
  if (!videoPlayer) return;

  const duration = videoPlayer.duration;
  const currentTime = videoPlayer.currentTime;
  const percent = (currentTime / duration) * 100;
  playhead.style.left = `${percent}%`;

  // Check if current time is outside trim bounds
  const isOutsideBounds = currentTime > trimEndTime || currentTime < trimStartTime;
  const isInsideBounds = currentTime >= trimStartTime && currentTime <= trimEndTime;
  
  // If playhead is back inside bounds, re-enable auto-reset (regardless of how it got there)
  if (isInsideBounds && isAutoResetDisabled) {
    isAutoResetDisabled = false;
  }
  
  // Only auto-reset if not disabled and outside bounds
  if (!isAutoResetDisabled && isOutsideBounds) {
    videoPlayer.currentTime = trimStartTime;
  }
  
  // Reset manual seek flag after processing
  wasLastSeekManual = false;

  // Check if the current time is within the buffered range
  let isBuffered = false;
  for (let i = 0; i < videoPlayer.buffered.length; i++) {
    if (
      currentTime >= videoPlayer.buffered.start(i) &&
      currentTime <= videoPlayer.buffered.end(i)
    ) {
      isBuffered = true;
      break;
    }
  }

  if (!isBuffered) {
    showLoadingOverlay();
  } else {
    hideLoadingOverlay();
  }

  // Request the next animation frame
  requestAnimationFrame(updatePlayhead);
}

videoPlayer.addEventListener("loadedmetadata", () => {
  requestAnimationFrame(updatePlayhead);
});

progressBarContainer.addEventListener("mousedown", (e) => {
  const rect = progressBarContainer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const width = rect.width;
  const clickPercent = x / width;

  dragStartX = e.clientX;
  
  if (Math.abs(clickPercent - trimStartTime / videoPlayer.duration) < 0.02) {
    isDragging = "start";
  } else if (Math.abs(clickPercent - trimEndTime / videoPlayer.duration) < 0.02) {
    isDragging = "end";
  }

  if (isDragging) {
    isDraggingTrim = false; // Reset drag state
    document.body.classList.add('dragging'); // Add dragging class
    document.addEventListener("mousemove", handleTrimDrag);
    document.addEventListener("mouseup", endTrimDrag);
  } else {
    // Track manual seek
    wasLastSeekManual = true;
    const newTime = clickPercent * videoPlayer.duration;
    
    // If seeking outside bounds, disable auto-reset
    if (newTime < trimStartTime || newTime > trimEndTime) {
      isAutoResetDisabled = true;
    }
    
    videoPlayer.currentTime = newTime;
  }
});

function handleTrimDrag(e) {
  const dragDistance = Math.abs(e.clientX - dragStartX);
  
  if (dragDistance > dragThreshold) {
    isDraggingTrim = true;
  }
  
  if (isDraggingTrim) {
    const rect = progressBarContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    const dragPercent = Math.max(0, Math.min(1, x / width));
    const dragTime = dragPercent * videoPlayer.duration;

    // Minimum gap between trim points (0.5 seconds)
    const minGap = 0.5;

    if (isDragging === "start") {
      // Ensure start doesn't get too close to end
      const maxStartTime = Math.max(0, trimEndTime - minGap);
      trimStartTime = Math.max(0, Math.min(dragTime, maxStartTime));
    } else if (isDragging === "end") {
      // Ensure end doesn't get too close to start
      const minEndTime = Math.min(videoPlayer.duration, trimStartTime + minGap);
      trimEndTime = Math.max(minEndTime, Math.min(videoPlayer.duration, dragTime));
    }

    updateTrimControls();
    
    // Track manual seek when dragging trim controls
    wasLastSeekManual = true;
    const newTime = isDragging === "start" ? trimStartTime : trimEndTime;
    
    // When dragging trim controls, we're adjusting the bounds themselves,
    // so we should re-enable auto-reset since we're now at the boundary
    isAutoResetDisabled = false;
    
    videoPlayer.currentTime = newTime;
    saveTrimChanges();
  }
}

function endTrimDrag(e) {
  if (!isDraggingTrim) {
    // It was just a click, not a drag
    const clickPercent = (dragStartX - progressBarContainer.getBoundingClientRect().left) / progressBarContainer.offsetWidth;
    videoPlayer.currentTime = clickPercent * videoPlayer.duration;
  }
  
  isDragging = null;
  isDraggingTrim = false;
  document.body.classList.remove('dragging');
  document.removeEventListener("mousemove", handleTrimDrag);
  document.removeEventListener("mouseup", endTrimDrag);

  // Prevent the event from propagating to the player overlay
  e.stopPropagation();
  
  // Set a flag to indicate we just finished dragging
  window.justFinishedDragging = true;
  setTimeout(() => {
    window.justFinishedDragging = false;
  }, 100); // Reset the flag after a short delay
}

// Add mousedown and mouseup event listeners to track mouse button state
document.addEventListener("mousedown", () => {
  isMouseDown = true;
});

document.addEventListener("mouseup", () => {
  isMouseDown = false;
  if (isDraggingTrim) {
    mouseUpTime = Date.now();
  }
  isDragging = null;
  isDraggingTrim = false;
});

setInterval(checkDragState, 100);

// Modify the checkDragState function
function checkDragState() {
  if ((isDragging || isDraggingTrim) && !isMouseDown) {
    const rect = progressBarContainer.getBoundingClientRect();
    if (
      lastMousePosition.x < rect.left ||
      lastMousePosition.x > rect.right ||
      lastMousePosition.y < rect.top ||
      lastMousePosition.y > rect.bottom
    ) {
      logger.info("Drag state reset due to mouse being outside the progress bar and mouse button not pressed");
      isDragging = null;
      isDraggingTrim = false;
      updateTrimControls();
    }
  }
}

let saveTrimTimeout = null;

async function updateClipDisplay(originalName) {
  return
}

async function saveTrimChanges() {
  const clipToUpdate = currentClip ? { ...currentClip } : null;
  
  if (!clipToUpdate) {
    logger.info("No clip to save trim data for");
    return;
  }

  if (saveTrimTimeout) {
    clearTimeout(saveTrimTimeout);
  }

  saveTrimTimeout = setTimeout(async () => {
    try {
      // Save trim data
      await ipcRenderer.invoke(
        "save-trim",
        clipToUpdate.originalName,
        trimStartTime,
        trimEndTime
      );
      logger.info("Trim data saved successfully");

      // Regenerate thumbnail at new start point
      const result = await ipcRenderer.invoke(
        "regenerate-thumbnail-for-trim",
        clipToUpdate.originalName,
        trimStartTime
      );

      if (result.success) {
        // Just update the thumbnail image
        const clipElement = document.querySelector(
          `.clip-item[data-original-name="${clipToUpdate.originalName}"]`
        );
        
        if (clipElement) {
          const imgElement = clipElement.querySelector(".clip-item-media-container img");
          if (imgElement) {
            // Update the thumbnail source with cache busting
            imgElement.src = `file://${result.thumbnailPath}?t=${Date.now()}`;
          }
        }
      }

      if (currentClip) {
        updateDiscordPresence('Editing a clip', currentClip.customName);
      }
    } catch (error) {
      logger.error("Error saving trim data:", error);
      showCustomAlert(`Error saving trim: ${error.message}`);
    }
  }, 500);
}

async function resetClipTrimTimes(clip) {
  try {
    const isConfirmed = await showCustomConfirm(`Reset trim times for "${clip.customName}"? This will remove any custom start/end points.`);
    
    if (!isConfirmed) return;

    // Delete trim data for the clip
    await ipcRenderer.invoke("delete-trim", clip.originalName);
    logger.info("Trim data reset successfully for:", clip.originalName);

    // If this is the currently playing clip, reset the UI trim times
    if (currentClip && currentClip.originalName === clip.originalName) {
      trimStartTime = 0;
      trimEndTime = videoPlayer.duration;
      updateTrimControls();
    }

    // Regenerate thumbnail to default (start of video)
    const result = await ipcRenderer.invoke(
      "regenerate-thumbnail-for-trim",
      clip.originalName,
      0
    );

    if (result.success) {
      // Update the thumbnail image
      const clipElement = document.querySelector(
        `.clip-item[data-original-name="${clip.originalName}"]`
      );
      
      if (clipElement) {
        const imgElement = clipElement.querySelector(".clip-item-media-container img");
        if (imgElement) {
          // Update the thumbnail source with cache busting
          imgElement.src = `file://${result.thumbnailPath}?t=${Date.now()}`;
        }
      }
    }

    await showCustomAlert("Trim times have been reset successfully.");
  } catch (error) {
    logger.error("Error resetting trim data:", error);
    await showCustomAlert(`Error resetting trim times: ${error.message}`);
  }
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
        updateClipNameInLibrary(originalName, newCustomName);
        logger.info(`Title successfully changed to: ${newCustomName}`);
        
        // Update the currentClip object
        if (currentClip && currentClip.originalName === originalName) {
          currentClip.customName = newCustomName;
        }
        
        // Update the clip in allClips array
        const clipIndex = allClips.findIndex(clip => clip.originalName === originalName);
        if (clipIndex !== -1) {
          allClips[clipIndex].customName = newCustomName;
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

function updateClipNameInLibrary(originalName, newCustomName) {
  if (!originalName) {
    logger.warn(
      "Attempted to update clip name in library with undefined originalName",
    );
    return;
  }

  const clipElement = clipGrid.querySelector(
    `[data-original-name="${originalName}"]`,
  );
  if (clipElement) {
    const clipNameElement = clipElement.querySelector(".clip-name");
    if (clipNameElement) {
      clipNameElement.textContent = newCustomName;
    }
  } else {
    logger.warn(`Clip element not found for originalName: ${originalName}`);
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


const debouncedFilterClips = debounce((filter) => {
  logger.info("Filtering clips with filter:", filter);
  logger.info("allClips length before filtering:", allClips.length);
  
  let filteredClips = [...allClips];

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

  currentClipList = filteredClips;
  renderClips(currentClipList);

  if (currentClip) {
    updateNavigationButtons();
  }

  validateClipLists();
  updateClipCounter(filteredClips.length);
  updateDiscordPresence('Browsing clips', `Filter: ${filter}, Total: ${currentClipList.length}`);
}, 300);  // 300ms debounce time

function filterClips() {
  if (selectedTags.size === 0) {
    currentClipList = [];
  } else {
    currentClipList = allClips.filter(clip => {
      // Handle untagged clips
      if (selectedTags.has('Untagged')) {
        if (!clip.tags || clip.tags.length === 0) {
          return true;
        }
      }

      if (!clip.tags || clip.tags.length === 0) {
        return false;
      }

      if (isInTemporaryMode) {
        // In temporary mode (focus mode), show clips that have ANY of the temporary selected tags
        return clip.tags.some(tag => temporaryTagSelections.has(tag));
      } else {
        // In normal mode, clips must have ALL their tags selected to be shown
        return clip.tags.every(tag => selectedTags.has(tag));
      }
    });
  }
  
  currentClipList = removeDuplicates(currentClipList);
  renderClips(currentClipList);
  updateClipCounter(currentClipList.length);
}

// Helper function to remove duplicates
function removeDuplicates(clips) {
  const seen = new Map();
  return clips.filter(clip => {
    const key = clip.originalName;
    return !seen.has(key) && seen.set(key, true);
  });
}

function validateClipLists() {
  logger.info("Validating clip lists");
  logger.info("allClips length:", allClips.length);
  logger.info("currentClipList length:", currentClipList.length);
  logger.info("Rendered clips count:", clipGrid.children.length);

  const allClipsUnique = new Set(allClips.map(clip => clip.originalName)).size === allClips.length;
  const currentClipListUnique = new Set(currentClipList.map(clip => clip.originalName)).size === currentClipList.length;

  logger.info("allClips is unique:", allClipsUnique);
  logger.info("currentClipList is unique:", currentClipListUnique);

  if (!allClipsUnique || !currentClipListUnique) {
    logger.warn("Duplicate clips detected!");
  }
}

function updateFilterDropdown() {
  const tagButton = document.getElementById('tagv2-button');
  const tagList = document.getElementById('tagv2-list');
  const tagCount = document.getElementById('tagv2-count');
  
  // Clear existing list
  tagList.innerHTML = '';
  
  // Get all unique tags and add "Untagged"
  const allTags = new Set(['Untagged', ...globalTags]);
  
  // Update count
  tagCount.textContent = `(${selectedTags.size}/${allTags.size})`;

  // Create and add the "Untagged" option first
  const untaggedItem = createTagItem('Untagged');
  tagList.appendChild(untaggedItem);
  
  // Add a separator
  const separator = document.createElement('div');
  separator.className = 'tagv2-separator';
  tagList.appendChild(separator);
  
  // Add all other tags
  globalTags.forEach(tag => {
    const tagItem = createTagItem(tag);
    tagList.appendChild(tagItem);
  });
}

function createTagItem(tag) {
  const tagItem = document.createElement('div');
  tagItem.className = `tagv2-item ${savedTagSelections.has(tag) ? 'selected' : ''}`;
  
  const label = document.createElement('span');
  label.className = 'tagv2-item-label';
  label.textContent = tag;
  
  const indicator = document.createElement('span');
  indicator.className = 'tagv2-indicator';
  
  tagItem.appendChild(label);
  tagItem.appendChild(indicator);
  
  // Separate click handlers for indicator and general tag area
  indicator.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent the click from triggering the tag click
    handleCtrlClickTag(tag, tagItem); // Reuse the ctrl+click logic for single tag focus
  });

  tagItem.addEventListener('click', (e) => {
    // Only handle clicks on the tag area, not the indicator
    if (!e.target.classList.contains('tagv2-indicator')) {
      if (e.ctrlKey || e.metaKey) {
        handleCtrlClickTag(tag, tagItem);
      } else {
        handleRegularClickTag(tag, tagItem);
      }
    }
  });
  
  return tagItem;
}

function handleCtrlClickTag(tag, tagItem) {
  if (!isInTemporaryMode || !temporaryTagSelections.has(tag)) {
    // Enter temporary mode or add to temporary selections
    enterTemporaryMode(tag);
  } else {
    // If ctrl-clicking a temporary selected tag, revert to saved selections
    exitTemporaryMode();
  }
  
  updateTagSelectionUI();
  filterClips();
}

function handleRegularClickTag(tag, tagItem) {
  if (isInTemporaryMode) {
    // If in temporary mode, regular click exits it
    exitTemporaryMode();
  } 
  
  // Toggle the tag selection
  if (savedTagSelections.has(tag)) {
    savedTagSelections.delete(tag);
  } else {
    savedTagSelections.add(tag);
  }
  selectedTags = new Set(savedTagSelections);
  saveTagPreferences();
  
  updateTagSelectionUI();
  filterClips();
}

function enterTemporaryMode(tag) {
  isInTemporaryMode = true;
  temporaryTagSelections.clear();
  temporaryTagSelections.add(tag);
  selectedTags = temporaryTagSelections; // Update the global selectedTags
}

function exitTemporaryMode() {
  isInTemporaryMode = false;
  temporaryTagSelections.clear();
  selectedTags = new Set(savedTagSelections); // Restore saved selections
}

function updateTagSelectionUI() {
  const tagItems = document.querySelectorAll('.tagv2-item');
  tagItems.forEach(item => {
    const label = item.querySelector('.tagv2-item-label').textContent;
    const isSelected = isInTemporaryMode ? 
      temporaryTagSelections.has(label) : 
      savedTagSelections.has(label);
    
    item.classList.toggle('selected', isSelected);
    
    // Add visual indicator for temporary mode
    if (isInTemporaryMode && temporaryTagSelections.has(label)) {
      item.classList.add('temp-selected');
    } else {
      item.classList.remove('temp-selected');
    }
  });
  
  updateTagCount();
}

function updateTagSelectionStates() {
  const tagItems = document.querySelectorAll('.tagv2-item');
  tagItems.forEach(item => {
    const label = item.querySelector('.tagv2-item-label').textContent;
    item.classList.toggle('selected', selectedTags.has(label));
  });
}

function updateTagCount() {
  const tagCount = document.getElementById('tagv2-count');
  const allTags = new Set(['Untagged', ...globalTags]);
  tagCount.textContent = `(${selectedTags.size}/${allTags.size})`;
}

async function saveTagPreferences() {
  try {
    await ipcRenderer.invoke('save-tag-preferences', Array.from(selectedTags));
  } catch (error) {
    logger.error('Error saving tag preferences:', error);
  }
}

function createTagFilterUI() {
  // First remove old filter dropdown if it exists
  const oldDropdown = document.getElementById('filter-dropdown');
  if (oldDropdown) {
    oldDropdown.remove();
  }

  // Create the new tag filter structure
  const tagFilter = document.createElement('div');
  tagFilter.id = 'tagv2-filter';
  tagFilter.className = 'tagv2-filter';
  
  tagFilter.innerHTML = `
    <button id="tagv2-button" class="tagv2-button">
      <span>Tags</span>
      <span id="tagv2-count">(0/0)</span>
    </button>
    <div id="tagv2-dropdown" class="tagv2-dropdown">
      <div class="tagv2-actions">
        <button id="tagv2-select-all">Show All</button>
        <button id="tagv2-deselect-all">Hide All</button>
      </div>
      <div id="tagv2-list" class="tagv2-list"></div>
    </div>
  `;

  // Find the search container and insert after it
  const searchContainer = document.getElementById('search-container');
  if (searchContainer) {
    // Look for any existing tag filters and remove them
    const existingFilters = document.querySelectorAll('.tagv2-filter');
    existingFilters.forEach(filter => filter.remove());
    
    searchContainer.after(tagFilter);
  }

  setupTagFilterEventListeners();
}

function setupTagFilterEventListeners() {
  const tagButton = document.getElementById('tagv2-button');
  const tagDropdown = document.getElementById('tagv2-dropdown');
  const tagSearch = document.getElementById('tagv2-search');
  const selectAllBtn = document.getElementById('tagv2-select-all');
  const deselectAllBtn = document.getElementById('tagv2-deselect-all');

  if (tagButton && tagDropdown) {
    // Toggle dropdown
    tagButton.addEventListener('click', (e) => {
      e.stopPropagation();
      tagDropdown.classList.toggle('show');
    });
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.tagv2-filter')) {
      tagDropdown?.classList.remove('show');
    }
  });

  if (tagSearch) {
    // Search functionality
    tagSearch.addEventListener('input', debounce(() => {
      const searchTerm = tagSearch.value.toLowerCase();
      const tagItems = document.querySelectorAll('.tagv2-item');
      
      tagItems.forEach(item => {
        const label = item.querySelector('.tagv2-item-label').textContent.toLowerCase();
        item.style.display = label.includes(searchTerm) ? '' : 'none';
      });
    }, 300));
  }

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent event from bubbling up
      exitTemporaryMode();
      savedTagSelections = new Set(['Untagged', ...globalTags]);
      selectedTags = new Set(savedTagSelections);
      saveTagPreferences();
      updateTagSelectionStates();
      updateTagCount();
      filterClips();
    });
  }
  
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent event from bubbling up
      exitTemporaryMode();
      savedTagSelections.clear();
      selectedTags.clear();
      saveTagPreferences();
      updateTagSelectionStates();
      updateTagCount();
      filterClips();
    });
  }
}

function updateDiscordPresenceBasedOnState() {
  if (currentClip) {
    updateDiscordPresenceForClip(currentClip, !videoPlayer.paused);
  } else {
    const publicClipCount = currentClipList.filter(clip => !clip.tags.includes('Private')).length;
    updateDiscordPresence('Browsing clips', `Total: ${publicClipCount}`);
  }
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 100); // Get 2 decimal places
  
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(2, '0')}`;
}

function updateDiscordPresence(details, state = null) {
  if (settings && settings.enableDiscordRPC) {
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
  lastActivityTime = Date.now();
});

document.addEventListener('keydown', () => {
  lastActivityTime = Date.now();
});

setInterval(() => {
  if (Date.now() - lastActivityTime > IDLE_TIMEOUT && !videoPlayer.playing) {
    ipcRenderer.invoke('clear-discord-presence');
  }
}, 60000); // Check every minute

ipcRenderer.on('check-activity-state', () => {
  if (Date.now() - lastActivityTime <= IDLE_TIMEOUT || videoPlayer.playing) {
    updateDiscordPresenceBasedOnState();
  }
});

function updateDiscordPresenceForClip(clip, isPlaying = true) {
  if (settings && settings.enableDiscordRPC) {
    clearInterval(discordPresenceInterval);
    
    if (clip.tags && clip.tags.includes('Private')) {
      logger.info('Private clip detected. Clearing presence');
      updateDiscordPresence('Download Clip Library now!', '');
    } else {
      if (isPlaying) {
        clipStartTime = Date.now() - (elapsedTime * 1000);
      }
      
      const updatePresence = () => {
        if (isPlaying) {
          elapsedTime = Math.floor((Date.now() - clipStartTime) / 1000);
        }
        const totalDuration = Math.floor(videoPlayer.duration);
        const timeString = `${formatTime(elapsedTime)}/${formatTime(totalDuration)}`;
        updateDiscordPresence(`${clip.customName}`, `${timeString}`);
      };

      updatePresence(); // Initial update
      
      if (isPlaying) {
        discordPresenceInterval = setInterval(updatePresence, 1000); // Update every second
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
  previewTimestamp.textContent = formatTime(time);

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
            selectedClips.add(clip.dataset.originalName);
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
      
      if (selectedClips.has(originalName) && (event.ctrlKey || event.metaKey)) {
        // Deselect if already selected and using Ctrl/Cmd
        selectedClips.delete(originalName);
        clipItem.classList.remove('selected');
        
        // Update lastSelectedClip to the previous selected clip if exists
        const selectedElements = Array.from(document.querySelectorAll('.clip-item.selected'));
        lastSelectedClip = selectedElements[selectedElements.length - 1] || null;
      } else {
        // Select the clip
        selectedClips.add(originalName);
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
  selectedClips.clear();
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
  if (e.key === 'Escape' && isInTemporaryMode) {
    exitTemporaryMode();
    updateTagSelectionUI();
    filterClips();
  }
});

function updateSelectionUI() {
  const selectionActions = document.getElementById('selection-actions');
  const selectionCount = document.getElementById('selection-count');

  if (selectedClips.size > 0) {
    selectionActions.classList.remove('hidden');
    selectionCount.textContent = `${selectedClips.size} clip${selectedClips.size !== 1 ? 's' : ''} selected`;
  } else {
    selectionActions.classList.add('hidden');
  }
}

function clearSelection() {
  document.querySelectorAll('.clip-item.selected').forEach(clip => {
    clip.classList.remove('selected');
  });
  selectedClips.clear();
  selectionStartIndex = -1;
  updateSelectionUI();
}

// Add keyboard handler for Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedClips.size > 0) {
    clearSelection();
  }
});

async function deleteSelectedClips() {
  if (selectedClips.size === 0) return;

  const isConfirmed = await showCustomConfirm(
    `Are you sure you want to delete ${selectedClips.size} clip${selectedClips.size !== 1 ? 's' : ''}? This action cannot be undone.`
  );

  if (!isConfirmed) return;

  const totalClips = selectedClips.size;
  let completed = 0;

  // Show initial progress
  showDeletionTooltip();

  try {
    const clipsToDelete = Array.from(selectedClips);
    
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
          const allClipsIndex = allClips.findIndex(clip => clip.originalName === originalName);
          const currentClipListIndex = currentClipList.findIndex(clip => clip.originalName === originalName);
          
          if (allClipsIndex > -1) allClips.splice(allClipsIndex, 1);
          if (currentClipListIndex > -1) currentClipList.splice(currentClipListIndex, 1);

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
    updateClipCounter(currentClipList.length);
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
  const deletionTooltip = document.querySelector('.deletion-tooltip');
  if (deletionTooltip) {
    deletionTooltip.textContent = `Deleting clips... ${completed}/${total}`;
  }
}

// Add event listeners for the action buttons
document.getElementById('delete-selected')?.addEventListener('click', deleteSelectedClips);
document.getElementById('clear-selection')?.addEventListener('click', clearSelection);

// Add these helper functions to renderer.js

function styleSearchText(text) {
  // Split by @mentions while preserving spaces
  return text.split(/(@\S+)/).map(part => {
    if (part.startsWith('@')) {
      return `<span class="tag-highlight">${part}</span>`;
    }
    // Preserve spaces
    return part;
  }).join('');
}

function createSearchDisplay() {
  const searchContainer = document.getElementById('search-container');
  const searchInput = document.getElementById('search-input');
  
  if (!searchContainer || !searchInput) {
    logger.error('Search container or input not found');
    return null;
  }
  
  // Create display element if it doesn't exist
  let searchDisplay = document.getElementById('search-display');
  if (!searchDisplay) {
    searchDisplay = document.createElement('div');
    searchDisplay.id = 'search-display';
    searchDisplay.contentEditable = true;
    searchDisplay.className = 'search-display';
    searchDisplay.setAttribute('role', 'textbox');
    searchDisplay.setAttribute('aria-label', 'Search input');
    
    // Replace input with display
    searchInput.style.display = 'none';
    searchContainer.appendChild(searchDisplay);
  }
  
  return searchDisplay;
}

function updateSearchDisplay() {
  const searchInput = document.getElementById('search-input');
  const searchDisplay = document.getElementById('search-display');
  
  if (!searchDisplay || !searchInput) return;
  
  // Store cursor position if there is a selection
  let savedSelection = null;
  if (window.getSelection && window.getSelection().rangeCount > 0) {
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    savedSelection = {
      node: range.startContainer,
      offset: range.startOffset
    };
  }
  
  // Update display
  const text = searchDisplay.innerText;
  searchDisplay.innerHTML = styleSearchText(text);
  
  // Update hidden input value for search functionality
  searchInput.value = text;
  
  // Trigger search
  performSearch();
  
  // Restore cursor position if we had one
  if (savedSelection) {
    const selection = window.getSelection();
    const newRange = document.createRange();
    
    // Find the appropriate text node to place the cursor
    const textNodes = [];
    const walker = document.createTreeWalker(
      searchDisplay,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    
    let node;
    while (node = walker.nextNode()) {
      textNodes.push(node);
    }
    
    if (textNodes.length > 0) {
      // Place cursor at the end if we can't find the exact position
      const lastNode = textNodes[textNodes.length - 1];
      newRange.setStart(lastNode, lastNode.length);
      newRange.collapse(true);
      
      selection.removeAllRanges();
      selection.addRange(newRange);
    }
  }
}

// Add event listeners for the search display
function setupEnhancedSearch() {
  const searchDisplay = createSearchDisplay();
  
  if (!searchDisplay) {
    logger.error('Failed to create search display');
    return;
  }
  
  searchDisplay.addEventListener('input', () => {
    updateSearchDisplay();
  });
  
  searchDisplay.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  });
  
  searchDisplay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
    }
  });
  
  // Initialize with empty content
  searchDisplay.innerHTML = '';
}

// Modify your existing document.addEventListener('DOMContentLoaded', ...) 
// to call this after the search container is definitely created
function initializeEnhancedSearch() {
  if (document.getElementById('search-container')) {
    setupEnhancedSearch();
  } else {
    logger.warn('Search container not found, waiting for DOM...');
    // Try again in a short moment
    setTimeout(initializeEnhancedSearch, 100);
  }
}

// Add this to your existing DOMContentLoaded listener
document.addEventListener('DOMContentLoaded', () => {
  initializeEnhancedSearch();
  initializeSettingsModal();
  
  // Add global click handler for modal backdrop
  const settingsModal = document.getElementById('settingsModal');
  
  // Add escape key handler
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal.style.display === 'block') {
      closeSettingsModal();
    }
  });
});

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
ipcRenderer.on('show-update-notification', (event, { currentVersion, latestVersion, changelog }) => {

  logger.info(`Renderer received update notification: ${currentVersion} -> ${latestVersion}`);
  if (!document.querySelector('.update-notification')) {
    const notification = document.createElement('div');
    notification.className = 'update-notification';
    notification.innerHTML = `
      <div class="update-notification-content">
        <span class="update-text">Update available (${latestVersion})</span>
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

    // Parse and sanitize markdown
    const changelogContainer = notification.querySelector('.changelog');
    if (changelog) {
      const parsed = marked.parse(changelog);
      changelogContainer.innerHTML = DOMPurify.sanitize(parsed);
    } else {
      changelogContainer.textContent = 'No release notes available';
    }
    document.body.appendChild(notification);
    
    // Show notification with slight delay
    setTimeout(() => {
      notification.classList.add('show');
      logger.info('Update notification shown');
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
      
      // Add progress bar
      const progressBar = document.createElement('div');
      progressBar.className = 'download-progress';
      progressBar.innerHTML = '<div class="progress-fill"></div>';
      e.currentTarget.appendChild(progressBar);
      e.currentTarget.classList.add('downloading');
      
      // Listen for progress updates
      ipcRenderer.on('download-progress', (_, progress) => {
        progressBar.querySelector('.progress-fill').style.width = `${progress}%`;
      });
    
      // Start update
      await ipcRenderer.invoke('start-update');
      
      // Cleanup
      ipcRenderer.removeAllListeners('download-progress');
    });
  }
});

window.loadingScreenTest = {
  show: () => {
    const loadingScreen = document.getElementById('loading-screen');
    if (!loadingScreen) {
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
      loadingScreen.style.display = 'flex';
      loadingScreen.style.opacity = '1';
    }
  },
  
  hide: () => {
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
      loadingScreen.style.opacity = '0';
      setTimeout(() => {
        loadingScreen.style.display = 'none';
      }, 1000);
    }
  },
  
  toggle: () => {
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen && (loadingScreen.style.display === 'none' || loadingScreen.style.opacity === '0')) {
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
  if (!volumeStartElement) {
    volumeStartElement = document.createElement('div');
    volumeStartElement.className = 'volume-start';
  }
  
  if (!volumeEndElement) {
    volumeEndElement = document.createElement('div');
    volumeEndElement.className = 'volume-end';
  }
  
  if (!volumeRegionElement) {
    volumeRegionElement = document.createElement('div');
    volumeRegionElement.className = 'volume-region';
  }

  if (!volumeDragControl) {
    volumeDragControl = document.createElement('div');
    volumeDragControl.className = 'volume-drag-control';
    const volumeInput = document.createElement('input');
    volumeInput.type = 'range';
    volumeInput.min = '0';
    volumeInput.max = '1';
    volumeInput.step = '0.1';
    volumeInput.value = '0';
    volumeDragControl.appendChild(volumeInput);
  }
  
  const progressBarContainer = document.getElementById('progress-bar-container');
  if (!progressBarContainer.contains(volumeStartElement)) {
    progressBarContainer.appendChild(volumeStartElement);
    progressBarContainer.appendChild(volumeEndElement);
    progressBarContainer.appendChild(volumeRegionElement);
    progressBarContainer.appendChild(volumeDragControl);
  }

  hideVolumeControls();
  setupVolumeControlListeners();
}

const debouncedSaveVolumeLevel = debounce(async () => {
  if (!currentClip || !isVolumeControlsVisible) return;
  
  const volumeData = {
    start: volumeStartTime,
    end: volumeEndTime,
    level: volumeLevel || 0
  };
  
  try {
    await ipcRenderer.invoke('save-volume-range', currentClip.originalName, volumeData);
    logger.info('Volume data saved with new level:', volumeData);
  } catch (error) {
    logger.error('Error saving volume data:', error);
  }
}, 300);

function setupVolumeControlListeners() {
  // Clean up existing listeners first
  volumeStartElement.removeEventListener('mousedown', handleVolumeStartDrag);
  volumeEndElement.removeEventListener('mousedown', handleVolumeEndDrag);
  document.removeEventListener('mousemove', handleVolumeDrag);
  document.removeEventListener('mouseup', endVolumeDrag);

  function handleVolumeStartDrag(e) {
    if (e.button !== 0) return; // Only handle left mouse button
    e.stopPropagation();
    isVolumeDragging = 'start';
    showVolumeDragControl(e);
    document.addEventListener('mousemove', handleVolumeDrag);
    document.addEventListener('mouseup', endVolumeDrag);
  }

  function handleVolumeEndDrag(e) {
    if (e.button !== 0) return; // Only handle left mouse button
    e.stopPropagation();
    isVolumeDragging = 'end';
    showVolumeDragControl(e);
    document.addEventListener('mousemove', handleVolumeDrag);
    document.addEventListener('mouseup', endVolumeDrag);
  }

  volumeDragControl.querySelector('input').addEventListener('input', (e) => {
    e.stopPropagation();
    volumeLevel = parseFloat(e.target.value);
    debouncedSaveVolumeLevel();
  });

  volumeDragControl.querySelector('input').addEventListener('change', (e) => {
    e.stopPropagation();
    volumeLevel = parseFloat(e.target.value);
    // Force an immediate save
    debouncedSaveVolumeLevel.flush?.() || debouncedSaveVolumeLevel();
  });

  volumeStartElement.addEventListener('mousedown', handleVolumeStartDrag);
  volumeEndElement.addEventListener('mousedown', handleVolumeEndDrag);

  // Force cleanup if window loses focus
  window.addEventListener('blur', () => {
    if (isVolumeDragging) {
      endVolumeDrag();
    }
  });
}

function handleVolumeDrag(e) {
  if (!isVolumeDragging) return;

  document.body.classList.add('dragging');

  const progressBarContainer = document.getElementById('progress-bar-container');
  const rect = progressBarContainer.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const timePosition = (x / rect.width) * videoPlayer.duration;

  if (isVolumeDragging === 'start') {
    volumeStartTime = Math.min(timePosition, volumeEndTime - 0.1);
  } else if (isVolumeDragging === 'end') {
    volumeEndTime = Math.max(timePosition, volumeStartTime + 0.1);
  }

  // Keep volume control visible and centered during drag
  updateVolumeControlsPosition();
  volumeDragControl.style.display = 'flex';
  
  // Ensure volume input stays visible
  const volumeInput = volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.style.display = 'block';
  }

  debouncedSaveVolumeData();
}

function showVolumeDragControl(e) {
  if (!isVolumeControlsVisible) return;

  const rect = progressBarContainer.getBoundingClientRect();
  volumeDragControl.style.display = 'flex';

  // If dragging, use event position
  if (e) {
    const x = e.clientX - rect.left;
    volumeDragControl.style.left = `${x}px`;
  } else {
    // Otherwise position in middle of volume range
    const startPercent = (volumeStartTime / videoPlayer.duration) * 100;
    const endPercent = (volumeEndTime / videoPlayer.duration) * 100;
    const middlePercent = (startPercent + endPercent) / 2;
    volumeDragControl.style.left = `${middlePercent}%`;
  }

  // Ensure input is visible and set to current level
  const volumeInput = volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.value = volumeLevel;
    volumeInput.style.display = 'block';
  }
}

function hideVolumeDragControl() {
  volumeDragControl.style.display = 'none';
}

function endVolumeDrag() {
  if (!isVolumeDragging) return;

  document.body.classList.remove('dragging');
  
  // Save the final position
  if (currentClip) {
    const volumeData = {
      start: volumeStartTime,
      end: volumeEndTime,
      level: volumeLevel
    };
    ipcRenderer.invoke('save-volume-range', currentClip.originalName, volumeData)
      .catch(error => logger.error('Error saving volume data:', error));
  }

  // Reset drag state but keep controls visible
  isVolumeDragging = null;
  document.removeEventListener('mousemove', handleVolumeDrag);
  document.removeEventListener('mouseup', endVolumeDrag);

  // Don't hide the volume drag control, just update its position
  updateVolumeControlsPosition();
  
  // Make sure the input stays visible
  const volumeInput = volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.style.display = 'block';
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isVolumeDragging) {
    endVolumeDrag();
  }
});

function updateVolumeControlsPosition() {
  if (!videoPlayer.duration || !isVolumeControlsVisible) return;

  const startPercent = (volumeStartTime / videoPlayer.duration) * 100;
  const endPercent = (volumeEndTime / videoPlayer.duration) * 100;

  volumeStartElement.style.left = `${startPercent}%`;
  volumeEndElement.style.left = `${endPercent}%`;
  volumeRegionElement.style.left = `${startPercent}%`;
  volumeRegionElement.style.width = `${endPercent - startPercent}%`;

  // Update volume drag control position
  if (volumeDragControl) {
    const middlePercent = (startPercent + endPercent) / 2;
    volumeDragControl.style.left = `${middlePercent}%`;
    volumeDragControl.style.display = 'flex';
  }
}

async function loadVolumeData() {
  if (!currentClip) {
    logger.warn('Attempted to load volume data without current clip');
    return;
  }
  
  try {
    const volumeData = await ipcRenderer.invoke('get-volume-range', currentClip.originalName);
    logger.info('Volume data loaded:', volumeData);

    if (volumeData && volumeData.start !== undefined && volumeData.end !== undefined) {
      volumeStartTime = volumeData.start;
      volumeEndTime = volumeData.end;
      volumeLevel = volumeData.level || 0;
      isVolumeControlsVisible = true;
      showVolumeControls();
      updateVolumeControlsPosition();
      logger.info('Volume controls restored with data:', {
        start: volumeStartTime,
        end: volumeEndTime,
        level: volumeLevel
      });
    } else {
      logger.info('No valid volume data found for:', currentClip.originalName);
      hideVolumeControls();
    }
  } catch (error) {
    logger.error('Error loading volume data:', error);
    hideVolumeControls();
  }
}

const debouncedSaveVolumeData = debounce(async () => {
  if (!currentClip || !isVolumeControlsVisible) return;
  
  const volumeData = {
    start: volumeStartTime,
    end: volumeEndTime,
    level: volumeLevel || 0
  };
  
  try {
    logger.info('Saving volume data:', volumeData);
    await ipcRenderer.invoke('save-volume-range', currentClip.originalName, volumeData);
    logger.info('Volume data saved successfully');
  } catch (error) {
    logger.error('Error saving volume data:', error);
  }
}, 300); // 300ms debounce time

function saveVolumeData() {
  debouncedSaveVolumeData();
}

function showVolumeControls() {
  isVolumeControlsVisible = true;
  volumeStartElement.style.display = 'block';
  volumeEndElement.style.display = 'block';
  volumeRegionElement.style.display = 'block';
  updateVolumeControlsPosition();
  showVolumeDragControl();
}

function hideVolumeControls() {
  isVolumeControlsVisible = false;
  volumeStartTime = 0;
  volumeEndTime = 0;
  volumeLevel = 0;
  volumeStartElement.style.display = 'none';
  volumeEndElement.style.display = 'none';
  volumeRegionElement.style.display = 'none';
  hideVolumeDragControl();
  
  // Remove volume data from storage when hiding controls
  if (currentClip) {
    ipcRenderer.invoke('save-volume-range', currentClip.originalName, null)
      .catch(error => logger.error('Error removing volume data:', error));
  }
}

function toggleVolumeControls() {
  if (!videoPlayer.duration) return;

  if (!isVolumeControlsVisible) {
    if (volumeStartTime === 0 && volumeEndTime === 0) {
      volumeStartTime = videoPlayer.duration / 3;
      volumeEndTime = (videoPlayer.duration / 3) * 2;
      volumeLevel = 0;
    }
    showVolumeControls();
  } else {
    hideVolumeControls();
  }
}

// Add this to your video timeupdate event listener
videoPlayer.addEventListener('timeupdate', () => {
  if (!audioContext || !gainNode || !isVolumeControlsVisible) return;
  
  const currentVolume = volumeSlider.value;
  if (videoPlayer.currentTime >= volumeStartTime && videoPlayer.currentTime <= volumeEndTime) {
    gainNode.gain.setValueAtTime(volumeLevel * currentVolume, audioContext.currentTime);
  } else {
    gainNode.gain.setValueAtTime(currentVolume, audioContext.currentTime);
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

// Add this helper function after getGroupOrder
function updateGroupAfterDeletion(clipElement) {
  const groupElement = clipElement.closest('.clip-group');
  if (!groupElement) return;

  const content = groupElement.querySelector('.clip-group-content');
  const remainingClips = content.querySelectorAll('.clip-item').length - 1; // -1 because the clip is not yet removed

  if (remainingClips === 0) {
    // If this was the last clip, remove the entire group
    groupElement.remove();
  } else {
    // Update the clip count
    const countElement = groupElement.querySelector('.clip-group-count');
    if (countElement) {
      countElement.textContent = `${remainingClips} clip${remainingClips !== 1 ? 's' : ''}`;
    }
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
  if (durationSeconds > 1 && currentClip) {
    try {
      await ipcRenderer.invoke('log-watch-session', {
        originalName: currentClip.originalName,
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

// inside DOMContentLoaded handler after settings loaded
loadGlobalTags();

applyIconGreyscale(settings?.iconGreyscale);

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
  const list=document.getElementById('keybinding-list'); if(!list) return; list.innerHTML=''; const bindings=require('./keybinding-manager').getAll();
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
    require('./keybinding-manager').setKeybinding(captureAction, normalizedCombo); 
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
      const keybindManager = require('./keybinding-manager');
      
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