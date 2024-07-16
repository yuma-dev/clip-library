const { ipcRenderer } = require("electron");
const path = require("path");

const clipGrid = document.getElementById("clip-grid");
const fullscreenPlayer = document.getElementById("fullscreen-player");
const videoPlayer = document.getElementById("video-player");
const clipTitle = document.getElementById("clip-title");
const progressBarContainer = document.getElementById("progress-bar-container");
const progressBar = document.getElementById("progress-bar");
const trimStart = document.getElementById("trim-start");
const trimEnd = document.getElementById("trim-end");
const playhead = document.getElementById("playhead");
const loadingOverlay = document.getElementById('loading-overlay');
const playerOverlay = document.getElementById('player-overlay');

let currentClip = null;
let trimStartTime = 0;
let trimEndTime = 0;
let isDragging = null;
let isDraggingTrim = false;
let mouseUpTime = 0;
let isPlaying = false;
let isRenamingActive = false;
let lastMousePosition = { x: 0, y: 0 };
let isMouseDown = false;
let clipLocation;
let isLoading = false;

// Create settings button and modal
const settingsButton = document.createElement('button');
settingsButton.id = 'settingsButton';
settingsButton.textContent = 'Settings';
settingsButton.className = 'settings-button';

const settingsModal = document.createElement('div');
settingsModal.id = 'settingsModal';
settingsModal.className = 'modal';
settingsModal.innerHTML = `
  <div class="modal-content">
    <h2>Settings</h2>
    <p>Current clip location: <span id="currentClipLocation"></span></p>
    <button id="changeLocationBtn">Change Location</button>
    <button id="closeSettingsBtn">Close</button>
  </div>
`;

document.body.appendChild(settingsButton);
document.body.appendChild(settingsModal);

const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const currentClipLocationSpan = document.getElementById('currentClipLocation');

async function loadClips() {
  try {
    clipLocation = await ipcRenderer.invoke('get-clip-location');
    currentClipLocationSpan.textContent = clipLocation;
    
    const clips = await ipcRenderer.invoke('get-clips');
    clipGrid.innerHTML = '';
    
    for (const clip of clips) {
      const clipElement = document.createElement('div');
      clipElement.className = 'clip-item';
      clipElement.dataset.originalName = clip.originalName;
      
      // Generate thumbnail
      try {
        const thumbnailPath = await ipcRenderer.invoke('generate-thumbnail', clip.originalName);
        const relativeTime = getRelativeTimeString(clip.createdAt);
        clipElement.innerHTML = `
          <img src="file://${thumbnailPath}" alt="${clip.customName}" onerror="this.src='path/to/fallback/image.jpg'" />
          <div class="clip-info">
            <p class="clip-name">${clip.customName}</p>
            <p title="${new Date(clip.createdAt).toLocaleString()}">${relativeTime}</p>
          </div>
        `;
      } catch (error) {
        console.error(`Error generating thumbnail for ${clip.originalName}:`, error);
        const relativeTime = getRelativeTimeString(clip.createdAt);
        clipElement.innerHTML = `
          <div class="thumbnail-error">Thumbnail Error</div>
          <div class="clip-info">
            <p class="clip-name">${clip.customName}</p>
            <p title="${new Date(clip.createdAt).toLocaleString()}">${relativeTime}</p>
          </div>
        `;
      }
      
      clipElement.addEventListener('click', () => openClip(clip.originalName, clip.customName));
      clipGrid.appendChild(clipElement);
    }
  } catch (error) {
    console.error('Error loading clips:', error);
    clipGrid.innerHTML = `<p class="error-message">Error loading clips. Please check your clip location in settings.</p>`;
    currentClipLocationSpan.textContent = 'Error: Unable to load location';
  }
}

async function changeClipLocation() {
  const newLocation = await ipcRenderer.invoke('open-folder-dialog');
  if (newLocation) {
    try {
      await ipcRenderer.invoke('set-clip-location', newLocation);
      clipLocation = newLocation;
      currentClipLocationSpan.textContent = newLocation;
      await loadClips(); // Reload clips with the new location
    } catch (error) {
      console.error('Error changing clip location:', error);
      alert(`Failed to change clip location: ${error.message}`);
    }
  }
}

function openSettingsModal() {
  currentClipLocationSpan.textContent = clipLocation || 'Not set';
  settingsModal.style.display = 'block';
}

function closeSettingsModal() {
  settingsModal.style.display = 'none';
}

settingsButton.addEventListener('click', openSettingsModal);
closeSettingsBtn.addEventListener('click', closeSettingsModal);
document.getElementById('changeLocationBtn').addEventListener('click', changeClipLocation);



// Add this function to calculate relative time
function getRelativeTimeString(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffInSeconds = Math.floor((now - date) / 1000);

  const intervals = [
    { label: 'year', seconds: 31536000 },
    { label: 'month', seconds: 2592000 },
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 },
    { label: 'second', seconds: 1 }
  ];

  for (let i = 0; i < intervals.length; i++) {
    const interval = intervals[i];
    const count = Math.floor(diffInSeconds / interval.seconds);
    if (count >= 1) {
      return count === 1 ? `1 ${interval.label} ago` : `${count} ${interval.label}s ago`;
    }
  }

  return 'just now';
}

// Modify the createClipElement function
function createClipElement(clip, thumbnailPath) {
  const clipElement = document.createElement("div");
  clipElement.className = "clip-item";
  clipElement.dataset.originalName = clip.originalName;
  clipElement.innerHTML = `
    <img src="${thumbnailPath}" alt="${clip.customName}" />
    <div class="clip-info">
      <p class="clip-name">${clip.customName}</p>
      <p>${getRelativeTime(new Date(clip.createdAt))}</p>
    </div>
  `;
  clipElement.addEventListener("click", () =>
    openClip(clip.originalName, clip.customName)
  );
  return clipElement;
}

const exportButton = document.getElementById('export-button');
const deleteButton = document.getElementById('delete-button');

deleteButton.addEventListener('click', confirmAndDeleteClip);
exportButton.addEventListener('click', exportTrimmedVideo);

ipcRenderer.on('close-video-player', () => {
  if (videoPlayer) {
    videoPlayer.pause();
    videoPlayer.src = '';
  }
});

async function confirmAndDeleteClip() {
  if (!currentClip) return;

  const isConfirmed = confirm(`Are you sure you want to delete "${currentClip.customName}"? This action cannot be undone.`);

  if (isConfirmed) {
    try {
      // Close the player before attempting to delete
      closePlayer();
      
      const result = await ipcRenderer.invoke('delete-clip', currentClip.originalName);
      if (result.success) {
        await loadClips(); // Reload clips after successful deletion
        console.log('Clip deleted successfully');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Error deleting clip:', error);
      alert(`Failed to delete clip: ${error.message}`);
    }
  }
}

async function exportTrimmedVideo() {
  if (!currentClip) return;

  exportButton.disabled = true;
  exportButton.textContent = 'Exporting...';

  try {
    const result = await ipcRenderer.invoke('export-trimmed-video', currentClip.originalName, trimStartTime, trimEndTime);
    if (result.success) {
      console.log('Trimmed video exported and copied to clipboard:', result.path);
      exportButton.textContent = 'Export Complete!';
      setTimeout(() => {
        exportButton.textContent = 'Export';
        exportButton.disabled = false;
      }, 2000);
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    console.error('Error exporting video:', error);
    exportButton.textContent = 'Export Failed';
    setTimeout(() => {
      exportButton.textContent = 'Export';
      exportButton.disabled = false;
    }, 2000);
  }
}


ipcRenderer.on('export-progress', (event, progress) => {
  exportButton.textContent = `Exporting... ${Math.round(progress)}%`;
});



async function openClip(originalName, customName) {
  currentClip = { originalName, customName };
  const clipInfo = await ipcRenderer.invoke("get-clip-info", originalName);
  
  // Set video attributes
  videoPlayer.preload = "auto";
  videoPlayer.autoplay = false;
  videoPlayer.src = `file://${clipInfo.format.filename}`;
  
  clipTitle.value = customName;
  
  playerOverlay.style.display = 'block';
  fullscreenPlayer.style.display = "flex";

  const trimData = await ipcRenderer.invoke("get-trim", originalName);
  if (trimData) {
    trimStartTime = trimData.start;
    trimEndTime = trimData.end;
  } else {
    trimStartTime = 0;
    trimEndTime = clipInfo.format.duration;
  }

  // Show loading overlay
  showLoadingOverlay();

  videoPlayer.addEventListener('loadedmetadata', handleVideoMetadataLoaded);
  videoPlayer.addEventListener('canplay', handleVideoCanPlay);
  videoPlayer.addEventListener('progress', updateLoadingProgress);
  videoPlayer.addEventListener('waiting', showLoadingOverlay);
  videoPlayer.addEventListener('playing', hideLoadingOverlay);
  videoPlayer.addEventListener('seeked', handleVideoSeeked);

  setupClipTitleEditing();

  playerOverlay.addEventListener('click', handleOverlayClick);
}

// Add this new function to handle overlay clicks
function handleOverlayClick(e) {
  if (e.target === playerOverlay) {
    closePlayer();
  }
}

function handleVideoMetadataLoaded() {
  updateTrimControls();
  videoPlayer.currentTime = trimStartTime;
}

function handleVideoSeeked() {
  // If we've seeked to the trim start time, start playing
  if (Math.abs(videoPlayer.currentTime - trimStartTime) < 0.1) {
    videoPlayer.play().catch(error => {
      console.error('Error attempting to play the video:', error);
    });
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
    const loadedPercentage = (videoPlayer.buffered.end(0) / videoPlayer.duration) * 100;
    progressBar.style.backgroundImage = `linear-gradient(to right, #3498db ${loadedPercentage}%, #3a3a3a ${loadedPercentage}%)`;
  }
}

function showLoadingOverlay() {
  loadingOverlay.style.display = 'flex';
}

function hideLoadingOverlay() {
  loadingOverlay.style.display = 'none';
}

function setupClipTitleEditing() {
  clipTitle.addEventListener("focus", clipTitleFocusHandler);
  clipTitle.addEventListener("blur", clipTitleBlurHandler);
  clipTitle.addEventListener("keydown", clipTitleKeydownHandler);
}

function clipTitleFocusHandler() {
  isRenamingActive = true;
}

function clipTitleBlurHandler() {
  isRenamingActive = false;
  saveTitleChange();
}

function clipTitleKeydownHandler(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    clipTitle.blur();
  }
}

function closePlayer() {
  playerOverlay.style.display = 'none';
  fullscreenPlayer.style.display = 'none';
  videoPlayer.pause();
  videoPlayer.removeEventListener('loadedmetadata', handleVideoMetadataLoaded);
  videoPlayer.removeEventListener('canplay', handleVideoCanPlay);
  videoPlayer.removeEventListener('progress', updateLoadingProgress);
  videoPlayer.removeEventListener('waiting', showLoadingOverlay);
  videoPlayer.removeEventListener('playing', hideLoadingOverlay);
  videoPlayer.removeEventListener('seeked', handleVideoSeeked);
  videoPlayer.src = '';

  // Remove clip title editing event listeners
  clipTitle.removeEventListener("focus", clipTitleFocusHandler);
  clipTitle.removeEventListener("blur", clipTitleBlurHandler);
  clipTitle.removeEventListener("keydown", clipTitleKeydownHandler);

  // Remove the overlay click event listener
  playerOverlay.removeEventListener('click', handleOverlayClick);

  // Reset current clip
  currentClip = null;
}

// Make sure this event listener is present on the fullscreenPlayer
fullscreenPlayer.addEventListener('click', (e) => {
  e.stopPropagation();
});

playerOverlay.addEventListener('click', closePlayer);

function handleOutsideClick(e) {
  if (e.target === playerOverlay) {
    const timeSinceMouseUp = Date.now() - mouseUpTime;
    if (timeSinceMouseUp > 50) { // 50ms threshold
      closePlayer();
    }
  }
}

// Add this function for handling key presses if needed
function handleKeyPress(e) {
  if (e.key === 'Escape') {
    closePlayer();
  }
  // Add more key handlers as needed
}

// Optionally, you can add this event listener if you want to use handleKeyPress
document.addEventListener('keydown', handleKeyPress);

function togglePlayPause() {
  if (videoPlayer.paused) {
    videoPlayer.play();
    isPlaying = true;
  } else {
    videoPlayer.pause();
    isPlaying = false;
  }
}

videoPlayer.addEventListener("click", togglePlayPause);

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
  const duration = videoPlayer.duration;
  const currentTime = videoPlayer.currentTime;
  const percent = (currentTime / duration) * 100;
  playhead.style.left = `${percent}%`;

  // Remove the automatic seeking here, as it's now handled in handleVideoMetadataLoaded
  // if (currentTime < trimStartTime) {
  //   videoPlayer.currentTime = trimStartTime;
  // } else 
  if (currentTime > trimEndTime) {
    videoPlayer.currentTime = trimStartTime;
  }

  // Check if the current time is within the buffered range
  let isBuffered = false;
  for (let i = 0; i < videoPlayer.buffered.length; i++) {
    if (currentTime >= videoPlayer.buffered.start(i) && currentTime <= videoPlayer.buffered.end(i)) {
      isBuffered = true;
      break;
    }
  }

  if (!isBuffered) {
    showLoadingOverlay();
  } else {
    hideLoadingOverlay();
  }
}

videoPlayer.addEventListener('timeupdate', updatePlayhead);

progressBarContainer.addEventListener("mousedown", (e) => {
  isMouseDown = true;
  const rect = progressBarContainer.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const width = rect.width;
  const clickPercent = x / width;

  if (Math.abs(clickPercent - trimStartTime / videoPlayer.duration) < 0.02) {
    isDragging = "start";
    isDraggingTrim = true;
  } else if (
    Math.abs(clickPercent - trimEndTime / videoPlayer.duration) < 0.02
  ) {
    isDragging = "end";
    isDraggingTrim = true;
  } else {
    videoPlayer.currentTime = clickPercent * videoPlayer.duration;
  }

  // Capture mouse moves on the entire document during drag
  function onMouseMove(e) {
    lastMousePosition = { x: e.clientX, y: e.clientY };
    if (isDragging) {
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
      videoPlayer.currentTime =
        isDragging === "start" ? trimStartTime : trimEndTime;
      saveTrimChanges();
    }
  }

  function onMouseUp() {
    isDragging = null;
    isDraggingTrim = false;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
});

document.addEventListener("mousemove", (e) => {
  lastMousePosition = { x: e.clientX, y: e.clientY };
  
  if (isDragging) {
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
    videoPlayer.currentTime =
      isDragging === "start" ? trimStartTime : trimEndTime;
    saveTrimChanges();
  }
});

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
  if (isDragging && !isMouseDown) {
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
        trimEndTime
      );
      console.log("Trim data saved successfully");
    } catch (error) {
      console.error("Error saving trim data:", error);
      // Optionally, you can show an error message to the user here
    }
  }, 500); // 500ms debounce
}

async function saveTitleChange() {
  if (!currentClip) return;

  const newCustomName = clipTitle.value;
  if (newCustomName === currentClip.customName) return;

  try {
    const result = await ipcRenderer.invoke(
      "save-custom-name",
      currentClip.originalName,
      newCustomName
    );
    if (result.success) {
      currentClip.customName = newCustomName;
      updateClipNameInLibrary(currentClip.originalName, newCustomName);
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    console.error("Error saving custom name:", error);
    alert(`Failed to save custom name. The file might be in use or you may not have the necessary permissions. Please try again later. Error: ${error.message}`);
    clipTitle.value = currentClip.customName; // Revert to the original name
  }
}

function updateClipNameInLibrary(originalName, newCustomName) {
  const clipElement = clipGrid.querySelector(`[data-original-name="${originalName}"]`);
  if (clipElement) {
    const clipNameElement = clipElement.querySelector('.clip-name');
    if (clipNameElement) {
      clipNameElement.textContent = newCustomName;
    }
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

// Initial load
loadClips();