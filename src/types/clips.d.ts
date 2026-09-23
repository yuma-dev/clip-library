// Ambient types for the window.clips IPC facade exposed by preload.js: typed
// seam between the React renderer and the unchanged Electron main process.
// Method names are camelCase wrappers over kebab-case IPC channels.

// mirror of clipdip's TOML config (clipdip crates/core/src/config.rs); every
// field is serde-defaulted on the Rust side, so partial objects are fine

/** Mode-tagged enum table; replaced whole on patch, never merged. */
export type ClipdipRateControl =
  | { mode: "constant_qp"; qp: number }
  | { mode: "vbr"; avg_bps: number };

export type ClipdipRecordingQuality =
  | { mode: "match_clips" }
  | { mode: "constant_qp"; qp: number };

/** Kind-tagged audio source entry; fallbacks is an ordered list of device ids
 *  tried when the entry above doesn't start ("default" = system default).
 *  device_name rides along with a pin so the engine can find the endpoint again
 *  after windows hands it a new id (usb port change, driver reinstall). */
export type ClipdipAudioSource =
  | { kind: "system_loopback"; device_id?: string; device_name?: string; fallbacks?: string[] }
  | { kind: "microphone"; device_id?: string; device_name?: string; fallbacks?: string[] }
  | { kind: "process_loopback"; process_name?: string };

export interface ClipdipConfig {
  replay_seconds?: number;
  video?: {
    output_index?: number;
    capture_backend?: "auto" | "wgc" | "dxgi";
    fps?: number;
    bitrate_bps?: number;
    include_cursor?: boolean;
    gop_seconds?: number;
    codec?: "prefer_av1" | "force_h264" | "force_av1";
    /** Bitrate ceiling override: absent = automatic per quality tier, 0 = uncapped, n = explicit bps. */
    quality_cap_bps?: number;
    rate_control?: ClipdipRateControl;
    recording_quality?: ClipdipRecordingQuality;
  };
  audio?: {
    sources?: ClipdipAudioSource[];
    include_mix?: boolean;
  };
  output?: {
    directory?: string;
    filename_stem?: string;
    ffmpeg_path?: string | null;
    keep_sidecars?: boolean;
    audio_bitrate_bps?: number;
  };
  hotkey?: {
    save_clip?: string;
    rename_clip?: string;
    toggle_recording?: string;
  };
  notifications?: {
    enabled?: boolean;
    sound?: boolean;
    corner?: "top_left" | "top_right" | "bottom_left" | "bottom_right";
    auto_dismiss_secs?: number;
    health_alerts?: boolean;
  };
  metadata?: {
    enabled?: boolean;
    capture_icon?: boolean;
    ignored_processes?: string[];
  };
  discord?: { enabled?: boolean };
  telemetry?: { enabled?: boolean };
  profile?: { report_interval_ms?: number };
  [key: string]: unknown;
}

/** Where a clip's playback volume comes from; gain fields only when source is normalized. */
export interface VolumeDetail {
  volume: number;
  source: "custom" | "normalized" | "default";
  measured: boolean;
  gain?: number;
  gainDb?: number;
  lufs?: number;
  /** headroom cap kept the clip under target so its peaks stay below -1 dBTP */
  capped?: boolean;
}

export interface AnalysisProgress {
  running: boolean;
  /** workers hold while a clip plays or an export runs */
  paused: boolean;
  pending: number;
  total: number;
  done: number;
  /** from the recent pace; null until a few clips have finished */
  etaSeconds: number | null;
}

export interface LoudnessEntry {
  name: string;
  lufs: number;
  peak: number | null;
}

/** one audio stream's level envelope, `rate` windows per second, dBFS (-90 is silence) */
export interface WaveformTrack {
  ordinal: number;
  streamIndex: number;
  peak: number[];
  rms: number[];
}

export interface ClipWaveform {
  rate: number;
  tracks: WaveformTrack[];
}

export interface LoudnessSummary {
  enabled: boolean;
  /** null means auto (library median) */
  targetLufs: number | null;
  effectiveTarget: number;
  median: number | null;
  headroomDbtp: number;
  maxGainDb: number;
  measured: number;
  entries: LoudnessEntry[];
  scan: AnalysisProgress;
}

/** WASAPI endpoint from `clipdip --list-audio-devices`. */
export interface AudioDeviceInfo {
  /** Stable WASAPI device ID; pin it via audio.sources[].device_id. */
  id: string;
  friendly_name: string;
  flow: "Render" | "Capture";
  /** System default endpoint for its flow. */
  is_default: boolean;
}

/** Display from `clipdip --list-monitors`; index maps to video.output_index. */
export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  is_primary?: boolean;
}

/** Filename template token from `clipdip --filename-variables`. */
export interface FilenameVariable {
  token: string;
  description: string;
  example?: string;
}

/** Discord RPC connection state (control status response's discord field). */
export type DiscordStatus =
  | { state: "disabled" }
  | { state: "connecting" }
  | { state: "discord_not_running" }
  | { state: "needs_authorization" }
  | { state: "connected"; user: string }
  | { state: "error"; message: string };

/** Control `status` response payload (merged with ok:true). */
export interface LiveStatus {
  pipeline_running: boolean;
  /** Most recent pipeline error; cleared when the pipeline (re)starts. */
  pipeline_error: string | null;
  buffer_stats: {
    measuring: boolean;
    mb_per_minute: number;
    clip_mb: number;
    buffered_secs: number;
  };
  discord: DiscordStatus;
  /** Per-source audio state (status's audio_sources): config wants vs what's actually recording, empty while down. */
  audio_sources?: ClipdipAudioSourceStatus[];
  version: string;
}

/** One audio source's live state, for the settings repair banner. */
export interface ClipdipAudioSourceStatus {
  index: number;
  kind: "system_loopback" | "microphone";
  /** Configured primary device's display name ("System default", a friendly name, or "(disconnected device)"). */
  wanted: string;
  /** Friendly name of the device actually recording; null = silent. */
  using: string | null;
  on_fallback: boolean;
  missing: boolean;
}

/** Generic control-server response; `not_running` when clipdip is down. */
export interface ClipdipControlResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

// telemetry wire payloads (preload to main via telemetry-report); context/dims:
// numbers/booleans/enum strings only, never names/paths/ids

export type TelemetryKind =
  | "crash"
  | "error"
  | "silent_failure"
  | "data_loss"
  | "degraded"
  | "custom";

export type TelemetrySeverity = "debug" | "info" | "warning" | "error" | "fatal";

/** Forced to one of these by main; anything else lands as `renderer`. */
export type TelemetrySurface = "renderer" | "player" | "preload" | "worker";

export interface TelemetryWireEvent {
  /** snake_case, 3-64 chars, matches /^[a-z0-9_]{3,64}$/. */
  code: string;
  kind?: TelemetryKind;
  severity?: TelemetrySeverity;
  surface?: TelemetrySurface;
  context?: Record<string, unknown>;
  message?: string;
  /** Grouping key; main coalesces on code + fingerprint. */
  fingerprint?: string;
  coalesceMs?: number;
}

export interface TelemetryWireMetric {
  name: string;
  value: number;
  unit?: "ms" | "bytes" | "count" | "ratio" | "mbps";
  /** Max three keys, enum-ish values; free strings explode cardinality. */
  dims?: Record<string, string | number | boolean>;
}

/** Max 50 events and 100 metrics per message; extras are dropped by main. */
export interface TelemetryReport {
  events?: TelemetryWireEvent[];
  metrics?: TelemetryWireMetric[];
}

type ClipsUnsubscribe = () => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClipsEventCallback = (...args: any[]) => void;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ClipsApi {
  getClips(): Promise<any[]>;
  getNewClipInfo(fileName: string): Promise<any>;
  /** Pass the names from getClips to spare main a second library walk. */
  getNewClipsInfo(knownNames?: string[]): Promise<{ newClips: string[]; totalNewCount?: number }>;
  /** Total disk usage (bytes) of the configured clip folder. Cached ~4 min in main. */
  getClipsFolderSize(): Promise<{ bytes: number }>;
  markClipsWatched(clipNames: string[]): Promise<void>;
  deleteClip(clip: any): Promise<any>;
  saveClipListImmediately(): Promise<any>;
  getClipLocation(): Promise<string>;
  setClipLocation(location: string): Promise<any>;
  getGameIcon(game: string): Promise<any>;
  getGameIconsBatch(
    clipNames: string[],
  ): Promise<Record<string, { path: string | null; title: string | null; discord: unknown } | null>>;
  getClipParticipants(clipNames: string[]): Promise<{
    people: Array<{
      id: string;
      username: string;
      global_name: string | null;
      nick: string | null;
      bot: boolean;
      avatar_url: string | null;
      count: number;
    }>;
    byClip: Record<string, string[]>;
  }>;

  saveCustomName(originalName: string, customName: string): Promise<{ success: boolean; customName?: string; error?: string }>;
  getClipInfo(clip: any): Promise<any>;
  getTrim(clipName: string): Promise<any>;
  saveTrim(clipName: string, start: number, end: number): Promise<any>;
  deleteTrim(clipName: string): Promise<any>;
  getSpeed(clipName: string): Promise<number>;
  saveSpeed(clipName: string, speed: number): Promise<any>;
  getVolume(clipName: string): Promise<number>;
  saveVolume(clipName: string, volume: number): Promise<any>;
  getVolumeRange(clipName: string): Promise<any>;
  saveVolumeRange(clipName: string, range: any): Promise<any>;
  getClipTags(clipName: string): Promise<string[]>;
  getClipTagsBatch(clipNames: string[]): Promise<Record<string, string[]>>;
  saveClipTags(clipName: string, tags: string[]): Promise<any>;
  /** Hover-preview start seconds (trim.start or cached-duration midpoint); never probes. */
  getPreviewStartTime(clipName: string): Promise<number>;
  /** Effective volume: the custom .volume file, else the loudness-matched gain, else 1. */
  getVolumeDetail(clipName: string): Promise<VolumeDetail>;
  /** Drops the custom level; resolves to the detail that now applies. */
  resetVolume(clipName: string): Promise<VolumeDetail>;
  getLoudnessSummary(): Promise<LoudnessSummary>;
  /** One-round-trip bundle of everything the player reads on clip open. */
  getClipOpenState(clipName: string): Promise<any>;
  /** Probe and extract audio tracks for a clip at idle so its open is a cache hit. */
  warmClipOpen(clipName: string): Promise<void>;
  /** Per-track level envelope for the timeline; null while it is being measured. */
  getClipWaveform(clipName: string): Promise<ClipWaveform | null>;
  /** queue state plus how many clips already have a sidecar, out of the library size */
  getAnalysisProgress(): Promise<AnalysisProgress & { analyzed: number; libraryTotal: number }>;
  /** drops every analysis and the loudness index, then listens to the whole library again */
  resetAudioAnalysis(): Promise<{ ok: boolean }>;

  extractAudioTracks(...args: any[]): Promise<any>;
  getTrackState(...args: any[]): Promise<any>;
  saveTrackState(...args: any[]): Promise<any>;
  getTrackPreferences(...args: any[]): Promise<any>;
  saveTrackPreferences(...args: any[]): Promise<any>;

  loadGlobalTags(): Promise<any>;
  saveGlobalTags(tags: any): Promise<any>;
  restoreMissingGlobalTags(...args: any[]): Promise<any>;
  removeTagFromAllClips(tag: string): Promise<any>;
  updateTagInAllClips(oldTag: string, newTag: string): Promise<any>;
  getTagPreferences(): Promise<any>;
  saveTagPreferences(prefs: any): Promise<any>;

  getThumbnailPath(...args: any[]): Promise<any>;
  getThumbnailPathsBatch(...args: any[]): Promise<any>;
  generateThumbnailsProgressively(...args: any[]): Promise<any>;
  regenerateThumbnailForTrim(...args: any[]): Promise<any>;

  exportVideo(...args: any[]): Promise<any>;
  exportTrimmedVideo(...args: any[]): Promise<any>;
  exportAudio(...args: any[]): Promise<any>;
  openSaveDialog(...args: any[]): Promise<any>;
  revealClip(...args: any[]): Promise<any>;
  resetClipCache(...args: any[]): Promise<any>;

  getSettings(): Promise<any>;
  saveSettings(settings: any): Promise<any>;
  getDefaultKeybindings(): Promise<any>;

  openFolderDialog(): Promise<any>;
  openFolderDialogSteelseries(): Promise<any>;
  showDiagnosticsSaveDialog(...args: any[]): Promise<any>;

  updateDiscordPresence(...args: any[]): Promise<any>;
  toggleDiscordRpc(...args: any[]): Promise<any>;
  clearDiscordPresence(): Promise<any>;

  testShareConnection(...args: any[]): Promise<any>;
  startCliplibAuth(...args: any[]): Promise<any>;
  disconnectCliplibAuth(): Promise<any>;
  shareClip(...args: any[]): Promise<any>;
  getShareUsers(...args: any[]): Promise<any>;
  /** Generic authenticated JSON call against the ClipLib share API (path relative to /api). */
  shareApiRequest(request: {
    method?: string;
    path: string;
    body?: unknown;
    /** 404 is an expected answer, not a failure worth reporting */
    allow404?: boolean;
  }): Promise<{ success: boolean; status?: number; data?: unknown; error?: string }>;
  /** Pick a banner image via the native dialog and upload it to /users/me/banner. */
  shareUploadBanner(): Promise<{
    success: boolean;
    status?: number;
    error?: string;
    canceled?: boolean;
    data?: unknown;
  }>;

  checkForUpdates(): Promise<any>;
  /** Download the latest installer, launch it, and quit (main auto-installs). */
  startUpdate(): Promise<{ success: boolean }>;
  openUpdatePage(url?: string | null): Promise<{ success: boolean; url?: string; error?: string }>;
  getAppVersion(): Promise<string>;

  generateDiagnosticsZip(...args: any[]): Promise<any>;
  uploadSessionLogs(...args: any[]): Promise<any>;
  uploadDiagnosticsBundle(...args: any[]): Promise<any>;
  logWatchSession(...args: any[]): Promise<any>;
  getFfmpegVersion(): Promise<string>;
  getExportAccelerationStatus(): Promise<any>;
  importSteelseriesClips(...args: any[]): Promise<any>;
  quitApp(): Promise<any>;

  // source benchmark runner, handlers exist only in benchmark mode
  benchmarkGetResults(): Promise<any>;
  benchmarkOutputResult(result: any): Promise<boolean>;
  benchmarkOutputMarker(marker: string, payload: any): Promise<boolean>;
  benchmarkOutputComplete(data: any): Promise<boolean>;
  benchmarkQuit(): Promise<boolean>;

  // integrated clipdip binary; its own settings live in its TOML config
  clipdip: {
    getConfig(): Promise<{ exists: boolean; config: ClipdipConfig }>;
    /** Deep-merge patch into the TOML; a debounced --reload follows if running. */
    setConfig(patch: Partial<ClipdipConfig>): Promise<{ success: boolean }>;
    getStatus(): Promise<{
      running: boolean;
      binaryFound: boolean;
      configExists: boolean;
      autostart: boolean;
      /** false when the machine can't run clipdip (non-Windows / no NVIDIA GPU). */
      supported?: boolean;
      unsupportedReason?: string | null;
    }>;
    start(): Promise<{ success: boolean; error?: string; alreadyRunning?: boolean }>;
    stop(): Promise<{ success: boolean; forced?: boolean; alreadyStopped?: boolean }>;
    restart(): Promise<{ success: boolean; error?: string }>;
    setAutostart(enabled: boolean): Promise<{ success: boolean }>;
    setEnabled(enabled: boolean): Promise<{ success: boolean; error?: string }>;

    // stateless CLI queries, spawn the exe, no running instance needed
    listAudioDevices(): Promise<{ ok: boolean; error?: string; devices?: AudioDeviceInfo[] }>;
    listMonitors(): Promise<{ ok: boolean; error?: string; monitors?: MonitorInfo[] }>;
    getFilenameVariables(): Promise<{ ok: boolean; error?: string; variables?: FilenameVariable[] }>;
    previewFilename(template: string): Promise<{ ok: boolean; error?: string; preview?: string }>;

    /** Generic control-server call; resolves {ok:false, error:"not_running"}
     * when clipdip isn't up, never rejects. */
    control(cmd: string, args?: Record<string, unknown>): Promise<ClipdipControlResult>;
    getLiveStatus(): Promise<({ ok: true } & LiveStatus) | { ok: false; error: string }>;
    testOverlay(stage: "flow" | "notice" | "rec_on" | "rec_off"): Promise<ClipdipControlResult>;
    discordConnect(): Promise<ClipdipControlResult>;
    discordDisconnect(): Promise<ClipdipControlResult>;
    getTelemetryStatus(): Promise<
      | { ok: true; enabled: boolean; configured: boolean; install_id: string | null }
      | { ok: false; error: string }
    >;
    setTelemetryEnabled(enabled: boolean): Promise<ClipdipControlResult>;
    uploadDiagnostics(note?: string | null): Promise<ClipdipControlResult>;
    openClipsFolder(): Promise<ClipdipControlResult>;
  };

  rendererReady(): void;
  /** Where the launcher drew its logo, in CSS px of the content area (null without the launcher). */
  getBootLogoRect(): Promise<{ x: number; y: number; w: number; h: number } | null>;
  /** Main is about to make the window opaque; set up the reveal animation. */
  onBootReveal(cb: (payload: BootRevealPayload) => void): () => void;
  /** The animation's first frame is composited; main may make the window opaque. */
  bootRevealArmed(): void;
  bootRevealFrames(stats: BootRevealFrames): void;

  /** Post a renderer batch onto the `telemetry-report` channel. Never throws. */
  telemetryReport(payload: TelemetryReport): void;

  onLog(cb: ClipsEventCallback): ClipsUnsubscribe;
  onNewClipAdded(cb: ClipsEventCallback): ClipsUnsubscribe;
  onAnalysisProgress(cb: (p: AnalysisProgress) => void): ClipsUnsubscribe;
  onAnalysisReady(cb: (p: { clipName: string; waveform: ClipWaveform }) => void): ClipsUnsubscribe;
  onLoudnessMeasured(cb: (p: { clipName: string; gain: number; gainDb: number; lufs: number | null }) => void): ClipsUnsubscribe;
  onCheckActivityState(cb: ClipsEventCallback): ClipsUnsubscribe;
  onCliplibAuthEvent(cb: ClipsEventCallback): ClipsUnsubscribe;
  /** Navigation deep links (cliplib://settings/<section>) forwarded by main. */
  onCliplibNavigate(cb: ClipsEventCallback): ClipsUnsubscribe;
  onExportProgress(cb: ClipsEventCallback): ClipsUnsubscribe;
  onShowFallbackNotice(cb: ClipsEventCallback): ClipsUnsubscribe;
  onShowDecodeFallbackNotice(cb: ClipsEventCallback): ClipsUnsubscribe;
  onThumbnailValidationStart(cb: ClipsEventCallback): ClipsUnsubscribe;
  onThumbnailProgress(cb: ClipsEventCallback): ClipsUnsubscribe;
  onThumbnailGenerated(cb: ClipsEventCallback): ClipsUnsubscribe;
  onThumbnailGenerationFailed(cb: ClipsEventCallback): ClipsUnsubscribe;
  onThumbnailGenerationComplete(cb: ClipsEventCallback): ClipsUnsubscribe;
  onSteelseriesProgress(cb: ClipsEventCallback): ClipsUnsubscribe;
  onSteelseriesLog(cb: ClipsEventCallback): ClipsUnsubscribe;
  onShowUpdateNotification(cb: ClipsEventCallback): ClipsUnsubscribe;
  /** Fired once after a silent update landed ({version}). */
  onAppUpdated(cb: ClipsEventCallback): ClipsUnsubscribe;
  onDownloadProgress(cb: ClipsEventCallback): ClipsUnsubscribe;
  onUpdateDownloadError(cb: ClipsEventCallback): ClipsUnsubscribe;
  onUpdateDownloadComplete(cb: ClipsEventCallback): ClipsUnsubscribe;
  onShareUploadProgress(cb: ClipsEventCallback): ClipsUnsubscribe;
  onDiagnosticsProgress(cb: ClipsEventCallback): ClipsUnsubscribe;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface LegacyPlayerModule {
  init(elements: Record<string, unknown>, callbacks: Record<string, unknown>): void;
  openClip(originalName: string, customName: string): Promise<void>;
  closePlayer(): Promise<void>;
  getElements(): Record<string, HTMLElement | null>;
  applyAmbientGlowSettings(settings: unknown): void;
  changeSpeed(speed: number): void;
  resetControlsTimeout(): void;
  changeVolume(delta: number): void;
  getActiveAudioTracksManager(): {
    getExportMix(): Array<{ streamIndex: number; ordinal: number; volume: number }>;
    /** shifts every unhidden track by delta, keeping their offsets */
    nudgeAll(delta: number): void;
  } | null;
  handleKeyPress(e: KeyboardEvent): void;
  handleKeyRelease(e: KeyboardEvent): void;
  [key: string]: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    clips: ClipsApi;
    __benchmarkConfig?: { enabled: boolean; scenarios: string[] };
    __runAudioBenchmark?: (scenario: string, harness: unknown) => Promise<unknown>;
    __benchmarkLastOpenTimings?: {
      clipName: string;
      audioTrackCount: number;
      timings: Record<string, number>;
    };
    legacyPlayer?: LegacyPlayerModule;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    legacyState?: Record<string, any>;
    legacyVolumeRange?: { init(opts: Record<string, unknown>): void };
  }
}

export {};

export interface BootRevealPayload {
  animate: boolean;
  /** The launcher's logo, in CSS px of the window's content area, when it drew one. */
  logo: { x: number; y: number; w: number; h: number } | null;
}

export interface BootRevealFrames {
  animated: boolean;
  frames: number;
  p95: number;
  max: number;
  over25: number;
  /** The same statistics for the seconds after the intro (bench only). */
  tail?: { frames: number; p95: number; max: number; over25: number };
}
