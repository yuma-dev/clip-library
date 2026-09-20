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

/** the master level the export applies. while the clip is open that is the live master node: a
 * matched multi-track clip carries its gain on the tracks and keeps the master at 1, and the saved
 * level (the matched gain) would count it twice. otherwise the saved level */
async function loadVolume(name: string): Promise<number> {
  const s = window.legacyState;
  const live = s?.gainNode?.gain?.value;
  if (s?.currentClip?.originalName === name && Number.isFinite(live)) return live as number;
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

interface SavedTrack {
  ordinal: number;
  streamIndex: number;
  name?: string;
}

/** the mix the player would build for a multi-track clip that is not open, from what the mixer
 * persists: hidden by global pref (Mix hidden by default), per-clip mute and hand-set levels,
 * the matched gain on every other track unless the clip has its own master level. null for
 * single-track clips, where the master carries everything */
async function savedMix(originalName: string, tracks: SavedTrack[], detail: { source: string; gain?: number }): Promise<unknown> {
  if (tracks.length < 2) return null;
  const [state, prefs] = await Promise.all([
    window.clips.getTrackState(originalName).catch(() => null),
    window.clips.getTrackPreferences().catch(() => null),
  ]);
  const saved = (state?.tracks ?? {}) as Record<string, { volume?: number; muted?: boolean; custom?: boolean }>;
  const global = (prefs ?? {}) as Record<string, { hidden?: boolean }>;
  const matched = detail.source === "normalized" && Number.isFinite(detail.gain) ? (detail.gain as number) : null;
  return tracks
    .filter((t) => {
      const name = t.name || `Track ${t.ordinal + 1}`;
      const hidden = global[name]?.hidden !== undefined ? !!global[name].hidden : name === "Mix";
      return !hidden && !saved[t.ordinal]?.muted;
    })
    .map((t) => {
      const s = saved[t.ordinal] ?? {};
      // same rule as the mixer: a saved 1 from before the custom flag counts as unset
      const custom = Number.isFinite(s.volume) && (s.custom === true || s.volume !== 1);
      return { streamIndex: t.streamIndex, ordinal: t.ordinal, volume: custom ? (s.volume as number) : matched ?? 1 };
    });
}

/** exports a clip not open in the player (grid right-click) to the clipboard; loads saved
 * trim/volume/speed from disk since there's no live player state, mirrors legacy exportClipFromContextMenu */
export async function exportClipToClipboard(originalName: string, onProgress?: ProgressFn): Promise<void> {
  const info = await window.clips.getClipInfo(originalName);
  const trim = await window.clips.getTrim(originalName);
  const start = trim ? trim.start : 0;
  const end = trim ? trim.end : (info?.format?.duration ?? 0);
  const detail = await window.clips.getVolumeDetail(originalName).catch(() => ({ volume: 1, source: "default" as const, measured: false }));
  const speed = await window.clips.getSpeed(originalName).catch(() => 1);
  const tracks: SavedTrack[] = Array.isArray(info?.audioTracks) ? info.audioTracks : [];
  const mix = await savedMix(originalName, tracks, detail);
  // a matched multi-track clip carries the gain on its tracks, the master stays at 1
  const volume = mix && detail.source !== "custom" ? 1 : detail.volume;
  onProgress?.(0, 100, true);
  const res = await window.clips.exportTrimmedVideo(originalName, start, end, volume, speed, mix ?? undefined);
  if (res?.success) onProgress?.(100, 100, true);
  else throw new Error(res?.error || "Export failed");
}
