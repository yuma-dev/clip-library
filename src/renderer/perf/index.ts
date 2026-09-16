// dev-only profiler entry, one import surface for main.tsx/App.tsx; callers guard on
// import.meta.env.DEV so the whole subtree tree-shakes out of production
// `window.__perf?.interaction("open-clip")` relabels the active interaction for the trace

import { instrumentIpc } from "./ipc";
import { startFrameMonitor } from "./frames";
import { startInteractionTracker, beginInteraction } from "./interactions";
import { snapshotForDump, getStats, instant, TID } from "./trace";
import { dumpTrace } from "./bridge";

let started = false;

export function initPerf(): void {
  if (started) return;
  started = true;
  // left edge of the renderer's slice of the startup timeline
  instant("renderer:perf-init", TID.frames);
  instrumentIpc();
  startFrameMonitor();
  startInteractionTracker();

  // snapshot is the full session from boot, so dumps always include startup phases
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
