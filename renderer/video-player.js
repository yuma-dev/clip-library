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
    this.glowOverflow = 40;
    this.dynamicBorder = true;
    this.borderOpacity = 0.4;
    this.borderSaturationBoost = 1.4;
    this.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.draw = this.draw.bind(this);
    this.drawLoop = this.drawLoop.bind(this);
  }

  init() {
    const grid = document.getElementById('clip-grid');
    if (!grid || this.canvas) return;

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
  // Note: saveTrimChanges should be called from renderer.js as it needs access to clip data
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
// INITIALIZATION
// ============================================================================

function init(domElements) {
  elements = { ...elements, ...domElements };

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
  }

  // NOTE: The following event listeners are handled by renderer.js which has more
  // complete logic (e.g., saveTrimChanges, ambient glow manager references).
  // They are left here as comments for future migration reference:
  //
  // - progressBarContainer mousedown (trim dragging with save)
  // - fullscreenchange (with ambient glow manager)
  // - fullscreen button click
  // - videoClickTarget click
  // - mouse tracking (mousedown/mouseup)
  //
  // These will be migrated when renderer.js is further modularized.
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Initialization
  init,

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

  // Skip / navigation
  calculateSkipTime,
  skipTime,

  // Ambient glow
  applyAmbientGlowSettings,

  // Volume icons (for external use)
  volumeIcons,

  // DOM elements (for external access after init)
  getElements: () => elements,
};
