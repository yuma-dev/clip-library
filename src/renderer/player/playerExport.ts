// reimplements the legacy export-manager's arg-gathering against window.clips.*; the fragile
// encoder-fallback/benchmark/clipboard logic lives in the main process. savePath === null means clipboard

/** (current, total, isClipboard); mirrors the legacy showExportProgress */
export type ProgressFn = (current: number, total: number, clipboard: boolean) => void;

/** current playback rate drives export speed (>0, else 1x) */
function speed(): number {
  const v = document.getElementById("video-player") as HTMLVideoElement | null;
  const r = Number(v?.playbackRate);
  return Number.isFinite(r) && r > 0 ? r : 1;
}

/** per-clip saved volume, master gain applied to the export */
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

/** multi-track mix snapshot, or null for single-track clips */
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

/** exports the current trim as video to the clipboard (default action) */
export async function exportTrimmedVideo(onProgress?: ProgressFn): Promise<void> {
  const c = ctx();
  if (!c) return;
  // surfaces the ffmpeg version in main's log before export, so failed-export diagnostics always
  // carry it (result unused)
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

/** exports the current trim as a video file at savePath */
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

/** exports the current trim's audio, to a file (savePath) or the clipboard (null) */
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

/** prompts for a path, then exports video there */
export async function exportVideoWithFileSelection(onProgress?: ProgressFn): Promise<void> {
  const clip = window.legacyState?.currentClip;
  if (!clip) return;
  const savePath = await window.clips.openSaveDialog("video", clip.originalName, clip.customName);
  if (savePath) await exportVideoToFile(savePath, onProgress);
}

/** prompts for a path, then exports audio there */
export async function exportAudioWithFileSelection(onProgress?: ProgressFn): Promise<void> {
  const clip = window.legacyState?.currentClip;
  if (!clip) return;
  const savePath = await window.clips.openSaveDialog("audio", clip.originalName, clip.customName);
  if (savePath) await exportAudio(savePath, onProgress);
}

/** exports a clip not open in the player (grid right-click) to the clipboard; loads saved
 * trim/volume/speed from disk since there's no live player state, mirrors legacy exportClipFromContextMenu */
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
