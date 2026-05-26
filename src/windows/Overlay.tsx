import { useEffect, useRef, useState, useCallback } from "react";
import { listen, invoke } from "@/lib/tauri";

// ---------- types -----------------------------------------------------------

interface ClipSavingPayload {
  thumbnail: string | null;
  rename_hotkey: string;
  auto_dismiss_secs: number;
  corner: string;
  sound: boolean;
  profile: boolean;
}

interface ClipSavedPayload {
  path: string;
  title: string;
}

interface ClipThumbnailPayload {
  thumbnail: string;
}

type Corner = "top_left" | "top_right" | "bottom_left" | "bottom_right";

// ---------- helpers ---------------------------------------------------------

const TEAL = "oklch(0.74 0.13 195)";

// The overlay window is now small (480x140), so CSS `vh` units resolve
// to the window height — not the screen. Multiply by the actual screen
// height instead so the notification renders at the same physical size
// as before regardless of window size.
const SCREEN_VH_PX =
  typeof window !== "undefined" ? window.screen.height / 100 : 10.8;
const vh = (n: number) => `${n * SCREEN_VH_PX}px`;

// Inner offset of the notification card from the window edge. Combined
// with the small overlay window's screen position (which sits flush at
// the screen corner), this is the visible distance from the screen edge
// to the card.
const CARD_INSET_PX = 24;

function cornerStyle(corner: Corner): React.CSSProperties {
  switch (corner) {
    case "top_left":     return { top: CARD_INSET_PX,    left: CARD_INSET_PX };
    case "top_right":    return { top: CARD_INSET_PX,    right: CARD_INSET_PX };
    case "bottom_left":  return { bottom: CARD_INSET_PX, left: CARD_INSET_PX };
    case "bottom_right": return { bottom: CARD_INSET_PX, right: CARD_INSET_PX };
  }
}

function enterAnimation(): React.CSSProperties {
  // Fade + tiny scale-up. We can no longer slide horizontally — the
  // overlay window is sized to fit the card, so a translateX would
  // immediately clip at the window's edge. Fade-in is also kinder on
  // the GPU than a sliding translate.
  return {
    animation: `notif-pop-in 0.22s cubic-bezier(0.2,0.8,0.25,1) both`,
  };
}

// ---------- sub-components --------------------------------------------------

const NOTIF_SANS = '"Geist", Inter, system-ui, sans-serif';
const NOTIF_MONO = '"Geist Mono", "JetBrains Mono", ui-monospace, monospace';

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: vh(1.85), height: vh(1.65), padding: `0 ${vh(0.4)}`,
      borderRadius: vh(0.35),
      background: "rgba(255,255,255,0.07)",
      color: "rgba(255,255,255,0.72)",
      border: "1px solid rgba(255,255,255,0.1)",
      font: `500 ${vh(1.2)}/1 ${NOTIF_MONO}`,
    }}>{children}</span>
  );
}

function Thumb({ src, w = vh(6.4), h = vh(4.2) }: { src: string | null; w?: string; h?: string }) {
  // Thumbnail arrives via a separate `clip-thumbnail` event (gdigrab is
  // slow on first run), so the initial render almost always has src=null.
  // A faint pulse on the placeholder signals "image coming".
  return (
    <div style={{
      width: w, height: h, flexShrink: 0,
      borderRadius: vh(0.35),
      background: "#0a0a0c",
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
      overflow: "hidden",
      animation: src ? "none" : "pulse 1.4s ease-in-out infinite",
    }}>
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          style={{
            width: "100%", height: "100%",
            objectFit: "cover", objectPosition: "50% 50%",
            userSelect: "none",
            display: "block",
          }}
        />
      )}
    </div>
  );
}

function Spinner({ size = vh(1.1) }: { size?: string }) {
  return (
    <span style={{
      width: size, height: size,
      borderRadius: 999, flexShrink: 0,
      border: `${vh(0.18)} solid rgba(255,255,255,0.18)`,
      borderTopColor: "rgba(255,255,255,0.85)",
      boxSizing: "border-box",
      animation: "notif-spin 0.75s linear infinite",
      display: "inline-block",
    }} />
  );
}

// ---------- notification card -----------------------------------------------

type Phase = "saving" | "saved";

interface NotifState {
  phase: Phase;
  /// `null` until phase=saved. The rename input is hidden until then.
  path: string | null;
  /// Filename stem. `null` until phase=saved.
  title: string | null;
  thumbnail: string | null;
  rename_hotkey: string;
  auto_dismiss_secs: number;
  corner: Corner;
}

function NotificationCard({
  notif,
  onDismiss,
}: {
  notif: NotifState;
  onDismiss: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const [renamed, setRenamed] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-dismiss countdown — only runs in the saved phase. Saving phase
  // can't dismiss because we don't yet know the clip succeeded.
  useEffect(() => {
    if (notif.phase !== "saved") return;
    if (!notif.auto_dismiss_secs || focused) return;
    if (renamed) { setTimeout(onDismiss, 1200); return; }

    const t = setTimeout(onDismiss, notif.auto_dismiss_secs * 1000);
    return () => clearTimeout(t);
  }, [notif.phase, notif.auto_dismiss_secs, focused, renamed, onDismiss]);

  // Listen for global rename-activate event from backend
  useEffect(() => {
    const unlisten = listen("activate-rename", () => activateRename());
    return () => { unlisten.then(f => f()); };
  }, []);

  const activateRename = useCallback(() => {
    // Backend already gates this on active_clip being set, but double-check
    // here so an in-flight saving notification never grabs focus.
    if (notif.phase !== "saved" || focused) return;
    invoke("set_overlay_input_mode", { enabled: true }).catch(console.error);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [notif.phase, focused]);

  const handleFocus = () => {
    setFocused(true);
    invoke("set_overlay_input_mode", { enabled: true }).catch(console.error);
  };

  const handleBlur = () => {
    setFocused(false);
    invoke("set_overlay_input_mode", { enabled: false }).catch(console.error);
  };

  const submitRename = async () => {
    const trimmed = renameValue.trim();
    inputRef.current?.blur();
    if (!trimmed || !notif.path) return;
    try {
      await invoke("rename_clip", { oldPath: notif.path, newName: trimmed });
      setRenamed(true);
      invoke("set_overlay_input_mode", { enabled: false }).catch(console.error);
    } catch (e) {
      console.error("rename failed:", e);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submitRename();
    if (e.key === "Escape") inputRef.current?.blur();
  };

  return (
    <div
      style={{
        ...enterAnimation(),
        display: "inline-flex", alignItems: "center", gap: vh(1.3),
        padding: `${vh(1)} ${vh(1.6)}`,
        borderRadius: vh(0.55),
        background: "rgb(22,22,26)",
        boxShadow: "0 18px 40px -16px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06)",
        cursor: "default",
        userSelect: "none",
      }}
    >
      <Thumb src={notif.thumbnail} />

      <div style={{ display: "flex", flexDirection: "column", gap: vh(0.2) }}>
        {/* header: pip/spinner + label */}
        <div style={{ display: "flex", alignItems: "center", gap: vh(0.55) }}>
          {notif.phase === "saving" ? (
            <Spinner />
          ) : (
            <span style={{
              width: vh(1.1), height: vh(1.1), borderRadius: 999,
              background: renamed ? "#22c55e" : TEAL,
              flexShrink: 0,
              boxShadow: renamed ? `0 0 ${vh(0.75)} #22c55e88` : `0 0 ${vh(0.75)} ${TEAL}55`,
              transition: "background 0.3s, box-shadow 0.3s",
            }} />
          )}
          <span style={{
            font: `600 ${vh(1.3)}/1 ${NOTIF_SANS}`,
            color: "rgba(255,255,255,0.88)",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}>
            {notif.phase === "saving" ? "Clip saving…" : renamed ? "Renamed!" : "Clip saved"}
          </span>
        </div>

        {/* input row — only rendered in saved phase. While saving we
            still reserve the same vertical space so the card doesn't
            visibly resize when phase 2 lands. */}
        {notif.phase === "saving" ? (
          <div style={{ height: vh(2.2), minWidth: vh(17) }} />
        ) : (
          <div
            onClick={() => inputRef.current?.focus()}
            style={{
              cursor: "text",
              position: "relative",
              height: vh(2.2),
              minWidth: vh(17),
              display: "flex",
              alignItems: "center",
            }}
          >
            {!focused && !renamed && (
              <div style={{
                font: `500 ${vh(1.4)}/1 ${NOTIF_SANS}`,
                color: "rgba(255,255,255,0.5)",
                display: "flex", alignItems: "center", gap: vh(0.45),
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}>
                <Kbd>Ctrl</Kbd>
                <span style={{ opacity: 0.45 }}>+</span>
                <Kbd>F10</Kbd>
                <span style={{ opacity: 0.85, marginLeft: vh(0.2) }}>to rename</span>
              </div>
            )}
            {renamed && (
              <span style={{
                font: `500 ${vh(1.65)}/1 ${NOTIF_SANS}`,
                color: "rgba(255,255,255,0.7)",
                letterSpacing: "-0.005em",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: vh(26),
              }}>
                {renameValue || notif.title}
              </span>
            )}
            {!renamed && (
              <input
                ref={inputRef}
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                spellCheck={false}
                style={{
                  position: "absolute", inset: 0,
                  width: "100%", height: "100%",
                  background: "transparent", border: 0, outline: 0, padding: 0, margin: 0,
                  color: "rgba(255,255,255,0.96)",
                  font: `500 ${vh(1.65)}/1 ${NOTIF_SANS}`,
                  letterSpacing: "-0.005em",
                  opacity: focused ? 1 : 0,
                  caretColor: "#fff",
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- overlay root ----------------------------------------------------

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window &&
  (window as unknown as { __TAURI_INTERNALS__: { invoke?: unknown } }).__TAURI_INTERNALS__.invoke !== undefined;

// Corner read from the URL params Rust set when it created the window.
// Used as the initial value before the first clip-saving payload arrives
// so the card lands at the right edge of the window without a flicker.
const URL_CORNER: Corner = (() => {
  if (typeof window === "undefined") return "bottom_right";
  const c = new URLSearchParams(window.location.search).get("corner");
  if (c === "top_left" || c === "top_right" || c === "bottom_left" || c === "bottom_right") {
    return c;
  }
  return "bottom_right";
})();

export default function OverlayWindow() {
  const [notif, setNotif] = useState<NotifState | null>(null);
  // Bumped on every clip-saving event; used as a React `key` on the card
  // so its local state (renamed, focused, rename input value) resets
  // cleanly when a new clip arrives — otherwise the second clip would
  // inherit "Renamed!" from the first.
  const [clipSeq, setClipSeq] = useState(0);

  // Startup diagnostics — remove once overlay is confirmed working
  useEffect(() => {
    console.log("[overlay] mounted, isTauri=", isTauri, "href=", window.location.href);
  }, []);

  // The overlay window is now created on demand per-notification, so the
  // backend's `clip-saving` emit races with React attaching its listener
  // below. Read the stashed payload on mount as a safety net.
  useEffect(() => {
    if (!isTauri) return;
    invoke<ClipSavingPayload | null>("overlay_get_pending")
      .then(p => {
        if (!p) return;
        profileRef.current = !!p.profile;
        flowStartRef.current = performance.now();
        if (p.profile) {
          console.log("[overlay] hydrated from pending payload", {
            ...p,
            thumbnail: p.thumbnail ? `<${p.thumbnail.length} chars>` : null,
          });
        }
        setNotif({
          phase:             "saving",
          path:              null,
          title:             null,
          thumbnail:         p.thumbnail,
          rename_hotkey:     p.rename_hotkey,
          auto_dismiss_secs: p.auto_dismiss_secs,
          corner:            (p.corner as Corner) || URL_CORNER,
        });
        setClipSeq(s => s + 1);
      })
      .catch(err => console.error("[overlay] overlay_get_pending failed:", err));
  }, []);

  // Show a demo notification in browser preview mode
  useEffect(() => {
    if (!isTauri) {
      const t = setTimeout(() => {
        setNotif({
          phase: "saving",
          path: null,
          title: null,
          thumbnail: null,
          rename_hotkey: "Ctrl+F10",
          auto_dismiss_secs: 0,
          corner: (new URLSearchParams(window.location.search).get("corner") as Corner) || "bottom_right",
        });
        setClipSeq(s => s + 1);
        // Simulate phase 2 ~500ms later so the demo shows both states.
        const t2 = setTimeout(() => {
          setNotif(prev => prev ? {
            ...prev,
            phase: "saved",
            path: "C:\\Users\\User\\Videos\\Clipdip\\clip4291.mp4",
            title: "clip4291",
          } : prev);
        }, 600);
        return () => clearTimeout(t2);
      }, 400);
      return () => clearTimeout(t);
    }
  }, []);

  // Wall-clock anchor for one save flow. Set when clip-saving arrives,
  // used to log "received" and "painted" deltas for both phases.
  const flowStartRef = useRef<number | null>(null);
  // Tracks whether the current save flow opted in to profiling. The flag
  // arrives in the saving payload; phase-2 + paint hooks read this ref.
  const profileRef = useRef(false);

  // Phase 1 — clip-saving. Brand-new notification: reset everything,
  // bump the seq so the card unmounts/remounts.
  useEffect(() => {
    console.log("[overlay] registering clip-saving listener");
    const unlisten = listen<ClipSavingPayload>("clip-saving", e => {
      const p = e.payload;
      profileRef.current = !!p.profile;
      const t_recv = performance.now();
      flowStartRef.current = t_recv;
      if (p.profile) {
        console.log(`[overlay] clip-saving received [perf=${t_recv.toFixed(0)}ms]`, {
          ...p,
          thumbnail: p.thumbnail ? `<${p.thumbnail.length} chars>` : null,
        });
      }
      // Sound is now played from the Rust process via PlaySoundW —
      // playing in the webview forced an extra layout/decode pass while
      // WebView2 was already rendering the notification.
      setNotif({
        phase:             "saving",
        path:              null,
        title:             null,
        thumbnail:         p.thumbnail,
        rename_hotkey:     p.rename_hotkey,
        auto_dismiss_secs: p.auto_dismiss_secs,
        corner:            (p.corner as Corner) || "bottom_right",
      });
      setClipSeq(s => s + 1);
    });
    unlisten.catch(err => console.error("[overlay] clip-saving listen failed:", err));
    return () => { unlisten.then(f => f()); };
  }, []);

  // Phase 2 — clip-saved. Merge the title + path into the existing
  // notification; if (somehow) saving phase was missed, materialize the
  // card directly into the saved state.
  useEffect(() => {
    const unlisten = listen<ClipSavedPayload>("clip-saved", e => {
      const p = e.payload;
      if (profileRef.current) {
        const t_recv = performance.now();
        const since = flowStartRef.current != null
          ? ` [+${(t_recv - flowStartRef.current).toFixed(0)}ms since clip-saving]`
          : "";
        console.log(`[overlay] clip-saved received${since}`, p);
      }
      setNotif(prev => prev ? {
        ...prev,
        phase: "saved",
        path: p.path,
        title: p.title,
      } : prev);
    });
    unlisten.catch(err => console.error("[overlay] clip-saved listen failed:", err));
    return () => { unlisten.then(f => f()); };
  }, []);

  // First-paint timer per phase. useEffect fires after React commit but
  // before the browser actually paints, so we hop one RAF to capture the
  // post-paint moment. Logs `since clip-saving` so we can line it up
  // against the backend's `save flow start` anchor. Only logs when this
  // flow was started in profile mode.
  useEffect(() => {
    if (!notif || !profileRef.current) return;
    const t_commit = performance.now();
    const start = flowStartRef.current;
    const tag = notif.phase;
    requestAnimationFrame(() => {
      const t_painted = performance.now();
      const since = start != null
        ? `+${(t_painted - start).toFixed(0)}ms since clip-saving`
        : `perf=${t_painted.toFixed(0)}ms`;
      console.log(
        `[overlay] phase=${tag} painted [${since}, commit→paint=${(t_painted - t_commit).toFixed(1)}ms]`
      );
    });
  }, [notif?.phase, clipSeq]);

  // Thumbnail arrives out-of-band — gdigrab can be slow (~1–2 s the first
  // run), so it's no longer gated to phase 1. Merge whenever it lands.
  useEffect(() => {
    const unlisten = listen<ClipThumbnailPayload>("clip-thumbnail", e => {
      const p = e.payload;
      if (profileRef.current) {
        const since = flowStartRef.current != null
          ? ` [+${(performance.now() - flowStartRef.current).toFixed(0)}ms since clip-saving]`
          : "";
        console.log(`[overlay] clip-thumbnail received${since} <${p.thumbnail.length} chars>`);
      }
      setNotif(prev => prev ? { ...prev, thumbnail: p.thumbnail } : prev);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  // Error case — backend couldn't save the clip. Drop the notification
  // immediately so the user isn't left staring at a spinner forever.
  useEffect(() => {
    const unlisten = listen<string>("clip-error", e => {
      console.warn("[overlay] clip-error received:", e.payload);
      setNotif(null);
    });
    return () => { unlisten.then(f => f()); };
  }, []);

  const dismiss = useCallback(() => {
    setNotif(null);
    invoke("dismiss_notification").catch(console.error);
  }, []);

  const corner: Corner = notif?.corner ?? "bottom_right";

  return (
    <div
      className="fixed inset-0"
      style={{ pointerEvents: "none", background: "transparent" }}
    >
      <div
        className="absolute"
        style={{ ...cornerStyle(corner), pointerEvents: "auto" }}
      >
        {notif && (
          <NotificationCard
            key={clipSeq}
            notif={notif}
            onDismiss={dismiss}
          />
        )}
      </div>
    </div>
  );
}
