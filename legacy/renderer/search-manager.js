/**
 * search/filter for the clip library, plus the tag management modal
 */

const logger = require('../utils/logger');

let state, renderClips, updateClipCounter, updateNavigationButtons, filterClips, tagManagerModule, videoPlayerModule;

function init(dependencies) {
  state = dependencies.state;
  renderClips = dependencies.renderClips;
  updateClipCounter = dependencies.updateClipCounter;
  updateNavigationButtons = dependencies.updateNavigationButtons;
  filterClips = dependencies.filterClips;
  tagManagerModule = dependencies.tagManagerModule;
  videoPlayerModule = dependencies.videoPlayerModule;
}

function setupSearch() {
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", videoPlayerModule.debounce(performSearch, 300));
}

function performSearch() {
  const searchDisplay = document.getElementById('search-display');
  if (!searchDisplay) return;

  const searchText = searchDisplay.innerText.trim().toLowerCase();
  const searchTerms = parseSearchTerms(searchText);

  let filteredClips = [...state.allClips];

  if (searchTerms.tags.length > 0 || searchTerms.text.length > 0) {
    filteredClips = filteredClips.filter(clip => {
      const hasMatchingTags = searchTerms.tags.length === 0 ||
        searchTerms.tags.every(searchTag =>
          clip.tags.some(clipTag =>
            clipTag.toLowerCase().includes(searchTag.toLowerCase().substring(1))
          )
        );

      const hasMatchingText = searchTerms.text.length === 0 ||
        searchTerms.text.every(word =>
          clip.customName.toLowerCase().includes(word) ||
          clip.originalName.toLowerCase().includes(word)
        );

      return hasMatchingTags && hasMatchingText;
    });
  }

  // explicit @tag search bypasses the dropdown tag-filter exclusions
  if (searchTerms.tags.length === 0) {
    filteredClips = filteredClips.filter(matchesCurrentTagFilter);
  }

  state.currentClipList = filteredClips.filter((clip, index, self) =>
    index === self.findIndex((t) => t.originalName === clip.originalName)
  );

  state.currentClipList.sort((a, b) => b.createdAt - a.createdAt);

  renderClips(state.currentClipList);
  updateClipCounter(state.currentClipList.length);

  if (state.currentClip) {
    updateNavigationButtons();
  }
}

function matchesCurrentTagFilter(clip) {
  if (state.selectedTags.size === 0) {
    return false;
  }

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
    }

    return clipTags.every(tag => state.selectedTags.has(tag));
  }

  return state.selectedTags.has('Untagged');
}

function parseSearchTerms(searchText) {
  const terms = searchText.split(/\s+/).filter(term => term.length > 0);
  const validTagTerms = terms.filter(term => term.startsWith('@') && term.length > 1);
  return {
    tags: validTagTerms, // bare "@" ignored
    text: terms.filter(term => !term.startsWith('@'))
  };
}

function styleSearchText(text) {
  return text.split(/(@\S+)/).map(part => {
    if (part.startsWith('@')) {
      return `<span class="tag-highlight">${part}</span>`;
    }
    return part;
  }).join('');
}

function createSearchDisplay() {
  const searchContainer = document.getElementById('search-container');
  const searchInput = document.getElementById('search-input');

  if (!searchContainer || !searchInput) {
    logger.error('Search container or input not found');
    return null;
  }

  let searchDisplay = document.getElementById('search-display');
  if (!searchDisplay) {
    searchDisplay = document.createElement('div');
    searchDisplay.id = 'search-display';
    searchDisplay.contentEditable = true;
    searchDisplay.className = 'search-display';
    searchDisplay.setAttribute('role', 'textbox');
    searchDisplay.setAttribute('aria-label', 'Search input');
    searchDisplay.setAttribute('tabindex', '0');

    searchInput.style.display = 'none';
    searchContainer.appendChild(searchDisplay);
    searchDisplay.addEventListener('focus', () => {
      searchDisplay.classList.add('focused');
    });
    searchDisplay.addEventListener('blur', () => {
      searchDisplay.classList.remove('focused');
    });
  }

  return searchDisplay;
}

function updateSearchDisplay() {
  const searchInput = document.getElementById('search-input');
  const searchDisplay = document.getElementById('search-display');

  if (!searchDisplay || !searchInput) return;

  let savedSelection = null;
  if (window.getSelection && window.getSelection().rangeCount > 0) {
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    savedSelection = {
      node: range.startContainer,
      offset: range.startOffset
    };
  }

  const text = searchDisplay.innerText;
  searchDisplay.innerHTML = styleSearchText(text);
  searchInput.value = text;

  performSearch();

  if (savedSelection) {
    const selection = window.getSelection();
    const newRange = document.createRange();

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
      // can't find exact position, so place cursor at the end
      const lastNode = textNodes[textNodes.length - 1];
      newRange.setStart(lastNode, lastNode.length);
      newRange.collapse(true);

      selection.removeAllRanges();
      selection.addRange(newRange);
    }
  }
}

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

  searchDisplay.innerHTML = '';
}

function initializeEnhancedSearch() {
  if (document.getElementById('search-container')) {
    setupEnhancedSearch();
  } else {
    logger.warn('Search container not found, waiting for DOM...');
    setTimeout(initializeEnhancedSearch, 100);
  }
}

let isTagManagementOpen = false;

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

  renderTagList(tagManagerModule.getGlobalTags());

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

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeTagManagement();
    }
  });

  document.addEventListener('keydown', handleEscapeKey);
}

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

function handleTagRename(e) {
  const input = e.target;
  const originalTag = input.dataset.original;
  const newTag = input.value.trim();

  if (newTag && newTag !== originalTag) {
    tagManagerModule.updateTag(originalTag, newTag);
  }
}

async function handleTagDelete(e) {
  const item = e.target.closest('.tagManagement-item');
  const tag = item.dataset.tag;

  if (tag) {
    logger.info(`Starting deletion of tag: "${tag}"`);
    try {
      await tagManagerModule.deleteTag(tag);
      logger.info(`Successfully deleted tag: "${tag}"`);
      item.remove();

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

async function addNewTag() {
  const searchInput = document.getElementById('tagManagementSearch');
  const newTagName = searchInput.value.trim();

  if (newTagName && !tagManagerModule.getGlobalTags().includes(newTagName)) {
    await tagManagerModule.addGlobalTag(newTagName);

    searchInput.value = '';
    renderTagList(tagManagerModule.getGlobalTags());
    tagManagerModule.updateFilterDropdown();
    filterClips();
  }
}

function handleEscapeKey(e) {
  if (e.key === 'Escape' && isTagManagementOpen) {
    closeTagManagement();
  }
}

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
