// global renderer state, module-level vars behind getters/setters below; use as state.variableName
const CACHE_EXPIRY_MS = 60000;
const GRID_NAVIGATION_THROTTLE = 200;

// media & playback
let audioContext = null;
let gainNode = null;
let initialPlaybackTime = 0;
let currentClip = null;
let trimStartTime = 0;
let trimEndTime = 0;
let speedBeforeSpaceHold = 1;

// ui
let lastActivityTime = Date.now();
let isDragging = null;
let isDraggingTrim = false;
let isMouseDown = false;
let dragStartX = 0;
let dragThreshold = 5;
let lastMousePosition = { x: 0, y: 0 };
let isLoading = false;
let controlsTimeout = null;
let isMouseOverControls = false;
let isFrameStepping = false;
let frameStepDirection = 0;
let lastFrameStepTime = 0;
let pendingFrameStep = false;
let deletionTooltip = null;
let deletionTimeout = null;
let isSpaceHeld = false;
let spaceHoldTimeoutId = null;
let wasSpaceHoldBoostActive = false;
let isRendering = false;
let isTagsDropdownOpen = false;

// clips & library
let currentClipList = [];
let allClips = [];
let clipLocation = null;
let contextMenuClip = null;
let selectedClips = new Set();
let selectionStartIndex = -1;

const clipDataCache = new Map();
const thumbnailPathCache = new Map();

// tags & filtering
let selectedTags = new Set();
let savedTagSelections = new Set(); // saved permanently
let temporaryTagSelections = new Set(); // ctrl+click, not saved
let isInTemporaryMode = false;

// volume range
let volumeStartTime = 0;
let volumeEndTime = 0;
let volumeLevel = 0; // Volume level for the range
let isVolumeDragging = null;
let volumeStartElement = null;
let volumeEndElement = null;
let volumeRegionElement = null;
let volumeDragControl = null;
let isVolumeControlsVisible = false;

// settings & discord
let settings = null;
let discordPresenceInterval = null;
let clipStartTime = null;
let elapsedTime = 0;

let processingTimeout = null;
let diagnosticsInProgress = false;
let diagnosticsStatusEl = null;
let generateDiagnosticsBtn = null;
const diagnosticsButtonDefaultLabel = 'Generate Zip';
let uploadLogsInProgress = false;
let uploadLogsStatusEl = null;
let uploadLogsBtn = null;
const uploadLogsButtonDefaultLabel = 'Upload Logs';

let activePreview = null;
let previewCleanupTimeout = null;

// thumbnail generation
let isGeneratingThumbnails = false;
let currentGenerationTotal = 0;
let completedThumbnails = 0;
let thumbnailGenerationStartTime = 0;

let isAutoResetDisabled = false; // true when user manually seeked outside bounds
let wasLastSeekManual = false;

let gamepadManager = null;
let isGamepadActive = false;

let currentGridFocusIndex = 0;
let gridNavigationEnabled = false;
let lastGridNavigationTime = 0;
let mouseKeyboardListenersSetup = false;

let loadingScreen = null;
let currentCleanup = null;

module.exports = {
  CACHE_EXPIRY_MS,
  GRID_NAVIGATION_THROTTLE,
  diagnosticsButtonDefaultLabel,
  uploadLogsButtonDefaultLabel,

  // Media & Playback State
  get audioContext() { return audioContext; },
  set audioContext(value) { audioContext = value; },
  get gainNode() { return gainNode; },
  set gainNode(value) { gainNode = value; },
  get initialPlaybackTime() { return initialPlaybackTime; },
  set initialPlaybackTime(value) { initialPlaybackTime = value; },
  get currentClip() { return currentClip; },
  set currentClip(value) { currentClip = value; },
  get trimStartTime() { return trimStartTime; },
  set trimStartTime(value) { trimStartTime = value; },
  get trimEndTime() { return trimEndTime; },
  set trimEndTime(value) { trimEndTime = value; },
  get speedBeforeSpaceHold() { return speedBeforeSpaceHold; },
  set speedBeforeSpaceHold(value) { speedBeforeSpaceHold = value; },

  get lastActivityTime() { return lastActivityTime; },
  set lastActivityTime(value) { lastActivityTime = value; },
  get isDragging() { return isDragging; },
  set isDragging(value) { isDragging = value; },
  get isDraggingTrim() { return isDraggingTrim; },
  set isDraggingTrim(value) { isDraggingTrim = value; },
  get isMouseDown() { return isMouseDown; },
  set isMouseDown(value) { isMouseDown = value; },
  get dragStartX() { return dragStartX; },
  set dragStartX(value) { dragStartX = value; },
  get dragThreshold() { return dragThreshold; },
  get lastMousePosition() { return lastMousePosition; },
  set lastMousePosition(value) { lastMousePosition = value; },
  get isLoading() { return isLoading; },
  set isLoading(value) { isLoading = value; },
  get controlsTimeout() { return controlsTimeout; },
  set controlsTimeout(value) { controlsTimeout = value; },
  get isMouseOverControls() { return isMouseOverControls; },
  set isMouseOverControls(value) { isMouseOverControls = value; },
  get isFrameStepping() { return isFrameStepping; },
  set isFrameStepping(value) { isFrameStepping = value; },
  get frameStepDirection() { return frameStepDirection; },
  set frameStepDirection(value) { frameStepDirection = value; },
  get lastFrameStepTime() { return lastFrameStepTime; },
  set lastFrameStepTime(value) { lastFrameStepTime = value; },
  get pendingFrameStep() { return pendingFrameStep; },
  set pendingFrameStep(value) { pendingFrameStep = value; },
  get deletionTooltip() { return deletionTooltip; },
  set deletionTooltip(value) { deletionTooltip = value; },
  get deletionTimeout() { return deletionTimeout; },
  set deletionTimeout(value) { deletionTimeout = value; },
  get isSpaceHeld() { return isSpaceHeld; },
  set isSpaceHeld(value) { isSpaceHeld = value; },
  get spaceHoldTimeoutId() { return spaceHoldTimeoutId; },
  set spaceHoldTimeoutId(value) { spaceHoldTimeoutId = value; },
  get wasSpaceHoldBoostActive() { return wasSpaceHoldBoostActive; },
  set wasSpaceHoldBoostActive(value) { wasSpaceHoldBoostActive = value; },
  get isRendering() { return isRendering; },
  set isRendering(value) { isRendering = value; },
  get isTagsDropdownOpen() { return isTagsDropdownOpen; },
  set isTagsDropdownOpen(value) { isTagsDropdownOpen = value; },

  get currentClipList() { return currentClipList; },
  set currentClipList(value) { currentClipList = value; },
  get allClips() { return allClips; },
  set allClips(value) { allClips = value; },
  get clipLocation() { return clipLocation; },
  set clipLocation(value) { clipLocation = value; },
  get contextMenuClip() { return contextMenuClip; },
  set contextMenuClip(value) { contextMenuClip = value; },
  get selectedClips() { return selectedClips; },
  set selectedClips(value) { selectedClips = value; },
  get selectionStartIndex() { return selectionStartIndex; },
  set selectionStartIndex(value) { selectionStartIndex = value; },

  clipDataCache,
  thumbnailPathCache,

  get selectedTags() { return selectedTags; },
  set selectedTags(value) { selectedTags = value; },
  get savedTagSelections() { return savedTagSelections; },
  set savedTagSelections(value) { savedTagSelections = value; },
  get temporaryTagSelections() { return temporaryTagSelections; },
  set temporaryTagSelections(value) { temporaryTagSelections = value; },
  get isInTemporaryMode() { return isInTemporaryMode; },
  set isInTemporaryMode(value) { isInTemporaryMode = value; },

  get volumeStartTime() { return volumeStartTime; },
  set volumeStartTime(value) { volumeStartTime = value; },
  get volumeEndTime() { return volumeEndTime; },
  set volumeEndTime(value) { volumeEndTime = value; },
  get volumeLevel() { return volumeLevel; },
  set volumeLevel(value) { volumeLevel = value; },
  get isVolumeDragging() { return isVolumeDragging; },
  set isVolumeDragging(value) { isVolumeDragging = value; },
  get volumeStartElement() { return volumeStartElement; },
  set volumeStartElement(value) { volumeStartElement = value; },
  get volumeEndElement() { return volumeEndElement; },
  set volumeEndElement(value) { volumeEndElement = value; },
  get volumeRegionElement() { return volumeRegionElement; },
  set volumeRegionElement(value) { volumeRegionElement = value; },
  get volumeDragControl() { return volumeDragControl; },
  set volumeDragControl(value) { volumeDragControl = value; },
  get isVolumeControlsVisible() { return isVolumeControlsVisible; },
  set isVolumeControlsVisible(value) { isVolumeControlsVisible = value; },

  get settings() { return settings; },
  set settings(value) { settings = value; },
  get discordPresenceInterval() { return discordPresenceInterval; },
  set discordPresenceInterval(value) { discordPresenceInterval = value; },
  get clipStartTime() { return clipStartTime; },
  set clipStartTime(value) { clipStartTime = value; },
  get elapsedTime() { return elapsedTime; },
  set elapsedTime(value) { elapsedTime = value; },

  get processingTimeout() { return processingTimeout; },
  set processingTimeout(value) { processingTimeout = value; },
  get diagnosticsInProgress() { return diagnosticsInProgress; },
  set diagnosticsInProgress(value) { diagnosticsInProgress = value; },
  get diagnosticsStatusEl() { return diagnosticsStatusEl; },
  set diagnosticsStatusEl(value) { diagnosticsStatusEl = value; },
  get generateDiagnosticsBtn() { return generateDiagnosticsBtn; },
  set generateDiagnosticsBtn(value) { generateDiagnosticsBtn = value; },
  get uploadLogsInProgress() { return uploadLogsInProgress; },
  set uploadLogsInProgress(value) { uploadLogsInProgress = value; },
  get uploadLogsStatusEl() { return uploadLogsStatusEl; },
  set uploadLogsStatusEl(value) { uploadLogsStatusEl = value; },
  get uploadLogsBtn() { return uploadLogsBtn; },
  set uploadLogsBtn(value) { uploadLogsBtn = value; },

  get activePreview() { return activePreview; },
  set activePreview(value) { activePreview = value; },
  get previewCleanupTimeout() { return previewCleanupTimeout; },
  set previewCleanupTimeout(value) { previewCleanupTimeout = value; },

  get isGeneratingThumbnails() { return isGeneratingThumbnails; },
  set isGeneratingThumbnails(value) { isGeneratingThumbnails = value; },
  get currentGenerationTotal() { return currentGenerationTotal; },
  set currentGenerationTotal(value) { currentGenerationTotal = value; },
  get completedThumbnails() { return completedThumbnails; },
  set completedThumbnails(value) { completedThumbnails = value; },
  get thumbnailGenerationStartTime() { return thumbnailGenerationStartTime; },
  set thumbnailGenerationStartTime(value) { thumbnailGenerationStartTime = value; },

  get isAutoResetDisabled() { return isAutoResetDisabled; },
  set isAutoResetDisabled(value) { isAutoResetDisabled = value; },
  get wasLastSeekManual() { return wasLastSeekManual; },
  set wasLastSeekManual(value) { wasLastSeekManual = value; },

  get gamepadManager() { return gamepadManager; },
  set gamepadManager(value) { gamepadManager = value; },
  get isGamepadActive() { return isGamepadActive; },
  set isGamepadActive(value) { isGamepadActive = value; },

  get currentGridFocusIndex() { return currentGridFocusIndex; },
  set currentGridFocusIndex(value) { currentGridFocusIndex = value; },
  get gridNavigationEnabled() { return gridNavigationEnabled; },
  set gridNavigationEnabled(value) { gridNavigationEnabled = value; },
  get lastGridNavigationTime() { return lastGridNavigationTime; },
  set lastGridNavigationTime(value) { lastGridNavigationTime = value; },
  get mouseKeyboardListenersSetup() { return mouseKeyboardListenersSetup; },
  set mouseKeyboardListenersSetup(value) { mouseKeyboardListenersSetup = value; },

  get loadingScreen() { return loadingScreen; },
  set loadingScreen(value) { loadingScreen = value; },
  get currentCleanup() { return currentCleanup; },
  set currentCleanup(value) { currentCleanup = value; }
};
