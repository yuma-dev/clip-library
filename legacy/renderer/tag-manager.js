// tag crud, filtering, and the tag filter dropdown ui

const { ipcRenderer } = require('electron');
const logger = require('../utils/logger');
const state = require('./state');

let globalTags = [];


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

// adds tag and enables it in both saved and active tag filters
async function addGlobalTag(tag) {
  if (!globalTags.includes(tag)) {
    globalTags.push(tag);
    await saveGlobalTags();
    
    state.savedTagSelections.add(tag);
    state.selectedTags.add(tag);
    await saveTagPreferences();
    
    updateFilterDropdown();
    updateTagSelectionUI();
    // caller re-filters after this
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

    logger.info(`Starting to remove tag "${tag}" from all .tags files on disk...`);
    const result = await ipcRenderer.invoke("remove-tag-from-all-clips", tag);
    
    if (result.success) {
      logger.info(`Successfully removed tag "${tag}" from ${result.modifiedCount} clips on disk`);
      
      // ipc call above only touched disk, sync in-memory clips too
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
  if (originalTag === newTag) return;

  const index = globalTags.indexOf(originalTag);
  if (index > -1) {
    logger.info(`Updating tag "${originalTag}" to "${newTag}"`);
    globalTags[index] = newTag;
    await saveGlobalTags();

    logger.info(`Starting to update tag "${originalTag}" to "${newTag}" in all .tags files on disk...`);
    const result = await ipcRenderer.invoke("update-tag-in-all-clips", originalTag, newTag);
    
    if (result.success) {
      logger.info(`Successfully updated tag in ${result.modifiedCount} clips on disk`);
      
      // ipc call above only touched disk, sync in-memory clips too
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

    updateFilterDropdown();

    // caller/callback still owns triggering the actual re-filter
    const filterDropdown = document.getElementById("filter-dropdown");
    if (filterDropdown && filterDropdown.value === originalTag) {
      filterDropdown.value = newTag;
    }

    logger.info(`Tag "${originalTag}" updated to "${newTag}"`);
  } else {
    logger.warn(`Tag "${originalTag}" not found in globalTags`);
  }
}

/**
 * Toggle a tag on a single clip and persist.
 */
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

  // re-render whole view if this change could hide the clip under current filters
  if (state.selectedTags.size > 0 && callbacks.onFilterNeeded) {
    const shouldBeVisible = () => {
      const clipTags = Array.isArray(clip.tags) ? clip.tags : [];

      const baseFileName = clip.originalName.replace(/\.[^/.]+$/, '');
      const isUnnamed = clip.customName === baseFileName;
      
      const isUntagged = clipTags.length === 0;

      if (isUntagged && !state.selectedTags.has('Untagged')) {
        return false;
      }

      if (isUnnamed && !state.selectedTags.has('Unnamed')) {
        return false;
      }

      if (clipTags.length > 0) {
        if (state.isInTemporaryMode) {
          return clipTags.some(tag => state.temporaryTagSelections.has(tag));
        } else {
          return clipTags.every(tag => state.selectedTags.has(tag));
        }
      }

      return state.selectedTags.has('Untagged');
    };

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
    state.clipDataCache.delete(clip.originalName); // stale entry would serve old tags on next open
  } catch (error) {
    logger.error("Error saving clip tags:", error);
  }
}

async function loadTagPreferences() {
  try {
    const savedTags = await ipcRenderer.invoke('get-tag-preferences');
    if (savedTags && savedTags.length > 0) {
      state.savedTagSelections = new Set(savedTags);
      
      // migrate: "Unnamed" was added after this pref existed, backfill it in
      if (!state.savedTagSelections.has('Unnamed')) {
        state.savedTagSelections.add('Unnamed');
        await ipcRenderer.invoke('save-tag-preferences', Array.from(state.savedTagSelections));
      }
    } else {
      state.savedTagSelections = new Set(['Untagged', 'Unnamed', ...globalTags]);
    }
    state.selectedTags = new Set(state.savedTagSelections);
  } catch (error) {
    logger.error('Error loading tag preferences:', error);
    state.savedTagSelections = new Set(['Untagged', 'Unnamed', ...globalTags]);
    state.selectedTags = new Set(state.savedTagSelections);
  }
  
  updateFilterDropdown();
}

async function saveTagPreferences() {
  try {
    await ipcRenderer.invoke('save-tag-preferences', Array.from(state.savedTagSelections));
  } catch (error) {
    logger.error('Error saving tag preferences:', error);
  }
}

// ui helpers

function updateTagList() {
  const tagList = document.getElementById("tag-list");
  const tagSearchInput = document.getElementById("tag-search-input");
  
  if (!tagList || !tagSearchInput) return;
  
  const searchTerm = tagSearchInput.value.toLowerCase();
  
  let tagsToShow = globalTags.filter(tag => tag.toLowerCase().includes(searchTerm));
  
  // closer matches to the search term sort first
  tagsToShow.sort((a, b) => {
    const aIndex = a.toLowerCase().indexOf(searchTerm);
    const bIndex = b.toLowerCase().indexOf(searchTerm);
    if (aIndex === bIndex) {
      return a.localeCompare(b);
    }
    return aIndex - bIndex;
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
  const clipElement = document.querySelector(`.clip-item[data-original-name="${CSS.escape(clip.originalName)}"]`);
  if (clipElement) {
    const tagContainer = clipElement.querySelector(".tag-container");
    tagContainer.innerHTML = "";
    
    const visibleTags = clip.tags.slice(0, 3);
    visibleTags.forEach(tag => {
      const tagElement = document.createElement("span");
      tagElement.className = "tag";
      tagElement.textContent = truncateTag(tag);
      tagElement.title = tag;
      tagContainer.appendChild(tagElement);
    });
    
    if (clip.tags.length > 3) {
      const moreTagsElement = document.createElement("span");
      moreTagsElement.className = "tag more-tags";
      moreTagsElement.textContent = `+${clip.tags.length - 3}`;
      
      const tooltip = document.createElement("div");
      tooltip.className = "tags-tooltip";
      
      clip.tags.slice(3).forEach(tag => {
        const tooltipTag = document.createElement("span");
        tooltipTag.className = "tooltip-tag";
        tooltipTag.textContent = tag;
        tooltip.appendChild(tooltipTag);
      });
      
      moreTagsElement.appendChild(tooltip);
      tagContainer.appendChild(moreTagsElement);

      moreTagsElement.addEventListener('mouseenter', (e) => showTooltip(e, tooltip));
      moreTagsElement.addEventListener('mouseleave', () => hideTooltip(tooltip));
    }
  }
}

function showTooltip(event, tooltip) {
  const rect = event.target.getBoundingClientRect();
  tooltip.style.display = 'flex';
  tooltip.style.position = 'fixed';
  tooltip.style.zIndex = '10000'; // above everything else in the app
  tooltip.style.left = `${rect.left}px`;
  tooltip.style.top = `${rect.bottom + 5}px`;

  // clamp into viewport
  const tooltipRect = tooltip.getBoundingClientRect();
  if (tooltipRect.right > window.innerWidth) {
    tooltip.style.left = `${window.innerWidth - tooltipRect.width}px`;
  }
  if (tooltipRect.bottom > window.innerHeight) {
    tooltip.style.top = `${rect.top - tooltipRect.height - 5}px`;
  }

  // reparent to body so an ancestor with overflow:hidden can't clip it
  document.body.appendChild(tooltip);
}

function hideTooltip(tooltip) {
  tooltip.style.display = 'none';
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

// filter dropdown

function updateFilterDropdown() {
  const tagList = document.getElementById('tagv2-list');
  const tagCount = document.getElementById('tagv2-count');
  
  if (!tagList || !tagCount) return;
  
  tagList.innerHTML = '';
  
  const allTags = new Set(['Untagged', 'Unnamed', ...globalTags]);
  
  tagCount.textContent = `(${state.selectedTags.size}/${allTags.size})`;

  // Untagged/Unnamed are system tags, always shown first
  const untaggedItem = createTagItem('Untagged');
  tagList.appendChild(untaggedItem);
  
  const unnamedItem = createTagItem('Unnamed');
  tagList.appendChild(unnamedItem);
  
  const separator = document.createElement('div');
  separator.className = 'tagv2-separator';
  tagList.appendChild(separator);
  
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
  
  indicator.addEventListener('click', (e) => {
    e.stopPropagation(); // indicator has its own click meaning, don't fall through to tagItem's
    handleCtrlClickTag(tag, tagItem); // clicking the indicator = focusing on just this tag
  });

  tagItem.addEventListener('click', (e) => {
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

let onFilterUpdate = () => {}; // set by renderer.js

function setFilterUpdateCallback(callback) {
  onFilterUpdate = callback;
}

function handleCtrlClickTag(tag, tagItem) {
  if (!state.isInTemporaryMode || !state.temporaryTagSelections.has(tag)) {
    enterTemporaryMode(tag);
  } else {
    exitTemporaryMode();
  }
  
  updateTagSelectionUI();
  onFilterUpdate();
}

function handleRegularClickTag(tag, tagItem) {
  if (state.isInTemporaryMode) {
    exitTemporaryMode();
  } 
  
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
  state.selectedTags = state.temporaryTagSelections;
}

function exitTemporaryMode() {
  state.isInTemporaryMode = false;
  state.temporaryTagSelections.clear();
  state.selectedTags = new Set(state.savedTagSelections);
}

function updateTagSelectionUI() {
  const tagItems = document.querySelectorAll('.tagv2-item');
  tagItems.forEach(item => {
    const label = item.querySelector('.tagv2-item-label').textContent;
    const isSelected = state.isInTemporaryMode ?
      state.temporaryTagSelections.has(label) :
      state.savedTagSelections.has(label);
    
    item.classList.toggle('selected', isSelected);
    
    if (state.isInTemporaryMode && state.temporaryTagSelections.has(label)) {
      item.classList.add('temp-selected');
    } else {
      item.classList.remove('temp-selected');
    }
  });
  
  updateTagCount();
}

// like updateTagSelectionUI but keys off state.selectedTags, not saved/temporary
function updateTagSelectionStates() {
  const tagItems = document.querySelectorAll('.tagv2-item');
  tagItems.forEach(item => {
    const label = item.querySelector('.tagv2-item-label').textContent;
    item.classList.toggle('selected', state.selectedTags.has(label));
  });
}

function updateTagCount() {
  const tagCount = document.getElementById('tagv2-count');
  const allTags = new Set(['Untagged', 'Unnamed', ...globalTags]);
  tagCount.textContent = `(${state.selectedTags.size}/${allTags.size})`;
}

function createTagFilterUI() {
  const oldDropdown = document.getElementById('filter-dropdown');
  if (oldDropdown) {
    oldDropdown.remove();
  }

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

  const searchContainer = document.getElementById('search-container');
  if (searchContainer) {
    const searchFilterPill = document.getElementById('search-filter-pill');
    const existingFilters = document.querySelectorAll('.tagv2-filter');
    existingFilters.forEach(filter => filter.remove());

    if (searchFilterPill && searchFilterPill.contains(searchContainer)) {
      searchFilterPill.appendChild(tagFilter);
    } else {
      searchContainer.after(tagFilter);
    }
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
    tagButton.addEventListener('click', (e) => {
      e.stopPropagation();
      tagDropdown.classList.toggle('show');
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.tagv2-filter')) {
      tagDropdown?.classList.remove('show');
    }
  });

  if (tagSearch) {
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
      e.stopPropagation();
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
      e.stopPropagation();
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
