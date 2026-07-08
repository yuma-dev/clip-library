// Ambient types for the `window.clips` IPC facade exposed by preload.js.
//
// This is the typed seam between the new React renderer and the UNCHANGED
// Electron main process (plan D2/D9). Method names are camelCase wrappers over
// the kebab-case IPC channels verified in plan §5.
//
// NOTE (plan §5): argument/return payload shapes are loosely typed for now.
// Verify each against the corresponding `main/` handler and tighten the types
// as each phase starts consuming the channel.

type ClipsUnsubscribe = () => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClipsEventCallback = (...args: any[]) => void;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ClipsApi {
  // --- Clips ---
  getClips(): Promise<any[]>;
  getNewClipInfo(fileName: string): Promise<any>;
  getNewClipsInfo(): Promise<{ newClips: string[]; totalNewCount?: number }>;
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
  generateThumbnail(...args: any[]): Promise<any>;
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
  openUpdatePage(url?: string | null): Promise<{ success: boolean; url?: string; error?: string }>;
  getAppVersion(): Promise<string>;

  // --- Diagnostics / misc ---
  generateDiagnosticsZip(...args: any[]): Promise<any>;
  uploadSessionLogs(...args: any[]): Promise<any>;
  logWatchSession(...args: any[]): Promise<any>;
  getFfmpegVersion(): Promise<string>;
  getExportAccelerationStatus(): Promise<any>;
  importSteelseriesClips(...args: any[]): Promise<any>;
  quitApp(): Promise<any>;

  // --- Signal to main (fire-and-forget) ---
  rendererReady(): void;

  // --- Events (main -> renderer); each returns an unsubscribe fn ---
  onLog(cb: ClipsEventCallback): ClipsUnsubscribe;
  onNewClipAdded(cb: ClipsEventCallback): ClipsUnsubscribe;
  onCheckActivityState(cb: ClipsEventCallback): ClipsUnsubscribe;
  onCliplibAuthEvent(cb: ClipsEventCallback): ClipsUnsubscribe;
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
