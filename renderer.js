const { ipcRenderer } = require("electron");
const path = require("path");
const { Titlebar, TitlebarColor } = require("custom-electron-titlebar");
const logger = require('./logger');

const clipGrid = document.getElementById("clip-grid");
const fullscreenPlayer = document.getElementById("fullscreen-player");
const videoPlayer = document.getElementById("video-player");
const clipTitle = document.getElementById("clip-title");
const progressBarContainer = document.getElementById("progress-bar-container");
const progressBar = document.getElementById("progress-bar");
const trimStart = document.getElementById("trim-start");
const trimEnd = document.getElementById("trim-end");
const playhead = document.getElementById("playhead");
const loadingOverlay = document.getElementById("loading-overlay");
const playerOverlay = document.getElementById("player-overlay");
const videoClickTarget = document.getElementById("video-click-target");
const MAX_FRAME_RATE = 10;
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes in milliseconds
const volumeButton = document.getElementById("volume-button");
const volumeSlider = document.getElementById("volume-slider");
const volumeContainer = document.getElementById("volume-container");
const speedButton = document.getElementById("speed-button");
const speedSlider = document.getElementById("speed-slider");
const speedContainer = document.getElementById("speed-container");
const speedText = document.getElementById("speed-text");
const volumeIcons = {
  normal: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M760-481q0-83-44-151.5T598-735q-15-7-22-21.5t-2-29.5q6-16 21.5-23t31.5 0q97 43 155 131.5T840-481q0 108-58 196.5T627-153q-16 7-31.5 0T574-176q-5-15 2-29.5t22-21.5q74-34 118-102.5T760-481ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm380-120q0 42-19 79.5T591-339q-10 6-20.5.5T560-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM400-606l-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`,
  muted: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="m720-424-76 76q-11 11-28 11t-28-11q-11-11-11-28t11-28l76-76-76-76q-11-11-11-28t11-28q11-11 28-11t28 11l76 76 76-76q11-11 28-11t28 11q11 11 11 28t-11 28l-76 76 76 76q11 11 11 28t-11 28q-11 11-28 11t-28-11l-76-76Zm-440 64H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`,
  low: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M360-360H240q-17 0-28.5-11.5T200-400v-160q0-17 11.5-28.5T240-600h120l132-132q19-19 43.5-8.5T560-703v446q0 27-24.5 37.5T492-228L360-360Zm380-120q0 42-19 79.5T671-339q-10 6-20.5.5T640-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM480-606l-86 86H280v80h114l86 86v-252ZM380-480Z"/></svg>`,
  high: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M760-440h-80q-17 0-28.5-11.5T640-480q0-17 11.5-28.5T680-520h80q17 0 28.5 11.5T800-480q0 17-11.5 28.5T760-440ZM584-288q10-14 26-16t30 8l64 48q14 10 16 26t-8 30q-10 14-26 16t-30-8l-64-48q-14-10-16-26t8-30Zm120-424-64 48q-14 10-30 8t-26-16q-10-14-8-30t16-26l64-48q14-10 30-8t26 16q10 14 8 30t-16 26ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`
};
const THUMBNAIL_RETRY_DELAY = 2000; // 2 seconds
const THUMBNAIL_INIT_DELAY = 1000; // 1 second delay before first validation

let audioContext, gainNode;
let initialPlaybackTime = 0;
let lastActivityTime = Date.now();
let currentClipList = [];
let currentClip = null;
let trimStartTime = 0;
let trimEndTime = 0;
let isDragging = null;
let isDraggingTrim = false;
let dragStartX = 0;
let dragThreshold = 5; // pixels
let lastMousePosition = { x: 0, y: 0 };
let isMouseDown = false;
let clipLocation;
let isLoading = false;
let currentCleanup = null;
let allClips = [];
let contextMenuClip = null;
let isTagsDropdownOpen = false;
let isFrameStepping = false;
let frameStepDirection = 0;
let lastFrameStepTime = 0;
let pendingFrameStep = false;
let controlsTimeout;
let isMouseOverControls = false;
let isRendering = false;
let deletionTooltip = null;
let deletionTimeout = null;
let settings;
let discordPresenceInterval;
let clipStartTime;
let elapsedTime = 0;
let loadingScreen;
let processingTimeout = null;
let activePreview = null;
let previewCleanupTimeout = null;
let isGeneratingThumbnails = false;
let currentGenerationTotal = 0;
let completedThumbnails = 0;
let thumbnailGenerationStartTime = 0;
let selectedClips = new Set();
let selectionStartIndex = -1;
let selectedTags = new Set();
let volumeStartTime = 0;
let volumeEndTime = 0;
let volumeLevel = 0; // Volume level for the range
let isVolumeDragging = null;
let volumeStartElement = null;
let volumeEndElement = null;
let volumeRegionElement = null;
let volumeDragControl = null;
let isVolumeControlsVisible = false;
let savedTagSelections = new Set(); // Permanent selections that are saved
let temporaryTagSelections = new Set(); // Temporary (Ctrl+click) selections
let isInTemporaryMode = false; // Whether we're in temporary selection mode

const previewElement = document.getElementById('timeline-preview');

previewElement.style.display = 'none';;

// Create a temporary video element for previews
const tempVideo = document.createElement('video');
tempVideo.crossOrigin = 'anonymous';
tempVideo.preload = 'auto';
tempVideo.muted = true;
tempVideo.style.display = 'none'; // Hide the temp video
document.body.appendChild(tempVideo); // Add to DOM

ipcRenderer.on('log', (event, { type, message }) => {
  console[type](`[Main Process] ${message}`);
});

const settingsModal = document.createElement("div");
settingsModal.id = "settingsModal";
settingsModal.className = "settings-modal";
settingsModal.innerHTML = `
<div class="settings-modal-content">
    <div class="settings-tabs">
      <div class="settings-tab active" data-tab="general">General</div>
      <div class="settings-tab" data-tab="exportImport">Export/Import</div>
      <div class="settings-tab" data-tab="about">About</div>
    </div>

    <div class="settings-tab-content active" data-tab="general">
      <div class="settings-group">
        <h3 class="settings-group-title">Clip Library Location</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Current Location</div>
            <div class="settings-item-description" id="currentClipLocation">Loading...</div>
          </div>
          <div class="settings-control">
            <button id="changeLocationBtn" class="settings-button settings-button-primary">Change Location</button>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h3 class="settings-group-title">Playback</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Preview Volume</div>
            <div class="settings-item-description">Set the default volume for clip previews</div>
          </div>
          <div class="settings-control">
            <input type="range" id="previewVolumeSlider" class="settings-range" min="0" max="1" step="0.01" value="0.1">
            <span id="previewVolumeValue">10%</span>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h3 class="settings-group-title">Integration</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Discord Rich Presence</div>
            <div class="settings-item-description">Show your current activity in Discord</div>
          </div>
          <div class="settings-control">
            <label class="settings-switch">
              <input type="checkbox" id="enableDiscordRPC">
              <span class="settings-switch-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h3 class="settings-group-title">Tag Management</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Manage Tags</div>
            <div class="settings-item-description">Edit and organize your clip tags</div>
          </div>
          <div class="settings-control">
            <button id="manageTagsBtn" class="settings-button settings-button-secondary">Manage Tags</button>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-tab-content" data-tab="exportImport">
      <div class="settings-group">
        <h3 class="settings-group-title">Export Settings</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Export Quality</div>
            <div class="settings-item-description">Choose the default quality for exported clips</div>
          </div>
          <div class="settings-control">
            <select id="exportQuality" class="settings-select">
              <option value="discord">Discord (~10MB)</option>
              <option value="high">High Quality (~30MB)</option>
              <option value="lossless">Lossless</option>
            </select>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h3 class="settings-group-title">Import Options</h3>
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Import from SteelSeries</div>
            <div class="settings-item-description">Select your SteelSeries Moments folder</div>
          </div>
          <div class="settings-control">
            <button id="importSteelSeriesBtn" class="settings-button settings-button-primary">Import Clips</button>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-tab-content" data-tab="about">
      <div class="settings-group">
        <div class="settings-item">
          <div class="settings-item-info">
            <div class="settings-item-title">Clip Library</div>
            <div class="settings-item-description">A modern, fast, and efficient way to manage your clip collection.</div>
          </div>
        </div>
      </div>

      <div class="settings-version">
        <p>Version: <span id="app-version">Loading...</span></p>
      </div>
    </div>
    <div class="settings-footer">
      <button id="closeSettingsBtn" class="settings-save-button">
        Save Settings
      </button>
    </div>
  </div>
`;

const container = document.querySelector('.cet-container') || document.body;
container.appendChild(settingsModal);

const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const currentClipLocationSpan = document.getElementById("currentClipLocation");

async function fetchSettings() {
  settings = await ipcRenderer.invoke('get-settings');
  logger.info('Fetched settings:', settings);  // Log the fetched settings
  
  // Set defaults if not present
  if (settings.previewVolume === undefined) settings.previewVolume = 0.1;
  if (settings.exportQuality === undefined) settings.exportQuality = 'discord';
  await ipcRenderer.invoke('save-settings', settings);
  logger.info('Settings after defaults:', settings);  // Log after setting defaults
  return settings;
}

async function loadClips() {
  try {
    logger.info("Loading clips...");
    clipLocation = await ipcRenderer.invoke("get-clip-location");
    currentClipLocationSpan.textContent = clipLocation;
    allClips = await ipcRenderer.invoke("get-clips");
    logger.info("Clips received:", allClips.length);
    
    // Load tags for each clip in smaller batches
    const TAG_BATCH_SIZE = 50;
    for (let i = 0; i < allClips.length; i += TAG_BATCH_SIZE) {
      const batch = allClips.slice(i, i + TAG_BATCH_SIZE);
      await Promise.all(batch.map(async (clip) => {
        clip.tags = await ipcRenderer.invoke("get-clip-tags", clip.originalName);
      }));
      
      // Small delay between tag batches
      if (i + TAG_BATCH_SIZE < allClips.length) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    allClips = removeDuplicates(allClips);
    allClips.sort((a, b) => b.createdAt - a.createdAt);

    await loadTagPreferences(); // This will set up selectedTags
    filterClips(); // This will set currentClipList correctly
    
    logger.info("Initial currentClipList length:", currentClipList.length);
    updateClipCounter(currentClipList.length);
    renderClips(currentClipList);
    setupClipTitleEditing();
    validateClipLists();
    updateFilterDropdown();

    logger.info("Clips loaded and rendered.");
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

async function startThumbnailValidation() {
  logger.info("Starting thumbnail validation for clips:", allClips.length);
  
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
    const pendingClips = new Set(allClips.map(clip => clip.originalName));

    const generationPromise = new Promise((resolve) => {
      ipcRenderer.invoke("generate-thumbnails-progressively", Array.from(pendingClips))
      .then((result) => {
        if (result.needsGeneration > 0) {
          showThumbnailGenerationText(result.needsGeneration);

          ipcRenderer.on("thumbnail-progress", (event, { current, total, clipName }) => {
            currentTimeout = createTimeout();
            if (isGeneratingThumbnails) {
              updateThumbnailGenerationText(total - current);
            }
            
            // Remove from pending set when processed
            pendingClips.delete(clipName);
            
            ipcRenderer.invoke("get-thumbnail-path", clipName).then(thumbnailPath => {
              if (thumbnailPath) {
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

function hideLoadingScreen() {
  if (loadingScreen) {
    // Add the fade-out class to trigger the animations
    loadingScreen.classList.add('fade-out');
    
    // Remove the element after the animation completes
    setTimeout(() => {
      loadingScreen.style.display = 'none';
    }, 1000); // Match this with the animation duration (1s)
  }
}

async function updateVersionDisplay() {
  try {
    const version = await ipcRenderer.invoke('get-app-version');
    const versionElement = document.getElementById('app-version');
    if (versionElement) {
      versionElement.textContent = `Version: ${version}`;
    }
  } catch (error) {
    logger.error('Failed to get app version:', error);
  }
}

async function addNewClipToLibrary(fileName) {
  try {
    const newClipInfo = await ipcRenderer.invoke('get-new-clip-info', fileName);
    
    // Check if the clip already exists in allClips
    const existingClipIndex = allClips.findIndex(clip => clip.originalName === newClipInfo.originalName);
    
    if (existingClipIndex === -1) {
      // If it doesn't exist, add it to allClips
      allClips.unshift(newClipInfo);
      
      // Create clip element with a loading thumbnail first
      const newClipElement = await createClipElement({
        ...newClipInfo,
        thumbnailPath: "assets/loading-thumbnail.gif"
      });
      
      clipGrid.insertBefore(newClipElement, clipGrid.firstChild);
      
      // Force a clean state for the new clip
      const clipElement = clipGrid.querySelector(`[data-original-name="${newClipInfo.originalName}"]`);
      if (clipElement) {
        clipElement.dataset.trimStart = undefined;
        clipElement.dataset.trimEnd = undefined;
      }

      // Generate thumbnail in the background without waiting
      // This prevents the timeout from blocking the clip addition
      setTimeout(async () => {
        try {
          await ipcRenderer.invoke("generate-thumbnails-progressively", [fileName]);
        } catch (error) {
          logger.error("Error in background thumbnail generation:", error);
        }
      }, 1000); // Give a slight delay to ensure file is fully written

    } else {
      // If it exists, update the existing clip info
      allClips[existingClipIndex] = newClipInfo;
      const existingElement = clipGrid.querySelector(`[data-original-name="${newClipInfo.originalName}"]`);
      if (existingElement) {
        const updatedElement = await createClipElement(newClipInfo);
        existingElement.replaceWith(updatedElement);
      }
    }
    
    updateFilterDropdown();

  } catch (error) {
    logger.error("Error adding new clip to library:", error);
  }
}

ipcRenderer.on('new-clip-added', (event, fileName) => {
  addNewClipToLibrary(fileName);
});

ipcRenderer.on('new-clip-added', (event, fileName) => {
  addNewClipToLibrary(fileName);
  updateFilterDropdown();
});

ipcRenderer.on("thumbnail-validation-start", (event, { total }) => {
  // Always reset state when validation starts
  isGeneratingThumbnails = false;
  currentGenerationTotal = 0;
  completedThumbnails = 0;
  thumbnailGenerationStartTime = null;
  
  if (total > 0) {
    showThumbnailGenerationText(total);
  }
});

ipcRenderer.on("thumbnail-progress", (event, { current, total, clipName }) => {
  if (isGeneratingThumbnails) {
    updateThumbnailGenerationText(total - current);
  }
  logger.info(`Thumbnail generation progress: (${current}/${total}) - Processing: ${clipName}`);
});

ipcRenderer.on("thumbnail-generation-complete", () => {
  hideThumbnailGenerationText();
  isGeneratingThumbnails = false;
  // Clear any existing timeouts here as well
  if (window.thumbnailGenerationTimeout) {
    clearTimeout(window.thumbnailGenerationTimeout);
    window.thumbnailGenerationTimeout = null;
  }
});

function showThumbnailGenerationText(totalToGenerate) {
  if (totalToGenerate <= 0) return;
  
  // Reset all state variables
  isGeneratingThumbnails = true;
  currentGenerationTotal = totalToGenerate;
  completedThumbnails = 0;
  thumbnailGenerationStartTime = Date.now();
  
  let textElement = document.getElementById("thumbnail-generation-text");
  
  if (!textElement) {
    textElement = document.createElement("div");
    textElement.id = "thumbnail-generation-text";
    textElement.style.position = "fixed";
    textElement.style.top = "100px";
    textElement.style.left = "50%";
    textElement.style.transform = "translateX(-50%)";
    textElement.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
    textElement.style.color = "white";
    textElement.style.padding = "10px 20px";
    textElement.style.borderRadius = "20px";
    textElement.style.zIndex = "10000";
    textElement.style.fontWeight = "normal";
    textElement.style.display = "block";
    document.body.appendChild(textElement);
  }
  
  updateThumbnailGenerationText(totalToGenerate);
}

function updateClipCounter(count) {
  const counter = document.getElementById('clip-counter');
  if (counter) {
    counter.textContent = `Clips: ${count}`;
  }
}

function updateThumbnailGenerationText(remaining) {
  if (!isGeneratingThumbnails) return;
  
  const textElement = document.getElementById("thumbnail-generation-text");
  if (!textElement) return;

  textElement.style.display = "block";
  
  if (remaining <= 0) {
    hideThumbnailGenerationText();
    return;
  }

  completedThumbnails = currentGenerationTotal - remaining;
  const percentage = Math.round((completedThumbnails / currentGenerationTotal) * 100);
  
  // Calculate time estimate based on actual progress
  let estimatedTimeRemaining = 0;
  if (completedThumbnails > 0) {
    const elapsedTime = (Date.now() - thumbnailGenerationStartTime) / 1000; // in seconds
    const averageTimePerThumbnail = elapsedTime / completedThumbnails;
    // Calculate remaining time and convert to minutes, rounding up
    estimatedTimeRemaining = Math.ceil((averageTimePerThumbnail * remaining) / 60);
    
    // Ensure we show at least 1 minute if there's any time remaining
    if (remaining > 0 && estimatedTimeRemaining === 0) {
      estimatedTimeRemaining = 1;
    }
  }

  textElement.textContent = `Generating thumbnails... ${completedThumbnails}/${currentGenerationTotal} (${percentage}%) - Est. ${estimatedTimeRemaining} min remaining`;
}

function hideThumbnailGenerationText() {
  const textElement = document.getElementById("thumbnail-generation-text");
  if (textElement) {
    textElement.remove();
  }
  isGeneratingThumbnails = false;
  currentGenerationTotal = 0;
  completedThumbnails = 0;
}

window.addEventListener('beforeunload', () => {
  if (window.thumbnailGenerationTimeout) {
    clearTimeout(window.thumbnailGenerationTimeout);
  }
  hideThumbnailGenerationText();
});

ipcRenderer.on("thumbnail-generation-failed", (event, { clipName, error }) => {
  logger.error(`Failed to generate thumbnail for ${clipName}: ${error}`);
});

ipcRenderer.on("thumbnail-generated", (event, { clipName, thumbnailPath }) => {
  updateClipThumbnail(clipName, thumbnailPath);
});

async function getFfmpegVersion() {
  try {
    await ipcRenderer.invoke('get-ffmpeg-version');
  } catch (error) {
    logger.error('Failed to get FFmpeg version:', error);
  }
}

function updateClipThumbnail(clipName, thumbnailPath) {
  const clipElement = document.querySelector(
    `.clip-item[data-original-name="${clipName}"]`
  );
  if (clipElement) {
    const imgElement = clipElement.querySelector("img");
    if (imgElement) {
      // Create a new image element
      const newImg = new Image();
      newImg.onload = () => {
        // Only replace the src after the new image has loaded
        imgElement.src = newImg.src;
      };
      // Add cache busting and random number to ensure unique URL
      newImg.src = `file://${thumbnailPath}?t=${Date.now()}-${Math.random()}`;
    } else {
      logger.warn(`Image element not found for clip: ${clipName}`);
    }
  } else {
    logger.warn(`Clip element not found for: ${clipName}`);
  }
}

async function renderClips(clips) {
  if (isRendering) {
    logger.info("Render already in progress, skipping");
    return;
  }
  
  isRendering = true;
  logger.info("Rendering clips. Input length:", clips.length);
  clipGrid.innerHTML = ""; // Clear the grid

  clips = removeDuplicates(clips);
  logger.info("Clips to render after removing duplicates:", clips.length);

  const clipPromises = clips.map(createClipElement);
  const clipElements = await Promise.all(clipPromises);

  clipElements.forEach((clipElement) => {
    clipGrid.appendChild(clipElement);
    const clip = clips.find(c => c.originalName === clipElement.dataset.originalName);
    if (clip) {
      updateClipTags(clip);
    }
  });

  setupTooltips();
  currentClipList = clips;
  addHoverEffect();

  document.querySelectorAll('.clip-item').forEach(card => {
    card.addEventListener('mouseenter', handleMouseEnter);
    card.addEventListener('mouseleave', handleMouseLeave);
  });

  logger.info("Rendered clips count:", clipGrid.children.length);
  isRendering = false;
}

let currentHoveredCard = null;

function handleOnMouseMove(e) {
  if (!currentHoveredCard) return;

  const rect = currentHoveredCard.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  const centerX = rect.width / 2;
  const centerY = rect.height / 2;

  const tiltX = (y - centerY) / centerY;
  const tiltY = (centerX - x) / centerX;

  requestAnimationFrame(() => {
    if (currentHoveredCard) {
      currentHoveredCard.style.setProperty("--mouse-x", `${x}px`);
      currentHoveredCard.style.setProperty("--mouse-y", `${y}px`);
      currentHoveredCard.style.setProperty("--tilt-x", `${tiltX * 5}deg`);
      currentHoveredCard.style.setProperty("--tilt-y", `${tiltY * 5}deg`);
    }
  });
}

function handleMouseEnter(e) {
  currentHoveredCard = e.currentTarget;
}

function handleMouseLeave(e) {
  const card = e.currentTarget;
  card.style.setProperty("--tilt-x", "0deg");
  card.style.setProperty("--tilt-y", "0deg");
  currentHoveredCard = null;
}

function addHoverEffect() {
  const wrapper = document.getElementById("clip-grid");
  wrapper.addEventListener("mousemove", handleOnMouseMove);
}

function setupSearch() {
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", debounce(performSearch, 300));
}

function performSearch() {
  const searchDisplay = document.getElementById('search-display');
  if (!searchDisplay) return;

  const searchText = searchDisplay.innerText.trim().toLowerCase();
  const searchTerms = parseSearchTerms(searchText);
  
  // Start with all clips
  let filteredClips = [...allClips];
  
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
  if (selectedTags.size > 0) {
    filteredClips = filteredClips.filter(clip => {
      if (selectedTags.has('Untagged')) {
        if (!clip.tags || clip.tags.length === 0) {
          return true;
        }
      }
      return clip.tags && clip.tags.some(tag => selectedTags.has(tag));
    });
  }

  // Remove duplicates
  currentClipList = filteredClips.filter((clip, index, self) =>
    index === self.findIndex((t) => t.originalName === clip.originalName)
  );

  // Sort by creation date
  currentClipList.sort((a, b) => b.createdAt - a.createdAt);

  renderClips(currentClipList);
  updateClipCounter(currentClipList.length);

  if (currentClip) {
    updateNavigationButtons();
  }
}

function parseSearchTerms(searchText) {
  const terms = searchText.split(/\s+/).filter(term => term.length > 0);
  return {
    // Get all terms that start with @ (tags)
    tags: terms.filter(term => term.startsWith('@')),
    // Get all other terms (regular search)
    text: terms.filter(term => !term.startsWith('@'))
  };
}

// Debounce function to limit how often the search is performed
function debounce(func, delay) {
  let debounceTimer;
  return function () {
    const context = this;
    const args = arguments;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => func.apply(context, args), delay);
  };
}

function setupContextMenu() {
  const contextMenu = document.getElementById("context-menu");
  const contextMenuExport = document.getElementById("context-menu-export");
  const contextMenuDelete = document.getElementById("context-menu-delete");
  const contextMenuTags = document.getElementById("context-menu-tags");
  const tagsDropdown = document.getElementById("tags-dropdown");
  const tagSearchInput = document.getElementById("tag-search-input");
  const addTagButton = document.getElementById("add-tag-button");

  if (
    !contextMenu ||
    !contextMenuExport ||
    !contextMenuDelete) {
    logger.error("One or more context menu elements not found");
    return;
  }

  document.addEventListener("click", (e) => {
    if (!contextMenu.contains(e.target)) {
      contextMenu.style.display = "none";
      isTagsDropdownOpen = false;
      tagsDropdown.style.display = "none";
    }
  });

  contextMenuExport.addEventListener("click", () => {
    logger.info("Export clicked for clip:", contextMenuClip?.originalName);
    if (contextMenuClip) {
      exportClipFromContextMenu(contextMenuClip);
    }
    contextMenu.style.display = "none";
  });

  contextMenuTags.addEventListener("click", (e) => {
    e.stopPropagation();
    isTagsDropdownOpen = !isTagsDropdownOpen;
    const tagsDropdown = document.getElementById("tags-dropdown");
    tagsDropdown.style.display = isTagsDropdownOpen ? "block" : "none";
    if (isTagsDropdownOpen) {
      const tagSearchInput = document.getElementById("tag-search-input");
      tagSearchInput.focus();
      updateTagList();
    }
  });

  addTagButton.addEventListener("click", () => {
    const tagSearchInput = document.getElementById("tag-search-input");
    const newTag = tagSearchInput.value.trim();
    if (newTag && !globalTags.includes(newTag)) {
      addGlobalTag(newTag);
      if (contextMenuClip) {
        toggleClipTag(contextMenuClip, newTag);
      }
      tagSearchInput.value = "";
      updateTagList();
    }
  });

  tagSearchInput.addEventListener("input", updateTagList);
  tagSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const searchTerm = tagSearchInput.value.trim().toLowerCase();
      
      // Find the closest matching tag
      const matchingTag = globalTags.find(tag => 
        tag.toLowerCase() === searchTerm ||
        tag.toLowerCase().startsWith(searchTerm)
      );
      
      if (matchingTag && contextMenuClip) {
        toggleClipTag(contextMenuClip, matchingTag);
        tagSearchInput.value = "";
        updateTagList();
      }
    }
  });

  tagsDropdown.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  contextMenuDelete.addEventListener("click", async () => {
    logger.info("Delete clicked for clip:", contextMenuClip?.originalName);
    if (contextMenuClip) {
      await confirmAndDeleteClip(contextMenuClip);
    }
    contextMenu.style.display = "none";
  });

  // Close context menu when clicking outside
  document.addEventListener("click", () => {
    contextMenu.style.display = "none";
  });
}

document.getElementById('manageTagsBtn').addEventListener('click', openTagManagement);

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
        ${globalTags.length === 0 ? 
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

  // Render initial tags
  renderTagList(globalTags);

  // Setup event listeners
  const searchInput = document.getElementById('tagManagementSearch');
  const closeBtn = document.getElementById('tagManagementCloseBtn');
  const addBtn = document.getElementById('tagManagementAddBtn');

  searchInput.addEventListener('input', (e) => {
    const searchTerm = e.target.value.toLowerCase();
    const filteredTags = globalTags.filter(tag => 
      tag.toLowerCase().includes(searchTerm)
    );
    renderTagList(filteredTags);
  });

  addBtn.addEventListener('click', () => {
    addNewTag();
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

  document.querySelectorAll('.tagManagement-deleteBtn').forEach(btn => {
    btn.addEventListener('click', handleTagDelete);
  });
}

function handleTagRename(e) {
  const input = e.target;
  const originalTag = input.dataset.original;
  const newTag = input.value.trim();

  if (newTag && newTag !== originalTag) {
    updateTag(originalTag, newTag);
  }
}

function handleTagDelete(e) {
  const item = e.target.closest('.tagManagement-item');
  const tag = item.dataset.tag;

  if (tag) {
    deleteTag(tag);
    item.remove();

    // Show no tags message if no tags left
    const listElement = document.getElementById('tagManagementList');
    if (listElement.children.length === 0) {
      listElement.innerHTML = '<div class="tagManagement-noTags">No tags found</div>';
    }
  }
}

function addNewTag() {
  const searchInput = document.getElementById('tagManagementSearch');
  const newTagName = searchInput.value.trim();

  if (newTagName && !globalTags.includes(newTagName)) {
    globalTags.push(newTagName);
    saveGlobalTags();
    
    // Automatically enable the new tag
    selectedTags.add(newTagName);
    saveTagPreferences();
    
    searchInput.value = '';
    renderTagList(globalTags);
    updateFilterDropdown();
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
    setTimeout(() => {
      modal.remove();
      document.removeEventListener('keydown', handleEscapeKey);
    }, 300);
  }
  isTagManagementOpen = false;
}

function updateTagList() {
  const tagList = document.getElementById("tag-list");
  const searchTerm = document.getElementById("tag-search-input").value.toLowerCase();
  
  let tagsToShow = [...globalTags];
  
  // Always include the "Private" tag
  if (!tagsToShow.includes("Private")) {
    tagsToShow.push("Private");
  }
  
  tagsToShow = tagsToShow.filter(tag => tag.toLowerCase().includes(searchTerm));
  
  // Sort tags by how closely they match the search term, but keep "Private" at the top
  tagsToShow.sort((a, b) => {
    if (a === "Private") return -1;
    if (b === "Private") return 1;
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
    checkbox.checked = contextMenuClip && contextMenuClip.tags && contextMenuClip.tags.includes(tag);
    checkbox.onclick = (e) => {
      e.stopPropagation();
      if (contextMenuClip) {
        toggleClipTag(contextMenuClip, tag);
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

async function deleteTag(tag) {
  const index = globalTags.indexOf(tag);
  if (index > -1) {
    globalTags.splice(index, 1);
    await saveGlobalTags();

    // Remove the tag from all clips
    allClips.forEach(clip => {
      const tagIndex = clip.tags.indexOf(tag);
      if (tagIndex > -1) {
        clip.tags.splice(tagIndex, 1);
        updateClipTags(clip);
        saveClipTags(clip);
      }
    });

    updateFilterDropdown();
  }
}

let globalTags = [];

function addGlobalTag(tag) {
  if (!globalTags.includes(tag)) {
    globalTags.push(tag);
    saveGlobalTags();
    
    // Automatically enable the new tag
    selectedTags.add(tag);
    saveTagPreferences();
    
    updateFilterDropdown();
    filterClips(); // Re-filter to show clips with the new tag
  }
}

async function loadGlobalTags() {
  try {
    globalTags = await ipcRenderer.invoke("load-global-tags");
  } catch (error) {
    logger.error("Error loading global tags:", error);
    globalTags = [];
  }
}

function saveGlobalTags() {
  ipcRenderer.invoke("save-global-tags", globalTags);
}

function updateTagList() {
  const tagList = document.getElementById("tag-list");
  const searchTerm = document.getElementById("tag-search-input").value.toLowerCase();
  
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
    checkbox.checked = contextMenuClip && contextMenuClip.tags && contextMenuClip.tags.includes(tag);
    checkbox.onclick = (e) => {
      e.stopPropagation();
      if (contextMenuClip) {
        toggleClipTag(contextMenuClip, tag);
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

function toggleClipTag(clip, tag) {
  if (!clip.tags) clip.tags = [];
  const index = clip.tags.indexOf(tag);
  const wasPrivate = clip.tags.includes("Private");
  
  if (index > -1) {
    clip.tags.splice(index, 1);
  } else {
    clip.tags.push(tag);
  }
  
  updateClipTags(clip);
  saveClipTags(clip);

  // Special handling for "Private" tag
  if (tag === "Private") {
    const currentFilter = document.getElementById("filter-dropdown").value;
    const clipElement = document.querySelector(`.clip-item[data-original-name="${clip.originalName}"]`);
    
    if (clipElement) {
      if (currentFilter === "all" && clip.tags.includes("Private")) {
        // Smoothly hide the clip if it's now private and we're showing all clips
        clipElement.style.transition = "opacity 0.3s, height 0.3s";
        clipElement.style.opacity = "0";
        clipElement.style.height = "0";
        setTimeout(() => {
          clipElement.style.display = "none";
        }, 300);
      } else if (currentFilter === "Private" && !clip.tags.includes("Private")) {
        // Smoothly hide the clip if it's no longer private and we're showing only private clips
        clipElement.style.transition = "opacity 0.3s, height 0.3s";
        clipElement.style.opacity = "0";
        clipElement.style.height = "0";
        setTimeout(() => {
          clipElement.style.display = "none";
        }, 300);
      } else if (wasPrivate !== clip.tags.includes("Private")) {
        // If the private status changed and it should be visible, ensure it's shown
        clipElement.style.display = "";
        clipElement.style.opacity = "1";
        clipElement.style.height = "";
      }
    }

    // Update the clip counter
    const visibleClips = document.querySelectorAll('.clip-item[style="display: none;"]').length;
    updateClipCounter(currentClipList.length - visibleClips);
  }
  
  updateFilterDropdown();
}

async function updateTag(originalTag, newTag) {
  if (originalTag === newTag) return; // No change, skip update

  const index = globalTags.indexOf(originalTag);
  if (index > -1) {
    globalTags[index] = newTag;
    await saveGlobalTags();

    // Update the tag in all clips
    allClips.forEach(clip => {
      const tagIndex = clip.tags.indexOf(originalTag);
      if (tagIndex > -1) {
        clip.tags[tagIndex] = newTag;
        updateClipTags(clip);
        saveClipTags(clip);
      }
    });

    // Update the filter dropdown
    updateFilterDropdown();

    // If the current filter is the original tag, update it to the new tag
    const filterDropdown = document.getElementById("filter-dropdown");
    if (filterDropdown.value === originalTag) {
      filterDropdown.value = newTag;
      filterClips(newTag);
    }

    logger.info(`Tag "${originalTag}" updated to "${newTag}"`);
  } else {
    logger.warn(`Tag "${originalTag}" not found in globalTags`);
  }
}

async function loadTagPreferences() {
  try {
    const savedTags = await ipcRenderer.invoke('get-tag-preferences');
    if (savedTags && savedTags.length > 0) {
      savedTagSelections = new Set(savedTags);
    } else {
      // Default to all tags visible, including "Untagged"
      savedTagSelections = new Set(['Untagged', ...globalTags]);
    }
    selectedTags = new Set(savedTagSelections); // Initialize global selectedTags
  } catch (error) {
    logger.error('Error loading tag preferences:', error);
    savedTagSelections = new Set(['Untagged', ...globalTags]);
    selectedTags = new Set(savedTagSelections);
  }
  
  updateFilterDropdown();
  filterClips();
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

async function saveClipTags(clip) {
  try {
    await ipcRenderer.invoke("save-clip-tags", clip.originalName, clip.tags);
  } catch (error) {
    logger.error("Error saving clip tags:", error);
  }
}

function truncateTag(tag, maxLength = 15) {
  if (tag.length <= maxLength) return tag;
  return tag.slice(0, maxLength - 1) + '..';
}

function setupTooltips() {
  document.querySelectorAll('.more-tags').forEach(moreTags => {
    const tooltip = moreTags.querySelector('.tags-tooltip');
    
    moreTags.addEventListener('mouseenter', () => {
      tooltip.style.display = 'flex';
      logger.info('Tooltip shown');
    });
    
    moreTags.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
      logger.info('Tooltip hidden');
    });
  });
}

function showContextMenu(e, clip) {
  e.preventDefault();
  e.stopPropagation();

  const contextMenu = document.getElementById("context-menu");
  const tagsDropdown = document.getElementById("tags-dropdown");

  if (contextMenu) {
    // Reset the context menu state
    contextMenu.style.display = "none";
    tagsDropdown.style.display = "none";
    isTagsDropdownOpen = false; 
    
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

    // Update the contextMenuClip
    contextMenuClip = clip;

    logger.info("Context menu shown for clip:", clip.originalName);
    
    // Update the tag list for the new clip
    updateTagList();
    
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

function closeContextMenu(e) {
  const contextMenu = document.getElementById("context-menu");
  const tagsDropdown = document.getElementById("tags-dropdown");
  const overlay = document.getElementById('context-menu-overlay');
  
  if (!contextMenu.contains(e.target)) {
    contextMenu.style.display = "none";
    tagsDropdown.style.display = "none";
    isTagsDropdownOpen = false;
    document.removeEventListener('click', closeContextMenu);
    if (overlay) {
      overlay.remove();
    }
  }
}

const toast = document.getElementById('export-toast');
const content = toast.querySelector('.export-toast-content');
const progressText = toast.querySelector('.export-progress-text');
const title = toast.querySelector('.export-title');

function showExportProgress(current, total) {
  if (!toast.classList.contains('show')) {
    toast.classList.add('show');
  }

  const percentage = Math.min(Math.round((current / total) * 100), 100);
  content.style.setProperty('--progress', `${percentage}%`);
  progressText.textContent = `${percentage}%`;

  if (percentage >= 100) {
    title.textContent = 'Export complete!';
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        title.textContent = 'Exporting...';
        content.style.setProperty('--progress', '0%');
        progressText.textContent = '0%';
      }, 300);
    }, 1000);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  settings = ipcRenderer.invoke('get-settings');
  fetchSettings();
  const settingsButton = document.getElementById("settingsButton");
  if (settingsButton) {
    settingsButton.addEventListener("click", openSettingsModal);
  } else {
    logger.error("Settings button not found");
  }

  const changeLocationBtn = document.getElementById("changeLocationBtn");
  const manageTagsBtn = document.getElementById("manageTagsBtn");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");

  if (changeLocationBtn) {
    changeLocationBtn.addEventListener("click", changeClipLocation);
  } else {
    logger.error("Change Location button not found");
  }

  if (manageTagsBtn) {
    manageTagsBtn.addEventListener("click", openTagManagement);
    logger.info("Manage Tags button listener added");
  } else {
    logger.error("Manage Tags button not found");
  }

  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener("click", closeSettingsModal);
  } else {
    logger.error("Close Settings button not found");
  }

  document.getElementById('importSteelSeriesBtn').addEventListener('click', async () => {
    try {
      const importBtn = document.getElementById('importSteelSeriesBtn');
      importBtn.disabled = true;
      importBtn.textContent = 'Importing...';
  
      const sourcePath = await ipcRenderer.invoke('open-folder-dialog-steelseries');
      if (!sourcePath) {
        importBtn.disabled = false;
        importBtn.textContent = 'Import SteelSeries Clips';
        return;
      }
  
      showExportProgress(0, 100);
  
      const progressHandler = (event, { current, total }) => {
        showExportProgress(current, total);
      };
  
      const logHandler = (event, { type, message }) => {
        logger.info(`[SteelSeries] ${message}`);
      };
  
      ipcRenderer.on('steelseries-progress', progressHandler);
      ipcRenderer.on('steelseries-log', logHandler);
  
      const result = await ipcRenderer.invoke('import-steelseries-clips', sourcePath);
  
      if (result.success) {
        // Add "Imported" to selectedTags if not already present
        if (!selectedTags.has("Imported")) {
          selectedTags.add("Imported");
          await saveTagPreferences();
        }
  
        await showCustomAlert('Import completed successfully!');
        // Reload clips to show new imports
        await loadClips();
        updateFilterDropdown(); // Update the dropdown with new tag
      } else {
        await showCustomAlert(`Import failed: ${result.error}`);
      }
  
      ipcRenderer.removeListener('steelseries-progress', progressHandler);
      ipcRenderer.removeListener('steelseries-log', logHandler);
  
    } catch (error) {
      logger.error('Error during SteelSeries import:', error);
      await showCustomAlert(`Import failed: ${error.message}`);
    } finally {
      const importBtn = document.getElementById('importSteelSeriesBtn');
      importBtn.disabled = false;
      importBtn.textContent = 'Import SteelSeries Clips';
    }
  });

  const titlebarOptions = {
    backgroundColor: TitlebarColor.fromHex("#1e1e1e"),
    menu: null,
    titleHorizontalAlignment: "center",
    unfocusEffect: false,
  };

  new Titlebar(titlebarOptions);

  loadClips();
  setupSearch();

  
  volumeSlider.addEventListener("input", (e) => {
    const newVolume = parseFloat(e.target.value);
    if (!audioContext) setupAudioContext();
    gainNode.gain.setValueAtTime(newVolume, audioContext.currentTime);
    updateVolumeSlider(newVolume);
    updateVolumeIcon(newVolume);
    
    if (currentClip) {
      debouncedSaveVolume(currentClip.originalName, newVolume);
    }
  });

  
  volumeButton.addEventListener("click", () => {
    volumeSlider.classList.toggle("collapsed");
    clearTimeout(volumeContainer.timeout);
  });
  
  volumeContainer.addEventListener("mouseenter", () => {
    clearTimeout(volumeContainer.timeout);
    volumeSlider.classList.remove("collapsed");
  });
  
  volumeContainer.addEventListener("mouseleave", () => {
    volumeContainer.timeout = setTimeout(() => {
      volumeSlider.classList.add("collapsed");
    }, 2000);
  });

  setupContextMenu();
  loadGlobalTags();

  const enableDiscordRPCCheckbox = document.getElementById('enableDiscordRPC');
  enableDiscordRPCCheckbox.addEventListener('change', (e) => {
    toggleDiscordRPC(e.target.checked);
  });

  // Create and setup the tag filter UI
  createTagFilterUI();
  // Load initial tag preferences
  await loadTagPreferences();

  updateDiscordPresence('Browsing clips', `Total clips: ${currentClipList.length}`);

  loadingScreen = document.getElementById('loading-screen');
});

async function saveSpeed(clipName, speed) {
  try {
    await ipcRenderer.invoke("save-speed", clipName, speed);
  } catch (error) {
    logger.error("Error saving speed:", error);
  }
}

async function loadSpeed(clipName) {
  try {
    const speed = await ipcRenderer.invoke("get-speed", clipName);
    logger.info(`Loaded speed for ${clipName}: ${speed}`);
    return speed;
  } catch (error) {
    logger.error("Error loading speed:", error);
    return 1;
  }
}

function changeSpeed(speed) {
  videoPlayer.playbackRate = speed;
  updateSpeedSlider(speed);
  updateSpeedText(speed);
  showSpeedContainer();
  
  if (currentClip) {
    debouncedSaveSpeed(currentClip.originalName, speed);
  }
}

function updateSpeedSlider(speed) {
  if (speedSlider) {
    speedSlider.value = speed;
  }
}

function updateSpeedText(speed) {
  let displaySpeed;
  if (Number.isInteger(speed)) {
    displaySpeed = `${speed}x`;
  } else if (speed * 10 % 1 === 0) {
    // This condition checks if the speed has only one decimal place
    displaySpeed = `${speed.toFixed(1)}x`;
  } else {
    displaySpeed = `${speed.toFixed(2)}x`;
  }
  speedText.textContent = displaySpeed;
}

function showSpeedContainer() {
  speedSlider.classList.remove("collapsed");
  
  clearTimeout(speedContainer.timeout);
  speedContainer.timeout = setTimeout(() => {
    speedSlider.classList.add("collapsed");
  }, 2000);
}

function showSpeedContainer() {
  speedSlider.classList.remove("collapsed");
  
  clearTimeout(speedContainer.timeout);
  speedContainer.timeout = setTimeout(() => {
    speedSlider.classList.add("collapsed");
  }, 2000);
}

const debouncedSaveSpeed = debounce(async (clipName, speed) => {
  try {
    await ipcRenderer.invoke("save-speed", clipName, speed);
    logger.info(`Speed saved for ${clipName}: ${speed}`);
  } catch (error) {
    logger.error('Error saving speed:', error);
  }
}, 300);

speedSlider.addEventListener("input", (e) => {
  const newSpeed = parseFloat(e.target.value);
  changeSpeed(newSpeed);
});

speedButton.addEventListener("click", () => {
  speedSlider.classList.toggle("collapsed");
  clearTimeout(speedContainer.timeout);
});

speedContainer.addEventListener("mouseenter", () => {
  clearTimeout(speedContainer.timeout);
  speedSlider.classList.remove("collapsed");
});

speedContainer.addEventListener("mouseleave", () => {
  speedContainer.timeout = setTimeout(() => {
    speedSlider.classList.add("collapsed");
  }, 2000);
});

function setupAudioContext() {
  if (audioContext) return; // If already set up, don't create a new context
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  gainNode = audioContext.createGain();
  const source = audioContext.createMediaElementSource(videoPlayer);
  source.connect(gainNode);
  gainNode.connect(audioContext.destination);
}

function changeVolume(delta) {
  if (!audioContext) setupAudioContext();
  
  const currentVolume = gainNode.gain.value;
  let newVolume = currentVolume + delta;
  
  newVolume = Math.round(newVolume * 100) / 100;
  newVolume = Math.min(Math.max(newVolume, 0), 2);
  
  gainNode.gain.setValueAtTime(newVolume, audioContext.currentTime);
  updateVolumeSlider(newVolume);
  updateVolumeIcon(newVolume);
  
  if (currentClip) {
    debouncedSaveVolume(currentClip.originalName, newVolume);
  }
  
  showVolumeContainer();
}

function updateVolumeSlider(volume) {
  const volumeSlider = document.getElementById("volume-slider");
  volumeSlider.value = volume;
  
  // Update visual feedback
  if (volume > 1) {
    volumeSlider.classList.add('boosted');
  } else {
    volumeSlider.classList.remove('boosted');
  }
  
  // Update volume button icon if needed
  updateVolumeIcon(volume);
}

function updateVolumeIcon(volume) {
  const volumeButton = document.getElementById("volume-button");
  if (volume === 0) {
    volumeButton.innerHTML = volumeIcons.muted;
  } else if (volume < 0.5) {
    volumeButton.innerHTML = volumeIcons.low;
  } else if (volume <= 1) {
    volumeButton.innerHTML = volumeIcons.normal; // We'll need to add this icon
  } else if (volume > 1) {
    volumeButton.innerHTML = volumeIcons.high;
  }
}

const debouncedSaveVolume = debounce(async (clipName, volume) => {
  try {
    await ipcRenderer.invoke("save-volume", clipName, volume);
    logger.info(`Volume saved for ${clipName}: ${volume}`);
  } catch (error) {
    logger.error('Error saving volume:', error);
  }
}, 300); // 300ms debounce time

async function saveVolume(clipName, volume) {
  try {
    await ipcRenderer.invoke("save-volume", clipName, volume);
  } catch (error) {
    logger.error("Error saving volume:", error);
  }
}

async function loadVolume(clipName) {
  try {
    const volume = await ipcRenderer.invoke("get-volume", clipName);
    logger.info(`Loaded volume for ${clipName}: ${volume}`);
    return volume;
  } catch (error) {
    logger.error("Error loading volume:", error);
    return 1; 
  }
}

function showVolumeContainer() {
  const volumeContainer = document.getElementById("volume-container");
  const volumeSlider = document.getElementById("volume-slider");
  
  volumeSlider.classList.remove("collapsed");
  
  clearTimeout(volumeContainer.timeout);
  volumeContainer.timeout = setTimeout(() => {
    volumeSlider.classList.add("collapsed");
  }, 2000); // Hide after 2 seconds
}

async function changeClipLocation() {
  const newLocation = await ipcRenderer.invoke("open-folder-dialog");
  if (newLocation) {
    try {
      await ipcRenderer.invoke("set-clip-location", newLocation);
      clipLocation = newLocation;
      currentClipLocationSpan.textContent = newLocation;
      await loadClips(); // Reload clips with the new location
    } catch (error) {
      logger.error("Error changing clip location:", error);
      await showCustomAlert(`Failed to change clip location: ${error.message}`);
    }
  }
}

const exportQualitySelect = document.getElementById('exportQuality');
exportQualitySelect.addEventListener('change', async (e) => {
  const newQuality = e.target.value;
  logger.info('Export quality changed to:', newQuality);
  
  try {
    // Update local settings first
    settings = {
      ...settings,
      exportQuality: newQuality
    };
    
    // Save settings and wait for completion
    const savedSettings = await ipcRenderer.invoke('save-settings', settings);
    
    // Update local settings with the returned saved settings
    settings = savedSettings;
    
    logger.info('Settings saved successfully:', settings);
  } catch (error) {
    logger.error('Error saving settings:', error);
    // Revert the select value if save failed
    e.target.value = settings.exportQuality;
    // Revert local settings
    settings = await fetchSettings();
  }
});

function initializeSettingsModal() {
  const settingsModal = document.getElementById('settingsModal');
  const tabs = document.querySelectorAll('.settings-tab');
  const tabContents = document.querySelectorAll('.settings-tab-content');

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      
      // Update active states
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      tab.classList.add('active');
      document.querySelector(`.settings-tab-content[data-tab="${targetTab}"]`).classList.add('active');
    });
  });

  // Preview volume slider
  const previewVolumeSlider = document.getElementById('previewVolumeSlider');
  const previewVolumeValue = document.getElementById('previewVolumeValue');

  previewVolumeSlider.addEventListener('input', (e) => {
    const value = Math.round(e.target.value * 100);
    previewVolumeValue.textContent = `${value}%`;
    updateAllPreviewVolumes(e.target.value);
  });

  // Settings controls event handlers
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettingsModal);
  document.getElementById('changeLocationBtn').addEventListener('click', changeClipLocation);
  document.getElementById('manageTagsBtn').addEventListener('click', () => {
    closeSettingsModal();
    openTagManagement();
  });

  // Export quality change handler
  document.getElementById('exportQuality').addEventListener('change', async (e) => {
    const newQuality = e.target.value;
    logger.info('Export quality changed to:', newQuality);
    
    try {
      settings = {
        ...settings,
        exportQuality: newQuality
      };
      
      const savedSettings = await ipcRenderer.invoke('save-settings', settings);
      settings = savedSettings;
      
      logger.info('Settings saved successfully:', settings);
    } catch (error) {
      logger.error('Error saving settings:', error);
      e.target.value = settings.exportQuality;
      settings = await fetchSettings();
    }
  });

  // Discord RPC toggle handler
  const discordRPCToggle = document.getElementById('enableDiscordRPC');
  discordRPCToggle.addEventListener('change', async (e) => {
    const isEnabled = e.target.checked;
    try {
      await toggleDiscordRPC(isEnabled);
      settings = {
        ...settings,
        enableDiscordRPC: isEnabled
      };
      await ipcRenderer.invoke('save-settings', settings);
    } catch (error) {
      logger.error('Error toggling Discord RPC:', error);
      e.target.checked = !isEnabled;
    }
  });
}

async function openSettingsModal() {
  logger.debug('Opening settings modal. Current settings:', settings);
  
  // Fetch fresh settings
  settings = await fetchSettings();
  logger.debug('Fresh settings fetched:', settings);
  
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) {
    settingsModal.style.display = 'block';
    
    // Update version display
    updateVersionDisplay();
    
    // Update clip location
    const currentClipLocation = document.getElementById('currentClipLocation');
    if (currentClipLocation) {
      currentClipLocation.textContent = clipLocation || 'Not set';
    }
    
    // Set control values from settings
    const enableDiscordRPCToggle = document.getElementById('enableDiscordRPC');
    const exportQualitySelect = document.getElementById('exportQuality');
    const previewVolumeSlider = document.getElementById('previewVolumeSlider');
    const previewVolumeValue = document.getElementById('previewVolumeValue');

    logger.debug('Setting controls with values:', {
      enableDiscordRPC: settings.enableDiscordRPC,
      exportQuality: settings.exportQuality,
      previewVolume: settings.previewVolume
    });

    if (enableDiscordRPCToggle) {
      enableDiscordRPCToggle.checked = Boolean(settings.enableDiscordRPC);
    }
    
    if (exportQualitySelect) {
      exportQualitySelect.value = settings.exportQuality || 'discord';
    }

    if (previewVolumeSlider && previewVolumeValue) {
      const savedVolume = settings.previewVolume ?? 0.1;
      previewVolumeSlider.value = savedVolume;
      previewVolumeValue.textContent = `${Math.round(savedVolume * 100)}%`;
    }

    // Set initial active tab
    const defaultTab = document.querySelector('.settings-tab[data-tab="general"]');
    if (defaultTab) {
      defaultTab.click();
    }
  }
}

function closeSettingsModal() {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) {
    // Add fade-out animation
    settingsModal.style.opacity = '0';
    setTimeout(() => {
      settingsModal.style.display = 'none';
      settingsModal.style.opacity = '1';
    }, 300);
  }
  
  // Save settings state
  updateSettings();
  
  // Update preview volumes
  const previewVolumeSlider = document.getElementById('previewVolumeSlider');
  if (previewVolumeSlider) {
    updateAllPreviewVolumes(parseFloat(previewVolumeSlider.value));
  }
}

document.getElementById('previewVolumeSlider').addEventListener('input', async (e) => {
  const value = parseFloat(e.target.value);
  // Round to 2 decimal places for display
  document.getElementById('previewVolumeValue').textContent = `${Math.round(value * 100)}%`;
  settings.previewVolume = value;
  await ipcRenderer.invoke('save-settings', settings);
  settings = await fetchSettings();
  // Update all currently playing preview videos
  updateAllPreviewVolumes(value);
});

async function updateSettings() {
  settings = await ipcRenderer.invoke('get-settings');
}

function updateAllPreviewVolumes(newVolume) {
  // Find all video elements inside clip-item elements
  const previewVideos = document.querySelectorAll('.clip-item video');
  previewVideos.forEach(video => {
    video.volume = newVolume;
  });
}

document
  .getElementById("settingsButton")
  .addEventListener("click", openSettingsModal);
closeSettingsBtn.addEventListener("click", closeSettingsModal);
document
  .getElementById("changeLocationBtn")
  .addEventListener("click", changeClipLocation);

// Add this function to calculate relative time
function getRelativeTimeString(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffInSeconds = Math.floor((now - date) / 1000);

  const intervals = [
    { label: "year", seconds: 31536000 },
    { label: "month", seconds: 2592000 },
    { label: "day", seconds: 86400 },
    { label: "hour", seconds: 3600 },
    { label: "minute", seconds: 60 },
    { label: "second", seconds: 1 },
  ];

  for (let i = 0; i < intervals.length; i++) {
    const interval = intervals[i];
    const count = Math.floor(diffInSeconds / interval.seconds);
    if (count >= 1) {
      return count === 1
        ? `1 ${interval.label} ago`
        : `${count} ${interval.label}s ago`;
    }
  }

  return "just now";
}

function createClipElement(clip) {
  return new Promise(async (resolve) => {
    const clipElement = document.createElement("div");
    clipElement.className = "clip-item";
    clipElement.dataset.originalName = clip.originalName;

    const contentElement = document.createElement("div");
    contentElement.className = "clip-item-content";

    let thumbnailPath = await ipcRenderer.invoke(
      "get-thumbnail-path",
      clip.originalName,
    );

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

    // Create the rest of the clip element structure
    clipElement.innerHTML = `
      ${mediaContainer.outerHTML}
      <div class="tag-container"></div>
      <div class="clip-info">
        <p class="clip-name" contenteditable="true">${clip.customName}</p>
        <p title="${new Date(clip.createdAt).toLocaleString()}">${relativeTime}</p>
      </div>
    `;

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

    function cleanupVideoPreview() {
      // Clear the timeout if it exists
      if (previewCleanupTimeout) {
        clearTimeout(previewCleanupTimeout);
        previewCleanupTimeout = null;
      }
    
      // Reset active preview
      activePreview = null;
    
      // Clean up video element if it exists
      if (videoElement) {
        videoElement.pause();
        videoElement.removeAttribute('src');
        videoElement.load();
        videoElement.remove();
        videoElement = null;
    
        // Restore thumbnail visibility
        const imgElement = clipElement.querySelector(".clip-item-media-container img");
        if (imgElement) {
          imgElement.style.display = "";
        }
      }
    }

    async function handleMouseEnter() {
      if (clipElement.classList.contains("video-preview-disabled")) return;
    
      // Clear any existing preview immediately
      cleanupVideoPreview();
    
      // Store the current preview context
      const currentPreviewContext = {};
      activePreview = currentPreviewContext;
    
      // Set a small delay before creating the preview
      previewCleanupTimeout = setTimeout(async () => {
        // Check if this preview is still the active one
        if (activePreview !== currentPreviewContext) return;
    
        try {
          const trimData = await ipcRenderer.invoke("get-trim", clip.originalName);
          const clipInfo = await ipcRenderer.invoke("get-clip-info", clip.originalName);
          
          // Check again if this preview is still active
          if (activePreview !== currentPreviewContext) return;
    
          let startTime;
          if (trimData) {
            startTime = trimData.start;
          } else {
            startTime = clipInfo.format.duration > 40 ? clipInfo.format.duration / 2 : 0;
          }
    
          // Final check before creating video element
          if (activePreview !== currentPreviewContext) return;
    
          // Get the current preview volume setting
          const currentPreviewVolume = document.getElementById('previewVolumeSlider')?.value ?? settings?.previewVolume ?? 0.1;
    
          videoElement = document.createElement("video");
          videoElement.src = `file://${path.join(clipLocation, clip.originalName)}`;
          videoElement.volume = currentPreviewVolume;
          videoElement.loop = true;
          videoElement.preload = "metadata";
          videoElement.style.zIndex = "1";
    
          const mediaContainer = clipElement.querySelector(".clip-item-media-container");
          const imgElement = mediaContainer.querySelector("img");
          
          // Set the video poster to the current thumbnail
          videoElement.poster = imgElement.src;
    
          // Store video element in the preview context
          currentPreviewContext.videoElement = videoElement;
    
          // Add loadedmetadata event listener
          videoElement.addEventListener('loadedmetadata', () => {
            // Final check before playing
            if (activePreview !== currentPreviewContext || !clipElement.matches(':hover')) {
              cleanupVideoPreview();
              return;
            }
    
            imgElement.style.display = "none";
            videoElement.currentTime = startTime;
            videoElement.play().catch((error) => {
              if (error.name !== "AbortError") {
                logger.error("Error playing video:", error);
              }
              cleanupVideoPreview();
            });
          });
    
          mediaContainer.appendChild(videoElement);
        } catch (error) {
          logger.error("Error setting up preview:", error);
          cleanupVideoPreview();
        }
      }, 100);
    }

    function handleMouseLeave() {
      if (clipElement.classList.contains("video-preview-disabled")) return;
      cleanupVideoPreview();
    }

    clipElement.handleMouseEnter = handleMouseEnter;
    clipElement.addEventListener("mouseenter", handleMouseEnter);
    clipElement.addEventListener("mouseleave", handleMouseLeave);

    clipElement.addEventListener("click", (e) => handleClipClick(e, clip));

    clipElement.addEventListener("mousemove", handleOnMouseMove);

    clipElement.addEventListener("contextmenu", (e) => {
      e.preventDefault(); // Prevent the default context menu
      showContextMenu(e, clip);
    });
    clipElement.appendChild(contentElement);

    clipElement.cleanup = () => {
      cleanupVideoPreview();
      clipElement.removeEventListener("mouseenter", handleMouseEnter);
      clipElement.removeEventListener("mouseleave", handleMouseLeave);
    };

    resolve(clipElement);
  });
}

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
  if (selectedClips.size > 0) {
    clearSelection();
    return;
  }

  // Otherwise, open the clip
  openClip(clip.originalName, clip.customName);
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

const exportButton = document.getElementById("export-button");
const deleteButton = document.getElementById("delete-button");

deleteButton.addEventListener("click", () => confirmAndDeleteClip());
exportButton.addEventListener("click", (e) => {
  if (e.ctrlKey && e.shiftKey) {
    exportAudioWithFileSelection();
  } else if (e.ctrlKey) {
    exportVideoWithFileSelection();
  } else if (e.shiftKey) {
    exportAudioToClipboard();
  } else {
    exportTrimmedVideo();
  }
});

ipcRenderer.on("close-video-player", () => {
  if (videoPlayer) {
    videoPlayer.pause();
    videoPlayer.src = "";
    videoPlayer.load();
  }
});

function updateNavigationButtons() {
  const currentIndex = currentClipList.findIndex(clip => clip.originalName === currentClip.originalName);
  document.getElementById('prev-video').disabled = currentIndex <= 0;
  document.getElementById('next-video').disabled = currentIndex >= currentClipList.length - 1;
}

function pauseVideoIfPlaying() {
  if (!videoPlayer.paused) {
    videoPlayer.pause();
  }
}

function navigateToVideo(direction) {
  const currentIndex = currentClipList.findIndex(clip => clip.originalName === currentClip.originalName);
  const newIndex = currentIndex + direction;
  if (newIndex >= 0 && newIndex < currentClipList.length) {
    const nextClip = currentClipList[newIndex];
    openClip(nextClip.originalName, nextClip.customName);
  }
}

document.getElementById('prev-video').addEventListener('click', (e) => {
  e.stopPropagation();
  navigateToVideo(-1);
});

document.getElementById('next-video').addEventListener('click', (e) => {
  e.stopPropagation();
  navigateToVideo(1);
});

async function confirmAndDeleteClip(clipToDelete = null) {
  if (!clipToDelete && !currentClip) return;
  
  const clipInfo = clipToDelete || currentClip;
  
  const isConfirmed = await showCustomConfirm(`Are you sure you want to delete "${clipInfo.customName}"? This action cannot be undone.`);

  if (isConfirmed) {
    // Immediately remove the clip from UI
    const clipElement = document.querySelector(`.clip-item[data-original-name="${clipInfo.originalName}"]`);
    if (clipElement) {
      clipElement.remove();
    }

    // Remove from allClips and currentClipList
    const allClipsIndex = allClips.findIndex(clip => clip.originalName === clipInfo.originalName);
    const currentClipListIndex = currentClipList.findIndex(clip => clip.originalName === clipInfo.originalName);
    
    if (allClipsIndex > -1) allClips.splice(allClipsIndex, 1);
    if (currentClipListIndex > -1) currentClipList.splice(currentClipListIndex, 1);

    try {
      // Close the player if we're deleting the current clip
      if (currentClip && currentClip.originalName === clipInfo.originalName) {
        closePlayer();
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
        clipGrid.appendChild(clipElement);
      }
      
      // Revert data changes
      if (allClipsIndex > -1) allClips.splice(allClipsIndex, 0, clipInfo);
      if (currentClipListIndex > -1) currentClipList.splice(currentClipListIndex, 0, clipInfo);
    } finally {
      // Hide deletion tooltip
      hideDeletionTooltip();
    }

    updateClipCounter(currentClipList.length);
  }
}

function showDeletionTooltip() {
  if (!deletionTooltip) {
    deletionTooltip = document.createElement('div');
    deletionTooltip.className = 'deletion-tooltip';
    deletionTooltip.textContent = 'Deleting files...';
    document.body.appendChild(deletionTooltip);
  }
  
  // Force a reflow to ensure the initial state is applied
  deletionTooltip.offsetHeight;
  
  deletionTooltip.classList.add('show');
  
  if (deletionTimeout) {
    clearTimeout(deletionTimeout);
  }
  
  deletionTimeout = setTimeout(() => {
    hideDeletionTooltip();
  }, 5000);
}

function hideDeletionTooltip() {
  if (deletionTooltip) {
    deletionTooltip.classList.remove('show');
  }
  if (deletionTimeout) {
    clearTimeout(deletionTimeout);
    deletionTimeout = null;
  }
}

function disableVideoThumbnail(clipName) {
  const clipElement = document.querySelector(
    `.clip-item[data-original-name="${clipName}"]`,
  );
  if (!clipElement) return;

  // Remove the video element if it exists
  const videoElement = clipElement.querySelector("video");
  if (videoElement) {
    videoElement.remove();
  }

  // Remove event listeners that trigger video preview
  clipElement.removeEventListener(
    "mouseenter",
    clipElement.videoPreviewHandler,
  );
  clipElement.removeEventListener(
    "mouseleave",
    clipElement.videoPreviewHandler,
  );

  // Add a class to indicate that video preview is disabled
  clipElement.classList.add("video-preview-disabled");

  // Add a visual indicator that the clip is being deleted
  const deletingIndicator = document.createElement("div");
  deletingIndicator.className = "deleting-indicator";
  deletingIndicator.textContent = "Deleting...";
  clipElement.appendChild(deletingIndicator);
}

function handleFullscreenMouseLeave() {
  if (document.fullscreenElement) {
    hideControls();
  }
}

document.addEventListener('mouseleave', handleFullscreenMouseLeave);

function handleFullscreenChange() {
  const fullscreenPlayer = document.getElementById('fullscreen-player');
  
  if (document.fullscreenElement) {
    fullscreenPlayer.classList.add('custom-fullscreen');
    document.addEventListener('mousemove', handleFullscreenMouseMove);
  } else {
    fullscreenPlayer.classList.remove('custom-fullscreen');
    document.removeEventListener('mousemove', handleFullscreenMouseMove);
    fullscreenPlayer.style.top = '50%';
    fullscreenPlayer.style.left = '50%';
    fullscreenPlayer.style.transform = 'translate(-50%, -50%)';
  }
  
  resetControlsTimeout();
}

function handleFullscreenMouseMove(e) {
  if (e.clientY >= window.innerHeight - 1) {
    hideControlsInstantly();
  } else {
    resetControlsTimeout();
  }
}

document.addEventListener('fullscreenchange', handleFullscreenChange);

function toggleFullscreen() {
  const fullscreenPlayer = document.getElementById('fullscreen-player');
  
  if (!document.fullscreenElement) {
    if (fullscreenPlayer.requestFullscreen) {
      fullscreenPlayer.requestFullscreen();
    } else if (fullscreenPlayer.mozRequestFullScreen) {
      fullscreenPlayer.mozRequestFullScreen();
    } else if (fullscreenPlayer.webkitRequestFullscreen) {
      fullscreenPlayer.webkitRequestFullscreen();
    } else if (fullscreenPlayer.msRequestFullscreen) {
      fullscreenPlayer.msRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }
  }
  
  // Reset control visibility
  showControls();
  resetControlsTimeout();
}

document
  .getElementById("fullscreen-button")
  .addEventListener("click", toggleFullscreen);

function isVideoInFullscreen(videoElement) {
  return (
    document.fullscreenElement === videoElement ||
    document.webkitFullscreenElement === videoElement || // for Safari
    document.mozFullScreenElement === videoElement || // for Firefox
    document.msFullscreenElement === videoElement // for IE/Edge
  );
}

async function exportVideoWithFileSelection() {
  if (!currentClip) return;
  const savePath = await ipcRenderer.invoke("open-save-dialog", "video");
  if (savePath) {
    await exportVideo(savePath);
  }
}

async function exportAudioWithFileSelection() {
  if (!currentClip) return;
  const savePath = await ipcRenderer.invoke("open-save-dialog", "audio");
  if (savePath) {
    await exportAudio(savePath);
  }
}

async function exportAudioToClipboard() {
  if (!currentClip) return;
  await exportAudio();
}

async function exportVideo(savePath = null) {
  try {
    const volume = await loadVolume(currentClip.originalName);
    const speed = videoPlayer.playbackRate;
    const result = await ipcRenderer.invoke(
      "export-video",
      currentClip.originalName,
      trimStartTime,
      trimEndTime,
      volume,
      speed,
      savePath
    );
    if (result.success) {
      logger.info("Video exported successfully:", result.path);
      showExportProgress(100, 100); // Show completion
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting video:", error);
    showCustomAlert("Export failed: " + error.message);
  }
}

ipcRenderer.on('show-fallback-notice', () => {
  showFallbackNotice();
});

function showFallbackNotice() {
  const notice = document.createElement('div');
  notice.className = 'fallback-notice';
  notice.innerHTML = `
    <p>Your video is being exported using software encoding, which may be slower.</p>
    <p>For faster exports, consider installing NVIDIA CUDA Runtime and updated graphics drivers.</p>
    <button id="close-notice">Close</button>
  `;
  document.body.appendChild(notice);

  document.getElementById('close-notice').addEventListener('click', () => {
    notice.remove();
  });
}

async function exportAudio(savePath = null) {
  try {
    const volume = await loadVolume(currentClip.originalName);
    const speed = videoPlayer.playbackRate;
    const result = await ipcRenderer.invoke(
      "export-audio",
      currentClip.originalName,
      trimStartTime,
      trimEndTime,
      volume,
      speed,
      savePath
    );
    if (result.success) {
      logger.info("Audio exported successfully:", result.path);
      showExportProgress(100, 100); // Show completion
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting audio:", error);
    showCustomAlert("Audio export failed: " + error.message);
  }
}

ipcRenderer.on('ffmpeg-error', (event, message) => {
  logger.error('FFmpeg Error:', message);
});

async function exportTrimmedVideo() {
  if (!currentClip) return;

  try {
    await getFfmpegVersion();
    const volume = await loadVolume(currentClip.originalName);
    const speed = videoPlayer.playbackRate;
    logger.info(`Exporting video: ${currentClip.originalName}`);
    logger.info(`Trim start: ${trimStartTime}, Trim end: ${trimEndTime}`);
    logger.info(`Volume: ${volume}, Speed: ${speed}`);

    showExportProgress(0, 100); // Show initial progress

    const result = await ipcRenderer.invoke(
      "export-trimmed-video",
      currentClip.originalName,
      trimStartTime,
      trimEndTime,
      volume,
      speed
    );

    if (result.success) {
      logger.info("Trimmed video exported successfully:", result.path);
      showExportProgress(100, 100); // Show completion
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting video:", error);
    logger.error("Error details:", error.stack);
    await showCustomAlert(`Export failed: ${error.message}. Please check the console for more details.`);
  }
}

async function exportClipFromContextMenu(clip) {
  try {
    const clipInfo = await ipcRenderer.invoke("get-clip-info", clip.originalName);
    const trimData = await ipcRenderer.invoke("get-trim", clip.originalName);
    const start = trimData ? trimData.start : 0;
    const end = trimData ? trimData.end : clipInfo.format.duration;
    const volume = await loadVolume(clip.originalName);
    const speed = await loadSpeed(clip.originalName);

    showExportProgress(0, 100); // Show initial progress

    const result = await ipcRenderer.invoke(
      "export-trimmed-video",
      clip.originalName,
      start,
      end,
      volume,
      speed
    );
    if (result.success) {
      logger.info("Clip exported successfully:", result.path);
      showExportProgress(100, 100); // Show completion
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error("Error exporting clip:", error);
    await showCustomAlert(`Failed to export clip. Error: ${error.message}`);
  }
}

ipcRenderer.on("export-progress", (event, progress) => {
  showExportProgress(progress, 100);
});

const currentTimeDisplay = document.getElementById("current-time");
const totalTimeDisplay = document.getElementById("total-time");

function updateTimeDisplay() {
  currentTimeDisplay.textContent = formatDuration(videoPlayer.currentTime);
  totalTimeDisplay.textContent = formatDuration(videoPlayer.duration);
}

videoPlayer.addEventListener("loadedmetadata", updateTimeDisplay);
videoPlayer.addEventListener("timeupdate", updateTimeDisplay);

async function openClip(originalName, customName) {
  logger.info(`Opening clip: ${originalName}`);
  elapsedTime = 0;
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }

  initializeVolumeControls();
  loadingOverlay.style.display = "none";

  // Create or get thumbnail overlay
  let thumbnailOverlay = document.getElementById('thumbnail-overlay');
  if (!thumbnailOverlay) {
    thumbnailOverlay = document.createElement('img');
    thumbnailOverlay.id = 'thumbnail-overlay';
    thumbnailOverlay.style.position = 'absolute';
    thumbnailOverlay.style.top = '0';
    thumbnailOverlay.style.left = '0';
    thumbnailOverlay.style.width = '100%';
    thumbnailOverlay.style.height = '100%';
    thumbnailOverlay.style.objectFit = 'contain';
    videoPlayer.parentElement.appendChild(thumbnailOverlay);
  }

  // Hide video and show thumbnail
  videoPlayer.style.opacity = '0';
  const thumbnailPath = await ipcRenderer.invoke("get-thumbnail-path", originalName);
  if (thumbnailPath) {
    thumbnailOverlay.src = `file://${thumbnailPath}`;
    thumbnailOverlay.style.display = 'block';
  }

  // Load all data first before setting up video
  let clipInfo, trimData, clipTags;
  try {
    [clipInfo, trimData, clipTags] = await Promise.all([
      ipcRenderer.invoke("get-clip-info", originalName),
      ipcRenderer.invoke("get-trim", originalName),
      ipcRenderer.invoke("get-clip-tags", originalName)
    ]);
  } catch (error) {
    logger.error("Error loading clip data:", error);
    return;
  }

  currentClip = { originalName, customName, tags: clipTags };

  // Set up trim points before video loads
  if (trimData) {
    trimStartTime = trimData.start;
    trimEndTime = trimData.end;
    initialPlaybackTime = trimData.start;
  } else {
    trimStartTime = 0;
    trimEndTime = clipInfo.format.duration;
    initialPlaybackTime = clipInfo.format.duration > 40 ? clipInfo.format.duration / 2 : 0;
  }

  // Create a promise to handle video loading
  const videoLoadPromise = new Promise((resolve) => {
    const loadHandler = () => {
      updateTrimControls();
      videoPlayer.currentTime = initialPlaybackTime;
      videoPlayer.removeEventListener('loadedmetadata', loadHandler);
      resolve();
    };
    videoPlayer.addEventListener('loadedmetadata', loadHandler);
  });

  // Set video source
  videoPlayer.src = `file://${clipInfo.format.filename}`;

  // Wait for video to load
  await videoLoadPromise;

  await loadVolumeData();

  // Show video and play when ready
  videoPlayer.addEventListener('seeked', () => {
    videoPlayer.style.opacity = '1';
    thumbnailOverlay.style.display = 'none';
    videoPlayer.play();
  }, { once: true });

  logger.info(`Final trim values set - start: ${trimStartTime}, end: ${trimEndTime}`);

  clipTitle.value = customName;

  // Load and set the volume before playing the video
  try {
    const savedVolume = await loadVolume(originalName);
    logger.info(`Loaded volume for ${originalName}: ${savedVolume}`);
    setupAudioContext();
    gainNode.gain.setValueAtTime(savedVolume, audioContext.currentTime);
    updateVolumeSlider(savedVolume);
  } catch (error) {
    logger.error('Error loading volume:', error);
    setupAudioContext();
    gainNode.gain.setValueAtTime(1, audioContext.currentTime);
    updateVolumeSlider(1); // Default to 100%
  }

  try {
    const savedSpeed = await loadSpeed(originalName);
    logger.info(`Loaded speed for ${originalName}: ${savedSpeed}`);
    videoPlayer.playbackRate = savedSpeed;
    updateSpeedSlider(savedSpeed);
    updateSpeedText(savedSpeed);
  } catch (error) {
    logger.error('Error loading speed:', error);
    videoPlayer.playbackRate = 1;
    updateSpeedSlider(1);
    updateSpeedText(1);
  }

  playerOverlay.style.display = "block";
  fullscreenPlayer.style.display = "block";

  document.addEventListener("keydown", handleKeyPress);
  document.addEventListener("keyup", handleKeyRelease);

  // Update the clip duration in the allClips array
  const clipIndex = allClips.findIndex(
    (clip) => clip.originalName === originalName,
  );
  if (clipIndex !== -1) {
    allClips[clipIndex].duration = clipInfo.format.duration;
  }

  showLoadingOverlay();

  videoPlayer.addEventListener("loadedmetadata", async () => {
    updateTrimControls();
    videoPlayer.currentTime = initialPlaybackTime;
  }, { once: true });
  videoPlayer.addEventListener("canplay", handleVideoCanPlay);
  videoPlayer.addEventListener("progress", updateLoadingProgress);
  videoPlayer.addEventListener("waiting", showLoadingOverlay);
  videoPlayer.addEventListener("playing", hideLoadingOverlay);
  videoPlayer.addEventListener("seeked", handleVideoSeeked);

  setupClipTitleEditing();

  playerOverlay.addEventListener("click", handleOverlayClick);

  const videoContainer = document.getElementById("video-container");
  const videoControls = document.getElementById("video-controls");

  function resetControlsTimeout() {
    showControls();
    clearTimeout(controlsTimeout);
    if (!videoPlayer.paused && !document.activeElement.closest('#video-controls')) {
      controlsTimeout = setTimeout(hideControls, 3000);
    }
  }

  function handleMouseMove(e) {
    // Only respond to actual mouse movements
    if (e.movementX !== 0 || e.movementY !== 0) {
      resetControlsTimeout();
    }
  }

  videoContainer.addEventListener("mousemove", handleMouseMove);
  videoContainer.addEventListener("mouseenter", () => {
    showControls();
  });
  videoContainer.addEventListener("mouseleave", () => {
    isMouseOverControls = false;
    if (!videoPlayer.paused && !document.activeElement.closest('#video-controls')) {
      controlsTimeout = setTimeout(hideControls, 3000);
    }
  });

  videoPlayer.addEventListener('ended', () => {
    videoPlayer.pause();
    isPlaying = false;
    videoPlayer.currentTime = trimStartTime;
  });

  videoPlayer.addEventListener('pause', () => {
    showControls();
    if (currentClip) {
      updateDiscordPresenceForClip(currentClip, false);
    }
  });
  videoPlayer.addEventListener("play", () => {
    if (currentClip) {
      updateDiscordPresenceForClip(currentClip, true);
    }
    showControls();
    controlsTimeout = setTimeout(hideControls, 3000);
    resetControlsTimeout();
  });

  videoControls.addEventListener("mouseenter", () => {
    isMouseOverControls = true;
    showControls();
  });

  videoControls.addEventListener("mouseleave", () => {
    isMouseOverControls = false;
    if (!videoPlayer.paused) {
      controlsTimeout = setTimeout(hideControls, 3000);
    }
  });

  // Add this for all interactive elements within the controls
  const interactiveElements = videoControls.querySelectorAll('button, input, #clip-title');
  interactiveElements.forEach(element => {
    element.addEventListener('focus', () => {
      clearTimeout(controlsTimeout);
      showControls();
    });
  
    element.addEventListener('blur', (e) => {
      // Only hide controls if we're not focusing another interactive element
      if (!e.relatedTarget || !videoControls.contains(e.relatedTarget)) {
        if (!videoPlayer.paused && !isMouseOverControls) {
          controlsTimeout = setTimeout(hideControls, 3000);
        }
      }
    });
  });

  updateNavigationButtons();

  // Clean up function to remove event listeners
  currentCleanup = () => {
    document.removeEventListener("keydown", handleKeyPress);
    document.removeEventListener("keyup", handleKeyRelease);
    videoPlayer.removeEventListener("canplay", handleVideoCanPlay);
    videoPlayer.removeEventListener("progress", updateLoadingProgress);
    videoPlayer.removeEventListener("waiting", showLoadingOverlay);
    videoPlayer.removeEventListener("playing", hideLoadingOverlay);
    videoPlayer.removeEventListener("seeked", handleVideoSeeked);
    playerOverlay.removeEventListener("click", handleOverlayClick);
  };

  updateDiscordPresenceForClip({ originalName, customName, tags: clipTags }, false); // Start paused
}

const videoControls = document.getElementById("video-controls");

function showControls() {
  videoControls.style.transition = 'none';
  videoControls.classList.add("visible");
}

function hideControls() {
  if (!videoPlayer.paused && !isMouseOverControls && !document.activeElement.closest('#video-controls')) {
    videoControls.style.transition = 'opacity 0.5s';
    videoControls.classList.remove("visible");
  }
}

// Add this new function to handle overlay clicks
function handleOverlayClick(e) {
  if (e.target === playerOverlay && !window.justFinishedDragging) {
    closePlayer();
  }
}

function handleMouseLeave(e) {
  // Check if the mouse has truly left the window/document
  if (e.clientY <= 0 || e.clientX <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
    hideControlsInstantly();
  }
}

// Add this event listener to the document
document.addEventListener('mouseleave', handleMouseLeave);

function hideControlsInstantly() {
  videoControls.classList.remove("visible");
  clearTimeout(controlsTimeout);
}

function handleVideoSeeked() {
  if (currentClip) {
    elapsedTime = Math.floor(videoPlayer.currentTime);
    // Check if the clip is private before updating Discord presence
    logger.info('Current clip:', currentClip.tags);
    if (!currentClip.tags || !currentClip.tags.includes('Private')) {
      updateDiscordPresenceForClip(currentClip, !videoPlayer.paused);
    }
  }
}

function handleVideoCanPlay() {
  if (isLoading) {
    isLoading = false;
    hideLoadingOverlay();
    videoPlayer.currentTime = initialPlaybackTime;
  }
}

function updateLoadingProgress() {
  if (videoPlayer.buffered.length > 0) {
    const loadedPercentage =
      (videoPlayer.buffered.end(0) / videoPlayer.duration) * 100;
    progressBar.style.backgroundImage = `linear-gradient(to right, #c2c2c2 ${loadedPercentage}%, #3a3a3a ${loadedPercentage}%)`;
  }
}

function showLoadingOverlay() {
  loadingOverlay.style.display = "flex";
}

function hideLoadingOverlay() {
  loadingOverlay.style.display = "none";
}

function setupClipTitleEditing() {
  clipTitle.removeEventListener("focus", clipTitleFocusHandler);
  clipTitle.removeEventListener("blur", clipTitleBlurHandler);
  clipTitle.removeEventListener("keydown", clipTitleKeydownHandler);
  clipTitle.removeEventListener("input", clipTitleInputHandler);

  clipTitle.addEventListener("focus", clipTitleFocusHandler);
  clipTitle.addEventListener("blur", clipTitleBlurHandler);
  clipTitle.addEventListener("keydown", clipTitleKeydownHandler);
  clipTitle.addEventListener("input", clipTitleInputHandler);
}

function clipTitleInputHandler() {
  if (currentClip) {
    saveTitleChange(
      currentClip.originalName,
      currentClip.customName,
      clipTitle.value,
      false,
    );
  }
}

function clipTitleFocusHandler() {
  isRenamingActive = true;

  clipTitle.dataset.originalValue = clipTitle.value;
  updateDiscordPresence('Editing clip title', currentClip.customName);
  logger.info(
    "Clip title focused. Original value:",
    clipTitle.dataset.originalValue,
  );
}

function clipTitleBlurHandler() {
  isRenamingActive = false;
  if (currentClip) {
    saveTitleChange(
      currentClip.originalName,
      currentClip.customName,
      clipTitle.value,
      false,
    );
  }
}

function clipTitleKeydownHandler(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    clipTitle.blur();
  }
}

function closePlayer() {
  if (window.justFinishedDragging) {
    return; // Don't close the player if we just finished dragging
  }
  if (saveTitleTimeout) {
    clearTimeout(saveTitleTimeout);
    saveTitleTimeout = null;
    document.removeEventListener("keydown", handleKeyPress);
    document.removeEventListener("keyup", handleKeyRelease);
  }

  // Capture necessary information before resetting currentClip
  const originalName = currentClip ? currentClip.originalName : null;
  const oldCustomName = currentClip ? currentClip.customName : null;
  const newCustomName = clipTitle.value;

  // Save any pending changes immediately
  saveTitleChange(originalName, oldCustomName, newCustomName, true).then(() => {
    playerOverlay.style.display = "none";
    fullscreenPlayer.style.display = "none";
    videoPlayer.pause();
    videoPlayer.removeEventListener("canplay", handleVideoCanPlay);
    videoPlayer.removeEventListener("progress", updateLoadingProgress);
    videoPlayer.removeEventListener("waiting", showLoadingOverlay);
    videoPlayer.removeEventListener("playing", hideLoadingOverlay);
    videoPlayer.removeEventListener("seeked", handleVideoSeeked);
    videoPlayer.src = "";

    clipTitle.removeEventListener("focus", clipTitleFocusHandler);
    clipTitle.removeEventListener("blur", clipTitleBlurHandler);
    clipTitle.removeEventListener("keydown", clipTitleKeydownHandler);
    clipTitle.removeEventListener("input", clipTitleInputHandler);

    playerOverlay.removeEventListener("click", handleOverlayClick);

    const clipTitleElement = document.getElementById("clip-title");
    if (clipTitleElement) {
      clipTitleElement.value = "";
    }

    // Update the clip's display in the grid if we have the original name
    if (originalName) {
      updateClipDisplay(originalName);
    }

    // Reset current clip
    currentClip = null;
    if (currentCleanup) {
      currentCleanup();
      currentCleanup = null;
    }
  });

  clearInterval(discordPresenceInterval);
  updateDiscordPresence('Browsing clips', `Total: ${currentClipList.length}`);
}

// Make sure this event listener is present on the fullscreenPlayer
fullscreenPlayer.addEventListener("click", (e) => {
  e.stopPropagation();
});

playerOverlay.addEventListener("click", closePlayer);

function handleKeyRelease(e) {
  if (e.key === "," || e.key === ".") {
    isFrameStepping = false;
    frameStepDirection = 0;
  }
}

function handleKeyPress(e) {
  const isClipTitleFocused = document.activeElement === clipTitle;
  const isSearching = document.activeElement === document.getElementById("search-input");
  const isPlayerActive = playerOverlay.style.display === "block";

  if (!isPlayerActive) return;

  showControls();

  if (e.key === "Escape") {
    closePlayer();
  }
  if (e.key === " " && !isClipTitleFocused && !isSearching) {
    if (videoPlayer.src) {
      e.preventDefault();
      togglePlayPause();
    }
  }

  // New keybinds
  if (!isClipTitleFocused && !isSearching) {
    switch (e.key) {
      case ",":
      case ".":
        e.preventDefault();
        moveFrame(e.key === "," ? -1 : 1);
        break;
        case "ArrowLeft":
          case "ArrowRight":
              e.preventDefault();
              if (e.ctrlKey) {
                  navigateToVideo(e.key === "ArrowLeft" ? -1 : 1);
              } else {
                  skipTime(e.key === "ArrowLeft" ? -1 : 1);
              }
              break;
      case "ArrowUp":
        case "ArrowDown":
          e.preventDefault();
          changeVolume(e.key === "ArrowUp" ? 0.1 : -0.1);
          break;
      case "e":
      case "E":
        e.preventDefault();
        if (e.ctrlKey && e.shiftKey) {
          exportAudioWithFileSelection();
        } else if (e.ctrlKey) {
          exportVideoWithFileSelection();
        } else if (e.shiftKey) {
          exportAudioToClipboard();
        } else {
          exportTrimmedVideo();
        }
        break;
      case "f":
      case "F":
        toggleFullscreen();
        break;
      case "Delete":
        e.preventDefault();
        confirmAndDeleteClip();
        break;
      case "[":
        e.preventDefault();
        setTrimPoint("start");
        break;
      case "]":
        e.preventDefault();
        setTrimPoint("end");
        break;
      case "Tab":
        e.preventDefault();
        clipTitle.focus();
        break;
    }
  }
}

function moveFrame(direction) {
  pauseVideoIfPlaying();

  if (!isFrameStepping) {
    isFrameStepping = true;
    frameStepDirection = direction;
    lastFrameStepTime = 0;
    pendingFrameStep = false;
    requestAnimationFrame(frameStep);
  } else {
    frameStepDirection = direction;
  }
}

function frameStep(timestamp) {
  if (!isFrameStepping) return;

  const minFrameDuration = 1000 / MAX_FRAME_RATE;
  const elapsedTime = timestamp - lastFrameStepTime;

  if (elapsedTime >= minFrameDuration) {
    if (!pendingFrameStep) {
      pendingFrameStep = true;
      const newTime = videoPlayer.currentTime + frameStepDirection * (1 / 30);
      videoPlayer.currentTime = Math.max(0, Math.min(newTime, videoPlayer.duration));
    }
    showControls();
  }

  requestAnimationFrame(frameStep);
}

videoPlayer.addEventListener('seeked', function() {
  if (pendingFrameStep) {
    lastFrameStepTime = performance.now();
    pendingFrameStep = false;
    updateVideoDisplay();
  }
});

function updateVideoDisplay() {
  if (videoPlayer.paused) {
    const canvas = document.createElement('canvas');
    canvas.width = videoPlayer.videoWidth;
    canvas.height = videoPlayer.videoHeight;
    canvas.getContext('2d').drawImage(videoPlayer, 0, 0, canvas.width, canvas.height);
    
    // Force a repaint of the video element
    videoPlayer.style.display = 'none';
    videoPlayer.offsetHeight; // Trigger a reflow
    videoPlayer.style.display = '';
  }
}

function calculateSkipTime(videoDuration) {
  const skipPercentage = 0.03; // 5% of total duration
  return videoDuration * skipPercentage;
}

function skipTime(direction) {
  const skipDuration = calculateSkipTime(videoPlayer.duration);
  logger.info(`Video duration: ${videoPlayer.duration.toFixed(2)}s, Skip duration: ${skipDuration.toFixed(2)}s`);
  
  const newTime = videoPlayer.currentTime + (direction * skipDuration);
  videoPlayer.currentTime = Math.max(0, Math.min(newTime, videoPlayer.duration));
  
  showControls();
}

function setTrimPoint(point) {
  if (point === "start") {
    trimStartTime = videoPlayer.currentTime;
  } else {
    trimEndTime = videoPlayer.currentTime;
  }
  updateTrimControls();
  saveTrimChanges();
}

function togglePlayPause() {
  if (!isVideoInFullscreen(videoPlayer)) {
    if (videoPlayer.paused) {
      // If the video is at the end (current time is at or very close to duration)
      // ensure we start from the trim start point
      if (Math.abs(videoPlayer.currentTime - videoPlayer.duration) < 0.1) {
        videoPlayer.currentTime = trimStartTime;
      }
      videoPlayer.play();
      isPlaying = true;
    } else {
      videoPlayer.pause();
      isPlaying = false;
    }
  }
}

videoClickTarget.addEventListener("click", (e) => {
  e.stopPropagation(); // Prevent the click from bubbling up to the overlay
  togglePlayPause();
});

function updateTrimControls() {
  const duration = videoPlayer.duration;
  const startPercent = (trimStartTime / duration) * 100;
  const endPercent = (trimEndTime / duration) * 100;

  trimStart.style.left = `${startPercent}%`;
  trimEnd.style.right = `${100 - endPercent}%`;
  progressBar.style.left = `${startPercent}%`;
  progressBar.style.right = `${100 - endPercent}%`;
}

function updatePlayhead() {
  if (!videoPlayer) return;

  const duration = videoPlayer.duration;
  const currentTime = videoPlayer.currentTime;
  const percent = (currentTime / duration) * 100;
  playhead.style.left = `${percent}%`;

  // Check if the current time is beyond the trim end
  if (currentTime > trimEndTime) {
    videoPlayer.currentTime = trimStartTime;
  }

  // Check if the current time is within the buffered range
  let isBuffered = false;
  for (let i = 0; i < videoPlayer.buffered.length; i++) {
    if (
      currentTime >= videoPlayer.buffered.start(i) &&
      currentTime <= videoPlayer.buffered.end(i)
    ) {
      isBuffered = true;
      break;
    }
  }

  if (!isBuffered) {
    showLoadingOverlay();
  } else {
    hideLoadingOverlay();
  }

  // Request the next animation frame
  requestAnimationFrame(updatePlayhead);
}

videoPlayer.addEventListener("loadedmetadata", () => {
  requestAnimationFrame(updatePlayhead);
});

progressBarContainer.addEventListener("mousedown", (e) => {
  const rect = progressBarContainer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const width = rect.width;
  const clickPercent = x / width;

  dragStartX = e.clientX;
  
  if (Math.abs(clickPercent - trimStartTime / videoPlayer.duration) < 0.02) {
    isDragging = "start";
  } else if (Math.abs(clickPercent - trimEndTime / videoPlayer.duration) < 0.02) {
    isDragging = "end";
  }

  if (isDragging) {
    isDraggingTrim = false; // Reset drag state
    document.body.classList.add('dragging'); // Add dragging class
    document.addEventListener("mousemove", handleTrimDrag);
    document.addEventListener("mouseup", endTrimDrag);
  } else {
    videoPlayer.currentTime = clickPercent * videoPlayer.duration;
  }
});

function handleTrimDrag(e) {
  const dragDistance = Math.abs(e.clientX - dragStartX);
  
  if (dragDistance > dragThreshold) {
    isDraggingTrim = true;
  }
  
  if (isDraggingTrim) {
    const rect = progressBarContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    const dragPercent = Math.max(0, Math.min(1, x / width));
    const dragTime = dragPercent * videoPlayer.duration;

    if (isDragging === "start" && dragTime < trimEndTime) {
      trimStartTime = Math.max(0, dragTime);
    } else if (isDragging === "end" && dragTime > trimStartTime) {
      trimEndTime = Math.min(videoPlayer.duration, dragTime);
    }

    updateTrimControls();
    videoPlayer.currentTime = isDragging === "start" ? trimStartTime : trimEndTime;
    saveTrimChanges();
  }
}

function endTrimDrag(e) {
  if (!isDraggingTrim) {
    // It was just a click, not a drag
    const clickPercent = (dragStartX - progressBarContainer.getBoundingClientRect().left) / progressBarContainer.offsetWidth;
    videoPlayer.currentTime = clickPercent * videoPlayer.duration;
  }
  
  isDragging = null;
  isDraggingTrim = false;
  document.body.classList.remove('dragging');
  document.removeEventListener("mousemove", handleTrimDrag);
  document.removeEventListener("mouseup", endTrimDrag);

  // Prevent the event from propagating to the player overlay
  e.stopPropagation();
  
  // Set a flag to indicate we just finished dragging
  window.justFinishedDragging = true;
  setTimeout(() => {
    window.justFinishedDragging = false;
  }, 100); // Reset the flag after a short delay
}

// Add mousedown and mouseup event listeners to track mouse button state
document.addEventListener("mousedown", () => {
  isMouseDown = true;
});

document.addEventListener("mouseup", () => {
  isMouseDown = false;
  if (isDraggingTrim) {
    mouseUpTime = Date.now();
  }
  isDragging = null;
  isDraggingTrim = false;
});

setInterval(checkDragState, 100);

// Modify the checkDragState function
function checkDragState() {
  if ((isDragging || isDraggingTrim) && !isMouseDown) {
    const rect = progressBarContainer.getBoundingClientRect();
    if (
      lastMousePosition.x < rect.left ||
      lastMousePosition.x > rect.right ||
      lastMousePosition.y < rect.top ||
      lastMousePosition.y > rect.bottom
    ) {
      logger.info("Drag state reset due to mouse being outside the progress bar and mouse button not pressed");
      isDragging = null;
      isDraggingTrim = false;
      updateTrimControls();
    }
  }
}

let saveTrimTimeout = null;

async function updateClipDisplay(originalName) {
  return
}

async function saveTrimChanges() {
  const clipToUpdate = currentClip ? { ...currentClip } : null;
  
  if (!clipToUpdate) {
    logger.info("No clip to save trim data for");
    return;
  }

  if (saveTrimTimeout) {
    clearTimeout(saveTrimTimeout);
  }

  saveTrimTimeout = setTimeout(async () => {
    try {
      // Save trim data
      await ipcRenderer.invoke(
        "save-trim",
        clipToUpdate.originalName,
        trimStartTime,
        trimEndTime
      );
      logger.info("Trim data saved successfully");

      // Regenerate thumbnail at new start point
      const result = await ipcRenderer.invoke(
        "regenerate-thumbnail-for-trim",
        clipToUpdate.originalName,
        trimStartTime
      );

      if (result.success) {
        // Just update the thumbnail image
        const clipElement = document.querySelector(
          `.clip-item[data-original-name="${clipToUpdate.originalName}"]`
        );
        
        if (clipElement) {
          const imgElement = clipElement.querySelector(".clip-item-media-container img");
          if (imgElement) {
            // Update the thumbnail source with cache busting
            imgElement.src = `file://${result.thumbnailPath}?t=${Date.now()}`;
          }
        }
      }

      if (currentClip) {
        updateDiscordPresence('Editing a clip', currentClip.customName);
      }
    } catch (error) {
      logger.error("Error saving trim data:", error);
      showCustomAlert(`Error saving trim: ${error.message}`);
    }
  }, 500);
}

let saveTitleTimeout = null;

async function saveTitleChange(originalName, oldCustomName, newCustomName, immediate = false) {
  if (saveTitleTimeout) {
    clearTimeout(saveTitleTimeout);
  }

  const saveOperation = async () => {
    if (newCustomName === oldCustomName) return;

    try {
      const result = await ipcRenderer.invoke(
        "save-custom-name",
        originalName,
        newCustomName
      );
      if (result.success) {
        updateClipNameInLibrary(originalName, newCustomName);
        logger.info(`Title successfully changed to: ${newCustomName}`);
        
        // Update the currentClip object
        if (currentClip && currentClip.originalName === originalName) {
          currentClip.customName = newCustomName;
        }
        
        // Update the clip in allClips array
        const clipIndex = allClips.findIndex(clip => clip.originalName === originalName);
        if (clipIndex !== -1) {
          allClips[clipIndex].customName = newCustomName;
        }

        // Update the clip element in the grid
        const clipElement = document.querySelector(`.clip-item[data-original-name="${originalName}"]`);
        if (clipElement) {
          const clipNameElement = clipElement.querySelector('.clip-name');
          if (clipNameElement) {
            clipNameElement.textContent = newCustomName;
          }
        }
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      logger.error("Error saving custom name:", error);
      await showCustomAlert(
        `Failed to save custom name. Please try again later. Error: ${error.message}`
      );
      // Revert to the original name in the grid
      const clipElement = document.querySelector(`.clip-item[data-original-name="${originalName}"]`);
      if (clipElement) {
        const clipNameElement = clipElement.querySelector('.clip-name');
        if (clipNameElement) {
          clipNameElement.textContent = oldCustomName;
        }
      }
    }
  };

  if (immediate) {
    await saveOperation();
  } else {
    saveTitleTimeout = setTimeout(saveOperation, 500); // 500ms debounce
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

clipTitle.addEventListener("focus", () => {
  isRenamingActive = true;
});

clipTitle.addEventListener("blur", () => {
  isRenamingActive = false;
  saveTitleChange();
});

clipTitle.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clipTitle.blur();
  }
});


function showCustomAlert(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-modal");
    const modalMessage = document.getElementById("modal-message");
    const modalOk = document.getElementById("modal-ok");
    const modalCancel = document.getElementById("modal-cancel");

    modalMessage.textContent = message;
    modalCancel.style.display = "none";
    modal.style.display = "block";

    modalOk.onclick = () => {
      modal.style.display = "none";
      resolve();
    };
  });
}

function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-modal");
    const modalMessage = document.getElementById("modal-message");
    const modalOk = document.getElementById("modal-ok");
    const modalCancel = document.getElementById("modal-cancel");

    modalMessage.textContent = message;
    modalCancel.style.display = "inline-block";
    modal.style.display = "block";

    modalOk.onclick = () => {
      modal.style.display = "none";
      resolve(true);
    };

    modalCancel.onclick = () => {
      modal.style.display = "none";
      resolve(false);
    };
  });
}


const debouncedFilterClips = debounce((filter) => {
  logger.info("Filtering clips with filter:", filter);
  logger.info("allClips length before filtering:", allClips.length);
  
  let filteredClips = [...allClips];

  if (filter === "all") {
    filteredClips = filteredClips.filter(clip => !clip.tags.includes("Private"));
  } else if (filter === "Private") {
    filteredClips = filteredClips.filter(clip => clip.tags.includes("Private"));
  } else {
    filteredClips = filteredClips.filter(clip => 
      clip.tags.includes(filter) && !clip.tags.includes("Private")
    );
  }

  filteredClips = removeDuplicates(filteredClips);
  filteredClips.sort((a, b) => b.createdAt - a.createdAt);

  logger.info("Filtered clips length:", filteredClips.length);

  currentClipList = filteredClips;
  renderClips(currentClipList);

  if (currentClip) {
    updateNavigationButtons();
  }

  validateClipLists();
  updateClipCounter(filteredClips.length);
  updateDiscordPresence('Browsing clips', `Filter: ${filter}, Total: ${currentClipList.length}`);
}, 300);  // 300ms debounce time

function filterClips() {
  if (selectedTags.size === 0) {
    currentClipList = [];
  } else {
    currentClipList = allClips.filter(clip => {
      // Handle untagged clips
      if (selectedTags.has('Untagged')) {
        if (!clip.tags || clip.tags.length === 0) {
          return true;
        }
      }

      if (!clip.tags || clip.tags.length === 0) {
        return false;
      }

      if (isInTemporaryMode) {
        // In temporary mode (focus mode), show clips that have ANY of the temporary selected tags
        return clip.tags.some(tag => temporaryTagSelections.has(tag));
      } else {
        // In normal mode, clips must have ALL their tags selected to be shown
        return clip.tags.every(tag => selectedTags.has(tag));
      }
    });
  }
  
  currentClipList = removeDuplicates(currentClipList);
  renderClips(currentClipList);
  updateClipCounter(currentClipList.length);
}

// Helper function to remove duplicates
function removeDuplicates(clips) {
  logger.info("Removing duplicates. Input length:", clips.length);
  const uniqueClips = clips.filter((clip, index, self) =>
    index === self.findIndex((t) => t.originalName === clip.originalName)
  );
  logger.info("After removing duplicates. Output length:", uniqueClips.length);
  return uniqueClips;
}

function validateClipLists() {
  logger.info("Validating clip lists");
  logger.info("allClips length:", allClips.length);
  logger.info("currentClipList length:", currentClipList.length);
  logger.info("Rendered clips count:", clipGrid.children.length);

  const allClipsUnique = new Set(allClips.map(clip => clip.originalName)).size === allClips.length;
  const currentClipListUnique = new Set(currentClipList.map(clip => clip.originalName)).size === currentClipList.length;

  logger.info("allClips is unique:", allClipsUnique);
  logger.info("currentClipList is unique:", currentClipListUnique);

  if (!allClipsUnique || !currentClipListUnique) {
    logger.warn("Duplicate clips detected!");
  }
}

function updateFilterDropdown() {
  const tagButton = document.getElementById('tagv2-button');
  const tagList = document.getElementById('tagv2-list');
  const tagCount = document.getElementById('tagv2-count');
  
  // Clear existing list
  tagList.innerHTML = '';
  
  // Get all unique tags and add "Untagged"
  const allTags = new Set(['Untagged', ...globalTags]);
  
  // Update count
  tagCount.textContent = `(${selectedTags.size}/${allTags.size})`;

  // Create and add the "Untagged" option first
  const untaggedItem = createTagItem('Untagged');
  tagList.appendChild(untaggedItem);
  
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
  tagItem.className = `tagv2-item ${savedTagSelections.has(tag) ? 'selected' : ''}`;
  
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

function handleCtrlClickTag(tag, tagItem) {
  if (!isInTemporaryMode || !temporaryTagSelections.has(tag)) {
    // Enter temporary mode or add to temporary selections
    enterTemporaryMode(tag);
  } else {
    // If ctrl-clicking a temporary selected tag, revert to saved selections
    exitTemporaryMode();
  }
  
  updateTagSelectionUI();
  filterClips();
}

function handleRegularClickTag(tag, tagItem) {
  if (isInTemporaryMode) {
    // If in temporary mode, regular click exits it
    exitTemporaryMode();
  } 
  
  // Toggle the tag selection
  if (savedTagSelections.has(tag)) {
    savedTagSelections.delete(tag);
  } else {
    savedTagSelections.add(tag);
  }
  selectedTags = new Set(savedTagSelections);
  saveTagPreferences();
  
  updateTagSelectionUI();
  filterClips();
}

function enterTemporaryMode(tag) {
  isInTemporaryMode = true;
  temporaryTagSelections.clear();
  temporaryTagSelections.add(tag);
  selectedTags = temporaryTagSelections; // Update the global selectedTags
}

function exitTemporaryMode() {
  isInTemporaryMode = false;
  temporaryTagSelections.clear();
  selectedTags = new Set(savedTagSelections); // Restore saved selections
}

function updateTagSelectionUI() {
  const tagItems = document.querySelectorAll('.tagv2-item');
  tagItems.forEach(item => {
    const label = item.querySelector('.tagv2-item-label').textContent;
    const isSelected = isInTemporaryMode ? 
      temporaryTagSelections.has(label) : 
      savedTagSelections.has(label);
    
    item.classList.toggle('selected', isSelected);
    
    // Add visual indicator for temporary mode
    if (isInTemporaryMode && temporaryTagSelections.has(label)) {
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
    item.classList.toggle('selected', selectedTags.has(label));
  });
}

function updateTagCount() {
  const tagCount = document.getElementById('tagv2-count');
  const allTags = new Set(['Untagged', ...globalTags]);
  tagCount.textContent = `(${selectedTags.size}/${allTags.size})`;
}

async function saveTagPreferences() {
  try {
    await ipcRenderer.invoke('save-tag-preferences', Array.from(selectedTags));
  } catch (error) {
    logger.error('Error saving tag preferences:', error);
  }
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
        <button id="tagv2-select-all">Select All</button>
        <button id="tagv2-deselect-all">Deselect All</button>
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
      savedTagSelections = new Set(['Untagged', ...globalTags]);
      selectedTags = new Set(savedTagSelections);
      saveTagPreferences();
      updateTagSelectionStates();
      updateTagCount();
      filterClips();
    });
  }
  
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent event from bubbling up
      exitTemporaryMode();
      savedTagSelections.clear();
      selectedTags.clear();
      saveTagPreferences();
      updateTagSelectionStates();
      updateTagCount();
      filterClips();
    });
  }
}

function updateDiscordPresenceBasedOnState() {
  if (currentClip) {
    updateDiscordPresenceForClip(currentClip, !videoPlayer.paused);
  } else {
    const publicClipCount = currentClipList.filter(clip => !clip.tags.includes('Private')).length;
    updateDiscordPresence('Browsing clips', `Total: ${publicClipCount}`);
  }
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 100); // Get 2 decimal places
  
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(2, '0')}`;
}

function updateDiscordPresence(details, state = null) {
  if (settings && settings.enableDiscordRPC) {
    ipcRenderer.invoke('update-discord-presence', details, state);
  }
}

async function toggleDiscordRPC(enable) {
  await ipcRenderer.invoke('toggle-discord-rpc', enable);
  if (enable) {
    updateDiscordPresenceBasedOnState();
  }
}

document.addEventListener('mousemove', () => {
  lastActivityTime = Date.now();
});

document.addEventListener('keydown', () => {
  lastActivityTime = Date.now();
});

setInterval(() => {
  if (Date.now() - lastActivityTime > IDLE_TIMEOUT && !videoPlayer.playing) {
    ipcRenderer.invoke('clear-discord-presence');
  }
}, 60000); // Check every minute

ipcRenderer.on('check-activity-state', () => {
  if (Date.now() - lastActivityTime <= IDLE_TIMEOUT || videoPlayer.playing) {
    updateDiscordPresenceBasedOnState();
  }
});

function updateDiscordPresenceForClip(clip, isPlaying = true) {
  if (settings && settings.enableDiscordRPC) {
    clearInterval(discordPresenceInterval);
    
    if (clip.tags && clip.tags.includes('Private')) {
      logger.info('Private clip detected. Clearing presence');
      updateDiscordPresence('Download Clip Library now!', '');
    } else {
      if (isPlaying) {
        clipStartTime = Date.now() - (elapsedTime * 1000);
      }
      
      const updatePresence = () => {
        if (isPlaying) {
          elapsedTime = Math.floor((Date.now() - clipStartTime) / 1000);
        }
        const totalDuration = Math.floor(videoPlayer.duration);
        const timeString = `${formatTime(elapsedTime)}/${formatTime(totalDuration)}`;
        updateDiscordPresence(`${clip.customName}`, `${timeString}`);
      };

      updatePresence(); // Initial update
      
      if (isPlaying) {
        discordPresenceInterval = setInterval(updatePresence, 1000); // Update every second
      }
    }
  }
}

// Update preview position and content
function updatePreview(e) {
  const rect = progressBarContainer.getBoundingClientRect();
  const position = (e.clientX - rect.left) / rect.width;
  const time = videoPlayer.duration * position;
  
  // Position directly based on cursor location within progress bar
  const cursorXRelative = e.clientX - rect.left;
  const previewWidth = previewElement.offsetWidth;
  
  previewElement.style.position = 'absolute';
  previewElement.style.left = `${cursorXRelative - (previewWidth/2)}px`;
  previewElement.style.bottom = '20px';
  
  // Update timestamp
  const previewTimestamp = document.getElementById('preview-timestamp');
  previewTimestamp.textContent = formatTime(time);

  // Update video frame if ready
  if (tempVideo.readyState >= 2) {
    tempVideo.currentTime = time;
  }
}

// Use a more efficient throttling mechanism
let lastUpdateTime = 0;
const UPDATE_INTERVAL = 16; // About 60fps

progressBarContainer.addEventListener('mousemove', (e) => {
  // Add this check - if we're hovering over volume controls, don't show preview
  if (e.target.classList.contains('volume-start') || 
      e.target.classList.contains('volume-end') || 
      e.target.classList.contains('volume-region') ||
      e.target.classList.contains('volume-drag-control') ||
      e.target.parentElement?.classList.contains('volume-drag-control')) {
    return;
  }
  
  const now = performance.now();
  
  // Just show the preview initially
  previewElement.style.display = 'block';
  
  // Only update position and content when throttle interval has passed
  if (now - lastUpdateTime >= UPDATE_INTERVAL) {
    lastUpdateTime = now;
    updatePreview(e);
  }
});

// Optimize the seeked event handler
tempVideo.addEventListener('seeked', () => {
  const previewCanvas = document.getElementById('preview-canvas');
  const ctx = previewCanvas?.getContext('2d');
  if (ctx && tempVideo.readyState >= 2) {
    ctx.drawImage(tempVideo, 0, 0, previewCanvas.width, previewCanvas.height);
  }
});

// Add this function after tempVideo creation
async function initializePreviewVideo(videoSource) {
  return new Promise((resolve) => {
    tempVideo.src = videoSource;
    tempVideo.addEventListener('loadedmetadata', () => {
      const previewCanvas = document.getElementById('preview-canvas');
      if (previewCanvas) {
        previewCanvas.width = 160;  // Set fixed preview width
        previewCanvas.height = 90;  // Set fixed preview height
      }
      resolve();
    }, { once: true });
  });
}

// Modify the video player's loadedmetadata event handler
videoPlayer.addEventListener('loadedmetadata', async () => {
  await initializePreviewVideo(videoPlayer.src);
  // Hide preview by default when loading a new video
  previewElement.style.display = 'none';
});

// Add this after the mousemove event listener for progressBarContainer
progressBarContainer.addEventListener('mouseleave', () => {
  const previewElement = document.getElementById('timeline-preview');
  if (previewElement) {
    previewElement.style.display = 'none';
  }
  // Reset temp video
  tempVideo.currentTime = 0;
});

const selectionActions = document.createElement('div');
selectionActions.id = 'selection-actions';
selectionActions.classList.add('hidden');
selectionActions.innerHTML = `
  <span id="selection-count"></span>
  <button id="delete-selected" class="action-button">Delete Selected</button>
  <button id="clear-selection" class="action-button">Clear Selection</button>
`;
document.body.appendChild(selectionActions);

let lastSelectedClip = null;

function handleClipSelection(clipItem, event) {
  // Get all visible clip items
  const clipItems = Array.from(document.querySelectorAll('.clip-item:not([style*="display: none"])'));
  const currentIndex = clipItems.indexOf(clipItem);

  if (event.shiftKey && lastSelectedClip) {
    // Get index of last selected clip
    const lastSelectedIndex = clipItems.indexOf(lastSelectedClip);
    
    if (currentIndex >= 0 && lastSelectedIndex >= 0) {
      // Clear existing selection
      clearSelection(false); // Don't reset lastSelectedClip
      
      // Select all clips between last selected and current
      const [start, end] = [lastSelectedIndex, currentIndex].sort((a, b) => a - b);
      
      for (let i = start; i <= end; i++) {
        if (i >= 0 && i < clipItems.length) {
          const clip = clipItems[i];
          if (isClipSelectable(clip)) {
            selectedClips.add(clip.dataset.originalName);
            clip.classList.add('selected');
          }
        }
      }
    }
  } else {
    // Single selection with Ctrl/Cmd
    if (currentIndex >= 0) {
      const originalName = clipItem.dataset.originalName;
      
      if (!event.ctrlKey && !event.metaKey) {
        // Clear other selections if not using Ctrl/Cmd
        clearSelection(false);
      }
      
      if (selectedClips.has(originalName) && (event.ctrlKey || event.metaKey)) {
        // Deselect if already selected and using Ctrl/Cmd
        selectedClips.delete(originalName);
        clipItem.classList.remove('selected');
        
        // Update lastSelectedClip to the previous selected clip if exists
        const selectedElements = Array.from(document.querySelectorAll('.clip-item.selected'));
        lastSelectedClip = selectedElements[selectedElements.length - 1] || null;
      } else {
        // Select the clip
        selectedClips.add(originalName);
        clipItem.classList.add('selected');
        lastSelectedClip = clipItem;
      }
    }
  }

  updateSelectionUI();
}

// Modified clear selection to optionally preserve lastSelectedClip
function clearSelection(resetLastSelected = true) {
  document.querySelectorAll('.clip-item.selected').forEach(clip => {
    clip.classList.remove('selected');
  });
  selectedClips.clear();
  if (resetLastSelected) {
    lastSelectedClip = null;
  }
  updateSelectionUI();
}

// Helper function to check if a clip is selectable
function isClipSelectable(clip) {
  return clip && 
         clip.dataset && 
         clip.dataset.originalName && 
         !clip.classList.contains('deleting') && 
         !clip.classList.contains('video-preview-disabled');
}

// Add this to your document event listeners
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    clearSelection(true); // Reset lastSelectedClip when using Escape
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isInTemporaryMode) {
    exitTemporaryMode();
    updateTagSelectionUI();
    filterClips();
  }
});

function updateSelectionUI() {
  const selectionActions = document.getElementById('selection-actions');
  const selectionCount = document.getElementById('selection-count');

  if (selectedClips.size > 0) {
    selectionActions.classList.remove('hidden');
    selectionCount.textContent = `${selectedClips.size} clip${selectedClips.size !== 1 ? 's' : ''} selected`;
  } else {
    selectionActions.classList.add('hidden');
  }
}

function clearSelection() {
  document.querySelectorAll('.clip-item.selected').forEach(clip => {
    clip.classList.remove('selected');
  });
  selectedClips.clear();
  selectionStartIndex = -1;
  updateSelectionUI();
}

// Add keyboard handler for Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedClips.size > 0) {
    clearSelection();
  }
});

async function deleteSelectedClips() {
  if (selectedClips.size === 0) return;

  const isConfirmed = await showCustomConfirm(
    `Are you sure you want to delete ${selectedClips.size} clip${selectedClips.size !== 1 ? 's' : ''}? This action cannot be undone.`
  );

  if (!isConfirmed) return;

  const totalClips = selectedClips.size;
  let completed = 0;

  // Show initial progress
  showDeletionTooltip();

  try {
    const clipsToDelete = Array.from(selectedClips);
    
    for (const originalName of clipsToDelete) {
      const clipElement = document.querySelector(
        `.clip-item[data-original-name="${originalName}"]`
      );

      if (clipElement) {
        // Immediately add visual feedback
        disableVideoThumbnail(originalName);

        try {
          const result = await ipcRenderer.invoke('delete-clip', originalName);
          if (!result.success) {
            throw new Error(result.error);
          }

          // Remove from data structures
          const allClipsIndex = allClips.findIndex(clip => clip.originalName === originalName);
          const currentClipListIndex = currentClipList.findIndex(clip => clip.originalName === originalName);
          
          if (allClipsIndex > -1) allClips.splice(allClipsIndex, 1);
          if (currentClipListIndex > -1) currentClipList.splice(currentClipListIndex, 1);

          // Remove from UI
          clipElement.remove();
          
          completed++;
          updateDeletionProgress(completed, totalClips);
          
        } catch (error) {
          logger.error(`Error deleting clip ${originalName}:`, error);
          await showCustomAlert(`Failed to delete clip: ${error.message}`);
        }
      }
    }
  } finally {
    clearSelection();
    updateClipCounter(currentClipList.length);
    hideDeletionTooltip();
  }
}

// Update deletion tooltip to show progress
function updateDeletionProgress(completed, total) {
  const deletionTooltip = document.querySelector('.deletion-tooltip');
  if (deletionTooltip) {
    deletionTooltip.textContent = `Deleting clips... ${completed}/${total}`;
  }
}

// Add event listeners for the action buttons
document.getElementById('delete-selected')?.addEventListener('click', deleteSelectedClips);
document.getElementById('clear-selection')?.addEventListener('click', clearSelection);

// Add these helper functions to renderer.js

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
    
    // Replace input with display
    searchInput.style.display = 'none';
    searchContainer.appendChild(searchDisplay);
  }
  
  return searchDisplay;
}

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

// Add event listeners for the search display
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

// Modify your existing document.addEventListener('DOMContentLoaded', ...) 
// to call this after the search container is definitely created
function initializeEnhancedSearch() {
  if (document.getElementById('search-container')) {
    setupEnhancedSearch();
  } else {
    logger.warn('Search container not found, waiting for DOM...');
    // Try again in a short moment
    setTimeout(initializeEnhancedSearch, 100);
  }
}

// Add this to your existing DOMContentLoaded listener
document.addEventListener('DOMContentLoaded', () => {
  initializeEnhancedSearch();
  initializeSettingsModal();
  
  // Add global click handler for modal backdrop
  const settingsModal = document.getElementById('settingsModal');
  
  // Add escape key handler
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal.style.display === 'block') {
      closeSettingsModal();
    }
  });
});

async function updateVersionDisplay() {
  try {
    const version = await ipcRenderer.invoke('get-app-version');
    const versionElement = document.getElementById('app-version');
    if (versionElement) {
      versionElement.textContent = version;
    }
  } catch (error) {
    logger.error('Failed to get app version:', error);
  }
}

// Add this near the other ipcRenderer listeners
ipcRenderer.on('show-update-notification', (event, { currentVersion, latestVersion, changelog }) => {

  logger.info(`Renderer received update notification: ${currentVersion} -> ${latestVersion}`);
  if (!document.querySelector('.update-notification')) {
    const notification = document.createElement('div');
    notification.className = 'update-notification';
    notification.innerHTML = `
      <div class="update-notification-content">
        <span class="update-text">Update available (${latestVersion})</span>
        <button class="update-close" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
      <div class="changelog-container">
        <div class="changelog"></div>
      </div>
    `;

    // Parse and sanitize markdown
    const changelogContainer = notification.querySelector('.changelog');
    if (changelog) {
      const parsed = marked.parse(changelog);
      changelogContainer.innerHTML = DOMPurify.sanitize(parsed);
    } else {
      changelogContainer.textContent = 'No release notes available';
    }
    document.body.appendChild(notification);
    
    // Show notification with slight delay
    setTimeout(() => {
      notification.classList.add('show');
      logger.info('Update notification shown');
    }, 100);

    // Add event listeners
    notification.querySelector('.update-close').addEventListener('click', (e) => {
      e.stopPropagation();
      notification.classList.remove('show');
      setTimeout(() => notification.remove(), 300);
      logger.info('Update notification dismissed');
    });

    notification.querySelector('.update-notification-content').addEventListener('click', async (e) => {
      if (e.target.closest('.update-close')) return;
      
      // Add progress bar
      const progressBar = document.createElement('div');
      progressBar.className = 'download-progress';
      progressBar.innerHTML = '<div class="progress-fill"></div>';
      e.currentTarget.appendChild(progressBar);
      e.currentTarget.classList.add('downloading');
      
      // Listen for progress updates
      ipcRenderer.on('download-progress', (_, progress) => {
        progressBar.querySelector('.progress-fill').style.width = `${progress}%`;
      });
    
      // Start update
      await ipcRenderer.invoke('start-update');
      
      // Cleanup
      ipcRenderer.removeAllListeners('download-progress');
    });
  }
});

window.loadingScreenTest = {
  show: () => {
    const loadingScreen = document.getElementById('loading-screen');
    if (!loadingScreen) {
      // Create the loading screen if it doesn't exist
      const newLoadingScreen = document.createElement('div');
      newLoadingScreen.id = 'loading-screen';
      newLoadingScreen.innerHTML = `
        <div class="loading-content">
          <div class="logo-container">
            <img src="assets/title.png" alt="App Logo and Title" class="app-logo-title">
          </div>
        </div>
      `;
      document.body.appendChild(newLoadingScreen);
      
      // Force a reflow to ensure the animation starts
      newLoadingScreen.offsetHeight;
      
    } else {
      loadingScreen.style.display = 'flex';
      loadingScreen.style.opacity = '1';
    }
  },
  
  hide: () => {
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
      loadingScreen.style.opacity = '0';
      setTimeout(() => {
        loadingScreen.style.display = 'none';
      }, 1000);
    }
  },
  
  toggle: () => {
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen && (loadingScreen.style.display === 'none' || loadingScreen.style.opacity === '0')) {
      window.loadingScreenTest.show();
    } else {
      window.loadingScreenTest.hide();
    }
  }
};

// Optional: Add keyboard shortcut for quick testing
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + Shift + L to toggle loading screen
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
    window.loadingScreenTest.toggle();
  }
});

function initializeVolumeControls() {
  // Create elements if they don't exist
  if (!volumeStartElement) {
    volumeStartElement = document.createElement('div');
    volumeStartElement.className = 'volume-start';
  }
  
  if (!volumeEndElement) {
    volumeEndElement = document.createElement('div');
    volumeEndElement.className = 'volume-end';
  }
  
  if (!volumeRegionElement) {
    volumeRegionElement = document.createElement('div');
    volumeRegionElement.className = 'volume-region';
  }

  if (!volumeDragControl) {
    volumeDragControl = document.createElement('div');
    volumeDragControl.className = 'volume-drag-control';
    const volumeInput = document.createElement('input');
    volumeInput.type = 'range';
    volumeInput.min = '0';
    volumeInput.max = '1';
    volumeInput.step = '0.1';
    volumeInput.value = '0';
    volumeDragControl.appendChild(volumeInput);
  }
  
  const progressBarContainer = document.getElementById('progress-bar-container');
  if (!progressBarContainer.contains(volumeStartElement)) {
    progressBarContainer.appendChild(volumeStartElement);
    progressBarContainer.appendChild(volumeEndElement);
    progressBarContainer.appendChild(volumeRegionElement);
    progressBarContainer.appendChild(volumeDragControl);
  }

  hideVolumeControls();
  setupVolumeControlListeners();
}

const debouncedSaveVolumeLevel = debounce(async () => {
  if (!currentClip || !isVolumeControlsVisible) return;
  
  const volumeData = {
    start: volumeStartTime,
    end: volumeEndTime,
    level: volumeLevel || 0
  };
  
  try {
    await ipcRenderer.invoke('save-volume-range', currentClip.originalName, volumeData);
    logger.info('Volume data saved with new level:', volumeData);
  } catch (error) {
    logger.error('Error saving volume data:', error);
  }
}, 300);

function setupVolumeControlListeners() {
  // Clean up existing listeners first
  volumeStartElement.removeEventListener('mousedown', handleVolumeStartDrag);
  volumeEndElement.removeEventListener('mousedown', handleVolumeEndDrag);
  document.removeEventListener('mousemove', handleVolumeDrag);
  document.removeEventListener('mouseup', endVolumeDrag);

  function handleVolumeStartDrag(e) {
    if (e.button !== 0) return; // Only handle left mouse button
    e.stopPropagation();
    isVolumeDragging = 'start';
    showVolumeDragControl(e);
    document.addEventListener('mousemove', handleVolumeDrag);
    document.addEventListener('mouseup', endVolumeDrag);
  }

  function handleVolumeEndDrag(e) {
    if (e.button !== 0) return; // Only handle left mouse button
    e.stopPropagation();
    isVolumeDragging = 'end';
    showVolumeDragControl(e);
    document.addEventListener('mousemove', handleVolumeDrag);
    document.addEventListener('mouseup', endVolumeDrag);
  }

  volumeDragControl.querySelector('input').addEventListener('input', (e) => {
    e.stopPropagation();
    volumeLevel = parseFloat(e.target.value);
    debouncedSaveVolumeLevel();
  });

  volumeDragControl.querySelector('input').addEventListener('change', (e) => {
    e.stopPropagation();
    volumeLevel = parseFloat(e.target.value);
    // Force an immediate save
    debouncedSaveVolumeLevel.flush?.() || debouncedSaveVolumeLevel();
  });

  volumeStartElement.addEventListener('mousedown', handleVolumeStartDrag);
  volumeEndElement.addEventListener('mousedown', handleVolumeEndDrag);

  // Force cleanup if window loses focus
  window.addEventListener('blur', () => {
    if (isVolumeDragging) {
      endVolumeDrag();
    }
  });
}

function handleVolumeDrag(e) {
  if (!isVolumeDragging) return;

  document.body.classList.add('dragging');

  const progressBarContainer = document.getElementById('progress-bar-container');
  const rect = progressBarContainer.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const timePosition = (x / rect.width) * videoPlayer.duration;

  if (isVolumeDragging === 'start') {
    volumeStartTime = Math.min(timePosition, volumeEndTime - 0.1);
  } else if (isVolumeDragging === 'end') {
    volumeEndTime = Math.max(timePosition, volumeStartTime + 0.1);
  }

  // Keep volume control visible and centered during drag
  updateVolumeControlsPosition();
  volumeDragControl.style.display = 'flex';
  
  // Ensure volume input stays visible
  const volumeInput = volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.style.display = 'block';
  }

  debouncedSaveVolumeData();
}

function showVolumeDragControl(e) {
  if (!isVolumeControlsVisible) return;

  const rect = progressBarContainer.getBoundingClientRect();
  volumeDragControl.style.display = 'flex';

  // If dragging, use event position
  if (e) {
    const x = e.clientX - rect.left;
    volumeDragControl.style.left = `${x}px`;
  } else {
    // Otherwise position in middle of volume range
    const startPercent = (volumeStartTime / videoPlayer.duration) * 100;
    const endPercent = (volumeEndTime / videoPlayer.duration) * 100;
    const middlePercent = (startPercent + endPercent) / 2;
    volumeDragControl.style.left = `${middlePercent}%`;
  }

  // Ensure input is visible and set to current level
  const volumeInput = volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.value = volumeLevel;
    volumeInput.style.display = 'block';
  }
}

function hideVolumeDragControl() {
  volumeDragControl.style.display = 'none';
}

function endVolumeDrag() {
  if (!isVolumeDragging) return;

  document.body.classList.remove('dragging');
  
  // Save the final position
  if (currentClip) {
    const volumeData = {
      start: volumeStartTime,
      end: volumeEndTime,
      level: volumeLevel
    };
    ipcRenderer.invoke('save-volume-range', currentClip.originalName, volumeData)
      .catch(error => logger.error('Error saving volume data:', error));
  }

  // Reset drag state but keep controls visible
  isVolumeDragging = null;
  document.removeEventListener('mousemove', handleVolumeDrag);
  document.removeEventListener('mouseup', endVolumeDrag);

  // Don't hide the volume drag control, just update its position
  updateVolumeControlsPosition();
  
  // Make sure the input stays visible
  const volumeInput = volumeDragControl.querySelector('input');
  if (volumeInput) {
    volumeInput.style.display = 'block';
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isVolumeDragging) {
    endVolumeDrag();
  }
});

function updateVolumeControlsPosition() {
  if (!videoPlayer.duration || !isVolumeControlsVisible) return;

  const startPercent = (volumeStartTime / videoPlayer.duration) * 100;
  const endPercent = (volumeEndTime / videoPlayer.duration) * 100;

  volumeStartElement.style.left = `${startPercent}%`;
  volumeEndElement.style.left = `${endPercent}%`;
  volumeRegionElement.style.left = `${startPercent}%`;
  volumeRegionElement.style.width = `${endPercent - startPercent}%`;

  // Update volume drag control position
  if (volumeDragControl) {
    const middlePercent = (startPercent + endPercent) / 2;
    volumeDragControl.style.left = `${middlePercent}%`;
    volumeDragControl.style.display = 'flex';
  }
}

async function loadVolumeData() {
  if (!currentClip) {
    logger.warn('Attempted to load volume data without current clip');
    return;
  }
  
  try {
    const volumeData = await ipcRenderer.invoke('get-volume-range', currentClip.originalName);
    logger.info('Volume data loaded:', volumeData);

    if (volumeData && volumeData.start !== undefined && volumeData.end !== undefined) {
      volumeStartTime = volumeData.start;
      volumeEndTime = volumeData.end;
      volumeLevel = volumeData.level || 0;
      isVolumeControlsVisible = true;
      showVolumeControls();
      updateVolumeControlsPosition();
      logger.info('Volume controls restored with data:', {
        start: volumeStartTime,
        end: volumeEndTime,
        level: volumeLevel
      });
    } else {
      logger.info('No valid volume data found for:', currentClip.originalName);
      hideVolumeControls();
    }
  } catch (error) {
    logger.error('Error loading volume data:', error);
    hideVolumeControls();
  }
}

const debouncedSaveVolumeData = debounce(async () => {
  if (!currentClip || !isVolumeControlsVisible) return;
  
  const volumeData = {
    start: volumeStartTime,
    end: volumeEndTime,
    level: volumeLevel || 0
  };
  
  try {
    logger.info('Saving volume data:', volumeData);
    await ipcRenderer.invoke('save-volume-range', currentClip.originalName, volumeData);
    logger.info('Volume data saved successfully');
  } catch (error) {
    logger.error('Error saving volume data:', error);
  }
}, 300); // 300ms debounce time

function saveVolumeData() {
  debouncedSaveVolumeData();
}

function showVolumeControls() {
  isVolumeControlsVisible = true;
  volumeStartElement.style.display = 'block';
  volumeEndElement.style.display = 'block';
  volumeRegionElement.style.display = 'block';
  updateVolumeControlsPosition();
  showVolumeDragControl();
}

function hideVolumeControls() {
  isVolumeControlsVisible = false;
  volumeStartTime = 0;
  volumeEndTime = 0;
  volumeLevel = 0;
  volumeStartElement.style.display = 'none';
  volumeEndElement.style.display = 'none';
  volumeRegionElement.style.display = 'none';
  hideVolumeDragControl();
  
  // Remove volume data from storage when hiding controls
  if (currentClip) {
    ipcRenderer.invoke('save-volume-range', currentClip.originalName, null)
      .catch(error => logger.error('Error removing volume data:', error));
  }
}

function toggleVolumeControls() {
  if (!videoPlayer.duration) return;

  if (!isVolumeControlsVisible) {
    if (volumeStartTime === 0 && volumeEndTime === 0) {
      volumeStartTime = videoPlayer.duration / 3;
      volumeEndTime = (videoPlayer.duration / 3) * 2;
      volumeLevel = 0;
    }
    showVolumeControls();
  } else {
    hideVolumeControls();
  }
}

// Add this to your video timeupdate event listener
videoPlayer.addEventListener('timeupdate', () => {
  if (!audioContext || !gainNode || !isVolumeControlsVisible) return;
  
  const currentVolume = volumeSlider.value;
  if (videoPlayer.currentTime >= volumeStartTime && videoPlayer.currentTime <= volumeEndTime) {
    gainNode.gain.setValueAtTime(volumeLevel * currentVolume, audioContext.currentTime);
  } else {
    gainNode.gain.setValueAtTime(currentVolume, audioContext.currentTime);
  }
});

document.addEventListener('keydown', (e) => {
  const isInputFocused = document.activeElement.tagName === 'INPUT' || 
                        document.activeElement.tagName === 'TEXTAREA' ||
                        document.activeElement.isContentEditable;
                        
  if (!isInputFocused && (e.key === 'v' || e.key === 'V')) {
    e.preventDefault();
    toggleVolumeControls();
  }
});