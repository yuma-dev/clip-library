/**
 * Search Manager Module
 * Handles search and filtering functionality for the clip library
 */

// Imports
const logger = require('../utils/logger');

// Dependencies (injected)
let state, renderClips, updateClipCounter, updateNavigationButtons, filterClips, tagManagerModule, videoPlayerModule;

/**
 * Initialize the search manager with required dependencies
 */
function init(dependencies) {
  state = dependencies.state;
  renderClips = dependencies.renderClips;
  updateClipCounter = dependencies.updateClipCounter;
  updateNavigationButtons = dependencies.updateNavigationButtons;
  filterClips = dependencies.filterClips;
  tagManagerModule = dependencies.tagManagerModule;
  videoPlayerModule = dependencies.videoPlayerModule;
}

// Search input wiring
/**
 * Set up search input event listeners.
 */
function setupSearch() {
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", videoPlayerModule.debounce(performSearch, 300));
}

/**
 * Perform search based on current search text.
 */
function performSearch() {
  const searchDisplay = document.getElementById('search-display');
  if (!searchDisplay) return;

  const searchText = searchDisplay.innerText.trim().toLowerCase();
  const searchTerms = parseSearchTerms(searchText);

  // Start with all clips
  let filteredClips = [...state.allClips];

  // Apply search terms if they exist
  if (searchTerms.tags.length > 0 || searchTerms.text.length > 0) {
    filteredClips = filteredClips.filter(clip => {
      // Check tag matches
      const hasMatchingTags = searchTerms.tags.length === 0 ||
        searchTerms.tags.every(searchTag =>
          clip.tags.some(clipTag =>
            clipTag.toLowerCase().includes(searchTag.toLowerCase().substring(1))
          )
        );

      // Check text matches
      const hasMatchingText = searchTerms.text.length === 0 ||
        searchTerms.text.every(word =>
          clip.customName.toLowerCase().includes(word) ||
          clip.originalName.toLowerCase().includes(word)
        );

      return hasMatchingTags && hasMatchingText;
    });
  }

  // Apply tag filter from dropdown
  if (state.selectedTags.size > 0) {
    filteredClips = filteredClips.filter(clip => {
      if (state.selectedTags.has('Untagged')) {
        if (!clip.tags || clip.tags.length === 0) {
          return true;
        }
      }
      return clip.tags && clip.tags.some(tag => state.selectedTags.has(tag));
    });
  }

  // Remove duplicates
  state.currentClipList = filteredClips.filter((clip, index, self) =>
    index === self.findIndex((t) => t.originalName === clip.originalName)
  );

  // Sort by creation date
  state.currentClipList.sort((a, b) => b.createdAt - a.createdAt);

  renderClips(state.currentClipList);
  updateClipCounter(state.currentClipList.length);

  if (state.currentClip) {
    updateNavigationButtons();
  }
}

/**
 * Parse search terms into tag and text buckets.
 */
function parseSearchTerms(searchText) {
  const terms = searchText.split(/\s+/).filter(term => term.length > 0);
  return {
    // Get all terms that start with @ (tags)
    tags: terms.filter(term => term.startsWith('@')),
    // Get all other terms (regular search)
    text: terms.filter(term => !term.startsWith('@'))
  };
}

/**
 * Style search text with tag highlighting.
 */
function styleSearchText(text) {
  // Split by @mentions while preserving spaces
  return text.split(/(@\S+)/).map(part => {
    if (part.startsWith('@')) {
      return `<span class="tag-highlight">${part}</span>`;
    }
    // Preserve spaces
    return part;
  }).join('');
}

/**
 * Create the search display element.
 */
function createSearchDisplay() {
  const searchContainer = document.getElementById('search-container');
  const searchInput = document.getElementById('search-input');

  if (!searchContainer || !searchInput) {
    logger.error('Search container or input not found');
    return null;
  }

  // Create display element if it doesn't exist
  let searchDisplay = document.getElementById('search-display');
  if (!searchDisplay) {
    searchDisplay = document.createElement('div');
    searchDisplay.id = 'search-display';
    searchDisplay.contentEditable = true;
    searchDisplay.className = 'search-display';
    searchDisplay.setAttribute('role', 'textbox');
    searchDisplay.setAttribute('aria-label', 'Search input');
    searchDisplay.setAttribute('tabindex', '0');

    // Replace input with display
    searchInput.style.display = 'none';
    searchContainer.appendChild(searchDisplay);
    // Mirror placeholder focus effect on initial focus when user clicks in
    searchDisplay.addEventListener('focus', () => {
      searchDisplay.classList.add('focused');
    });
    searchDisplay.addEventListener('blur', () => {
      searchDisplay.classList.remove('focused');
    });
  }

  return searchDisplay;
}

/**
 * Update the search display with styled content.
 */
function updateSearchDisplay() {
  const searchInput = document.getElementById('search-input');
  const searchDisplay = document.getElementById('search-display');

  if (!searchDisplay || !searchInput) return;

  // Store cursor position if there is a selection
  let savedSelection = null;
  if (window.getSelection && window.getSelection().rangeCount > 0) {
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    savedSelection = {
      node: range.startContainer,
      offset: range.startOffset
    };
  }

  // Update display
  const text = searchDisplay.innerText;
  searchDisplay.innerHTML = styleSearchText(text);

  // Update hidden input value for search functionality
  searchInput.value = text;

  // Trigger search
  performSearch();

  // Restore cursor position if we had one
  if (savedSelection) {
    const selection = window.getSelection();
    const newRange = document.createRange();

    // Find the appropriate text node to place the cursor
    const textNodes = [];
    const walker = document.createTreeWalker(
      searchDisplay,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let node;
    while (node = walker.nextNode()) {
      textNodes.push(node);
    }

    if (textNodes.length > 0) {
      // Place cursor at the end if we can't find the exact position
      const lastNode = textNodes[textNodes.length - 1];
      newRange.setStart(lastNode, lastNode.length);
      newRange.collapse(true);

      selection.removeAllRanges();
      selection.addRange(newRange);
    }
  }
}

/**
 * Set up enhanced search functionality.
 */
function setupEnhancedSearch() {
  const searchDisplay = createSearchDisplay();

  if (!searchDisplay) {
    logger.error('Failed to create search display');
    return;
  }

  searchDisplay.addEventListener('input', () => {
    updateSearchDisplay();
  });

  searchDisplay.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  });

  searchDisplay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
    }
  });

  // Initialize with empty content
  searchDisplay.innerHTML = '';
}

/**
 * Initialize enhanced search when DOM is ready.
 */
function initializeEnhancedSearch() {
  if (document.getElementById('search-container')) {
    setupEnhancedSearch();
  } else {
    logger.warn('Search container not found, waiting for DOM...');
    // Try again in a short moment
    setTimeout(initializeEnhancedSearch, 100);
  }
}

// Tag management functionality
let isTagManagementOpen = false;

/**
 * Open the tag management modal.
 */
function openTagManagement() {
  if (isTagManagementOpen) {
    logger.info("Tag management modal is already open");
    return;
  }

  const existingModal = document.getElementById('tagManagementModal');
  if (existingModal) {
    existingModal.remove();
  }

  const container = document.querySelector('.cet-container') || document.body;
  const modal = document.createElement('div');
  modal.id = 'tagManagementModal';
  modal.className = 'tagManagement-modal';

  modal.innerHTML = `
    <div class="tagManagement-content">
      <div class="tagManagement-header">
        <h2 class="tagManagement-title">Tag Management</h2>
      </div>

      <div class="tagManagement-search">
        <input type="text"
               class="tagManagement-searchInput"
               placeholder="Search tags..."
               id="tagManagementSearch">
      </div>

      <div class="tagManagement-list" id="tagManagementList">
        ${tagManagerModule.getGlobalTags().length === 0 ?
          '<div class="tagManagement-noTags">No tags created yet. Add your first tag below!</div>' :
          ''}
      </div>

      <div class="tagManagement-footer">
        <button class="tagManagement-addBtn" id="tagManagementAddBtn">
          Add New Tag
        </button>
        <button class="tagManagement-closeBtn" id="tagManagementCloseBtn">
          Close
        </button>
      </div>
    </div>
  `;

  container.appendChild(modal);
  modal.style.display = 'block';
  isTagManagementOpen = true;
  if (window.uiBlur) window.uiBlur.enable();

  // Render initial tags
  renderTagList(tagManagerModule.getGlobalTags());

  // Setup event listeners
  const searchInput = document.getElementById('tagManagementSearch');
  const closeBtn = document.getElementById('tagManagementCloseBtn');
  const addBtn = document.getElementById('tagManagementAddBtn');

  searchInput.addEventListener('input', (e) => {
    const searchTerm = e.target.value.toLowerCase();
    const filteredTags = tagManagerModule.getGlobalTags().filter(tag =>
      tag.toLowerCase().includes(searchTerm)
    );
    renderTagList(filteredTags);
  });

  addBtn.addEventListener('click', async () => {
    await addNewTag();
  });

  closeBtn.addEventListener('click', closeTagManagement);

  // Close on click outside
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeTagManagement();
    }
  });

  // Close on Escape key
  document.addEventListener('keydown', handleEscapeKey);
}

/**
 * Render the tag list in the management modal.
 */
function renderTagList(tags) {
  const listElement = document.getElementById('tagManagementList');
  if (!listElement) return;

  listElement.innerHTML = tags.length === 0 ?
    '<div class="tagManagement-noTags">No tags found</div>' :
    tags.map(tag => `
      <div class="tagManagement-item" data-tag="${tag}">
        <input type="text"
               class="tagManagement-input"
               value="${tag}"
               data-original="${tag}">
        <button class="tagManagement-deleteBtn">Delete</button>
      </div>
    `).join('');

  // Add event listeners for input changes and delete buttons
  document.querySelectorAll('.tagManagement-input').forEach(input => {
    input.addEventListener('change', handleTagRename);
  });

  const deleteButtons = document.querySelectorAll('.tagManagement-deleteBtn');
  logger.info(`Setting up ${deleteButtons.length} delete button event listeners`);
  deleteButtons.forEach((btn, index) => {
    btn.addEventListener('click', handleTagDelete);
    logger.info(`Delete button ${index + 1} event listener attached`);
  });
}

/**
 * Handle tag renaming in the management modal.
 */
function handleTagRename(e) {
  const input = e.target;
  const originalTag = input.dataset.original;
  const newTag = input.value.trim();

  if (newTag && newTag !== originalTag) {
    tagManagerModule.updateTag(originalTag, newTag);
  }
}

/**
 * Handle tag deletion in the management modal.
 */
async function handleTagDelete(e) {
  const item = e.target.closest('.tagManagement-item');
  const tag = item.dataset.tag;

  if (tag) {
    logger.info(`Starting deletion of tag: "${tag}"`);
    try {
      await tagManagerModule.deleteTag(tag);
      logger.info(`Successfully deleted tag: "${tag}"`);
      item.remove();

      // Show no tags message if no tags left
      const listElement = document.getElementById('tagManagementList');
      if (listElement.children.length === 0) {
        listElement.innerHTML = '<div class="tagManagement-noTags">No tags found</div>';
      }
    } catch (error) {
      logger.error(`Error deleting tag "${tag}":`, error);
    }
  } else {
    logger.warn('No tag found for deletion');
  }
}

/**
 * Add a new tag from the tag management modal.
 */
async function addNewTag() {
  const searchInput = document.getElementById('tagManagementSearch');
  const newTagName = searchInput.value.trim();

  if (newTagName && !tagManagerModule.getGlobalTags().includes(newTagName)) {
    await tagManagerModule.addGlobalTag(newTagName);

    // Automatically enable the new tag
    state.selectedTags.add(newTagName);
    await tagManagerModule.saveTagPreferences();

    searchInput.value = '';
    renderTagList(tagManagerModule.getGlobalTags());
    tagManagerModule.updateFilterDropdown();
    filterClips();
  }
}

/**
 * Handle escape key for closing tag management.
 */
function handleEscapeKey(e) {
  if (e.key === 'Escape' && isTagManagementOpen) {
    closeTagManagement();
  }
}

/**
 * Close the tag management modal.
 */
function closeTagManagement() {
  const modal = document.getElementById('tagManagementModal');
  if (modal) {
    modal.style.opacity = '0';
    if (window.uiBlur) window.uiBlur.disable();
    setTimeout(() => {
      modal.remove();
      document.removeEventListener('keydown', handleEscapeKey);
    }, 300);
  }
  isTagManagementOpen = false;
}

// Module exports
module.exports = {
  init,
  setupSearch,
  performSearch,
  parseSearchTerms,
  styleSearchText,
  createSearchDisplay,
  updateSearchDisplay,
  setupEnhancedSearch,
  initializeEnhancedSearch,
  openTagManagement,
  renderTagList,
  handleTagRename,
  handleTagDelete,
  addNewTag,
  handleEscapeKey,
  closeTagManagement
};
