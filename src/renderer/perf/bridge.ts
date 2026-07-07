// Renderer↔main bridge for the profiler (dev-only).
//
// The production preload facade (window.clips) intentionally has no perf
// channels, so we reach ipcRenderer directly. The main window runs with
// nodeIntegration:true / contextIsolation:false, so Node's require is present on
// window — going through window.require keeps Vite from trying to resolve
// 'electron' at build time. If it isn't reachable, main-side merge is skipped
// and the renderer-only trace still dumps via a Blob download.

import type { TraceEvent } from "./trace";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (...args: unknown[]) => void): void;
}

function getIpc(): IpcRendererLike | null {
  // Preferred: the dev-only bridge the preload exposes (preload always has
  // ipcRenderer; the ESM renderer does not). See preload.js.
  const bridge = (window as unknown as { __perfIpc?: IpcRendererLike }).__perfIpc;
  if (bridge) return bridge;
  // Fallback: some Electron configs still expose Node's require on window.
  try {
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    if (!req) return null;
    const electron = req("electron") as { ipcRenderer?: IpcRendererLike };
    return electron.ipcRenderer ?? null;
  } catch {
    return null;
  }
}

// Filesystem-safe timestamp for the trace filename (main avoids Date here).
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export interface DumpResult {
  file: string;
  eventCount: number;
}

/**
 * Send renderer events to main, which merges its own buffered handler/ffmpeg
 * spans and writes one trace file. Falls back to a browser download if the main
 * bridge is unavailable.
 */
export async function dumpTrace(events: TraceEvent[], opts?: { reveal?: boolean }): Promise<DumpResult | null> {
  const ipc = getIpc();
  if (ipc) {
    const res = (await ipc.invoke("perf:dumpTrace", events, { stamp: stamp(), reveal: opts?.reveal ?? true })) as DumpResult;
    return res;
  }
  // Fallback: renderer-only trace as a download.
  const doc = { traceEvents: events, displayTimeUnit: "ms" };
  const blob = new Blob([JSON.stringify(doc)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `perf-trace-${stamp()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return { file: a.download, eventCount: events.length };
}
