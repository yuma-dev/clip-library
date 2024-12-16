const { ipcRenderer } = require('electron');
const logger = require('./logger');

class DebugManager {
    constructor() {
        this.isEnabled = false;
        this.debugOverlay = null;
        this.logBuffer = [];
        this.maxBufferSize = 100;
        this.frames = 0;
        this.lastTime = performance.now();
        this.statsInterval = null;
        this.animationFrameId = null;
        
        // Add state storage
        this.state = {
            allClips: [],
            currentClipList: [],
            selectedClips: new Set(),
            currentClip: null,
            isGeneratingThumbnails: false,
            completedThumbnails: 0,
            currentGenerationTotal: 0,
            gainNode: null,
            videoPlayer: null
        };
    }

    updateState(newState) {
        this.state = {
          ...this.state,
          ...newState
        };
    
        // If debug is enabled, update the UI immediately
        if (this.isEnabled) {
          this.updateStats();
        }
      }

    enable() {
        this.isEnabled = true;
        this.createDebugOverlay();
        this.attachKeyboardShortcuts();
        this.startUpdates();
        this.interceptConsole();
        logger.info('Debug mode enabled');
    }

    disable() {
        this.isEnabled = false;
        this.removeDebugOverlay();
        this.detachKeyboardShortcuts();
        this.stopUpdates();
        this.restoreConsole();
        logger.info('Debug mode disabled');
    }

    createDebugOverlay() {
        this.debugOverlay = document.createElement('div');
        this.debugOverlay.className = 'debug-overlay';
        this.debugOverlay.innerHTML = `
        <div class="debug-header">
            Debug Info
            <span class="debug-refresh-rate"></span>
        </div>
        <div class="debug-content">
            <div class="debug-section">
            <h4>Performance</h4>
            <div id="debug-fps">FPS: 0</div>
            <div id="debug-memory">Memory: --</div>
            <div id="debug-frame-time">Frame Time: 0ms</div>
            </div>
            <div class="debug-section">
            <h4>Application</h4>
            <div id="debug-clips">Total Clips: 0</div>
            <div id="debug-filtered">Filtered Clips: 0</div>
            <div id="debug-selected">Selected: 0</div>
            <div id="debug-thumbnail-status">Thumbnails: Idle</div>
            </div>
            <div class="debug-section">
            <h4>Playback</h4>
            <div id="debug-current-clip">Current: None</div>
            <div id="debug-playback-speed">Speed: 1x</div>
            <div id="debug-volume">Volume: 100%</div>
            </div>
            <div class="debug-section">
            <h4>Recent Logs</h4>
            <div id="debug-logs"></div>
            </div>
        </div>
        `;
        document.body.appendChild(this.debugOverlay);
        this.makeDraggable(this.debugOverlay);
    }

    startUpdates() {
        // Update stats every 500ms
        this.statsInterval = setInterval(() => this.updateStats(), 500);
        
        // Start the animation frame loop for FPS counting
        this.updateFrame();
    }

    stopUpdates() {
        if (this.statsInterval) {
        clearInterval(this.statsInterval);
        this.statsInterval = null;
        }
        if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
        }
    }

    updateFrame = () => {
        if (!this.isEnabled) return;

        this.frames++;
        const now = performance.now();
        const elapsed = now - this.lastTime;

        if (elapsed >= 1000) {
        const fps = Math.round((this.frames * 1000) / elapsed);
        const frameTime = Math.round(elapsed / this.frames);
        
        this.updateDebugValue('debug-fps', `FPS: ${fps}`);
        this.updateDebugValue('debug-frame-time', `Frame Time: ${frameTime}ms`);
        this.debugOverlay.querySelector('.debug-refresh-rate').textContent = `${fps} fps`;

        this.frames = 0;
        this.lastTime = now;
        }

        this.animationFrameId = requestAnimationFrame(this.updateFrame);
    }

    async updateStats() {
        if (!this.isEnabled || !this.debugOverlay) return;
    
        const {
          allClips,
          currentClipList,
          selectedClips,
          currentClip,
          isGeneratingThumbnails,
          completedThumbnails,
          currentGenerationTotal,
          gainNode
        } = this.state;
    
        // Update Application tab
        this.updateDebugValue('debug-clips', `Total Clips: ${allClips.length || 0}`);
        this.updateDebugValue('debug-filtered', `Filtered Clips: ${currentClipList.length || 0}`);
        this.updateDebugValue('debug-selected', `Selected: ${selectedClips.size || 0}`);
    
        // Update thumbnail status
        const thumbnailStatus = isGeneratingThumbnails
          ? `Thumbnails: Generating ${completedThumbnails}/${currentGenerationTotal}`
          : 'Thumbnails: Idle';
        this.updateDebugValue('debug-thumbnail-status', thumbnailStatus);
    
        // Update Playback tab
        const videoPlayer = document.getElementById('video-player');
        if (videoPlayer) {
          // Update playback speed
          const speed = videoPlayer.playbackRate || 1;
          this.updateDebugValue('debug-playback-speed', `Speed: ${speed}x`);
    
          // Update volume - check gainNode first, then video volume
          let volume = 100;
          if (gainNode && typeof gainNode.gain.value === 'number') {
            volume = Math.round(gainNode.gain.value * 100);
          } else if (typeof videoPlayer.volume === 'number') {
            volume = Math.round(videoPlayer.volume * 100);
          }
          this.updateDebugValue('debug-volume', `Volume: ${volume}%`);
    
          // Update current clip info
          const clipName = currentClip
            ? (currentClip.customName || currentClip.originalName)
            : 'None';
          this.updateDebugValue('debug-current-clip', `Current: ${clipName}`);
        }
    
        // Update memory usage
        try {
          const memoryInfo = await ipcRenderer.invoke('get-memory-usage');
          const heapUsed = Math.round(memoryInfo.heapUsed / 1024 / 1024);
          const processMemory = Math.round(memoryInfo.processMemory / 1024 / 1024);
          this.updateDebugValue('debug-memory', `Memory: ${heapUsed}MB (Process: ${processMemory}MB)`);
        } catch (error) {
          console.error('Failed to get memory usage:', error);
        }
    }

    updateDebugValue(id, value) {
        if (!this.debugOverlay) return;
        const element = this.debugOverlay.querySelector(`#${id}`);
        if (element && element.textContent !== value) {
        element.textContent = value;
        }
    }

    makeDraggable(element) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        const header = element.querySelector('.debug-header');
        
        header.onmousedown = dragMouseDown;

        function dragMouseDown(e) {
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        element.style.top = (element.offsetTop - pos2) + "px";
        element.style.left = (element.offsetLeft - pos1) + "px";
        }

        function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
        }
    }

    attachKeyboardShortcuts() {
        document.addEventListener('keydown', this.handleKeyPress);
    }

    detachKeyboardShortcuts() {
        document.removeEventListener('keydown', this.handleKeyPress);
    }

    handleKeyPress = (e) => {
        if (!this.isEnabled) return;

        // Ctrl + Shift + H to toggle debug overlay visibility
        if (e.ctrlKey && e.shiftKey && e.key === 'H') {
        this.debugOverlay.style.display = 
            this.debugOverlay.style.display === 'none' ? 'block' : 'none';
        }
        
        // Ctrl + Shift + C to clear logs
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        this.clearLogs();
        }
    }

    clearLogs() {
        if (!this.debugOverlay) return;
        const logsContainer = this.debugOverlay.querySelector('#debug-logs');
        logsContainer.innerHTML = '';
        this.logBuffer = [];
        this.addLog('Logs cleared');
    }

    addLog(message) {
        if (!this.debugOverlay) return;

        const logsContainer = this.debugOverlay.querySelector('#debug-logs');
        if (!logsContainer) return;

        const timestamp = new Date().toLocaleTimeString('en-US', { 
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
        });
        
        const logEntry = document.createElement('div');
        logEntry.className = 'debug-log-entry';
        logEntry.textContent = `[${timestamp}] ${message}`;
        
        this.logBuffer.push(logEntry);
        if (this.logBuffer.length > this.maxBufferSize) {
        this.logBuffer.shift();
        }

        logsContainer.innerHTML = '';
        this.logBuffer.forEach(entry => {
        logsContainer.appendChild(entry.cloneNode(true));
        });

        logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    interceptConsole() {
        this.originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info
        };

        console.log = (...args) => {
        this.originalConsole.log.apply(console, args);
        this.addLog(`LOG: ${args.map(arg => this.formatLogArgument(arg)).join(' ')}`);
        };

        console.warn = (...args) => {
        this.originalConsole.warn.apply(console, args);
        this.addLog(`WARN: ${args.map(arg => this.formatLogArgument(arg)).join(' ')}`);
        };

        console.error = (...args) => {
        this.originalConsole.error.apply(console, args);
        this.addLog(`ERROR: ${args.map(arg => this.formatLogArgument(arg)).join(' ')}`);
        };

        console.info = (...args) => {
        this.originalConsole.info.apply(console, args);
        this.addLog(`INFO: ${args.map(arg => this.formatLogArgument(arg)).join(' ')}`);
        };
    }

    restoreConsole() {
        if (this.originalConsole) {
        console.log = this.originalConsole.log;
        console.warn = this.originalConsole.warn;
        console.error = this.originalConsole.error;
        console.info = this.originalConsole.info;
        }
    }

    formatLogArgument(arg) {
        if (typeof arg === 'undefined') return 'undefined';
        if (arg === null) return 'null';
        if (typeof arg === 'object') {
        try {
            return JSON.stringify(arg);
        } catch (e) {
            return String(arg);
        }
        }
        return String(arg);
    }

    removeDebugOverlay() {
        if (this.debugOverlay) {
        this.debugOverlay.remove();
        this.debugOverlay = null;
        }
    }
}

// Create and export a single instance
const debugManager = new DebugManager();
module.exports = debugManager;