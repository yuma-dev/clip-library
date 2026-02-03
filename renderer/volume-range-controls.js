// Volume range UI controls for the player timeline
const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');
const state = require('./state');

function init({
  videoPlayer,
  progressBarContainer,
  volumeSlider,
  toggleVolumeControls,
  showVolumeDragControl,
  handleVolumeDrag,
  endVolumeDrag,
  debounce
}) {
  if (!videoPlayer || !progressBarContainer || !volumeSlider) return;

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

  if (!progressBarContainer.contains(state.volumeStartElement)) {
    progressBarContainer.appendChild(state.volumeStartElement);
    progressBarContainer.appendChild(state.volumeEndElement);
    progressBarContainer.appendChild(state.volumeRegionElement);
    progressBarContainer.appendChild(state.volumeDragControl);
  }

  const debouncedSaveVolumeLevel = debounce(async () => {
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

  function handleVolumeStartDrag(e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    state.isVolumeDragging = 'start';
    showVolumeDragControl(e);
    document.addEventListener('mousemove', handleVolumeDrag);
    document.addEventListener('mouseup', endVolumeDrag);
  }

  function handleVolumeEndDrag(e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    state.isVolumeDragging = 'end';
    showVolumeDragControl(e);
    document.addEventListener('mousemove', handleVolumeDrag);
    document.addEventListener('mouseup', endVolumeDrag);
  }

  const volumeInput = state.volumeDragControl.querySelector('input');
  volumeInput.addEventListener('input', (e) => {
    e.stopPropagation();
    state.volumeLevel = parseFloat(e.target.value);
    debouncedSaveVolumeLevel();
  });

  volumeInput.addEventListener('change', (e) => {
    e.stopPropagation();
    state.volumeLevel = parseFloat(e.target.value);
    debouncedSaveVolumeLevel.flush?.() || debouncedSaveVolumeLevel();
  });

  state.volumeStartElement.addEventListener('mousedown', handleVolumeStartDrag);
  state.volumeEndElement.addEventListener('mousedown', handleVolumeEndDrag);

  window.addEventListener('blur', () => {
    if (state.isVolumeDragging) {
      endVolumeDrag();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.isVolumeDragging) {
      endVolumeDrag();
    }
  });

  document.addEventListener('keydown', (e) => {
    const isInputFocused =
      document.activeElement.tagName === 'INPUT' ||
      document.activeElement.tagName === 'TEXTAREA' ||
      document.activeElement.isContentEditable;

    if (!isInputFocused && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      toggleVolumeControls();
    }
  });

  videoPlayer.addEventListener('timeupdate', () => {
    if (!state.audioContext || !state.gainNode || !state.isVolumeControlsVisible) return;

    const currentVolume = volumeSlider.value;
    if (videoPlayer.currentTime >= state.volumeStartTime && videoPlayer.currentTime <= state.volumeEndTime) {
      state.gainNode.gain.setValueAtTime(state.volumeLevel * currentVolume, state.audioContext.currentTime);
    } else {
      state.gainNode.gain.setValueAtTime(currentVolume, state.audioContext.currentTime);
    }
  });
}

module.exports = { init };
