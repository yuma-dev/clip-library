const { ipcRenderer } = require('electron');

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
    
    // Timing for analog stick actions
    this.seekSensitivity = 0.5;  // Seconds per second of stick movement
    this.volumeSensitivity = 0.1; // Volume change per second of stick movement
    this.lastAnalogTime = 0;
    
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Gamepad connection events
    window.addEventListener('gamepadconnected', (e) => {
      // Use logger if available, otherwise fallback to console
      if (typeof logger !== 'undefined' && logger.info) {
        logger.info('Gamepad connected:', e.gamepad.id);
      }
      this.onGamepadConnected(e.gamepad);
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      if (typeof logger !== 'undefined' && logger.info) {
        logger.info('Gamepad disconnected:', e.gamepad.id);
      }
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

// Export for use in renderer
module.exports = GamepadManager; 