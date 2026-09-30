import type { Layer, SoundLayer } from "../../../types/clips";
import { fileUrl } from "./meta";
import { playSeconds, soundAt, soundEnd } from "./model";
import { baseRate } from "./speed";
import { getLayers } from "./store";

/** plays sound layers along with the video. the clip's speed and speed layers change their tempo
 * like the clip audio, except speed layers set to leave sounds alone; main/layer-export.js plans them
 * the same. levels above 100% need a gain node, so each sound goes through its own */
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
      const { pos, rate } = soundAt(all, l, t, base);
      if (l.duration > 0 && pos >= l.duration) {
        if (!v.el.paused) v.el.pause();
        continue;
      }
      // the fades run on the clock you hear, like the export's afade after the retime
      const at = playSeconds(all, l.start, t, base);
      const len = playSeconds(all, l.start, soundEnd(all, l), base);
      const c = context();
      if (c.state === "suspended") void c.resume();
      v.gain.gain.setTargetAtTime(envelope(l, at, len), c.currentTime, 0.015);
      const r = Math.min(16, Math.max(0.0625, rate));
      if (Math.abs(v.el.playbackRate - r) > 1e-6) v.el.playbackRate = r;
      if (v.el.paused) {
        v.el.currentTime = pos;
        void v.el.play().catch(() => undefined);
      } else if (Math.abs(v.el.currentTime - pos) > DRIFT_S * Math.max(1, r)) {
        v.el.currentTime = pos;
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
