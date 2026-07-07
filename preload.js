// Preload for the new React renderer (plan D2/D9).
//
// The main window runs with contextIsolation:false + nodeIntegration:true
// (unchanged from the legacy renderer), so this preload shares the renderer's
// `window` object and can attach the facade directly. New React code talks to
// the main process ONLY through `window.clips.*`; wrapped legacy modules keep
// using `require('electron')` directly (Phase 4).
//
// Method names are camelCase wrappers over the kebab-case IPC channels verified
// in plan §5. Argument forwarding is transparent — whatever the caller passes is
// handed to the channel, so payload shapes live with the caller + clips.d.ts.

const { ipcRenderer } = require("electron");

/** Build a request/response wrapper for an ipcMain.handle channel. */
const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

/** Subscribe to a main->renderer event; returns an unsubscribe function. */
const subscribe = (channel) => (callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api = {
  // --- Clips ---
  getClips: invoke("get-clips"),
  getNewClipInfo: invoke("get-new-clip-info"),
  getNewClipsInfo: invoke("get-new-clips-info"),
  deleteClip: invoke("delete-clip"),
  saveClipListImmediately: invoke("save-clip-list-immediately"),
  getClipLocation: invoke("get-clip-location"),
  setClipLocation: invoke("set-clip-location"),
  getGameIcon: invoke("get-game-icon"),
  getGameIconsBatch: invoke("get-game-icons-batch"),

  // --- Per-clip metadata ---
  saveCustomName: invoke("save-custom-name"),
  getClipInfo: invoke("get-clip-info"),
  getTrim: invoke("get-trim"),
  saveTrim: invoke("save-trim"),
  deleteTrim: invoke("delete-trim"),
  getSpeed: invoke("get-speed"),
  saveSpeed: invoke("save-speed"),
  getVolume: invoke("get-volume"),
  saveVolume: invoke("save-volume"),
  getVolumeRange: invoke("get-volume-range"),
  saveVolumeRange: invoke("save-volume-range"),
  getClipTags: invoke("get-clip-tags"),
  getClipTagsBatch: invoke("get-clip-tags-batch"),
  saveClipTags: invoke("save-clip-tags"),

  // --- Audio tracks ---
  extractAudioTracks: invoke("extract-audio-tracks"),
  getTrackState: invoke("get-track-state"),
  saveTrackState: invoke("save-track-state"),
  getTrackPreferences: invoke("get-track-preferences"),
  saveTrackPreferences: invoke("save-track-preferences"),

  // --- Global tags ---
  loadGlobalTags: invoke("load-global-tags"),
  saveGlobalTags: invoke("save-global-tags"),
  restoreMissingGlobalTags: invoke("restore-missing-global-tags"),
  removeTagFromAllClips: invoke("remove-tag-from-all-clips"),
  updateTagInAllClips: invoke("update-tag-in-all-clips"),
  getTagPreferences: invoke("get-tag-preferences"),
  saveTagPreferences: invoke("save-tag-preferences"),

  // --- Thumbnails ---
  getThumbnailPath: invoke("get-thumbnail-path"),
  getThumbnailPathsBatch: invoke("get-thumbnail-paths-batch"),
  generateThumbnail: invoke("generate-thumbnail"),
  generateThumbnailsProgressively: invoke("generate-thumbnails-progressively"),
  regenerateThumbnailForTrim: invoke("regenerate-thumbnail-for-trim"),

  // --- Export / files ---
  exportVideo: invoke("export-video"),
  exportTrimmedVideo: invoke("export-trimmed-video"),
  exportAudio: invoke("export-audio"),
  openSaveDialog: invoke("open-save-dialog"),
  revealClip: invoke("reveal-clip"),
  resetClipCache: invoke("reset-clip-cache"),

  // --- Settings ---
  getSettings: invoke("get-settings"),
  saveSettings: invoke("save-settings"),
  getDefaultKeybindings: invoke("get-default-keybindings"),

  // --- Dialogs ---
  openFolderDialog: invoke("open-folder-dialog"),
  openFolderDialogSteelseries: invoke("open-folder-dialog-steelseries"),
  showDiagnosticsSaveDialog: invoke("show-diagnostics-save-dialog"),

  // --- Discord RPC ---
  updateDiscordPresence: invoke("update-discord-presence"),
  toggleDiscordRpc: invoke("toggle-discord-rpc"),
  clearDiscordPresence: invoke("clear-discord-presence"),

  // --- Share / ClipLib ---
  testShareConnection: invoke("test-share-connection"),
  startCliplibAuth: invoke("start-cliplib-auth"),
  disconnectCliplibAuth: invoke("disconnect-cliplib-auth"),
  shareClip: invoke("share-clip"),
  getShareUsers: invoke("get-share-users"),

  // --- Updates ---
  checkForUpdates: invoke("check-for-updates"),
  getAppVersion: invoke("get-app-version"),

  // --- Diagnostics / misc ---
  generateDiagnosticsZip: invoke("generate-diagnostics-zip"),
  uploadSessionLogs: invoke("upload-session-logs"),
  logWatchSession: invoke("log-watch-session"),
  getFfmpegVersion: invoke("get-ffmpeg-version"),
  getExportAccelerationStatus: invoke("get-export-acceleration-status"),
  importSteelseriesClips: invoke("import-steelseries-clips"),
  quitApp: invoke("quit-app"),

  // --- Signal to main (fire-and-forget) ---
  rendererReady: () => ipcRenderer.send("renderer-ready"),

  // --- Events (main -> renderer); each returns an unsubscribe fn ---
  onLog: subscribe("log"),
  onNewClipAdded: subscribe("new-clip-added"),
  onCheckActivityState: subscribe("check-activity-state"),
  onCliplibAuthEvent: subscribe("cliplib-auth-event"),
  onExportProgress: subscribe("export-progress"),
  onShowFallbackNotice: subscribe("show-fallback-notice"),
  onShowDecodeFallbackNotice: subscribe("show-decode-fallback-notice"),
  onThumbnailValidationStart: subscribe("thumbnail-validation-start"),
  onThumbnailProgress: subscribe("thumbnail-progress"),
  onThumbnailGenerated: subscribe("thumbnail-generated"),
  onThumbnailGenerationFailed: subscribe("thumbnail-generation-failed"),
  onThumbnailGenerationComplete: subscribe("thumbnail-generation-complete"),
  onSteelseriesProgress: subscribe("steelseries-progress"),
  onSteelseriesLog: subscribe("steelseries-log"),
  onShowUpdateNotification: subscribe("show-update-notification"),
  onDownloadProgress: subscribe("download-progress"),
  onUpdateDownloadError: subscribe("update-download-error"),
  onUpdateDownloadComplete: subscribe("update-download-complete"),
  onShareUploadProgress: subscribe("share-upload-progress"),
  onDiagnosticsProgress: subscribe("diagnostics-progress"),
};

// contextIsolation is OFF, so a direct assignment is visible to the renderer.
window.clips = api;

// Bridge for the performance profiler (src/renderer/perf) — ONLY when launched
// via `npm run dev:trace` (which sets CLIPS_PERF_STARTUP=1, inherited by this
// renderer process). Not in normal `npm run dev`, not in packaged builds. The
// renderer checks `window.__perfEnabled` before loading any profiler code; the
// bundled ESM renderer can't reach ipcRenderer itself, so the preload provides
// the channel here.
try {
  if (process.env.CLIPS_PERF_STARTUP === "1") {
    window.__perfEnabled = true;
    window.__perfIpc = {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      on: (channel, cb) => ipcRenderer.on(channel, (_event, ...args) => cb(...args)),
    };
  }
} catch (_) {
  /* env unavailable — skip; profiler stays off */
}

// Legacy video player (plan D1/Phase 4): run the crown-jewel player + audio
// engine VERBATIM. Required here (preload has Node + a real __dirname) and
// exposed on window; contextIsolation is off so these modules share the
// renderer's window/document once init() is called from React. Copied under
// player-legacy/ (only patch: `../utils/logger` -> `./logger`).
try {
  window.legacyState = require("./player-legacy/state.js");
  window.legacyPlayer = require("./player-legacy/video-player.js");
  window.legacyVolumeRange = require("./player-legacy/volume-range-controls.js");
} catch (err) {
  // Non-fatal: the library still works; the player just won't open.
  console.error("[preload] failed to load legacy player:", err);
}
