// Preload for the React renderer (plan D2/D9). contextIsolation:false +
// nodeIntegration:true, so window.clips.* is a direct facade; legacy modules
// still require('electron') themselves. camelCase wraps kebab-case IPC (section 5).

const { ipcRenderer } = require("electron");

// Boot timeline for benchmark/cold-start.js (CLIPLIB_BOOT_TRACE=1, 2 or 3).
const bootTrace = (() => {
  try {
    if (!["1", "2", "3"].includes(process.env.CLIPLIB_BOOT_TRACE)) return null;
    const mark = (name, t) => {
      try {
        ipcRenderer.send("boot-trace-mark", {
          name,
          t: typeof t === "number" ? t : performance.timeOrigin + performance.now(),
        });
      } catch (_) {
        /* tracing must never break the app */
      }
    };
    mark("preload_start");
    return { mark };
  } catch (_) {
    return null;
  }
})();

// telemetry bridge: fire-and-forget onto `telemetry-report` (main coalesces
// queues, uploads); preload batches its own since invoke() below meters every call.

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
  /* no window yet, interval flush still covers us */
}

/** wraps an ipcMain.handle channel: times it, reports rejections
 * (channel is a fixed enum, safe as a metric dim), rethrows untouched. */
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
        // per-channel, else main's coalescer hides all but the first to fail in 60s
        fingerprint: telemetryHash(`ipc_call_rejected|${channel}`),
        context: { channel, ms },
      });
      throw error;
    },
  );
};

/** Subscribe to a main-to-renderer event; returns an unsubscribe function. */
const subscribe = (channel) => (callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api = {
  // clips
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

  // per-clip metadata
  saveCustomName: invoke("save-custom-name"),
  getClipInfo: invoke("get-clip-info"),
  // hover-preview start time (trim.start or cached-duration midpoint); never triggers ffprobe
  getPreviewStartTime: invoke("get-preview-start-time"),
  // one round trip, everything the player reads on clip open
  getClipOpenState: invoke("get-clip-open-state"),
  warmClipOpen: invoke("warm-clip-open"),
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

  // audio tracks
  extractAudioTracks: invoke("extract-audio-tracks"),
  getTrackState: invoke("get-track-state"),
  saveTrackState: invoke("save-track-state"),
  getTrackPreferences: invoke("get-track-preferences"),
  saveTrackPreferences: invoke("save-track-preferences"),

  // global tags
  loadGlobalTags: invoke("load-global-tags"),
  saveGlobalTags: invoke("save-global-tags"),
  restoreMissingGlobalTags: invoke("restore-missing-global-tags"),
  removeTagFromAllClips: invoke("remove-tag-from-all-clips"),
  updateTagInAllClips: invoke("update-tag-in-all-clips"),
  getTagPreferences: invoke("get-tag-preferences"),
  saveTagPreferences: invoke("save-tag-preferences"),

  // thumbnails
  getThumbnailPath: invoke("get-thumbnail-path"),
  getThumbnailPathsBatch: invoke("get-thumbnail-paths-batch"),
  // no wrapper for "generate-thumbnail" (singular): predates this, unused
  generateThumbnailsProgressively: invoke("generate-thumbnails-progressively"),
  // legacy player calls this via ipcRenderer today; wrapper is for future React code
  regenerateThumbnailForTrim: invoke("regenerate-thumbnail-for-trim"),

  // export / files
  exportVideo: invoke("export-video"),
  exportTrimmedVideo: invoke("export-trimmed-video"),
  exportAudio: invoke("export-audio"),
  openSaveDialog: invoke("open-save-dialog"),
  revealClip: invoke("reveal-clip"),
  resetClipCache: invoke("reset-clip-cache"),

  // settings: dedupe concurrent startup calls (share in-flight promise, not cached)
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

  // dialogs
  openFolderDialog: invoke("open-folder-dialog"),
  openFolderDialogSteelseries: invoke("open-folder-dialog-steelseries"),
  showDiagnosticsSaveDialog: invoke("show-diagnostics-save-dialog"),

  // discord rpc
  updateDiscordPresence: invoke("update-discord-presence"),
  toggleDiscordRpc: invoke("toggle-discord-rpc"),
  clearDiscordPresence: invoke("clear-discord-presence"),

  // share / cliplib
  testShareConnection: invoke("test-share-connection"),
  startCliplibAuth: invoke("start-cliplib-auth"),
  disconnectCliplibAuth: invoke("disconnect-cliplib-auth"),
  shareClip: invoke("share-clip"),
  getShareUsers: invoke("get-share-users"),
  shareApiRequest: invoke("share-api-request"),
  shareUploadBanner: invoke("share-upload-banner"),

  // updates
  checkForUpdates: invoke("check-for-updates"),
  startUpdate: invoke("start-update"),
  openUpdatePage: invoke("open-update-page"),
  getAppVersion: invoke("get-app-version"),

  // diagnostics / misc
  generateDiagnosticsZip: invoke("generate-diagnostics-zip"),
  uploadSessionLogs: invoke("upload-session-logs"),
  uploadDiagnosticsBundle: invoke("upload-diagnostics-bundle"),
  logWatchSession: invoke("log-watch-session"),
  getFfmpegVersion: invoke("get-ffmpeg-version"),
  getExportAccelerationStatus: invoke("get-export-acceleration-status"),
  importSteelseriesClips: invoke("import-steelseries-clips"),
  quitApp: invoke("quit-app"),

  // benchmark runner: handlers only exist under CLIPS_BENCHMARK=1, same guard as the caller
  benchmarkGetResults: invoke("benchmark:getResults"),
  benchmarkOutputResult: invoke("benchmark:outputResult"),
  benchmarkOutputMarker: invoke("benchmark:outputMarker"),
  benchmarkOutputComplete: invoke("benchmark:outputComplete"),
  benchmarkQuit: invoke("benchmark:quit"),

  // integrated clipdip
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
      // stateless CLI queries, work without a running instance
      listAudioDevices: invoke("clipdip-list-audio-devices"),
      listMonitors: invoke("clipdip-list-monitors"),
      getFilenameVariables: invoke("clipdip-filename-variables"),
      previewFilename: invoke("clipdip-preview-filename"),
      // control server on the running instance; {ok:false,error:"not_running"} when down
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

  // signal to main (fire-and-forget)
  rendererReady: () => ipcRenderer.send("renderer-ready"),

  // telemetry (fire-and-forget): ESM renderer bundle can't reach ipcRenderer directly
  telemetryReport: (payload) => sendTelemetry(payload),

  // events, main to renderer; each returns an unsubscribe fn
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

  // boot reveal (src/renderer/boot/bootReveal.ts)
  getBootLogoRect: invoke("get-boot-logo-rect"),
  onBootReveal: subscribe("boot-reveal"),
  bootRevealArmed: () => ipcRenderer.send("boot-reveal-armed"),
  bootRevealFrames: (stats) => ipcRenderer.send("boot-reveal-frames", stats),
};

// contextIsolation is OFF, so a direct assignment is visible to the renderer.
window.clips = api;
if (bootTrace) window.__bootTrace = bootTrace;

// Vite bundle can't reliably read process.env, so preload parses CLIPS_BENCHMARK*
// and hands over the values; old audio-compare impl kept alongside the React runtime.
try {
  if (process.env.CLIPS_BENCHMARK === "1") {
    let scenarios = [];
    try {
      const parsed = JSON.parse(process.env.CLIPS_BENCHMARK_SCENARIOS || "[]");
      if (Array.isArray(parsed)) scenarios = parsed.map(String);
    } catch (_) {
      /* runtime reports an empty scenario list as a fatal benchmark error */
    }
    window.__benchmarkConfig = { enabled: true, scenarios };
    const audioBench = require("./benchmark/audio-track-bench");
    const audioScenarios = {
      playback_cpu_compare: audioBench.benchmarkPlaybackCPUCompare,
      open_phases_compare: audioBench.benchmarkOpenPhasesCompare,
      seek_burst_compare: audioBench.benchmarkSeekBurstCompare,
      memory_footprint_compare: audioBench.benchmarkMemoryFootprintCompare,
    };
    window.__runAudioBenchmark = (scenario, harness) => {
      const run = audioScenarios[scenario];
      if (!run) throw new Error(`Unknown audio benchmark scenario: ${scenario}`);
      return run(harness);
    };
  }
} catch (error) {
  console.error("[benchmark] failed to initialize preload bridge", error);
}

// perf profiler bridge (src/renderer/perf): only under npm run dev:trace (sets
// CLIPS_PERF_STARTUP=1), never in dev or packaged; ESM renderer can't reach ipcRenderer itself.
try {
  if (process.env.CLIPS_PERF_STARTUP === "1") {
    window.__perfEnabled = true;
    window.__perfIpc = {
      invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
      on: (channel, cb) => ipcRenderer.on(channel, (_event, ...args) => cb(...args)),
    };
  }
} catch (_) {
  /* env unavailable, skip; profiler stays off */
}

// legacy player (plan D1/Phase 4) runs verbatim; preload has Node + real __dirname to
// require it and expose on window, shared once React calls init() (contextIsolation off).
let legacyModuleIndex = 0;
try {
  window.legacyState = require("./player-legacy/state.js");
  legacyModuleIndex = 1;
  window.legacyPlayer = require("./player-legacy/video-player.js");
  legacyModuleIndex = 2;
  window.legacyVolumeRange = require("./player-legacy/volume-range-controls.js");
} catch (err) {
  // non-fatal: the library still works; the player just won't open
  console.error("[preload] failed to load legacy player:", err);
  // total feature outage that used to only hit the console; sent straight
  // out (not batched) since the renderer client isn't loaded yet
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

if (bootTrace) bootTrace.mark("preload_done");
