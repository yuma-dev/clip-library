import type { Layer, SoundLayer } from "../../../types/clips";
import { fileUrl } from "./meta";
import { playSeconds } from "./model";
import { baseRate } from "./speed";
import { getLayers } from "./store";

/** plays sound layers along with the video. they run on the real clock, not slowed by speed layers
 * or the clip's speed, the same as main/layer-export.js mixes them after the retime. levels above
 * 100% need a gain node, so each sound goes through its own */
interface Voice {
  el: HTMLAudioElement;
  gain: GainNode;
  file: string;
}

// resyncing costs a small skip, drift below this is left alone
const DRIFT_S = 0.12;

let ctx: AudioContext | null = null;
const context = () => (ctx ??= new AudioContext());

/** 0..level, the fade in and out over the part the sound actually plays */
function envelope(l: SoundLayer, at: number, len: number): number {
  const f = Math.min(l.fade, len / 2);
  if (f <= 0) return l.level;
  return l.level * Math.max(0, Math.min(1, at / f, (len - at) / f));
}

export function installSoundLayers(): () => void {
  const voices = new Map<string, Voice>();
  let raf = 0;

  const drop = (id: string) => {
    const v = voices.get(id);
    if (!v) return;
    v.el.pause();
    v.el.removeAttribute("src");
    v.gain.disconnect();
    voices.delete(id);
  };

  const voiceFor = (l: SoundLayer): Voice => {
    const had = voices.get(l.id);
    if (had && had.file === l.file) return had;
    if (had) drop(l.id);
    const el = new Audio(fileUrl(l.file as string));
    el.preload = "auto";
    const c = context();
    const gain = c.createGain();
    c.createMediaElementSource(el).connect(gain);
    gain.connect(c.destination);
    const v = { el, gain, file: l.file as string };
    voices.set(l.id, v);
    return v;
  };

  const loop = () => {
    raf = requestAnimationFrame(loop);
    const video = document.getElementById("video-player") as HTMLVideoElement | null;
    const { clip, items } = getLayers();
    const sounds = clip && video ? (items.filter((l) => l.kind === "sound" && l.file) as SoundLayer[]) : [];
    for (const id of voices.keys()) if (!sounds.some((s) => s.id === id)) drop(id);
    if (!video || !sounds.length) return;
    const t = video.currentTime;
    const playing = !video.paused && !video.ended && !video.seeking;
    const base = baseRate();
    const all = items as Layer[];
    for (const l of sounds) {
      const inside = t >= l.start && t < l.end;
      if (!inside || !playing) {
        const v = voices.get(l.id);
        if (v && !v.el.paused) v.el.pause();
        continue;
      }
      const v = voiceFor(l);
      const at = playSeconds(all, l.start, t, base);
      const len = playSeconds(all, l.start, l.end, base);
      if (l.duration > 0 && at >= l.duration) {
        if (!v.el.paused) v.el.pause();
        continue;
      }
      const c = context();
      if (c.state === "suspended") void c.resume();
      v.gain.gain.setTargetAtTime(envelope(l, at, Math.min(len, l.duration || len)), c.currentTime, 0.015);
      if (v.el.playbackRate !== 1) v.el.playbackRate = 1;
      if (v.el.paused) {
        v.el.currentTime = at;
        void v.el.play().catch(() => undefined);
      } else if (Math.abs(v.el.currentTime - at) > DRIFT_S) {
        v.el.currentTime = at;
      }
    }
  };

  raf = requestAnimationFrame(loop);
  return () => {
    cancelAnimationFrame(raf);
    for (const id of [...voices.keys()]) drop(id);
  };
}

/** length of a local audio file in seconds, 0 if it won't load */
export function probeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    const el = new Audio();
    el.preload = "metadata";
    el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => resolve(0);
    el.src = fileUrl(file);
  });
}
