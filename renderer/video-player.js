/**
 * Video Player Module
 *
 * Handles all video playback functionality including:
 * - Playback controls (play/pause, seek)
 * - Speed and volume controls
 * - Trim controls
 * - Fullscreen handling
 * - Ambient glow effects
 * - Keyboard/frame navigation
 * - Video loading and initialization
 * - Volume range controls
 * - Clip preview functionality
 */

const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');
const state = require('./state');

// ============================================================================
// DOM ELEMENT REFERENCES
// ============================================================================
let elements = {
  videoPlayer: null,
  clipTitle: null,
  progressBarContainer: null,
  progressBar: null,
  trimStart: null,
  trimEnd: null,
  playhead: null,
  loadingOverlay: null,
  playerOverlay: null,
  videoClickTarget: null,
  ambientGlowCanvas: null,
  fullscreenPlayer: null,
  videoControls: null,
  volumeButton: null,
  volumeSlider: null,
  volumeContainer: null,
  speedButton: null,
  speedSlider: null,
  speedContainer: null,
  speedText: null,
  currentTimeDisplay: null,
  totalTimeDisplay: null,
};

// Volume icons SVG
const volumeIcons = {
  normal: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M760-481q0-83-44-151.5T598-735q-15-7-22-21.5t-2-29.5q6-16 21.5-23t31.5 0q97 43 155 131.5T840-481q0 108-58 196.5T627-153q-16 7-31.5 0T574-176q-5-15 2-29.5t22-21.5q74-34 118-102.5T760-481ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm380-120q0 42-19 79.5T591-339q-10 6-20.5.5T560-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM400-606l-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`,
  muted: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="m720-424-76 76q-11 11-28 11t-28-11q-11-11-11-28t11-28l76-76-76-76q-11-11-11-28t11-28q11-11 28-11t28 11l76 76 76-76q11-11 28-11t28 11q11 11 11 28t-11 28l-76 76 76 76q11 11 11 28t-11 28q-11 11-28 11t-28-11l-76-76Zm-440 64H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`,
  low: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M360-360H240q-17 0-28.5-11.5T200-400v-160q0-17 11.5-28.5T240-600h120l132-132q19-19 43.5-8.5T560-703v446q0 27-24.5 37.5T492-228L360-360Zm380-120q0 42-19 79.5T671-339q-10 6-20.5.5T640-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM480-606l-86 86H280v80h114l86 86v-252ZM380-480Z"/></svg>`,
  high: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M760-440h-80q-17 0-28.5-11.5T640-480q0-17 11.5-28.5T680-520h80q17 0 28.5 11.5T800-480q0 17-11.5 28.5T760-440ZM584-288q10-14 26-16t30 8l64 48q14 10 16 26t-8 30q-10 14-26 16t-30-8l-64-48q-14-10-16-26t8-30Zm120-424-64 48q-14 10-30 8t-26-16q-10-14-8-30t16-26l64-48q14-10 30-8t26 16q10 14 8 30t-16 26ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`
};

// ============================================================================
// MANAGERS
// ============================================================================
let ambientGlowManager = null;
let clipGlowManager = null;

// ============================================================================
// AMBIENT GLOW MANAGER CLASS
// ============================================================================
class AmbientGlowManager {
  constructor(videoElement, canvasElement) {
    this.video = videoElement;
    this.canvas = canvasElement;
    this.ctx = null;
    this.animationFrameId = null;
    this.isActive = false;
    this.lastDrawTime = 0;
    this.frameInterval = 1000 / 30; // Cap at 30fps for performance
    this.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Temporal smoothing - blend factor (0.1 = very smooth, 0.5 = responsive, 1.0 = no smoothing)
    this.blendFactor = 0.15;

    // Bind methods
    this.draw = this.draw.bind(this);
    this.drawLoop = this.drawLoop.bind(this);
    this.handlePlay = this.handlePlay.bind(this);
    this.handlePause = this.handlePause.bind(this);
    this.handleSeeked = this.handleSeeked.bind(this);

    this.init();
  }

  init() {
    if (!this.canvas || !this.video) return;

    this.ctx = this.canvas.getContext('2d', {
      alpha: true,
      willReadFrequently: false
    });

    // Set low-resolution for performance (glow is heavily blurred anyway)
    this.canvas.width = 16;
    this.canvas.height = 9;

    // Small blur on canvas for smoother color sampling
    this.ctx.filter = 'blur(1px)';
  }

  draw(forceFullDraw = false) {
    if (!this.ctx || !this.video || this.video.readyState < 2) return;

    try {
      if (forceFullDraw) {
        // Full draw without blending (used on seek/initial load)
        this.ctx.globalAlpha = 1.0;
        this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      } else {
        // Temporal smoothing: blend new frame with existing content
        this.ctx.globalAlpha = this.blendFactor;
        this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
        this.ctx.globalAlpha = 1.0;
      }
    } catch (e) {
      // Silently handle cross-origin or video not ready errors
    }
  }

  drawLoop(timestamp) {
    if (!this.isActive) return;

    // Throttle to target framerate for performance
    const elapsed = timestamp - this.lastDrawTime;
    if (elapsed >= this.frameInterval) {
      this.draw();
      this.lastDrawTime = timestamp - (elapsed % this.frameInterval);
    }

    this.animationFrameId = requestAnimationFrame(this.drawLoop);
  }

  start() {
    if (this.prefersReducedMotion || this.isActive) return;

    this.isActive = true;
    this.canvas.classList.remove('hidden');

    // Draw initial frame
    this.draw();

    // Add event listeners
    this.video.addEventListener('play', this.handlePlay);
    this.video.addEventListener('pause', this.handlePause);
    this.video.addEventListener('ended', this.handlePause);
    this.video.addEventListener('seeked', this.handleSeeked);
    this.video.addEventListener('loadeddata', this.handleSeeked);

    // Start loop if video is already playing
    if (!this.video.paused) {
      this.handlePlay();
    }
  }

  stop() {
    this.isActive = false;
    this.canvas.classList.add('hidden');

    // Cancel animation frame
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    // Remove event listeners
    this.video.removeEventListener('play', this.handlePlay);
    this.video.removeEventListener('pause', this.handlePause);
    this.video.removeEventListener('ended', this.handlePause);
    this.video.removeEventListener('seeked', this.handleSeeked);
    this.video.removeEventListener('loadeddata', this.handleSeeked);
  }

  handlePlay() {
    if (!this.isActive) return;
    this.lastDrawTime = performance.now();
    this.animationFrameId = requestAnimationFrame(this.drawLoop);
  }

  handlePause() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    // Draw one final frame when paused
    this.draw();
  }

  handleSeeked() {
    // Update canvas immediately when video seeks (no smoothing)
    this.draw(true);
  }

  // Hide during fullscreen mode
  setFullscreen(isFullscreen) {
    if (isFullscreen) {
      this.canvas.classList.add('hidden');
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
    } else if (this.isActive) {
      this.canvas.classList.remove('hidden');
      if (!this.video.paused) {
        this.handlePlay();
      } else {
        this.draw();
      }
    }
  }
}

// ============================================================================
// CLIP GLOW MANAGER CLASS
// ============================================================================
class ClipGlowManager {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.currentClip = null;
    this.currentSource = null;
    this.animationFrameId = null;
    this.isActive = false;
    this.lastDrawTime = 0;
    this.frameInterval = 1000 / 30;
    this.blendFactor = 0.2;
    this.glowOverflow = 55;
    this.dynamicBorder = true;
    this.borderOpacity = 0.4;
    this.borderSaturationBoost = 1.4;
    this.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.draw = this.draw.bind(this);
    this.drawLoop = this.drawLoop.bind(this);
  }

  init() {
    const grid = document.getElementById('clip-grid');
    if (!grid) return;

    // Check if canvas exists AND is still in the DOM (innerHTML clearing removes it)
    if (this.canvas && this.canvas.isConnected) return;

    this.canvas = document.createElement('canvas');
    this.canvas.id = 'clip-glow-canvas';
    this.canvas.width = 16;
    this.canvas.height = 9;
    grid.style.position = 'relative';
    grid.insertBefore(this.canvas, grid.firstChild);

    this.ctx = this.canvas.getContext('2d', { alpha: true, willReadFrequently: false });
    this.ctx.filter = 'blur(1px)';
  }

  show(clipElement) {
    if (this.prefersReducedMotion || !this.canvas) return;

    this.currentClip = clipElement;

    const img = clipElement.querySelector('.clip-item-media-container img');
    if (img && img.complete && img.naturalWidth > 0) {
      this.currentSource = img;
      this.draw(true);
    }

    this.positionGlow(clipElement);
    this.canvas.classList.add('visible');
    this.isActive = true;

    this.lastDrawTime = performance.now();
    this.animationFrameId = requestAnimationFrame(this.drawLoop);
  }

  hide() {
    this.isActive = false;
    this.currentClip = null;
    this.currentSource = null;

    if (this.canvas) {
      this.canvas.classList.remove('visible');
    }

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  updateSource(videoElement) {
    if (!this.isActive) return;
    this.currentSource = videoElement;
    this.draw(true);
  }

  positionGlow(clipElement) {
    if (!this.canvas) return;

    const grid = document.getElementById('clip-grid');
    const gridRect = grid.getBoundingClientRect();
    const mediaContainer = clipElement.querySelector('.clip-item-media-container');
    const mediaRect = mediaContainer.getBoundingClientRect();

    const left = mediaRect.left - gridRect.left + grid.scrollLeft;
    const top = mediaRect.top - gridRect.top + grid.scrollTop;

    const overflow = this.glowOverflow;
    this.canvas.style.left = `${left - overflow}px`;
    this.canvas.style.top = `${top - overflow}px`;
    this.canvas.style.width = `${mediaRect.width + overflow * 2}px`;
    this.canvas.style.height = `${mediaRect.height + overflow * 2}px`;
  }

  draw(forceFullDraw = false) {
    if (!this.ctx || !this.currentSource) return;

    try {
      if (this.currentSource.tagName === 'VIDEO') {
        if (this.currentSource.readyState < 2) return;
      } else if (this.currentSource.tagName === 'IMG') {
        if (!this.currentSource.complete || this.currentSource.naturalWidth === 0) return;
      }

      if (forceFullDraw) {
        this.ctx.globalAlpha = 1.0;
        this.ctx.drawImage(this.currentSource, 0, 0, this.canvas.width, this.canvas.height);
      } else {
        this.ctx.globalAlpha = this.blendFactor;
        this.ctx.drawImage(this.currentSource, 0, 0, this.canvas.width, this.canvas.height);
        this.ctx.globalAlpha = 1.0;
      }
    } catch (e) {
      // Silently handle errors
    }
  }

  drawLoop(timestamp) {
    if (!this.isActive) return;

    if (this.currentSource && this.currentSource.tagName === 'VIDEO' && !this.currentSource.paused) {
      const elapsed = timestamp - this.lastDrawTime;
      if (elapsed >= this.frameInterval) {
        this.draw();
        this.lastDrawTime = timestamp - (elapsed % this.frameInterval);
      }
    }

    this.animationFrameId = requestAnimationFrame(this.drawLoop);
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function debounce(func, delay) {
  let timeoutId;
  const debouncedFn = function(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func.apply(this, args), delay);
  };
  debouncedFn.flush = () => {
    clearTimeout(timeoutId);
    func();
  };
  return debouncedFn;
}

function formatTime(seconds) {
  if (isNaN(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatDuration(seconds) {
  if (isNaN(seconds)) return "0:00";
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// ============================================================================
// SPEED CONTROLS
// ============================================================================

function changeSpeed(speed) {
  elements.videoPlayer.playbackRate = speed;
  updateSpeedSlider(speed);
  updateSpeedText(speed);
  showSpeedContainer();

  if (state.currentClip) {
    debouncedSaveSpeed(state.currentClip.originalName, speed);
  }
}

function updateSpeedSlider(speed) {
  if (elements.speedSlider) {
    elements.speedSlider.value = speed;
  }
}

function updateSpeedText(speed) {
  let displaySpeed;
  if (Number.isInteger(speed)) {
    displaySpeed = `${speed}x`;
  } else if (speed * 10 % 1 === 0) {
    displaySpeed = `${speed.toFixed(1)}x`;
  } else {
    displaySpeed = `${speed.toFixed(2)}x`;
  }
  elements.speedText.textContent = displaySpeed;
}

function showSpeedContainer() {
  elements.speedSlider.classList.remove("collapsed");

  clearTimeout(elements.speedContainer.timeout);
  elements.speedContainer.timeout = setTimeout(() => {
    elements.speedSlider.classList.add("collapsed");
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

// ============================================================================
// VOLUME CONTROLS
// ============================================================================

function setupAudioContext() {
  if (state.audioContext) return;
  state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  state.gainNode = state.audioContext.createGain();
  const source = state.audioContext.createMediaElementSource(elements.videoPlayer);
  source.connect(state.gainNode);
  state.gainNode.connect(state.audioContext.destination);
}

function changeVolume(delta) {
  if (!state.audioContext) setupAudioContext();

  const currentVolume = state.gainNode.gain.value;
  let newVolume = currentVolume + delta;

  newVolume = Math.round(newVolume * 100) / 100;
  newVolume = Math.min(Math.max(newVolume, 0), 2);

  state.gainNode.gain.setValueAtTime(newVolume, state.audioContext.currentTime);
  updateVolumeSlider(newVolume);
  updateVolumeIcon(newVolume);

  if (state.currentClip) {
    debouncedSaveVolume(state.currentClip.originalName, newVolume);
  }

  showVolumeContainer();
}

function updateVolumeSlider(volume) {
  elements.volumeSlider.value = volume;

  if (volume > 1) {
    elements.volumeSlider.classList.add('boosted');
  } else {
    elements.volumeSlider.classList.remove('boosted');
  }

  updateVolumeIcon(volume);
}

function updateVolumeIcon(volume) {
  if (volume === 0) {
    elements.volumeButton.innerHTML = volumeIcons.muted;
  } else if (volume < 0.5) {
    elements.volumeButton.innerHTML = volumeIcons.low;
  } else if (volume <= 1) {
    elements.volumeButton.innerHTML = volumeIcons.normal;
  } else if (volume > 1) {
    elements.volumeButton.innerHTML = volumeIcons.high;
  }
}

const debouncedSaveVolume = debounce(async (clipName, volume) => {
  try {
    await ipcRenderer.invoke("save-volume", clipName, volume);
    logger.info(`Volume saved for ${clipName}: ${volume}`);
  } catch (error) {
    logger.error('Error saving volume:', error);
  }
}, 300);

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
  elements.volumeSlider.classList.remove("collapsed");

  clearTimeout(elements.volumeContainer.timeout);
  elements.volumeContainer.timeout = setTimeout(() => {
    elements.volumeSlider.classList.add("collapsed");
  }, 2000);
}

// ============================================================================
// PLAYBACK CONTROLS
// ============================================================================

function togglePlayPause() {
  if (!isVideoInFullscreen(elements.videoPlayer)) {
    if (elements.videoPlayer.paused) {
      if (Math.abs(elements.videoPlayer.currentTime - elements.videoPlayer.duration) < 0.1) {
        elements.videoPlayer.currentTime = state.trimStartTime;
      }
      elements.videoPlayer.play();
    } else {
      elements.videoPlayer.pause();
    }
  }
}

function showControls() {
  elements.videoControls.style.transition = 'none';
  elements.videoControls.classList.add('visible');
}

function hideControls() {
  if (!elements.videoPlayer.paused && !state.isMouseOverControls && !document.activeElement.closest('#video-controls')) {
    elements.videoControls.style.transition = 'opacity 0.5s';
    elements.videoControls.classList.remove("visible");
  }
}

function hideControlsInstantly() {
  elements.videoControls.classList.remove("visible");
  clearTimeout(state.controlsTimeout);
}

function resetControlsTimeout() {
  showControls();
  clearTimeout(state.controlsTimeout);
  state.controlsTimeout = setTimeout(() => {
    hideControls();
  }, 3000);
}

function showLoadingOverlay() {
  elements.loadingOverlay.style.display = "flex";
}

function hideLoadingOverlay() {
  elements.loadingOverlay.style.display = "none";
}

// ============================================================================
// TIME DISPLAY
// ============================================================================

function updateTimeDisplay() {
  elements.currentTimeDisplay.textContent = formatDuration(elements.videoPlayer.currentTime);
  elements.totalTimeDisplay.textContent = formatDuration(elements.videoPlayer.duration);
}

// ============================================================================
// TRIM CONTROLS
// ============================================================================

function setTrimPoint(point) {
  if (point === "start") {
    state.trimStartTime = elements.videoPlayer.currentTime;
  } else {
    state.trimEndTime = elements.videoPlayer.currentTime;
  }

  state.isAutoResetDisabled = false;
  state.wasLastSeekManual = true;

  updateTrimControls();

  // Call the trim change callback for saving
  if (callbacks.onTrimChange) {
    callbacks.onTrimChange(state.trimStartTime, state.trimEndTime);
  }
}

function updateTrimControls() {
  const duration = elements.videoPlayer.duration;
  const startPercent = (state.trimStartTime / duration) * 100;
  const endPercent = (state.trimEndTime / duration) * 100;

  elements.trimStart.style.left = `${startPercent}%`;
  elements.trimEnd.style.right = `${100 - endPercent}%`;
  elements.progressBar.style.left = `${startPercent}%`;
  elements.progressBar.style.right = `${100 - endPercent}%`;
}

function updatePlayhead() {
  if (!elements.videoPlayer) return;

  const duration = elements.videoPlayer.duration;
  const currentTime = elements.videoPlayer.currentTime;
  const percent = (currentTime / duration) * 100;
  elements.playhead.style.left = `${percent}%`;

  const BOUNDS_TOLERANCE = 0.001;
  const isOutsideBounds = (currentTime > state.trimEndTime + BOUNDS_TOLERANCE) || (currentTime < state.trimStartTime - BOUNDS_TOLERANCE);
  const isInsideBounds = (currentTime >= state.trimStartTime - BOUNDS_TOLERANCE) && (currentTime <= state.trimEndTime + BOUNDS_TOLERANCE);

  if (isInsideBounds && state.isAutoResetDisabled) {
    state.isAutoResetDisabled = false;
  }

  if (!state.isAutoResetDisabled && isOutsideBounds) {
    elements.videoPlayer.currentTime = state.trimStartTime;
  }

  state.wasLastSeekManual = false;

  let isBuffered = false;
  for (let i = 0; i < elements.videoPlayer.buffered.length; i++) {
    if (
      currentTime >= elements.videoPlayer.buffered.start(i) &&
      currentTime <= elements.videoPlayer.buffered.end(i)
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

  requestAnimationFrame(updatePlayhead);
}

function handleTrimDrag(e) {
  const dragDistance = Math.abs(e.clientX - state.dragStartX);

  if (dragDistance > state.dragThreshold) {
    state.isDraggingTrim = true;
  }

  if (state.isDraggingTrim) {
    const rect = elements.progressBarContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    const dragPercent = Math.max(0, Math.min(1, x / width));
    const dragTime = dragPercent * elements.videoPlayer.duration;

    const minGap = 0.5;

    if (state.isDragging === "start") {
      const maxStartTime = Math.max(0, state.trimEndTime - minGap);
      state.trimStartTime = Math.max(0, Math.min(dragTime, maxStartTime));
    } else if (state.isDragging === "end") {
      const minEndTime = Math.min(elements.videoPlayer.duration, state.trimStartTime + minGap);
      state.trimEndTime = Math.max(minEndTime, Math.min(elements.videoPlayer.duration, dragTime));
    }

    updateTrimControls();

    state.wasLastSeekManual = true;
    const newTime = state.isDragging === "start" ? state.trimStartTime : state.trimEndTime;
    state.isAutoResetDisabled = false;
    elements.videoPlayer.currentTime = newTime;

    // Call the trim change callback for saving
    if (callbacks.onTrimChange) {
      callbacks.onTrimChange(state.trimStartTime, state.trimEndTime);
    }
  }
}

function endTrimDrag(e) {
  if (!state.isDraggingTrim) {
    const clickPercent = (state.dragStartX - elements.progressBarContainer.getBoundingClientRect().left) / elements.progressBarContainer.offsetWidth;
    elements.videoPlayer.currentTime = clickPercent * elements.videoPlayer.duration;
  }

  state.isDragging = null;
  state.isDraggingTrim = false;
  document.body.classList.remove('dragging');
  document.removeEventListener("mousemove", handleTrimDrag);
  document.removeEventListener("mouseup", endTrimDrag);

  e.stopPropagation();

  window.justFinishedDragging = true;
  setTimeout(() => {
    window.justFinishedDragging = false;
  }, 100);
}

function checkDragState() {
  if ((state.isDragging || state.isDraggingTrim) && !state.isMouseDown) {
    const rect = elements.progressBarContainer.getBoundingClientRect();
    if (
      state.lastMousePosition.x < rect.left ||
      state.lastMousePosition.x > rect.right ||
      state.lastMousePosition.y < rect.top ||
      state.lastMousePosition.y > rect.bottom
    ) {
      logger.info("Drag state reset due to mouse being outside the progress bar and mouse button not pressed");
      state.isDragging = null;
      state.isDraggingTrim = false;
      updateTrimControls();
    }
  }
}

// ============================================================================
// FULLSCREEN
// ============================================================================

function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      if (elements.fullscreenPlayer.requestFullscreen) {
        elements.fullscreenPlayer.requestFullscreen();
      } else if (elements.fullscreenPlayer.mozRequestFullScreen) {
        elements.fullscreenPlayer.mozRequestFullScreen();
      } else if (elements.fullscreenPlayer.webkitRequestFullscreen) {
        elements.fullscreenPlayer.webkitRequestFullscreen();
      } else if (elements.fullscreenPlayer.msRequestFullscreen) {
        elements.fullscreenPlayer.msRequestFullscreen();
      }
    } else {
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

  showControls();
  resetControlsTimeout();
}

function handleFullscreenChange() {
  if (!elements.fullscreenPlayer) {
    logger.warn('Fullscreen player element not found');
    return;
  }

  try {
    if (document.fullscreenElement) {
      elements.fullscreenPlayer.classList.add('custom-fullscreen');
      document.addEventListener('mousemove', handleFullscreenMouseMove);
      if (ambientGlowManager) {
        ambientGlowManager.setFullscreen(true);
      }
      logger.info('Entered fullscreen mode');
    } else {
      elements.fullscreenPlayer.classList.remove('custom-fullscreen');
      document.removeEventListener('mousemove', handleFullscreenMouseMove);
      elements.fullscreenPlayer.style.top = '51%';
      elements.fullscreenPlayer.style.left = '50%';
      elements.fullscreenPlayer.style.transform = 'translate(-50%, -50%)';
      if (ambientGlowManager) {
        ambientGlowManager.setFullscreen(false);
      }
      logger.info('Exited fullscreen mode');
    }

    showControls();
    resetControlsTimeout();
  } catch (error) {
    logger.error('Error handling fullscreen change:', error);
  }
}

function handleFullscreenMouseMove(e) {
  try {
    if (e.clientY >= window.innerHeight - 1) {
      hideControlsInstantly();
    } else {
      resetControlsTimeout();
    }
  } catch (error) {
    logger.error('Error in fullscreen mouse move handler:', error);
  }
}

function handleFullscreenMouseLeave() {
  if (document.fullscreenElement) {
    hideControls();
  }
}

function isVideoInFullscreen(videoElement) {
  return (
    document.fullscreenElement === videoElement ||
    document.webkitFullscreenElement === videoElement ||
    document.mozFullScreenElement === videoElement ||
    document.msFullscreenElement === videoElement
  );
}

// ============================================================================
// FRAME STEPPING
// ============================================================================

function moveFrame(direction) {
  state.isFrameStepping = true;
  state.frameStepDirection = direction;

  if (!state.pendingFrameStep) {
    state.pendingFrameStep = true;
    requestAnimationFrame(frameStep);
  }
}

function frameStep(timestamp) {
  if (!state.isFrameStepping) {
    state.pendingFrameStep = false;
    return;
  }

  const frameTime = 1 / 30; // Assume 30fps
  const minFrameInterval = 50; // Minimum 50ms between steps

  if (timestamp - state.lastFrameStepTime >= minFrameInterval) {
    const newTime = elements.videoPlayer.currentTime + (state.frameStepDirection * frameTime);
    elements.videoPlayer.currentTime = Math.max(0, Math.min(newTime, elements.videoPlayer.duration));
    state.lastFrameStepTime = timestamp;
  }

  if (state.isFrameStepping) {
    requestAnimationFrame(frameStep);
  } else {
    state.pendingFrameStep = false;
  }
}

// ============================================================================
// SKIP / NAVIGATION
// ============================================================================

function updateVideoDisplay() {
  if (elements.videoPlayer.paused) {
    const canvas = document.createElement('canvas');
    canvas.width = elements.videoPlayer.videoWidth;
    canvas.height = elements.videoPlayer.videoHeight;
    canvas.getContext('2d').drawImage(elements.videoPlayer, 0, 0, canvas.width, canvas.height);
    
    // Force a repaint of the video element
    elements.videoPlayer.style.display = 'none';
    // eslint-disable-next-line no-unused-expressions
    elements.videoPlayer.offsetHeight; // Trigger a reflow
    elements.videoPlayer.style.display = '';
  }
}

function calculateSkipTime(videoDuration) {
  return Math.min(5, videoDuration * 0.05);
}

function skipTime(direction) {
  const skipAmount = calculateSkipTime(elements.videoPlayer.duration);
  const newTime = elements.videoPlayer.currentTime + (direction * skipAmount);
  elements.videoPlayer.currentTime = Math.max(0, Math.min(newTime, elements.videoPlayer.duration));
}

// ============================================================================
// AMBIENT GLOW SETTINGS
// ============================================================================

function applyAmbientGlowSettings(glowSettings) {
  if (!elements.ambientGlowCanvas) return;

  const { enabled, smoothing, fps, blur, saturation, opacity } = glowSettings;

  if (ambientGlowManager) {
    if (!enabled) {
      ambientGlowManager.stop();
      return;
    }

    ambientGlowManager.blendFactor = smoothing || 0.15;
    ambientGlowManager.frameInterval = 1000 / (fps || 30);
  }

  // Apply CSS properties
  elements.ambientGlowCanvas.style.filter = `blur(${blur || 100}px) saturate(${saturation || 1.5})`;
  elements.ambientGlowCanvas.style.opacity = opacity || 0.8;
}

// ============================================================================
// ADDITIONAL VIDEO PLAYER FUNCTIONS
// ============================================================================

/**
 * Pause the video if it's currently playing
 */
function pauseVideoIfPlaying() {
  if (!elements.videoPlayer.paused) {
    elements.videoPlayer.pause();
  }
}

/**
 * Video load handler - called when video metadata is loaded
 */
function loadHandler() {
  state.isMetadataLoaded = true;
  logger.info(`[${state.currentClip.originalName}] Video metadata loaded - duration: ${elements.videoPlayer.duration}, readyState: ${elements.videoPlayer.readyState}`);
  updateTrimControls();
  
  logger.info(`[${state.currentClip.originalName}] Attempting to seek to time: ${state.initialPlaybackTime} (duration: ${elements.videoPlayer.duration})`);
  const oldTime = elements.videoPlayer.currentTime;
  elements.videoPlayer.currentTime = state.initialPlaybackTime;
  
  // Log if the time actually changed
  setTimeout(() => {
    logger.info(`[${state.currentClip.originalName}] After seek attempt - oldTime: ${oldTime}, currentTime: ${elements.videoPlayer.currentTime}, target: ${state.initialPlaybackTime}`);
  }, 50);
  
  elements.videoPlayer.removeEventListener('loadedmetadata', loadHandler);
  checkComplete();
}

/**
 * Video seek handler - called when video seeking is complete
 */
function seekHandler() {
  state.isSeeked = true;
  logger.info(`[${state.currentClip.originalName}] Video seek completed to time: ${elements.videoPlayer.currentTime}`);
  elements.videoPlayer.removeEventListener('seeked', seekHandler);
  checkComplete();
}

/**
 * Video error handler - called when there's an error loading the video
 * 
 * @param {Event} e - The error event
 */
function errorHandler(e) {
  logger.error(`[${state.currentClip.originalName}] Video error during loading:`, e);
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
  }
  elements.videoPlayer.removeEventListener('loadedmetadata', loadHandler);
  elements.videoPlayer.removeEventListener('seeked', seekHandler);
  elements.videoPlayer.removeEventListener('error', errorHandler);
  reject(new Error(`Video error: ${e.message || 'Unknown error'}`));
}

/**
 * Video play handler - called when video starts playing
 */
function playHandler() {
  elements.videoPlayer.style.opacity = '1';
  const thumbnailOverlay = document.getElementById('thumbnail-overlay');
  if (thumbnailOverlay) {
    thumbnailOverlay.style.display = 'none';
  }
  elements.videoPlayer.removeEventListener('playing', playHandler);
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
  }
  logger.info(`[${state.currentClip.originalName}] Video started playing successfully`);
  resolve();
}

/**
 * Handle video seeked event
 */
function handleVideoSeeked() {
  if (state.currentClip) {
    state.elapsedTime = Math.floor(elements.videoPlayer.currentTime);
    // Check if the clip is private before updating Discord presence
    logger.info('Current clip:', state.currentClip.tags);
    if (!state.currentClip.tags || !state.currentClip.tags.includes('Private')) {
      updateDiscordPresenceForClip(state.currentClip, !elements.videoPlayer.paused);
    }
  }
}

/**
 * Handle video canplay event
 */
function handleVideoCanPlay() {
  if (state.isLoading) {
    state.isLoading = false;
    hideLoadingOverlay();
    elements.videoPlayer.currentTime = state.initialPlaybackTime;
  }
  // Ensure thumbnail hides when video becomes playable
  elements.videoPlayer.style.opacity = '1';
  const thumbnailOverlay = document.getElementById('thumbnail-overlay');
  if (thumbnailOverlay) {
    thumbnailOverlay.style.display = 'none';
  }
  elements.videoPlayer.removeEventListener('canplay', handleVideoCanPlay);
}

/**
 * Update loading progress display
 */
function updateLoadingProgress() {
  if (elements.videoPlayer.buffered.length > 0) {
    const loadedPercentage =
      (elements.videoPlayer.buffered.end(0) / elements.videoPlayer.duration) * 100;
    elements.progressBar.style.backgroundImage = `linear-gradient(to right, #c2c2c2 ${loadedPercentage}%, #3a3a3a ${loadedPercentage}%)`;
  }
}

/**
 * End volume drag operation
 */
function endVolumeDrag() {
  if (!state.isVolumeDragging) return;

  document.body.classList.remove('dragging');
  
  // Save the final position
  if (state.currentClip) {
    const volumeData = {
      start: state.volumeStartTime,
      end: state.volumeEndTime,
      level: state.volumeLevel
    };
    ipcRenderer.invoke('save-volume-range', state.currentClip.originalName, volumeData)
      .catch(error => logger.error('Error saving volume data:', error));
  }

  // Reset drag state but keep controls visible
  state.isVolumeDragging = null;
  document.removeEventListener('mousemove', handleVolumeDrag);
  document.removeEventListener('mouseup', endVolumeDrag);

  // Don't hide the volume drag control, just update its position
  updateVolumeControlsPosition();
  
  // Make sure the input stays visible
  const volumeInput = state.volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.style.display = 'block';
  }
}

/**
 * Load volume data for current clip
 */
async function loadVolumeData() {
  if (!state.currentClip) {
    logger.warn('Attempted to load volume data without current clip');
    return;
  }
  
  try {
    const volumeData = await ipcRenderer.invoke('get-volume-range', state.currentClip.originalName);
    logger.info('Volume data loaded:', volumeData);

    if (volumeData && volumeData.start !== undefined && volumeData.end !== undefined) {
      state.volumeStartTime = volumeData.start;
      state.volumeEndTime = volumeData.end;
      state.volumeLevel = volumeData.level || 0;
      state.isVolumeControlsVisible = true;
      showVolumeControls();
      updateVolumeControlsPosition();
      logger.info('Volume controls restored with data:', {
        start: state.volumeStartTime,
        end: state.volumeEndTime,
        level: state.volumeLevel
      });
    } else {
      logger.info('No valid volume data found for:', state.currentClip.originalName);
      hideVolumeControls();
    }
  } catch (error) {
    logger.error('Error loading volume data:', error);
    hideVolumeControls();
  }
}

/**
 * Hide volume controls
 */
function hideVolumeControls() {
  state.isVolumeControlsVisible = false;
  state.volumeStartTime = 0;
  state.volumeEndTime = 0;
  state.volumeLevel = 0;
  state.volumeStartElement.style.display = 'none';
  state.volumeEndElement.style.display = 'none';
  state.volumeRegionElement.style.display = 'none';
  hideVolumeDragControl();
  
  // Remove volume data from storage when hiding controls
  if (state.currentClip) {
    ipcRenderer.invoke('save-volume-range', state.currentClip.originalName, null)
      .catch(error => logger.error('Error removing volume data:', error));
  }
}

/**
 * Preload clip data on hover for faster opening
 * 
 * @param {string} originalName - The original name of the clip
 * @returns {Promise<Object|null>} The preloaded clip data or null if failed
 */
async function preloadClipData(originalName) {
  // Check if already cached and not expired
  const cached = state.clipDataCache.get(originalName);
  if (cached && (Date.now() - cached.timestamp) < state.CACHE_EXPIRY_MS) {
    return cached.data;
  }

  try {
    // Preload in parallel
    const [clipInfo, trimData, clipTags, thumbnailPath] = await Promise.all([
      ipcRenderer.invoke("get-clip-info", originalName),
      ipcRenderer.invoke("get-trim", originalName),
      ipcRenderer.invoke("get-clip-tags", originalName),
      ipcRenderer.invoke("get-thumbnail-path", originalName)
    ]);

    const data = { clipInfo, trimData, clipTags, thumbnailPath };
    state.clipDataCache.set(originalName, { data, timestamp: Date.now() });

    // Limit cache size
    if (state.clipDataCache.size > 50) {
      const oldestKey = state.clipDataCache.keys().next().value;
      state.clipDataCache.delete(oldestKey);
    }

    return data;
  } catch (error) {
    logger.warn(`[Preload] Failed to preload ${originalName}:`, error.message);
    return null;
  }
}

/**
 * Handle mouse enter event on clip elements
 * 
 * @param {Object} clip - The clip object
 * @param {HTMLElement} clipElement - The clip element
 */
async function handleMouseEnter(clip, clipElement) {
  // OPTIMIZATION: Preload clip data on hover for faster opening
  preloadClipData(clip.originalName).catch(() => {});

  // Show ambient glow behind clip
  const clipGlowManager = getClipGlowManager();
  if (clipGlowManager) {
    clipGlowManager.show(clipElement);
  }

  if (clipElement.classList.contains("video-preview-disabled")) return;

  // Clear any existing preview immediately
  cleanupVideoPreview();

  // Store the current preview context
  const currentPreviewContext = {};
  state.activePreview = currentPreviewContext;

  // Set a small delay before creating the preview
  state.previewCleanupTimeout = setTimeout(async () => {
    // Check if this preview is still the active one
    if (state.activePreview !== currentPreviewContext) return;

    try {
      const trimData = await ipcRenderer.invoke("get-trim", clip.originalName);
      const clipInfo = await ipcRenderer.invoke("get-clip-info", clip.originalName);
      
      // Check again if this preview is still active
      if (state.activePreview !== currentPreviewContext) return;

      let startTime;
      if (trimData) {
        startTime = trimData.start;
      } else {
        startTime = clipInfo.format.duration > 40 ? clipInfo.format.duration / 2 : 0;
      }

      // Final check before creating video element
      if (state.activePreview !== currentPreviewContext) return;

      // Get the current preview volume setting
      const currentPreviewVolume = document.getElementById('previewVolumeSlider')?.value ?? state.settings?.previewVolume ?? 0.1;

      videoElement = document.createElement("video");
      videoElement.src = `file://${path.join(state.clipLocation, clip.originalName)}`;
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
        if (state.activePreview !== currentPreviewContext || !clipElement.matches(':hover')) {
          cleanupVideoPreview();
          return;
        }

        imgElement.style.display = "none";
        videoElement.currentTime = startTime;
        videoElement.play().then(() => {
          // Update glow to sample from video instead of thumbnail
          const clipGlowManager = getClipGlowManager();
          if (clipGlowManager) {
            clipGlowManager.updateSource(videoElement);
          }
        }).catch((error) => {
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

/**
 * Export clip from context menu
 * 
 * @param {Object} clip - The clip object to export
 */
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

/**
 * Open a clip for playback
 * 
 * @param {string} originalName - The original name of the clip
 * @param {string} customName - The custom name of the clip
 */
async function openClip(originalName, customName) {
  logger.info(`Opening clip: ${originalName}`);
  
  // Performance timing for benchmark mode
  const timings = {};
  const startTime = performance.now();
  const mark = (name) => {
    timings[name] = performance.now() - startTime;
    if (isBenchmarkMode) {
      logger.info(`[TIMING] ${name}: ${timings[name].toFixed(1)}ms`);
    }
  };
  mark('start');
  
  state.elapsedTime = 0;

  // Reset auto-seek behavior for new clip
  state.isAutoResetDisabled = false;
  state.wasLastSeekManual = false;

  // Log the previous session if one was active
  await logCurrentWatchSession();
  mark('logSession');

  if (state.currentCleanup) {
    state.currentCleanup();
    state.currentCleanup = null;
  }

  // Remove last-opened class from any previously highlighted clip
  document.querySelectorAll('.clip-item.last-opened').forEach(clip => {
    clip.classList.remove('last-opened');
  });

  initializeVolumeControls();
  elements.loadingOverlay.style.display = "none";

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
    elements.videoPlayer.parentElement.appendChild(thumbnailOverlay);
  }

  logger.info(`[${originalName}] Setting up thumbnail overlay`);
  // Hide video and show thumbnail
  elements.videoPlayer.style.opacity = '0';
  
  // OPTIMIZATION: Show player overlay IMMEDIATELY with thumbnail
  // This gives instant visual feedback while video loads in background
  elements.playerOverlay.style.display = "block";
  elements.fullscreenPlayer.style.display = "block";
  mark('playerVisibleEarly');
  
  // OPTIMIZATION: Check if data was preloaded on hover
  let clipInfo, trimData, clipTags, thumbnailPath;
  const cachedData = await getCachedClipData(originalName);
  
  if (cachedData) {
    // Use cached data - much faster!
    clipInfo = cachedData.clipInfo;
    trimData = cachedData.trimData;
    clipTags = cachedData.clipTags;
    thumbnailPath = cachedData.thumbnailPath;
    mark('usedCachedData');
    logger.info(`[${originalName}] Using preloaded cached data`);
  } else {
    // No cache - load fresh (parallel fetch for speed)
    logger.info(`[${originalName}] Loading clip data (not cached)...`);
    try {
      [clipInfo, trimData, clipTags, thumbnailPath] = await Promise.all([
        ipcRenderer.invoke("get-clip-info", originalName),
        ipcRenderer.invoke("get-trim", originalName),
        ipcRenderer.invoke("get-clip-tags", originalName),
        getThumbnailPath(originalName)  // Use cache-aware helper
      ]);
      mark('fetchedClipData');
    } catch (error) {
      logger.error(`[${originalName}] Error loading clip data:`, error);
      return;
    }
  }
  mark('getClipData');
  
  // Set up thumbnail
  if (thumbnailPath) {
    thumbnailOverlay.src = `file://${thumbnailPath}`;
    thumbnailOverlay.style.display = 'block';
    logger.info(`[${originalName}] Thumbnail loaded: ${thumbnailPath}`);
  } else {
    logger.warn(`[${originalName}] No thumbnail path found`);
  }

  // Add cleanup for previous video element
  if(elements.videoPlayer.src) {
    logger.info(`[${originalName}] Cleaning up previous video`);
    elements.videoPlayer.pause();
    elements.videoPlayer.removeAttribute('src');
    elements.videoPlayer.load();
  }
  mark('cleanupPrevious');
  
  logger.info(`[${originalName}] Clip data ready. Duration: ${clipInfo?.format?.duration}, Trim: ${trimData ? 'Yes' : 'No'}, Tags: ${clipTags?.length || 0}`);

  state.currentClip = { originalName, customName, tags: clipTags };

  // Set up trim points before video loads
  if (trimData) {
    state.trimStartTime = trimData.start;
    state.trimEndTime = trimData.end;
    state.initialPlaybackTime = trimData.start;
    logger.info(`[${originalName}] Using trim data - Start: ${state.trimStartTime}, End: ${state.trimEndTime}, Initial: ${state.initialPlaybackTime}`);
  } else {
    state.trimStartTime = 0;
    state.trimEndTime = clipInfo.format.duration;
    state.initialPlaybackTime = clipInfo.format.duration > 40 ? clipInfo.format.duration / 2 : 0;
    logger.info(`[${originalName}] No trim data - Start: ${state.trimStartTime}, End: ${state.trimEndTime}, Initial: ${state.initialPlaybackTime}`);
  }

  logger.info(`[${originalName}] Setting up video load promise...`);
  // Create a promise to handle video loading and seeking
  const videoLoadPromise = new Promise((resolve, reject) => {
    let isMetadataLoaded = false;
    let isSeeked = false;
    let timeoutId;

    const checkComplete = () => {
      if (isMetadataLoaded && isSeeked) {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        logger.info(`[${originalName}] Video load promise resolved - metadata and seek complete`);
        resolve();
      }
    };

    const loadHandler = () => {
      isMetadataLoaded = true;
      logger.info(`[${originalName}] Video metadata loaded - duration: ${elements.videoPlayer.duration}, readyState: ${elements.videoPlayer.readyState}`);
      updateTrimControls();
      
      logger.info(`[${originalName}] Attempting to seek to time: ${state.initialPlaybackTime} (duration: ${elements.videoPlayer.duration})`);
      const oldTime = elements.videoPlayer.currentTime;
      elements.videoPlayer.currentTime = state.initialPlaybackTime;
      
      // Log if the time actually changed
      setTimeout(() => {
        logger.info(`[${originalName}] After seek attempt - oldTime: ${oldTime}, currentTime: ${elements.videoPlayer.currentTime}, target: ${state.initialPlaybackTime}`);
      }, 50);
      
      elements.videoPlayer.removeEventListener('loadedmetadata', loadHandler);
      checkComplete();
    };

    const seekHandler = () => {
      isSeeked = true;
      logger.info(`[${originalName}] Video seek completed to time: ${elements.videoPlayer.currentTime}`);
      elements.videoPlayer.removeEventListener('seeked', seekHandler);
      checkComplete();
    };

    const errorHandler = (e) => {
      logger.error(`[${originalName}] Video error during loading:`, e);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      elements.videoPlayer.removeEventListener('loadedmetadata', loadHandler);
      elements.videoPlayer.removeEventListener('seeked', seekHandler);
      elements.videoPlayer.removeEventListener('error', errorHandler);
      reject(new Error(`Video error: ${e.message || 'Unknown error'}`));
    };

    // Add timeout to catch hung promises
    timeoutId = setTimeout(() => {
      logger.error(`[${originalName}] Video load timeout after 15 seconds`);
      elements.videoPlayer.removeEventListener('loadedmetadata', loadHandler);
      elements.videoPlayer.removeEventListener('seeked', seekHandler);
      elements.videoPlayer.removeEventListener('error', errorHandler);
      elements.videoPlayer.removeEventListener('playing', playHandler);
      reject(new Error('Video load timeout'));
    }, 15000);

    // Set up event listeners
    elements.videoPlayer.addEventListener('loadedmetadata', loadHandler);
    elements.videoPlayer.addEventListener('seeked', seekHandler);
    elements.videoPlayer.addEventListener('error', errorHandler);
    
    // Set video source
    elements.videoPlayer.src = `file://${path.join(state.clipLocation, originalName)}`;
    
    // If video was already loaded, we can resolve immediately
    if (elements.videoPlayer.readyState >= 2) {
      logger.info(`[${originalName}] Video already ready, skipping load/seek handlers`);
      elements.videoPlayer.removeEventListener('loadedmetadata', loadHandler);
      elements.videoPlayer.removeEventListener('seeked', seekHandler);
      elements.videoPlayer.removeEventListener('error', errorHandler);
      clearTimeout(timeoutId);
      resolve();
    }
  });

  // Play promise handles actually playing the video
  const playPromise = new Promise((resolve, reject) => {
    let timeoutId;
    
    const playHandler = () => {
      elements.videoPlayer.style.opacity = '1';
      thumbnailOverlay.style.display = 'none';
      elements.videoPlayer.removeEventListener('playing', playHandler);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      logger.info(`[${originalName}] Video started playing successfully`);
      resolve();
    };
    
    const errorHandlerPlay = (e) => {
      logger.error(`[${originalName}] Video play error:`, e);
      elements.videoPlayer.removeEventListener('playing', playHandler);
      elements.videoPlayer.removeEventListener('error', errorHandlerPlay);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      reject(new Error(`Video play error: ${e.message || 'Unknown error'}`));
    };
    
    // Add timeout for play promise as well
    timeoutId = setTimeout(() => {
      logger.error(`[${originalName}] Video play timeout after 5 seconds`);
      elements.videoPlayer.removeEventListener('playing', playHandler);
      elements.videoPlayer.removeEventListener('error', errorHandlerPlay);
      reject(new Error('Video play timeout'));
    }, 5000);

    elements.videoPlayer.addEventListener('playing', playHandler);
    elements.videoPlayer.addEventListener('error', errorHandlerPlay);
  });
  
  try {
    mark('beforeLoadPromise');
    await videoLoadPromise;
    mark('afterLoadPromise');
    
    // Load volume and speed
    const [loadedVolume, loadedSpeed] = await Promise.all([
      loadVolume(originalName),
      loadSpeed(originalName)
    ]);
    
    // Set up volume if loaded
    if (loadedVolume !== 1) {
      setupAudioContext();
      state.gainNode.gain.setValueAtTime(loadedVolume, state.audioContext.currentTime);
      updateVolumeSlider(loadedVolume);
      updateVolumeIcon(loadedVolume);
    }
    
    // Set up speed if loaded
    if (loadedSpeed !== 1) {
      changeSpeed(loadedSpeed);
    }
    
    mark('afterVolumeSpeed');
    
    // Check for volume range data to show volume controls
    await loadVolumeData();
    mark('afterVolumeData');
    
    // Start playhead updates
    requestAnimationFrame(updatePlayhead);

    // Apply ambient glow if enabled
    if (state.settings?.ambientGlowEnabled && ambientGlowManager) {
      logger.info(`[${originalName}] Starting ambient glow`);
      ambientGlowManager.start();
    }

    // Update Discord presence
    logger.info('Clip tags before Discord update:', clipTags);
    if (!clipTags || !clipTags.includes('Private')) {
      updateDiscordPresenceForClip({ originalName, customName, tags: clipTags }, true);
    }

    // Update last opened clip and navigation buttons
    const currentIndex = state.currentClipList.findIndex(clip => clip.originalName === originalName);
    if (currentIndex !== -1) {
      // Add a special class to the last-opened clip
      const lastOpenedElement = document.querySelector(`.clip-item[data-original-name="${originalName}"]`);
      if (lastOpenedElement) {
        lastOpenedElement.classList.add('last-opened');
      }
      
      updateNavigationButtons();
    }

    // Handle initial playback time for trim data
    if (trimData && !isNaN(state.initialPlaybackTime)) {
      elements.videoPlayer.currentTime = state.initialPlaybackTime;
    }
    
    // Show video and play when ready
    mark('beforePlayPromise');
    await playPromise;
    mark('afterPlayPromise');
    
    logger.info(`[${originalName}] Clip opened successfully!`);
    mark('end');
    
    if (isBenchmarkMode) {
      logger.info(`[PERF] Total: ${timings.end.toFixed(1)}ms`);
    }
  } catch (error) {
    logger.error(`[${originalName}] Error during clip opening:`, error);
    
    // Hide player overlay on error
    elements.playerOverlay.style.display = "none";
    elements.fullscreenPlayer.style.display = "none";
    
    if (!isBenchmarkMode) {
      showCustomAlert(`Error opening clip: ${error.message}`);
    }
  }
}

/**
 * Save trim changes for current clip
 */
async function saveTrimChanges() {
  const clipToUpdate = state.currentClip ? { ...state.currentClip } : null;
  
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
        state.trimStartTime,
        state.trimEndTime
      );
      logger.info("Trim data saved successfully");

      // Invalidate cache so next open gets fresh data
      state.clipDataCache.delete(clipToUpdate.originalName);

      // Regenerate thumbnail at new start point
      const result = await ipcRenderer.invoke(
        "regenerate-thumbnail-for-trim",
        clipToUpdate.originalName,
        state.trimStartTime
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

      if (state.currentClip) {
        updateDiscordPresence('Editing a clip', state.currentClip.customName);
      }
    } catch (error) {
      logger.error("Error saving trim data:", error);
      showCustomAlert(`Error saving trim: ${error.message}`);
    }
  }, 500);
}

/**
 * Reset clip trim times
 * 
 * @param {Object} clip - The clip object to reset trim times for
 */
async function resetClipTrimTimes(clip) {
  try {
    const isConfirmed = await showCustomConfirm(`Reset trim times for "${clip.customName}"? This will remove any custom start/end points.`);
    
    if (!isConfirmed) return;

    // Delete trim data for the clip
    await ipcRenderer.invoke("delete-trim", clip.originalName);
    logger.info("Trim data reset successfully for:", clip.originalName);

    // Invalidate cache so next open gets fresh data
    state.clipDataCache.delete(clip.originalName);

    // If this is the currently playing clip, reset the UI trim times
    if (state.currentClip && state.currentClip.originalName === clip.originalName) {
      state.trimStartTime = 0;
      state.trimEndTime = elements.videoPlayer.duration;
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

// ============================================================================
// CALLBACKS
// ============================================================================
let callbacks = {
  onTrimChange: null,      // Called when trim points change (for saving)
  onPlayerClose: null,     // Called when player should close
};

// ============================================================================
// INITIALIZATION
// ============================================================================

function init(domElements, callbackOptions = {}) {
  elements = { ...elements, ...domElements };
  callbacks = { ...callbacks, ...callbackOptions };

  // Create managers
  if (elements.videoPlayer && elements.ambientGlowCanvas) {
    ambientGlowManager = new AmbientGlowManager(elements.videoPlayer, elements.ambientGlowCanvas);
  }

  clipGlowManager = new ClipGlowManager();
  clipGlowManager.init();

  // Set up event listeners
  setupEventListeners();

  // Start drag state check interval
  setInterval(checkDragState, 100);

  logger.info('[VideoPlayer] Module initialized');
}

function setupEventListeners() {
  // Speed controls
  if (elements.speedSlider) {
    elements.speedSlider.addEventListener("input", (e) => {
      const newSpeed = parseFloat(e.target.value);
      changeSpeed(newSpeed);
    });
  }

  if (elements.speedButton) {
    elements.speedButton.addEventListener("click", () => {
      elements.speedSlider.classList.toggle("collapsed");
      clearTimeout(elements.speedContainer.timeout);
    });
  }

  if (elements.speedContainer) {
    elements.speedContainer.addEventListener("mouseenter", () => {
      clearTimeout(elements.speedContainer.timeout);
      elements.speedSlider.classList.remove("collapsed");
    });

    elements.speedContainer.addEventListener("mouseleave", () => {
      elements.speedContainer.timeout = setTimeout(() => {
        elements.speedSlider.classList.add("collapsed");
      }, 2000);
    });
  }

  // Volume controls
  if (elements.volumeSlider) {
    elements.volumeSlider.addEventListener("input", (e) => {
      const newVolume = parseFloat(e.target.value);
      if (!state.audioContext) setupAudioContext();
      state.gainNode.gain.setValueAtTime(newVolume, state.audioContext.currentTime);
      updateVolumeSlider(newVolume);
      updateVolumeIcon(newVolume);

      if (state.currentClip) {
        debouncedSaveVolume(state.currentClip.originalName, newVolume);
      }
    });
  }

  if (elements.volumeButton) {
    elements.volumeButton.addEventListener("click", () => {
      elements.volumeSlider.classList.toggle("collapsed");
      clearTimeout(elements.volumeContainer.timeout);
    });
  }

  if (elements.volumeContainer) {
    elements.volumeContainer.addEventListener("mouseenter", () => {
      clearTimeout(elements.volumeContainer.timeout);
      elements.volumeSlider.classList.remove("collapsed");
    });

    elements.volumeContainer.addEventListener("mouseleave", () => {
      elements.volumeContainer.timeout = setTimeout(() => {
        elements.volumeSlider.classList.add("collapsed");
      }, 2000);
    });
  }

  // Video events
  if (elements.videoPlayer) {
    elements.videoPlayer.addEventListener("loadedmetadata", () => {
      requestAnimationFrame(updatePlayhead);
      updateTimeDisplay();
    });

    elements.videoPlayer.addEventListener("timeupdate", updateTimeDisplay);

    elements.videoPlayer.addEventListener('seeked', function() {
      if (state.pendingFrameStep) {
        state.lastFrameStepTime = performance.now();
        state.pendingFrameStep = false;
        updateVideoDisplay();
      }
    });
  }

  // Progress bar / trim controls
  if (elements.progressBarContainer) {
    elements.progressBarContainer.addEventListener("mousedown", (e) => {
      const rect = elements.progressBarContainer.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const width = rect.width;
      const clickPercent = x / width;

      state.dragStartX = e.clientX;

      if (Math.abs(clickPercent - state.trimStartTime / elements.videoPlayer.duration) < 0.02) {
        state.isDragging = "start";
      } else if (Math.abs(clickPercent - state.trimEndTime / elements.videoPlayer.duration) < 0.02) {
        state.isDragging = "end";
      }

      if (state.isDragging) {
        state.isDraggingTrim = false;
        document.body.classList.add('dragging');
        document.addEventListener("mousemove", handleTrimDrag);
        document.addEventListener("mouseup", endTrimDrag);
      } else {
        state.wasLastSeekManual = true;
        const newTime = clickPercent * elements.videoPlayer.duration;

        if (newTime < state.trimStartTime || newTime > state.trimEndTime) {
          state.isAutoResetDisabled = true;
        }

        elements.videoPlayer.currentTime = newTime;
      }
    });
  }

  // Fullscreen events
  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('mouseleave', handleFullscreenMouseLeave);

  // Mouse tracking for drag state
  document.addEventListener("mousedown", () => {
    state.isMouseDown = true;
  });

  document.addEventListener("mouseup", () => {
    state.isMouseDown = false;
    state.isDragging = null;
    state.isDraggingTrim = false;
  });

  // Fullscreen button
  const fullscreenButton = document.getElementById("fullscreen-button");
  if (fullscreenButton) {
    fullscreenButton.addEventListener("click", toggleFullscreen);
  }

  // Video click target for play/pause
  if (elements.videoClickTarget) {
    elements.videoClickTarget.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlayPause();
    });
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Initialization
  init,

  // Utility
  debounce,

  // Classes (for external instantiation if needed)
  AmbientGlowManager,
  ClipGlowManager,

  // Managers (access after init)
  getAmbientGlowManager: () => ambientGlowManager,
  getClipGlowManager: () => clipGlowManager,

  // Speed controls
  changeSpeed,
  updateSpeedSlider,
  updateSpeedText,
  showSpeedContainer,
  loadSpeed,

  // Volume controls
  setupAudioContext,
  changeVolume,
  updateVolumeSlider,
  updateVolumeIcon,
  showVolumeContainer,
  loadVolume,

  // Playback controls
  togglePlayPause,
  showControls,
  hideControls,
  hideControlsInstantly,
  resetControlsTimeout,
  showLoadingOverlay,
  hideLoadingOverlay,

  // Time display
  updateTimeDisplay,
  formatTime,
  formatDuration,

  // Trim controls
  setTrimPoint,
  updateTrimControls,
  updatePlayhead,
  handleTrimDrag,
  endTrimDrag,
  checkDragState,

  // Fullscreen
  toggleFullscreen,
  handleFullscreenChange,
  handleFullscreenMouseMove,
  handleFullscreenMouseLeave,
  isVideoInFullscreen,

  // Frame stepping
  moveFrame,
  frameStep,
  updateVideoDisplay,

  // Skip / navigation
  calculateSkipTime,
  skipTime,

  // Ambient glow
  applyAmbientGlowSettings,

  // Additional functions
  pauseVideoIfPlaying,
  loadHandler,
  seekHandler,
  errorHandler,
  playHandler,
  handleVideoSeeked,
  handleVideoCanPlay,
  updateLoadingProgress,
  endVolumeDrag,
  loadVolumeData,
  hideVolumeControls,
  preloadClipData,
  handleMouseEnter,
  exportClipFromContextMenu,
  openClip,
  saveTrimChanges,
  resetClipTrimTimes,

  // Volume icons (for external use)
  volumeIcons,

  // DOM elements (for external access after init)
  getElements: () => elements,
};