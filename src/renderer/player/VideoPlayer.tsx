import ExportProgress from './ExportProgress';
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, Copy, Maximize, Trash2, Upload } from "lucide-react";
import type { LocalClip } from "../library/types";
import type { ClipWaveform } from "../../types/clips";
import { getActionFromEvent, initKeybindings } from "./keybindings";
import {
  exportAudio,
  exportAudioWithFileSelection,
  exportTrimmedVideo,
  exportVideoWithFileSelection,
  type ProgressFn,
} from "./playerExport";
import { hideExportProgress, showExportProgress } from "./exportToast";
import { installUiBlur } from "../ui/uiBlur";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/Toast";
import { useProfile } from "../shell/useProfile";
import { useSettings } from "../settings/SettingsContext";
import {
  initDiscordPresence,
  updateDiscordPresence,
  updateDiscordPresenceBasedOnState,
  updateDiscordPresenceForClip,
} from "./discordPresence";
import { initGamepad } from "./gamepad";
import {
  disableGridNavigation,
  enableGridNavigation,
  getVisibleCards,
  initGridKeyboardNavigation,
  moveGridSelection,
  openCurrentGridSelection,
  type GridDirection,
} from "../library/gridNavigation";
import ShareModal from "./ShareModal";
import SpeedDrum from "./SpeedDrum";
import { installChromeVisibility } from "./chromeVisibility";
import Timeline from "./Timeline";
import type { TrackView } from "./Waveform";
import { fingerprint, reportEvent } from "../telemetry";
import "./player.css";

// only these alert codes get reported (message carries clip names/ffmpeg errors); trim-reset
// success alert isn't an error
const ALERT_CODES: Array<[string, string]> = [
  ["Failed to export clip", "export_failed"],
  ["Error opening clip", "open_failed"],
  ["Error saving trim", "trim_save_failed"],
  ["Error resetting trim times", "trim_reset_failed"],
];

const alertCodeFor = (message: string): string | null =>
  ALERT_CODES.find(([prefix]) => message.startsWith(prefix))?.[1] ?? null;

interface VideoPlayerProps {
  clipLocation: string;
  /** display order; drives prev/next navigation */
  clips: LocalClip[];
  /** persists + propagates a title change */
  renameClip: (originalName: string, newName: string) => Promise<boolean>;
  /** called after a successful disk delete */
  removeClips: (names: string[]) => void;
  /** clears the "new" highlight + persists watched state on open */
  markClipsWatched: (names: string[]) => void;
}

/** what react keeps per opened clip, taken from legacy's clip-open-state event */
interface OpenSession {
  originalName: string;
  thumbnailPath: string | null;
  waveform: ClipWaveform | null;
}

/** renders the legacy #player-overlay DOM; window.legacyPlayer.init() drives it imperatively
 * (React never re-renders it). card clicks call legacyPlayer.openClip() */
function VideoPlayer({ clipLocation, clips, renameClip, removeClips, markClipsWatched }: VideoPlayerProps) {
  const initedRef = useRef(false);
  const { confirm } = useConfirm();
  const toast = useToast();
  const { connected: shareConnected } = useProfile();
  const { settings } = useSettings();
  const [shareOpen, setShareOpen] = useState(false);
  const [session, setSession] = useState<OpenSession | null>(null);
  // body.player-open mirrored into state; legacy toggles it on open and every close path
  const [isOpen, setIsOpen] = useState(false);
  const [tracks, setTracks] = useState<TrackView[] | null>(null);
  const [masterVolume, setMasterVolume] = useState(1);
  // click-to-toggle glyph; the counter restarts the animation, playing picks the glyph
  const [flash, setFlash] = useState({ n: 0, playing: false });
  // width / height of the loaded video; the frame takes this shape inside the stage
  const [aspect, setAspect] = useState(16 / 9);
  // where the last mousedown landed; only a press and release both on the backdrop close
  const backdropPressRef = useRef(false);
  // avoids stale closures in the once-only init callbacks
  const renameRef = useRef(renameClip);
  renameRef.current = renameClip;
  // avoids stale closures in the openClip wrapper
  const markWatchedRef = useRef(markClipsWatched);
  markWatchedRef.current = markClipsWatched;
  // debounced title save timer; also cleared by legacy's flush-on-close
  const titleTimerRef = useRef<number | undefined>(undefined);
  // hover-preview scrub video
  const tempVideoRef = useRef<HTMLVideoElement | null>(null);
  // only active playing time counts (lastPlay set on play, folded into activeMs on pause/log);
  // feeds the recap log via log-watch-session
  const watchRef = useRef<{ activeMs: number; lastPlay: number | null }>({ activeMs: 0, lastPlay: null });

  // flushes session for the outgoing clip (legacy calls this on close and right before switching,
  // while state.currentClip still points at it); sessions <=1s dropped as noise
  const logCurrentWatchSession = useCallback(() => {
    const w = watchRef.current;
    if (w.lastPlay != null) {
      w.activeMs += Date.now() - w.lastPlay;
      w.lastPlay = null;
    }
    const durationSeconds = Math.round(w.activeMs / 1000);
    w.activeMs = 0;
    const clip = window.legacyState?.currentClip;
    if (!clip || durationSeconds <= 1) return;
    const titleInput = document.getElementById("clip-title") as HTMLInputElement | null;
    void window.clips.logWatchSession({
      originalName: clip.originalName,
      customName: titleInput?.value || clip.customName,
      durationSeconds,
    });
  }, []);

  // prev (-1) / next (+1); reads live legacy state so it never captures a stale list
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

  // disables prev/next at list ends, matches legacy
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

  useEffect(() => {
    if (window.legacyState) window.legacyState.currentClipList = clips;
    updateNavButtons();
    // grid view: refresh "Browsing clips, Total: N" presence as the list changes (legacy: on load +
    // filter changes)
    if (!window.legacyState?.currentClip) updateDiscordPresenceBasedOnState();
  }, [clips, updateNavButtons]);

  // toast driven by ./exportToast; #export-toast markup below renders once at document level,
  // reused by player + grid context menu
  const runExport = useCallback(
    (fn: (p: ProgressFn) => Promise<void>) => {
      fn(showExportProgress).catch((err) => {
        hideExportProgress();
        toast.show(err?.message ? `Export failed: ${err.message}` : "Export failed", "error");
      });
    },
    [toast],
  );

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

    // legacy calls window.uiBlur.enable/disable on open/close; install the real refcounted blur
    // before player.init so the grid actually blurs behind it
    installUiBlur();

    state.clipLocation = clipLocation;
    window.clips
      .getSettings()
      .then((s) => {
        state.settings = s ?? {};
      })
      .catch(() => {
        state.settings = state.settings ?? {};
      });

    // player keybindings (space/f/,/./[/] etc.) from settings
    void initKeybindings();

    // discord presence: initial "Browsing clips", idle poll, focus re-assert
    initDiscordPresence();

    // grid navigation: arrows/enter on the library grid (player closed)
    initGridKeyboardNavigation();

    // gamepad: 16ms poll, button/stick routing, quit confirm, grid nav
    initGamepad({
      navigateToVideo: (direction) => navigate(direction),
      exportDefault: () => runExport(exportTrimmedVideo),
      exportVideo: () => runExport(exportVideoWithFileSelection),
      confirm: (options) => confirm(options),
    });

    const byId = (id: string) => document.getElementById(id);
    // hover-preview scrub video, kept in a ref so both effects share it
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
      // the frame-sampling glow canvas is gone; the thumbnail glow below replaces it
      ambientGlowCanvas: null,
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
      logCurrentWatchSession,
      initializeVolumeControls: null,
      getCachedClipData: () => null,
      getThumbnailPath: (name: string) => window.clips.getThumbnailPath(name),
      // legacy calls this on open/seek (skips Private clips) and close/edit; gated on
      // enableDiscordRPC inside the module
      updateDiscordPresenceForClip: (clip: { originalName: string; customName: string; tags?: string[] }, isPlaying: boolean) =>
        updateDiscordPresenceForClip(clip, isPlaying),
      showCustomAlert: (msg: unknown) => {
        const text = String(msg);
        const alertCode = alertCodeFor(text);
        if (alertCode) {
          reportEvent("legacy_alert_shown", {
            kind: "error",
            severity: "error",
            surface: "player",
            // per-path fingerprint, so one noisy alert can't hide the others
            fingerprint: fingerprint(`legacy_alert_shown:${alertCode}`),
            context: { alert_code: alertCode },
          });
        }
        return window.alert(text);
      },
      showCustomConfirm: (msg: unknown) => window.confirm(String(msg)),
      isBenchmarkMode: window.__benchmarkConfig?.enabled === true,
      updateDiscordPresence: (details: string, state?: string | null) =>
        updateDiscordPresence(details, state ?? null),
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
      // player re-enables grid nav (library/gridNavigation.ts) on close while a gamepad is
      // connected (player-legacy:1747)
      enableGridNavigation: () => enableGridNavigation(),
      disableGridNavigation: () => disableGridNavigation(),
      openCurrentGridSelection: () => openCurrentGridSelection(),
      moveGridSelection: (direction: GridDirection) => moveGridSelection(direction),
      // flush runs on every close/switch (legacy flushPendingClipEdits); unchanged titles skip the
      // write, the redundant save-custom-name IPC showed up in perf traces
      saveTitleChange: (clipName: string, old: string, newName: string) =>
        old === newName ? Promise.resolve(true) : renameRef.current(clipName, newName),
      clearSaveTitleTimeout: () => window.clearTimeout(titleTimerRef.current),
      removeClipTitleEditingListeners: noop,
      updateClipDisplay: noop,
      smoothScrollToElement: noop,
      getVisibleClips: () => getVisibleCards(),
    };

    try {
      player.init(elements, callbacks);

      // mirrors legacy: key handlers bound on document before each open, detached by closePlayer;
      // openClip is the one chokepoint all opens funnel through, addEventListener dedupes repeats
      const rawOpenClip = player.openClip.bind(player);
      player.openClip = (originalName: string, customName: string) => {
        // dev profiler: labels trace "open-clip" instead of "pointerdown:clip-card"; no-op unless HUD is on
        (window as unknown as { __perf?: { interaction(l: string): void } }).__perf?.interaction("open-clip");
        // opening the player marks watched (grid click + prev/next land here); hover previews don't
        markWatchedRef.current([originalName]);
        document.addEventListener("keydown", player.handleKeyPress);
        document.addEventListener("keyup", player.handleKeyRelease);
        return rawOpenClip(originalName, customName);
      };

      // volume-range controls create state.volumeStart/End/Region DOM that hideVolumeControls() expects
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
      // stays broken after this; console-only logging was why it never surfaced in the field
      reportEvent("player_init_failed", { kind: "crash", severity: "error", surface: "player", error: err });
    }

    // Start hidden; legacy openClip() reveals it.
    const overlay = byId("player-overlay");
    const fs = byId("fullscreen-player");
    if (overlay) overlay.style.display = "none";
    if (fs) fs.style.display = "none";
  }, [clipLocation]);

  useEffect(() => {
    if (window.legacyState) window.legacyState.clipLocation = clipLocation;
  }, [clipLocation]);

  // legacy fires clip-open-state once its batched IPC lands; the waveform can trail it by a
  // measurement when the clip was never warmed
  useEffect(() => {
    const onOpenState = (e: Event) => {
      const { originalName, openState } = (e as CustomEvent<{ originalName: string; openState: Record<string, unknown> }>).detail;
      setSession({
        originalName,
        thumbnailPath: (openState.thumbnailPath as string | null) ?? null,
        waveform: (openState.waveform as ClipWaveform | null) ?? null,
      });
      setTracks(null);
    };
    document.addEventListener("clip-open-state", onOpenState);
    const offReady = window.clips.onAnalysisReady(({ clipName, waveform }) => {
      setSession((s) => (s && s.originalName === clipName ? { ...s, waveform } : s));
    });
    // master level, from legacy's slider updates
    const onVolume = (e: Event) => {
      const v = (e as CustomEvent<number>).detail;
      if (Number.isFinite(v)) setMasterVolume(v);
    };
    document.addEventListener("player-volume", onVolume);
    // fired by the mixer on init, colour/hide/mute/level changes and dispose (empty list)
    const onTracks = (e: Event) => {
      const view = (e as CustomEvent<TrackView[]>).detail;
      setTracks(view && view.length > 0 ? view : null);
    };
    document.addEventListener("audio-tracks-changed", onTracks);
    // open/close both go through body.player-open in legacy
    const observer = new MutationObserver(() => {
      const open = document.body.classList.contains("player-open");
      setIsOpen(open);
      if (!open) {
        setSession(null);
        setTracks(null);
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => {
      document.removeEventListener("clip-open-state", onOpenState);
      document.removeEventListener("player-volume", onVolume);
      document.removeEventListener("audio-tracks-changed", onTracks);
      offReady();
      observer.disconnect();
    };
  }, []);

  // chrome show/hide rules, one place for keys, mouse, open and drags
  useEffect(() => installChromeVisibility(), []);

  // play/pause drives watch-session active-time + discord presence (ticker while playing, frozen
  // while paused); pause also fires before ended and on switch/close
  useEffect(() => {
    const video = document.getElementById("video-player") as HTMLVideoElement | null;
    if (!video) return;
    const onMeta = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) setAspect(video.videoWidth / video.videoHeight);
    };
    video.addEventListener("loadedmetadata", onMeta);
    const onPlay = () => {
      watchRef.current.lastPlay = Date.now();
      const clip = window.legacyState?.currentClip;
      if (clip) updateDiscordPresenceForClip(clip, true);
    };
    const onPause = () => {
      const w = watchRef.current;
      if (w.lastPlay != null) {
        w.activeMs += Date.now() - w.lastPlay;
        w.lastPlay = null;
      }
      const clip = window.legacyState?.currentClip;
      if (clip) updateDiscordPresenceForClip(clip, false);
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    return () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, []);

  // streamed export progress fills the toast bar between the 0%/100% set by the export helpers
  useEffect(() => {
    const unsub = window.clips.onExportProgress((progress: number) => {
      const pct = Math.max(0, Math.min(100, Number(progress) || 0));
      if (pct < 100) showExportProgress(pct, 100, false);
    });
    return unsub;
  }, [showExportProgress]);

  // hw encode/decode fallback notices; legacy used dismissible .fallback-notice divs, toasts now cover it
  useEffect(() => {
    const offEncode = window.clips.onShowFallbackNotice(() => {
      toast.show(
        "Exporting with software encoding (slower). For faster exports, install the NVIDIA CUDA runtime and update your graphics drivers.",
        "info",
        8000,
      );
    });
    const offDecode = window.clips.onShowDecodeFallbackNotice(
      (payload: { sourceCodec?: string; decodeAttempts?: string[] } | undefined) => {
        const codec = payload?.sourceCodec ? payload.sourceCodec.toUpperCase() : "unknown";
        const attempts = (payload?.decodeAttempts ?? []).filter((a) => a && a !== "none");
        const tried = attempts.length > 0 ? attempts.join(", ") : "hardware decode";
        toast.show(
          `Hardware decode fallback: using software decode for the ${codec} source (tried ${tried}). Export still works, but may be slower.`,
          "info",
          8000,
        );
      },
    );
    return () => {
      offEncode();
      offDecode();
    };
  }, [toast]);

  // escape-to-close is handled by the player's own keybindings; backdrop click is the fallback

  // #clip-title inline editing: debounced save, enter commits, escape cancels, via renameClip
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
      // stop player keybindings (space/arrows/escape) firing while typing a title
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

  // hidden temp <video> tracks the current clip; hover seeks it (throttled) and draws frames into
  // #preview-canvas; legacy updatePreview handles seek+timestamp, we own positioning + the draw
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

    // points the temp video at each newly-loaded clip; sizes the canvas once
    const onLoaded = () => {
      if (video.src && temp.src !== video.src) temp.src = video.src;
      canvas.width = 320;
      canvas.height = 180;
      preview.style.display = "none";
    };
    video.addEventListener("loadedmetadata", onLoaded);

    // hover: position horizontally on the cursor + throttled frame seek
    let half = 0;
    let lastSeek = 0;
    let trailing: number | undefined;
    const seekAt = (clientX: number) => {
      // updatePreview only reads e.clientX; the legacy module is loosely typed
      window.legacyPlayer?.updatePreview?.({ clientX }, { skipPosition: true });
    };
    const onMove = (e: MouseEvent) => {
      // don't fight the volume-range drag controls that live on the bar
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

  const glow = settings.ambientGlow;
  const thumbUrl = session?.thumbnailPath ? `file://${session.thumbnailPath}` : null;
  const glowStyle = {
    "--glow-blur": `${glow.blur}px`,
    "--glow-sat": glow.saturation,
    "--glow-opacity": glow.opacity,
  } as CSSProperties;

  return (
    <>
    <div
      id="player-overlay"
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        backdropPressRef.current = t.id === "player-overlay" || t.id === "player-container";
      }}
      onClick={(e) => {
        // a click on the backdrop closes the player, but only when the press started there too: a
        // drag (trim, speed, mixer) released outside the frame lands its click on the backdrop
        const t = e.target as HTMLElement;
        const onBackdrop = t.id === "player-overlay" || t.id === "player-container";
        if (onBackdrop && backdropPressRef.current) void window.legacyPlayer?.closePlayer();
        backdropPressRef.current = false;
      }}
    >
      <div id="player-container" style={glowStyle}>
        {/* the clip's own thumbnail bled out behind the frame; two layers, a wide slow hue drift
            and a tight one breathing with the frame */}
        {glow.enabled && thumbUrl ? <img className="pl-glow pl-glow-wide" src={thumbUrl} alt="" aria-hidden="true" /> : null}
        {/* stage is the inset area; the frame takes the video's own aspect inside it so no letterbox
            ever shows as black, the glow fills the rest */}
        <div className="pl-stage" style={{ "--ar": aspect } as CSSProperties}>
        {glow.enabled && thumbUrl ? <img className="pl-glow pl-glow-frame" src={thumbUrl} alt="" aria-hidden="true" /> : null}
        {/* same box as the frame, so the chevrons hang just outside its edges whatever its aspect */}
        <div className="pl-frame-box">
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
            <ChevronLeft size={18} strokeWidth={2.2} />
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
            <ChevronRight size={18} strokeWidth={2.2} />
          </button>
        </div>
        <div id="fullscreen-player">
          <div id="video-container">
            <div
              id="video-click-target"
              onClick={() => {
                // legacy's native listener toggled play/pause before this ran, so paused is already the new state
                const video = document.getElementById("video-player") as HTMLVideoElement | null;
                setFlash((f) => ({ n: f.n + 1, playing: !!video && !video.paused }));
              }}
            />
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video id="video-player" />
            <div id="loading-overlay">
              <div className="loading-spinner" />
            </div>
            {flash.n > 0 ? (
              <div key={flash.n} className="pl-flash" aria-hidden="true">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="#fff">
                  <path d={flash.playing ? "M7 5l12 7-12 7z" : "M7 5h4v14H7zM13 5h4v14h-4z"} />
                </svg>
              </div>
            ) : null}
          </div>
          <div id="video-controls">
            {/* top: title pill left, actions pill right */}
            <div id="top-controls">
              <div className="pl-pill pl-title">
                <input type="text" id="clip-title" placeholder="Clip title" spellCheck={false} />
              </div>
              <div className="pl-pill pl-actions">
                <button
                  id="export-button"
                  type="button"
                  title="Export (Ctrl: video file · Shift: audio to clipboard · Ctrl+Shift: audio file)"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.ctrlKey && e.shiftKey) runExport(exportAudioWithFileSelection);
                    else if (e.ctrlKey) runExport(exportVideoWithFileSelection);
                    else if (e.shiftKey) runExport((p) => exportAudio(null, p));
                    else runExport(exportTrimmedVideo);
                  }}
                >
                  <Copy size={12} />
                  Copy
                </button>
                <button
                  id="share-button"
                  className={shareConnected ? undefined : "share-hidden"}
                  type="button"
                  title="Publish to ClipLib"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShareOpen(true);
                  }}
                >
                  <Upload size={12} />
                  Post to feed
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
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            {/* bottom pill: volume, time, timeline, duration, speed, fullscreen */}
            <div id="bottom-controls" className="pl-pill pl-bar">
              <div id="volume-container">
                <div id="audio-tracks-panel" className="hidden" />
                {/* legacy toggles .normalized on the button; the badge reads it through the container */}
                <span className="pl-auto-pill" aria-hidden="true">auto</span>
                <button
                  id="volume-button"
                  type="button"
                  aria-label="Volume"
                  onWheel={(e) => {
                    // wheel nudges every track together, or the master level on single-track clips
                    const delta = e.deltaY < 0 ? 0.05 : -0.05;
                    const manager = window.legacyPlayer?.getActiveAudioTracksManager?.();
                    if (manager) manager.nudgeAll(delta);
                    else window.legacyPlayer?.changeVolume(delta);
                  }}
                />
                <input type="range" id="volume-slider" min="0" max="2" step="0.1" defaultValue="1" className="collapsed" />
              </div>
              <div id="current-time">0:00</div>
              <Timeline waveform={session?.waveform ?? null} tracks={tracks} open={isOpen} gain={masterVolume} />
              <div id="total-time">0:00</div>
              <div id="speed-container">
                {/* legacy writes these two; the drum is what the user sees */}
                <button id="speed-button" type="button" tabIndex={-1} aria-hidden="true">
                  <span id="speed-text">1x</span>
                </button>
                <input type="range" id="speed-slider" min="0.5" max="2" step="0.25" defaultValue="1" className="collapsed" aria-hidden="true" />
                <SpeedDrum />
              </div>
              <button id="fullscreen-button" type="button" aria-label="Fullscreen">
                <Maximize size={14} />
              </button>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>

    {/* legacy markup, positioned fixed at document level (outside the overlay stacking context) so it stays visible */}
    <ExportProgress/>

    <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </>
  );
}

// DOM is driven imperatively by legacy code after init; memo keeps app-shell state changes from
// re-rendering this large static tree
export default memo(VideoPlayer);
