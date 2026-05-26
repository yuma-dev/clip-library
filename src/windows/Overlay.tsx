import { useEffect, useRef, useState, useCallback } from "react";
import { listen, invoke } from "@/lib/tauri";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Film, Pencil, X } from "lucide-react";
import { playNotificationSound } from "@/lib/utils";

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

function cornerStyle(corner: Corner): React.CSSProperties {
  switch (corner) {
    case "top_left":     return { top: 24, left: 24 };
    case "top_right":    return { top: 24, right: 24 };
    case "bottom_left":  return { bottom: 24, left: 24 };
    case "bottom_right": return { bottom: 24, right: 24 };
  }
}

function slideVariants(corner: Corner) {
  const fromRight = corner === "top_right" || corner === "bottom_right";
  const x = fromRight ? 120 : -120;
  return {
    initial: { x: `${x}%`, opacity: 0, scale: 0.92 },
    animate: {
      x: "0%",
      opacity: 1,
      scale: 1,
      transition: { type: "spring", stiffness: 380, damping: 28 },
    },
    exit: {
      x: `${x}%`,
      opacity: 0,
      scale: 0.92,
      transition: { duration: 0.25, ease: "easeIn" },
    },
  };
}

// ---------- progress ring ---------------------------------------------------

function ProgressRing({ seconds, total }: { seconds: number; total: number }) {
  const r = 11;
  const circ = 2 * Math.PI * r;
  const progress = total > 0 ? (seconds / total) : 0;
  const dash = circ * (1 - progress);

  return (
    <svg width="28" height="28" className="-rotate-90">
      <circle cx="14" cy="14" r={r} fill="none" stroke="#2a2a3a" strokeWidth="2" />
      <circle
        cx="14" cy="14" r={r}
        fill="none"
        stroke="#7c3aed"
        strokeWidth="2"
        strokeDasharray={circ}
        strokeDashoffset={dash}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.9s linear" }}
      />
      <text
        x="14" y="14"
        textAnchor="middle"
        dominantBaseline="central"
        className="rotate-90"
        style={{ rotate: "90deg", transformOrigin: "14px 14px", fontSize: 9, fill: "#8892a4", fontFamily: "monospace" }}
      >
        {seconds}
      </text>
    </svg>
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
  const [mode, setMode] = useState<"display" | "renaming" | "renamed">("display");
  const [renameValue, setRenameValue] = useState(notif.title);
  const [countdown, setCountdown] = useState(notif.auto_dismiss_secs);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);

  // Auto-dismiss countdown
  useEffect(() => {
    if (notif.auto_dismiss_secs === 0 || mode === "renaming") return;
    if (mode === "renamed") { setTimeout(onDismiss, 1200); return; }

    timerRef.current = window.setInterval(() => {
      setCountdown(n => {
        if (n <= 1) {
          clearInterval(timerRef.current!);
          onDismiss();
          return 0;
        }
        return n - 1;
      });
    }, 1000);

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [notif.auto_dismiss_secs, mode, onDismiss]);

  // Listen for global rename-activate event from backend
  useEffect(() => {
    const unlisten = listen("activate-rename", () => activateRename());
    return () => { unlisten.then(f => f()); };
  }, []);

  const activateRename = useCallback(() => {
    if (mode === "renaming") return;
    if (timerRef.current) clearInterval(timerRef.current);
    setMode("renaming");
    invoke("set_overlay_input_mode", { enabled: true }).catch(console.error);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [mode]);

  const cancelRename = () => {
    setMode("display");
    invoke("set_overlay_input_mode", { enabled: false }).catch(console.error);
    // Restart countdown
    setCountdown(notif.auto_dismiss_secs);
  };

  const submitRename = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    try {
      await invoke("rename_clip", { oldPath: notif.path, newName: trimmed });
      setMode("renamed");
      invoke("set_overlay_input_mode", { enabled: false }).catch(console.error);
    } catch (e) {
      console.error("rename failed:", e);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submitRename();
    if (e.key === "Escape") cancelRename();
  };

  const variants = slideVariants(notif.corner);

  return (
    <motion.div
      initial={variants.initial}
      animate={variants.animate}
      exit={variants.exit}
      className="w-[340px] overflow-hidden rounded-2xl"
      style={{
        background: "rgba(19, 19, 26, 0.92)",
        backdropFilter: "blur(24px) saturate(1.4)",
        border: "1px solid rgba(124, 58, 237, 0.25)",
        boxShadow: "0 8px 40px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(255,255,255,0.05) inset",
      }}
    >
      {/* ── Top purple accent line */}
      <div className="h-0.5 w-full bg-gradient-to-r from-accent via-violet-400 to-transparent" />

      <div className="p-4">
        {/* ── Header row */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/20">
              <Film className="h-3.5 w-3.5 text-accent" />
            </div>
            <span className="text-xs font-semibold uppercase tracking-widest text-text-muted">
              {mode === "renamed" ? "Clip renamed!" : "Clip saved"}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {mode === "display" && notif.auto_dismiss_secs > 0 && (
              <ProgressRing seconds={countdown} total={notif.auto_dismiss_secs} />
            )}
            <button
              className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-bg-raised hover:text-text transition-colors"
              onClick={onDismiss}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* ── Body: thumbnail + info */}
        <div className="flex gap-3">
          {notif.thumbnail ? (
            <img
              src={notif.thumbnail}
              alt="clip thumbnail"
              className="h-16 w-28 flex-shrink-0 rounded-lg object-cover ring-1 ring-white/10"
            />
          ) : (
            <div className="flex h-16 w-28 flex-shrink-0 items-center justify-center rounded-lg bg-bg-raised ring-1 ring-white/10">
              <Film className="h-7 w-7 text-text-faint" />
            </div>
          )}

          <div className="flex min-w-0 flex-col justify-center gap-1">
            <p
              className="truncate text-sm font-semibold text-text"
              title={mode === "renamed" ? renameValue : notif.title}
            >
              {mode === "renamed" ? renameValue : notif.title}
            </p>

            {mode === "display" && (
              <button
                className="flex items-center gap-1.5 text-left text-xs text-text-muted hover:text-accent transition-colors group"
                onClick={activateRename}
                title="Click or press hotkey to rename"
              >
                <Pencil className="h-3 w-3 group-hover:text-accent" />
                <span className="font-mono bg-bg-raised px-1.5 py-0.5 rounded text-[10px]">
                  {notif.rename_hotkey}
                </span>
                <span>to rename</span>
              </button>
            )}

            {mode === "renamed" && (
              <div className="flex items-center gap-1.5 text-xs text-success">
                <Check className="h-3.5 w-3.5" />
                Renamed successfully
              </div>
            )}
          </div>
        </div>

        {/* ── Rename input */}
        <AnimatePresence>
          {mode === "renaming" && (
            <motion.div
              initial={{ height: 0, opacity: 0, marginTop: 0 }}
              animate={{ height: "auto", opacity: 1, marginTop: 12 }}
              exit={{ height: 0, opacity: 0, marginTop: 0 }}
              className="overflow-hidden"
            >
              <div
                className="flex items-center gap-2 rounded-xl p-3"
                style={{
                  background: "rgba(124, 58, 237, 0.08)",
                  border: "1px solid rgba(124, 58, 237, 0.3)",
                }}
              >
                <input
                  ref={inputRef}
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="flex-1 bg-transparent text-sm text-text placeholder:text-text-faint outline-none"
                  placeholder="New clip name…"
                  autoFocus
                  spellCheck={false}
                />
                <div className="flex gap-1.5">
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
                    onClick={submitRename}
                    title="Rename (Enter)"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-bg-raised transition-colors"
                    onClick={cancelRename}
                    title="Cancel (Escape)"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <p className="mt-1.5 text-center text-[10px] text-text-faint">
                Enter to confirm · Escape to cancel
              </p>
            </motion.div>
          )}
        </AnimatePresence>
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
          path: "C:\\Users\\User\\Videos\\Clipdip\\epic-clutch-2024.mp4",
          title: "epic-clutch-2024",
          thumbnail: null,
          rename_hotkey: "Press Ctrl+F10 to rename",
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
        path:             p.path,
        title:            p.title,
        thumbnail:        p.thumbnail,
        rename_hotkey:    p.rename_hotkey,
        auto_dismiss_secs: p.auto_dismiss_secs,
        corner:           (p.corner as Corner) || "bottom_right",
      });
      if (p.auto_dismiss_secs > 0) {
        // sound is gated by the "sound" setting — backend already checks it
        playNotificationSound();
      }
    });

    return () => { unlisten.then(f => f()); };
  }, []);

  const dismiss = useCallback(() => {
    setNotif(null);
    invoke("dismiss_notification").catch(console.error);
  }, []);

  const corner: Corner = notif?.corner ?? "bottom_right";

  return (
    // Full-screen container; pointer-events:none so all unoccupied pixels
    // stay click-through at the CSS level (Tauri also sets ignore_cursor_events).
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
