/**
 * Clip Grid Module
 *
 * Handles clip grid management operations:
 * - Loading and rendering clips
 * - Creating clip elements
 * - Context menu handling
 * - Clip deletion
 * - Clip name updates
 * - Clip list validation
 * - Thumbnail management
 */

// Imports
const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');
const state = require('./state');
const tagManagerModule = require('./tag-manager');
const videoPlayerModule = require('./video-player');
const keybinds = require('./keybinding-manager');
const searchManagerModule = require('./search-manager');

// Dependencies (injected)
let showCustomConfirm, showCustomAlert, updateClipCounter, getTimeGroup, getGroupOrder,
    loadCollapsedState, saveCollapsedState, removeDuplicates, getRelativeTimeString,
    showDeletionTooltip, hideDeletionTooltip, updateNewClipsIndicators, newClipsInfo,
    showThumbnailGenerationText, hideThumbnailGenerationText, updateThumbnailGenerationText,
    updateClipThumbnail, handleClipSelection, clearSelection, handleKeyPress, handleKeyRelease,
    closePlayer, disableVideoThumbnail, saveTitleChange, filterClips, setupClipTitleEditing,
    positionNewClipsIndicators, hideLoadingScreen, currentClipLocationSpan, clipGrid;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the clip grid manager with required dependencies.
 */
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

// ============================================================================
// CLIP GRID MANAGEMENT
// ============================================================================

/**
 * Load clips from disk and render the initial grid state.
 */
async function loadClips() {
  try {
    logger.info("Loading clips...");
    state.clipLocation = await ipcRenderer.invoke("get-clip-location");
    currentClipLocationSpan.textContent = state.clipLocation;

    // Get new clips info before loading all clips
    const newClipsData = await ipcRenderer.invoke("get-new-clips-info");
    Object.assign(newClipsInfo, newClipsData);
    logger.info("New clips info:", newClipsInfo);

    state.allClips = await ipcRenderer.invoke("get-clips");
    logger.info("Loaded", state.allClips.length, "clips");

    // Mark which clips are new
    state.allClips.forEach(clip => {
      clip.isNewSinceLastSession = newClipsInfo.newClips.includes(clip.originalName);
    });

    // Load tags for each clip in smaller batches
    const TAG_BATCH_SIZE = 50;
    for (let i = 0; i < state.allClips.length; i += TAG_BATCH_SIZE) {
      const batch = state.allClips.slice(i, i + TAG_BATCH_SIZE);
      await Promise.all(batch.map(async (clip) => {
        clip.tags = await ipcRenderer.invoke("get-clip-tags", clip.originalName);
      }));
    }

    state.allClips = removeDuplicates(state.allClips);
    state.allClips.sort((a, b) => b.createdAt - a.createdAt);

    // Restore any missing global tags from clip tags (e.g., after PC reset)
    try {
      const restoreResult = await ipcRenderer.invoke("restore-missing-global-tags");
      if (restoreResult.success && restoreResult.restoredCount > 0) {
        logger.info(`Restored ${restoreResult.restoredCount} missing global tags:`, restoreResult.restoredTags);
        // Reload global tags to include the newly restored ones
        await tagManagerModule.loadGlobalTags();
      }
    } catch (error) {
      logger.error("Error during tag restoration:", error);
    }

    await tagManagerModule.loadTagPreferences(); // This will set up state.selectedTags
    filterClips(); // This will set state.currentClipList correctly

    logger.info("Initial state.currentClipList length:", state.currentClipList.length);
    updateClipCounter(state.currentClipList.length);
    renderClips(state.currentClipList);
    setupClipTitleEditing();
    validateClipLists();
    tagManagerModule.updateFilterDropdown();

    logger.info("Clips loaded and rendered.");

    // Position indicators after rendering is complete
    setTimeout(() => {
      positionNewClipsIndicators();
    }, 100);

    // Save current clip list after initial load
    try {
      await ipcRenderer.invoke('save-clip-list-immediately');
    } catch (error) {
      logger.error('Failed to save clip list after initial load:', error);
    }

    hideLoadingScreen();

    // Start thumbnail validation after a short delay
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

  // Remove duplicates
  clips = removeDuplicates(clips);
  logger.info("Clips to render after removing duplicates:", clips.length);

  // Batch prefetch all thumbnail paths in a single IPC call (major perf optimization)
  const clipNames = clips.map(clip => clip.originalName);
  await prefetchThumbnailPaths(clipNames);

  // Group clips by time period
  const groups = {};
  clips.forEach(clip => {
    const group = getTimeGroup(clip.createdAt);
    if (!groups[group]) groups[group] = [];
    groups[group].push(clip);
  });

  // Get collapsed state
  const collapsedState = loadCollapsedState();

  // Sort groups by time (most recent first)
  const sortedGroups = Object.entries(groups).sort((a, b) => 
    getGroupOrder(a[0]) - getGroupOrder(b[0])
  );

  // Find where new clips begin for visual indicator
  let newClipsStartIndex = -1;
  if (newClipsInfo.totalNewCount > 0) {
    newClipsStartIndex = clips.findIndex(clip => clip.isNewSinceLastSession);
  }
  
  // Debug logging
  console.log('Debug - New clips info:', newClipsInfo);
  console.log('Debug - newClipsStartIndex:', newClipsStartIndex);
  console.log('Debug - clips with new status:', clips.map(c => ({ name: c.originalName, isNew: c.isNewSinceLastSession })).slice(0, 10));

  // Create and append groups
  let hasAddedNewClipsIndicator = false;
  
  for (const [groupName, groupClips] of sortedGroups) {
    // Check if this group contains the first new clip
    const groupHasFirstNewClip = newClipsStartIndex >= 0 && 
      groupClips.some(clip => clip.isNewSinceLastSession) &&
      !groupClips.every(clip => clip.isNewSinceLastSession);
    
    // Check if this entire group consists of new clips and we haven't added indicator yet
    const groupIsAllNewClips = groupClips.every(clip => clip.isNewSinceLastSession) && groupClips.length > 0;
    
    // Debug logging for this group
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
    
    // Create group header
    const header = document.createElement('div');
    header.className = 'clip-group-header';
    header.innerHTML = `
      <h2 class="clip-group-title">
        ${groupName}
        <span class="clip-group-count">${groupClips.length} clip${groupClips.length !== 1 ? 's' : ''}</span>
      </h2>
      <div class="clip-group-divider"></div>
    `;

    // Create group content
    const content = document.createElement('div');
    content.className = 'clip-group-content';
    
    // Only create clip elements if the group is not collapsed
    if (!collapsedState[groupName]) {
      // Create clip elements
      const clipElements = await Promise.all(groupClips.map(createClipElement));
      
      // Add clips to content with new clips indicator
      for (let i = 0; i < clipElements.length; i++) {
        const clipElement = clipElements[i];
        const clip = groupClips[i];
        
        // Mark this content area for later indicator positioning
        // Skip if the whole group is already marked as new clips or if indicators are disabled
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
      
      // Check if we need an indicator at the end of the group (last clip is new, no more clips)
      // Skip if the whole group is already marked as new clips or if indicators are disabled
      if (state.settings.showNewClipsIndicators !== false && !groupIsAllNewClips && !hasAddedNewClipsIndicator && groupClips.length > 0) {
        const lastClip = groupClips[groupClips.length - 1];
        if (lastClip.isNewSinceLastSession) {
          console.log('Debug - Adding end-of-group indicator after last new clip:', lastClip.originalName);
          content.dataset.needsIndicator = 'true';
          content.dataset.lastNewIndex = groupClips.length - 1;
          content.dataset.firstOldIndex = -1; // Special case: no next clip
          hasAddedNewClipsIndicator = true;
        }
      }
    } else {
      // Store the clip data for lazy loading
      groupElement.dataset.clips = JSON.stringify(groupClips.map(clip => ({
        originalName: clip.originalName,
        customName: clip.customName,
        createdAt: clip.createdAt,
        tags: clip.tags || []
      })));
    }

    // Add click handler for collapse/expand with lazy loading
    header.addEventListener('click', async () => {
      const isCollapsed = groupElement.classList.contains('collapsed');
      
      // Toggle collapsed state
      groupElement.classList.toggle('collapsed');
      collapsedState[groupName] = !isCollapsed;
      saveCollapsedState(collapsedState);
      
      // If we're expanding and the content isn't loaded yet, load it now
      if (isCollapsed && groupElement.dataset.loaded === 'false') {
        try {
          let groupClips;
          
          // Get the clips data from the dataset
          if (groupElement.dataset.clips) {
            groupClips = JSON.parse(groupElement.dataset.clips);
          } else {
            // Fallback to find clips in the current list if data not stored
            groupClips = state.currentClipList.filter(
              clip => getTimeGroup(clip.createdAt) === groupName
            );
          }
          
          // Show a loading indicator if there are many clips
          if (groupClips.length > 50) {
            const loadingIndicator = document.createElement('div');
            loadingIndicator.className = 'loading-indicator';
            loadingIndicator.innerHTML = `
              <div class="loading-spinner"></div>
              <div style="margin-top: 10px;">Loading ${groupClips.length} clips...</div>
            `;
            content.appendChild(loadingIndicator);
          }

          // Batch prefetch thumbnail paths for this group (single IPC call)
          await prefetchThumbnailPaths(groupClips.map(c => c.originalName));

          // Create clip elements in batches to avoid UI freezing
          const batchSize = 20;
          for (let i = 0; i < groupClips.length; i += batchSize) {
            const batch = groupClips.slice(i, i + batchSize);
            
            // Add a small delay between batches to allow UI to update
            if (i > 0) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            
            const clipElements = await Promise.all(batch.map(createClipElement));
            
            // Remove loading indicator if it exists
            if (i === 0 && groupClips.length > 50) {
              content.innerHTML = '';
            }
            
            // Add clips with new clips indicator logic (similar to main render)
            for (let j = 0; j < clipElements.length; j++) {
              const clipElement = clipElements[j];
              const clipIndex = i + j;
              const clip = batch[j];
              
              // Mark for indicator positioning in lazy-loaded content.
              // Indicator belongs at the first new->old transition.
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
          
          // Mark as loaded
          groupElement.dataset.loaded = 'true';
          
          // Remove stored clip data to free memory
          delete groupElement.dataset.clips;

          tagManagerModule.setupTooltips();
          
          // Position indicators for lazy-loaded content
          setTimeout(() => {
            positionNewClipsIndicators();
          }, 50);
        } catch (error) {
          logger.error("Error loading clips for group:", error);
          content.innerHTML = '<div class="error-message">Error loading clips</div>';
        }
      } else if (!isCollapsed && groupElement.dataset.loaded === 'true') {
        // If we're collapsing, optionally cleanup resources
        // This could be enabled for very large groups to free more memory
        // when collapsed, but would require reloading clips when expanded again
        
        // Uncomment the following code to enable cleanup on collapse
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

  // Initialize clip glow manager via the video player module
  const clipGlowManager = videoPlayerModule.getClipGlowManager();
  if (clipGlowManager) {
    clipGlowManager.init();
  }

  logger.info("Rendered clips count:", clips.length);
  
  // Setup grid navigation if controller is connected
  if (state.gamepadManager && state.gamepadManager.isGamepadConnected() && clips.length > 0) {
    setTimeout(() => {
      if (!state.gridNavigationEnabled) {
        enableGridNavigation();
      } else {
        updateGridSelection();
      }
    }, 100); // Small delay to ensure DOM is updated
  }
  
  state.isRendering = false;
}

/**
 * Build a DOM element for a single clip.
 * Wires dataset fields, click handlers, and preview behavior.
 */
function createClipElement(clip) {
  return new Promise(async (resolve) => {
    const clipElement = document.createElement("div");
    clipElement.className = "clip-item";
    clipElement.dataset.originalName = clip.originalName;

    const contentElement = document.createElement("div");
    contentElement.className = "clip-item-content";

    // Use cached thumbnail path (batch prefetched) with fallback to individual IPC
    let thumbnailPath = await getThumbnailPath(clip.originalName);

    const relativeTime = getRelativeTimeString(clip.createdAt);

    // Create media container
    const mediaContainer = document.createElement("div");
    mediaContainer.className = "clip-item-media-container";

    // Create image element
    const imgElement = document.createElement("img");
    
    // Only create shimmer if we don't have a thumbnail
    if (thumbnailPath === null) {
      // Add loading class to container
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
          // Remove shimmer elements completely from DOM
          const shimmerWrapper = mediaContainer.querySelector('.shimmer-wrapper');
          if (shimmerWrapper) {
            shimmerWrapper.remove();
          }
          mediaContainer.classList.remove('is-loading');
        }
      });
    } else {
      // We have a thumbnail, just set it directly
      imgElement.src = `file://${thumbnailPath}`;
    }

    imgElement.alt = clip.customName;
    imgElement.onerror = () => {
      imgElement.src = 'assets/fallback-image.jpg';
      // Remove shimmer if there's an error
      mediaContainer.classList.remove('is-loading');
      const shimmerWrapper = mediaContainer.querySelector('.shimmer-wrapper');
      if (shimmerWrapper) {
        shimmerWrapper.remove();
      }
    };

    mediaContainer.appendChild(imgElement);

    // Create tag container and add tags directly during clip element creation
    const tagContainer = document.createElement("div");
    tagContainer.className = "tag-container";
    
    // Add tags to the container if they exist
    if (clip.tags && clip.tags.length > 0) {
      const visibleTags = clip.tags.slice(0, 3);  // Show only first 3 tags
      visibleTags.forEach(tag => {
        const tagElement = document.createElement("span");
        tagElement.className = "tag";
        tagElement.textContent = tagManagerModule.truncateTag(tag);
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
      }
    }

    // Create the clip element structure
    clipElement.innerHTML = `
      ${mediaContainer.outerHTML}
      <div class="clip-info">
        <p class="clip-name" contenteditable="true">${clip.customName}</p>
        <p class="clip-time" title="${new Date(clip.createdAt).toLocaleString()}">${relativeTime}</p>
      </div>
    `;

    // Insert the tag container after mediaContainer
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

    // Setup tooltip events for tags if needed
    tagManagerModule.setupTagTooltips(clipElement);

    /**
     * Record original title before inline editing.
     */
    function handleClipTitleFocus(titleElement, clip) {
      titleElement.dataset.originalValue = titleElement.textContent;
    }
    
    /**
     * Persist title changes on blur if modified.
     */
    function handleClipTitleBlur(titleElement, clip) {
      const newTitle = titleElement.textContent.trim();
      if (newTitle !== titleElement.dataset.originalValue) {
        saveTitleChange(clip.originalName, clip.customName, newTitle);
      }
    }
    
    /**
     * Commit title on Enter, revert on Escape.
     */
    function handleClipTitleKeydown(e, titleElement, clip) {
      e.stopPropagation(); // Stop the event from bubbling up
      if (e.key === 'Enter') {
        e.preventDefault();
        titleElement.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        titleElement.textContent = titleElement.dataset.originalValue;
        titleElement.blur();
      }
    }

    /**
     * Hide preview/ambient glow on mouse leave.
     */
    function handleMouseLeave() {
    // Hide ambient glow
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
      e.preventDefault(); // Prevent the default context menu
      showContextMenu(e, clip);
    });
    clipElement.appendChild(contentElement);

    clipElement.cleanup = () => {
      videoPlayerModule.cleanupVideoPreview();
      clipElement.removeEventListener("mouseenter", onMouseEnter);
      clipElement.removeEventListener("mouseleave", handleMouseLeave);
    };

    // Fetch a potential game/application icon and append it to the clip-info
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

    resolve(clipElement);
  });
}

/**
 * Open a clip or update selection based on input modifiers.
 */
function handleClipClick(e, clip) {
  // Check if the clicked element is the title or its parent (the clip-info div)
  if (e.target.classList.contains('clip-name') || e.target.classList.contains('clip-info')) {
    // If it's the title or clip-info, don't open the clip
    return;
  }

  // Handle multi-select
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    handleClipSelection(e.target.closest('.clip-item'), e);
    return;
  }

  // Clear selection if clicking without modifier keys
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

/**
 * Update group counts or remove empty groups after deletion.
 */
function updateGroupAfterDeletion(clipElement) {
  const groupElement = clipElement.closest('.clip-group');
  if (!groupElement) return;

  const content = groupElement.querySelector('.clip-group-content');
  const remainingClips = content.querySelectorAll('.clip-item').length - 1; // -1 because the clip is not yet removed

  if (remainingClips === 0) {
    // If this was the last clip, remove the entire group
    groupElement.remove();
  } else {
    // Update the clip count
    const countElement = groupElement.querySelector('.clip-group-count');
    if (countElement) {
      countElement.textContent = `${remainingClips} clip${remainingClips !== 1 ? 's' : ''}`;
    }
  }
}

/**
 * Confirm and delete a clip (current or specified).
 */
async function confirmAndDeleteClip(clipToDelete = null) {
  if (!clipToDelete && !state.currentClip) return;
  
  const clipInfo = clipToDelete || state.currentClip;
  
  const isConfirmed = await showCustomConfirm(`Are you sure you want to delete "${clipInfo.customName}"? This action cannot be undone.`);

  if (isConfirmed) {
    // Ensure preview/glow are released before any deletion attempt
    videoPlayerModule.cleanupVideoPreview();
    const clipGlowManager = videoPlayerModule.getClipGlowManager();
    if (clipGlowManager) {
      clipGlowManager.hide();
    }

    // Immediately remove the clip from UI
    const clipElement = document.querySelector(`.clip-item[data-original-name="${clipInfo.originalName}"]`);
    if (clipElement) {
      // Update group before removing the clip
      updateGroupAfterDeletion(clipElement);
      clipElement.remove();
    }

    // Remove from state.allClips and state.currentClipList
    const allClipsIndex = state.allClips.findIndex(clip => clip.originalName === clipInfo.originalName);
    const currentClipListIndex = state.currentClipList.findIndex(clip => clip.originalName === clipInfo.originalName);
    
    if (allClipsIndex > -1) state.allClips.splice(allClipsIndex, 1);
    if (currentClipListIndex > -1) state.currentClipList.splice(currentClipListIndex, 1);

    try {
      // Close the player if we're deleting the current clip
      if (state.currentClip && state.currentClip.originalName === clipInfo.originalName) {
        await closePlayer();
        await videoPlayerModule.releaseVideoElement();
      }
      
      disableVideoThumbnail(clipInfo.originalName);
      
      // Show deletion tooltip
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
      
      // Revert the UI changes if deletion fails
      if (clipElement && clipElement.parentNode === null) {
        // Find or recreate the appropriate group
        const timeGroup = getTimeGroup(clipInfo.createdAt);
        let groupElement = document.querySelector(`.clip-group[data-group-name="${timeGroup}"]`);
        
        if (!groupElement) {
          // Recreate the group if it was removed
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
          
          // Insert the group in the correct position
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
        
        // Add the clip back to the group
        const content = groupElement.querySelector('.clip-group-content');
        content.appendChild(clipElement);
        
        // Update the group count
        const countElement = groupElement.querySelector('.clip-group-count');
        const currentCount = content.querySelectorAll('.clip-item').length;
        countElement.textContent = `${currentCount} clip${currentCount !== 1 ? 's' : ''}`;
      }
      
      // Revert data changes
      if (allClipsIndex > -1) state.allClips.splice(allClipsIndex, 0, clipInfo);
      if (currentClipListIndex > -1) state.currentClipList.splice(currentClipListIndex, 0, clipInfo);
    } finally {
      // Hide deletion tooltip
      hideDeletionTooltip();
    }

    updateClipCounter(state.currentClipList.length);
    
    // Update new clips indicators after deletion
    updateNewClipsIndicators();
    
    // Save clip list immediately after deletion
    try {
      await ipcRenderer.invoke('save-clip-list-immediately');
    } catch (error) {
      logger.error('Failed to save clip list after deletion:', error);
    }
  }
}

/**
 * Update the clip title shown in the grid and backing state.
 */
function updateClipNameInLibrary(originalName, newCustomName) {
  if (!originalName) {
    logger.warn(
      "Attempted to update clip name in library with undefined originalName",
    );
    return;
  }

  const clipElement = clipGrid.querySelector(
    `[data-original-name="${originalName}"]`,
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

/**
 * Show the right-click context menu for a clip.
 */
function showContextMenu(e, clip) {
  e.preventDefault();
  e.stopPropagation();

  const contextMenu = document.getElementById("context-menu");
  const tagsDropdown = document.getElementById("tags-dropdown");

  if (contextMenu) {
    // Reset the context menu state
    contextMenu.style.display = "none";
    tagsDropdown.style.display = "none";
    state.isTagsDropdownOpen = false; 
    
    // Clear any checked checkboxes
    const checkboxes = tagsDropdown.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => checkbox.checked = false);
    
    // Clear the tag search input
    const tagSearchInput = document.getElementById("tag-search-input");
    if (tagSearchInput) tagSearchInput.value = '';

    // Set new position and show the menu
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;
    contextMenu.style.display = "block";

    // Update the state.contextMenuClip
    state.contextMenuClip = clip;

    logger.info("Context menu shown for clip:", clip.originalName);
    
    // Update the tag list for the new clip
    tagManagerModule.updateTagList();
    
    // Add a click event listener to the document to close the context menu
    document.addEventListener('click', closeContextMenu);
    
    // Add an overlay to block clicks outside the context menu
    const overlay = document.createElement('div');
    overlay.id = 'context-menu-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.zIndex = '1980'; // Just below the context menu
    clipGrid.appendChild(overlay);
  } else {
    logger.error("Context menu elements not found");
  }
}

/**
 * Close the clip context menu if open.
 */
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

// ============================================================================
// THUMBNAIL MANAGEMENT
// ============================================================================

const THUMBNAIL_RETRY_DELAY = 2000; // 2 seconds
const THUMBNAIL_INIT_DELAY = 1000; // 1 second delay before first validation

/**
 * Batch fetch thumbnail paths for multiple clips in a single IPC call
 */
async function prefetchThumbnailPaths(clipNames) {
  if (!clipNames || clipNames.length === 0) return;

  try {
    const results = await ipcRenderer.invoke("get-thumbnail-paths-batch", clipNames);
    // Store results in cache
    for (const [clipName, thumbnailPath] of Object.entries(results)) {
      state.thumbnailPathCache.set(clipName, thumbnailPath);
    }
  } catch (error) {
    logger.warn("Failed to batch fetch thumbnail paths:", error.message);
  }
}

/**
 * Get thumbnail path from cache or fetch individually as fallback
 */
async function getThumbnailPath(clipName) {
  // Check cache first
  if (state.thumbnailPathCache.has(clipName)) {
    return state.thumbnailPathCache.get(clipName);
  }
  // Fallback to individual IPC call (for edge cases)
  const path = await ipcRenderer.invoke("get-thumbnail-path", clipName);
  state.thumbnailPathCache.set(clipName, path);
  return path;
}

/**
 * Kick off thumbnail validation/generation for the current list.
 */
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

    // Add this line to collect pending clips
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
            
            // Remove from pending set when processed
            pendingClips.delete(clipName);
            
            ipcRenderer.invoke("get-thumbnail-path", clipName).then(thumbnailPath => {
              if (thumbnailPath) {
                // Update cache with newly generated thumbnail path
                state.thumbnailPathCache.set(clipName, thumbnailPath);
                updateClipThumbnail(clipName, thumbnailPath);
              }
            });
          });

          ipcRenderer.once("thumbnail-generation-complete", () => {
            // Check if any clips were missed
            if (pendingClips.size > 0) {
              // Process any remaining clips
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

  if (state.selectedTags && state.selectedTags.size > 0) {
    const isUntagged = clipTags.length === 0;
    if (state.selectedTags.has('Untagged') && isUntagged) {
      return true;
    }
    return clipTags.some(tag => state.selectedTags.has(tag));
  }

  return true;
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

  let matchesSystemTag = false;
  if (state.selectedTags.has('Untagged') && isUntagged) {
    matchesSystemTag = true;
  }
  if (state.selectedTags.has('Unnamed') && isUnnamed) {
    matchesSystemTag = true;
  }

  if (isUntagged && !state.selectedTags.has('Untagged')) {
    return false;
  }

  if (isUnnamed && !state.selectedTags.has('Unnamed')) {
    return false;
  }

  if (matchesSystemTag) {
    return true;
  }

  if (clipTags.length > 0) {
    if (state.isInTemporaryMode) {
      return clipTags.some(tag => state.temporaryTagSelections.has(tag));
    }
    return clipTags.every(tag => state.selectedTags.has(tag));
  }

  return false;
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

/**
 * Add a new clip to state and update the grid.
 */
async function addNewClipToLibrary(fileName) {
  try {
    // First check if the file exists
    const clipPath = path.join(state.clipLocation, fileName);
    try {
      await fs.access(clipPath);
    } catch (error) {
      logger.info(`File no longer exists, skipping: ${fileName}`);
      return;
    }

    const newClipInfo = await ipcRenderer.invoke('get-new-clip-info', fileName);
    
    // Mark as new since it's being added during runtime
    newClipInfo.isNewSinceLastSession = true;
    
    // Update the newClipsInfo to include this clip
    if (!newClipsInfo.newClips.includes(fileName)) {
      newClipsInfo.newClips.push(fileName);
      newClipsInfo.totalNewCount++;
    }
    
    // Check if the clip already exists in state.allClips
    const existingClipIndex = state.allClips.findIndex(clip => clip.originalName === newClipInfo.originalName);
    
    if (existingClipIndex === -1) {
      // If it doesn't exist, add it to state.allClips
      state.allClips.unshift(newClipInfo);

      const shouldRenderInCurrentView = shouldIncludeClipInCurrentList(newClipInfo);
      if (shouldRenderInCurrentView) {
        insertClipIntoCurrentList(newClipInfo);
      }

      // Create clip element with a loading thumbnail first
      const newClipElement = shouldRenderInCurrentView ? await createClipElement({
        ...newClipInfo,
        thumbnailPath: "assets/loading-thumbnail.gif"
      }) : null;

      if (shouldRenderInCurrentView) {
        // Find or create the appropriate time group
        const timeGroup = getTimeGroup(newClipInfo.createdAt);
        
        // First try to find an existing group by looking at the header text content
        let groupElement = Array.from(document.querySelectorAll('.clip-group'))
          .find(group => {
            const headerText = group.querySelector('.clip-group-header h2.clip-group-title')?.textContent.trim();
            return headerText?.startsWith(timeGroup);
          });
        let content;
        
        if (groupElement) {
          // Use existing group
          content = groupElement.querySelector('.clip-group-content');
          
          // Update clip count
          const countElement = groupElement.querySelector('.clip-group-count');
          const currentCount = parseInt(countElement.textContent);
          countElement.textContent = `${currentCount + 1} clip${currentCount + 1 !== 1 ? 's' : ''}`;
        } else {
          // Create new group if it doesn't exist
          groupElement = document.createElement('div');
          groupElement.className = 'clip-group';
          groupElement.dataset.groupName = timeGroup;
          
          // Create group header
          const header = document.createElement('div');
          header.className = 'clip-group-header';
          header.innerHTML = `
            <h2 class="clip-group-title">
              ${timeGroup}
              <span class="clip-group-count">1 clip</span>
            </h2>
            <div class="clip-group-divider"></div>
          `;

          // Add click handler for collapse/expand
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

          // Create group content
          content = document.createElement('div');
          content.className = 'clip-group-content';
          
          groupElement.appendChild(header);
          groupElement.appendChild(content);

          // Insert the group in the correct position
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

        // Add the new clip to the group content at the beginning
        content.insertBefore(newClipElement, content.firstChild);
        
        // Check if this group now contains only new clips and update styling
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
        
        // Force a clean state for the new clip
        newClipElement.dataset.trimStart = undefined;
        newClipElement.dataset.trimEnd = undefined;
      }

      // Generate thumbnail in the background without waiting
      setTimeout(async () => {
        try {
          await ipcRenderer.invoke("generate-thumbnails-progressively", [fileName]);
        } catch (error) {
          logger.error("Error in background thumbnail generation:", error);
        }
      }, 1000); // Give a slight delay to ensure file is fully written

    } else {
      // If it exists, update the existing clip info
      state.allClips[existingClipIndex] = newClipInfo;
      if (shouldIncludeClipInCurrentList(newClipInfo)) {
        insertClipIntoCurrentList(newClipInfo);
      }
      const existingElement = document.querySelector(`[data-original-name="${newClipInfo.originalName}"]`);
      if (existingElement) {
        const updatedElement = await createClipElement(newClipInfo);
        existingElement.replaceWith(updatedElement);
      }
    }
    
    tagManagerModule.updateFilterDropdown();

    // Update new clips indicators after adding clip (avoid full re-render)
    positionNewClipsIndicators();

    updateClipCounter(state.currentClipList.length);

    // Save clip list immediately after adding clip
    try {
      await ipcRenderer.invoke('save-clip-list-immediately');
    } catch (error) {
      logger.error('Failed to save clip list after adding clip:', error);
    }
  } catch (error) {
    logger.error("Error adding new clip to library:", error);
  }
}

// ============================================================================
// GRID NAVIGATION
// ============================================================================

function enableGridNavigation() {
  state.gridNavigationEnabled = true;
  state.currentGridFocusIndex = 0;
  updateGridSelection();
  setupMouseKeyboardDetection(); // Set up detection to hide on mouse/keyboard use
}

/**
 * Disable grid navigation and clear the focus highlight.
 */
function disableGridNavigation() {
  state.gridNavigationEnabled = false;
  // Remove focus from all clips
  document.querySelectorAll('.clip-item').forEach(clip => {
    clip.classList.remove('controller-focused');
  });
  removeMouseKeyboardDetection(); // Clean up listeners when disabling
}

/**
 * Open the clip currently focused by grid navigation.
 */
function openCurrentGridSelection() {
  if (!state.gridNavigationEnabled) return;
  
  const visibleClips = getVisibleClips();
  if (visibleClips.length === 0 || state.currentGridFocusIndex >= visibleClips.length) return;
  
  const selectedClip = visibleClips[state.currentGridFocusIndex];
  if (!selectedClip) return;
  
  const originalName = selectedClip.dataset.originalName;
  const customName = selectedClip.dataset.customName || originalName;

  if (originalName) {
    disableGridNavigation(); // Disable grid navigation when opening clip

    // Add keyboard event listeners for video player controls
    document.addEventListener("keydown", handleKeyPress);
    document.addEventListener("keyup", handleKeyRelease);

    videoPlayerModule.openClip(originalName, customName);
  }
}

// Mouse and keyboard detection to hide controller selection
function setupMouseKeyboardDetection() {
  if (state.mouseKeyboardListenersSetup) return; // Already set up
  
  // Mouse movement detection
  document.addEventListener('mousemove', hideControllerSelectionOnInput, { passive: true });
  
  // Mouse click detection
  document.addEventListener('mousedown', hideControllerSelectionOnInput, { passive: true });
  
  // Keyboard detection (but exclude controller-related keys in video player)
  document.addEventListener('keydown', hideControllerSelectionOnKeyboard, { passive: true });
  
  state.mouseKeyboardListenersSetup = true;
}

/**
 * Remove mouse/keyboard detection listeners.
 */
function removeMouseKeyboardDetection() {
  if (!state.mouseKeyboardListenersSetup) return;
  
  document.removeEventListener('mousemove', hideControllerSelectionOnInput);
  document.removeEventListener('mousedown', hideControllerSelectionOnInput);
  document.removeEventListener('keydown', hideControllerSelectionOnKeyboard);
  
  state.mouseKeyboardListenersSetup = false;
}

/**
 * Hide controller focus ring after pointer input.
 */
function hideControllerSelectionOnInput() {
  if (state.gridNavigationEnabled) {
    disableGridNavigation();
  }
}

/**
 * Hide controller focus ring after keyboard input.
 */
function hideControllerSelectionOnKeyboard(e) {
  // Don't hide on controller-related keys
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

/**
 * Return visible clip elements in the grid.
 */
function getVisibleClips() {
  // Get all clip elements that are currently visible in the grid
  return Array.from(document.querySelectorAll('.clip-item:not(.hidden)'));
}

/**
 * Find the closest clip in a given direction.
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

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Initialization
  init,

  // Clip grid management
  loadClips,
  renderClips,
  createClipElement,
  handleClipClick,
  confirmAndDeleteClip,
  updateClipNameInLibrary,
  validateClipLists,
  showContextMenu,
  closeContextMenu,

  // Thumbnail management
  prefetchThumbnailPaths,
  getThumbnailPath,
  startThumbnailValidation,
  addNewClipToLibrary,

  // Grid navigation
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
