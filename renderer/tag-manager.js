/**
 * Tag Manager Module
 *
 * Handles tag management operations:
 * - Loading and saving tags
 * - Adding/removing/updating tags
 * - Filtering clips by tags
 * - Tag UI management (filter dropdown, etc.)
 */

const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');
const state = require('./state');

// ============================================================================
// STATE
// ============================================================================
let globalTags = [];

// ============================================================================
// TAG MANAGEMENT OPERATIONS
// ============================================================================

async function loadGlobalTags() {
  try {
    globalTags = await ipcRenderer.invoke("load-global-tags");
    return globalTags;
  } catch (error) {
    logger.error("Error loading global tags:", error);
    globalTags = [];
    return [];
  }
}

async function saveGlobalTags() {
  try {
    const result = await ipcRenderer.invoke("save-global-tags", globalTags);
    logger.info("Global tags saved successfully:", result);
    return result;
  } catch (error) {
    logger.error("Error saving global tags:", error);
    throw error;
  }
}

async function addGlobalTag(tag) {
  if (!globalTags.includes(tag)) {
    globalTags.push(tag);
    await saveGlobalTags();
    
    // Automatically enable the new tag
    state.selectedTags.add(tag);
    saveTagPreferences();
    
    updateFilterDropdown();
    // Re-filter to show clips with the new tag - handled by caller or callback
  }
}

async function deleteTag(tag) {
  logger.info(`deleteTag called for: "${tag}"`);
  const index = globalTags.indexOf(tag);
  logger.info(`Tag index in globalTags: ${index}`);
  
  if (index > -1) {
    logger.info(`Removing tag from globalTags array`);
    globalTags.splice(index, 1);
    await saveGlobalTags();
    logger.info(`Global tags saved, current count: ${globalTags.length}`);

    // Remove the tag from all clips by reading files directly from disk
    logger.info(`Starting to remove tag "${tag}" from all .tags files on disk...`);
    const result = await ipcRenderer.invoke("remove-tag-from-all-clips", tag);
    
    if (result.success) {
      logger.info(`Successfully removed tag "${tag}" from ${result.modifiedCount} clips on disk`);
      
      // Also update any clips in memory
      let memoryClipsModified = 0;
      state.allClips.forEach(clip => {
        const tagIndex = clip.tags.indexOf(tag);
        if (tagIndex > -1) {
          memoryClipsModified++;
          clip.tags.splice(tagIndex, 1);
          updateClipTags(clip);
        }
      });
      
      if (memoryClipsModified > 0) {
        logger.info(`Updated ${memoryClipsModified} clips in memory as well`);
      }
    } else {
      logger.error(`Failed to remove tag from clips: ${result.error}`);
    }

    updateFilterDropdown();
  } else {
    logger.warn(`Tag "${tag}" not found in globalTags for deletion`);
  }
}

async function updateTag(originalTag, newTag) {
  if (originalTag === newTag) return; // No change, skip update

  const index = globalTags.indexOf(originalTag);
  if (index > -1) {
    logger.info(`Updating tag "${originalTag}" to "${newTag}"`);
    globalTags[index] = newTag;
    await saveGlobalTags();

    // Update the tag in all clips by reading files directly from disk
    logger.info(`Starting to update tag "${originalTag}" to "${newTag}" in all .tags files on disk...`);
    const result = await ipcRenderer.invoke("update-tag-in-all-clips", originalTag, newTag);
    
    if (result.success) {
      logger.info(`Successfully updated tag in ${result.modifiedCount} clips on disk`);
      
      // Also update any clips in memory
      let memoryClipsModified = 0;
      state.allClips.forEach(clip => {
        const tagIndex = clip.tags.indexOf(originalTag);
        if (tagIndex > -1) {
          memoryClipsModified++;
          clip.tags[tagIndex] = newTag;
          updateClipTags(clip);
        }
      });
      
      if (memoryClipsModified > 0) {
        logger.info(`Updated ${memoryClipsModified} clips in memory as well`);
      }
    } else {
      logger.error(`Failed to update tag in clips: ${result.error}`);
    }

    // Update the filter dropdown
    updateFilterDropdown();

    // If the current filter is the original tag, update it to the new tag
    // Note: DOM manipulation should be handled by caller or via callback
    const filterDropdown = document.getElementById("filter-dropdown");
    if (filterDropdown && filterDropdown.value === originalTag) {
      filterDropdown.value = newTag;
      // Trigger re-filter
    }

    logger.info(`Tag "${originalTag}" updated to "${newTag}"`);
  } else {
    logger.warn(`Tag "${originalTag}" not found in globalTags`);
  }
}

async function toggleClipTag(clip, tag, callbacks = {}) {
  if (!clip.tags) clip.tags = [];
  const index = clip.tags.indexOf(tag);
  
  if (index > -1) {
    clip.tags.splice(index, 1);
  } else {
    clip.tags.push(tag);
  }
  
  updateClipTags(clip);
  await saveClipTags(clip);

  // If we're in a filtered view and this tag change would affect visibility,
  // re-filter and re-render the entire view
  if (state.selectedTags.size > 0 && callbacks.onFilterNeeded) {
    // Check if this clip would be filtered out based on current tag selection
    const shouldBeVisible = () => {
      // Check if clip is unnamed
      const baseFileName = clip.originalName.replace(/\.[^/.]+$/, '');
      const isUnnamed = clip.customName === baseFileName;
      
      // Check if clip is untagged
      const isUntagged = !clip.tags || clip.tags.length === 0;

      // Handle system tag filtering
      let matchesSystemTag = false;
      
      // Handle untagged clips
      if (state.selectedTags.has('Untagged') && isUntagged) {
        matchesSystemTag = true;
      }

      // Handle unnamed clips
      if (state.selectedTags.has('Unnamed') && isUnnamed) {
        matchesSystemTag = true;
      }

      // If clip is untagged and "Untagged" is not selected, exclude it
      if (isUntagged && !state.selectedTags.has('Untagged')) {
        return false;
      }

      // If clip is unnamed and "Unnamed" is not selected, exclude it
      if (isUnnamed && !state.selectedTags.has('Unnamed')) {
        return false;
      }

      // If it matches a system tag, show it
      if (matchesSystemTag) {
        return true;
      }

      // For clips with tags, check regular tag filtering
      if (clip.tags && clip.tags.length > 0) {
        if (state.isInTemporaryMode) {
          // In temporary mode (focus mode), show clips that have ANY of the temporary selected tags
          return clip.tags.some(tag => state.temporaryTagSelections.has(tag));
        } else {
          // In normal mode, clips must have ALL their tags selected to be shown
          return clip.tags.every(tag => state.selectedTags.has(tag));
        }
      }

      return false;
    };

    // If tag change would affect visibility, re-filter everything
    const nowVisible = shouldBeVisible();
    if (nowVisible === false) {
      callbacks.onFilterNeeded();
    }
  }
  
  updateFilterDropdown();
}

async function saveClipTags(clip) {
  try {
    await ipcRenderer.invoke("save-clip-tags", clip.originalName, clip.tags);
    // Invalidate cache so next open gets fresh data
    state.clipDataCache.delete(clip.originalName);
  } catch (error) {
    logger.error("Error saving clip tags:", error);
  }
}

async function loadTagPreferences() {
  try {
    const savedTags = await ipcRenderer.invoke('get-tag-preferences');
    if (savedTags && savedTags.length > 0) {
      state.savedTagSelections = new Set(savedTags);
      
      // If "Unnamed" is not in saved preferences, add it automatically (first time feature introduction)
      if (!state.savedTagSelections.has('Unnamed')) {
        state.savedTagSelections.add('Unnamed');
        // Save the updated preferences
        await ipcRenderer.invoke('save-tag-preferences', Array.from(state.savedTagSelections));
      }
    } else {
      // Default to all tags visible, including system tags
      state.savedTagSelections = new Set(['Untagged', 'Unnamed', ...globalTags]);
    }
    state.selectedTags = new Set(state.savedTagSelections); // Initialize global state.selectedTags
  } catch (error) {
    logger.error('Error loading tag preferences:', error);
    state.savedTagSelections = new Set(['Untagged', 'Unnamed', ...globalTags]);
    state.selectedTags = new Set(state.savedTagSelections);
  }
  
  updateFilterDropdown();
}

async function saveTagPreferences() {
  try {
    await ipcRenderer.invoke('save-tag-preferences', Array.from(state.selectedTags));
  } catch (error) {
    logger.error('Error saving tag preferences:', error);
  }
}

// ============================================================================
// UI HELPERS
// ============================================================================

function updateTagList() {
  const tagList = document.getElementById("tag-list");
  const tagSearchInput = document.getElementById("tag-search-input");
  
  if (!tagList || !tagSearchInput) return;
  
  const searchTerm = tagSearchInput.value.toLowerCase();
  
  let tagsToShow = globalTags.filter(tag => tag.toLowerCase().includes(searchTerm));
  
  // Sort tags by how closely they match the search term
  tagsToShow.sort((a, b) => {
    const aIndex = a.toLowerCase().indexOf(searchTerm);
    const bIndex = b.toLowerCase().indexOf(searchTerm);
    if (aIndex === bIndex) {
      return a.localeCompare(b); // Alphabetical order if match position is the same
    }
    return aIndex - bIndex; // Earlier match comes first
  });

  tagList.innerHTML = "";
  tagsToShow.forEach(tag => {
    const tagElement = document.createElement("div");
    tagElement.className = "tag-item";
    
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.contextMenuClip && state.contextMenuClip.tags && state.contextMenuClip.tags.includes(tag);
    checkbox.onclick = async (e) => {
      e.stopPropagation();
      if (state.contextMenuClip) {
        await toggleClipTag(state.contextMenuClip, tag);
        checkbox.checked = state.contextMenuClip.tags.includes(tag);
      }
    };
    
    const tagText = document.createElement("span");
    tagText.textContent = truncateTag(tag);
    
    tagElement.appendChild(checkbox);
    tagElement.appendChild(tagText);
    
    tagElement.onclick = (e) => {
      e.stopPropagation();
      checkbox.click();
    };
    
    tagList.appendChild(tagElement);
  });
}

function truncateTag(tag, maxLength = 15) {
  if (tag.length <= maxLength) return tag;
  return tag.slice(0, maxLength - 1) + '..';
}

function updateClipTags(clip) {
  const clipElement = document.querySelector(`.clip-item[data-original-name="${clip.originalName}"]`);
  if (clipElement) {
    const tagContainer = clipElement.querySelector(".tag-container");
    tagContainer.innerHTML = "";
    
    const visibleTags = clip.tags.slice(0, 3);  // Show only first 3 tags
    visibleTags.forEach(tag => {
      const tagElement = document.createElement("span");
      tagElement.className = "tag";
      tagElement.textContent = truncateTag(tag);
      tagElement.title = tag; // Show full tag on hover
      tagContainer.appendChild(tagElement);
    });
    
    if (clip.tags.length > 3) {
      const moreTagsElement = document.createElement("span");
      moreTagsElement.className = "tag more-tags";
      moreTagsElement.textContent = `+${clip.tags.length - 3}`;
      
      // Create a tooltip element
      const tooltip = document.createElement("div");
      tooltip.className = "tags-tooltip";
      
      // Add remaining tags to the tooltip
      clip.tags.slice(3).forEach(tag => {
        const tooltipTag = document.createElement("span");
        tooltipTag.className = "tooltip-tag";
        tooltipTag.textContent = tag;
        tooltip.appendChild(tooltipTag);
      });
      
      moreTagsElement.appendChild(tooltip);
      tagContainer.appendChild(moreTagsElement);

      // Add event listeners
      moreTagsElement.addEventListener('mouseenter', (e) => showTooltip(e, tooltip));
      moreTagsElement.addEventListener('mouseleave', () => hideTooltip(tooltip));
    }
  }
}

function showTooltip(event, tooltip) {
  const rect = event.target.getBoundingClientRect();
  tooltip.style.display = 'flex';
  tooltip.style.position = 'fixed';
  tooltip.style.zIndex = '10000';  // Ensure this is higher than any other z-index in your app
  tooltip.style.left = `${rect.left}px`;
  tooltip.style.top = `${rect.bottom + 5}px`; // 5px below the tag

  // Ensure the tooltip doesn't go off-screen
  const tooltipRect = tooltip.getBoundingClientRect();
  if (tooltipRect.right > window.innerWidth) {
    tooltip.style.left = `${window.innerWidth - tooltipRect.width}px`;
  }
  if (tooltipRect.bottom > window.innerHeight) {
    tooltip.style.top = `${rect.top - tooltipRect.height - 5}px`;
  }

  // Move the tooltip to the body to ensure it's not constrained by any parent elements
  document.body.appendChild(tooltip);
}

function hideTooltip(tooltip) {
  tooltip.style.display = 'none';
  // Move the tooltip back to its original parent
  if (tooltip.parentElement === document.body) {
    const moreTagsElement = tooltip.previousElementSibling;
    if (moreTagsElement) {
      moreTagsElement.appendChild(tooltip);
    }
  }
}

function setupTagTooltips(clipElement) {
  const moreTags = clipElement.querySelector('.more-tags');
  if (moreTags) {
    const tooltip = moreTags.querySelector('.tags-tooltip');
    if (tooltip) {
      moreTags.addEventListener('mouseenter', (e) => showTooltip(e, tooltip));
      moreTags.addEventListener('mouseleave', () => hideTooltip(tooltip));
    }
  }
}

function setupTooltips() {
  document.querySelectorAll('.more-tags').forEach(moreTags => {
    const tooltip = moreTags.querySelector('.tags-tooltip');
    
    moreTags.addEventListener('mouseenter', (e) => {
      showTooltip(e, tooltip);
    });
    
    moreTags.addEventListener('mouseleave', () => {
      hideTooltip(tooltip);
    });
  });
}

// ============================================================================
// FILTER DROPDOWN UI
// ============================================================================

function updateFilterDropdown() {
  const tagList = document.getElementById('tagv2-list');
  const tagCount = document.getElementById('tagv2-count');
  
  if (!tagList || !tagCount) return;
  
  // Clear existing list
  tagList.innerHTML = '';
  
  // Get all unique tags and add system tags
  const allTags = new Set(['Untagged', 'Unnamed', ...globalTags]);
  
  // Update count
  tagCount.textContent = `(${state.selectedTags.size}/${allTags.size})`;

  // Create and add the "Untagged" option first
  const untaggedItem = createTagItem('Untagged');
  tagList.appendChild(untaggedItem);
  
  // Create and add the "Unnamed" option
  const unnamedItem = createTagItem('Unnamed');
  tagList.appendChild(unnamedItem);
  
  // Add a separator
  const separator = document.createElement('div');
  separator.className = 'tagv2-separator';
  tagList.appendChild(separator);
  
  // Add all other tags
  globalTags.forEach(tag => {
    const tagItem = createTagItem(tag);
    tagList.appendChild(tagItem);
  });
}

function createTagItem(tag) {
  const tagItem = document.createElement('div');
  tagItem.className = `tagv2-item ${state.savedTagSelections.has(tag) ? 'selected' : ''}`;
  
  const label = document.createElement('span');
  label.className = 'tagv2-item-label';
  label.textContent = tag;
  
  const indicator = document.createElement('span');
  indicator.className = 'tagv2-indicator';
  
  tagItem.appendChild(label);
  tagItem.appendChild(indicator);
  
  // Separate click handlers for indicator and general tag area
  indicator.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent the click from triggering the tag click
    handleCtrlClickTag(tag, tagItem); // Reuse the ctrl+click logic for single tag focus
  });

  tagItem.addEventListener('click', (e) => {
    // Only handle clicks on the tag area, not the indicator
    if (!e.target.classList.contains('tagv2-indicator')) {
      if (e.ctrlKey || e.metaKey) {
        handleCtrlClickTag(tag, tagItem);
      } else {
        handleRegularClickTag(tag, tagItem);
      }
    }
  });
  
  return tagItem;
}

// Callbacks for filter updates (to be set by renderer.js)
let onFilterUpdate = () => {};

function setFilterUpdateCallback(callback) {
  onFilterUpdate = callback;
}

function handleCtrlClickTag(tag, tagItem) {
  if (!state.isInTemporaryMode || !state.temporaryTagSelections.has(tag)) {
    // Enter temporary mode or add to temporary selections
    enterTemporaryMode(tag);
  } else {
    // If ctrl-clicking a temporary selected tag, revert to saved selections
    exitTemporaryMode();
  }
  
  updateTagSelectionUI();
  onFilterUpdate();
}

function handleRegularClickTag(tag, tagItem) {
  if (state.isInTemporaryMode) {
    // If in temporary mode, regular click exits it
    exitTemporaryMode();
  } 
  
  // Toggle the tag selection
  if (state.savedTagSelections.has(tag)) {
    state.savedTagSelections.delete(tag);
  } else {
    state.savedTagSelections.add(tag);
  }
  state.selectedTags = new Set(state.savedTagSelections);
  saveTagPreferences();
  
  updateTagSelectionUI();
  onFilterUpdate();
}

function enterTemporaryMode(tag) {
  state.isInTemporaryMode = true;
  state.temporaryTagSelections.clear();
  state.temporaryTagSelections.add(tag);
  state.selectedTags = state.temporaryTagSelections; // Update the global state.selectedTags
}

function exitTemporaryMode() {
  state.isInTemporaryMode = false;
  state.temporaryTagSelections.clear();
  state.selectedTags = new Set(state.savedTagSelections); // Restore saved selections
}

function updateTagSelectionUI() {
  const tagItems = document.querySelectorAll('.tagv2-item');
  tagItems.forEach(item => {
    const label = item.querySelector('.tagv2-item-label').textContent;
    const isSelected = state.isInTemporaryMode ? 
      state.temporaryTagSelections.has(label) : 
      state.savedTagSelections.has(label);
    
    item.classList.toggle('selected', isSelected);
    
    // Add visual indicator for temporary mode
    if (state.isInTemporaryMode && state.temporaryTagSelections.has(label)) {
      item.classList.add('temp-selected');
    } else {
      item.classList.remove('temp-selected');
    }
  });
  
  updateTagCount();
}

function updateTagSelectionStates() {
  const tagItems = document.querySelectorAll('.tagv2-item');
  tagItems.forEach(item => {
    const label = item.querySelector('.tagv2-item-label').textContent;
    item.classList.toggle('selected', state.selectedTags.has(label));
  });
}

function updateTagCount() {
  const tagCount = document.getElementById('tagv2-count');
  const allTags = new Set(['Untagged', ...globalTags]);
  tagCount.textContent = `(${state.selectedTags.size}/${allTags.size})`;
}

function createTagFilterUI() {
  // First remove old filter dropdown if it exists
  const oldDropdown = document.getElementById('filter-dropdown');
  if (oldDropdown) {
    oldDropdown.remove();
  }

  // Create the new tag filter structure
  const tagFilter = document.createElement('div');
  tagFilter.id = 'tagv2-filter';
  tagFilter.className = 'tagv2-filter';
  
  tagFilter.innerHTML = `
    <button id="tagv2-button" class="tagv2-button">
      <span>Tags</span>
      <span id="tagv2-count">(0/0)</span>
    </button>
    <div id="tagv2-dropdown" class="tagv2-dropdown">
      <div class="tagv2-actions">
        <button id="tagv2-select-all">Show All</button>
        <button id="tagv2-deselect-all">Hide All</button>
      </div>
      <div id="tagv2-list" class="tagv2-list"></div>
    </div>
  `;

  // Find the search container and insert after it
  const searchContainer = document.getElementById('search-container');
  if (searchContainer) {
    // Look for any existing tag filters and remove them
    const existingFilters = document.querySelectorAll('.tagv2-filter');
    existingFilters.forEach(filter => filter.remove());
    
    searchContainer.after(tagFilter);
  }

  setupTagFilterEventListeners();
}

function setupTagFilterEventListeners() {
  const tagButton = document.getElementById('tagv2-button');
  const tagDropdown = document.getElementById('tagv2-dropdown');
  const tagSearch = document.getElementById('tagv2-search');
  const selectAllBtn = document.getElementById('tagv2-select-all');
  const deselectAllBtn = document.getElementById('tagv2-deselect-all');

  if (tagButton && tagDropdown) {
    // Toggle dropdown
    tagButton.addEventListener('click', (e) => {
      e.stopPropagation();
      tagDropdown.classList.toggle('show');
    });
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.tagv2-filter')) {
      tagDropdown?.classList.remove('show');
    }
  });

  if (tagSearch) {
    // Search functionality
    tagSearch.addEventListener('input', debounce(() => {
      const searchTerm = tagSearch.value.toLowerCase();
      const tagItems = document.querySelectorAll('.tagv2-item');
      
      tagItems.forEach(item => {
        const label = item.querySelector('.tagv2-item-label').textContent.toLowerCase();
        item.style.display = label.includes(searchTerm) ? '' : 'none';
      });
    }, 300));
  }

  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent event from bubbling up
      exitTemporaryMode();
      state.savedTagSelections = new Set(['Untagged', 'Unnamed', ...globalTags]);
      state.selectedTags = new Set(state.savedTagSelections);
      saveTagPreferences();
      updateTagSelectionStates();
      updateTagCount();
      onFilterUpdate();
    });
  }
  
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent event from bubbling up
      exitTemporaryMode();
      state.savedTagSelections.clear();
      state.selectedTags.clear();
      saveTagPreferences();
      updateTagSelectionStates();
      updateTagCount();
      onFilterUpdate();
    });
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Constants
  getGlobalTags: () => globalTags,

  // Operations
  loadGlobalTags,
  saveGlobalTags,
  addGlobalTag,
  deleteTag,
  updateTag,
  toggleClipTag,
  saveClipTags,
  loadTagPreferences,
  saveTagPreferences,

  // UI Helpers
  updateTagList,
  truncateTag,
  updateClipTags,
  showTooltip,
  hideTooltip,
  setupTooltips,
  setupTagTooltips,

  // Filter Dropdown
  createTagFilterUI,
  updateFilterDropdown,
  createTagItem,
  handleCtrlClickTag,
  handleRegularClickTag,
  enterTemporaryMode,
  exitTemporaryMode,
  updateTagSelectionUI,
  updateTagSelectionStates,
  updateTagCount,
  setFilterUpdateCallback
};
