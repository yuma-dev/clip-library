// dev-only renderer<->main bridge for the profiler; window.clips has no perf channels in prod
// so this reaches ipcRenderer directly via window.require (nodeIntegration:true), keeping Vite
// from resolving 'electron' at build time. unreachable -> renderer-only trace dumps as a Blob

import type { TraceEvent } from "./trace";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (...args: unknown[]) => void): void;
}

function getIpc(): IpcRendererLike | null {
  // preferred: preload's dev-only bridge (preload.js has ipcRenderer, the ESM renderer doesn't)
  const bridge = (window as unknown as { __perfIpc?: IpcRendererLike }).__perfIpc;
  if (bridge) return bridge;
  try {
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    if (!req) return null;
    const electron = req("electron") as { ipcRenderer?: IpcRendererLike };
    return electron.ipcRenderer ?? null;
  } catch {
    return null;
  }
}

// filesystem-safe timestamp for the trace filename
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export interface DumpResult {
  file: string;
  eventCount: number;
}

/** main merges its own buffered handler/ffmpeg spans and writes one trace file */
export async function dumpTrace(events: TraceEvent[], opts?: { reveal?: boolean }): Promise<DumpResult | null> {
  const ipc = getIpc();
  if (ipc) {
    const res = (await ipc.invoke("perf:dumpTrace", events, { stamp: stamp(), reveal: opts?.reveal ?? true })) as DumpResult;
    return res;
  }
  // fallback: renderer-only trace as a download
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
