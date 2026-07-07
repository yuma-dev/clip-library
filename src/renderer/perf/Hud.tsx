// Live profiler HUD (dev-only). Toggle with Ctrl+Shift+P.
//
// A small always-on-top overlay with the numbers that matter while you click
// around: FPS, dropped frames, last long task, in-flight IPC, worst interaction
// this session, buffered event count. "Dump trace" merges renderer + main events
// into one Chrome-trace JSON on disk (benchmark/traces/) and reveals it — open in
// chrome://tracing or Perfetto for the full cross-process flame graph.

import { useEffect, useRef, useState } from "react";
import { getStats, resetStats, clearBuffer, snapshotForDump, type LiveStats } from "./trace";
import { dumpTrace } from "./bridge";

function fpsColor(fps: number): string {
  if (fps >= 55) return "#4ade80";
  if (fps >= 30) return "#fbbf24";
  return "#f87171";
}

export function PerfHud() {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<LiveStats>(getStats);
  const [saved, setSaved] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) {
      if (timer.current) clearInterval(timer.current);
      return;
    }
    timer.current = setInterval(() => setStats(getStats()), 250);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [open]);

  if (!open) return null;

  const onDump = async () => {
    setSaved("saving…");
    try {
      const res = await dumpTrace(snapshotForDump());
      setSaved(res ? `saved ${res.eventCount} events` : "saved");
    } catch (err) {
      setSaved(`error: ${String(err)}`);
    }
  };

  const row = (label: string, value: string, color?: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ color, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );

  return (
    <div
      style={{
        position: "fixed", top: 44, right: 12, zIndex: 2147483647,
        width: 240, padding: "10px 12px", borderRadius: 10,
        background: "rgba(8,10,14,0.92)", border: "1px solid rgba(255,255,255,0.12)",
        color: "#e5e7eb", font: "12px/1.5 ui-monospace, monospace",
        backdropFilter: "blur(8px)", pointerEvents: "auto", userSelect: "none",
        boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontWeight: 600 }}>
        <span>⚡ perf</span>
        <span style={{ opacity: 0.5, fontWeight: 400 }}>Ctrl+Shift+P</span>
      </div>
      {row("FPS", String(stats.fps), fpsColor(stats.fps))}
      {row("dropped frames", String(stats.droppedFrames))}
      {row("long tasks", String(stats.longTaskCount))}
      {row("last long task", stats.lastLongTaskMs ? `${Math.round(stats.lastLongTaskMs)}ms` : "—")}
      {row("IPC in-flight", String(stats.inFlightIpc), stats.inFlightIpc > 0 ? "#fbbf24" : undefined)}
      {row(
        "worst interaction",
        stats.worstInteraction ? `${Math.round(stats.worstInteraction.durMs)}ms` : "—",
        stats.worstInteraction && stats.worstInteraction.durMs > 200 ? "#f87171" : undefined,
      )}
      {stats.worstInteraction ? (
        <div style={{ opacity: 0.55, fontSize: 11, marginTop: -2, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {stats.worstInteraction.label}
        </div>
      ) : null}
      {row("events buffered", String(stats.eventCount))}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button onClick={onDump} style={btn}>Dump trace</button>
        <button onClick={() => { clearBuffer(); resetStats(); setSaved(null); }} style={btn}>Clear</button>
      </div>
      {saved ? <div style={{ marginTop: 6, opacity: 0.7, fontSize: 11 }}>{saved}</div> : null}
    </div>
  );
}

const btn: React.CSSProperties = {
  flex: 1, padding: "4px 6px", borderRadius: 6, cursor: "pointer",
  background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)",
  color: "#e5e7eb", font: "inherit",
};
