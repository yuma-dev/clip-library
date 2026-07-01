/**
 * Grid Navigation Module
 *
 * Handles keyboard and gamepad navigation through the clip grid:
 * - Arrow key navigation (up, down, left, right)
 * - Grid focus management
 * - Navigation throttling for smooth experience
 */

// Imports
const logger = require('../utils/logger');
const state = require('./state');

// ============================================================================
// CONSTANTS
// ============================================================================
const GRID_NAVIGATION_THROTTLE = 150; // ms between navigation actions

// ============================================================================
// GRID NAVIGATION FUNCTIONS
// ============================================================================

/**
 * Move grid selection in the specified direction
 * 
 * @param {string} direction - Direction to move ('up', 'down', 'left', 'right')
 */
function moveGridSelection(direction) {
  if (!state.gridNavigationEnabled) return;
  
  // Throttle navigation to prevent spam
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
      // Simple: move to previous clip
      if (state.currentGridFocusIndex > 0) {
        newIndex = state.currentGridFocusIndex - 1;
      }
      break;
      
    case 'right':
      // Simple: move to next clip
      if (state.currentGridFocusIndex < visibleClips.length - 1) {
        newIndex = state.currentGridFocusIndex + 1;
      }
      break;
      
    case 'up':
      // Find closest clip above
      newIndex = findClipInDirection(visibleClips, state.currentGridFocusIndex, 'up');
      break;
      
    case 'down':
      // Find closest clip below
      newIndex = findClipInDirection(visibleClips, state.currentGridFocusIndex, 'down');
      break;
  }
  
  if (newIndex !== state.currentGridFocusIndex && newIndex >= 0 && newIndex < visibleClips.length) {
    state.currentGridFocusIndex = newIndex;
    updateGridSelection();
  }
}

/**
 * Get clips that are currently visible in the grid
 * 
 * @returns {Array} Array of visible clip elements
 */
function getVisibleClips() {
  // Get all clip elements that are currently visible in the grid
  return Array.from(document.querySelectorAll('.clip-item:not(.hidden)'));
}

/**
 * Find the closest clip in the specified direction
 * 
 * @param {Array} clips - Array of clip elements
 * @param {number} currentIndex - Current clip index
 * @param {string} direction - Direction to search ('up', 'down', 'left', 'right')
 * @returns {number} Index of the clip in the specified direction
 */
function findClipInDirection(clips, currentIndex, direction) {
  if (clips.length === 0) return currentIndex;
  
  const gridElement = document.getElementById('clip-grid');
  if (!gridElement) return currentIndex;
  
  if (currentIndex < 0 || currentIndex >= clips.length) return currentIndex;
  
  // Get the bounding rectangle of the current clip
  const currentClip = clips[currentIndex];
  if (!currentClip) return currentIndex;
  
  const currentRect = currentClip.getBoundingClientRect();
  
  switch (direction) {
    case 'up':
      // Find the clip above the current one
      for (let i = currentIndex - 1; i >= 0; i--) {
        const clipRect = clips[i].getBoundingClientRect();
        // Check if this clip is in the same column (approximately)
        if (Math.abs(clipRect.left - currentRect.left) < currentRect.width) {
          return i;
        }
      }
      return currentIndex;
      
    case 'down':
      // Find the clip below the current one
      for (let i = currentIndex + 1; i < clips.length; i++) {
        const clipRect = clips[i].getBoundingClientRect();
        // Check if this clip is in the same column (approximately)
        if (Math.abs(clipRect.left - currentRect.left) < currentRect.width) {
          return i;
        }
      }
      return currentIndex;
      
    case 'left':
      // Find the clip to the left
      if (currentIndex > 0) {
        return currentIndex - 1;
      }
      return currentIndex;
      
    case 'right':
      // Find the clip to the right
      if (currentIndex < clips.length - 1) {
        return currentIndex + 1;
      }
      return currentIndex;
      
    default:
      return currentIndex;
  }
}

/**
 * Update the visual selection in the grid
 */
function updateGridSelection() {
  // Remove focus class from all clips
  document.querySelectorAll('.clip-item').forEach(clip => {
    clip.classList.remove('grid-focused');
  });
  
  // Add focus class to the currently selected clip
  const visibleClips = getVisibleClips();
  if (visibleClips.length > 0 && state.currentGridFocusIndex < visibleClips.length) {
    const selectedClip = visibleClips[state.currentGridFocusIndex];
    if (selectedClip) {
      selectedClip.classList.add('grid-focused');
      
      // Scroll the selected clip into view if needed
      selectedClip.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the grid navigation module
 * 
 * @param {Object} dependencies - Dependencies needed by this module
 * @param {Function} dependencies.getVisibleClips - Function to get visible clips
 * @param {Function} dependencies.findClipInDirection - Function to find clip in direction
 * @param {Function} dependencies.updateGridSelection - Function to update grid selection
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

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Initialization
  init,
  
  // Navigation functions
  moveGridSelection
};
