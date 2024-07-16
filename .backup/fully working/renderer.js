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
const loadingOverlay = document.getElementById('loading-overlay');
const playerOverlay = document.getElementById('player-overlay');
const videoClickTarget = document.getElementById('video-click-target');

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
let currentCleanup = null;


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

document.body.appendChild(settingsModal);

const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const currentClipLocationSpan = document.getElementById('currentClipLocation');

async function loadClips() {
  try {
    clipLocation = await ipcRenderer.invoke('get-clip-location');
    currentClipLocationSpan.textContent = clipLocation;
    
    allClips = await ipcRenderer.invoke('get-clips');
    await renderClips(allClips);
    setupClipTitleEditing();
  } catch (error) {
    console.error('Error loading clips:', error);
    clipGrid.innerHTML = `<p class="error-message">Error loading clips. Please check your clip location in settings.</p>`;
    currentClipLocationSpan.textContent = 'Error: Unable to load location';
  }
}

async function renderClips(clips) {
  clipGrid.innerHTML = '';
  
  const clipPromises = clips.map(createClipElement);
  const clipElements = await Promise.all(clipPromises);
  
  clipElements.forEach(clipElement => {
    clipGrid.appendChild(clipElement);
  });
}
function setupSearch() {
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', performSearch);
}

function performSearch() {
  const searchTerm = document.getElementById('search-input').value.toLowerCase();
  const filteredClips = allClips.filter(clip => 
    clip.customName.toLowerCase().includes(searchTerm) ||
    clip.originalName.toLowerCase().includes(searchTerm)
  );
  renderClips(filteredClips);
}

document.addEventListener('DOMContentLoaded', () => {
  const settingsButton = document.getElementById('settingsButton');
  if (settingsButton) {
      settingsButton.addEventListener('click', openSettingsModal);
  } else {
      console.error('Settings button not found');
  }

  const titlebarOptions = {
      backgroundColor: TitlebarColor.fromHex('#1e1e1e'),
      menu: null,
      titleHorizontalAlignment: 'center',
      unfocusEffect: false
  };

  new Titlebar(titlebarOptions);
  loadClips();
  setupSearch();

  const volumeButton = document.getElementById('volume-button');
  const volumeSlider = document.getElementById('volume-slider');

  volumeButton.addEventListener('click', () => {
      if (volumeSlider.classList.contains('collapsed')) {
          volumeSlider.classList.remove('collapsed');
      } else {
          volumeSlider.classList.add('collapsed');
      }
  });
});


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
      await showCustomAlert(`Failed to change clip location: ${error.message}`);
    }
  }
}

function openSettingsModal() {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) {
    settingsModal.style.display = 'block';
  }
}

function closeSettingsModal() {
  settingsModal.style.display = 'none';
}

document.getElementById('settingsButton').addEventListener('click', openSettingsModal);
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

function createClipElement(clip) {
  return new Promise(async (resolve) => {
    const clipElement = document.createElement('div');
    clipElement.className = 'clip-item';
    clipElement.dataset.originalName = clip.originalName;
    
    let thumbnailPath;
    try {
      thumbnailPath = await ipcRenderer.invoke('generate-thumbnail', clip.originalName);
    } catch (error) {
      console.error('Error generating thumbnail:', error);
      thumbnailPath = 'assets/fallback-image.jpg';
    }

    const relativeTime = getRelativeTimeString(clip.createdAt);

    const scissorsIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`;

    clipElement.innerHTML = `
      <div class="clip-item-media-container">
        <img src="file://${thumbnailPath}" alt="${clip.customName}" onerror="this.src='assets/fallback-image.jpg'" />
      </div>
      ${clip.isTrimmed ? `<div class="trimmed-indicator" title="This video has been trimmed">${scissorsIcon}</div>` : ''}
      <div class="clip-info">
        <p class="clip-name">${clip.customName}</p>
        <p title="${new Date(clip.createdAt).toLocaleString()}">${relativeTime}</p>
      </div>
    `;
    
    let hoverTimeout;
    let videoElement;
    let playPromise;

    clipElement.addEventListener('mouseenter', () => {
      hoverTimeout = setTimeout(() => {
        videoElement = document.createElement('video');
        videoElement.src = `file://${path.join(clipLocation, clip.originalName)}`;
        videoElement.muted = true;
        videoElement.loop = true;
        videoElement.preload = 'metadata';

        const mediaContainer = clipElement.querySelector('.clip-item-media-container');
        const imgElement = mediaContainer.querySelector('img');
        imgElement.style.display = 'none';
        mediaContainer.appendChild(videoElement);

        videoElement.currentTime = clip.isTrimmed ? (window.trimStartTime || 0) : 0;
        playPromise = videoElement.play();
        
        if (playPromise !== undefined) {
          playPromise.catch(error => {
            if (error.name !== 'AbortError') {
              console.error('Error playing video:', error);
            }
          });
        }
      }, 0);
    });

    clipElement.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimeout);
      if (videoElement) {
        if (playPromise !== undefined) {
          playPromise.then(() => {
            videoElement.pause();
          }).catch(() => {
            // Ignore the error if play was interrupted
          });
        }
        videoElement.remove();
        const imgElement = clipElement.querySelector('.clip-item-media-container img');
        imgElement.style.display = '';
      }
    });

    clipElement.addEventListener('click', () => openClip(clip.originalName, clip.customName));
    resolve(clipElement);
  });
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

  const clipToDelete = { ...currentClip }; // Create a copy of currentClip

  const isConfirmed = await showCustomConfirm(`Are you sure you want to delete "${clipToDelete.customName}"? This action cannot be undone.`);

  if (isConfirmed) {
    try {
      // Close the player before attempting to delete
      closePlayer();
      
      const result = await ipcRenderer.invoke('delete-clip', clipToDelete.originalName);
      if (result.success) {
        // Remove the deleted clip from the grid
        const clipElement = document.querySelector(`.clip-item[data-original-name="${clipToDelete.originalName}"]`);
        if (clipElement) {
          clipElement.remove();
        }
        console.log('Clip deleted successfully');
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Error deleting clip:', error);
      await showCustomAlert(`Failed to delete clip: ${error.message}`);
    }
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    if (videoPlayer.requestFullscreen) {
      videoPlayer.requestFullscreen();
    } else if (videoPlayer.mozRequestFullScreen) { // Firefox
      videoPlayer.mozRequestFullScreen();
    } else if (videoPlayer.webkitRequestFullscreen) { // Chrome, Safari and Opera
      videoPlayer.webkitRequestFullscreen();
    } else if (videoPlayer.msRequestFullscreen) { // IE/Edge
      videoPlayer.msRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.mozCancelFullScreen) { // Firefox
      document.mozCancelFullScreen();
    } else if (document.webkitExitFullscreen) { // Chrome, Safari and Opera
      document.webkitExitFullscreen();
    } else if (document.msExitFullscreen) { // IE/Edge
      document.msExitFullscreen();
    }
  }
}

document.getElementById('fullscreen-button').addEventListener('click', toggleFullscreen);

function isVideoInFullscreen(videoElement) {
  return (
      document.fullscreenElement === videoElement ||
      document.webkitFullscreenElement === videoElement || // for Safari
      document.mozFullScreenElement === videoElement || // for Firefox
      document.msFullscreenElement === videoElement // for IE/Edge
  );
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

  showLoadingOverlay();

  videoPlayer.addEventListener('loadedmetadata', handleVideoMetadataLoaded);
  videoPlayer.addEventListener('canplay', handleVideoCanPlay);
  videoPlayer.addEventListener('progress', updateLoadingProgress);
  videoPlayer.addEventListener('waiting', showLoadingOverlay);
  videoPlayer.addEventListener('playing', hideLoadingOverlay);
  videoPlayer.addEventListener('seeked', handleVideoSeeked);

  setupClipTitleEditing();

  playerOverlay.addEventListener('click', handleOverlayClick);


  
  const videoContainer = document.getElementById('video-container');
  const videoControls = document.getElementById('video-controls');

  let controlsTimeout;

  function showControls() {
    videoControls.classList.add('visible');
    clearTimeout(controlsTimeout);
  }

  function hideControls() {
    controlsTimeout = setTimeout(() => {
      if (!videoPlayer.paused) {
        videoControls.classList.remove('visible');
      }
    }, 3000);
  }

  function resetControlsTimeout() {
    showControls();
    hideControls();
  }

  function handleMouseMove(e) {
    // Only respond to actual mouse movements
    if (e.movementX !== 0 || e.movementY !== 0) {
      resetControlsTimeout();
    }
  }

  videoContainer.addEventListener('mousemove', handleMouseMove);
  videoContainer.addEventListener('mouseenter', showControls);
  videoContainer.addEventListener('mouseleave', hideControls);

  videoPlayer.addEventListener('pause', showControls);
  videoPlayer.addEventListener('play', hideControls);

  videoControls.addEventListener('mouseenter', () => {
    clearTimeout(controlsTimeout);
  });

  videoControls.addEventListener('mouseleave', () => {
    if (!videoPlayer.paused) {
      hideControls();
    }
  });

  // Show controls initially
  showControls();


  // Clean up function to remove event listeners
  const cleanup = () => {
    videoContainer.removeEventListener('mousemove', handleMouseMove);
    videoContainer.removeEventListener('mouseenter', showControls);
    videoContainer.removeEventListener('mouseleave', hideControls);
    videoPlayer.removeEventListener('pause', showControls);
    videoPlayer.removeEventListener('play', hideControls);
    videoControls.removeEventListener('mouseenter', showControls);
    videoControls.removeEventListener('mouseleave', hideControls);
    videoPlayer.removeEventListener('click', showControls);
  };

  // Call cleanup when closing the player
  return cleanup;
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
    saveTitleChange(currentClip.originalName, currentClip.customName, clipTitle.value, false);
  }
}

function clipTitleFocusHandler() {
  isRenamingActive = true;
  
  clipTitle.dataset.originalValue = clipTitle.value;

  console.log('Clip title focused. Original value:', clipTitle.dataset.originalValue);
}

function clipTitleBlurHandler() {
  isRenamingActive = false;
  if (currentClip) {
    saveTitleChange(currentClip.originalName, currentClip.customName, clipTitle.value, false);
  }
}

function clipTitleKeydownHandler(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    clipTitle.blur();
  }
}

function closePlayer() {
  if (saveTitleTimeout) {
    clearTimeout(saveTitleTimeout);
    saveTitleTimeout = null;
  }

  // Capture necessary information before resetting currentClip
  const originalName = currentClip ? currentClip.originalName : null;
  const oldCustomName = currentClip ? currentClip.customName : null;
  const newCustomName = clipTitle.value;

  // Save any pending changes immediately
  saveTitleChange(originalName, oldCustomName, newCustomName, true).then(() => {
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

    clipTitle.removeEventListener("focus", clipTitleFocusHandler);
    clipTitle.removeEventListener("blur", clipTitleBlurHandler);
    clipTitle.removeEventListener("keydown", clipTitleKeydownHandler);
    clipTitle.removeEventListener("input", clipTitleInputHandler);

    playerOverlay.removeEventListener('click', handleOverlayClick);

    const clipTitleElement = document.getElementById('clip-title');
    if (clipTitleElement) {
      clipTitleElement.value = '';
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

function handleKeyPress(e) {
  const isClipTitleFocused = document.activeElement === clipTitle;

  if (e.key === 'Escape') {
    closePlayer();
  }
  if (e.key === ' ' && !isClipTitleFocused) {
    if (videoPlayer.src) {
      e.preventDefault();
      togglePlayPause();
    }
  }
}

// Optionally, you can add this event listener if you want to use handleKeyPress
document.addEventListener('keydown', handleKeyPress);

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

async function updateClipDisplay(originalName) {
  const clipElement = document.querySelector(`.clip-item[data-original-name="${originalName}"]`);
  if (!clipElement) return;

  try {
    const clipInfo = await ipcRenderer.invoke('get-clip-info', originalName);
    const trimData = await ipcRenderer.invoke("get-trim", originalName);
    const isTrimmed = trimData !== null;

    const scissorsIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`;

    // Remove existing trimmed indicator if it exists
    const existingIndicator = clipElement.querySelector('.trimmed-indicator');
    if (existingIndicator) {
      existingIndicator.remove();
    }

    // Add new trimmed indicator if the clip is trimmed
    if (isTrimmed) {
      const indicatorElement = document.createElement('div');
      indicatorElement.className = 'trimmed-indicator';
      indicatorElement.title = 'This video has been trimmed';
      indicatorElement.innerHTML = scissorsIcon;
      clipElement.appendChild(indicatorElement);
    }

  } catch (error) {
    console.error(`Error updating clip display for ${originalName}:`, error);
  }
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
        trimEndTime
      );
      console.log("Trim data saved successfully");
      await updateClipDisplay(currentClip.originalName);
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
    if (!originalName) {
      console.warn("Attempted to save title change, but no original name provided.");
      return;
    }

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
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error("Error saving custom name:", error);
      await showCustomAlert(`Failed to save custom name. Please try again later. Error: ${error.message}`);
      clipTitle.value = oldCustomName; // Revert to the original name
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
    console.warn("Attempted to update clip name in library with undefined originalName");
    return;
  }

  const clipElement = clipGrid.querySelector(`[data-original-name="${originalName}"]`);
  if (clipElement) {
    const clipNameElement = clipElement.querySelector('.clip-name');
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

document.getElementById('clip-grid').addEventListener('click', async (event) => {
  const clipItem = event.target.closest('.clip-item');
  if (clipItem) {
    const originalName = clipItem.dataset.originalName;
    const customName = clipItem.querySelector('.clip-name').textContent;
    currentCleanup = await openClip(originalName, customName);
  }
});

function showCustomAlert(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-modal');
    const modalMessage = document.getElementById('modal-message');
    const modalOk = document.getElementById('modal-ok');
    const modalCancel = document.getElementById('modal-cancel');

    modalMessage.textContent = message;
    modalCancel.style.display = 'none';
    modal.style.display = 'block';

    modalOk.onclick = () => {
      modal.style.display = 'none';
      resolve();
    };
  });
}

function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-modal');
    const modalMessage = document.getElementById('modal-message');
    const modalOk = document.getElementById('modal-ok');
    const modalCancel = document.getElementById('modal-cancel');

    modalMessage.textContent = message;
    modalCancel.style.display = 'inline-block';
    modal.style.display = 'block';

    modalOk.onclick = () => {
      modal.style.display = 'none';
      resolve(true);
    };

    modalCancel.onclick = () => {
      modal.style.display = 'none';
      resolve(false);
    };
  });
}

// Initial load
loadClips();