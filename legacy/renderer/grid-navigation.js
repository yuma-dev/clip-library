/**
 * keyboard/gamepad navigation through the clip grid, with throttling
 */

const logger = require('../utils/logger');
const state = require('./state');

const GRID_NAVIGATION_THROTTLE = 150; // ms between navigation actions

/**
 * @param {string} direction - 'up' | 'down' | 'left' | 'right'
 */
function moveGridSelection(direction) {
  if (!state.gridNavigationEnabled) return;

  const now = Date.now();
  if (now - state.lastGridNavigationTime < GRID_NAVIGATION_THROTTLE) {
    return;
  }
  state.lastGridNavigationTime = now;
  
  const visibleClips = getVisibleClips();
  if (visibleClips.length === 0) return;
  
  state.currentClip = visibleClips[state.currentGridFocusIndex];
  if (!state.currentClip) return;
  
  let newIndex = state.currentGridFocusIndex;
  
  switch (direction) {
    case 'left':
      if (state.currentGridFocusIndex > 0) {
        newIndex = state.currentGridFocusIndex - 1;
      }
      break;

    case 'right':
      if (state.currentGridFocusIndex < visibleClips.length - 1) {
        newIndex = state.currentGridFocusIndex + 1;
      }
      break;

    case 'up':
      newIndex = findClipInDirection(visibleClips, state.currentGridFocusIndex, 'up');
      break;

    case 'down':
      newIndex = findClipInDirection(visibleClips, state.currentGridFocusIndex, 'down');
      break;
  }
  
  if (newIndex !== state.currentGridFocusIndex && newIndex >= 0 && newIndex < visibleClips.length) {
    state.currentGridFocusIndex = newIndex;
    updateGridSelection();
  }
}

function getVisibleClips() {
  return Array.from(document.querySelectorAll('.clip-item:not(.hidden)'));
}

function findClipInDirection(clips, currentIndex, direction) {
  if (clips.length === 0) return currentIndex;
  
  const gridElement = document.getElementById('clip-grid');
  if (!gridElement) return currentIndex;
  
  if (currentIndex < 0 || currentIndex >= clips.length) return currentIndex;
  
  const currentClip = clips[currentIndex];
  if (!currentClip) return currentIndex;
  
  const currentRect = currentClip.getBoundingClientRect();
  
  switch (direction) {
    case 'up':
      // same column = left edge within one clip width
      for (let i = currentIndex - 1; i >= 0; i--) {
        const clipRect = clips[i].getBoundingClientRect();
        if (Math.abs(clipRect.left - currentRect.left) < currentRect.width) {
          return i;
        }
      }
      return currentIndex;

    case 'down':
      for (let i = currentIndex + 1; i < clips.length; i++) {
        const clipRect = clips[i].getBoundingClientRect();
        if (Math.abs(clipRect.left - currentRect.left) < currentRect.width) {
          return i;
        }
      }
      return currentIndex;

    case 'left':
      if (currentIndex > 0) {
        return currentIndex - 1;
      }
      return currentIndex;

    case 'right':
      if (currentIndex < clips.length - 1) {
        return currentIndex + 1;
      }
      return currentIndex;

    default:
      return currentIndex;
  }
}

function updateGridSelection() {
  document.querySelectorAll('.clip-item').forEach(clip => {
    clip.classList.remove('grid-focused');
  });

  const visibleClips = getVisibleClips();
  if (visibleClips.length > 0 && state.currentGridFocusIndex < visibleClips.length) {
    const selectedClip = visibleClips[state.currentGridFocusIndex];
    if (selectedClip) {
      selectedClip.classList.add('grid-focused');
      selectedClip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }
}

/**
 * @param {Object} dependencies - override the module's clip-list/selection functions
 */
function init(dependencies = {}) {
  if (dependencies.getVisibleClips) {
    getVisibleClips = dependencies.getVisibleClips;
  }
  
  if (dependencies.findClipInDirection) {
    findClipInDirection = dependencies.findClipInDirection;
  }
  
  if (dependencies.updateGridSelection) {
    updateGridSelection = dependencies.updateGridSelection;
  }
  
  logger.info('[GridNavigation] Module initialized');
}

module.exports = {
  init,
  moveGridSelection
};
