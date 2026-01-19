/**
 * Grid Navigation Module
 *
 * Handles keyboard and gamepad navigation through the clip grid:
 * - Arrow key navigation (up, down, left, right)
 * - Grid focus management
 * - Navigation throttling for smooth experience
 */

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
 * @returns {Array} Array of visible clip objects
 */
function getVisibleClips() {
  // This function would need to be injected or imported
  // For now, we'll assume it's available in the state or passed as dependency
  return state.currentClipList || [];
}

/**
 * Find the closest clip in the specified direction
 * 
 * @param {Array} clips - Array of clip objects
 * @param {number} currentIndex - Current clip index
 * @param {string} direction - Direction to search ('up' or 'down')
 * @returns {number} Index of the clip in the specified direction
 */
function findClipInDirection(clips, currentIndex, direction) {
  // This function would need to be injected or imported
  // For now, we'll return a simple implementation
  if (direction === 'up' && currentIndex > 0) {
    return currentIndex - 1;
  } else if (direction === 'down' && currentIndex < clips.length - 1) {
    return currentIndex + 1;
  }
  return currentIndex;
}

/**
 * Update the visual selection in the grid
 */
function updateGridSelection() {
  // This function would need to be injected or imported
  // For now, we'll just log that it should be called
  logger.info('Grid selection updated to index:', state.currentGridFocusIndex);
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