import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Maximize, Trash2, Upload } from "lucide-react";
import type { LocalClip } from "../library/types";
import { getActionFromEvent, initKeybindings } from "./keybindings";
import {
  exportAudio,
  exportAudioWithFileSelection,
  exportTrimmedVideo,
  exportVideoWithFileSelection,
  type ProgressFn,
} from "./playerExport";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/Toast";
import { useProfile } from "../shell/useProfile";
import ShareModal from "./ShareModal";
import "./player.css";

interface VideoPlayerProps {
  clipLocation: string;
  /** The clip list in display order — drives prev/next navigation. */
  clips: LocalClip[];
  /** Persist + propagate a title change (player title edits funnel through this). */
  renameClip: (originalName: string, newName: string) => Promise<boolean>;
  /** Remove clips from the library list after a successful delete. */
  removeClips: (names: string[]) => void;
  /** Clear the "new" highlight + persist watched state when a clip is opened. */
  markClipsWatched: (names: string[]) => void;
}

/**
 * Wraps the legacy crown-jewel player (plan D1). It renders the exact
 * `#player-overlay` DOM the legacy code expects, then on mount hands the
 * element refs + callbacks to `window.legacyPlayer.init()` (loaded verbatim via
 * preload). The legacy JS thereafter drives this DOM imperatively; React never
 * re-renders it. Card clicks call `window.legacyPlayer.openClip(...)`.
 *
 * Phase 4a scope: get a clip playing + close. Trim/speed/volume/audio-tracks/
 * fullscreen come from the legacy code once initialized; callbacks + faithful
 * CSS + keybindings are filled in across 4b–4d.
 */
function VideoPlayer({ clipLocation, clips, renameClip, removeClips, markClipsWatched }: VideoPlayerProps) {
  const initedRef = useRef(false);
  const { confirm } = useConfirm();
  const toast = useToast();
  const { connected: shareConnected } = useProfile();
  const [shareOpen, setShareOpen] = useState(false);
  const exportTimerRef = useRef<number | undefined>(undefined);
  // Latest renameClip, read from the once-only init callbacks without stale closures.
  const renameRef = useRef(renameClip);
  renameRef.current = renameClip;
  // Latest markClipsWatched, read from the once-only openClip wrapper.
  const markWatchedRef = useRef(markClipsWatched);
  markWatchedRef.current = markClipsWatched;
  // Pending debounced title save (also cleared by the legacy flush-on-close path).
  const titleTimerRef = useRef<number | undefined>(undefined);
  // Hidden video used to render timeline hover-preview frames.
  const tempVideoRef = useRef<HTMLVideoElement | null>(null);

  // Move to the prev (-1) / next (+1) clip in the current display order.
  // Reads live from the shared legacy state so it never captures a stale list.
  const navigate = useCallback((direction: number) => {
    const state = window.legacyState;
    const player = window.legacyPlayer;
    if (!state || !player) return;
    const list = (state.currentClipList ?? []) as LocalClip[];
    const current = state.currentClip;
    if (!current || list.length === 0) return;
    const index = list.findIndex((c) => c.originalName === current.originalName);
    const nextIndex = index + direction;
    if (nextIndex >= 0 && nextIndex < list.length) {
      const next = list[nextIndex];
      void player.openClip(next.originalName, next.customName);
    }
  }, []);

  // Reflect prev/next availability at the ends of the list (matches legacy).
  const updateNavButtons = useCallback(() => {
    const state = window.legacyState;
    if (!state) return;
    const list = (state.currentClipList ?? []) as LocalClip[];
    const current = state.currentClip;
    const index = current ? list.findIndex((c) => c.originalName === current.originalName) : -1;
    const prev = document.getElementById("prev-video") as HTMLButtonElement | null;
    const next = document.getElementById("next-video") as HTMLButtonElement | null;
    if (prev) prev.disabled = index <= 0;
    if (next) next.disabled = index < 0 || index >= list.length - 1;
  }, []);

  // Keep the legacy navigation list in sync with the displayed clips.
  useEffect(() => {
    if (window.legacyState) window.legacyState.currentClipList = clips;
    updateNavButtons();
  }, [clips, updateNavButtons]);

  // Export progress toast — drives the legacy #export-toast markup imperatively
  // (icon + title + %, with a --progress bar), matching the original wording.
  const showExportProgress = useCallback<ProgressFn>((current, total, clipboard = false) => {
    const toastEl = document.getElementById("export-toast");
    const content = toastEl?.querySelector(".export-toast-content") as HTMLElement | null;
    const title = toastEl?.querySelector(".export-title") as HTMLElement | null;
    const progressText = toastEl?.querySelector(".export-progress-text") as HTMLElement | null;
    if (!toastEl || !content || !title || !progressText) return;

    toastEl.classList.add("show");
    const pct = Math.min(Math.round((current / total) * 100), 100);
    content.style.setProperty("--progress", `${pct}%`);
    progressText.textContent = `${pct}%`;

    if (pct >= 100) {
      content.classList.add("complete");
      title.textContent = clipboard ? "Copied to clipboard!" : "Export complete!";
      window.clearTimeout(exportTimerRef.current);
      exportTimerRef.current = window.setTimeout(() => {
        toastEl.classList.remove("show");
        window.setTimeout(() => {
          title.textContent = "Exporting...";
          content.style.setProperty("--progress", "0%");
          progressText.textContent = "0%";
          content.classList.remove("complete");
        }, 300);
      }, 3000);
    } else {
      title.textContent = "Exporting...";
      content.classList.remove("complete");
    }
  }, []);

  // Hide + reset the export toast (on error).
  const hideExportProgress = useCallback(() => {
    const toastEl = document.getElementById("export-toast");
    const content = toastEl?.querySelector(".export-toast-content") as HTMLElement | null;
    window.clearTimeout(exportTimerRef.current);
    toastEl?.classList.remove("show");
    content?.classList.remove("complete");
    content?.style.setProperty("--progress", "0%");
  }, []);

  const runExport = useCallback(
    (fn: (p: ProgressFn) => Promise<void>) => {
      fn(showExportProgress).catch((err) => {
        hideExportProgress();
        toast.show(err?.message ? `Export failed: ${err.message}` : "Export failed", "error");
      });
    },
    [showExportProgress, hideExportProgress, toast],
  );

  // Delete the open clip: confirm, close the player, delete on disk, drop from list.
  const handleDelete = useCallback(async () => {
    const clip = window.legacyState?.currentClip;
    if (!clip) return;
    const ok = await confirm({
      title: "Delete clip",
      message: `Delete “${clip.customName}”? This permanently removes the file.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const originalName = clip.originalName as string;
    try {
      await window.legacyPlayer?.closePlayer();
      const res = await window.clips.deleteClip(originalName);
      if (res && res.success === false) throw new Error(res.error);
      removeClips([originalName]);
      toast.show("Clip deleted", "success");
    } catch (err) {
      toast.show(
        (err as Error)?.message ? `Failed to delete: ${(err as Error).message}` : "Failed to delete clip",
        "error",
      );
    }
  }, [confirm, removeClips, toast]);

  useEffect(() => {
    const player = window.legacyPlayer;
    const state = window.legacyState;
    if (!player || !state || initedRef.current) return;
    initedRef.current = true;

    // The legacy player references window.uiBlur; provide a minimal shim
    // (the overlay covers the screen anyway — real blur can come later).
    const w = window as unknown as { uiBlur?: { enable(): void; disable(): void } };
    if (!w.uiBlur) w.uiBlur = { enable() {}, disable() {} };

    // Seed the shared legacy state singleton.
    state.clipLocation = clipLocation;
    window.clips
      .getSettings()
      .then((s) => {
        state.settings = s ?? {};
      })
      .catch(() => {
        state.settings = state.settings ?? {};
      });

    // Load player keybindings (Space/f/,/./[/] etc.) from settings.
    void initKeybindings();

    const byId = (id: string) => document.getElementById(id);
    // Hidden scrubbing video for the timeline hover preview (see the preview
    // effect below). Kept in a ref so both effects share the same element.
    if (!tempVideoRef.current) {
      const tv = document.createElement("video");
      tv.crossOrigin = "anonymous";
      tv.preload = "auto";
      tv.muted = true;
      tv.style.display = "none";
      document.body.appendChild(tv);
      tempVideoRef.current = tv;
    }
    const tempVideo = tempVideoRef.current;

    const elements = {
      videoPlayer: byId("video-player"),
      clipTitle: byId("clip-title"),
      progressBarContainer: byId("progress-bar-container"),
      progressBar: byId("progress-bar"),
      trimStart: byId("trim-start"),
      trimEnd: byId("trim-end"),
      playhead: byId("playhead"),
      loadingOverlay: byId("loading-overlay"),
      playerOverlay: byId("player-overlay"),
      videoClickTarget: byId("video-click-target"),
      ambientGlowCanvas: byId("ambient-glow-canvas"),
      fullscreenPlayer: byId("fullscreen-player"),
      videoControls: byId("video-controls"),
      volumeButton: byId("volume-button"),
      volumeSlider: byId("volume-slider"),
      volumeContainer: byId("volume-container"),
      audioTracksPanel: byId("audio-tracks-panel"),
      speedButton: byId("speed-button"),
      speedSlider: byId("speed-slider"),
      speedContainer: byId("speed-container"),
      speedText: byId("speed-text"),
      currentTimeDisplay: byId("current-time"),
      totalTimeDisplay: byId("total-time"),
      previewElement: byId("timeline-preview"),
      tempVideo,
    };

    const noop = () => {};
    const callbacks = {
      logCurrentWatchSession: noop,
      initializeVolumeControls: null,
      getCachedClipData: () => null,
      getThumbnailPath: (name: string) => window.clips.getThumbnailPath(name),
      updateDiscordPresenceForClip: noop,
      showCustomAlert: (msg: unknown) => window.alert(String(msg)),
      showCustomConfirm: (msg: unknown) => window.confirm(String(msg)),
      isBenchmarkMode: false,
      updateDiscordPresence: noop,
      getActionFromEvent: (e: KeyboardEvent) => getActionFromEvent(e),
      navigateToVideo: (direction: number) => navigate(direction),
      updateNavigationButtons: () => updateNavButtons(),
      showExportProgress: (current: number, total: number, clipboard?: boolean) =>
        showExportProgress(current, total, Boolean(clipboard)),
      exportAudioWithFileSelection: () => runExport(exportAudioWithFileSelection),
      exportVideoWithFileSelection: () => runExport(exportVideoWithFileSelection),
      exportAudioToClipboard: () => runExport((p) => exportAudio(null, p)),
      exportDefault: () => runExport(exportTrimmedVideo),
      confirmAndDeleteClip: () => void handleDelete(),
      enableGridNavigation: noop,
      disableGridNavigation: noop,
      openCurrentGridSelection: noop,
      moveGridSelection: noop,
      // Persist on close / clip-switch (legacy flushPendingClipEdits path).
      saveTitleChange: (clipName: string, _old: string, newName: string) =>
        renameRef.current(clipName, newName),
      clearSaveTitleTimeout: () => window.clearTimeout(titleTimerRef.current),
      removeClipTitleEditingListeners: noop,
      updateClipDisplay: noop,
      smoothScrollToElement: noop,
      getVisibleClips: () => [],
    };

    try {
      player.init(elements, callbacks);

      // The legacy player's key handlers (Space/f/,/./[/] …) were attached to
      // `document` by the old renderer right before each open, and detached by
      // closePlayer. Mirror that by wrapping openClip — the single chokepoint
      // all opens (grid click, prev/next) funnel through — so the handlers are
      // (re)bound every time. addEventListener dedupes identical listeners.
      const rawOpenClip = player.openClip.bind(player);
      player.openClip = (originalName: string, customName: string) => {
        // Dev profiler: label this end-to-end flow so the trace reads "open-clip"
        // instead of "pointerdown:clip-card". No-op unless the dev HUD is on.
        (window as unknown as { __perf?: { interaction(l: string): void } }).__perf?.interaction("open-clip");
        // Opening the player is what makes a clip "watched" (grid click and
        // prev/next both land here); hover previews never do.
        markWatchedRef.current([originalName]);
        document.addEventListener("keydown", player.handleKeyPress);
        document.addEventListener("keyup", player.handleKeyRelease);
        return rawOpenClip(originalName, customName);
      };

      // Volume-range controls create their own DOM (state.volumeStart/End/Region
      // elements) that the player's hideVolumeControls() expects to exist.
      window.legacyVolumeRange?.init({
        videoPlayer: elements.videoPlayer,
        progressBarContainer: elements.progressBarContainer,
        volumeSlider: elements.volumeSlider,
        toggleVolumeControls: player.toggleVolumeControls,
        showVolumeDragControl: player.showVolumeDragControl,
        handleVolumeDrag: player.handleVolumeDrag,
        endVolumeDrag: player.endVolumeDrag,
        debounce: player.debounce,
      });
    } catch (err) {
      console.error("[VideoPlayer] legacy init failed:", err);
    }

    // Start hidden; legacy openClip() reveals it.
    const overlay = byId("player-overlay");
    const fs = byId("fullscreen-player");
    if (overlay) overlay.style.display = "none";
    if (fs) fs.style.display = "none";
  }, [clipLocation]);

  // Keep the shared clip location fresh.
  useEffect(() => {
    if (window.legacyState) window.legacyState.clipLocation = clipLocation;
  }, [clipLocation]);

  // Live export progress streamed from the main process (fills the toast bar
  // between the 0% start and 100% completion set by the export helpers).
  useEffect(() => {
    const unsub = window.clips.onExportProgress((progress: number) => {
      const pct = Math.max(0, Math.min(100, Number(progress) || 0));
      if (pct < 100) showExportProgress(pct, 100, false);
    });
    return unsub;
  }, [showExportProgress]);

  // (Escape-to-close is now handled by the player's own keybindings, bound on
  // open; backdrop click remains as a fallback.)

  // Inline title editing on the legacy #clip-title input: live debounced save,
  // Enter commits, Escape cancels. Persists + propagates via renameClip.
  useEffect(() => {
    const input = document.getElementById("clip-title") as HTMLInputElement | null;
    if (!input) return;
    let original = "";
    const currentName = () =>
      window.legacyState?.currentClip?.originalName as string | undefined;

    const onFocus = () => {
      original = input.value;
    };
    const onInput = () => {
      const name = currentName();
      if (!name) return;
      const value = input.value;
      window.clearTimeout(titleTimerRef.current);
      titleTimerRef.current = window.setTimeout(() => {
        void renameRef.current(name, value);
      }, 300);
    };
    const onBlur = () => {
      const name = currentName();
      if (!name) return;
      window.clearTimeout(titleTimerRef.current);
      void renameRef.current(name, input.value);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        window.clearTimeout(titleTimerRef.current);
        input.value = original;
        input.blur();
      }
      // Stop player keybindings (space, arrows, Escape-to-close) from firing
      // while the user is typing a title.
      e.stopPropagation();
    };

    input.addEventListener("focus", onFocus);
    input.addEventListener("input", onInput);
    input.addEventListener("blur", onBlur);
    input.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(titleTimerRef.current);
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("input", onInput);
      input.removeEventListener("blur", onBlur);
      input.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Timeline hover preview: a hidden temp <video> is pointed at the current
  // clip; hovering the progress bar seeks it (throttled) and each seeked frame
  // is drawn into #preview-canvas. The player's updatePreview handles the seek
  // + timestamp; we own positioning + the canvas draw (ported from the legacy
  // renderer, which is where this wiring used to live).
  useEffect(() => {
    const container = document.getElementById("progress-bar-container");
    const preview = document.getElementById("timeline-preview") as HTMLElement | null;
    const canvas = document.getElementById("preview-canvas") as HTMLCanvasElement | null;
    const video = document.getElementById("video-player") as HTMLVideoElement | null;
    const temp = tempVideoRef.current;
    if (!container || !preview || !canvas || !video || !temp) return;

    const onSeeked = () => {
      const ctx = canvas.getContext("2d");
      if (ctx && temp.readyState >= 2) ctx.drawImage(temp, 0, 0, canvas.width, canvas.height);
    };
    temp.addEventListener("seeked", onSeeked);

    // Point the temp video at each newly-loaded clip; size the canvas once.
    const onLoaded = () => {
      if (video.src && temp.src !== video.src) temp.src = video.src;
      canvas.width = 160;
      canvas.height = 90;
      preview.style.display = "none";
    };
    video.addEventListener("loadedmetadata", onLoaded);

    // Hover → position horizontally on the cursor + throttled frame seek.
    let half = 0;
    let lastSeek = 0;
    let trailing: number | undefined;
    const seekAt = (clientX: number) => {
      // updatePreview only reads e.clientX; the legacy module is loosely typed.
      window.legacyPlayer?.updatePreview?.({ clientX }, { skipPosition: true });
    };
    const onMove = (e: MouseEvent) => {
      // Don't fight the volume-range drag controls that live on the bar.
      const t = e.target as HTMLElement;
      if (
        t.closest(".volume-drag-control") ||
        t.classList.contains("volume-region") ||
        t.classList.contains("volume-start") ||
        t.classList.contains("volume-end")
      ) {
        return;
      }
      preview.style.display = "block";
      if (!half) half = preview.offsetWidth / 2 || 100;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      preview.style.left = "0px";
      preview.style.transform = `translate3d(${x - half}px, 0, 0)`;

      const now = performance.now();
      window.clearTimeout(trailing);
      const clientX = e.clientX;
      trailing = window.setTimeout(() => seekAt(clientX), 90);
      if (now - lastSeek >= 60) {
        lastSeek = now;
        seekAt(clientX);
      }
    };
    const onLeave = () => {
      preview.style.display = "none";
      window.clearTimeout(trailing);
    };
    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", onLeave);

    return () => {
      temp.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onLoaded);
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
      window.clearTimeout(trailing);
    };
  }, []);

  return (
    <>
    <div
      id="player-overlay"
      onClick={(e) => {
        // Click on the backdrop (outside the video/controls) closes the player.
        const t = e.target as HTMLElement;
        if (t.id === "player-overlay" || t.id === "player-container") {
          void window.legacyPlayer?.closePlayer();
        }
      }}
    >
      <div id="player-container">
        <button
          id="prev-video"
          className="video-nav-button"
          type="button"
          aria-label="Previous"
          onClick={(e) => {
            e.stopPropagation();
            navigate(-1);
          }}
        >
          <ChevronLeft size={24} />
        </button>
        <button
          id="next-video"
          className="video-nav-button"
          type="button"
          aria-label="Next"
          onClick={(e) => {
            e.stopPropagation();
            navigate(1);
          }}
        >
          <ChevronRight size={24} />
        </button>
        <canvas id="ambient-glow-canvas" className="hidden" width={10} height={6} aria-hidden="true" />
        <div id="fullscreen-player">
          <div id="video-container">
            <div id="video-click-target" />
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video id="video-player" />
            <div id="loading-overlay">
              <div className="loading-spinner" />
            </div>
          </div>
          <div id="video-controls">
            {/* TOP: title + action buttons */}
            <div id="top-controls">
              <input type="text" id="clip-title" placeholder="Clip Title" />
              <div className="player-actions">
                <button
                  id="export-button"
                  type="button"
                  aria-label="Export"
                  title="Export (Ctrl: video file · Shift: audio to clipboard · Ctrl+Shift: audio file)"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.ctrlKey && e.shiftKey) runExport(exportAudioWithFileSelection);
                    else if (e.ctrlKey) runExport(exportVideoWithFileSelection);
                    else if (e.shiftKey) runExport((p) => exportAudio(null, p));
                    else runExport(exportTrimmedVideo);
                  }}
                >
                  <Copy size={18} />
                </button>
                <button
                  id="share-button"
                  className={shareConnected ? undefined : "share-hidden"}
                  type="button"
                  aria-label="Publish"
                  title="Publish to ClipLib"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShareOpen(true);
                  }}
                >
                  <Upload size={18} />
                </button>
                <button
                  id="delete-button"
                  type="button"
                  aria-label="Delete"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete();
                  }}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>

            {/* BOTTOM: playback controls, then progress bar, then time */}
            <div id="bottom-controls">
              <div className="playback-row">
                <div id="volume-container">
                  <div id="audio-tracks-panel" className="hidden" />
                  <button id="volume-button" type="button" aria-label="Volume" />
                  <input type="range" id="volume-slider" min="0" max="2" step="0.1" defaultValue="1" className="collapsed" />
                </div>
                <div className="playback-right">
                  <div id="speed-container">
                    <button id="speed-button" type="button" title="Playback Speed">
                      <span id="speed-text">1x</span>
                    </button>
                    <input type="range" id="speed-slider" min="0.5" max="2" step="0.25" defaultValue="1" className="collapsed" />
                  </div>
                  <button id="fullscreen-button" type="button" aria-label="Fullscreen">
                    <Maximize size={19} />
                  </button>
                </div>
              </div>
              <div id="trim-controls">
                <div id="progress-bar-container">
                  <div id="progress-bar" />
                  <div id="trim-start" />
                  <div id="trim-end" />
                  <div id="playhead" />
                  <div id="timeline-preview" className="timeline-preview">
                    <canvas id="preview-canvas" width={160} height={90} />
                    <div id="preview-timestamp" />
                  </div>
                </div>
              </div>
              <div className="time-row">
                <div id="current-time">0:00</div>
                <div id="total-time">0:00</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    {/* Export progress toast — legacy markup, positioned fixed at document
        level (outside the overlay's stacking context) so it stays visible. */}
    <div id="export-toast" className="export-toast">
      <div className="export-toast-content">
        <div className="export-toast-header">
          <svg className="export-icon" viewBox="0 0 24 24">
            <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          <div className="export-text">
            <h3 className="export-title">Exporting...</h3>
            <p className="export-progress-text">0%</p>
          </div>
        </div>
      </div>
    </div>

    <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </>
  );
}

// The player DOM is driven imperatively by the legacy code after init; memo
// keeps app-shell state changes from re-rendering this large static tree.
export default memo(VideoPlayer);
