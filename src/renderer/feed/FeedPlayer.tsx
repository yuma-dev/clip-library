// In-app ClipLib feed player. Renders THE SAME markup skeleton with THE SAME
// IDs as the local crown-jewel player's #player-overlay (see
// src/renderer/player/VideoPlayer.tsx + player.css) so the entire player.css
// applies verbatim — same size, same hover-revealed controls, same volume
// glyphs — then adds the feed-specific social layer as a BOTTOM SHEET:
//
//   ┌──────────────────────────────┐
//   │            player            │  ← full-size stage, like the local player
//   │                              │
//   ├──────────────────────────────┤
//   │ ▒ uploader · 🔥3 💬2      ˄ │  ← sheet header peeks at the bottom
//   └──────────────────────────────┘
//
// The overlay is a scroll container with two snap regions: the stage and the
// details sheet. Wheel/trackpad scrolls naturally; clicking the peeking header
// glides down to the details (description, featuring, reactions, comments)
// while the bottom of the still-playing video stays visible above the sheet.
//
// HARD RULES (unchanged):
//  - never getElementById/querySelector our own elements — React refs only;
//  - never touch window.legacyPlayer / window.legacyState;
//  - do not edit player/* or player.css;
//  - the `feed-player` class on #player-overlay scopes all overrides in
//    feed-player.css; the portal mounts ONLY while a feed clip is open.

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Maximize,
  MessageSquare,
  Trash2,
  X,
} from "lucide-react";
import { useAppNav } from "../shell/appNav";
import { useSettings } from "../settings/SettingsContext";
import {
  deleteComment as apiDeleteComment,
  fetchClipDetail,
  fetchComments,
  postComment,
  toggleFavorite,
  toggleReaction,
} from "./api";
import { fetchMe, type Me } from "./me";
import { setFeedOpenHandler, type FeedListSync } from "./feedPlayerBus";
import {
  formatDuration,
  formatRelativeTime,
  getAvatarUrl,
  REACTION_EMOJI,
  REACTIONS,
  streamUrl,
  type Clip,
  type ClipDetail,
  type Comment,
} from "./types";
import "./feed-player.css";

// Mounted once at App level; the launching grid passes its optimistic
// mutators through the bus (openFeedClip's `sync` arg), so no props needed.

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const STREAM_URL = streamUrl;

/** Idle time before the hover controls fade out while playing. */
const CONTROLS_HIDE_MS = 2400;
/** Overlay scrollTop past which the details sheet counts as "open". */
const SHEET_OPEN_THRESHOLD = 48;

// The exact volume glyphs the crown-jewel player injects into #volume-button
// (player-legacy/video-player.js `volumeIcons`) — Material Symbols paths.
const VOLUME_PATHS = {
  muted:
    "m720-424-76 76q-11 11-28 11t-28-11q-11-11-11-28t11-28l76-76-76-76q-11-11-11-28t11-28q11-11 28-11t28 11l76 76 76-76q11-11 28-11t28 11q11 11 11 28t-11 28l-76 76 76 76q11 11 11 28t-11 28q-11 11-28 11t-28-11l-76-76Zm-440 64H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z",
  low: "M360-360H240q-17 0-28.5-11.5T200-400v-160q0-17 11.5-28.5T240-600h120l132-132q19-19 43.5-8.5T560-703v446q0 27-24.5 37.5T492-228L360-360Zm380-120q0 42-19 79.5T671-339q-10 6-20.5.5T640-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM480-606l-86 86H280v80h114l86 86v-252ZM380-480Z",
  normal:
    "M760-481q0-83-44-151.5T598-735q-15-7-22-21.5t-2-29.5q6-16 21.5-23t31.5 0q97 43 155 131.5T840-481q0 108-58 196.5T627-153q-16 7-31.5 0T574-176q-5-15 2-29.5t22-21.5q74-34 118-102.5T760-481ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm380-120q0 42-19 79.5T591-339q-10 6-20.5.5T560-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM400-606l-86 86H200v80h114l86 86v-252ZM300-480Z",
  high: "M760-440h-80q-17 0-28.5-11.5T640-480q0-17 11.5-28.5T680-520h80q17 0 28.5 11.5T800-480q0 17-11.5 28.5T760-440ZM584-288q10-14 26-16t30 8l64 48q14 10 16 26t-8 30q-10 14-26 16t-30-8l-64-48q-14-10-16-26t8-30Zm120-424-64 48q-14 10-30 8t-26-16q-10-14-8-30t16-26l64-48q14-10 30-8t26 16q10 14 8 30t-16 26ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm120-246-86 86H200v80h114l86 86v-252ZM300-480Z",
} as const;

function VolumeGlyph({ volume, muted }: { volume: number; muted: boolean }) {
  const kind =
    muted || volume === 0 ? "muted" : volume < 0.5 ? "low" : volume <= 1 ? "normal" : "high";
  return (
    <svg xmlns="http://www.w3.org/2000/svg" height="24" width="24" viewBox="0 -960 960 960" fill="#e8eaed">
      <path d={VOLUME_PATHS[kind]} />
    </svg>
  );
}

export default function FeedPlayer() {
  const nav = useAppNav();
  const { settings } = useSettings();
  // Optimistic mirrors into the grid that opened the current clip.
  const syncRef = useRef<FeedListSync>({});
  const onReactionUpdate = useCallback(
    (clipId: string, emoji: string, action: "added" | "removed") =>
      syncRef.current.onReactionUpdate?.(clipId, emoji, action),
    [],
  );
  const onFavoriteUpdate = useCallback(
    (clipId: string, action: "added" | "removed") =>
      syncRef.current.onFavoriteUpdate?.(clipId, action),
    [],
  );

  // --- Open / clip state ---
  const [clip, setClip] = useState<Clip | null>(null);
  const [list, setList] = useState<Clip[]>([]);
  const [detail, setDetail] = useState<ClipDetail | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [me, setMe] = useState<Me | null>(null);

  // --- Playback state (React-driven; no legacy involvement) ---
  const [playing, setPlaying] = useState(false);
  const [loadingVideo, setLoadingVideo] = useState(true);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [volumeExpanded, setVolumeExpanded] = useState(false);
  const [speedExpanded, setSpeedExpanded] = useState(false);
  // Hover controls, mirroring the legacy player's mousemove + idle-fade UX.
  const [controlsVisible, setControlsVisible] = useState(true);
  // Details sheet (bottom): derived from the overlay scroll position.
  const [sheetOpen, setSheetOpen] = useState(false);

  // --- Reaction/favorite optimistic local state (per open clip) ---
  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>({});
  const [userReactions, setUserReactions] = useState<string[]>([]);
  const [favorited, setFavorited] = useState(false);
  const [reactionPending, setReactionPending] = useState<string | null>(null);
  const [favPending, setFavPending] = useState(false);

  // --- Comment composer ---
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const glowCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const fsPlayerRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const commentsScrollRef = useRef<HTMLDivElement | null>(null);
  // Guards a stale detail/comment fetch from clobbering a newer clip's state.
  const openTokenRef = useRef(0);
  const draggingRef = useRef(false);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const playingRef = useRef(false);
  playingRef.current = playing;

  const isOpen = clip !== null;

  // ---- Registration on the feed bus ----
  const openClip = useCallback((next: Clip, nextList: Clip[], sync?: FeedListSync) => {
    syncRef.current = sync ?? {};
    setClip(next);
    setList(nextList);
  }, []);

  useEffect(() => {
    setFeedOpenHandler(openClip);
    return () => setFeedOpenHandler(null);
  }, [openClip]);

  // ---- Fetch me once (cached in me.ts) ----
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetchMe()
      .then((m) => {
        if (!cancelled) setMe(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // ---- On clip switch: reset per-clip state + refetch detail & comments ----
  useEffect(() => {
    if (!clip) return;
    const token = ++openTokenRef.current;

    // Seed reaction/favorite from the grid clip, then reconcile with detail.
    setReactionCounts(clip.reactionCounts ?? {});
    setUserReactions(clip.userReactions ?? []);
    setFavorited(Boolean(clip.isFavorited));
    setDetail(null);
    setComments([]);
    setDraft("");

    // Reset playback UI (video element resets via keyed remount below).
    setPlaying(false);
    setLoadingVideo(true);
    setCurrent(0);
    setDuration(clip.duration ?? 0);
    setControlsVisible(true);

    // Back to the stage (a prev/next while reading comments shouldn't strand
    // the user inside the previous clip's sheet).
    overlayRef.current?.scrollTo({ top: 0 });

    if (clip.status !== "processing") {
      fetchClipDetail(clip.id)
        .then((d) => {
          if (openTokenRef.current !== token) return;
          setDetail(d);
          setReactionCounts(d.reactionCounts ?? {});
          setUserReactions(d.userReactions ?? []);
          setFavorited(Boolean(d.isFavorited));
        })
        .catch(() => {});

      fetchComments(clip.id)
        .then((c) => {
          if (openTokenRef.current !== token) return;
          setComments(c);
        })
        .catch(() => {});
    }
  }, [clip]);

  // ---- Apply volume/mute/speed to the <video> imperatively ----
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.volume = volume;
      v.muted = muted;
    }
  }, [volume, muted, clip]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed, clip]);

  // ---- Navigation ----
  const index = clip ? list.findIndex((c) => c.id === clip.id) : -1;
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < list.length - 1;

  const navigate = useCallback(
    (dir: number) => {
      setClip((cur) => {
        if (!cur) return cur;
        const i = list.findIndex((c) => c.id === cur.id);
        const ni = i + dir;
        if (ni < 0 || ni >= list.length) return cur;
        return list[ni];
      });
    },
    [list],
  );

  // ---- Close ----
  const close = useCallback(() => {
    const v = videoRef.current;
    if (v) {
      try {
        v.pause();
        v.removeAttribute("src");
        v.load();
      } catch {
        /* ignore */
      }
    }
    window.clearTimeout(hideTimerRef.current);
    setFullscreen(false);
    setSheetOpen(false);
    setClip(null);
    setList([]);
    setDetail(null);
    setComments([]);
  }, []);

  // ---- Playback controls ----
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const seekBy = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + delta));
  }, []);

  const changeVolume = useCallback((delta: number) => {
    setVolume((vol) => {
      const next = Math.max(0, Math.min(1, Math.round((vol + delta) * 100) / 100));
      if (next > 0) setMuted(false);
      return next;
    });
  }, []);

  const toggleMute = useCallback(() => setMuted((m) => !m), []);

  const toggleFullscreen = useCallback(() => setFullscreen((f) => !f), []);

  // ---- Hover controls: show on movement, fade after idle while playing ----
  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (playingRef.current && !draggingRef.current) setControlsVisible(false);
    }, CONTROLS_HIDE_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(hideTimerRef.current), []);

  // Paused → controls stay up (matches the local player's feel).
  useEffect(() => {
    if (!playing) {
      window.clearTimeout(hideTimerRef.current);
      setControlsVisible(true);
    } else {
      pokeControls();
    }
  }, [playing, pokeControls]);

  // ---- Ambient glow: tiny canvas behind the player sampling the video ----
  // Mirrors the local player's #ambient-glow-canvas (10×6 buffer, CSS scales
  // + blurs it). Draws with temporal blending at the configured fps; remote
  // frames taint the canvas but we never read pixels back, so that's fine.
  const glow = (settings.ambientGlow ?? {}) as {
    enabled?: boolean;
    smoothing?: number;
    fps?: number;
    blur?: number;
    saturation?: number;
    opacity?: number;
  };
  const glowEnabled = glow.enabled !== false;

  useEffect(() => {
    if (!isOpen || !glowEnabled) return;
    const canvas = glowCanvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;
    const fps = Math.max(5, Math.min(60, glow.fps ?? 30));
    const interval = 1000 / fps;
    const blend = 1 - Math.max(0, Math.min(0.95, glow.smoothing ?? 0.5));
    let raf = 0;
    let last = 0;
    let first = true;
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      if (!v || v.readyState < 2) return;
      if (ts - last < interval) return;
      last = ts;
      try {
        ctx.globalAlpha = first ? 1 : blend;
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
        first = false;
      } catch {
        /* frame not ready */
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [isOpen, clip, glowEnabled, glow.fps, glow.smoothing]);

  // ---- Details sheet scrolling ----
  const scrollToSheet = useCallback(() => {
    const el = overlayRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight - el.clientHeight, behavior: "smooth" });
  }, []);

  const scrollToStage = useCallback(() => {
    overlayRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const toggleSheet = useCallback(() => {
    if (sheetOpen) scrollToStage();
    else scrollToSheet();
  }, [sheetOpen, scrollToSheet, scrollToStage]);

  const onOverlayScroll = useCallback(() => {
    const el = overlayRef.current;
    if (el) setSheetOpen(el.scrollTop > SHEET_OPEN_THRESHOLD);
  }, []);

  // ---- Progress bar seek (click + drag) ----
  const seekToClientX = useCallback((clientX: number) => {
    const bar = progressRef.current;
    const v = videoRef.current;
    if (!bar || !v || !Number.isFinite(v.duration)) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    v.currentTime = ratio * v.duration;
    setCurrent(v.currentTime);
  }, []);

  const onProgressPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      draggingRef.current = true;
      progressRef.current?.setPointerCapture(e.pointerId);
      seekToClientX(e.clientX);
    },
    [seekToClientX],
  );

  const onProgressPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      seekToClientX(e.clientX);
    },
    [seekToClientX],
  );

  const onProgressPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try {
      progressRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  // ---- Keyboard (document listener while open ONLY) ----
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekBy(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekBy(5);
          break;
        case "ArrowUp":
          e.preventDefault();
          changeVolume(0.1);
          break;
        case "ArrowDown":
          e.preventDefault();
          changeVolume(-0.1);
          break;
        case "m":
        case "M":
          e.preventDefault();
          toggleMute();
          break;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "Escape":
          e.preventDefault();
          // Layered dismissal: fullscreen → details sheet → the player itself.
          if (fullscreen) setFullscreen(false);
          else if (sheetOpen) scrollToStage();
          else close();
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    isOpen,
    fullscreen,
    sheetOpen,
    togglePlay,
    seekBy,
    changeVolume,
    toggleMute,
    toggleFullscreen,
    scrollToStage,
    close,
  ]);

  // ---- Reactions ----
  const onToggleReaction = useCallback(
    async (emoji: string) => {
      if (!clip || reactionPending) return;
      setReactionPending(emoji);
      const removing = userReactions.includes(emoji);
      const action: "added" | "removed" = removing ? "removed" : "added";

      // Optimistic local update.
      const prevCounts = reactionCounts;
      const prevUser = userReactions;
      const nextCounts = { ...reactionCounts };
      nextCounts[emoji] = (nextCounts[emoji] || 0) + (removing ? -1 : 1);
      const nextUser = removing
        ? userReactions.filter((r) => r !== emoji)
        : [...userReactions, emoji];
      setReactionCounts(nextCounts);
      setUserReactions(nextUser);
      onReactionUpdate?.(clip.id, emoji, action);

      try {
        const res = await toggleReaction(clip.id, emoji);
        // Reconcile against server result if it disagrees with our guess.
        if (res.action !== action) {
          onReactionUpdate?.(clip.id, emoji, res.action);
          const fixCounts = { ...prevCounts };
          fixCounts[emoji] = (fixCounts[emoji] || 0) + (res.action === "added" ? 1 : -1);
          setReactionCounts(fixCounts);
          setUserReactions(
            res.action === "added"
              ? [...prevUser.filter((r) => r !== emoji), emoji]
              : prevUser.filter((r) => r !== emoji),
          );
        }
      } catch {
        // Rollback.
        setReactionCounts(prevCounts);
        setUserReactions(prevUser);
        onReactionUpdate?.(clip.id, emoji, removing ? "added" : "removed");
      } finally {
        setReactionPending(null);
      }
    },
    [clip, reactionPending, reactionCounts, userReactions, onReactionUpdate],
  );

  // ---- Favorite ----
  const onToggleFavorite = useCallback(async () => {
    if (!clip || favPending) return;
    setFavPending(true);
    const next = !favorited;
    const action: "added" | "removed" = next ? "added" : "removed";
    setFavorited(next);
    onFavoriteUpdate?.(clip.id, action);
    try {
      const res = await toggleFavorite(clip.id);
      const truth = res.action === "added";
      if (truth !== next) {
        setFavorited(truth);
        onFavoriteUpdate?.(clip.id, res.action);
      }
    } catch {
      setFavorited(!next);
      onFavoriteUpdate?.(clip.id, next ? "removed" : "added");
    } finally {
      setFavPending(false);
    }
  }, [clip, favPending, favorited, onFavoriteUpdate]);

  // ---- Comments ----
  const onPostComment = useCallback(async () => {
    if (!clip || posting) return;
    const content = draft.trim();
    if (!content) return;
    setPosting(true);
    try {
      const comment = await postComment(clip.id, content);
      setComments((prev) => [...prev, comment]);
      setDraft("");
      // Scroll to newest.
      requestAnimationFrame(() => {
        const el = commentsScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } catch {
      /* ignore */
    } finally {
      setPosting(false);
    }
  }, [clip, posting, draft]);

  const onDeleteComment = useCallback(async (commentId: string) => {
    setComments((prev) => prev.filter((c) => c.id !== commentId));
    try {
      await apiDeleteComment(commentId);
    } catch {
      /* comment stays removed locally; a reopen refetches truth */
    }
  }, []);

  // ---- Profile navigation (closes the player) ----
  const openProfile = useCallback(
    (userId: string) => {
      close();
      nav.openProfile(userId);
    },
    [close, nav],
  );

  if (!clip) return null;

  const uploader = clip.user;
  const processing = clip.status === "processing";
  const progressPct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const mentions = detail?.mentions ?? clip.mentions ?? [];
  const description = detail?.description ?? clip.description;
  const resolution =
    (detail?.width ?? clip.width) && (detail?.height ?? clip.height)
      ? `${detail?.width ?? clip.width}×${detail?.height ?? clip.height}`
      : "";
  const totalDuration = duration || clip.duration || 0;

  const topReactions = Object.entries(reactionCounts)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  const overlay = (
    <div
      id="player-overlay"
      className="feed-player"
      ref={overlayRef}
      onScroll={onOverlayScroll}
      onClick={(e) => {
        // Backdrop click closes: the stage area around the player AND the
        // overlay background beside/below the sheet.
        const t = e.target as HTMLElement;
        if (t === e.currentTarget || t.classList.contains("fp-stage") || t.id === "player-container")
          close();
      }}
    >
      {/* ================= STAGE — the player, full size ================= */}
      <div className="fp-stage">
        {glowEnabled && !processing && !fullscreen ? (
          <canvas
            ref={glowCanvasRef}
            className="fp-ambient-glow"
            width={10}
            height={6}
            aria-hidden="true"
            style={{
              filter: `blur(${glow.blur ?? 80}px) saturate(${glow.saturation ?? 1.5})`,
              opacity: glow.opacity ?? 0.7,
            }}
          />
        ) : null}
        <div id="player-container">
          <button
            className="video-nav-button fp-nav-prev"
            type="button"
            aria-label="Previous"
            disabled={!hasPrev}
            onClick={(e) => {
              e.stopPropagation();
              navigate(-1);
            }}
          >
            <ChevronLeft size={24} />
          </button>
          <button
            className="video-nav-button fp-nav-next"
            type="button"
            aria-label="Next"
            disabled={!hasNext}
            onClick={(e) => {
              e.stopPropagation();
              navigate(1);
            }}
          >
            <ChevronRight size={24} />
          </button>

          <div
            id="fullscreen-player"
            ref={fsPlayerRef}
            className={fullscreen ? "custom-fullscreen" : undefined}
          >
            <div
              id="video-container"
              onMouseMove={pokeControls}
              onMouseLeave={() => {
                if (playingRef.current) setControlsVisible(false);
              }}
            >
              {processing ? (
                <div className="fp-processing">Still processing…</div>
              ) : (
                <>
                  <div
                    id="video-click-target"
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePlay();
                    }}
                  />
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video
                    key={clip.id}
                    className="fp-video"
                    ref={videoRef}
                    src={STREAM_URL(clip.id)}
                    autoPlay
                    playsInline
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget;
                      setDuration(v.duration || clip.duration || 0);
                      v.volume = volume;
                      v.muted = muted;
                      v.playbackRate = speed;
                    }}
                    onCanPlay={() => setLoadingVideo(false)}
                    onWaiting={() => setLoadingVideo(true)}
                    onPlaying={() => {
                      setLoadingVideo(false);
                      setPlaying(true);
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onTimeUpdate={(e) => {
                      if (!draggingRef.current) setCurrent(e.currentTarget.currentTime);
                    }}
                    onEnded={() => setPlaying(false)}
                  />
                  {loadingVideo && (
                    <div id="loading-overlay">
                      <div className="loading-spinner" />
                    </div>
                  )}
                </>
              )}

              <div id="video-controls" className={controlsVisible ? "visible" : undefined}>
                {/* TOP: title + actions */}
                <div id="top-controls">
                  <div className="fp-title" title={clip.title}>
                    {clip.title}
                  </div>
                  <div className="player-actions">
                    <button
                      type="button"
                      className={`fp-action${favorited ? " fp-fav-active" : ""}`}
                      aria-label={favorited ? "Remove favorite" : "Add favorite"}
                      title="Favorite"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onToggleFavorite();
                      }}
                    >
                      <Bookmark size={18} fill={favorited ? "currentColor" : "none"} />
                    </button>
                    <button
                      type="button"
                      className={`fp-action${sheetOpen ? " fp-action-on" : ""}`}
                      aria-label="Comments and details"
                      title="Comments & details"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSheet();
                      }}
                    >
                      <MessageSquare size={18} />
                    </button>
                    <button
                      type="button"
                      className="fp-action fp-close"
                      aria-label="Close"
                      title="Close"
                      onClick={(e) => {
                        e.stopPropagation();
                        close();
                      }}
                    >
                      <X size={18} />
                    </button>
                  </div>
                </div>

                {/* BOTTOM: playback row -> progress -> time */}
                <div id="bottom-controls">
                  <div className="playback-row">
                    <div
                      id="volume-container"
                      onMouseEnter={() => setVolumeExpanded(true)}
                      onMouseLeave={() => setVolumeExpanded(false)}
                    >
                      <button
                        id="volume-button"
                        type="button"
                        aria-label="Mute"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleMute();
                        }}
                      >
                        <VolumeGlyph volume={volume} muted={muted} />
                      </button>
                      <input
                        type="range"
                        id="volume-slider"
                        min="0"
                        max="1"
                        step="0.05"
                        value={muted ? 0 : volume}
                        className={volumeExpanded ? undefined : "collapsed"}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setVolume(val);
                          if (val > 0) setMuted(false);
                          else setMuted(true);
                        }}
                      />
                    </div>
                    <div className="playback-right">
                      <div
                        id="speed-container"
                        onMouseEnter={() => setSpeedExpanded(true)}
                        onMouseLeave={() => setSpeedExpanded(false)}
                      >
                        <button
                          id="speed-button"
                          type="button"
                          title="Playback Speed"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span id="speed-text">{speed}x</span>
                        </button>
                        <input
                          type="range"
                          id="speed-slider"
                          min="0.5"
                          max="2"
                          step="0.25"
                          value={speed}
                          className={speedExpanded ? undefined : "collapsed"}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setSpeed(Number(e.target.value))}
                        />
                      </div>
                      <button
                        id="fullscreen-button"
                        type="button"
                        aria-label="Fullscreen"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFullscreen();
                        }}
                      >
                        <Maximize size={19} />
                      </button>
                    </div>
                  </div>

                  <div className="fp-progress-wrap">
                    {/* No #progress-bar fill: the white bar is the local
                        player's draggable trim region — feed clips only need
                        the track + playhead. */}
                    <div
                      id="progress-bar-container"
                      ref={progressRef}
                      onPointerDown={onProgressPointerDown}
                      onPointerMove={onProgressPointerMove}
                      onPointerUp={onProgressPointerUp}
                    >
                      <div id="playhead" style={{ left: `${progressPct}%` }} />
                    </div>
                  </div>

                  <div className="time-row">
                    <div id="current-time">{fmtTime(current)}</div>
                    <div id="total-time">{fmtTime(totalDuration)}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ============ DETAILS SHEET — peeks at the bottom of the stage ============ */}
      <section className="fp-sheet" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="fp-sheet-head" onClick={toggleSheet}>
          <span className="fp-sheet-grip" aria-hidden="true" />
          <span className="fp-sheet-head-row">
            <img
              className="fp-sheet-avatar"
              src={getAvatarUrl(uploader.discordId, uploader.avatarHash, 64)}
              alt=""
            />
            <span className="fp-sheet-uploader">{uploader.displayName}</span>
            <span className="fp-sheet-dot">·</span>
            <span className="fp-sheet-muted">{formatRelativeTime(clip.createdAt)}</span>
            {clip.game ? (
              <>
                <span className="fp-sheet-dot">·</span>
                <span className="fp-sheet-muted">{clip.game}</span>
              </>
            ) : null}
            <span className="fp-sheet-spacer" />
            {topReactions.map(([emoji, count]) => (
              <span key={emoji} className="fp-sheet-pill">
                {REACTION_EMOJI[emoji]} {count}
              </span>
            ))}
            <span className="fp-sheet-pill">
              <MessageSquare size={12} /> {comments.length}
            </span>
            <ChevronDown size={16} className={`fp-sheet-chevron${sheetOpen ? " open" : ""}`} />
          </span>
        </button>

        <div className="fp-sheet-body">
          {/* Left column — clip info + reactions */}
          <div className="fp-info-col">
            <h2 className="fp-info-title">{clip.title}</h2>
            <div className="fp-uploader">
              <img
                className="fp-uploader-avatar"
                src={getAvatarUrl(uploader.discordId, uploader.avatarHash, 64)}
                alt={uploader.displayName}
                onClick={() => openProfile(uploader.id)}
              />
              <div className="fp-uploader-info">
                <button
                  type="button"
                  className="fp-uploader-name"
                  onClick={() => openProfile(uploader.id)}
                >
                  {uploader.displayName}
                </button>
                <div className="fp-uploader-meta">
                  <span>{formatRelativeTime(clip.createdAt)}</span>
                  {clip.game && (
                    <>
                      <span className="fp-dot">·</span>
                      <span className="fp-muted">{clip.game}</span>
                    </>
                  )}
                  {totalDuration > 0 && (
                    <>
                      <span className="fp-dot">·</span>
                      <span>{formatDuration(totalDuration)}</span>
                    </>
                  )}
                  {resolution && (
                    <>
                      <span className="fp-dot">·</span>
                      <span>{resolution}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {description && <p className="fp-description">{description}</p>}

            {mentions.length > 0 && (
              <div className="fp-featuring">
                <div className="fp-featuring-label">Featuring</div>
                <div className="fp-featuring-chips">
                  {mentions.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="fp-mention-chip"
                      onClick={() => openProfile(m.id)}
                    >
                      <img src={getAvatarUrl(m.discordId, m.avatarHash, 32)} alt={m.displayName} />
                      <span>{m.displayName}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="fp-reactions">
              {REACTIONS.map(({ emoji, icon, label }) => {
                const count = reactionCounts[emoji] || 0;
                const active = userReactions.includes(emoji);
                return (
                  <button
                    key={emoji}
                    type="button"
                    title={label}
                    className={`fp-reaction${active ? " active" : ""}`}
                    disabled={reactionPending !== null}
                    onClick={() => void onToggleReaction(emoji)}
                  >
                    <span className="fp-reaction-icon">{icon}</span>
                    {count > 0 && <span className="fp-reaction-count">{count}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right column — comments */}
          <div className="fp-comments">
            <div className="fp-comments-header">Comments ({comments.length})</div>
            <div className="fp-comments-list" ref={commentsScrollRef}>
              {comments.length === 0 ? (
                <p className="fp-comments-empty">No comments yet. Be the first!</p>
              ) : (
                comments.map((c) => {
                  const canDelete = c.user.id === me?.id || Boolean(me?.isAdmin);
                  return (
                    <div key={c.id} className="fp-comment">
                      <img
                        className="fp-comment-avatar"
                        src={getAvatarUrl(c.user.discordId, c.user.avatarHash, 32)}
                        alt={c.user.displayName}
                      />
                      <div className="fp-comment-body">
                        <div className="fp-comment-head">
                          <span className="fp-comment-name">{c.user.displayName}</span>
                          <span className="fp-comment-time">
                            {formatRelativeTime(c.createdAt)}
                          </span>
                          {canDelete && (
                            <button
                              type="button"
                              className="fp-comment-delete"
                              aria-label="Delete comment"
                              title="Delete comment"
                              onClick={() => void onDeleteComment(c.id)}
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                        </div>
                        <p className="fp-comment-content">{c.content}</p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <form
              className="fp-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void onPostComment();
              }}
            >
              <input
                type="text"
                className="fp-composer-input"
                placeholder="Add a comment…"
                maxLength={1000}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button
                type="submit"
                className="fp-composer-post"
                disabled={!draft.trim() || posting}
              >
                Post
              </button>
            </form>
          </div>
        </div>
      </section>
    </div>
  );

  return createPortal(overlay, document.body);
}
