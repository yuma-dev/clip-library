// clip grid: loading/rendering, clip elements, context menu, delete, rename, thumbnails
const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const state = require('./state');
const tagManagerModule = require('./tag-manager');
const videoPlayerModule = require('./video-player');
const keybinds = require('./keybinding-manager');
const searchManagerModule = require('./search-manager');

let showCustomConfirm, showCustomAlert, updateClipCounter, getTimeGroup, getGroupOrder,
    loadCollapsedState, saveCollapsedState, removeDuplicates, getRelativeTimeString,
    showDeletionTooltip, hideDeletionTooltip, updateNewClipsIndicators, newClipsInfo,
    showThumbnailGenerationText, hideThumbnailGenerationText, updateThumbnailGenerationText,
    updateClipThumbnail, handleClipSelection, clearSelection, handleKeyPress, handleKeyRelease,
    closePlayer, disableVideoThumbnail, saveTitleChange, filterClips, setupClipTitleEditing,
    positionNewClipsIndicators, hideLoadingScreen, currentClipLocationSpan, clipGrid;

// replaces content-visibility: auto on .clip-item: that silently recomputes every layout
// and with the player open the playhead invalidates layout each frame (~150 calls/sec
// ~40% of a core in profiling). this is event-driven off scroll instead.

let _visibilityObserver = null;
function getVisibilityObserver() {
  if (_visibilityObserver) return _visibilityObserver;
  _visibilityObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      e.target.classList.toggle('cv-offscreen', !e.isIntersecting);
    }
  }, { rootMargin: '600px 0px' });
  return _visibilityObserver;
}

function observeClipVisibility(el) {
  try { getVisibilityObserver().observe(el); } catch (_) { /* element may have been removed */ }
}

function init(dependencies) {
  showCustomConfirm = dependencies.showCustomConfirm;
  showCustomAlert = dependencies.showCustomAlert;
  updateClipCounter = dependencies.updateClipCounter;
  getTimeGroup = dependencies.getTimeGroup;
  getGroupOrder = dependencies.getGroupOrder;
  loadCollapsedState = dependencies.loadCollapsedState;
  saveCollapsedState = dependencies.saveCollapsedState;
  removeDuplicates = dependencies.removeDuplicates;
  getRelativeTimeString = dependencies.getRelativeTimeString;
  showDeletionTooltip = dependencies.showDeletionTooltip;
  hideDeletionTooltip = dependencies.hideDeletionTooltip;
  updateNewClipsIndicators = dependencies.updateNewClipsIndicators;
  newClipsInfo = dependencies.newClipsInfo;
  showThumbnailGenerationText = dependencies.showThumbnailGenerationText;
  hideThumbnailGenerationText = dependencies.hideThumbnailGenerationText;
  updateThumbnailGenerationText = dependencies.updateThumbnailGenerationText;
  updateClipThumbnail = dependencies.updateClipThumbnail;
  handleClipSelection = dependencies.handleClipSelection;
  clearSelection = dependencies.clearSelection;
  handleKeyPress = dependencies.handleKeyPress;
  handleKeyRelease = dependencies.handleKeyRelease;
  closePlayer = dependencies.closePlayer;
  disableVideoThumbnail = dependencies.disableVideoThumbnail;
  saveTitleChange = dependencies.saveTitleChange;
  filterClips = dependencies.filterClips;
  setupClipTitleEditing = dependencies.setupClipTitleEditing;
  positionNewClipsIndicators = dependencies.positionNewClipsIndicators;
  hideLoadingScreen = dependencies.hideLoadingScreen;
  currentClipLocationSpan = dependencies.currentClipLocationSpan;
  clipGrid = dependencies.clipGrid;
}

async function loadClips() {
  try {
    logger.info("Loading clips...");
    state.clipLocation = await ipcRenderer.invoke("get-clip-location");
    currentClipLocationSpan.textContent = state.clipLocation;

    const newClipsData = await ipcRenderer.invoke("get-new-clips-info");
    Object.assign(newClipsInfo, newClipsData);
    logger.info("New clips info:", newClipsInfo);

    state.allClips = await ipcRenderer.invoke("get-clips");
    logger.info("Loaded", state.allClips.length, "clips");

    state.allClips.forEach(clip => {
      clip.isNewSinceLastSession = newClipsInfo.newClips.includes(clip.originalName);
    });

    const TAG_BATCH_SIZE = 50;
    for (let i = 0; i < state.allClips.length; i += TAG_BATCH_SIZE) {
      const batch = state.allClips.slice(i, i + TAG_BATCH_SIZE);
      await Promise.all(batch.map(async (clip) => {
        clip.tags = await ipcRenderer.invoke("get-clip-tags", clip.originalName);
      }));
    }

    state.allClips = removeDuplicates(state.allClips);
    state.allClips.sort((a, b) => b.createdAt - a.createdAt);

    // recovers global tags lost e.g. after a PC reset
    try {
      const restoreResult = await ipcRenderer.invoke("restore-missing-global-tags");
      if (restoreResult.success && restoreResult.restoredCount > 0) {
        logger.info(`Restored ${restoreResult.restoredCount} missing global tags:`, restoreResult.restoredTags);
        await tagManagerModule.loadGlobalTags();
      }
    } catch (error) {
      logger.error("Error during tag restoration:", error);
    }

    await tagManagerModule.loadTagPreferences(); // sets state.selectedTags
    filterClips(); // sets state.currentClipList

    logger.info("Initial state.currentClipList length:", state.currentClipList.length);
    updateClipCounter(state.currentClipList.length);
    renderClips(state.currentClipList);
    setupClipTitleEditing();
    validateClipLists();
    tagManagerModule.updateFilterDropdown();

    logger.info("Clips loaded and rendered.");

    setTimeout(() => {
      positionNewClipsIndicators();
    }, 100);

    try {
      await ipcRenderer.invoke('save-clip-list-immediately');
    } catch (error) {
      logger.error('Failed to save clip list after initial load:', error);
    }

    hideLoadingScreen();

    setTimeout(() => {
      startThumbnailValidation();
    }, 1000);

  } catch (error) {
    logger.error("Error loading clips:", error);
    clipGrid.innerHTML = `<p class="error-message">Error loading clips. Please check your clip location in settings.</p>`;
    currentClipLocationSpan.textContent = "Error: Unable to load location";
    hideThumbnailGenerationText();
    hideLoadingScreen();
  }
}

/**
 * Render the clip list into the grid.
 * Handles grouping, selection state, and indicator updates.
 */
async function renderClips(clips) {
  if (state.isRendering) {
    logger.info("Render already in progress, skipping");
    return;
  }
  
  state.isRendering = true;
  logger.info("Rendering clips. Input length:", clips.length);
  
  const clipGrid = document.getElementById('clip-grid');
  clipGrid.innerHTML = '';

  if (!clips || clips.length === 0) {
    clipGrid.innerHTML = '<div class="error-message">No clips found</div>';
    state.isRendering = false;
    return;
  }

  clips = removeDuplicates(clips);
  logger.info("Clips to render after removing duplicates:", clips.length);

  // single IPC call for all thumbnail paths, avoids per-clip round trips
  const clipNames = clips.map(clip => clip.originalName);
  await prefetchThumbnailPaths(clipNames);

  const groups = {};
  clips.forEach(clip => {
    const group = getTimeGroup(clip.createdAt);
    if (!groups[group]) groups[group] = [];
    groups[group].push(clip);
  });

  const collapsedState = loadCollapsedState();

  const sortedGroups = Object.entries(groups).sort((a, b) =>
    getGroupOrder(a[0]) - getGroupOrder(b[0])
  );

  let newClipsStartIndex = -1;
  if (newClipsInfo.totalNewCount > 0) {
    newClipsStartIndex = clips.findIndex(clip => clip.isNewSinceLastSession);
  }

  console.log('Debug - New clips info:', newClipsInfo);
  console.log('Debug - newClipsStartIndex:', newClipsStartIndex);
  console.log('Debug - clips with new status:', clips.map(c => ({ name: c.originalName, isNew: c.isNewSinceLastSession })).slice(0, 10));

  let hasAddedNewClipsIndicator = false;

  for (const [groupName, groupClips] of sortedGroups) {
    const groupHasFirstNewClip = newClipsStartIndex >= 0 &&
      groupClips.some(clip => clip.isNewSinceLastSession) &&
      !groupClips.every(clip => clip.isNewSinceLastSession);

    const groupIsAllNewClips = groupClips.every(clip => clip.isNewSinceLastSession) && groupClips.length > 0;

    console.log(`Debug - Group "${groupName}":`, {
      groupIsAllNewClips,
      hasAddedNewClipsIndicator,
      totalNewCount: newClipsInfo.totalNewCount,
      groupClips: groupClips.map(c => ({ name: c.originalName, isNew: c.isNewSinceLastSession }))
    });
    
    const groupElement = document.createElement('div');
    let groupClasses = 'clip-group';
    if (collapsedState[groupName]) {
      groupClasses += ' collapsed';
    }
    if (groupIsAllNewClips && state.settings.showNewClipsIndicators !== false) {
      groupClasses += ' new-clips-group';
      console.log('Debug - Marking group as new clips group:', groupName);
    }
    groupElement.className = groupClasses;
    groupElement.dataset.loaded = collapsedState[groupName] ? 'false' : 'true';
    groupElement.dataset.groupName = groupName;

    const header = document.createElement('div');
    header.className = 'clip-group-header';
    header.innerHTML = `
      <h2 class="clip-group-title">
        ${groupName}
        <span class="clip-group-count">${groupClips.length} clip${groupClips.length !== 1 ? 's' : ''}</span>
      </h2>
      <div class="clip-group-divider"></div>
    `;

    const content = document.createElement('div');
    content.className = 'clip-group-content';

    if (!collapsedState[groupName]) {
      const clipElements = await Promise.all(groupClips.map(createClipElement));

      for (let i = 0; i < clipElements.length; i++) {
        const clipElement = clipElements[i];
        const clip = groupClips[i];

        // marks the new->old transition for the indicator, unless the whole group is new or
        // indicators are off
        if (state.settings.showNewClipsIndicators !== false && !groupIsAllNewClips && i > 0 && groupClips[i-1].isNewSinceLastSession && !clip.isNewSinceLastSession && !hasAddedNewClipsIndicator) {
          console.log('Debug - Will add indicator after clip:', groupClips[i-1].originalName, 'before clip:', clip.originalName);
          console.log('Debug - Setting data attributes on content for group');
          content.dataset.needsIndicator = 'true';
          content.dataset.lastNewIndex = i - 1;
          content.dataset.firstOldIndex = i;
          hasAddedNewClipsIndicator = true;
        }

        content.appendChild(clipElement);
      }

      // last clip in group is new with nothing after it: indicator goes at the end
      if (state.settings.showNewClipsIndicators !== false && !groupIsAllNewClips && !hasAddedNewClipsIndicator && groupClips.length > 0) {
        const lastClip = groupClips[groupClips.length - 1];
        if (lastClip.isNewSinceLastSession) {
          console.log('Debug - Adding end-of-group indicator after last new clip:', lastClip.originalName);
          content.dataset.needsIndicator = 'true';
          content.dataset.lastNewIndex = groupClips.length - 1;
          content.dataset.firstOldIndex = -1; // no next clip
          hasAddedNewClipsIndicator = true;
        }
      }
    } else {
      groupElement.dataset.clips = JSON.stringify(groupClips.map(clip => ({
        originalName: clip.originalName,
        customName: clip.customName,
        createdAt: clip.createdAt,
        tags: clip.tags || []
      })));
    }

    header.addEventListener('click', async () => {
      const isCollapsed = groupElement.classList.contains('collapsed');

      groupElement.classList.toggle('collapsed');
      collapsedState[groupName] = !isCollapsed;
      saveCollapsedState(collapsedState);

      if (isCollapsed && groupElement.dataset.loaded === 'false') {
        try {
          let groupClips;

          if (groupElement.dataset.clips) {
            groupClips = JSON.parse(groupElement.dataset.clips);
          } else {
            groupClips = state.currentClipList.filter(
              clip => getTimeGroup(clip.createdAt) === groupName
            );
          }

          if (groupClips.length > 50) {
            const loadingIndicator = document.createElement('div');
            loadingIndicator.className = 'loading-indicator';
            loadingIndicator.innerHTML = `
              <div class="loading-spinner"></div>
              <div style="margin-top: 10px;">Loading ${groupClips.length} clips...</div>
            `;
            content.appendChild(loadingIndicator);
          }

          await prefetchThumbnailPaths(groupClips.map(c => c.originalName));

          const batchSize = 20; // batched to avoid freezing the UI thread
          for (let i = 0; i < groupClips.length; i += batchSize) {
            const batch = groupClips.slice(i, i + batchSize);

            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }

            const clipElements = await Promise.all(batch.map(createClipElement));

            if (i === 0 && groupClips.length > 50) {
              content.innerHTML = '';
            }

            for (let j = 0; j < clipElements.length; j++) {
              const clipElement = clipElements[j];
              const clipIndex = i + j;
              const clip = batch[j];

              // indicator goes at the first new->old transition
              if (
                clipIndex > 0 &&
                !content.dataset.needsIndicator &&
                groupClips[clipIndex - 1].isNewSinceLastSession &&
                !clip.isNewSinceLastSession
              ) {
                content.dataset.needsIndicator = 'true';
                content.dataset.lastNewIndex = clipIndex - 1;
                content.dataset.firstOldIndex = clipIndex;
              }
              
              content.appendChild(clipElement);
            }
          }

          groupElement.dataset.loaded = 'true';
          delete groupElement.dataset.clips; // free the stashed json now that DOM has it

          tagManagerModule.setupTooltips();

          setTimeout(() => {
            positionNewClipsIndicators();
          }, 50);
        } catch (error) {
          logger.error("Error loading clips for group:", error);
          content.innerHTML = '<div class="error-message">Error loading clips</div>';
        }
      } else if (!isCollapsed && groupElement.dataset.loaded === 'true') {
        // optional cleanup path for very large groups on collapse, currently disabled
        /*
        if (groupClips.length > 100) {
          // Cleanup existing elements
          const clipElements = content.querySelectorAll('.clip-item');
          clipElements.forEach(el => {
            if (typeof el.cleanup === 'function') {
              el.cleanup();
            }
          });
          
          // Clear the content
          content.innerHTML = '';
          
          // Store the clip data again for future loading
          const groupClips = state.currentClipList.filter(
            clip => getTimeGroup(clip.createdAt) === groupName
          );
          groupElement.dataset.clips = JSON.stringify(groupClips.map(clip => ({
            originalName: clip.originalName,
            customName: clip.customName,
            createdAt: clip.createdAt,
            tags: clip.tags || []
          })));
          
          // Mark as not loaded
          groupElement.dataset.loaded = 'false';
        }
        */
      }
    });

    groupElement.appendChild(header);
    groupElement.appendChild(content);
    clipGrid.appendChild(groupElement);
  }

  tagManagerModule.setupTooltips();
  state.currentClipList = clips;

  const clipGlowManager = videoPlayerModule.getClipGlowManager();
  if (clipGlowManager) {
    clipGlowManager.init();
  }

  logger.info("Rendered clips count:", clips.length);

  if (state.gamepadManager && state.gamepadManager.isGamepadConnected() && clips.length > 0) {
    setTimeout(() => {
      if (!state.gridNavigationEnabled) {
        enableGridNavigation();
      } else {
        updateGridSelection();
      }
    }, 100); // let DOM settle first
  }

  state.isRendering = false;
}

function createClipElement(clip) {
  return new Promise(async (resolve) => {
    const clipElement = document.createElement("div");
    clipElement.className = "clip-item";
    clipElement.dataset.originalName = clip.originalName;

    const contentElement = document.createElement("div");
    contentElement.className = "clip-item-content";

    let thumbnailPath = await getThumbnailPath(clip.originalName);

    const relativeTime = getRelativeTimeString(clip.createdAt);

    const mediaContainer = document.createElement("div");
    mediaContainer.className = "clip-item-media-container";

    const imgElement = document.createElement("img");

    if (thumbnailPath === null) {
      mediaContainer.classList.add('is-loading');
      
      // Create shimmer elements only for loading items
      const shimmerWrapper = document.createElement("div");
      shimmerWrapper.className = "shimmer-wrapper";
      const shimmerElement = document.createElement("div");
      shimmerElement.className = "shimmer";
      shimmerWrapper.appendChild(shimmerElement);
      mediaContainer.appendChild(shimmerWrapper);

      // Set src to loading thumbnail
      imgElement.src = "assets/loading-thumbnail.gif";
      
      // When the real thumbnail loads
      imgElement.addEventListener('load', () => {
        if (!imgElement.src.includes('loading-thumbnail.gif')) {
          const shimmerWrapper = mediaContainer.querySelector('.shimmer-wrapper');
          if (shimmerWrapper) {
            shimmerWrapper.remove();
          }
          mediaContainer.classList.remove('is-loading');
        }
      });
    } else {
      imgElement.src = `file://${thumbnailPath}`;
    }

    imgElement.alt = clip.customName;
    imgElement.onerror = () => {
      imgElement.src = 'assets/fallback-image.jpg';
      mediaContainer.classList.remove('is-loading');
      const shimmerWrapper = mediaContainer.querySelector('.shimmer-wrapper');
      if (shimmerWrapper) {
        shimmerWrapper.remove();
      }
    };

    mediaContainer.appendChild(imgElement);

    const tagContainer = document.createElement("div");
    tagContainer.className = "tag-container";

    if (clip.tags && clip.tags.length > 0) {
      const visibleTags = clip.tags.slice(0, 3);
      visibleTags.forEach(tag => {
        const tagElement = document.createElement("span");
        tagElement.className = "tag";
        tagElement.textContent = tagManagerModule.truncateTag(tag);
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
      }
    }

    clipElement.innerHTML = `
      ${mediaContainer.outerHTML}
      <div class="clip-info">
        <p class="clip-name" contenteditable="true">${clip.customName}</p>
        <p class="clip-time" title="${new Date(clip.createdAt).toLocaleString()}">${relativeTime}</p>
      </div>
    `;

    clipElement.insertBefore(tagContainer, clipElement.querySelector('.clip-info'));

    let videoElement;

    const clipNameElement = clipElement.querySelector('.clip-name');
    clipNameElement.addEventListener('focus', (e) => {
      e.stopPropagation();
      handleClipTitleFocus(clipNameElement, clip);
    });
    clipNameElement.addEventListener('blur', (e) => {
      e.stopPropagation();
      handleClipTitleBlur(clipNameElement, clip);
    });
    clipNameElement.addEventListener('keydown', (e) => handleClipTitleKeydown(e, clipNameElement, clip));
    clipNameElement.addEventListener('click', (e) => e.stopPropagation());

    tagManagerModule.setupTagTooltips(clipElement);

    function handleClipTitleFocus(titleElement, clip) {
      titleElement.dataset.originalValue = titleElement.textContent;
    }

    function handleClipTitleBlur(titleElement, clip) {
      const newTitle = titleElement.textContent.trim();
      if (newTitle !== titleElement.dataset.originalValue) {
        saveTitleChange(clip.originalName, clip.customName, newTitle);
      }
    }

    function handleClipTitleKeydown(e, titleElement, clip) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        titleElement.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        titleElement.textContent = titleElement.dataset.originalValue;
        titleElement.blur();
      }
    }

    function handleMouseLeave() {
    const clipGlowManager = videoPlayerModule.getClipGlowManager();
    if (clipGlowManager) {
      clipGlowManager.hide();
    }

    if (clipElement.classList.contains("video-preview-disabled")) return;
    videoPlayerModule.cleanupVideoPreview();
  }

    const onMouseEnter = () => videoPlayerModule.handleMouseEnter(clip, clipElement);
    clipElement.handleMouseEnter = onMouseEnter;
    clipElement.addEventListener("mouseenter", onMouseEnter);
    clipElement.addEventListener("mouseleave", handleMouseLeave);

    clipElement.addEventListener("click", (e) => handleClipClick(e, clip));

    clipElement.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e, clip);
    });
    clipElement.appendChild(contentElement);

    clipElement.cleanup = () => {
      videoPlayerModule.cleanupVideoPreview();
      clipElement.removeEventListener("mouseenter", onMouseEnter);
      clipElement.removeEventListener("mouseleave", handleMouseLeave);
    };

    // game/app icon, if the backend has one for this clip
    try {
      const iconData = await ipcRenderer.invoke('get-game-icon', clip.originalName);
      const iconPath = iconData && typeof iconData === 'object' ? iconData.path : iconData;
      const iconTitle = iconData && typeof iconData === 'object' ? iconData.title : null;
      if (iconPath) {
        const clipInfo = clipElement.querySelector('.clip-info');
        if (clipInfo) {
          const iconImg = document.createElement('img');
          iconImg.className = 'game-icon';
          iconImg.src = `file://${iconPath}`;
          iconImg.alt = 'Application Icon';
          if (iconTitle) {
            iconImg.title = iconTitle;
          }
          if (state.settings?.iconGreyscale) {
            iconImg.classList.add('greyscale-icon');
          }
          clipInfo.appendChild(iconImg);
          clipInfo.classList.add('has-icon');
        }
      }
    } catch (error) {
      logger.error('Error loading game icon:', error);
    }

    observeClipVisibility(clipElement);
    resolve(clipElement);
  });
}

function handleClipClick(e, clip) {
  if (e.target.classList.contains('clip-name') || e.target.classList.contains('clip-info')) {
    return;
  }

  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    handleClipSelection(e.target.closest('.clip-item'), e);
    return;
  }

  if (state.selectedClips.size > 0) {
    clearSelection();
    return;
  }

  // Otherwise, open the clip
  // Add keyboard event listeners for video player controls
  document.addEventListener("keydown", handleKeyPress);
  document.addEventListener("keyup", handleKeyRelease);

  videoPlayerModule.openClip(clip.originalName, clip.customName);
}

function updateGroupAfterDeletion(clipElement) {
  const groupElement = clipElement.closest('.clip-group');
  if (!groupElement) return;

  const content = groupElement.querySelector('.clip-group-content');
  const remainingClips = content.querySelectorAll('.clip-item').length - 1; // clipElement is still in the DOM here

  if (remainingClips === 0) {
    groupElement.remove();
  } else {
    const countElement = groupElement.querySelector('.clip-group-count');
    if (countElement) {
      countElement.textContent = `${remainingClips} clip${remainingClips !== 1 ? 's' : ''}`;
    }
  }
}

async function confirmAndDeleteClip(clipToDelete = null) {
  if (!clipToDelete && !state.currentClip) return;

  const clipInfo = clipToDelete || state.currentClip;

  const isConfirmed = await showCustomConfirm(`Are you sure you want to delete "${clipInfo.customName}"? This action cannot be undone.`);

  if (isConfirmed) {
    videoPlayerModule.cleanupVideoPreview();
    const clipGlowManager = videoPlayerModule.getClipGlowManager();
    if (clipGlowManager) {
      clipGlowManager.hide();
    }

    // optimistic UI removal, reverted in the catch block below if the IPC delete fails
    const clipElement = document.querySelector(`.clip-item[data-original-name="${CSS.escape(clipInfo.originalName)}"]`);
    if (clipElement) {
      updateGroupAfterDeletion(clipElement);
      clipElement.remove();
    }

    const allClipsIndex = state.allClips.findIndex(clip => clip.originalName === clipInfo.originalName);
    const currentClipListIndex = state.currentClipList.findIndex(clip => clip.originalName === clipInfo.originalName);
    
    if (allClipsIndex > -1) state.allClips.splice(allClipsIndex, 1);
    if (currentClipListIndex > -1) state.currentClipList.splice(currentClipListIndex, 1);

    try {
      if (state.currentClip && state.currentClip.originalName === clipInfo.originalName) {
        await closePlayer();
        await videoPlayerModule.releaseVideoElement();
      }

      disableVideoThumbnail(clipInfo.originalName);

      showDeletionTooltip();

      const result = await ipcRenderer.invoke('delete-clip', clipInfo.originalName);
      if (result.success) {
        logger.info('Clip deleted successfully');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      logger.error('Error deleting clip:', error);
      await showCustomAlert(`Failed to delete clip: ${error.message}`);

      // undo the optimistic removal above
      if (clipElement && clipElement.parentNode === null) {
        const timeGroup = getTimeGroup(clipInfo.createdAt);
        let groupElement = document.querySelector(`.clip-group[data-group-name="${timeGroup}"]`);

        if (!groupElement) {
          groupElement = document.createElement('div');
          groupElement.className = 'clip-group';
          groupElement.dataset.groupName = timeGroup;
          
          const header = document.createElement('div');
          header.className = 'clip-group-header';
          header.innerHTML = `
            <h2 class="clip-group-title">
              ${timeGroup}
              <span class="clip-group-count">1 clip</span>
            </h2>
            <div class="clip-group-divider"></div>
          `;
          
          const content = document.createElement('div');
          content.className = 'clip-group-content';
          
          groupElement.appendChild(header);
          groupElement.appendChild(content);

          const groups = Array.from(document.querySelectorAll('.clip-group'));
          const insertIndex = groups.findIndex(g =>
            getGroupOrder(g.dataset.groupName) > getGroupOrder(timeGroup)
          );

          if (insertIndex === -1) {
            clipGrid.appendChild(groupElement);
          } else {
            clipGrid.insertBefore(groupElement, groups[insertIndex]);
          }
        }

        const content = groupElement.querySelector('.clip-group-content');
        content.appendChild(clipElement);

        const countElement = groupElement.querySelector('.clip-group-count');
        const currentCount = content.querySelectorAll('.clip-item').length;
        countElement.textContent = `${currentCount} clip${currentCount !== 1 ? 's' : ''}`;
      }

      if (allClipsIndex > -1) state.allClips.splice(allClipsIndex, 0, clipInfo);
      if (currentClipListIndex > -1) state.currentClipList.splice(currentClipListIndex, 0, clipInfo);
    } finally {
      hideDeletionTooltip();
    }

    updateClipCounter(state.currentClipList.length);
    updateNewClipsIndicators();

    try {
      await ipcRenderer.invoke('save-clip-list-immediately');
    } catch (error) {
      logger.error('Failed to save clip list after deletion:', error);
    }
  }
}

function updateClipNameInLibrary(originalName, newCustomName) {
  if (!originalName) {
    logger.warn(
      "Attempted to update clip name in library with undefined originalName",
    );
    return;
  }

  const clipElement = clipGrid.querySelector(
    `[data-original-name="${CSS.escape(originalName)}"]`,
  );
  if (clipElement) {
    const clipNameElement = clipElement.querySelector(".clip-name");
    if (clipNameElement) {
      clipNameElement.textContent = newCustomName;
    }
  } else {
    logger.warn(`Clip element not found for originalName: ${originalName}`);
  }
}

/**
 * Validate list consistency between allClips/currentClipList.
 */
function validateClipLists() {
  logger.info("Validating clip lists");
  logger.info("state.allClips length:", state.allClips.length);
  logger.info("state.currentClipList length:", state.currentClipList.length);
  logger.info("Rendered clips count:", clipGrid.children.length);

  const allClipsUnique = new Set(state.allClips.map(clip => clip.originalName)).size === state.allClips.length;
  const currentClipListUnique = new Set(state.currentClipList.map(clip => clip.originalName)).size === state.currentClipList.length;

  logger.info("state.allClips is unique:", allClipsUnique);
  logger.info("state.currentClipList is unique:", currentClipListUnique);

  if (!allClipsUnique || !currentClipListUnique) {
    logger.warn("Duplicate clips detected!");
  }
}

function showContextMenu(e, clip) {
  e.preventDefault();
  e.stopPropagation();

  const contextMenu = document.getElementById("context-menu");
  const tagsDropdown = document.getElementById("tags-dropdown");

  if (contextMenu) {
    contextMenu.style.display = "none";
    tagsDropdown.style.display = "none";
    state.isTagsDropdownOpen = false;

    const checkboxes = tagsDropdown.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => checkbox.checked = false);

    const tagSearchInput = document.getElementById("tag-search-input");
    if (tagSearchInput) tagSearchInput.value = '';

    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;
    contextMenu.style.display = "block";

    state.contextMenuClip = clip;

    logger.info("Context menu shown for clip:", clip.originalName);

    tagManagerModule.updateTagList();

    document.addEventListener('click', closeContextMenu);

    // blocks clicks outside the menu from reaching the grid
    const overlay = document.createElement('div');
    overlay.id = 'context-menu-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.zIndex = '1980'; // just below the context menu
    clipGrid.appendChild(overlay);
  } else {
    logger.error("Context menu elements not found");
  }
}

function closeContextMenu(e) {
  const contextMenu = document.getElementById("context-menu");
  const tagsDropdown = document.getElementById("tags-dropdown");
  const overlay = document.getElementById('context-menu-overlay');
  
  if (!contextMenu.contains(e.target)) {
    contextMenu.style.display = "none";
    tagsDropdown.style.display = "none";
    state.isTagsDropdownOpen = false;
    document.removeEventListener('click', closeContextMenu);
    if (overlay) {
      overlay.remove();
    }
  }
}

const THUMBNAIL_RETRY_DELAY = 2000;
const THUMBNAIL_INIT_DELAY = 1000;

async function prefetchThumbnailPaths(clipNames) {
  if (!clipNames || clipNames.length === 0) return;

  try {
    const results = await ipcRenderer.invoke("get-thumbnail-paths-batch", clipNames);
    for (const [clipName, thumbnailPath] of Object.entries(results)) {
      state.thumbnailPathCache.set(clipName, thumbnailPath);
    }
  } catch (error) {
    logger.warn("Failed to batch fetch thumbnail paths:", error.message);
  }
}

async function getThumbnailPath(clipName) {
  if (state.thumbnailPathCache.has(clipName)) {
    return state.thumbnailPathCache.get(clipName);
  }
  const path = await ipcRenderer.invoke("get-thumbnail-path", clipName);
  state.thumbnailPathCache.set(clipName, path);
  return path;
}

async function startThumbnailValidation() {
  logger.info("Starting thumbnail validation for clips:", state.allClips.length);
  
  await new Promise(resolve => setTimeout(resolve, THUMBNAIL_INIT_DELAY));
  
  try {
    let timeoutId;
    
    const createTimeout = () => {
      if (timeoutId) clearTimeout(timeoutId);
      
      return new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error("Thumbnail generation timeout"));
        }, 30000);
      });
    };

    let currentTimeout = createTimeout();

    const pendingClips = new Set(state.allClips.map(clip => clip.originalName));

    const generationPromise = new Promise((resolve) => {
      ipcRenderer.invoke("generate-thumbnails-progressively", Array.from(pendingClips))
      .then((result) => {
        if (result.needsGeneration > 0) {
          showThumbnailGenerationText(result.needsGeneration);

          ipcRenderer.on("thumbnail-progress", (event, { current, total, clipName }) => {
            currentTimeout = createTimeout();
            if (state.isGeneratingThumbnails) {
              updateThumbnailGenerationText(total - current);
            }
            
            pendingClips.delete(clipName);

            ipcRenderer.invoke("get-thumbnail-path", clipName).then(thumbnailPath => {
              if (thumbnailPath) {
                state.thumbnailPathCache.set(clipName, thumbnailPath);
                updateClipThumbnail(clipName, thumbnailPath);
              }
            });
          });

          ipcRenderer.once("thumbnail-generation-complete", () => {
            if (pendingClips.size > 0) {
              ipcRenderer.invoke("generate-thumbnails-progressively", Array.from(pendingClips));
            }
            clearTimeout(timeoutId);
            hideThumbnailGenerationText();
            resolve(result);
          });
        } else {
          hideThumbnailGenerationText();
          resolve(result);
        }
      });
    });

    await Promise.race([generationPromise, currentTimeout]);

  } catch (error) {
    logger.error("Error during thumbnail validation:", error);
    hideThumbnailGenerationText();
    
    setTimeout(() => {
      startThumbnailValidation();
    }, THUMBNAIL_RETRY_DELAY);
  }
}

// ============================================================================
// DYNAMIC LIST HELPERS
// ============================================================================

function getActiveSearchText() {
  const searchDisplay = document.getElementById('search-display');
  if (!searchDisplay) return '';
  return searchDisplay.innerText.trim().toLowerCase();
}

function clipMatchesSearchFilters(clip, searchText) {
  if (!searchText) return true;
  const searchTerms = searchManagerModule.parseSearchTerms(searchText);
  const clipTags = clip.tags || [];
  const hasMatchingTags = searchTerms.tags.length === 0 ||
    searchTerms.tags.every(searchTag =>
      clipTags.some(clipTag =>
        clipTag.toLowerCase().includes(searchTag.toLowerCase().substring(1))
      )
    );

  const clipName = (clip.customName || '').toLowerCase();
  const originalName = (clip.originalName || '').toLowerCase();
  const hasMatchingText = searchTerms.text.length === 0 ||
    searchTerms.text.every(word =>
      clipName.includes(word) || originalName.includes(word)
    );

  if (!hasMatchingTags || !hasMatchingText) {
    return false;
  }

  // explicit tag search (e.g. "@MyTag") overrides dropdown filter state
  if (searchTerms.tags.length > 0) {
    return true;
  }

  return clipMatchesTagFilters(clip);
}

function clipMatchesTagFilters(clip) {
  if (!state.selectedTags || state.selectedTags.size === 0) {
    return false;
  }

  const baseFileName = clip.originalName
    ? clip.originalName.replace(/\.[^/.]+$/, '')
    : '';
  const isUnnamed = clip.customName === baseFileName;
  const clipTags = clip.tags || [];
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

function shouldIncludeClipInCurrentList(clip) {
  const searchText = getActiveSearchText();
  if (searchText) {
    return clipMatchesSearchFilters(clip, searchText);
  }
  return clipMatchesTagFilters(clip);
}

function insertClipIntoCurrentList(clip) {
  if (!state.currentClipList) return;

  const existingIndex = state.currentClipList.findIndex(
    (current) => current.originalName === clip.originalName
  );
  if (existingIndex !== -1) {
    state.currentClipList[existingIndex] = clip;
    return;
  }

  const insertIndex = state.currentClipList.findIndex(
    (current) => current.createdAt < clip.createdAt
  );
  if (insertIndex === -1) {
    state.currentClipList.push(clip);
  } else {
    state.currentClipList.splice(insertIndex, 0, clip);
  }
}

async function addNewClipToLibrary(fileName) {
  try {
    const clipPath = path.join(state.clipLocation, fileName);
    try {
      await fs.access(clipPath);
    } catch (error) {
      logger.info(`File no longer exists, skipping: ${fileName}`);
      return;
    }

    const newClipInfo = await ipcRenderer.invoke('get-new-clip-info', fileName);

    newClipInfo.isNewSinceLastSession = true; // added at runtime, not from a past session

    if (!newClipsInfo.newClips.includes(fileName)) {
      newClipsInfo.newClips.push(fileName);
      newClipsInfo.totalNewCount++;
    }

    const existingClipIndex = state.allClips.findIndex(clip => clip.originalName === newClipInfo.originalName);

    if (existingClipIndex === -1) {
      state.allClips.unshift(newClipInfo);

      const shouldRenderInCurrentView = shouldIncludeClipInCurrentList(newClipInfo);
      if (shouldRenderInCurrentView) {
        insertClipIntoCurrentList(newClipInfo);
      }

      const newClipElement = shouldRenderInCurrentView ? await createClipElement({
        ...newClipInfo,
        thumbnailPath: "assets/loading-thumbnail.gif"
      }) : null;

      if (shouldRenderInCurrentView) {
        const timeGroup = getTimeGroup(newClipInfo.createdAt);

        let groupElement = Array.from(document.querySelectorAll('.clip-group'))
          .find(group => {
            const headerText = group.querySelector('.clip-group-header h2.clip-group-title')?.textContent.trim();
            return headerText?.startsWith(timeGroup);
          });
        let content;

        if (groupElement) {
          content = groupElement.querySelector('.clip-group-content');

          const countElement = groupElement.querySelector('.clip-group-count');
          const currentCount = parseInt(countElement.textContent);
          countElement.textContent = `${currentCount + 1} clip${currentCount + 1 !== 1 ? 's' : ''}`;
        } else {
          groupElement = document.createElement('div');
          groupElement.className = 'clip-group';
          groupElement.dataset.groupName = timeGroup;

          const header = document.createElement('div');
          header.className = 'clip-group-header';
          header.innerHTML = `
            <h2 class="clip-group-title">
              ${timeGroup}
              <span class="clip-group-count">1 clip</span>
            </h2>
            <div class="clip-group-divider"></div>
          `;

          const collapsedState = loadCollapsedState();
          if (collapsedState[timeGroup]) {
            groupElement.classList.add('collapsed');
          }

          header.addEventListener('click', () => {
            groupElement.classList.toggle('collapsed');
            const newState = loadCollapsedState();
            newState[timeGroup] = groupElement.classList.contains('collapsed');
            saveCollapsedState(newState);
          });

          content = document.createElement('div');
          content.className = 'clip-group-content';

          groupElement.appendChild(header);
          groupElement.appendChild(content);

          const groups = Array.from(document.querySelectorAll('.clip-group'));
          const insertIndex = groups.findIndex(g =>
            getGroupOrder(g.dataset.groupName) > getGroupOrder(timeGroup)
          );

          if (insertIndex === -1) {
            clipGrid.appendChild(groupElement);
          } else {
            clipGrid.insertBefore(groupElement, groups[insertIndex]);
          }
        }

        content.insertBefore(newClipElement, content.firstChild);

        const groupClips = Array.from(content.querySelectorAll('.clip-item')).map(el => {
          const clipName = el.dataset.originalName;
          return state.allClips.find(clip => clip.originalName === clipName);
        }).filter(Boolean);
        
        const groupIsAllNewClips = groupClips.every(clip => clip.isNewSinceLastSession);
        if (groupIsAllNewClips && state.settings.showNewClipsIndicators !== false) {
          groupElement.classList.add('new-clips-group');
          console.log('Debug - Marking dynamically created/updated group as new clips group:', timeGroup);
        } else {
          groupElement.classList.remove('new-clips-group');
        }

        if (state.settings.showNewClipsIndicators !== false && !groupIsAllNewClips) {
          let firstOldIndex = -1;
          for (let i = 0; i < groupClips.length; i++) {
            if (!groupClips[i].isNewSinceLastSession) {
              firstOldIndex = i;
              break;
            }
          }

          if (firstOldIndex > 0) {
            content.dataset.needsIndicator = 'true';
            content.dataset.lastNewIndex = String(firstOldIndex - 1);
            content.dataset.firstOldIndex = String(firstOldIndex);
          } else {
            delete content.dataset.needsIndicator;
            delete content.dataset.lastNewIndex;
            delete content.dataset.firstOldIndex;
          }
        } else {
          delete content.dataset.needsIndicator;
          delete content.dataset.lastNewIndex;
          delete content.dataset.firstOldIndex;
        }
        
        newClipElement.dataset.trimStart = undefined; // no stale trim values on a freshly added clip
        newClipElement.dataset.trimEnd = undefined;
      }

      setTimeout(async () => {
        try {
          await ipcRenderer.invoke("generate-thumbnails-progressively", [fileName]);
        } catch (error) {
          logger.error("Error in background thumbnail generation:", error);
        }
      }, 1000); // delay so the file has finished writing to disk

    } else {
      state.allClips[existingClipIndex] = newClipInfo;
      if (shouldIncludeClipInCurrentList(newClipInfo)) {
        insertClipIntoCurrentList(newClipInfo);
      }
      const existingElement = document.querySelector(`[data-original-name="${CSS.escape(newClipInfo.originalName)}"]`);
      if (existingElement) {
        const updatedElement = await createClipElement(newClipInfo);
        existingElement.replaceWith(updatedElement);
      }
    }
    
    tagManagerModule.updateFilterDropdown();

    positionNewClipsIndicators(); // avoids a full re-render just for the indicator

    updateClipCounter(state.currentClipList.length);

    try {
      await ipcRenderer.invoke('save-clip-list-immediately');
    } catch (error) {
      logger.error('Failed to save clip list after adding clip:', error);
    }
  } catch (error) {
    logger.error("Error adding new clip to library:", error);
  }
}

function enableGridNavigation() {
  state.gridNavigationEnabled = true;
  state.currentGridFocusIndex = 0;
  updateGridSelection();
  setupMouseKeyboardDetection();
}

function disableGridNavigation() {
  state.gridNavigationEnabled = false;
  document.querySelectorAll('.clip-item').forEach(clip => {
    clip.classList.remove('controller-focused');
  });
  removeMouseKeyboardDetection();
}

function openCurrentGridSelection() {
  if (!state.gridNavigationEnabled) return;

  const visibleClips = getVisibleClips();
  if (visibleClips.length === 0 || state.currentGridFocusIndex >= visibleClips.length) return;

  const selectedClip = visibleClips[state.currentGridFocusIndex];
  if (!selectedClip) return;

  const originalName = selectedClip.dataset.originalName;
  const customName = selectedClip.dataset.customName || originalName;

  if (originalName) {
    disableGridNavigation();

    document.addEventListener("keydown", handleKeyPress);
    document.addEventListener("keyup", handleKeyRelease);

    videoPlayerModule.openClip(originalName, customName);
  }
}

function setupMouseKeyboardDetection() {
  if (state.mouseKeyboardListenersSetup) return;

  document.addEventListener('mousemove', hideControllerSelectionOnInput, { passive: true });
  document.addEventListener('mousedown', hideControllerSelectionOnInput, { passive: true });
  document.addEventListener('keydown', hideControllerSelectionOnKeyboard, { passive: true });

  state.mouseKeyboardListenersSetup = true;
}

function removeMouseKeyboardDetection() {
  if (!state.mouseKeyboardListenersSetup) return;

  document.removeEventListener('mousemove', hideControllerSelectionOnInput);
  document.removeEventListener('mousedown', hideControllerSelectionOnInput);
  document.removeEventListener('keydown', hideControllerSelectionOnKeyboard);

  state.mouseKeyboardListenersSetup = false;
}

function hideControllerSelectionOnInput() {
  if (state.gridNavigationEnabled) {
    disableGridNavigation();
  }
}

function hideControllerSelectionOnKeyboard(e) {
  // arrow keys drive controller navigation itself, don't let them cancel it
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    return;
  }
  
  if (state.gridNavigationEnabled) {
    disableGridNavigation();
  }
}

/**
 * Update visual focus state for grid navigation.
 */
function updateGridSelection() {
  // Remove focus class from all clips
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
      for (let i = currentIndex - 1; i >= 0; i--) {
        const clipRect = clips[i].getBoundingClientRect();
        // same column: left edge within one card-width of the current clip
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

module.exports = {
  init,

  loadClips,
  renderClips,
  createClipElement,
  handleClipClick,
  confirmAndDeleteClip,
  updateClipNameInLibrary,
  validateClipLists,
  showContextMenu,
  closeContextMenu,

  prefetchThumbnailPaths,
  getThumbnailPath,
  startThumbnailValidation,
  addNewClipToLibrary,

  enableGridNavigation,
  disableGridNavigation,
  openCurrentGridSelection,
  setupMouseKeyboardDetection,
  removeMouseKeyboardDetection,
  hideControllerSelectionOnInput,
  hideControllerSelectionOnKeyboard,
  updateGridSelection,
  getVisibleClips,
  findClipInDirection
};
