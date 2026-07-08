import { useSyncExternalStore } from "react";

// App-update state shared by the rail pill and Settings → About. Main pushes
// `show-update-notification` from its background check on startup (non-silent,
// main.js did-finish-load → updater.js), then `download-progress` (bare 0-100
// number), `update-download-complete` ({path}) and `update-download-error`
// ({message, manualUpdateUrl}) once a download is started via `start-update`.
// Main launches the installer and quits itself after completion, so the
// "downloaded" phase is a short-lived "Launching installer…" state.

export type UpdaterPhase = "idle" | "available" | "downloading" | "downloaded" | "error";

export interface UpdaterState {
  phase: UpdaterPhase;
  latestVersion: string | null;
  /** Raw GitHub release-body markdown (unused by the pill, kept for future UI). */
  changelog: string | null;
  percent: number;
}

let state: UpdaterState = { phase: "idle", latestVersion: null, changelog: null, percent: 0 };
const listeners = new Set<() => void>();

function setState(next: Partial<UpdaterState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

let wired = false;
function wire(): void {
  if (wired || !window.clips) return;
  wired = true;
  window.clips.onShowUpdateNotification((payload: { latestVersion?: string; changelog?: string }) => {
    // Never regress an in-flight download back to "available".
    if (state.phase === "downloading" || state.phase === "downloaded") return;
    setState({
      phase: "available",
      latestVersion: payload?.latestVersion ?? null,
      changelog: payload?.changelog ?? null,
    });
  });
  window.clips.onDownloadProgress((progress: number) => {
    if (state.phase === "downloaded") return;
    setState({ phase: "downloading", percent: Math.max(0, Math.min(100, Math.round(Number(progress) || 0))) });
  });
  window.clips.onUpdateDownloadComplete(() => setState({ phase: "downloaded", percent: 100 }));
  window.clips.onUpdateDownloadError(() => setState({ phase: "error" }));
}

/** Feed a manual Settings → About check result into the shared state so the pill appears. */
export function reportUpdateAvailable(latestVersion: string | null, changelog?: string | null): void {
  if (state.phase === "downloading" || state.phase === "downloaded") return;
  setState({ phase: "available", latestVersion, changelog: changelog ?? state.changelog });
}

/** Kick off download + install (main quits into the installer when done). */
export async function startUpdateDownload(): Promise<void> {
  if (state.phase === "downloading" || state.phase === "downloaded") return;
  if (fakeDownload) {
    fakeDownload();
    return;
  }
  setState({ phase: "downloading", percent: 0 });
  try {
    await window.clips.startUpdate();
  } catch {
    setState({ phase: "error" });
  }
}

function subscribe(cb: () => void): () => void {
  wire();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useUpdater(): UpdaterState {
  return useSyncExternalStore(subscribe, () => state);
}

// Dev-only visual test hook: __fakeUpdate() shows the pill; clicking it then
// runs a simulated download instead of the real start-update invoke.
// __clearFakeUpdate() resets. Mirrors the Game Launcher harness.
let fakeDownload: (() => void) | null = null;
if (import.meta.env.DEV) {
  let fakeTimer: ReturnType<typeof setInterval> | null = null;
  (window as unknown as Record<string, unknown>).__fakeUpdate = () => {
    setState({ phase: "available", latestVersion: "9.9.9" });
    fakeDownload = () => {
      let pct = 0;
      setState({ phase: "downloading", percent: 0 });
      fakeTimer = setInterval(() => {
        pct += 7;
        if (pct >= 100) {
          if (fakeTimer) clearInterval(fakeTimer);
          setState({ phase: "downloaded", percent: 100 });
        } else setState({ percent: pct });
      }, 200);
    };
  };
  (window as unknown as Record<string, unknown>).__clearFakeUpdate = () => {
    if (fakeTimer) clearInterval(fakeTimer);
    fakeDownload = null;
    setState({ phase: "idle", latestVersion: null, changelog: null, percent: 0 });
  };
}
