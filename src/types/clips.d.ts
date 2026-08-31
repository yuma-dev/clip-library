// Ambient types for the `window.clips` IPC facade exposed by preload.js.
//
// This is the typed seam between the new React renderer and the UNCHANGED
// Electron main process (plan D2/D9). Method names are camelCase wrappers over
// the kebab-case IPC channels verified in plan §5.
//
// NOTE (plan §5): argument/return payload shapes are loosely typed for now.
// Verify each against the corresponding `main/` handler and tighten the types
// as each phase starts consuming the channel.

// Mirror of clipdip's TOML config (clipdip crates/core/src/config.rs).
// Every field is serde-defaulted on the Rust side, so partial objects are fine.

/** Mode-tagged enum table; replaced whole on patch, never merged. */
export type ClipdipRateControl =
  | { mode: "constant_qp"; qp: number }
  | { mode: "vbr"; avg_bps: number };

/** Mode-tagged enum table; replaced whole on patch, never merged. */
export type ClipdipRecordingQuality =
  | { mode: "match_clips" }
  | { mode: "constant_qp"; qp: number };

/** Kind-tagged audio source entry (audio.sources[]). `fallbacks` is an
 *  ordered list of device ids tried when the entry above doesn't start;
 *  the literal "default" means the system default endpoint. */
export type ClipdipAudioSource =
  | { kind: "system_loopback"; device_id?: string; fallbacks?: string[] }
  | { kind: "microphone"; device_id?: string; fallbacks?: string[] }
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

// --- Clipdip bridge payloads (stateless CLI queries + control server) -------

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

/** Discord RPC connection state (control `status` -> discord). */
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
  /** Per-source audio state (control `status` -> audio_sources): what the
   *  config wants vs what is actually recording. Empty while the pipeline
   *  is down. */
  audio_sources?: ClipdipAudioSourceStatus[];
  version: string;
}

/** One audio source's live state, for the settings repair banner. */
export interface ClipdipAudioSourceStatus {
  index: number;
  kind: "system_loopback" | "microphone";
  /** Display name of the configured primary device ("System default", a
   *  friendly name, or "(disconnected device)"). */
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

// --- Telemetry wire payloads (preload -> main `telemetry-report`) -----------
//
// Mirrors the contract main/telemetry/index.js `registerIpc` accepts. Context
// and dims carry numbers, booleans and enum strings only; never file names,
// clip names, tag text, paths, search queries or account identifiers.

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
  // --- Clips ---
  getClips(): Promise<any[]>;
  getNewClipInfo(fileName: string): Promise<any>;
  getNewClipsInfo(): Promise<{ newClips: string[]; totalNewCount?: number }>;
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

  // --- Per-clip metadata ---
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
  /** One-round-trip bundle of everything the player reads on clip open. */
  getClipOpenState(clipName: string): Promise<any>;

  // --- Audio tracks ---
  extractAudioTracks(...args: any[]): Promise<any>;
  getTrackState(...args: any[]): Promise<any>;
  saveTrackState(...args: any[]): Promise<any>;
  getTrackPreferences(...args: any[]): Promise<any>;
  saveTrackPreferences(...args: any[]): Promise<any>;

  // --- Global tags ---
  loadGlobalTags(): Promise<any>;
  saveGlobalTags(tags: any): Promise<any>;
  restoreMissingGlobalTags(...args: any[]): Promise<any>;
  removeTagFromAllClips(tag: string): Promise<any>;
  updateTagInAllClips(oldTag: string, newTag: string): Promise<any>;
  getTagPreferences(): Promise<any>;
  saveTagPreferences(prefs: any): Promise<any>;

  // --- Thumbnails ---
  getThumbnailPath(...args: any[]): Promise<any>;
  getThumbnailPathsBatch(...args: any[]): Promise<any>;
  generateThumbnailsProgressively(...args: any[]): Promise<any>;
  regenerateThumbnailForTrim(...args: any[]): Promise<any>;

  // --- Export / files ---
  exportVideo(...args: any[]): Promise<any>;
  exportTrimmedVideo(...args: any[]): Promise<any>;
  exportAudio(...args: any[]): Promise<any>;
  openSaveDialog(...args: any[]): Promise<any>;
  revealClip(...args: any[]): Promise<any>;
  resetClipCache(...args: any[]): Promise<any>;

  // --- Settings ---
  getSettings(): Promise<any>;
  saveSettings(settings: any): Promise<any>;
  getDefaultKeybindings(): Promise<any>;

  // --- Dialogs ---
  openFolderDialog(): Promise<any>;
  openFolderDialogSteelseries(): Promise<any>;
  showDiagnosticsSaveDialog(...args: any[]): Promise<any>;

  // --- Discord RPC ---
  updateDiscordPresence(...args: any[]): Promise<any>;
  toggleDiscordRpc(...args: any[]): Promise<any>;
  clearDiscordPresence(): Promise<any>;

  // --- Share / ClipLib ---
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
  }): Promise<{ success: boolean; status?: number; data?: unknown; error?: string }>;
  /** Pick a banner image via the native dialog and upload it to /users/me/banner. */
  shareUploadBanner(): Promise<{
    success: boolean;
    status?: number;
    error?: string;
    canceled?: boolean;
    data?: unknown;
  }>;

  // --- Updates ---
  checkForUpdates(): Promise<any>;
  /** Download the latest installer, launch it, and quit (main auto-installs). */
  startUpdate(): Promise<{ success: boolean }>;
  openUpdatePage(url?: string | null): Promise<{ success: boolean; url?: string; error?: string }>;
  getAppVersion(): Promise<string>;

  // --- Diagnostics / misc ---
  generateDiagnosticsZip(...args: any[]): Promise<any>;
  uploadSessionLogs(...args: any[]): Promise<any>;
  uploadDiagnosticsBundle(...args: any[]): Promise<any>;
  logWatchSession(...args: any[]): Promise<any>;
  getFfmpegVersion(): Promise<string>;
  getExportAccelerationStatus(): Promise<any>;
  importSteelseriesClips(...args: any[]): Promise<any>;
  quitApp(): Promise<any>;

  // --- Integrated clipdip (clipdip binary; config lives in its TOML) ---
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

    // Stateless CLI queries (spawn the exe; no running instance needed).
    listAudioDevices(): Promise<{ ok: boolean; error?: string; devices?: AudioDeviceInfo[] }>;
    listMonitors(): Promise<{ ok: boolean; error?: string; monitors?: MonitorInfo[] }>;
    getFilenameVariables(): Promise<{ ok: boolean; error?: string; variables?: FilenameVariable[] }>;
    previewFilename(template: string): Promise<{ ok: boolean; error?: string; preview?: string }>;

    /**
     * Generic control-server call against the running clipdip instance.
     * Resolves {ok:false, error:"not_running"} when it isn't up; never rejects.
     */
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

  // --- Signal to main (fire-and-forget) ---
  rendererReady(): void;

  // --- Telemetry (fire-and-forget) ---
  /** Post a renderer batch onto the `telemetry-report` channel. Never throws. */
  telemetryReport(payload: TelemetryReport): void;

  // --- Events (main -> renderer); each returns an unsubscribe fn ---
  onLog(cb: ClipsEventCallback): ClipsUnsubscribe;
  onNewClipAdded(cb: ClipsEventCallback): ClipsUnsubscribe;
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

// Legacy video player (Phase 4) — loaded verbatim via preload; loosely typed.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface LegacyPlayerModule {
  init(elements: Record<string, unknown>, callbacks: Record<string, unknown>): void;
  openClip(originalName: string, customName: string): Promise<void>;
  closePlayer(): Promise<void>;
  getElements(): Record<string, HTMLElement | null>;
  applyAmbientGlowSettings(settings: unknown): void;
  handleKeyPress(e: KeyboardEvent): void;
  handleKeyRelease(e: KeyboardEvent): void;
  [key: string]: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    clips: ClipsApi;
    legacyPlayer?: LegacyPlayerModule;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    legacyState?: Record<string, any>;
    legacyVolumeRange?: { init(opts: Record<string, unknown>): void };
  }
}

export {};
