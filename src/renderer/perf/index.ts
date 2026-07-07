// Live performance profiler — renderer entry (dev-only).
//
// One import surface for main.tsx / App.tsx. initPerf() wires up every probe;
// PerfProfiler + PerfHud are the two React pieces. Callers guard on
// import.meta.env.DEV so the whole subtree tree-shakes out of production.
//
// Manual labelling: from anywhere, `window.__perf?.interaction("open-clip")`
// relabels the active interaction so a named flow (e.g. the player open path)
// reads clearly in the trace instead of "pointerdown:clip-card".

import { instrumentIpc } from "./ipc";
import { startFrameMonitor } from "./frames";
import { startInteractionTracker, beginInteraction } from "./interactions";
import { snapshotForDump, getStats, instant, TID } from "./trace";
import { dumpTrace } from "./bridge";

let started = false;

export function initPerf(): void {
  if (started) return;
  started = true;
  // Mark the moment renderer instrumentation comes up — the left edge of the
  // renderer's slice of the startup timeline.
  instant("renderer:perf-init", TID.frames);
  instrumentIpc();
  startFrameMonitor();
  startInteractionTracker();

  // Save on demand: Ctrl+Shift+P → Dump (or window.__perf.dump()). The snapshot
  // is the full session from boot, so it always includes the startup phases.
  (window as unknown as { __perf?: unknown }).__perf = {
    interaction: (label: string) => beginInteraction(label),
    mark: (label: string) => instant(label, TID.frames),
    dump: () => dumpTrace(snapshotForDump()),
    stats: () => getStats(),
  };
  // eslint-disable-next-line no-console
  console.info("[perf] dev:trace profiler on — Ctrl+Shift+P for HUD, Dump to save");
}

export { PerfProfiler } from "./react";
export { PerfHud } from "./Hud";
