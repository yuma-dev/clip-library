/**
 * Gamepad Manager Module
 *
 * Handles gamepad/controller input for both grid view and video player modes:
 * - Button mappings and actions
 * - Analog stick navigation
 * - Connection state management
 * - Customizable mappings
 */

// Imports
const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');

// Default mappings
// Default gamepad button mappings (Xbox controller layout)
const DEFAULT_GAMEPAD_MAPPINGS = {
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
};

// Analog stick mappings
const ANALOG_MAPPINGS = {
  leftStick: {
    xAxis: 0,    // Left stick X (horizontal navigation)
    yAxis: 1,    // Left stick Y (vertical navigation)
    deadzone: 0.4  // Higher deadzone for less sensitive grid navigation
  },
  rightStick: {
    xAxis: 2,    // Right stick X (timeline seeking)
    yAxis: 3,    // Right stick Y (volume control)
    deadzone: 0.2
  }
};

// Module state
let dependencies = null;
let isQuitConfirmVisible = false;
let originalConfirmOkText = null;
let originalConfirmCancelText = null;

/**
 * Show the quit confirmation modal in gamepad mode.
 */
function showQuitConfirmModal() {
  const modal = document.getElementById("custom-modal");
  const modalMessage = document.getElementById("modal-message");
  const modalOk = document.getElementById("modal-ok");
  const modalCancel = document.getElementById("modal-cancel");
  if (!modal || !modalMessage || !modalOk || !modalCancel) return;
  if (isQuitConfirmVisible) return;

  originalConfirmOkText = originalConfirmOkText ?? modalOk.textContent;
  originalConfirmCancelText = originalConfirmCancelText ?? modalCancel.textContent;

  modalMessage.textContent = "Quit Clip Library?";
  modalOk.textContent = "Quit (A)";
  modalCancel.textContent = "Cancel (B)";
  modalCancel.style.display = "inline-block";
  modal.style.display = "block";
  if (window.uiBlur) window.uiBlur.enable();
  modal.dataset.gamepadMode = "quit-confirm";
  modalOk.onclick = () => confirmQuit();
  modalCancel.onclick = () => hideQuitConfirmModal();
  isQuitConfirmVisible = true;
}

/**
 * Hide the quit confirmation modal and restore labels.
 */
function hideQuitConfirmModal() {
  const modal = document.getElementById("custom-modal");
  const modalOk = document.getElementById("modal-ok");
  const modalCancel = document.getElementById("modal-cancel");
  if (!modal || !modalOk || !modalCancel) return;

  if (modal.dataset.gamepadMode === "quit-confirm") {
    modal.style.display = "none";
    modal.dataset.gamepadMode = "";
    if (window.uiBlur) window.uiBlur.disable();
  }
  if (originalConfirmOkText !== null) modalOk.textContent = originalConfirmOkText;
  if (originalConfirmCancelText !== null) modalCancel.textContent = originalConfirmCancelText;
  isQuitConfirmVisible = false;
}

/**
 * Confirm quit from the gamepad modal.
 */
function confirmQuit() {
  hideQuitConfirmModal();
  ipcRenderer.invoke('quit-app');
}

// Core manager
class GamepadManager {
  constructor() {
    this.connectedGamepads = new Map();
    this.isEnabled = false;
    this.buttonMappings = { ...DEFAULT_GAMEPAD_MAPPINGS };
    this.analogMappings = { ...ANALOG_MAPPINGS };
    this.lastButtonStates = new Map();
    this.lastAnalogStates = new Map();
    this.pollInterval = null;
    this.onActionCallback = null;
    this.onNavigationCallback = null;
    this.onRawNavigationCallback = null;
    this.onConnectionCallback = null;
    this.lastQuitCombo = false;
    
    // Timing for analog stick actions
    this.seekSensitivity = 0.5;  // Seconds per second of stick movement
    this.volumeSensitivity = 0.1; // Volume change per second of stick movement
    this.lastAnalogTime = 0;
    
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Gamepad connection events
    window.addEventListener('gamepadconnected', (e) => {
      logger.info('Gamepad connected:', e.gamepad.id);
      this.onGamepadConnected(e.gamepad);
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      logger.info('Gamepad disconnected:', e.gamepad.id);
      this.onGamepadDisconnected(e.gamepad);
    });
  }

  onGamepadConnected(gamepad) {
    this.connectedGamepads.set(gamepad.index, {
      id: gamepad.id,
      index: gamepad.index,
      timestamp: gamepad.timestamp
    });
    
    this.lastButtonStates.set(gamepad.index, new Array(gamepad.buttons.length).fill(false));
    this.lastAnalogStates.set(gamepad.index, new Array(gamepad.axes.length).fill(0));
    
    if (!this.pollInterval && this.isEnabled) {
      this.startPolling();
    }
    
    // Trigger UI update if callback exists
    if (this.onConnectionCallback) {
      this.onConnectionCallback(true, gamepad.id);
    }
  }

  onGamepadDisconnected(gamepad) {
    this.connectedGamepads.delete(gamepad.index);
    this.lastButtonStates.delete(gamepad.index);
    this.lastAnalogStates.delete(gamepad.index);
    
    if (this.connectedGamepads.size === 0) {
      this.stopPolling();
    }
    
    // Trigger UI update if callback exists
    if (this.onConnectionCallback) {
      this.onConnectionCallback(false, gamepad.id);
    }
  }

  enable() {
    this.isEnabled = true;
    if (this.connectedGamepads.size > 0) {
      this.startPolling();
    }
  }

  disable() {
    this.isEnabled = false;
    this.stopPolling();
  }

  startPolling() {
    if (this.pollInterval) return;
    
    this.pollInterval = setInterval(() => {
      this.pollGamepads();
    }, 16); // ~60 FPS polling
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  pollGamepads() {
    const gamepads = navigator.getGamepads();
    
    for (let i = 0; i < gamepads.length; i++) {
      const gamepad = gamepads[i];
      if (!gamepad || !this.connectedGamepads.has(i)) continue;
      
      this.processGamepadInput(gamepad);
    }
  }

  processGamepadInput(gamepad) {
    const index = gamepad.index;
    const lastButtons = this.lastButtonStates.get(index);
    const lastAxes = this.lastAnalogStates.get(index);

    const quitComboPressed = gamepad.buttons[8]?.pressed && gamepad.buttons[9]?.pressed;
    if (quitComboPressed && !this.lastQuitCombo && this.onActionCallback) {
      this.onActionCallback('quitApp');
    }
    this.lastQuitCombo = quitComboPressed;
    
    // Process button presses (only on press, not hold)
    for (let i = 0; i < gamepad.buttons.length; i++) {
      const button = gamepad.buttons[i];
      const isPressed = button.pressed;
      const wasPressed = lastButtons[i];
      
      if (isPressed && !wasPressed) {
        // Button just pressed
        const action = this.buttonMappings[i];
        if (action && this.onActionCallback) {
          this.onActionCallback(action);
        }
      }
      
      lastButtons[i] = isPressed;
    }
    
    // Process analog sticks
    this.processAnalogInput(gamepad, lastAxes);
    
    // Update stored states
    this.lastButtonStates.set(index, lastButtons);
    this.lastAnalogStates.set(index, [...gamepad.axes]);
  }

  processAnalogInput(gamepad, lastAxes) {
    const currentTime = Date.now();
    const deltaTime = (currentTime - this.lastAnalogTime) / 1000; // Convert to seconds
    this.lastAnalogTime = currentTime;
    
    // Process right stick X for timeline seeking
    const rightStickX = gamepad.axes[this.analogMappings.rightStick.xAxis];
    if (Math.abs(rightStickX) > this.analogMappings.rightStick.deadzone) {
      const seekAmount = rightStickX * this.seekSensitivity * deltaTime;
      if (this.onNavigationCallback) {
        this.onNavigationCallback('seek', seekAmount);
      }
      // Also send raw value for grid scrolling
      if (this.onRawNavigationCallback) {
        this.onRawNavigationCallback('seekRaw', rightStickX);
      }
    }
    
    // Process right stick Y for volume control
    const rightStickY = gamepad.axes[this.analogMappings.rightStick.yAxis];
    if (Math.abs(rightStickY) > this.analogMappings.rightStick.deadzone) {
      // Invert Y axis (up is negative, but we want up to increase volume)
      const volumeAmount = -rightStickY * this.volumeSensitivity * deltaTime;
      if (this.onNavigationCallback) {
        this.onNavigationCallback('volume', volumeAmount);
      }
      // Also send raw value for grid scrolling (inverted)
      if (this.onRawNavigationCallback) {
        this.onRawNavigationCallback('volumeRaw', -rightStickY);
      }
    }
    
    // Process left stick for UI navigation (discrete movements)
    const leftStickX = gamepad.axes[this.analogMappings.leftStick.xAxis];
    const leftStickY = gamepad.axes[this.analogMappings.leftStick.yAxis];
    const lastLeftStickX = lastAxes[this.analogMappings.leftStick.xAxis] || 0;
    const lastLeftStickY = lastAxes[this.analogMappings.leftStick.yAxis] || 0;
    
    // Check for stick crossing deadzone threshold (for discrete navigation)
    if (Math.abs(leftStickX) > this.analogMappings.leftStick.deadzone && 
        Math.abs(lastLeftStickX) <= this.analogMappings.leftStick.deadzone) {
      const direction = leftStickX > 0 ? 'right' : 'left';
      if (this.onNavigationCallback) {
        this.onNavigationCallback('navigate', direction);
      }
    }
    
    if (Math.abs(leftStickY) > this.analogMappings.leftStick.deadzone && 
        Math.abs(lastLeftStickY) <= this.analogMappings.leftStick.deadzone) {
      const direction = leftStickY > 0 ? 'down' : 'up';
      if (this.onNavigationCallback) {
        this.onNavigationCallback('navigate', direction);
      }
    }
  }

  // Public methods for customization
  setButtonMapping(buttonIndex, action) {
    this.buttonMappings[buttonIndex] = action;
  }

  setActionCallback(callback) {
    this.onActionCallback = callback;
  }

  setNavigationCallback(callback) {
    this.onNavigationCallback = callback;
  }

  setRawNavigationCallback(callback) {
    this.onRawNavigationCallback = callback;
  }

  setConnectionCallback(callback) {
    this.onConnectionCallback = callback;
  }

  getConnectedGamepads() {
    return Array.from(this.connectedGamepads.values());
  }

  isGamepadConnected() {
    return this.connectedGamepads.size > 0;
  }

  // Methods for loading/saving settings
  loadMappings(mappings) {
    if (mappings.buttons) {
      this.buttonMappings = { ...DEFAULT_GAMEPAD_MAPPINGS, ...mappings.buttons };
    }
    if (mappings.analog) {
      this.analogMappings = { ...ANALOG_MAPPINGS, ...mappings.analog };
    }
  }

  getMappings() {
    return {
      buttons: this.buttonMappings,
      analog: this.analogMappings
    };
  }
}

/**
 * Handle controller button actions
 * 
 * @param {string} action - The action identifier from the gamepad mapping
 */
function handleControllerAction(action) {
  logger.info('Controller action:', action);
  
  // These will be injected by the renderer during initialization
  const {
    videoPlayer,
    playerOverlay,
    clipTitle,
    videoPlayerModule,
    navigateToVideo,
    exportAudioWithFileSelection,
    exportVideoWithFileSelection,
    exportAudioToClipboard,
    exportManagerModule,
    confirmAndDeleteClip,
    closePlayer,
    enableGridNavigation,
    disableGridNavigation,
    openCurrentGridSelection,
    moveGridSelection,
    state
  } = dependencies || {};
  
  if (!playerOverlay) return;

  // Check if we're in the video player
  const isPlayerActive = playerOverlay.style.display === "block";
  
  if (isPlayerActive) {
    if (videoPlayerModule) {
      videoPlayerModule.showControls();
    }
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
        confirmAndDeleteClip();
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
        logger.warn('Unknown controller action:', action);
        break;
    }
  } else {
    if (isQuitConfirmVisible) {
      if (action === 'playPause') {
        confirmQuit();
      } else if (action === 'closePlayer') {
        hideQuitConfirmModal();
      }
      return;
    }

    // Handle actions when in grid view
    if (!state.gridNavigationEnabled) {
      enableGridNavigation();
    }
    
    switch (action) {
      case 'closePlayer':
        showQuitConfirmModal();
        break;
      case 'quitApp':
        showQuitConfirmModal();
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

/**
 * Handle controller navigation (analog sticks)
 * 
 * Handle high-level navigation requests (grid/player).
 * @param {string} type - The navigation type ('seek', 'volume', 'navigate')
 * @param {number} value - The navigation value
 */
function handleControllerNavigation(type, value) {
  // These will be injected by the renderer during initialization
  const {
    videoPlayer,
    playerOverlay,
    videoPlayerModule,
    enableGridNavigation,
    moveGridSelection
  } = dependencies || {};
  
  if (!playerOverlay) return;

  const isPlayerActive = playerOverlay.style.display === "block";
  
  if (isPlayerActive && videoPlayer) {
    if (videoPlayerModule) {
      videoPlayerModule.showControls();
    }
    switch (type) {
      case 'seek':
        // Right stick X - timeline seeking
        if (Math.abs(value) > 0.1) { // Minimum threshold
          const newTime = Math.max(0, Math.min(videoPlayer.currentTime + value, videoPlayer.duration));
          
          // If seeking outside bounds, disable auto-reset
          // Note: This assumes state is available, might need to be injected
          if (newTime < 0 || newTime > videoPlayer.duration) {
            // state.isAutoResetDisabled = true;
          }
          
          videoPlayer.currentTime = newTime;
          videoPlayerModule.showControls();
        }
        break;
        
      case 'volume':
        // Right stick Y - volume control
        if (Math.abs(value) > 0.05) { // Minimum threshold
          videoPlayerModule.changeVolume(value);
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
        if (!dependencies || !dependencies.state.gridNavigationEnabled) {
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
/**
 * Handle raw analog navigation values.
 */
function handleControllerRawNavigation(type, value) {
  if (!dependencies || !dependencies.playerOverlay) return;
  const isPlayerActive = dependencies.playerOverlay.style.display === "block";

  if (!isPlayerActive) {
    switch (type) {
      case 'seekRaw':
        if (Math.abs(value) > 0.3) {
          const scrollAmount = value * 15;
          window.scrollBy(scrollAmount, 0);
        }
        break;

      case 'volumeRaw':
        if (Math.abs(value) > 0.3) {
          const scrollAmount = value * 15;
          window.scrollBy(0, scrollAmount);
        }
        break;

      default:
        break;
    }
  }
}

// Handle controller connection/disconnection
/**
 * Handle gamepad connect/disconnect updates.
 */
function handleControllerConnection(connected, gamepadId) {
  if (!dependencies || !dependencies.playerOverlay) return;
  const indicator = document.getElementById('controller-indicator');

  if (connected) {
    if (dependencies.state) {
      dependencies.state.isGamepadActive = true;
    }
    if (dependencies.videoPlayerModule && dependencies.playerOverlay && dependencies.playerOverlay.style.display === "block") {
      dependencies.videoPlayerModule.showControls();
    }
    if (dependencies.state && dependencies.state.gamepadManager && dependencies.state.gamepadManager.getConnectedGamepads().length === 1) {
      logger.info(`Controller connected: ${gamepadId}`);
    }

    if (indicator) {
      indicator.style.display = 'flex';
      indicator.classList.add('visible');
      indicator.title = `Controller Connected: ${gamepadId}`;
    }

    const isPlayerActive = dependencies.playerOverlay.style.display === "block";
    if (!isPlayerActive && dependencies.clipGridModule && dependencies.clipGridModule.getVisibleClips().length > 0 && !dependencies.state.gridNavigationEnabled) {
      setTimeout(() => {
        dependencies.clipGridModule.enableGridNavigation();
      }, 500);
    }
  } else {
    if (dependencies.state && dependencies.state.gamepadManager && !dependencies.state.gamepadManager.isGamepadConnected()) {
      dependencies.state.isGamepadActive = false;
      logger.info('All controllers disconnected');
      if (dependencies.videoPlayerModule) {
        dependencies.videoPlayerModule.resetControlsTimeout();
      }
    }

    if (indicator && dependencies.state && dependencies.state.gamepadManager && !dependencies.state.gamepadManager.isGamepadConnected()) {
      indicator.classList.remove('visible');
      indicator.title = 'Controller Disconnected';
      setTimeout(() => {
        if (!indicator.classList.contains('visible')) indicator.style.display = 'none';
      }, 250);
    }
  }
}

/**
 * Initialize the gamepad manager and wire dependencies.
 */
async function init(deps) {
  dependencies = deps;

  try {
    if (!dependencies || !dependencies.state) return;

    dependencies.state.gamepadManager = new GamepadManager();

    const appSettings = await ipcRenderer.invoke('get-settings');
    const controllerSettings = appSettings?.controller;

    if (controllerSettings) {
      if (controllerSettings.buttonMappings) {
        Object.entries(controllerSettings.buttonMappings).forEach(([buttonIndex, action]) => {
          dependencies.state.gamepadManager.setButtonMapping(parseInt(buttonIndex, 10), action);
        });
      }

      if (controllerSettings.seekSensitivity !== undefined) {
        dependencies.state.gamepadManager.seekSensitivity = controllerSettings.seekSensitivity;
      }
      if (controllerSettings.volumeSensitivity !== undefined) {
        dependencies.state.gamepadManager.volumeSensitivity = controllerSettings.volumeSensitivity;
      }

      if (controllerSettings.enabled) {
        dependencies.state.gamepadManager.enable();
      } else {
        dependencies.state.gamepadManager.disable();
      }
    } else {
      dependencies.state.gamepadManager.enable();
    }

    dependencies.state.gamepadManager.setActionCallback((action) => {
      handleControllerAction(action);
    });

    dependencies.state.gamepadManager.setNavigationCallback((type, value) => {
      handleControllerNavigation(type, value);
    });

    dependencies.state.gamepadManager.setRawNavigationCallback((type, value) => {
      handleControllerRawNavigation(type, value);
    });

    dependencies.state.gamepadManager.setConnectionCallback((connected, gamepadId) => {
      handleControllerConnection(connected, gamepadId);
    });

    logger.info('Gamepad manager initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize gamepad manager:', error);
  }
}

/**
 * Backwards-compatible init wrapper.
 */
async function initializeGamepadManager(deps) {
  return init(deps);
}

// Export for use in renderer
module.exports = {
  GamepadManager,
  handleControllerAction,
  handleControllerNavigation,
  handleControllerRawNavigation,
  handleControllerConnection,
  init,
  initializeGamepadManager
};
