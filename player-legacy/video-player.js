/**
 * Video playback: controls, trim, fullscreen, ambient glow, frame stepping
 * volume ranges, clip preview.
 */

const { ipcRenderer } = require('electron');
const path = require('path');
const logger = require('./logger');
const state = require('./state');
const { AudioTracksManager, SingleTrackMixer } = require('./audio-tracks-manager');

// active multi-track manager, if any
let activeAudioTracksManager = null;
// single-track clips get the mixer popover too, a one-row view over the master volume
let singleTrackMixer = null;
const mixerActive = () => !!(activeAudioTracksManager || singleTrackMixer);
// bumped on every openClip/closePlayer; async multi-track init checks this
// to bail if a newer open or close has superseded it
let clipOpenGeneration = 0;

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
  audioTracksPanel: null,
  speedButton: null,
  speedSlider: null,
  speedContainer: null,
  speedText: null,
  currentTimeDisplay: null,
  totalTimeDisplay: null,
  previewElement: null,
  tempVideo: null,
};

const volumeIcons = {
  normal: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M760-481q0-83-44-151.5T598-735q-15-7-22-21.5t-2-29.5q6-16 21.5-23t31.5 0q97 43 155 131.5T840-481q0 108-58 196.5T627-153q-16 7-31.5 0T574-176q-5-15 2-29.5t22-21.5q74-34 118-102.5T760-481ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm380-120q0 42-19 79.5T591-339q-10 6-20.5.5T560-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM400-606l-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`,
  muted: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="m720-424-76 76q-11 11-28 11t-28-11q-11-11-11-28t11-28l76-76-76-76q-11-11-11-28t11-28q11-11 28-11t28 11l76 76 76-76q11-11 28-11t28 11q11 11 11 28t-11 28l-76 76 76 76q11 11 11 28t-11 28q-11 11-28 11t-28-11l-76-76Zm-440 64H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`,
  low: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M360-360H240q-17 0-28.5-11.5T200-400v-160q0-17 11.5-28.5T240-600h120l132-132q19-19 43.5-8.5T560-703v446q0 27-24.5 37.5T492-228L360-360Zm380-120q0 42-19 79.5T671-339q-10 6-20.5.5T640-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM480-606l-86 86H280v80h114l86 86v-252ZM380-480Z"/></svg>`,
  high: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M760-440h-80q-17 0-28.5-11.5T640-480q0-17 11.5-28.5T680-520h80q17 0 28.5 11.5T800-480q0 17-11.5 28.5T760-440ZM584-288q10-14 26-16t30 8l64 48q14 10 16 26t-8 30q-10 14-26 16t-30-8l-64-48q-14-10-16-26t8-30Zm120-424-64 48q-14 10-30 8t-26-16q-10-14-8-30t16-26l64-48q14-10 30-8t26 16q10 14 8 30t-16 26ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`
};

let ambientGlowManager = null;
let clipGlowManager = null;
let saveTrimTimeout = null;
let pendingTrimSave = null;
let isReleasingVideoElement = false;

function createAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isIntentionalSourceResetError(errorCode, errorMessage) {
  const message = typeof errorMessage === 'string' ? errorMessage.toLowerCase() : '';
  if (Number(errorCode) !== 4) return false;

  // Chromium reports this when src is intentionally cleared during close/switch.
  if (message.includes('empty src attribute')) return true;

  const video = elements.videoPlayer;
  if (!video) return true;
  const srcAttr = video.getAttribute('src');
  const srcProp = typeof video.src === 'string' ? video.src.trim() : '';
  const currentSrc = typeof video.currentSrc === 'string' ? video.currentSrc.trim() : '';
  const hasNoSource = !srcAttr && !srcProp && !currentSrc;

  return isReleasingVideoElement || hasNoSource;
}

function getClipGlowManager() {
  return clipGlowManager;
}

function getAmbientGlowManager() {
  return ambientGlowManager;
}

class AmbientGlowManager {
  constructor(videoElement, canvasElement) {
    this.video = videoElement;
    this.canvas = canvasElement;
    this.ctx = null;
    this.animationFrameId = null;
    this.isActive = false;
    this.lastDrawTime = 0;
    this.frameInterval = 1000 / 30; // cap 30fps
    this.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // blend factor: 0.1 smooth, 1.0 no smoothing
    this.blendFactor = 0.15;

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

    // low-res is fine, glow is heavily blurred anyway
    this.canvas.width = 16;
    this.canvas.height = 9;
    this.ctx.filter = 'blur(1px)';
  }

  draw(forceFullDraw = false) {
    if (!this.ctx || !this.video || this.video.readyState < 2) return;

    try {
      if (forceFullDraw) {
        this.ctx.globalAlpha = 1.0;
        this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      } else {
        this.ctx.globalAlpha = this.blendFactor;
        this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
        this.ctx.globalAlpha = 1.0;
      }
    } catch (e) {
      // cross-origin or video-not-ready draw fails silently
    }
  }

  drawLoop(timestamp) {
    if (!this.isActive) return;

    // throttle to target fps
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

    this.draw();

    this.video.addEventListener('play', this.handlePlay);
    this.video.addEventListener('pause', this.handlePause);
    this.video.addEventListener('ended', this.handlePause);
    this.video.addEventListener('seeked', this.handleSeeked);
    this.video.addEventListener('loadeddata', this.handleSeeked);

    if (!this.video.paused) {
      this.handlePlay();
    }
  }

  stop() {
    this.isActive = false;
    this.canvas.classList.add('hidden');

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

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
    // one final frame when paused
    this.draw();
  }

  handleSeeked() {
    // no smoothing on seek
    this.draw(true);
  }

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

    // innerHTML clearing removes the canvas from the DOM without clearing our ref
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
      // ignore
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

function debounce(func, delay) {
  let timeoutId = null;
  let lastArgs = null;
  let lastThis = null;
  const debouncedFn = function(...args) {
    lastArgs = args;
    lastThis = this;
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      const argsToApply = lastArgs;
      const contextToApply = lastThis;
      timeoutId = null;
      lastArgs = null;
      lastThis = null;
      func.apply(contextToApply, argsToApply);
    }, delay);
  };
  debouncedFn.flush = () => {
    if (!timeoutId) return;
    clearTimeout(timeoutId);
    timeoutId = null;
    const argsToApply = lastArgs || [];
    const contextToApply = lastThis;
    lastArgs = null;
    lastThis = null;
    return func.apply(contextToApply, argsToApply);
  };
  debouncedFn.cancel = () => {
    clearTimeout(timeoutId);
    timeoutId = null;
    lastArgs = null;
    lastThis = null;
  };
  debouncedFn.hasPending = () => timeoutId !== null;
  debouncedFn.getPendingArgs = () => lastArgs;
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
    markVolumeCustom();
  }

  showVolumeContainer();
}

/** a level the user picked: master gain, saved for the clip, badge off */
function setMasterVolumeFromUser(newVolume) {
  if (!state.audioContext) setupAudioContext();
  state.gainNode.gain.setValueAtTime(newVolume, state.audioContext.currentTime);
  updateVolumeSlider(newVolume);

  if (state.currentClip) {
    debouncedSaveVolume(state.currentClip.originalName, newVolume);
    markVolumeCustom();
  }
}

// last level shown; gain.value lags a setValueAtTime until the context renders
let lastMasterVolume = 1;

function updateVolumeSlider(volume) {
  elements.volumeSlider.value = volume;
  lastMasterVolume = Number(volume);
  // the slider steps by 0.1, the mixer row gets the exact level
  if (singleTrackMixer) singleTrackMixer.setLevel(Number(volume));
  // the timeline waveform scales with the master level on single-track clips
  document.dispatchEvent(new CustomEvent('player-volume', { detail: Number(volume) }));

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

async function loadVolumeDetail(clipName) {
  try {
    return await ipcRenderer.invoke("get-volume-detail", clipName);
  } catch (error) {
    logger.error("Error loading volume detail:", error);
    return { volume: 1, source: 'default', measured: false };
  }
}

// where the current clip's level came from; drives the volume button tint and right-click revert
let volumeSource = { source: 'default', gainDb: 0 };

function loudnessEnabled() {
  return !!(state.settings && state.settings.loudness && state.settings.loudness.enabled);
}

function formatDb(db) {
  const n = Number(db) || 0;
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)} dB`;
}

// the matched detail of the open clip, so the badge can come back once every track is matched again
let lastMatchedSource = null;

function setVolumeSource(detail) {
  volumeSource = { source: detail?.source || 'default', gainDb: detail?.gainDb || 0 };
  if (volumeSource.source === 'normalized') lastMatchedSource = { ...volumeSource };
  else if (volumeSource.source === 'default') lastMatchedSource = null;
  if (!elements.volumeButton) return;
  const matched = volumeSource.source === 'normalized';
  if (singleTrackMixer) singleTrackMixer.setLevel(undefined, matched);
  elements.volumeButton.classList.toggle('normalized', matched);
  if (matched) {
    elements.volumeButton.title = `Loudness matched (${formatDb(volumeSource.gainDb)}). Drag the slider to set your own level.`;
  } else if (volumeSource.source === 'custom' && loudnessEnabled()) {
    elements.volumeButton.title = 'Your own level. Right-click to go back to matched loudness.';
  } else {
    elements.volumeButton.removeAttribute('title');
  }
}

/** slider touched: the saved level is now the clip's own */
function markVolumeCustom() {
  if (volumeSource.source === 'custom') return;
  setVolumeSource({ source: 'custom' });
}

/** apply a matched gain to whatever is playing: the master node, or each unset track on a multi-track clip */
function applyMatchedGain(gain, ramp) {
  if (!state.audioContext) setupAudioContext();
  const now = state.audioContext.currentTime;
  if (activeAudioTracksManager) {
    activeAudioTracksManager.applyNormalizedGain(gain, ramp);
    return;
  }
  const param = state.gainNode.gain;
  if (ramp) {
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(gain, now + 0.1);
  } else {
    param.setValueAtTime(gain, now);
  }
  const max = elements.volumeSlider ? Number(elements.volumeSlider.max) : 2;
  updateVolumeSlider(Math.min(gain, max));
}

/** right-click on the volume button: drop the custom level, back to matched loudness */
async function revertToMatchedVolume() {
  if (!state.currentClip || !loudnessEnabled() || volumeSource.source === 'normalized') return;
  const clipName = state.currentClip.originalName;
  // a double-click on the mixer row sets a level on its first press, that save must not land after the reset
  debouncedSaveVolume.cancel();
  try {
    const detail = await ipcRenderer.invoke('reset-volume', clipName);
    if (!state.currentClip || state.currentClip.originalName !== clipName) return;
    // on a multi-track clip the hand-set levels live on the tracks, so those go too
    if (detail.source === 'normalized' && activeAudioTracksManager) activeAudioTracksManager.revertAllToMatched(detail.gain);
    else if (detail.source === 'normalized') applyMatchedGain(detail.gain, true);
    else applyMatchedGain(1, true);
    setVolumeSource(detail);
    showVolumeContainer();
  } catch (error) {
    logger.error('Error reverting volume:', error);
  }
}

/** measurement finished for the open clip: ease its level in, no reopen needed */
function onLoudnessMeasured(payload) {
  if (!payload || !state.currentClip || state.currentClip.originalName !== payload.clipName) return;
  if (volumeSource.source === 'custom' || !loudnessEnabled()) return;
  applyMatchedGain(payload.gain, true);
  setVolumeSource({ source: 'normalized', gainDb: payload.gainDb });
}

function showVolumeContainer() {
  if (singleTrackMixer) {
    singleTrackMixer.showTransient();
    return;
  }
  elements.volumeSlider.classList.remove("collapsed");

  clearTimeout(elements.volumeContainer.timeout);
  elements.volumeContainer.timeout = setTimeout(() => {
    elements.volumeSlider.classList.add("collapsed");
  }, 2000);
}

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

// chrome visibility lives in the react player (VideoPlayer.tsx); these only report activity
function showControls() {
  document.dispatchEvent(new CustomEvent('player-activity'));
}

function hideControls() {}

function hideControlsInstantly() {}

function resetControlsTimeout() {
  showControls();
}

function showLoadingOverlay() {
  elements.loadingOverlay.style.display = "flex";
}

function hideLoadingOverlay() {
  elements.loadingOverlay.style.display = "none";
}

function updateTimeDisplay() {
  elements.currentTimeDisplay.textContent = formatDuration(elements.videoPlayer.currentTime);
  elements.totalTimeDisplay.textContent = formatDuration(elements.videoPlayer.duration);
}

function setTrimPoint(point) {
  if (point === "start") {
    state.trimStartTime = elements.videoPlayer.currentTime;
  } else {
    state.trimEndTime = elements.videoPlayer.currentTime;
  }

  state.isAutoResetDisabled = false;
  state.wasLastSeekManual = true;

  updateTrimControls();
  saveTrimChanges();
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

/**
 * Sync playhead position with current time.
 */
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

    saveTrimChanges();
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

  const frameTime = 1 / 30; // assume 30fps
  const minFrameInterval = 50; // min ms between steps

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

function updateVideoDisplay() {
  if (elements.videoPlayer.paused) {
    const canvas = document.createElement('canvas');
    canvas.width = elements.videoPlayer.videoWidth;
    canvas.height = elements.videoPlayer.videoHeight;
    canvas.getContext('2d').drawImage(elements.videoPlayer, 0, 0, canvas.width, canvas.height);

    // force a repaint
    elements.videoPlayer.style.display = 'none';
    // eslint-disable-next-line no-unused-expressions
    elements.videoPlayer.offsetHeight; // trigger reflow
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

  elements.ambientGlowCanvas.style.filter = `blur(${blur || 100}px) saturate(${saturation || 1.5})`;
  elements.ambientGlowCanvas.style.opacity = opacity || 0.8;
}

function pauseVideoIfPlaying() {
  if (!elements.videoPlayer.paused) {
    elements.videoPlayer.pause();
  }
}

function handleVideoSeeked() {
  if (state.currentClip) {
    state.elapsedTime = Math.floor(elements.videoPlayer.currentTime);
    logger.info('Current clip:', state.currentClip.tags);
    if (!state.currentClip.tags || !state.currentClip.tags.includes('Private')) {
      if (callbacks.updateDiscordPresenceForClip) {
        callbacks.updateDiscordPresenceForClip(state.currentClip, !elements.videoPlayer.paused);
      }
    }
  }
}

function handleVideoCanPlay() {
  if (state.isLoading) {
    state.isLoading = false;
    hideLoadingOverlay();
  }
  // don't show video/hide thumbnail here, wait for 'playing' event
}

function updateLoadingProgress() {
  if (elements.videoPlayer.buffered.length > 0) {
    const loadedPercentage =
      (elements.videoPlayer.buffered.end(0) / elements.videoPlayer.duration) * 100;
    elements.progressBar.style.backgroundImage = `linear-gradient(to right, #c2c2c2 ${loadedPercentage}%, #3a3a3a ${loadedPercentage}%)`;
  }
}

function endVolumeDrag() {
  if (!state.isVolumeDragging) return;

  document.body.classList.remove('dragging');

  if (state.currentClip) {
    const volumeData = {
      start: state.volumeStartTime,
      end: state.volumeEndTime,
      level: state.volumeLevel
    };
    ipcRenderer.invoke('save-volume-range', state.currentClip.originalName, volumeData)
      .catch(error => logger.error('Error saving volume data:', error));
  }

  state.isVolumeDragging = null;
  document.removeEventListener('mousemove', handleVolumeDrag);
  document.removeEventListener('mouseup', endVolumeDrag);

  updateVolumeControlsPosition();

  const volumeInput = state.volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.style.display = 'block';
  }
}

async function loadVolumeData(preloadedVolumeData) {
  if (!state.currentClip) {
    logger.warn('Attempted to load volume data without current clip');
    return;
  }

  try {
    // openClip passes its batched open-state value; other callers hit IPC directly
    const volumeData = preloadedVolumeData !== undefined
      ? preloadedVolumeData
      : await ipcRenderer.invoke('get-volume-range', state.currentClip.originalName);
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
      // no stored range, don't write a removal (this path runs on every clip open)
      hideVolumeControls(false);
    }
  } catch (error) {
    logger.error('Error loading volume data:', error);
    hideVolumeControls(false);
  }
}

function hideVolumeDragControl() {
  if (state.volumeDragControl) {
    state.volumeDragControl.style.display = 'none';
  }
}

function hideVolumeControls(persistRemoval = true) {
  state.isVolumeControlsVisible = false;
  state.volumeStartTime = 0;
  state.volumeEndTime = 0;
  state.volumeLevel = 0;
  state.volumeStartElement.style.display = 'none';
  state.volumeEndElement.style.display = 'none';
  state.volumeRegionElement.style.display = 'none';
  hideVolumeDragControl();

  // avoid stale debounced writes re-saving removed range data
  if (debouncedSaveVolumeData.cancel) {
    debouncedSaveVolumeData.cancel();
  }

  // callers hiding controls just because a clip has no range pass
  // persistRemoval=false so opening a clip never writes to disk
  if (persistRemoval && state.currentClip) {
    ipcRenderer.invoke('save-volume-range', state.currentClip.originalName, null)
      .catch(error => logger.error('Error removing volume data:', error));
  }
}

const debouncedSaveVolumeData = debounce(async (clipName, volumeData) => {
  if (!clipName || !volumeData) return;

  try {
    logger.info('Saving volume data:', volumeData);
    await ipcRenderer.invoke('save-volume-range', clipName, volumeData);
    logger.info('Volume data saved successfully');
  } catch (error) {
    logger.error('Error saving volume data:', error);
  }
}, 300);

function saveVolumeData() {
  if (!state.currentClip || !state.isVolumeControlsVisible) return;

  const volumeData = {
    start: state.volumeStartTime,
    end: state.volumeEndTime,
    level: state.volumeLevel || 0
  };

  debouncedSaveVolumeData(state.currentClip.originalName, volumeData);
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
  if (!elements.videoPlayer || !elements.videoPlayer.duration) return;

  if (!state.isVolumeControlsVisible) {
    if (state.volumeStartTime === 0 && state.volumeEndTime === 0) {
      state.volumeStartTime = elements.videoPlayer.duration / 3;
      state.volumeEndTime = (elements.videoPlayer.duration / 3) * 2;
      state.volumeLevel = 0;
    }
    showVolumeControls();
  } else {
    hideVolumeControls();
  }
}

function updateVolumeControlsPosition() {
  if (!elements.videoPlayer || !elements.videoPlayer.duration || !state.isVolumeControlsVisible) return;

  const startPercent = (state.volumeStartTime / elements.videoPlayer.duration) * 100;
  const endPercent = (state.volumeEndTime / elements.videoPlayer.duration) * 100;

  state.volumeStartElement.style.left = `${startPercent}%`;
  state.volumeEndElement.style.left = `${endPercent}%`;
  state.volumeRegionElement.style.left = `${startPercent}%`;
  state.volumeRegionElement.style.width = `${endPercent - startPercent}%`;

  if (state.volumeDragControl) {
    const middlePercent = (startPercent + endPercent) / 2;
    state.volumeDragControl.style.left = `${middlePercent}%`;
    state.volumeDragControl.style.display = 'flex';
  }
}

/**
 * Show the drag UI when adjusting volume range.
 */
function showVolumeDragControl(e) {
  if (!state.isVolumeControlsVisible || !elements.progressBarContainer || !elements.videoPlayer) return;

  const rect = elements.progressBarContainer.getBoundingClientRect();
  state.volumeDragControl.style.display = 'flex';

  if (e) {
    const x = e.clientX - rect.left;
    state.volumeDragControl.style.left = `${x}px`;
  } else {
    const startPercent = (state.volumeStartTime / elements.videoPlayer.duration) * 100;
    const endPercent = (state.volumeEndTime / elements.videoPlayer.duration) * 100;
    const middlePercent = (startPercent + endPercent) / 2;
    state.volumeDragControl.style.left = `${middlePercent}%`;
  }

  const volumeInput = state.volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.value = state.volumeLevel;
    volumeInput.style.display = 'block';
  }
}

function handleVolumeDrag(e) {
  if (!state.isVolumeDragging || !elements.progressBarContainer || !elements.videoPlayer) return;

  document.body.classList.add('dragging');

  const rect = elements.progressBarContainer.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const timePosition = (x / rect.width) * elements.videoPlayer.duration;

  if (state.isVolumeDragging === 'start') {
    state.volumeStartTime = Math.min(timePosition, state.volumeEndTime - 0.1);
  } else if (state.isVolumeDragging === 'end') {
    state.volumeEndTime = Math.max(timePosition, state.volumeStartTime + 0.1);
  }

  updateVolumeControlsPosition();
  state.volumeDragControl.style.display = 'flex';
  
  const volumeInput = state.volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.style.display = 'block';
  }

  saveVolumeData();
}

function updatePreview(e, options = {}) {
  if (!elements.progressBarContainer || !elements.previewElement || !elements.tempVideo || !elements.videoPlayer) return;
  if (!e) return;
  const rect = elements.progressBarContainer.getBoundingClientRect();
  const position = (e.clientX - rect.left) / rect.width;
  const time = elements.videoPlayer.duration * position;
  
  if (!options.skipPosition) {
    const cursorXRelative = e.clientX - rect.left;
    const previewWidth = elements.previewElement.offsetWidth;
    
    elements.previewElement.style.position = 'absolute';
    elements.previewElement.style.left = `${cursorXRelative - (previewWidth / 2)}px`;
    elements.previewElement.style.bottom = '20px';
  }
  
  const previewTimestamp = document.getElementById('preview-timestamp');
  previewTimestamp.textContent = formatTime(time);

  if (elements.tempVideo.readyState >= 2) {
    elements.tempVideo.currentTime = time;
  }
}

function handleKeyRelease(e) {
  if (isShareModalOpen()) return;

  if (e.key === "," || e.key === ".") {
    state.isFrameStepping = false;
    state.frameStepDirection = 0;
  }

  if (e.key === ' ' || e.code === 'Space') {
    const isClipTitleFocused = document.activeElement === elements.clipTitle;
    const isSearching = document.activeElement === document.getElementById("search-input");
    const isPlayerActive = elements.playerOverlay.style.display === "block";
    if (!isPlayerActive || isClipTitleFocused || isSearching) return;

    if (state.spaceHoldTimeoutId) {
      clearTimeout(state.spaceHoldTimeoutId);
      state.spaceHoldTimeoutId = null;
    }

    if (state.wasSpaceHoldBoostActive) {
      elements.videoPlayer.playbackRate = state.speedBeforeSpaceHold;
    } else {
      if (elements.videoPlayer.src) togglePlayPause();
    }

    state.isSpaceHeld = false;
    state.wasSpaceHoldBoostActive = false;
  }
}

function handleKeyPress(e) {
  if (isShareModalOpen()) return;

  const isClipTitleFocused = document.activeElement === elements.clipTitle;
  const isSearching = document.activeElement === document.getElementById("search-input");
  const isPlayerActive = elements.playerOverlay.style.display === "block";

  showControls();

  if (!isClipTitleFocused && !isSearching && (e.key === ' ' || e.code === 'Space')) {
    e.preventDefault();
    if (!state.isSpaceHeld) {
      state.isSpaceHeld = true;
      state.wasSpaceHoldBoostActive = false;
      state.spaceHoldTimeoutId = setTimeout(() => {
        if (state.isSpaceHeld && !elements.videoPlayer.paused) {
          state.wasSpaceHoldBoostActive = true;
          state.speedBeforeSpaceHold = elements.videoPlayer.playbackRate;
          elements.videoPlayer.playbackRate = 2;
        }
      }, 200);
    }
    return;
  }

  if (!isClipTitleFocused && !isSearching) {
    const action = callbacks.getActionFromEvent ? callbacks.getActionFromEvent(e) : null;
    if (!action) return;

    e.preventDefault();

    if (isPlayerActive) {
      switch (action) {
        case 'closePlayer':
          closePlayer();
          break;
        case 'playPause':
          if (elements.videoPlayer.src) togglePlayPause();
          break;
        case 'frameBackward':
          moveFrame(-1);
          break;
        case 'frameForward':
          moveFrame(1);
          break;
        case 'navigatePrev':
          if (callbacks.navigateToVideo) callbacks.navigateToVideo(-1);
          break;
        case 'navigateNext':
          if (callbacks.navigateToVideo) callbacks.navigateToVideo(1);
          break;
        case 'skipBackward':
          skipTime(-1);
          break;
        case 'skipForward':
          skipTime(1);
          break;
        case 'volumeUp':
          if (activeAudioTracksManager) {
            activeAudioTracksManager.nudgeAll(0.1);
          } else {
            changeVolume(0.1);
          }
          break;
        case 'volumeDown':
          if (activeAudioTracksManager) {
            activeAudioTracksManager.nudgeAll(-0.1);
          } else {
            changeVolume(-0.1);
          }
          break;
        case 'exportAudioFile':
          if (callbacks.exportAudioWithFileSelection) callbacks.exportAudioWithFileSelection();
          break;
        case 'exportVideo':
          if (callbacks.exportVideoWithFileSelection) callbacks.exportVideoWithFileSelection();
          break;
        case 'exportAudioClipboard':
          if (callbacks.exportAudioToClipboard) callbacks.exportAudioToClipboard();
          break;
        case 'exportDefault':
          if (callbacks.exportDefault) callbacks.exportDefault();
          break;
        case 'fullscreen':
          toggleFullscreen();
          break;
        case 'deleteClip':
          if (callbacks.confirmAndDeleteClip) callbacks.confirmAndDeleteClip();
          break;
        case 'setTrimStart':
          setTrimPoint('start');
          break;
        case 'setTrimEnd':
          setTrimPoint('end');
          break;
        case 'focusTitle':
          elements.clipTitle.focus();
          break;
        default:
          break;
      }
    } else {
      if (!state.gridNavigationEnabled && callbacks.enableGridNavigation) {
        callbacks.enableGridNavigation();
      }
      
      switch (action) {
        case 'playPause':
          if (callbacks.openCurrentGridSelection) callbacks.openCurrentGridSelection();
          break;
        case 'skipBackward':
          if (callbacks.moveGridSelection) callbacks.moveGridSelection('left');
          break;
        case 'skipForward':
          if (callbacks.moveGridSelection) callbacks.moveGridSelection('right');
          break;
        case 'volumeUp':
          if (callbacks.moveGridSelection) callbacks.moveGridSelection('up');
          break;
        case 'volumeDown':
          if (callbacks.moveGridSelection) callbacks.moveGridSelection('down');
          break;
        case 'closePlayer':
          if (callbacks.disableGridNavigation) callbacks.disableGridNavigation();
          break;
        case 'exportDefault':
          if (callbacks.openCurrentGridSelection) callbacks.openCurrentGridSelection();
          break;
        default:
          break;
      }
    }
  }
}

function isShareModalOpen() {
  const shareModal = document.getElementById('clip-share-modal');
  return Boolean(shareModal && shareModal.classList.contains('is-open'));
}

async function flushPendingClipEdits({ clipName, oldCustomName, titleValue, flushTitle = true }) {
  if (!clipName) return;

  const pendingTasks = [];

  if (flushTitle && callbacks.clearSaveTitleTimeout) {
    callbacks.clearSaveTitleTimeout();
  }

  if (flushTitle && callbacks.saveTitleChange) {
    pendingTasks.push(
      Promise.resolve(
        callbacks.saveTitleChange(clipName, oldCustomName || "", titleValue || "", true)
      )
    );
  }

  if (debouncedSaveSpeed.hasPending && debouncedSaveSpeed.hasPending()) {
    const pendingSpeedArgs = debouncedSaveSpeed.getPendingArgs ? debouncedSaveSpeed.getPendingArgs() : null;
    if (pendingSpeedArgs && pendingSpeedArgs[0] === clipName) {
      pendingTasks.push(Promise.resolve(debouncedSaveSpeed.flush()));
    }
  }

  if (debouncedSaveVolume.hasPending && debouncedSaveVolume.hasPending()) {
    const pendingVolumeArgs = debouncedSaveVolume.getPendingArgs ? debouncedSaveVolume.getPendingArgs() : null;
    if (pendingVolumeArgs && pendingVolumeArgs[0] === clipName) {
      pendingTasks.push(Promise.resolve(debouncedSaveVolume.flush()));
    }
  }

  if (debouncedSaveVolumeData.hasPending && debouncedSaveVolumeData.hasPending()) {
    const pendingVolumeDataArgs = debouncedSaveVolumeData.getPendingArgs ? debouncedSaveVolumeData.getPendingArgs() : null;
    if (pendingVolumeDataArgs && pendingVolumeDataArgs[0] === clipName) {
      pendingTasks.push(Promise.resolve(debouncedSaveVolumeData.flush()));
    }
  }

  if (saveTrimTimeout && pendingTrimSave && pendingTrimSave.clipName === clipName) {
    clearTimeout(saveTrimTimeout);
    saveTrimTimeout = null;
    const trimSave = pendingTrimSave;
    pendingTrimSave = null;
    pendingTasks.push(persistTrimSave(trimSave));
  }

  if (pendingTasks.length === 0) return;

  const results = await Promise.allSettled(pendingTasks);
  results.forEach((result) => {
    if (result.status === 'rejected') {
      logger.error(`Failed to flush pending edits for ${clipName}:`, result.reason);
    }
  });
}

async function closePlayer() {
  if (window.justFinishedDragging) {
    return;
  }

  // backdrop click, Escape, delete all land here; label for perf traces
  if (window.__perf && window.__perf.interaction) window.__perf.interaction('close-clip');

  if (callbacks.logCurrentWatchSession) {
    callbacks.logCurrentWatchSession();
  }

  document.removeEventListener("keydown", handleKeyPress);
  document.removeEventListener("keyup", handleKeyRelease);
  setVolumeSource({ source: 'default' });

  const originalName = state.currentClip ? state.currentClip.originalName : null;
  const oldCustomName = state.currentClip ? state.currentClip.customName : null;
  const newCustomName = elements.clipTitle.value;

  try {
    await flushPendingClipEdits({
      clipName: originalName,
      oldCustomName,
      titleValue: newCustomName,
      flushTitle: true
    });
  } catch (error) {
    logger.error("Error saving title on close:", error);
  }

  if (ambientGlowManager) {
    ambientGlowManager.stop();
  }

  elements.playerOverlay.style.display = "none";
  elements.fullscreenPlayer.style.display = "none";
  document.body.classList.remove('player-open');
  if (window.uiBlur) window.uiBlur.disable();

  // signals any in-flight multi-track init for this clip to discard itself
  // instead of attaching to a closed player
  clipOpenGeneration += 1;

  if (activeAudioTracksManager) {
    try { activeAudioTracksManager.dispose(); } catch (err) { logger.warn(`[audio-tracks] dispose failed: ${err.message}`); }
    activeAudioTracksManager = null;
  }
  if (singleTrackMixer) {
    singleTrackMixer.dispose();
    singleTrackMixer = null;
  }
  if (elements.audioTracksPanel) {
    elements.audioTracksPanel.classList.add('hidden');
  }
  if (elements.volumeSlider) {
    elements.volumeSlider.style.display = '';
  }

  await releaseVideoElement();

  if (elements.clipTitle) {
    elements.clipTitle.value = "";
  }

  document.querySelectorAll('.clip-item.last-opened').forEach(clip => {
    clip.classList.remove('last-opened');
  });

  if (originalName) {
    if (callbacks.updateClipDisplay) callbacks.updateClipDisplay(originalName);
    const clipElement = document.querySelector(`.clip-item[data-original-name="${CSS.escape(originalName)}"]`);
    if (clipElement) {
      logger.info('Found clip element to scroll to:', {
        originalName,
        elementExists: !!clipElement,
        elementPosition: clipElement.getBoundingClientRect()
      });

      clipElement.classList.add('last-opened');
      
      setTimeout(() => {
        if (callbacks.smoothScrollToElement) callbacks.smoothScrollToElement(clipElement);
      }, 50);
    } else {
      logger.warn('Clip element not found for scrolling:', originalName);
    }
  }

  state.currentClip = null;
  if (state.currentCleanup) {
    state.currentCleanup();
    state.currentCleanup = null;
  }

  clearInterval(state.discordPresenceInterval);
  if (callbacks.updateDiscordPresence) {
    callbacks.updateDiscordPresence('Browsing clips', `Total: ${state.currentClipList.length}`);
  }

  if (state.gamepadManager && state.gamepadManager.isGamepadConnected() && callbacks.getVisibleClips && callbacks.getVisibleClips().length > 0) {
    setTimeout(() => {
      if (callbacks.enableGridNavigation) callbacks.enableGridNavigation();
    }, 200);
  }
}

/**
 * @param {string} originalName
 * @returns {Promise<Object|null>}
 */
async function preloadClipData(originalName) {
  const cached = state.clipDataCache.get(originalName);
  if (cached && (Date.now() - cached.timestamp) < state.CACHE_EXPIRY_MS) {
    // Still kick off audio warming in case it wasn't done on the previous
    // hover (e.g. cache hit from a fresh page-load without audio warming).
    warmAudioTracksForHover(originalName, cached.data?.clipInfo).catch(() => {});
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

    if (state.clipDataCache.size > 50) {
      const oldestKey = state.clipDataCache.keys().next().value;
      state.clipDataCache.delete(oldestKey);
    }

    // fire-and-forget, has its own LRU cap + dedup so safe on every hover
    warmAudioTracksForHover(originalName, clipInfo).catch(() => {});

    return data;
  } catch (error) {
    logger.warn(`[Preload] Failed to preload ${originalName}:`, error.message);
    return null;
  }
}

// Multi-track clips: per-track AAC decoder warmup is the biggest open-time
// cost (~200ms waiting for all <audio> elements to reach readyState>=2).
// Warmed during hover instead: extract tracks, create hidden <audio> elements
// adopt them in AudioTracksManager.init on click. LRU cap evicts oldest clip.
//
// Entry shape: { audioEls: Map<ordinal, HTMLAudioElement>
//                trackMetas: Array, warmedAt: number
//                pending: Promise<void> }

const audioWarmCache = new Map();
const AUDIO_WARM_CAP = 3;

function warmCacheEvict(originalName) {
  const entry = audioWarmCache.get(originalName);
  if (!entry) return;
  audioWarmCache.delete(originalName);
  for (const audioEl of entry.audioEls.values()) {
    try { audioEl.pause(); } catch (_) {}
    try { audioEl.removeAttribute('src'); audioEl.load(); } catch (_) {}
    if (audioEl.parentNode) audioEl.parentNode.removeChild(audioEl);
  }
}

function warmCacheEnforceCap() {
  while (audioWarmCache.size > AUDIO_WARM_CAP) {
    // Map iteration order is insertion order, so oldest first
    const oldest = audioWarmCache.keys().next().value;
    if (!oldest) break;
    warmCacheEvict(oldest);
  }
}

/**
 * Idempotent, repeated hovers don't re-warm; returns the pending promise if
 * warming for this clip is already in flight.
 */
async function warmAudioTracksForHover(originalName, clipInfo) {
  const tracks = Array.isArray(clipInfo?.audioTracks) ? clipInfo.audioTracks : [];
  if (tracks.length <= 1) return;
  const existing = audioWarmCache.get(originalName);
  if (existing) {
    // refresh LRU position without retriggering work
    audioWarmCache.delete(originalName);
    audioWarmCache.set(originalName, existing);
    return existing.pending;
  }

  // reserve slot eagerly so concurrent hovers dedup
  const entry = {
    audioEls: new Map(),
    trackMetas: [],
    warmedAt: Date.now(),
    pending: null
  };
  audioWarmCache.set(originalName, entry);
  warmCacheEnforceCap();

  entry.pending = (async () => {
    try {
      const extracted = await ipcRenderer.invoke('extract-audio-tracks', originalName);
      if (!Array.isArray(extracted) || extracted.length === 0) {
        warmCacheEvict(originalName);
        return;
      }
      // cache may have been evicted while extract was running
      if (!audioWarmCache.has(originalName)) return;

      entry.trackMetas = extracted.map((e) => {
        const meta = tracks.find((t) => t.ordinal === e.ordinal) || {};
        return {
          ordinal: e.ordinal,
          streamIndex: e.streamIndex,
          path: e.path,
          name: meta.name || `Track ${e.ordinal + 1}`,
          channels: meta.channels || null
        };
      });

      for (const m of entry.trackMetas) {
        const audioEl = document.createElement('audio');
        audioEl.preload = 'auto';
        audioEl.src = `file://${m.path.replace(/\\/g, '/')}`;
        audioEl.style.display = 'none';
        audioEl.volume = 1;
        audioEl.dataset.warmedClip = originalName;
        audioEl.dataset.warmedOrdinal = String(m.ordinal);
        document.body.appendChild(audioEl);
        entry.audioEls.set(m.ordinal, audioEl);
      }
    } catch (err) {
      logger.warn(`[audio-warm] failed for ${originalName}: ${err.message}`);
      warmCacheEvict(originalName);
    }
  })();

  return entry.pending;
}

/**
 * Removes and returns the warm entry, or null. Caller takes ownership of the
 * audio elements: adopt into a manager or tear down.
 */
function takeWarmAudioTracks(originalName) {
  const entry = audioWarmCache.get(originalName);
  if (!entry) return null;
  audioWarmCache.delete(originalName);
  return entry;
}

/**
 * @param {Object} clip
 * @param {HTMLElement} clipElement
 */
async function handleMouseEnter(clip, clipElement) {
  preloadClipData(clip.originalName).catch(() => {});

  const clipGlowManager = getClipGlowManager();
  if (clipGlowManager) {
    clipGlowManager.show(clipElement);
  }

  if (clipElement.classList.contains("video-preview-disabled")) return;

  cleanupVideoPreview();

  const currentPreviewContext = {};
  state.activePreview = currentPreviewContext;

  state.previewCleanupTimeout = setTimeout(async () => {
    if (state.activePreview !== currentPreviewContext) return;

    try {
      const trimData = await ipcRenderer.invoke("get-trim", clip.originalName);
      const clipInfo = await ipcRenderer.invoke("get-clip-info", clip.originalName);

      if (state.activePreview !== currentPreviewContext) return;

      let startTime;
      if (trimData) {
        startTime = trimData.start;
      } else {
        startTime = clipInfo.format.duration > 40 ? clipInfo.format.duration / 2 : 0;
      }

      if (state.activePreview !== currentPreviewContext) return;

      const currentPreviewVolume = document.getElementById('previewVolumeSlider')?.value ?? state.settings?.previewVolume ?? 0.1;

      videoElement = document.createElement("video");
      videoElement.src = `file://${path.join(state.clipLocation, clip.originalName)}`;
      videoElement.volume = currentPreviewVolume;
      videoElement.loop = true;
      videoElement.preload = "metadata";
      videoElement.style.zIndex = "1";

      const mediaContainer = clipElement.querySelector(".clip-item-media-container");
      const imgElement = mediaContainer.querySelector("img");

      videoElement.poster = imgElement.src;

      currentPreviewContext.videoElement = videoElement;
      currentPreviewContext.imgElement = imgElement;

      videoElement.addEventListener('loadedmetadata', () => {
        if (state.activePreview !== currentPreviewContext || !clipElement.matches(':hover')) {
          cleanupVideoPreview();
          return;
        }

        imgElement.style.display = "none";
        videoElement.currentTime = startTime;
        videoElement.play().then(() => {
          // glow samples the playing video instead of the static thumbnail
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
 * @param {Object} clip
 */
async function exportClipFromContextMenu(clip) {
  try {
    const clipInfo = await ipcRenderer.invoke("get-clip-info", clip.originalName);
    const trimData = await ipcRenderer.invoke("get-trim", clip.originalName);
    const start = trimData ? trimData.start : 0;
    const end = trimData ? trimData.end : clipInfo.format.duration;
    const volume = await loadVolume(clip.originalName);
    const speed = await loadSpeed(clip.originalName);

    if (callbacks.showExportProgress) {
      callbacks.showExportProgress(0, 100);
    }

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
      if (callbacks.showExportProgress) {
        callbacks.showExportProgress(100, 100, true); // context menu export always goes to clipboard
      }
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting clip:", error);
    if (callbacks.showCustomAlert) {
      await callbacks.showCustomAlert(`Failed to export clip. Error: ${error.message}`);
    }
  }
}

/**
 * Used when the clip probe comes back empty; old path let the open run on
 * and surfaced a null-property error instead.
 */
function abortOpenUnreadable(originalName, customName) {
  elements.playerOverlay.style.display = "none";
  elements.fullscreenPlayer.style.display = "none";
  document.body.classList.remove('player-open');
  if (window.uiBlur) window.uiBlur.disable();
  if (callbacks.isBenchmarkMode || !callbacks.showCustomAlert) return;
  const name = customName || originalName;
  callbacks.showCustomAlert(`Error opening clip: "${name}" could not be read, it may be corrupted or still recording.`);
}

/**
 * @param {string} originalName
 * @param {string} customName
 */
async function openClip(originalName, customName) {
  // later async work checks this against clipOpenGeneration before mutating shared state
  clipOpenGeneration += 1;
  const openGen = clipOpenGeneration;
  logger.info(`Opening clip: ${originalName} (gen=${openGen})`);

  const timings = {};
  const startTime = performance.now();
  const mark = (name) => {
    timings[name] = performance.now() - startTime;
    if (callbacks.isBenchmarkMode) {
      logger.info(`[TIMING] ${name}: ${timings[name].toFixed(1)}ms`);
    }
  };
  mark('start');

  const previousClip = state.currentClip ? { ...state.currentClip } : null;
  if (previousClip && previousClip.originalName !== originalName) {
    await flushPendingClipEdits({
      clipName: previousClip.originalName,
      oldCustomName: previousClip.customName,
      titleValue: elements.clipTitle ? elements.clipTitle.value : previousClip.customName,
      flushTitle: true
    });
  }

  cleanupVideoPreview();

  // Ensure grid glow is cleared when opening a clip
  const clipGlowManager = getClipGlowManager();
  if (clipGlowManager) {
    clipGlowManager.hide();
  }
  
  state.elapsedTime = 0;

  state.isAutoResetDisabled = false;
  state.wasLastSeekManual = false;

  if (callbacks.logCurrentWatchSession) {
    await callbacks.logCurrentWatchSession();
  }
  mark('logSession');

  if (state.currentCleanup) {
    state.currentCleanup();
    state.currentCleanup = null;
  }

  if (activeAudioTracksManager) {
    try { activeAudioTracksManager.dispose(); } catch (err) { logger.warn(`[audio-tracks] dispose failed: ${err.message}`); }
    activeAudioTracksManager = null;
  }
  if (singleTrackMixer) {
    singleTrackMixer.dispose();
    singleTrackMixer = null;
  }
  if (elements.audioTracksPanel) {
    elements.audioTracksPanel.classList.add('hidden');
  }
  if (elements.volumeSlider) {
    elements.volumeSlider.style.display = '';
  }

  document.querySelectorAll('.clip-item.last-opened').forEach(clip => {
    clip.classList.remove('last-opened');
  });

  if (callbacks.initializeVolumeControls) {
    callbacks.initializeVolumeControls();
  }
  elements.loadingOverlay.style.display = "none";
  // clear a lingering darkener state from a clip closed before it played
  elements.loadingOverlay.classList.remove('thumbnail-backdrop');

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
  elements.videoPlayer.style.opacity = '0';

  // show player overlay immediately with thumbnail while video loads in the background
  const wasPlayerAlreadyOpen =
    elements.playerOverlay.style.display === "block" ||
    document.body.classList.contains('player-open');
  elements.playerOverlay.style.display = "block";
  elements.fullscreenPlayer.style.display = "block";
  document.body.classList.add('player-open');
  if (!wasPlayerAlreadyOpen && window.uiBlur) {
    window.uiBlur.enable();
  }
  mark('playerVisibleEarly');

  let clipInfo, trimData, clipTags, thumbnailPath;
  // volume/speed/volume-range/track state all arrive in the same round trip
  // so later stages never touch IPC again
  let openState = null;
  const cachedData = callbacks.getCachedClipData ? await callbacks.getCachedClipData(originalName) : null;

  if (cachedData) {
    clipInfo = cachedData.clipInfo;
    trimData = cachedData.trimData;
    clipTags = cachedData.clipTags;
    thumbnailPath = cachedData.thumbnailPath;
    mark('usedCachedData');
    logger.info(`[${originalName}] Using preloaded cached data`);
  } else {
    // single batched IPC: one round trip instead of ~9 handles over several await waves
    logger.info(`[${originalName}] Loading clip data (not cached)...`);
    try {
      const openStatePromise = ipcRenderer.invoke("get-clip-open-state", originalName);
      // batch can include a first-time ffprobe (~250ms); thumbnail lookup is just
      // fs.access, so run separately and paint the low-res placeholder right away
      // instead of waiting on the probe (else the hover-warmed video starts first)
      try {
        const earlyThumb = await (callbacks.getThumbnailPath
          ? callbacks.getThumbnailPath(originalName)
          : ipcRenderer.invoke("get-thumbnail-path", originalName));
        if (earlyThumb && openGen === clipOpenGeneration) {
          thumbnailOverlay.src = `file://${earlyThumb}`;
          thumbnailOverlay.style.display = 'block';
          // plain darkener, no spinner, see #loading-overlay.thumbnail-backdrop;
          // shown explicitly since updatePlayhead isn't running yet for the first clip
          elements.loadingOverlay.classList.add('thumbnail-backdrop');
          elements.loadingOverlay.style.display = 'flex';
        }
      } catch (_) { /* placeholder is cosmetic */ }
      openState = await openStatePromise;
      // the react timeline takes duration, thumbnail and waveform from here
      document.dispatchEvent(new CustomEvent('clip-open-state', { detail: { originalName, openState } }));
      clipInfo = openState.clipInfo;
      trimData = openState.trimData;
      clipTags = openState.clipTags;
      thumbnailPath = openState.thumbnailPath;
      if (!clipInfo) throw new Error('get-clip-open-state returned no clip info');
      mark('fetchedClipData');
    } catch (error) {
      logger.error(`[${originalName}] Error loading clip data:`, error);
      abortOpenUnreadable(originalName, customName);
      return;
    }
  }
  mark('getClipData');

  // hover-preloaded path can carry a null clipInfo too (main swallows a failed
  // probe); without this check the open blew up later with an opaque null-property error
  if (!clipInfo || !clipInfo.format) {
    logger.error(`[${originalName}] No clip info available, aborting open`);
    abortOpenUnreadable(originalName, customName);
    return;
  }

  // kick off track extraction now so the one-time ffmpeg stream-copy (~200-350ms)
  // overlaps the video load/seek below; multi-track init awaits this same promise later
  let earlyExtractPromise = null;
  if (Array.isArray(clipInfo?.audioTracks) && clipInfo.audioTracks.length > 1
      && !audioWarmCache.has(originalName)) {
    earlyExtractPromise = ipcRenderer.invoke('extract-audio-tracks', originalName);
    earlyExtractPromise.catch(() => {}); // observed where awaited
  }

  if (thumbnailPath) {
    thumbnailOverlay.src = `file://${thumbnailPath}`;
    thumbnailOverlay.style.display = 'block';
    elements.loadingOverlay.classList.add('thumbnail-backdrop');
    elements.loadingOverlay.style.display = 'flex';
    logger.info(`[${originalName}] Thumbnail loaded: ${thumbnailPath}`);
  } else {
    logger.warn(`[${originalName}] No thumbnail path found`);
  }

  if(elements.videoPlayer.src) {
    logger.info(`[${originalName}] Cleaning up previous video`);
    elements.videoPlayer.pause();
    // load() after removing src causes MEDIA_ERR_SRC_NOT_SUPPORTED, new src set below
    elements.videoPlayer.removeAttribute('src');
  }
  mark('cleanupPrevious');

  logger.info(`[${originalName}] Clip data ready. Duration: ${clipInfo?.format?.duration}, Trim: ${trimData ? 'Yes' : 'No'}, Tags: ${clipTags?.length || 0}`);

  state.currentClip = { originalName, customName, tags: clipTags };

  if (elements.clipTitle) {
    elements.clipTitle.value = customName || path.basename(originalName, path.extname(originalName));
    elements.clipTitle.dataset.originalName = originalName;
  }

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
      const mediaError = elements.videoPlayer.error;
      const errorCode = mediaError ? mediaError.code : 'unknown';
      const errorMessage = mediaError ? mediaError.message : 'Unknown error';

      // code 1 (MEDIA_ERR_ABORTED): we intentionally aborted (clip switch/close)
      if (errorCode === 1) {
        logger.info(`[${originalName}] Video loading aborted (intentional)`);
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        elements.videoPlayer.removeEventListener('loadedmetadata', loadHandler);
        elements.videoPlayer.removeEventListener('seeked', seekHandler);
        elements.videoPlayer.removeEventListener('error', errorHandler);
        reject(createAbortError('Video loading aborted'));
        return;
      }

      if (isIntentionalSourceResetError(errorCode, errorMessage)) {
        logger.info(`[${originalName}] Ignoring load error from intentional source reset`);
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        elements.videoPlayer.removeEventListener('loadedmetadata', loadHandler);
        elements.videoPlayer.removeEventListener('seeked', seekHandler);
        elements.videoPlayer.removeEventListener('error', errorHandler);
        reject(createAbortError('Video source reset'));
        return;
      }

      logger.error(`[${originalName}] Video error during loading - Code: ${errorCode}, Message: ${errorMessage}`);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      elements.videoPlayer.removeEventListener('loadedmetadata', loadHandler);
      elements.videoPlayer.removeEventListener('seeked', seekHandler);
      elements.videoPlayer.removeEventListener('error', errorHandler);
      reject(new Error(`Video error (code ${errorCode}): ${errorMessage}`));
    };

    timeoutId = setTimeout(() => {
      logger.error(`[${originalName}] Video load timeout after 15 seconds`);
      elements.videoPlayer.removeEventListener('loadedmetadata', loadHandler);
      elements.videoPlayer.removeEventListener('seeked', seekHandler);
      elements.videoPlayer.removeEventListener('error', errorHandler);
      elements.videoPlayer.removeEventListener('playing', playHandler);
      reject(new Error('Video load timeout'));
    }, 15000);

    elements.videoPlayer.addEventListener('loadedmetadata', loadHandler);
    elements.videoPlayer.addEventListener('seeked', seekHandler);
    elements.videoPlayer.addEventListener('error', errorHandler);

    logger.info(`[${originalName}] Setting video source: ${path.join(state.clipLocation, originalName)}`);
    elements.videoPlayer.src = `file://${path.join(state.clipLocation, originalName)}`;

    if (elements.videoPlayer.readyState >= 2) {
       logger.info(`[${originalName}] Video ready state is ${elements.videoPlayer.readyState}, forcing events manually`);
       // metadata event won't refire if readyState is already past it
       if (!isMetadataLoaded) loadHandler();
    }

  });

  try {
    mark('beforeLoadPromise');
    await videoLoadPromise;
    mark('afterLoadPromise');

    // already fetched in the open-state batch unless served from the hover cache
    const [volumeDetail, loadedSpeed] = openState
      ? [openState.volumeDetail || { volume: openState.volume, source: 'default' }, openState.speed]
      : await Promise.all([
          loadVolumeDetail(originalName),
          loadSpeed(originalName)
        ]);

    const audioTracks = Array.isArray(clipInfo?.audioTracks) ? clipInfo.audioTracks : [];
    // a matched gain on a multi-track clip goes onto each unset track instead of the master,
    // so a track with its own saved level keeps it
    const matchedOnTracks = audioTracks.length > 1 && volumeDetail.source === 'normalized';

    // apply clip-specific volume/speed so prior clip's state does not leak
    const volumeMin = elements.volumeSlider ? Number(elements.volumeSlider.min) : 0;
    const volumeMax = elements.volumeSlider ? Number(elements.volumeSlider.max) : 2;
    const loadedVolume = matchedOnTracks ? 1 : Number(volumeDetail.volume);
    const normalizedVolume = Number.isFinite(loadedVolume) ? loadedVolume : 1;
    // matched gains can pass the slider's 2x; the slider shows the clamp, the gain node gets the real value
    const targetVolume = volumeDetail.source === 'normalized'
      ? Math.max(normalizedVolume, volumeMin)
      : Math.min(Math.max(normalizedVolume, volumeMin), volumeMax);

    updateVolumeSlider(Math.min(targetVolume, volumeMax));
    if (state.audioContext || targetVolume !== 1) {
      setupAudioContext();
      state.gainNode.gain.setValueAtTime(targetVolume, state.audioContext.currentTime);
    }
    setVolumeSource(volumeDetail);

    const speedMin = elements.speedSlider ? Number(elements.speedSlider.min) : 0.5;
    const speedMax = elements.speedSlider ? Number(elements.speedSlider.max) : 2;
    const normalizedSpeed = Number.isFinite(Number(loadedSpeed)) ? Number(loadedSpeed) : 1;
    const targetSpeed = Math.min(Math.max(normalizedSpeed, speedMin), speedMax);

    elements.videoPlayer.playbackRate = targetSpeed;
    updateSpeedSlider(targetSpeed);
    updateSpeedText(targetSpeed);
    
    mark('afterVolumeSpeed');
    
    await loadVolumeData(openState ? openState.volumeRange : undefined);
    mark('afterVolumeData');

    // multi-track clips: extract each stream to its own .m4a, mute the <video>
    // build a per-track audio graph. Awaited before play(), a brief delay beats
    // playing the wrong (native default) track for a second then swapping it out
    if (audioTracks.length > 1) {
      try {
        setupAudioContext();
        // adopt hover-warmed entry if present: skips the extract IPC and <audio>
        // creation, and _waitForReady resolves near-instantly since decoders are
        // already past readyState>=2
        const warm = takeWarmAudioTracks(originalName);
        const extractedPromise = warm && warm.trackMetas.length > 0
          ? Promise.resolve(warm.trackMetas.map((m) => ({
              ordinal: m.ordinal,
              streamIndex: m.streamIndex,
              path: m.path
            })))
          : (earlyExtractPromise || ipcRenderer.invoke('extract-audio-tracks', originalName));
        const [extracted, persisted, globalPrefs] = await Promise.all([
          extractedPromise,
          openState ? Promise.resolve(openState.trackState) : ipcRenderer.invoke('get-track-state', originalName),
          openState ? Promise.resolve(openState.trackPreferences) : ipcRenderer.invoke('get-track-preferences')
        ]);
        if (openGen !== clipOpenGeneration) {
          logger.info(`[${originalName}] Multi-track init aborted (stale gen ${openGen} vs ${clipOpenGeneration})`);
          // warm entry was consumed but won't be used, drop its elements
          if (warm) {
            for (const el of warm.audioEls.values()) {
              try { el.pause(); el.removeAttribute('src'); el.load(); } catch (_) {}
              if (el.parentNode) el.parentNode.removeChild(el);
            }
          }
        } else if (Array.isArray(extracted) && extracted.length > 0) {
          const trackMetas = extracted.map((entry) => {
            const meta = audioTracks.find((t) => t.ordinal === entry.ordinal) || {};
            return {
              ordinal: entry.ordinal,
              streamIndex: entry.streamIndex,
              path: entry.path,
              name: meta.name || `Track ${entry.ordinal + 1}`,
              channels: meta.channels || null
            };
          });
          const manager = new AudioTracksManager({
            videoEl: elements.videoPlayer,
            audioContext: state.audioContext,
            masterGainNode: state.gainNode,
            panelEl: elements.audioTracksPanel,
            onPersistClip: (trackState) => {
              ipcRenderer.invoke('save-track-state', originalName, trackState)
                .catch((err) => logger.warn(`[audio-tracks] save clip failed: ${err.message}`));
            },
            onPersistGlobal: (trackName, patch) => {
              ipcRenderer.invoke('save-track-preferences', trackName, patch)
                .catch((err) => logger.warn(`[audio-tracks] save global failed: ${err.message}`));
            }
          });
          const persistedWithGain = matchedOnTracks
            ? { ...(persisted || {}), normalizedGain: volumeDetail.gain }
            : persisted;
          await manager.init(trackMetas, persistedWithGain, globalPrefs, warm ? warm.audioEls : null);
          if (openGen !== clipOpenGeneration) {
            logger.info(`[${originalName}] Multi-track init completed too late, disposing (gen ${openGen} vs ${clipOpenGeneration})`);
            try { manager.dispose(); } catch (_) {}
          } else {
            if (activeAudioTracksManager && activeAudioTracksManager !== manager) {
              try { activeAudioTracksManager.dispose(); } catch (_) {}
            }
            activeAudioTracksManager = manager;
            if (elements.volumeSlider) {
              elements.volumeSlider.style.display = 'none';
            }
            if (elements.audioTracksPanel) {
              elements.audioTracksPanel.classList.add('hidden');
            }
            logger.info(`[${originalName}] Multi-track audio initialized with ${trackMetas.length} tracks`);
          }
        }
      } catch (err) {
        logger.error(`[${originalName}] Failed to init multi-track audio:`, err);
      }
    } else if (openGen === clipOpenGeneration && elements.audioTracksPanel) {
      try {
        const globalPrefs = openState ? openState.trackPreferences : await ipcRenderer.invoke('get-track-preferences');
        if (openGen === clipOpenGeneration) {
          if (singleTrackMixer) singleTrackMixer.dispose();
          singleTrackMixer = new SingleTrackMixer({
            panelEl: elements.audioTracksPanel,
            globalPrefs,
            onLevel: setMasterVolumeFromUser,
            // matched loudness when it is on, else unity
            onReset: () => {
              if (loudnessEnabled()) void revertToMatchedVolume();
              else setMasterVolumeFromUser(1);
            },
            onPersistGlobal: (key, patch) => {
              ipcRenderer.invoke('save-track-preferences', key, patch)
                .catch((err) => logger.warn(`[audio-tracks] save global failed: ${err.message}`));
            }
          });
          singleTrackMixer.setLevel(lastMasterVolume, volumeSource.source === 'normalized');
          singleTrackMixer.render();
          if (elements.volumeSlider) elements.volumeSlider.style.display = 'none';
          elements.audioTracksPanel.classList.add('hidden');
        }
      } catch (err) {
        logger.error(`[${originalName}] Failed to init single-track mixer:`, err);
      }
    }
    mark('afterAudioTracks');

    requestAnimationFrame(updatePlayhead);

    if (state.settings?.ambientGlow?.enabled && ambientGlowManager) {
      logger.info(`[${originalName}] Starting ambient glow`);
      ambientGlowManager.start();
    }

    logger.info('Clip tags before Discord update:', clipTags);
    if (!clipTags || !clipTags.includes('Private')) {
      if (callbacks.updateDiscordPresenceForClip) {
        callbacks.updateDiscordPresenceForClip({ originalName, customName, tags: clipTags }, true);
      }
    }

    const currentIndex = state.currentClipList.findIndex(clip => clip.originalName === originalName);
    if (currentIndex !== -1) {
      const lastOpenedElement = document.querySelector(`.clip-item[data-original-name="${CSS.escape(originalName)}"]`);
      if (lastOpenedElement) {
        lastOpenedElement.classList.add('last-opened');
      }

      if (callbacks.updateNavigationButtons) {
        callbacks.updateNavigationButtons();
      }
    }

    if (trimData && !isNaN(state.initialPlaybackTime)) {
      elements.videoPlayer.currentTime = state.initialPlaybackTime;
    }

    mark('beforePlayPromise');
    logger.info(`[${originalName}] Calling videoPlayer.play()`);

    const playPromise = new Promise((resolve, reject) => {
        let playTimeoutId = setTimeout(() => {
            logger.error(`[${originalName}] Play promise timeout - video did not start playing`);
            elements.videoPlayer.removeEventListener('playing', playHandler);
            elements.videoPlayer.removeEventListener('error', errorHandlerPlay);
            reject(new Error('Play promise timeout'));
        }, 5000);

        const playHandler = () => {
            // wait for 'playing' so we don't flash the first frame before the trim-start jump
            elements.videoPlayer.style.opacity = '1';
            const thumbnailOverlay = document.getElementById('thumbnail-overlay');
            if (thumbnailOverlay) {
                thumbnailOverlay.style.display = 'none';
            }
            // placeholder gone, restore normal spinner for later mid-playback buffering
            elements.loadingOverlay.classList.remove('thumbnail-backdrop');

            elements.videoPlayer.removeEventListener('playing', playHandler);
            elements.videoPlayer.removeEventListener('error', errorHandlerPlay);
            clearTimeout(playTimeoutId);
            logger.info(`[${originalName}] Video started playing successfully`);
            resolve();
        };

        const errorHandlerPlay = (e) => {
             const mediaError = elements.videoPlayer.error;
             const errorCode = mediaError ? mediaError.code : 'unknown';
             const errorMessage = mediaError ? mediaError.message : 'Unknown error';

             // code 1 = intentional abort
             if (errorCode === 1) {
                 logger.info(`[${originalName}] Video play aborted (intentional)`);
                 elements.videoPlayer.removeEventListener('playing', playHandler);
                 elements.videoPlayer.removeEventListener('error', errorHandlerPlay);
                 clearTimeout(playTimeoutId);
                 reject(createAbortError('Video play aborted'));
                 return;
             }

             if (isIntentionalSourceResetError(errorCode, errorMessage)) {
                 logger.info(`[${originalName}] Ignoring play error from intentional source reset`);
                 elements.videoPlayer.removeEventListener('playing', playHandler);
                 elements.videoPlayer.removeEventListener('error', errorHandlerPlay);
                 clearTimeout(playTimeoutId);
                 reject(createAbortError('Video source reset during play'));
                 return;
             }

             logger.error(`[${originalName}] Video play error - Code: ${errorCode}, Message: ${errorMessage}`);
             elements.videoPlayer.removeEventListener('playing', playHandler);
             elements.videoPlayer.removeEventListener('error', errorHandlerPlay);
             clearTimeout(playTimeoutId);
             reject(new Error(`Video play error (code ${errorCode}): ${errorMessage}`));
        };

        elements.videoPlayer.addEventListener('playing', playHandler);
        elements.videoPlayer.addEventListener('error', errorHandlerPlay);

        elements.videoPlayer.play().catch(e => {
            // rejection from .play() itself; let the timeout/error event handle
            // it unless AbortError, main promise isn't rejected here
            if (e.name !== 'AbortError') {
                 logger.error(`[${originalName}] videoPlayer.play() rejected:`, e);
            }
        });
    });

    await playPromise;
    mark('afterPlayPromise');

    logger.info(`[${originalName}] Clip opened successfully!`);
    mark('end');

    if (callbacks.isBenchmarkMode) {
      logger.info(`[PERF] Total: ${timings.end.toFixed(1)}ms`);
      // side-channel for the benchmark harness instead of plumbing through the return value
      try {
        const audioTrackCount = Array.isArray(clipInfo?.audioTracks) ? clipInfo.audioTracks.length : 0;
        window.__benchmarkLastOpenTimings = {
          clipName: originalName,
          audioTrackCount,
          timings: { ...timings }
        };
      } catch (_) { /* ignore */ }
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      logger.info(`[${originalName}] Clip open cancelled`);
      return;
    }

    logger.error(`[${originalName}] Error during clip opening:`, error);

    elements.playerOverlay.style.display = "none";
    elements.fullscreenPlayer.style.display = "none";
    document.body.classList.remove('player-open');
    if (window.uiBlur) window.uiBlur.disable();

    if (!callbacks.isBenchmarkMode) {
      if (callbacks.showCustomAlert) {
        callbacks.showCustomAlert(`Error opening clip: ${error.message}`);
      }
    }
  }
}

async function persistTrimSave(trimSave) {
  await ipcRenderer.invoke(
    "save-trim",
    trimSave.clipName,
    trimSave.trimStartTime,
    trimSave.trimEndTime
  );
  logger.info(`Trim data saved successfully for ${trimSave.clipName}`);

  state.clipDataCache.delete(trimSave.clipName);

  const result = await ipcRenderer.invoke(
    "regenerate-thumbnail-for-trim",
    trimSave.clipName,
    trimSave.trimStartTime
  );

  if (result.success) {
    const clipElement = document.querySelector(
      `.clip-item[data-original-name="${trimSave.clipName}"]`
    );

    if (clipElement) {
      const imgElement = clipElement.querySelector(".clip-item-media-container img");
      if (imgElement) {
        imgElement.src = `file://${result.thumbnailPath}?t=${Date.now()}`;
      }
    }
  }

  if (
    state.currentClip &&
    state.currentClip.originalName === trimSave.clipName &&
    callbacks.updateDiscordPresence
  ) {
    callbacks.updateDiscordPresence('Editing a clip', state.currentClip.customName);
  }
}

async function saveTrimChanges() {
  const clipToUpdate = state.currentClip ? { ...state.currentClip } : null;
  
  if (!clipToUpdate) {
    logger.info("No clip to save trim data for");
    return;
  }

  if (saveTrimTimeout) {
    clearTimeout(saveTrimTimeout);
  }

  pendingTrimSave = {
    clipName: clipToUpdate.originalName,
    trimStartTime: state.trimStartTime,
    trimEndTime: state.trimEndTime
  };

  saveTrimTimeout = setTimeout(async () => {
    const trimSave = pendingTrimSave;
    pendingTrimSave = null;
    saveTrimTimeout = null;

    if (!trimSave) return;

    try {
      await persistTrimSave(trimSave);
    } catch (error) {
      logger.error("Error saving trim data:", error);
      if (callbacks.showCustomAlert) {
        callbacks.showCustomAlert(`Error saving trim: ${error.message}`);
      }
    }
  }, 500);
}

/**
 * @param {Object} clip
 */
async function resetClipTrimTimes(clip) {
  try {
    if (!callbacks.showCustomConfirm) return;

    const isConfirmed = await callbacks.showCustomConfirm(`Reset trim times for "${clip.customName}"? This will remove any custom start/end points.`);

    if (!isConfirmed) return;

    await ipcRenderer.invoke("delete-trim", clip.originalName);
    logger.info("Trim data reset successfully for:", clip.originalName);

    state.clipDataCache.delete(clip.originalName);

    if (state.currentClip && state.currentClip.originalName === clip.originalName) {
      state.trimStartTime = 0;
      state.trimEndTime = elements.videoPlayer.duration;
      updateTrimControls();
    }

    const result = await ipcRenderer.invoke(
      "regenerate-thumbnail-for-trim",
      clip.originalName,
      0
    );

    if (result.success) {
      const clipElement = document.querySelector(
        `.clip-item[data-original-name="${clip.originalName}"]`
      );

      if (clipElement) {
        const imgElement = clipElement.querySelector(".clip-item-media-container img");
        if (imgElement) {
          imgElement.src = `file://${result.thumbnailPath}?t=${Date.now()}`;
        }
      }
    }

    if (callbacks.showCustomAlert) {
      await callbacks.showCustomAlert("Trim times have been reset successfully.");
    }
  } catch (error) {
    logger.error("Error resetting trim data:", error);
    if (callbacks.showCustomAlert) {
      await callbacks.showCustomAlert(`Error resetting trim times: ${error.message}`);
    }
  }
}

// callback hooks wired up by init()
let callbacks = {
  onPlayerClose: null,
  logCurrentWatchSession: null,
  initializeVolumeControls: null,
  getCachedClipData: null,
  getThumbnailPath: null,
  updateDiscordPresenceForClip: null,
  updateNavigationButtons: null,
  showCustomAlert: null,
  showExportProgress: null,
  showCustomConfirm: null,
  isBenchmarkMode: false,
  updateDiscordPresence: null,
  getActionFromEvent: null,
  navigateToVideo: null,
  exportAudioWithFileSelection: null,    // Called to export audio with file picker
  exportVideoWithFileSelection: null,    // Called to export video with file picker
  exportAudioToClipboard: null,          // Called to export audio to clipboard
  exportDefault: null,                   // Called to export using default settings
  confirmAndDeleteClip: null,            // Called to delete current clip
  enableGridNavigation: null,            // Called to enable grid navigation
  disableGridNavigation: null,
  openCurrentGridSelection: null,
  moveGridSelection: null,
  saveTitleChange: null,
  clearSaveTitleTimeout: null,
  removeClipTitleEditingListeners: null,
  updateClipDisplay: null,
  smoothScrollToElement: null,
  getVisibleClips: null
};

function init(domElements, callbackOptions = {}) {
  elements = { ...elements, ...domElements };
  callbacks = { ...callbacks, ...callbackOptions };

  if (elements.videoPlayer && elements.ambientGlowCanvas) {
    ambientGlowManager = new AmbientGlowManager(elements.videoPlayer, elements.ambientGlowCanvas);
  }

  clipGlowManager = new ClipGlowManager();
  clipGlowManager.init();

  setupEventListeners();
  setInterval(checkDragState, 100);

  logger.info('[VideoPlayer] Module initialized');
}

function setupEventListeners() {
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

  // speed slider is click-to-expand only, hover-expand removed per design
  if (elements.volumeSlider) {
    elements.volumeSlider.addEventListener("input", (e) => {
      setMasterVolumeFromUser(parseFloat(e.target.value));
    });
  }

  ipcRenderer.on('loudness-measured', (_event, payload) => onLoudnessMeasured(payload));
  // a track level set by hand in the mixer counts as a manual volume too; every track back on its
  // matched level restores the badge
  document.addEventListener('audio-track-custom', () => markVolumeCustom());
  document.addEventListener('audio-tracks-auto', () => {
    if (lastMatchedSource && volumeSource.source !== 'normalized') setVolumeSource(lastMatchedSource);
  });

  if (elements.volumeButton) {
    elements.volumeButton.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void revertToMatchedVolume();
    });
    elements.volumeButton.addEventListener("click", () => {
      if (mixerActive() && elements.audioTracksPanel) {
        elements.audioTracksPanel.classList.toggle('hidden');
      } else {
        elements.volumeSlider.classList.toggle("collapsed");
        clearTimeout(elements.volumeContainer.timeout);
      }
    });
  }

  if (elements.volumeContainer) {
    elements.volumeContainer.addEventListener("mouseenter", () => {
      clearTimeout(elements.volumeContainer.timeout);
      if (mixerActive()) return; // the mixer popout is click-only
      elements.volumeSlider.classList.remove("collapsed");
    });

    elements.volumeContainer.addEventListener("mouseleave", () => {
      // the mixer stays open until an outside click; mouseleave
      // auto-hide was too aggressive for drag handles/palette interaction
      if (mixerActive()) return;
      elements.volumeContainer.timeout = setTimeout(() => {
        elements.volumeSlider.classList.add("collapsed");
      }, 2000);
    });
  }

  // closes the multi-track panel; mousedown (not click) so it runs before
  // the player-overlay's own close logic on the same gesture
  document.addEventListener('mousedown', (e) => {
    if (!mixerActive()) return;
    const panel = elements.audioTracksPanel;
    if (!panel || panel.classList.contains('hidden')) return;
    if (e.target.closest('#volume-container')) return;
    panel.classList.add('hidden');
  });

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

  document.addEventListener('fullscreenchange', handleFullscreenChange);
  document.addEventListener('mouseleave', handleFullscreenMouseLeave);

  document.addEventListener("mousedown", () => {
    state.isMouseDown = true;
  });

  document.addEventListener("mouseup", () => {
    state.isMouseDown = false;
    state.isDragging = null;
    state.isDraggingTrim = false;
  });

  const fullscreenButton = document.getElementById("fullscreen-button");
  if (fullscreenButton) {
    fullscreenButton.addEventListener("click", toggleFullscreen);
  }

  if (elements.videoClickTarget) {
    elements.videoClickTarget.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePlayPause();
    });
  }

}

function cleanupVideoPreview() {
  if (state.previewCleanupTimeout) {
    clearTimeout(state.previewCleanupTimeout);
    state.previewCleanupTimeout = null;
  }

  if (state.activePreview && state.activePreview.videoElement) {
    const videoElement = state.activePreview.videoElement;
    videoElement.pause();
    videoElement.removeAttribute('src');
    videoElement.load();
    videoElement.remove();

    if (state.activePreview.imgElement) {
       state.activePreview.imgElement.style.display = "";
    }
  }

  state.activePreview = null;
}

async function releaseVideoElement() {
  if (!elements.videoPlayer) return;

  isReleasingVideoElement = true;
  try {
    elements.videoPlayer.pause();
    elements.videoPlayer.removeEventListener("canplay", handleVideoCanPlay);
    elements.videoPlayer.removeEventListener("progress", updateLoadingProgress);
    elements.videoPlayer.removeEventListener("waiting", showLoadingOverlay);
    elements.videoPlayer.removeEventListener("playing", hideLoadingOverlay);
    elements.videoPlayer.removeEventListener("seeked", handleVideoSeeked);

    elements.videoPlayer.srcObject = null;
    elements.videoPlayer.removeAttribute('src');
    elements.videoPlayer.src = '';
    elements.videoPlayer.load();

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        elements.videoPlayer.removeEventListener('emptied', finish);
        elements.videoPlayer.removeEventListener('abort', finish);
        elements.videoPlayer.removeEventListener('error', finish);
        resolve();
      };

      elements.videoPlayer.addEventListener('emptied', finish, { once: true });
      elements.videoPlayer.addEventListener('abort', finish, { once: true });
      elements.videoPlayer.addEventListener('error', finish, { once: true });

      setTimeout(finish, 250);
    });

    if (elements.tempVideo) {
      elements.tempVideo.pause();
      elements.tempVideo.removeAttribute('src');
      elements.tempVideo.src = '';
      elements.tempVideo.load();
      elements.tempVideo.currentTime = 0;
    }

    if (elements.previewElement) {
      elements.previewElement.style.display = 'none';
    }
  } finally {
    isReleasingVideoElement = false;
  }
}

module.exports = {
  // Initialization
  init,

  // Utility
  debounce,

  // Classes (for external instantiation if needed)
  AmbientGlowManager,
  ClipGlowManager,

  // Managers (access after init)
  getAmbientGlowManager,
  getClipGlowManager,

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
  getActiveAudioTracksManager: () => activeAudioTracksManager,

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
  handleVideoSeeked,
  updateLoadingProgress,
  endVolumeDrag,
  loadVolumeData,
  hideVolumeDragControl,
  hideVolumeControls,
  cleanupVideoPreview,
  releaseVideoElement,
  preloadClipData,
  handleMouseEnter,
  exportClipFromContextMenu,
  openClip,
  saveTrimChanges,
  resetClipTrimTimes,
  closePlayer,
  handleKeyPress,
  handleKeyRelease,
  updatePreview,
  handleVolumeDrag,
  showVolumeDragControl,
  updateVolumeControlsPosition,
  toggleVolumeControls,
  showVolumeControls,
  saveVolumeData,

  // Volume icons (for external use)
  volumeIcons,

  // DOM elements (for external access after init)
  getElements: () => elements,
};
