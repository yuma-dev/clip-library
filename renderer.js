const { ipcRenderer } = require("electron");
const path = require("path");
const { Titlebar, TitlebarColor } = require("custom-electron-titlebar");

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
const volumeIcons = {
  normal: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M760-481q0-83-44-151.5T598-735q-15-7-22-21.5t-2-29.5q6-16 21.5-23t31.5 0q97 43 155 131.5T840-481q0 108-58 196.5T627-153q-16 7-31.5 0T574-176q-5-15 2-29.5t22-21.5q74-34 118-102.5T760-481ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm380-120q0 42-19 79.5T591-339q-10 6-20.5.5T560-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM400-606l-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`,
  muted: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="m720-424-76 76q-11 11-28 11t-28-11q-11-11-11-28t11-28l76-76-76-76q-11-11-11-28t11-28q11-11 28-11t28 11l76 76 76-76q11-11 28-11t28 11q11 11 11 28t-11 28l-76 76 76 76q11 11 11 28t-11 28q-11 11-28 11t-28-11l-76-76Zm-440 64H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`,
  low: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M360-360H240q-17 0-28.5-11.5T200-400v-160q0-17 11.5-28.5T240-600h120l132-132q19-19 43.5-8.5T560-703v446q0 27-24.5 37.5T492-228L360-360Zm380-120q0 42-19 79.5T671-339q-10 6-20.5.5T640-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM480-606l-86 86H280v80h114l86 86v-252ZM380-480Z"/></svg>`,
  high: `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M760-440h-80q-17 0-28.5-11.5T640-480q0-17 11.5-28.5T680-520h80q17 0 28.5 11.5T800-480q0 17-11.5 28.5T760-440ZM584-288q10-14 26-16t30 8l64 48q14 10 16 26t-8 30q-10 14-26 16t-30-8l-64-48q-14-10-16-26t8-30Zm120-424-64 48q-14 10-30 8t-26-16q-10-14-8-30t16-26l64-48q14-10 30-8t26 16q10 14 8 30t-16 26ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>`
};

let audioContext, gainNode;
let lastActivityTime = Date.now();
let currentClipList = [];
let currentClip = null;
let trimStartTime = 0;
let trimEndTime = 0;
let isDragging = null;
let isDraggingTrim = false;
let dragStartX = 0;
let dragThreshold = 5; // pixels
let mouseUpTime = 0;
let isPlaying = false;
let isRenamingActive = false;
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
let lastKeyPressed = null;
let pendingFrameStep = false;
let currentContextClip;
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

const settingsModal = document.createElement("div");
settingsModal.id = "settingsModal";
settingsModal.className = "modal";
settingsModal.innerHTML = `
  <div class="modal-content">
    <h2>Settings</h2>
    <p>Current clip location: <span id="currentClipLocation"></span></p>
    <button id="changeLocationBtn">Change Location</button>
    <button id="manageTagsBtn">Manage Tags</button>
    <div class="settings-row">
      <label for="enableDiscordRPC">Enable Discord Rich Presence:</label>
      <input type="checkbox" id="enableDiscordRPC">
    </div>
    <button id="closeSettingsBtn">Close</button>
    <p id="app-version"></p>
  </div>
`;

const container = document.querySelector('.cet-container') || document.body;
container.appendChild(settingsModal);

const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const currentClipLocationSpan = document.getElementById("currentClipLocation");

async function fetchSettings() {
  settings = await ipcRenderer.invoke('get-settings');
}

async function loadClips() {
  try {
    console.log("Loading clips...");
    clipLocation = await ipcRenderer.invoke("get-clip-location");
    currentClipLocationSpan.textContent = clipLocation;

    allClips = await ipcRenderer.invoke("get-clips");
    console.log("Clips received:", allClips.length);
    
    // Load tags for each clip
    for (let clip of allClips) {
      clip.tags = await ipcRenderer.invoke("get-clip-tags", clip.originalName);
    }

    // Remove duplicates based on originalName
    allClips = removeDuplicates(allClips);
    console.log("Clips after removing duplicates:", allClips.length);

    allClips.sort((a, b) => b.createdAt - a.createdAt);

    // Filter out private clips for initial render
    currentClipList = allClips.filter(clip => !clip.tags.includes("Private"));

    console.log("Initial currentClipList length:", currentClipList.length);

    updateClipCounter(currentClipList.length);
    renderClips(currentClipList);
    setupClipTitleEditing();
    validateClipLists();

    // Start progressive thumbnail generation
    const clipNames = allClips.map((clip) => clip.originalName);

    ipcRenderer.invoke("generate-thumbnails-progressively", clipNames);

    // Listen for thumbnail generation progress
    ipcRenderer.on("thumbnail-progress", (event, { current, total }) => {
      updateThumbnailProgress(current, total);
    });

    // Listen for generated thumbnails
    ipcRenderer.on(
      "thumbnail-generated",
      (event, { clipName, thumbnailPath }) => {
        updateClipThumbnail(clipName, thumbnailPath);
      },
    );
    console.log("Clips loaded and rendered.");
    hideLoadingScreen();

    // Update the filter dropdown with all tags
    updateFilterDropdown();
  } catch (error) {
    console.error("Error loading clips:", error);
    clipGrid.innerHTML = `<p class="error-message">Error loading clips. Please check your clip location in settings.</p>`;
    currentClipLocationSpan.textContent = "Error: Unable to load location";
    hideThumbnailGenerationText();
    hideLoadingScreen();
  }
}

function hideLoadingScreen() {
  if (loadingScreen) {
    // Add a 2-second delay before starting to hide the loading screen
    setTimeout(() => {
      loadingScreen.style.opacity = '0';
      setTimeout(() => {
        loadingScreen.style.display = 'none';
      }, 1000);
    }, 1000); // 2000 milliseconds = 2 seconds
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
    console.error('Failed to get app version:', error);
  }
}

async function addNewClipToLibrary(fileName) {
  const newClipInfo = await ipcRenderer.invoke('get-new-clip-info', fileName);
  
  // Check if the clip already exists in allClips
  const existingClipIndex = allClips.findIndex(clip => clip.originalName === newClipInfo.originalName);
  
  if (existingClipIndex === -1) {
    // If it doesn't exist, add it to allClips
    allClips.unshift(newClipInfo);
    const newClipElement = await createClipElement(newClipInfo);
    clipGrid.insertBefore(newClipElement, clipGrid.firstChild);
  } else {
    // If it exists, update the existing clip info
    allClips[existingClipIndex] = newClipInfo;
    // Update the existing clip element in the grid
    const existingElement = clipGrid.querySelector(`[data-original-name="${newClipInfo.originalName}"]`);
    if (existingElement) {
      const updatedElement = await createClipElement(newClipInfo);
      existingElement.replaceWith(updatedElement);
    }
  }
  
  ipcRenderer.invoke('generate-thumbnails-progressively', [fileName]);
  updateFilterDropdown();
}

ipcRenderer.on('new-clip-added', (event, fileName) => {
  addNewClipToLibrary(fileName);
  updateFilterDropdown();
});

function showThumbnailGenerationText() {
  if (!document.getElementById("thumbnail-generation-text")) {
    const textElement = document.createElement("div");
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
    textElement.textContent = "Generating thumbnails...";
    document.body.appendChild(textElement);
  }
}

function updateClipCounter(count) {
  const counter = document.getElementById('clip-counter');
  if (counter) {
    counter.textContent = `Clips: ${count}`;
  }
}

function updateThumbnailGenerationText(current, total) {
  const textElement = document.getElementById("thumbnail-generation-text");
  if (textElement) {
    textElement.textContent = `Generating thumbnails... ${current}/${total}`;
  }
}

function hideThumbnailGenerationText() {
  const textElement = document.getElementById("thumbnail-generation-text");
  if (textElement) {
    textElement.remove();
  }
}

function updateThumbnailProgress(current, total) {
  let progressElement = document.getElementById("thumbnail-progress");
  if (!progressElement) {
    progressElement = document.createElement("div");
    progressElement.id = "thumbnail-progress";
    progressElement.style.position = "fixed";
    progressElement.style.top = "0";
    progressElement.style.left = "0";
    progressElement.style.width = "100%";
    progressElement.style.height = "5px";
    progressElement.style.backgroundColor = "#4CAF50";
    progressElement.style.transition = "width 0.3s";
    progressElement.style.zIndex = "9999";
    document.body.appendChild(progressElement);

    // Show the text indicator when we start
    showThumbnailGenerationText();
  }
  const percentage = (current / total) * 100;
  progressElement.style.width = `${percentage}%`;

  // Update the text indicator
  updateThumbnailGenerationText(current, total);

  if (current === total) {
    setTimeout(() => {
      progressElement.remove();
      hideThumbnailGenerationText();
    }, 1000);
  }
}

function updateClipThumbnail(clipName, thumbnailPath) {
  const clipElement = document.querySelector(
    `.clip-item[data-original-name="${clipName}"]`,
  );
  if (clipElement) {
    const imgElement = clipElement.querySelector("img");
    if (imgElement && imgElement.src.endsWith("loading-thumbnail.gif")) {
      imgElement.src = `file://${thumbnailPath}`;
    }
  }
}

async function renderClips(clips) {
  if (isRendering) {
    console.log("Render already in progress, skipping");
    return;
  }
  
  isRendering = true;
  console.log("Rendering clips. Input length:", clips.length);
  clipGrid.innerHTML = ""; // Clear the grid

  clips = removeDuplicates(clips);
  console.log("Clips to render after removing duplicates:", clips.length);

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

  console.log("Rendered clips count:", clipGrid.children.length);
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
  const searchTerm = document.getElementById("search-input").value.trim().toLowerCase();

  if (searchTerm === "") {
    currentClipList = allClips.filter(clip => !clip.tags.includes("Private"));
  } else {
    const searchWords = searchTerm.split(/\s+/);
    currentClipList = allClips.filter((clip) =>
      !clip.tags.includes("Private") &&
      searchWords.every(
        (word) =>
          clip.customName.toLowerCase().includes(word) ||
          clip.originalName.toLowerCase().includes(word),
      ),
    );
  }
  // Remove duplicates
  currentClipList = currentClipList.filter((clip, index, self) =>
    index === self.findIndex((t) => t.originalName === clip.originalName)
  );
  renderClips(currentClipList);

  if (currentClip) {
    updateNavigationButtons();
  }
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
    console.error("One or more context menu elements not found");
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
    console.log("Export clicked for clip:", contextMenuClip?.originalName);
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
      const firstTag = document.querySelector(".tag-item");
      if (firstTag) {
        firstTag.querySelector("input[type='checkbox']").click();
      }
    }
  });

  tagsDropdown.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  contextMenuDelete.addEventListener("click", async () => {
    console.log("Delete clicked for clip:", contextMenuClip?.originalName);
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

function openTagManagement() {
  console.log("openTagManagement function called");
  try {
    const container = document.querySelector('.cet-container') || document.body;
    
    const tagManagementModal = document.createElement('div');
    tagManagementModal.id = 'tagManagementModal';
    tagManagementModal.className = 'modal';
    tagManagementModal.innerHTML = `
      <div class="modal-content">
        <h2>Manage Tags</h2>
        <div id="tagList"></div>
        <button id="closeTagManagementBtn">Close</button>
      </div>
    `;
    container.appendChild(tagManagementModal);

    // Show the modal
    tagManagementModal.style.display = 'block';

    const tagList = document.getElementById('tagList');
    if (!tagList) {
      throw new Error("Tag list element not found");
    }

    globalTags.forEach(tag => {
      const tagElement = document.createElement('div');
      tagElement.className = 'tag-management-item';
      tagElement.innerHTML = `
        <input type="text" value="${tag}" data-original="${tag}">
        <button class="delete-tag">Delete</button>
      `;
      tagList.appendChild(tagElement);
    });

    const closeTagManagementBtn = document.getElementById('closeTagManagementBtn');
    if (closeTagManagementBtn) {
      closeTagManagementBtn.addEventListener('click', () => {
        tagManagementModal.remove();
      });
    } else {
      throw new Error("Close button for tag management not found");
    }

    tagList.addEventListener('change', async (e) => {
      if (e.target.tagName === 'INPUT') {
        const originalTag = e.target.dataset.original;
        const newTag = e.target.value;
        await updateTag(originalTag, newTag);
      }
    });

    tagList.addEventListener('click', async (e) => {
      if (e.target.className === 'delete-tag') {
        const tagInput = e.target.previousElementSibling;
        const tag = tagInput.dataset.original;
        await deleteTag(tag);
        e.target.parentElement.remove();
      }
    });

    console.log("Tag management modal opened successfully");
  } catch (error) {
    console.error("Error in openTagManagement:", error);
    alert(`An error occurred while opening tag management: ${error.message}`);
  }
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
    updateFilterDropdown(); // Update the dropdown after adding a new tag
  }
}

function deleteGlobalTag(tag) {
  const index = globalTags.indexOf(tag);
  if (index > -1) {
    globalTags.splice(index, 1);
    saveGlobalTags();
    updateTagList();
    updateFilterDropdown();
    
    // Remove the tag from all clips
    allClips.forEach(clip => {
      const tagIndex = clip.tags.indexOf(tag);
      if (tagIndex > -1) {
        clip.tags.splice(tagIndex, 1);
        updateClipTags(clip);
        saveClipTags(clip);
      }
    });
  }
}

async function loadGlobalTags() {
  try {
    globalTags = await ipcRenderer.invoke("load-global-tags");
  } catch (error) {
    console.error("Error loading global tags:", error);
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

function addTag(clip, tag) {
  if (!clip.tags) clip.tags = [];
  clip.tags.push(tag);
  updateClipTags(clip);
  saveClipTags(clip);
}

function removeTag(clip, tag) {
  clip.tags = clip.tags.filter(t => t !== tag);
  updateClipTags(clip);
  saveClipTags(clip);
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

    console.log(`Tag "${originalTag}" updated to "${newTag}"`);
  } else {
    console.warn(`Tag "${originalTag}" not found in globalTags`);
  }
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
    console.error("Error saving clip tags:", error);
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
      console.log('Tooltip shown');
    });
    
    moreTags.addEventListener('mouseleave', () => {
      tooltip.style.display = 'none';
      console.log('Tooltip hidden');
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

    console.log("Context menu shown for clip:", clip.originalName);
    
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
    console.error("Context menu elements not found");
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

function showExportProgress(current, total) {
  let progressElement = document.getElementById("export-progress");
  let textElement = document.getElementById("export-progress-text");

  if (!progressElement) {
    progressElement = document.createElement("div");
    progressElement.id = "export-progress";
    progressElement.style.position = "fixed";
    progressElement.style.top = "0";
    progressElement.style.left = "0";
    progressElement.style.width = "100%";
    progressElement.style.height = "5px";
    progressElement.style.backgroundColor = "#4CAF50";
    progressElement.style.transition = "width 0.3s";
    progressElement.style.zIndex = "9999";
    document.body.appendChild(progressElement);

    textElement = document.createElement("div");
    textElement.id = "export-progress-text";
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

    document.body.appendChild(textElement);
  }

  const percentage = (current / total) * 100;
  progressElement.style.width = `${percentage}%`;
  textElement.textContent = `Exporting clip... ${Math.round(percentage)}%`;

  if (current === total) {
    setTimeout(() => {
      progressElement.remove();
      textElement.remove();
    }, 1000);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  settings = ipcRenderer.invoke('get-settings');
  fetchSettings();
  const settingsButton = document.getElementById("settingsButton");
  if (settingsButton) {
    settingsButton.addEventListener("click", openSettingsModal);
  } else {
    console.error("Settings button not found");
  }

  const changeLocationBtn = document.getElementById("changeLocationBtn");
  const manageTagsBtn = document.getElementById("manageTagsBtn");
  const closeSettingsBtn = document.getElementById("closeSettingsBtn");

  if (changeLocationBtn) {
    changeLocationBtn.addEventListener("click", changeClipLocation);
  } else {
    console.error("Change Location button not found");
  }

  if (manageTagsBtn) {
    manageTagsBtn.addEventListener("click", openTagManagement);
    console.log("Manage Tags button listener added");
  } else {
    console.error("Manage Tags button not found");
  }

  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener("click", closeSettingsModal);
  } else {
    console.error("Close Settings button not found");
  }

  const titlebarOptions = {
    backgroundColor: TitlebarColor.fromHex("#1e1e1e"),
    menu: null,
    titleHorizontalAlignment: "center",
    unfocusEffect: false,
  };

  new Titlebar(titlebarOptions);

  loadClips();
  setupSearch();

  const filterDropdown = document.getElementById("filter-dropdown");
  filterDropdown.addEventListener("change", (e) => {
    const selectedFilter = e.target.value;
    filterClips(selectedFilter);
  });
  
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

  updateDiscordPresence('Browsing clips', `Total clips: ${currentClipList.length}`);

  loadingScreen = document.getElementById('loading-screen');
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
    console.log(`Volume saved for ${clipName}: ${volume}`);
  } catch (error) {
    console.error('Error saving volume:', error);
  }
}, 300); // 300ms debounce time

async function saveVolume(clipName, volume) {
  try {
    await ipcRenderer.invoke("save-volume", clipName, volume);
  } catch (error) {
    console.error("Error saving volume:", error);
  }
}

async function loadVolume(clipName) {
  try {
    const volume = await ipcRenderer.invoke("get-volume", clipName);
    console.log(`Loaded volume for ${clipName}: ${volume}`);
    return volume;
  } catch (error) {
    console.error("Error loading volume:", error);
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
      console.error("Error changing clip location:", error);
      await showCustomAlert(`Failed to change clip location: ${error.message}`);
    }
  }
}

async function openSettingsModal() {
  await fetchSettings();
  const settingsModal = document.getElementById("settingsModal");
  if (settingsModal) {
    settingsModal.style.display = "block";
    updateVersionDisplay();
    
    // Fetch the latest settings
    settings = await ipcRenderer.invoke('get-settings');
    
    // Update the Discord RPC checkbox
    const enableDiscordRPCCheckbox = document.getElementById('enableDiscordRPC');
    if (enableDiscordRPCCheckbox) {
      enableDiscordRPCCheckbox.checked = settings.enableDiscordRPC;
    }
  }
}

async function updateSettings() {
  settings = await ipcRenderer.invoke('get-settings');
}

function closeSettingsModal() {
  settingsModal.style.display = "none";
  updateSettings(); // Update the local settings object
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

    // If thumbnailPath is null, use the loading gif
    if (thumbnailPath === null) {
      thumbnailPath = "assets/loading-thumbnail.gif";
    } else {
      thumbnailPath = `file://${thumbnailPath}`;
    }

    const relativeTime = getRelativeTimeString(clip.createdAt);

    const scissorsIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`;
    const starIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;

    clipElement.innerHTML = `
      <div class="clip-item-media-container">
        <img src="${thumbnailPath}" alt="${clip.customName}" onerror="this.src='assets/fallback-image.jpg'" />
      </div>
      <div class="tag-container"></div>
      <div class="clip-info">
        <p class="clip-name" contenteditable="true">${clip.customName}</p>
        <p title="${new Date(clip.createdAt).toLocaleString()}">${relativeTime}</p>
      </div>
    `;

    let hoverTimeout;
    let videoElement;
    let playPromise;
    let isVideoPlaying = false;

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
      clearTimeout(hoverTimeout);
      if (videoElement) {
        videoElement.pause();
        videoElement.removeAttribute('src'); // Empty source
        videoElement.load(); // Reset the video element
        videoElement.remove();
        videoElement = null;
      }
      isVideoPlaying = false;
      const imgElement = clipElement.querySelector(".clip-item-media-container img");
      if (imgElement) {
        imgElement.style.display = "";
      }
    }

    function handleMouseEnter() {
      if (clipElement.classList.contains("video-preview-disabled")) return;
      cleanupVideoPreview(); // Always cleanup before starting a new preview
      hoverTimeout = setTimeout(() => {
        if (!clipElement.matches(':hover')) return; // Exit if mouse is no longer over the element

        videoElement = document.createElement("video");
        videoElement.src = `file://${path.join(clipLocation, clip.originalName)}`;
        videoElement.muted = true;
        videoElement.loop = true;
        videoElement.preload = "metadata";
        videoElement.style.zIndex = "1";

        const mediaContainer = clipElement.querySelector(".clip-item-media-container");
        const imgElement = mediaContainer.querySelector("img");
        videoElement.poster = imgElement.src;

        videoElement.addEventListener('loadedmetadata', () => {
          if (clipElement.matches(':hover')) {
            imgElement.style.display = "none";
            videoElement.currentTime = clip.isTrimmed ? window.trimStartTime || 0 : 0;
            videoElement.play().then(() => {
              isVideoPlaying = true;
            }).catch((error) => {
              if (error.name !== "AbortError") {
                console.error("Error playing video:", error);
              }
              cleanupVideoPreview();
            });
          } else {
            cleanupVideoPreview();
          }
        });

        mediaContainer.appendChild(videoElement);
      }, 100);
    }

    function handleMouseLeave() {
      if (clipElement.classList.contains("video-preview-disabled")) return;
      cleanupVideoPreview();
    }

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
        console.log('Clip deleted successfully');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Error deleting clip:', error);
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

document.addEventListener('fullscreenchange', handleFullscreenChange);

function handleFullscreenChange() {
  const fullscreenPlayer = document.getElementById('fullscreen-player');
  
  if (!document.fullscreenElement) {
    // We've exited fullscreen
    fullscreenPlayer.classList.remove('custom-fullscreen');
    
    // Reset the player's position
    fullscreenPlayer.style.top = '50%';
    fullscreenPlayer.style.left = '50%';
    fullscreenPlayer.style.transform = 'translate(-50%, -50%)';
  }
}

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
    fullscreenPlayer.classList.add('custom-fullscreen');
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
    fullscreenPlayer.classList.remove('custom-fullscreen');
  }
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
  exportButton.disabled = true;
  exportButton.textContent = "Exporting...";

  try {
    const volume = await loadVolume(currentClip.originalName);
    const result = await ipcRenderer.invoke(
      "export-video",
      currentClip.originalName,
      trimStartTime,
      trimEndTime,
      volume,
      savePath
    );
    if (result.success) {
      console.log("Video exported successfully:", result.path);
      exportButton.textContent = "Export Complete!";
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    console.error("Error exporting video:", error);
    exportButton.textContent = "Export Failed";
  } finally {
    setTimeout(() => {
      exportButton.textContent = "Export";
      exportButton.disabled = false;
    }, 2000);
  }
}

async function exportAudio(savePath = null) {
  exportButton.disabled = true;
  exportButton.textContent = "Exporting Audio...";

  try {
    const volume = await loadVolume(currentClip.originalName);
    const result = await ipcRenderer.invoke(
      "export-audio",
      currentClip.originalName,
      trimStartTime,
      trimEndTime,
      volume,
      savePath
    );
    if (result.success) {
      console.log("Audio exported successfully:", result.path);
      exportButton.textContent = "Audio Export Complete!";
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    console.error("Error exporting audio:", error);
    exportButton.textContent = "Audio Export Failed";
  } finally {
    setTimeout(() => {
      exportButton.textContent = "Export";
      exportButton.disabled = false;
    }, 2000);
  }
}

async function exportTrimmedVideo() {
  if (!currentClip) return;

  exportButton.disabled = true;
  exportButton.textContent = "Exporting...";

  try {
    const volume = await loadVolume(currentClip.originalName);
    const result = await ipcRenderer.invoke(
      "export-trimmed-video",
      currentClip.originalName,
      trimStartTime,
      trimEndTime,
      volume
    );
    if (result.success) {
      console.log(
        "Trimmed video exported and copied to clipboard:",
        result.path,
      );
      exportButton.textContent = "Export Complete!";
      setTimeout(() => {
        exportButton.textContent = "Export";
        exportButton.disabled = false;
      }, 2000);
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    console.error("Error exporting video:", error);
    exportButton.textContent = "Export Failed";
    setTimeout(() => {
      exportButton.textContent = "Export";
      exportButton.disabled = false;
    }, 2000);
  }
}

async function exportClipFromContextMenu(clip) {
  try {
    const clipInfo = await ipcRenderer.invoke(
      "get-clip-info",
      clip.originalName,
    );
    const trimData = await ipcRenderer.invoke("get-trim", clip.originalName);
    const start = trimData ? trimData.start : 0;
    const end = trimData ? trimData.end : clipInfo.format.duration;
    const volume = await loadVolume(clip.originalName);

    // Show initial progress
    showExportProgress(0, 100);

    const result = await ipcRenderer.invoke(
      "export-trimmed-video",
      clip.originalName,
      start,
      end,
      volume
    );
    if (result.success) {
      console.log("Clip exported successfully:", result.path);
      showExportProgress(100, 100); // Show completed progress
      await showCustomAlert(
        `Clip exported successfully. Path copied to clipboard.`,
      );
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    console.error("Error exporting clip:", error);
    await showCustomAlert(`Failed to export clip. Error: ${error.message}`);
  }
}

ipcRenderer.on("export-progress", (event, progress) => {
  if (
    exportButton.disabled &&
    exportButton.textContent.startsWith("Exporting")
  ) {
    exportButton.textContent = `Exporting... ${Math.round(progress)}%`;
  } else {
    // This is a context menu export
    showExportProgress(progress, 100);
  }
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
  elapsedTime = 0;
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }

  const clipInfo = await ipcRenderer.invoke("get-clip-info", originalName);
  const trimData = await ipcRenderer.invoke("get-trim", originalName);
  const clipTags = await ipcRenderer.invoke("get-clip-tags", originalName);
  currentClip = { originalName, customName, tags: clipTags};

  let startTime;
  if (trimData) {
    startTime = trimData.start;
    trimEndTime = trimData.end;
  } else {
    if (clipInfo.format.duration > 40) {
      startTime = clipInfo.format.duration / 2;
    } else {
      startTime = 0;
    }
    trimEndTime = clipInfo.format.duration;
  }
  trimStartTime = startTime;

  videoPlayer.preload = "auto";
  videoPlayer.autoplay = true;
  videoPlayer.src = `file://${clipInfo.format.filename}`;

  clipTitle.value = customName;

  // Load and set the volume before playing the video
  try {
    const savedVolume = await loadVolume(originalName);
    console.log(`Loaded volume for ${originalName}: ${savedVolume}`);
    setupAudioContext();
    gainNode.gain.setValueAtTime(savedVolume, audioContext.currentTime);
    updateVolumeSlider(savedVolume);
  } catch (error) {
    console.error('Error loading volume:', error);
    setupAudioContext();
    gainNode.gain.setValueAtTime(1, audioContext.currentTime);
    updateVolumeSlider(1); // Default to 100%
  }

  playerOverlay.style.display = "block";
  fullscreenPlayer.style.display = "block";

  document.addEventListener("keydown", handleKeyPress);
  document.addEventListener("keyup", handleKeyRelease);

  if (trimData) {
    trimStartTime = trimData.start;
    trimEndTime = trimData.end;
  } else {
    trimStartTime = 0;
    trimEndTime = clipInfo.format.duration;
  }

  // Update the clip duration in the allClips array
  const clipIndex = allClips.findIndex(
    (clip) => clip.originalName === originalName,
  );
  if (clipIndex !== -1) {
    allClips[clipIndex].duration = clipInfo.format.duration;
  }

  showLoadingOverlay();

  videoPlayer.addEventListener("loadedmetadata", () => {
    updateTrimControls();
    videoPlayer.currentTime = startTime;  // Use the calculated startTime
  });
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
    if (!videoPlayer.paused && !document.activeElement.closest('#video-controls')) {
      clearTimeout(controlsTimeout);
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
  videoControls.classList.add("visible");
  clearTimeout(controlsTimeout);
}

function hideControls() {
  if (!videoPlayer.paused && !isMouseOverControls && !document.activeElement.closest('#video-controls')) {
    videoControls.classList.remove("visible");
  }
}

// Add this new function to handle overlay clicks
function handleOverlayClick(e) {
  if (e.target === playerOverlay && !window.justFinishedDragging) {
    closePlayer();
  }
}

function handleVideoSeeked() {
  if (currentClip) {
    elapsedTime = Math.floor(videoPlayer.currentTime);
    // Check if the clip is private before updating Discord presence
    console.log('Current clip:', currentClip.tags);
    if (!currentClip.tags || !currentClip.tags.includes('Private')) {
      updateDiscordPresenceForClip(currentClip, !videoPlayer.paused);
    }
  }
}

function handleVideoCanPlay() {
  if (isLoading) {
    isLoading = false;
    hideLoadingOverlay();
    // We don't need to play here anymore, as it will be handled by the 'seeked' event
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
  console.log(
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
  console.log(`Video duration: ${videoPlayer.duration.toFixed(2)}s, Skip duration: ${skipDuration.toFixed(2)}s`);
  
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
      console.log("Drag state reset due to mouse being outside the progress bar and mouse button not pressed");
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
  if (!currentClip) return;

  if (saveTrimTimeout) {
    clearTimeout(saveTrimTimeout);
  }

  saveTrimTimeout = setTimeout(async () => {
    try {
      await ipcRenderer.invoke(
        "save-trim",
        currentClip.originalName,
        trimStartTime,
        trimEndTime,
      );
      console.log("Trim data saved successfully");
      await updateClipDisplay(currentClip.originalName);
      updateDiscordPresence('Editing a clip', currentClip.customName);
    } catch (error) {
      console.error("Error saving trim data:", error);
      // Optionally, you can show an error message to the user here
    }
  }, 500); // 500ms debounce
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
        console.log(`Title successfully changed to: ${newCustomName}`);
        
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
      console.error("Error saving custom name:", error);
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
    console.warn(
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
    console.warn(`Clip element not found for originalName: ${originalName}`);
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

document
  .getElementById("clip-grid")
  .addEventListener("click", async (event) => {
    const clipItem = event.target.closest(".clip-item");
    if (clipItem) {
      const originalName = clipItem.dataset.originalName;
      const customName = clipItem.querySelector(".clip-name").textContent;
      currentCleanup = await openClip(originalName, customName);
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

const filterDropdown = document.getElementById("filter-dropdown");

filterDropdown.addEventListener("change", () => {
  const selectedFilter = filterDropdown.value;
  filterClips(selectedFilter);
});

const debouncedFilterClips = debounce((filter) => {
  console.log("Filtering clips with filter:", filter);
  console.log("allClips length before filtering:", allClips.length);
  
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

  console.log("Filtered clips length:", filteredClips.length);

  currentClipList = filteredClips;
  renderClips(currentClipList);

  if (currentClip) {
    updateNavigationButtons();
  }

  validateClipLists();
  updateClipCounter(filteredClips.length);
  updateDiscordPresence('Browsing clips', `Filter: ${filter}, Total: ${currentClipList.length}`);
}, 300);  // 300ms debounce time

function filterClips(filter) {
  debouncedFilterClips(filter);
}

// Helper function to remove duplicates
function removeDuplicates(clips) {
  console.log("Removing duplicates. Input length:", clips.length);
  const uniqueClips = clips.filter((clip, index, self) =>
    index === self.findIndex((t) => t.originalName === clip.originalName)
  );
  console.log("After removing duplicates. Output length:", uniqueClips.length);
  return uniqueClips;
}

function validateClipLists() {
  console.log("Validating clip lists");
  console.log("allClips length:", allClips.length);
  console.log("currentClipList length:", currentClipList.length);
  console.log("Rendered clips count:", clipGrid.children.length);

  const allClipsUnique = new Set(allClips.map(clip => clip.originalName)).size === allClips.length;
  const currentClipListUnique = new Set(currentClipList.map(clip => clip.originalName)).size === currentClipList.length;

  console.log("allClips is unique:", allClipsUnique);
  console.log("currentClipList is unique:", currentClipListUnique);

  if (!allClipsUnique || !currentClipListUnique) {
    console.warn("Duplicate clips detected!");
  }
}

function updateFilterDropdown() {
  const filterDropdown = document.getElementById("filter-dropdown");
  const allTags = new Set(globalTags);
  
  filterDropdown.innerHTML = '<option value="all">All Clips</option>';
  allTags.forEach(tag => {
    const option = document.createElement("option");
    option.value = tag;
    option.textContent = truncateTag(tag, 10);
    filterDropdown.appendChild(option);
  });

  // Always add the Private tag option
  if (!allTags.has("Private")) {
    const privateOption = document.createElement("option");
    privateOption.value = "Private";
    privateOption.textContent = "Private";
    filterDropdown.appendChild(privateOption);
  }
}


// Discord Rich Presence


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
  const remainingSeconds = seconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
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
      console.log('Private clip detected. Clearing presence');
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