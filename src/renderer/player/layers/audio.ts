import { getLayers } from "./store";
import { gainAt } from "./model";

/** drives the layer gain nodes from the playhead: one per track after the mixer's gain on
 * multi-track clips, one before the master on single-track clips. a frame loop instead of
 * scheduled ramps so seeks, speed changes and edits need no rescheduling */
export function installLayerAudio(): () => void {
  let raf = 0;
  const last = new Map<number, number>();
  let lastOwner: unknown = null;

  const loop = () => {
    raf = requestAnimationFrame(loop);
    const video = document.getElementById("video-player") as HTMLVideoElement | null;
    const { clip, items } = getLayers();
    if (!video || !clip) return;
    const hasVolume = items.some((l) => l.kind === "volume");
    const mgr = window.legacyPlayer?.getActiveAudioTracksManager?.();
    const state = window.legacyState;
    // a new clip or a rebuilt graph starts at unity, the cache would skip the first write
    const owner = mgr?.setLayerGain ? mgr : state?.layerGainNode ?? null;
    if (owner !== lastOwner) {
      last.clear();
      lastOwner = owner;
    }
    // nothing to automate and nothing left off unity: stay idle
    if (!hasVolume && [...last.values()].every((g) => g === 1)) return;
    const t = video.currentTime;

    if (mgr?.setLayerGain) {
      const view = (mgr as { getTracksView?: () => Array<{ ordinal: number }> }).getTracksView?.() ?? [];
      for (const { ordinal } of view) {
        const g = gainAt(items, ordinal, t);
        if (last.get(ordinal) === g) continue;
        last.set(ordinal, g);
        mgr.setLayerGain(ordinal, g);
      }
      return;
    }

    if (!state) return;
    if (!state.layerGainNode) {
      if (!hasVolume) return;
      // single-track clips at unity never built a graph; this one needs the node
      window.legacyPlayer?.setupAudioContext?.();
      if (!state.layerGainNode) return;
    }
    const g = gainAt(items, 0, t);
    if (last.get(0) === g) return;
    last.set(0, g);
    const ctx = state.audioContext as AudioContext;
    if (ctx.state === "suspended") void ctx.resume();
    (state.layerGainNode as GainNode).gain.setTargetAtTime(g, ctx.currentTime, 0.015);
  };

  raf = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(raf);
}
