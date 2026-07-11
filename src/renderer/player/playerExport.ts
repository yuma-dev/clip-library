// Player export actions. Reimplements the thin arg-gathering of the legacy
// export-manager against window.clips.* — the fragile encoder-fallback /
// benchmark / clipboard logic lives in the main process, not here.
//
// savePath === null means "export to clipboard".

/** (current, total, isClipboard) — mirrors the legacy showExportProgress. */
export type ProgressFn = (current: number, total: number, clipboard: boolean) => void;

/** Current playback rate drives export speed (>0, else 1×). */
function speed(): number {
  const v = document.getElementById("video-player") as HTMLVideoElement | null;
  const r = Number(v?.playbackRate);
  return Number.isFinite(r) && r > 0 ? r : 1;
}

/** Per-clip saved volume (master gain applied to the export). */
async function loadVolume(name: string): Promise<number> {
  const p = window.legacyPlayer;
  if (p?.loadVolume) {
    try {
      return await p.loadVolume(name);
    } catch {
      /* fall through to unity */
    }
  }
  return 1;
}

/** Multi-track mix snapshot, or null for single-track clips. */
function audioMix(): unknown {
  const mgr = window.legacyPlayer?.getActiveAudioTracksManager?.();
  if (mgr?.getExportMix) {
    try {
      return mgr.getExportMix();
    } catch {
      /* single-track / not ready */
    }
  }
  return null;
}

interface ExportCtx {
  name: string;
  start: number;
  end: number;
}

function ctx(): ExportCtx | null {
  const s = window.legacyState;
  const clip = s?.currentClip;
  if (!clip) return null;
  return { name: clip.originalName as string, start: s?.trimStartTime ?? 0, end: s?.trimEndTime ?? 0 };
}

/** Export the current trim as video to the clipboard (default action). */
export async function exportTrimmedVideo(onProgress?: ProgressFn): Promise<void> {
  const c = ctx();
  if (!c) return;
  // Legacy parity: surfaces the FFmpeg version in main's log right before an
  // export, so failed-export diagnostics always carry it. Result unused.
  window.clips.getFfmpegVersion().catch(() => {});
  onProgress?.(0, 100, true);
  const res = await window.clips.exportTrimmedVideo(
    c.name,
    c.start,
    c.end,
    await loadVolume(c.name),
    speed(),
    audioMix(),
  );
  if (res?.success) onProgress?.(100, 100, true);
  else throw new Error(res?.error || "Export failed");
}

/** Export the current trim as a video file at savePath. */
export async function exportVideoToFile(savePath: string, onProgress?: ProgressFn): Promise<void> {
  const c = ctx();
  if (!c) return;
  onProgress?.(0, 100, false);
  const res = await window.clips.exportVideo(
    c.name,
    c.start,
    c.end,
    await loadVolume(c.name),
    speed(),
    savePath,
    audioMix(),
  );
  if (res?.success) onProgress?.(100, 100, false);
  else throw new Error(res?.error || "Export failed");
}

/** Export the current trim's audio — to a file (savePath) or the clipboard (null). */
export async function exportAudio(savePath: string | null, onProgress?: ProgressFn): Promise<void> {
  const c = ctx();
  if (!c) return;
  const clipboard = !savePath;
  onProgress?.(0, 100, clipboard);
  const res = await window.clips.exportAudio(
    c.name,
    c.start,
    c.end,
    await loadVolume(c.name),
    speed(),
    savePath,
    audioMix(),
  );
  if (res?.success) onProgress?.(100, 100, clipboard);
  else throw new Error(res?.error || "Audio export failed");
}

/** Prompt for a path, then export video there. */
export async function exportVideoWithFileSelection(onProgress?: ProgressFn): Promise<void> {
  const clip = window.legacyState?.currentClip;
  if (!clip) return;
  const savePath = await window.clips.openSaveDialog("video", clip.originalName, clip.customName);
  if (savePath) await exportVideoToFile(savePath, onProgress);
}

/** Prompt for a path, then export audio there. */
export async function exportAudioWithFileSelection(onProgress?: ProgressFn): Promise<void> {
  const clip = window.legacyState?.currentClip;
  if (!clip) return;
  const savePath = await window.clips.openSaveDialog("audio", clip.originalName, clip.customName);
  if (savePath) await exportAudio(savePath, onProgress);
}

/**
 * Export a clip that is NOT open in the player (grid right-click menu) to the
 * clipboard. Loads the saved trim/volume/speed from disk — the clip has no live
 * player state or multi-track mix to read — mirroring the legacy
 * exportClipFromContextMenu (always a clipboard export).
 */
export async function exportClipToClipboard(originalName: string, onProgress?: ProgressFn): Promise<void> {
  const info = await window.clips.getClipInfo(originalName);
  const trim = await window.clips.getTrim(originalName);
  const start = trim ? trim.start : 0;
  const end = trim ? trim.end : (info?.format?.duration ?? 0);
  const volume = await window.clips.getVolume(originalName).catch(() => 1);
  const speed = await window.clips.getSpeed(originalName).catch(() => 1);
  onProgress?.(0, 100, true);
  const res = await window.clips.exportTrimmedVideo(originalName, start, end, volume, speed);
  if (res?.success) onProgress?.(100, 100, true);
  else throw new Error(res?.error || "Export failed");
}
