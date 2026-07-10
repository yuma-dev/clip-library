import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke, listen } from "@/lib/tauri";

// Same comet palette as Main.tsx.
const ACCENT = "#8b5cf6";
const ACCENT_HOT = "#d844dd";
const ACCENT_TIP = "#f3e8ff";
const TEAL = "#2dd4bf";
const TEAL_TIP = "#ccfbf1";

type Phase =
  | { tag: "hidden" }
  | { tag: "available"; version: string }
  | { tag: "downloading"; version: string; progress: number | null }
  | { tag: "ready"; version: string }
  | { tag: "error"; version: string; message: string };

/// Floating "Update available" card, bottom-right of the settings window.
/// Two clicks end to end: "Update now" downloads + installs the signed
/// NSIS quietly, "Restart" relaunches into the new version.
export default function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>({ tag: "hidden" });
  // The Update handle from check() — downloadAndInstall lives on it.
  const updateRef = useRef<Update | null>(null);

  const surface = useCallback((version: string) => {
    setPhase(prev =>
      // Don't clobber an in-flight download when the 30s checker re-fires.
      prev.tag === "downloading" || prev.tag === "ready" ? prev : { tag: "available", version });
  }, []);

  // Three discovery paths: the backend's stash (found while this window
  // was closed), the live event (found while it's open), and our own
  // check on mount (fresh open, checker between ticks).
  useEffect(() => {
    invoke<{ version: string; kind?: string } | null>("get_pending_update")
      // "installed" is the post-restart confirmation stash — not actionable.
      .then(p => { if (p && p.kind !== "installed") surface(p.version); })
      .catch(() => {});
    const un = listen<{ version: string }>("update-available", e => surface(e.payload.version));
    check({ timeout: 30_000 })
      .then(u => { if (u) { updateRef.current = u; surface(u.version); } })
      .catch(() => {});
    return () => { un.then(f => f()); };
  }, [surface]);

  const install = useCallback(async () => {
    if (phase.tag !== "available" && phase.tag !== "error") return;
    const version = phase.version;
    setPhase({ tag: "downloading", version, progress: null });
    try {
      const update = updateRef.current ?? (await check({ timeout: 30_000 }));
      if (!update) throw new Error("update no longer available");
      updateRef.current = update;
      let total: number | null = null;
      let got = 0;
      await update.downloadAndInstall(ev => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? null;
        } else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          setPhase({ tag: "downloading", version, progress: total ? got / total : null });
        } else if (ev.event === "Finished") {
          setPhase({ tag: "downloading", version, progress: 1 });
        }
      });
      setPhase({ tag: "ready", version });
    } catch (e) {
      console.error("update install failed:", e);
      setPhase({ tag: "error", version, message: String(e) });
    }
  }, [phase]);

  const visible = phase.tag !== "hidden";
  const pct =
    phase.tag === "downloading" && phase.progress != null
      ? Math.round(phase.progress * 100)
      : null;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.97 }}
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          style={{
            position: "fixed",
            right: 18,
            bottom: 18,
            zIndex: 60,
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "12px 14px 12px 16px",
            borderRadius: 12,
            background: `
              radial-gradient(280px 120px at 0% 0%, ${TEAL}14, transparent 70%),
              radial-gradient(280px 120px at 100% 100%, ${ACCENT}12, transparent 70%),
              rgb(24,24,29)`,
            boxShadow: `0 18px 40px -16px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.07), 0 0 28px -12px ${TEAL}55`,
            overflow: "hidden",
          }}
        >
          {/* Icon puck */}
          <div style={{
            width: 36, height: 36, borderRadius: 10, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: `linear-gradient(145deg, ${TEAL}2e, ${ACCENT}1f)`,
            boxShadow: `inset 0 0 0 1px ${TEAL}40`,
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={TEAL_TIP} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 190 }}>
            <span style={{ font: "700 13.5px/1 Inter, sans-serif", color: "rgba(255,255,255,0.96)", letterSpacing: "-0.005em" }}>
              {phase.tag === "ready" ? "Update ready" :
               phase.tag === "downloading" ? "Downloading update…" :
               phase.tag === "error" ? "Update failed" : "Update available"}
            </span>
            {phase.tag === "downloading" ? (
              <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden", marginTop: 3 }}>
                <div style={{
                  height: "100%", borderRadius: 2,
                  width: pct != null ? `${pct}%` : "40%",
                  background: `linear-gradient(90deg, ${TEAL}, ${TEAL_TIP})`,
                  boxShadow: `0 0 8px ${TEAL}aa`,
                  transition: "width .25s ease",
                  ...(pct == null ? { animation: "updbar 1.1s ease-in-out infinite alternate" } : {}),
                }} />
                <style>{`@keyframes updbar { from { margin-left: 0% } to { margin-left: 60% } }`}</style>
              </div>
            ) : (
              <span style={{ font: "500 11.5px/1.35 Inter, sans-serif", color: "rgba(255,255,255,0.5)" }}>
                {phase.tag === "ready" ? "Restart ClipDip to finish installing" :
                 phase.tag === "error" ? phase.message.slice(0, 90) : (
                  <>ClipDip <span style={{
                    padding: "1px 5px", borderRadius: 4,
                    background: `${TEAL}1f`, border: `1px solid ${TEAL}47`,
                    color: TEAL_TIP,
                    font: "600 10.5px/1.3 'Cascadia Mono', Consolas, ui-monospace, monospace",
                  }}>v{phase.version}</span> is out</>
                 )}
              </span>
            )}
          </div>

          {phase.tag !== "downloading" && (
            <button
              onClick={phase.tag === "ready" ? () => relaunch().catch(console.error) : install}
              style={{
                flexShrink: 0,
                padding: "8px 14px",
                borderRadius: 8,
                border: 0,
                cursor: "pointer",
                background: phase.tag === "ready"
                  ? `linear-gradient(145deg, ${TEAL}e6, #14b8a6)`
                  : `linear-gradient(145deg, ${ACCENT}, ${ACCENT_HOT})`,
                color: phase.tag === "ready" ? "#032726" : ACCENT_TIP,
                font: "600 12px/1 Inter, sans-serif",
                boxShadow: phase.tag === "ready"
                  ? `0 8px 20px -10px ${TEAL}aa`
                  : `0 8px 20px -10px ${ACCENT}aa`,
              }}
            >
              {phase.tag === "ready" ? "Restart" : phase.tag === "error" ? "Retry" : "Update now"}
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
