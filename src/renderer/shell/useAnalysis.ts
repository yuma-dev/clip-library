import { useSyncExternalStore } from "react";
import type { AnalysisProgress } from "../../types/clips";

// shared by the rail pill and Settings > Audio; main events: analysis-progress (queue state,
// throttled to 4/s) plus one get-analysis-progress read at first subscribe for the counts

export interface AnalysisState extends AnalysisProgress {
  /** clips with a current sidecar; refreshed when the queue drains */
  analyzed: number;
  /** library size at last read */
  libraryTotal: number;
  loaded: boolean;
}

let state: AnalysisState = {
  running: false,
  paused: false,
  pending: 0,
  total: 0,
  done: 0,
  etaSeconds: null,
  analyzed: 0,
  libraryTotal: 0,
  loaded: false,
};
const listeners = new Set<() => void>();

function setState(next: Partial<AnalysisState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function refreshAnalysis(): void {
  window.clips
    ?.getAnalysisProgress()
    .then((p) => setState({ ...p, analyzed: p.analyzed, libraryTotal: p.total, loaded: true }))
    .catch(() => undefined);
}

let wired = false;
function wire(): void {
  if (wired || !window.clips) return;
  wired = true;
  let wasRunning = false;
  window.clips.onAnalysisProgress((p) => {
    setState(p);
    // the queue drained: recount the sidecars for the done state
    if (wasRunning && !p.running) refreshAnalysis();
    wasRunning = p.running;
  });
  refreshAnalysis();
}

function subscribe(cb: () => void): () => void {
  wire();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useAnalysis(): AnalysisState {
  return useSyncExternalStore(subscribe, () => state);
}
