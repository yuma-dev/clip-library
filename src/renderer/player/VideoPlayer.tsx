import { useCallback, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, Copy, Maximize, Trash2, Upload } from "lucide-react";
import type { LocalClip } from "../library/types";
import { getActionFromEvent, initKeybindings } from "./keybindings";
import "./player.css";

interface VideoPlayerProps {
  clipLocation: string;
  /** The clip list in display order — drives prev/next navigation. */
  clips: LocalClip[];
  /** Persist + propagate a title change (player title edits funnel through this). */
  renameClip: (originalName: string, newName: string) => Promise<boolean>;
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
export default function VideoPlayer({ clipLocation, clips, renameClip }: VideoPlayerProps) {
  const initedRef = useRef(false);
  // Latest renameClip, read from the once-only init callbacks without stale closures.
  const renameRef = useRef(renameClip);
  renameRef.current = renameClip;
  // Pending debounced title save (also cleared by the legacy flush-on-close path).
  const titleTimerRef = useRef<number | undefined>(undefined);

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
    const tempVideo = document.createElement("video");

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
      showExportProgress: noop,
      showCustomConfirm: (msg: unknown) => window.confirm(String(msg)),
      isBenchmarkMode: false,
      updateDiscordPresence: noop,
      getActionFromEvent: (e: KeyboardEvent) => getActionFromEvent(e),
      navigateToVideo: (direction: number) => navigate(direction),
      updateNavigationButtons: () => updateNavButtons(),
      exportAudioWithFileSelection: noop,
      exportVideoWithFileSelection: noop,
      exportAudioToClipboard: noop,
      exportDefault: noop,
      confirmAndDeleteClip: noop,
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

  return (
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
                <button id="export-button" type="button" aria-label="Export" title="Export">
                  <Copy size={18} />
                </button>
                <button id="share-button" className="share-hidden" type="button" aria-label="Publish" title="Publish">
                  <Upload size={18} />
                </button>
                <button id="delete-button" type="button" aria-label="Delete" title="Delete">
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
  );
}
