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

// --- Telemetry bridge -------------------------------------------------------
//
// Fire-and-forget onto the `telemetry-report` channel (main/telemetry does the
// coalescing, queueing and upload). Preload owns a small batcher of its own
// because the invoke wrapper below records a metric on EVERY IPC call, and
// because preload emits before the renderer bundle exists. Nothing here may
// throw into a call site.

const TELEMETRY_CHANNEL = "telemetry-report";
const TELEMETRY_FLUSH_MS = 5000;
// main drops anything past these per message.
const TELEMETRY_MAX_EVENTS = 50;
const TELEMETRY_MAX_METRICS = 100;
// Backstop between flushes; a burst that big is already a bug of its own.
const TELEMETRY_MAX_PENDING = 500;

let telemetryEvents = [];
let telemetryMetrics = [];
let telemetryTimer = null;

const sendTelemetry = (payload) => {
  try {
    ipcRenderer.send(TELEMETRY_CHANNEL, payload);
  } catch (_) {
    /* telemetry must never break the app */
  }
};

const flushTelemetry = () => {
  try {
    if (telemetryTimer) {
      clearTimeout(telemetryTimer);
      telemetryTimer = null;
    }
    if (telemetryEvents.length === 0 && telemetryMetrics.length === 0) return;
    const events = telemetryEvents;
    const metrics = telemetryMetrics;
    telemetryEvents = [];
    telemetryMetrics = [];
    while (events.length > 0 || metrics.length > 0) {
      sendTelemetry({
        events: events.splice(0, TELEMETRY_MAX_EVENTS),
        metrics: metrics.splice(0, TELEMETRY_MAX_METRICS),
      });
    }
  } catch (_) {
    /* telemetry must never break the app */
  }
};

const scheduleTelemetryFlush = () => {
  if (telemetryTimer) return;
  telemetryTimer = setTimeout(flushTelemetry, TELEMETRY_FLUSH_MS);
};

const queueTelemetryEvent = (event) => {
  if (telemetryEvents.length >= TELEMETRY_MAX_PENDING) return;
  telemetryEvents.push(event);
  scheduleTelemetryFlush();
};

const queueTelemetryMetric = (metric) => {
  if (telemetryMetrics.length >= TELEMETRY_MAX_PENDING) return;
  telemetryMetrics.push(metric);
  scheduleTelemetryFlush();
};

/** djb2, mirroring `hash32` in main/telemetry/index.js. */
const telemetryHash = (input) => {
  let h = 5381;
  const s = String(input);
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

try {
  window.addEventListener("beforeunload", flushTelemetry);
} catch (_) {
  /* no window yet — the interval flush still covers us */
}

/**
 * Build a request/response wrapper for an ipcMain.handle channel.
 *
 * Every channel is timed and every rejection is reported. The channel list is
 * our own fixed enum, so it is safe as a metric dim. The original rejection is
 * rethrown untouched: callers must see exactly what they saw before.
 */
const invoke = (channel) => (...args) => {
  const startedAt = Date.now();
  return ipcRenderer.invoke(channel, ...args).then(
    (value) => {
      queueTelemetryMetric({ name: "ipc.call_ms", value: Date.now() - startedAt, unit: "ms", dims: { channel } });
      return value;
    },
    (error) => {
      const ms = Date.now() - startedAt;
      queueTelemetryMetric({ name: "ipc.call_ms", value: ms, unit: "ms", dims: { channel } });
      queueTelemetryEvent({
        code: "ipc_call_rejected",
        kind: "silent_failure",
        severity: "warning",
        surface: "preload",
        // Per-channel fingerprint, otherwise main's coalescer would hide every
        // channel but the first one to fail in a 60s window.
        fingerprint: telemetryHash(`ipc_call_rejected|${channel}`),
        context: { channel, ms },
      });
      throw error;
    },
  );
};

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
  getClipsFolderSize: invoke("get-clips-folder-size"),
  markClipsWatched: invoke("mark-clips-watched"),
  deleteClip: invoke("delete-clip"),
  saveClipListImmediately: invoke("save-clip-list-immediately"),
  getClipLocation: invoke("get-clip-location"),
  setClipLocation: invoke("set-clip-location"),
  getGameIcon: invoke("get-game-icon"),
  getGameIconsBatch: invoke("get-game-icons-batch"),
  getClipParticipants: invoke("get-clip-participants"),

  // --- Per-clip metadata ---
  saveCustomName: invoke("save-custom-name"),
  getClipInfo: invoke("get-clip-info"),
  // Hover-preview start time (trim.start or cached-duration midpoint) in one
  // cheap round trip — never triggers ffprobe.
  getPreviewStartTime: invoke("get-preview-start-time"),
  // One-round-trip bundle of everything the player reads on clip open.
  getClipOpenState: invoke("get-clip-open-state"),
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
  // NOTE: no wrapper for "generate-thumbnail" (singular) — that main handler
  // predates generate-thumbnails-progressively and no renderer ever called it.
  generateThumbnailsProgressively: invoke("generate-thumbnails-progressively"),
  // Called by the wrapped legacy player directly via ipcRenderer today; the
  // wrapper exists so future React code can trigger trim-thumbnail regen.
  regenerateThumbnailForTrim: invoke("regenerate-thumbnail-for-trim"),

  // --- Export / files ---
  exportVideo: invoke("export-video"),
  exportTrimmedVideo: invoke("export-trimmed-video"),
  exportAudio: invoke("export-audio"),
  openSaveDialog: invoke("open-save-dialog"),
  revealClip: invoke("reveal-clip"),
  resetClipCache: invoke("reset-clip-cache"),

  // --- Settings ---
  // Concurrent-call dedupe: several modules request settings at startup in
  // the same tick; share the in-flight promise instead of 4+ parallel IPCs.
  // No caching — once resolved, the next call hits the channel again.
  getSettings: (() => {
    const call = invoke("get-settings");
    let inflight = null;
    return () => {
      if (!inflight) {
        inflight = call().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    };
  })(),
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
  shareApiRequest: invoke("share-api-request"),
  shareUploadBanner: invoke("share-upload-banner"),

  // --- Updates ---
  checkForUpdates: invoke("check-for-updates"),
  startUpdate: invoke("start-update"),
  openUpdatePage: invoke("open-update-page"),
  getAppVersion: invoke("get-app-version"),

  // --- Diagnostics / misc ---
  generateDiagnosticsZip: invoke("generate-diagnostics-zip"),
  uploadSessionLogs: invoke("upload-session-logs"),
  uploadDiagnosticsBundle: invoke("upload-diagnostics-bundle"),
  logWatchSession: invoke("log-watch-session"),
  getFfmpegVersion: invoke("get-ffmpeg-version"),
  getExportAccelerationStatus: invoke("get-export-acceleration-status"),
  importSteelseriesClips: invoke("import-steelseries-clips"),
  quitApp: invoke("quit-app"),

  // --- Integrated clipdip ---
  clipdip: (() => {
    const controlInvoke = invoke("clipdip-control");
    const control = (cmd, args) => controlInvoke({ cmd, args });
    return {
      getConfig: invoke("clipdip-get-config"),
      setConfig: invoke("clipdip-set-config"),
      getStatus: invoke("clipdip-status"),
      start: invoke("clipdip-start"),
      stop: invoke("clipdip-stop"),
      restart: invoke("clipdip-restart"),
      setAutostart: invoke("clipdip-set-autostart"),
      setEnabled: invoke("clipdip-set-enabled"),
      // Stateless CLI queries (work without a running instance).
      listAudioDevices: invoke("clipdip-list-audio-devices"),
      listMonitors: invoke("clipdip-list-monitors"),
      getFilenameVariables: invoke("clipdip-filename-variables"),
      previewFilename: invoke("clipdip-preview-filename"),
      // Control server on the running instance; {ok:false,error:"not_running"}
      // when it isn't up.
      control,
      getLiveStatus: () => control("status"),
      testOverlay: (stage) => control("test_overlay", { stage }),
      discordConnect: () => control("discord_connect"),
      discordDisconnect: () => control("discord_disconnect"),
      getTelemetryStatus: () => control("get_telemetry_status"),
      setTelemetryEnabled: (enabled) => control("set_telemetry_enabled", { enabled }),
      uploadDiagnostics: (note) => control("upload_diagnostics_bundle", { note: note ?? null }),
      openClipsFolder: () => control("open_clips_folder"),
    };
  })(),

  // --- Signal to main (fire-and-forget) ---
  rendererReady: () => ipcRenderer.send("renderer-ready"),

  // --- Telemetry (fire-and-forget) ---
  // The renderer bundle is ESM and can't reach ipcRenderer itself, so the
  // renderer client (src/renderer/telemetry) posts its batches through here.
  telemetryReport: (payload) => sendTelemetry(payload),

  // --- Events (main -> renderer); each returns an unsubscribe fn ---
  onLog: subscribe("log"),
  onNewClipAdded: subscribe("new-clip-added"),
  onCheckActivityState: subscribe("check-activity-state"),
  onCliplibAuthEvent: subscribe("cliplib-auth-event"),
  onCliplibNavigate: subscribe("cliplib-navigate"),
  onAppUpdated: subscribe("app-updated"),
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
let legacyModuleIndex = 0;
try {
  window.legacyState = require("./player-legacy/state.js");
  legacyModuleIndex = 1;
  window.legacyPlayer = require("./player-legacy/video-player.js");
  legacyModuleIndex = 2;
  window.legacyVolumeRange = require("./player-legacy/volume-range-controls.js");
} catch (err) {
  // Non-fatal: the library still works; the player just won't open.
  console.error("[preload] failed to load legacy player:", err);
  // Which is a total feature outage that used to reach the console only. Sent
  // straight out rather than batched: the renderer client isn't loaded yet.
  sendTelemetry({
    events: [
      {
        code: "legacy_player_load_failed",
        kind: "crash",
        severity: "fatal",
        surface: "preload",
        fingerprint: telemetryHash(`legacy_player_load_failed|${legacyModuleIndex}`),
        context: {
          module_index: legacyModuleIndex,
          error_name: err && err.name ? String(err.name) : undefined,
        },
      },
    ],
  });
}
