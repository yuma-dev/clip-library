import { useSyncExternalStore } from "react";
import type { StorageJobProgress, StorageJobResult, StorageJobSpec } from "../../types/clips";

// main runs storage jobs one at a time; this mirrors the running one for any view that shows it
let current: StorageJobProgress | null = null;
const listeners = new Set<() => void>();
let wired = false;

function wire() {
  if (wired || !window.clips?.onStorageProgress) return;
  wired = true;
  window.clips.onStorageProgress((p) => {
    current = p.state === "done" || p.state === "failed" ? null : p;
    for (const l of listeners) l();
  });
  // a job may already be running after a renderer reload
  void window.clips.getStorageJob?.().then((p) => {
    if (p && !current) {
      current = p;
      for (const l of listeners) l();
    }
  });
}

function subscribe(cb: () => void) {
  wire();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useStorageJob(): StorageJobProgress | null {
  return useSyncExternalStore(subscribe, () => current);
}

export function runStorageJob(spec: StorageJobSpec): Promise<StorageJobResult> {
  wire();
  return window.clips.runStorageJob(spec);
}

export function formatBytes(bytes: number | null | undefined): string {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "-";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

const JOB_VERB: Record<StorageJobSpec["kind"], string> = {
  merge: "Merging clips",
  "keep-longer": "Removing the shorter save",
  delete: "Moving clips to the Recycle Bin",
  shrink: "Shrinking clips",
};

export function jobText(job: StorageJobProgress): string {
  const pct = Math.round((job.progress || 0) * 100);
  const count = job.total && job.total > 1 ? ` (${(job.index ?? 0) + 1} of ${job.total})` : "";
  const phase = job.phase === "align" ? ", lining up the audio" : "";
  return `${JOB_VERB[job.kind] ?? "Working"}${count}${phase}… ${pct}%`;
}
