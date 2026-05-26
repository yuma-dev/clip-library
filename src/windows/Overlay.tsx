import { useEffect, useRef, useState, useCallback } from "react";
import { listen, invoke } from "@/lib/tauri";
import { AnimatePresence, motion } from "framer-motion";

// ---------- types -----------------------------------------------------------

interface ClipSavedPayload {
  path: string;
  title: string;
  thumbnail: string | null;
  rename_hotkey: string;
  auto_dismiss_secs: number;
  corner: string;
}

type Corner = "top_left" | "top_right" | "bottom_left" | "bottom_right";

// ---------- helpers ---------------------------------------------------------

const TEAL = "oklch(0.74 0.13 195)";

function cornerStyle(corner: Corner): React.CSSProperties {
  switch (corner) {
    case "top_left":     return { top: 16, left: 16 };
    case "top_right":    return { top: 16, right: 16 };
    case "bottom_left":  return { bottom: 16, left: 16 };
    case "bottom_right": return { bottom: 16, right: 16 };
  }
}

function slideVariants(corner: Corner) {
  const fromRight = corner === "top_right" || corner === "bottom_right";
  const x = fromRight ? "40px" : "-40px";
  return {
    initial: { x, opacity: 0 },
    animate: {
      x: "0px",
      opacity: 1,
      transition: { duration: 0.52, ease: [0.2, 0.8, 0.25, 1] as [number, number, number, number] },
    },
    exit: {
      x,
      opacity: 0,
      transition: { duration: 0.22, ease: "easeIn" },
    },
  };
}

// ---------- sub-components --------------------------------------------------

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: 10, height: 9, padding: "0 2px",
      borderRadius: 2,
      background: "rgba(255,255,255,0.07)",
      color: "rgba(255,255,255,0.72)",
      border: "1px solid rgba(255,255,255,0.1)",
      font: '500 6.5px/1 "JetBrains Mono", ui-monospace, monospace',
    }}>{children}</span>
  );
}

function Thumb({ src, w = 28, h = 20 }: { src: string | null; w?: number; h?: number }) {
  return (
    <div style={{
      width: w, height: h, borderRadius: 2.5,
      overflow: "hidden", flexShrink: 0, position: "relative",
      boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
      background: "#111",
    }}>
      {src ? (
        <img src={src} alt="" style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          objectFit: "cover", objectPosition: "50% 55%",
        }} />
      ) : (
        <div style={{
          position: "absolute", inset: 0,
          background: "linear-gradient(135deg, #1a1a2e 0%, #0d1117 100%)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <rect x="1" y="2" width="10" height="8" rx="1.5" stroke="rgba(255,255,255,0.2)" strokeWidth="1.2" />
            <circle cx="4" cy="5.5" r="1.5" fill="rgba(255,255,255,0.18)" />
            <path d="M1 9 L4 6.5 L6.5 8.5 L8.5 6 L11 9" stroke="rgba(255,255,255,0.18)" strokeWidth="1.1" strokeLinejoin="round" />
          </svg>
        </div>
      )}
    </div>
  );
}

// ---------- notification card -----------------------------------------------

interface NotifState {
  path: string;
  title: string;
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
  const timerRef = useRef<number | null>(null);

  // Auto-dismiss countdown (silent — no visual ring)
  useEffect(() => {
    if (!notif.auto_dismiss_secs || focused) return;
    if (renamed) { setTimeout(onDismiss, 1200); return; }

    timerRef.current = window.setInterval(() => {
      setRenamed(r => {
        if (r) { clearInterval(timerRef.current!); return r; }
        return r;
      });
    }, 1000);

    const t = setTimeout(onDismiss, notif.auto_dismiss_secs * 1000);
    return () => {
      clearTimeout(t);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [notif.auto_dismiss_secs, focused, renamed, onDismiss]);

  // Listen for global rename-activate event from backend
  useEffect(() => {
    const unlisten = listen("activate-rename", () => activateRename());
    return () => { unlisten.then(f => f()); };
  }, []);

  const activateRename = useCallback(() => {
    if (focused) return;
    invoke("set_overlay_input_mode", { enabled: true }).catch(console.error);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [focused]);

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
    if (!trimmed) return;
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

  const variants = slideVariants(notif.corner);

  return (
    <motion.div
      initial={variants.initial}
      animate={variants.animate}
      exit={variants.exit}
      style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        padding: "5px 9px 5px 5px",
        borderRadius: 8,
        background: "linear-gradient(180deg, rgba(14,14,18,0.88), rgba(8,8,12,0.92))",
        backdropFilter: "blur(28px) saturate(140%)",
        WebkitBackdropFilter: "blur(28px) saturate(140%)",
        boxShadow: "0 18px 40px -16px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.07), inset 0 1px 0 rgba(255,255,255,0.06)",
        cursor: "default",
        userSelect: "none",
      }}
    >
      <Thumb src={notif.thumbnail} />

      <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
        {/* header: pip + label */}
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <span style={{
            width: 6, height: 6, borderRadius: 999,
            background: renamed ? "#22c55e" : TEAL,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
            boxShadow: renamed ? "0 0 4px #22c55e88" : `0 0 4px ${TEAL}55`,
            transition: "background 0.3s, box-shadow 0.3s",
          }}>
            {/* check mark */}
            <svg width={4} height={4} viewBox="0 0 10 10" fill="none">
              <path d="M2 5.2 L4.2 7.2 L8 3" stroke={renamed ? "#fff" : "rgba(0,0,0,0.6)"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span style={{
            font: "600 7px/1 Inter, sans-serif",
            color: "rgba(255,255,255,0.88)",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}>
            {renamed ? "Renamed!" : "Clip saved"}
          </span>
        </div>

        {/* input row */}
        <div
          onClick={() => inputRef.current?.focus()}
          style={{
            cursor: "text",
            position: "relative",
            height: 12,
            minWidth: 92,
            display: "flex",
            alignItems: "center",
          }}
        >
          {!focused && !renamed && (
            <div style={{
              font: "500 7.5px/1 Inter, sans-serif",
              color: "rgba(255,255,255,0.5)",
              display: "flex", alignItems: "center", gap: 2.5,
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}>
              <Kbd>Ctrl</Kbd>
              <span style={{ opacity: 0.45 }}>+</span>
              <Kbd>F10</Kbd>
              <span style={{ opacity: 0.85, marginLeft: 1 }}>to rename</span>
            </div>
          )}
          {renamed && (
            <span style={{
              font: '500 9px/1 "JetBrains Mono", ui-monospace, monospace',
              color: "rgba(255,255,255,0.7)",
              letterSpacing: "-0.005em",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 140,
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
                font: '500 9px/1 "JetBrains Mono", ui-monospace, monospace',
                letterSpacing: "-0.005em",
                opacity: focused ? 1 : 0,
                caretColor: "#fff",
              }}
            />
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ---------- overlay root ----------------------------------------------------

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window &&
  (window as unknown as { __TAURI_INTERNALS__: { invoke?: unknown } }).__TAURI_INTERNALS__.invoke !== undefined;

export default function OverlayWindow() {
  const [notif, setNotif] = useState<NotifState | null>(null);

  // Show a demo notification in browser preview mode
  useEffect(() => {
    if (!isTauri) {
      const t = setTimeout(() => {
        setNotif({
          path: "C:\\Users\\User\\Videos\\Clipdip\\clip4291.mp4",
          title: "clip4291.mp4",
          thumbnail: null,
          rename_hotkey: "Ctrl+F10",
          auto_dismiss_secs: 0,
          corner: (new URLSearchParams(window.location.search).get("corner") as Corner) || "bottom_right",
        });
      }, 400);
      return () => clearTimeout(t);
    }
  }, []);

  useEffect(() => {
    const unlisten = listen<ClipSavedPayload>("clip-saved", e => {
      const p = e.payload;
      setNotif({
        path:              p.path,
        title:             p.title,
        thumbnail:         p.thumbnail,
        rename_hotkey:     p.rename_hotkey,
        auto_dismiss_secs: p.auto_dismiss_secs,
        corner:            (p.corner as Corner) || "bottom_right",
      });
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
        <AnimatePresence mode="wait">
          {notif && (
            <NotificationCard
              key={notif.path}
              notif={notif}
              onDismiss={dismiss}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
