/**
 * gamepad input for grid view and video player: button/analog mappings
 * connection state, customizable via settings
 */

const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');

// xbox controller layout
const DEFAULT_GAMEPAD_MAPPINGS = {
  0: 'playPause',        // A
  1: 'closePlayer',      // B
  2: 'exportDefault',    // X
  3: 'fullscreen',       // Y

  4: 'navigatePrev',     // LB
  5: 'navigateNext',     // RB
  6: 'setTrimStart',     // LT
  7: 'setTrimEnd',       // RT

  8: 'focusTitle',       // back/select
  9: 'exportVideo',      // start/menu
  10: null,              // left stick click
  11: null,              // right stick click

  12: 'volumeUp',        // d-pad up
  13: 'volumeDown',      // d-pad down
  14: 'skipBackward',    // d-pad left
  15: 'skipForward'      // d-pad right
};

const ANALOG_MAPPINGS = {
  leftStick: {
    xAxis: 0,
    yAxis: 1,
    deadzone: 0.4  // higher than right stick, grid nav is less sensitive
  },
  rightStick: {
    xAxis: 2,    // timeline seek
    yAxis: 3,    // volume
    deadzone: 0.2
  }
};

let dependencies = null;
let isQuitConfirmVisible = false;
let originalConfirmOkText = null;
let originalConfirmCancelText = null;

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

function confirmQuit() {
  hideQuitConfirmModal();
  ipcRenderer.invoke('quit-app');
}

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

    this.seekSensitivity = 0.5;   // seconds per second of stick movement
    this.volumeSensitivity = 0.1; // volume change per second of stick movement
    this.lastAnalogTime = 0;
    
    this.setupEventListeners();
  }

  setupEventListeners() {
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
    }, 16); // ~60fps
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

    // fire only on press, not hold
    for (let i = 0; i < gamepad.buttons.length; i++) {
      const button = gamepad.buttons[i];
      const isPressed = button.pressed;
      const wasPressed = lastButtons[i];

      if (isPressed && !wasPressed) {
        const action = this.buttonMappings[i];
        if (action && this.onActionCallback) {
          this.onActionCallback(action);
        }
      }

      lastButtons[i] = isPressed;
    }

    this.processAnalogInput(gamepad, lastAxes);

    this.lastButtonStates.set(index, lastButtons);
    this.lastAnalogStates.set(index, [...gamepad.axes]);
  }

  processAnalogInput(gamepad, lastAxes) {
    const currentTime = Date.now();
    const deltaTime = (currentTime - this.lastAnalogTime) / 1000;
    this.lastAnalogTime = currentTime;

    const rightStickX = gamepad.axes[this.analogMappings.rightStick.xAxis];
    if (Math.abs(rightStickX) > this.analogMappings.rightStick.deadzone) {
      const seekAmount = rightStickX * this.seekSensitivity * deltaTime;
      if (this.onNavigationCallback) {
        this.onNavigationCallback('seek', seekAmount);
      }
      // raw value drives grid scrolling
      if (this.onRawNavigationCallback) {
        this.onRawNavigationCallback('seekRaw', rightStickX);
      }
    }

    const rightStickY = gamepad.axes[this.analogMappings.rightStick.yAxis];
    if (Math.abs(rightStickY) > this.analogMappings.rightStick.deadzone) {
      // up is negative on the axis but should raise volume
      const volumeAmount = -rightStickY * this.volumeSensitivity * deltaTime;
      if (this.onNavigationCallback) {
        this.onNavigationCallback('volume', volumeAmount);
      }
      if (this.onRawNavigationCallback) {
        this.onRawNavigationCallback('volumeRaw', -rightStickY);
      }
    }

    const leftStickX = gamepad.axes[this.analogMappings.leftStick.xAxis];
    const leftStickY = gamepad.axes[this.analogMappings.leftStick.yAxis];
    const lastLeftStickX = lastAxes[this.analogMappings.leftStick.xAxis] || 0;
    const lastLeftStickY = lastAxes[this.analogMappings.leftStick.yAxis] || 0;

    // discrete nav fires only when the stick crosses the deadzone
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

function handleControllerAction(action) {
  logger.info('Controller action:', action);

  // injected by the renderer at init
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

  const isPlayerActive = playerOverlay.style.display === "block";

  if (isPlayerActive) {
    if (videoPlayerModule) {
      videoPlayerModule.showControls();
    }
    const fakeEvent = {
      preventDefault: () => {},
      key: '',
      code: ''
    };

    switch (action) {
      case 'closePlayer':
        // exit fullscreen first, else close leaves the OS in fullscreen
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
            // let fullscreen exit finish before closing player
            setTimeout(() => {
              closePlayer();
            }, 100);
          } catch (error) {
            logger.error('Error exiting fullscreen before closing player:', error);
            closePlayer();
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
        openCurrentGridSelection();
        break;
      case 'exportDefault':
        openCurrentGridSelection();
        break;
      case 'volumeUp':
        moveGridSelection('up');
        break;
      case 'volumeDown':
        moveGridSelection('down');
        break;
      case 'skipBackward':
        moveGridSelection('left');
        break;
      case 'skipForward':
        moveGridSelection('right');
        break;
      default:
        break;
    }
  }
}

function handleControllerNavigation(type, value) {
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
        if (Math.abs(value) > 0.1) {
          const newTime = Math.max(0, Math.min(videoPlayer.currentTime + value, videoPlayer.duration));

          if (newTime < 0 || newTime > videoPlayer.duration) {
            // state.isAutoResetDisabled = true;
          }

          videoPlayer.currentTime = newTime;
          videoPlayerModule.showControls();
        }
        break;

      case 'volume':
        if (Math.abs(value) > 0.05) {
          videoPlayerModule.changeVolume(value);
        }
        break;

      case 'navigate':
        logger.info('Navigation direction:', value);
        break;
        
      default:
        logger.warn('Unknown navigation type:', type);
        break;
    }
  } else {
    switch (type) {
      case 'navigate':
        if (!dependencies || !dependencies.state.gridNavigationEnabled) {
          enableGridNavigation();
        }
        moveGridSelection(value);
        break;

      default:
        break;
    }
  }
}

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

// back-compat alias
async function initializeGamepadManager(deps) {
  return init(deps);
}

module.exports = {
  GamepadManager,
  handleControllerAction,
  handleControllerNavigation,
  handleControllerRawNavigation,
  handleControllerConnection,
  init,
  initializeGamepadManager
};
