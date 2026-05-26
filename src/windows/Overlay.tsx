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

function cornerStyle(corner: Corner): React.CSSProperties {
  const inset = "2.2vh";
  switch (corner) {
    case "top_left":     return { top: inset, left: inset };
    case "top_right":    return { top: inset, right: inset };
    case "bottom_left":  return { bottom: inset, left: inset };
    case "bottom_right": return { bottom: inset, right: inset };
  }
}

function slideInAnimation(corner: Corner): React.CSSProperties {
  const fromRight = corner === "top_right" || corner === "bottom_right";
  return {
    animation: `${fromRight ? "notif-in-right" : "notif-in-left"} 0.32s cubic-bezier(0.2,0.8,0.25,1) both`,
  };
}

// ---------- sub-components --------------------------------------------------

const NOTIF_SANS = '"Geist", Inter, system-ui, sans-serif';
const NOTIF_MONO = '"Geist Mono", "JetBrains Mono", ui-monospace, monospace';

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: "1.85vh", height: "1.65vh", padding: "0 0.4vh",
      borderRadius: "0.35vh",
      background: "rgba(255,255,255,0.07)",
      color: "rgba(255,255,255,0.72)",
      border: "1px solid rgba(255,255,255,0.1)",
      font: `500 1.2vh/1 ${NOTIF_MONO}`,
    }}>{children}</span>
  );
}

function Thumb({ src, w = "6.4vh", h = "4.2vh" }: { src: string | null; w?: string; h?: string }) {
  // Thumbnail arrives via a separate `clip-thumbnail` event (gdigrab is
  // slow on first run), so the initial render almost always has src=null.
  // A faint pulse on the placeholder signals "image coming".
  return (
    <div style={{
      width: w, height: h, flexShrink: 0,
      borderRadius: "0.35vh",
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

function Spinner({ size = "1.1vh" }: { size?: string }) {
  return (
    <span style={{
      width: size, height: size,
      borderRadius: 999, flexShrink: 0,
      border: "0.18vh solid rgba(255,255,255,0.18)",
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
        ...slideInAnimation(notif.corner),
        display: "inline-flex", alignItems: "center", gap: "1.3vh",
        padding: "1vh 1.6vh",
        borderRadius: "0.55vh",
        background: "rgb(22,22,26)",
        boxShadow: "0 18px 40px -16px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06)",
        cursor: "default",
        userSelect: "none",
      }}
    >
      <Thumb src={notif.thumbnail} />

      <div style={{ display: "flex", flexDirection: "column", gap: "0.2vh" }}>
        {/* header: pip/spinner + label */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.55vh" }}>
          {notif.phase === "saving" ? (
            <Spinner />
          ) : (
            <span style={{
              width: "1.1vh", height: "1.1vh", borderRadius: 999,
              background: renamed ? "#22c55e" : TEAL,
              flexShrink: 0,
              boxShadow: renamed ? "0 0 0.75vh #22c55e88" : `0 0 0.75vh ${TEAL}55`,
              transition: "background 0.3s, box-shadow 0.3s",
            }} />
          )}
          <span style={{
            font: `600 1.3vh/1 ${NOTIF_SANS}`,
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
          <div style={{ height: "2.2vh", minWidth: "17vh" }} />
        ) : (
          <div
            onClick={() => inputRef.current?.focus()}
            style={{
              cursor: "text",
              position: "relative",
              height: "2.2vh",
              minWidth: "17vh",
              display: "flex",
              alignItems: "center",
            }}
          >
            {!focused && !renamed && (
              <div style={{
                font: `500 1.4vh/1 ${NOTIF_SANS}`,
                color: "rgba(255,255,255,0.5)",
                display: "flex", alignItems: "center", gap: "0.45vh",
                pointerEvents: "none",
                whiteSpace: "nowrap",
              }}>
                <Kbd>Ctrl</Kbd>
                <span style={{ opacity: 0.45 }}>+</span>
                <Kbd>F10</Kbd>
                <span style={{ opacity: 0.85, marginLeft: "0.2vh" }}>to rename</span>
              </div>
            )}
            {renamed && (
              <span style={{
                font: `500 1.65vh/1 ${NOTIF_SANS}`,
                color: "rgba(255,255,255,0.7)",
                letterSpacing: "-0.005em",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: "26vh",
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
                  font: `500 1.65vh/1 ${NOTIF_SANS}`,
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
      if (p.sound) {
        // Served from `assets/sound/save.wav` via Vite's publicDir.
        const audio = new Audio("/sound/save.wav");
        audio.play().catch(err => console.warn("[overlay] save sound failed:", err));
      }
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
