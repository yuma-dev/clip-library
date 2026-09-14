// Sound for the boot reveal: three layers mixed live against the intro's
// real timing (src/renderer/boot/bootReveal.ts).
//
//  - woosh   as the logo flies through: trimmed so its swell peaks 0.42 s
//            after it starts; started as the reveal arms, so the peak lands
//            around the fastest part of the fly-through.
//  - chimes, motes and wind together at +0.6 s, under the drifting motes,
//            each with its own tail; the wind fades out last.
//
// The clips are pre-trimmed and faded (assets/sfx, see benchmark/STARTUP.md)
// so nothing starts or stops abruptly. Input never cuts the sound: a click
// or key ends the visuals early, the sound plays out. Nothing plays on the
// plain reveal.
import wooshUrl from "../assets/sfx/woosh.ogg";
import wooshFlightUrl from "../assets/sfx/woosh-flight.ogg";
import wooshCreatureUrl from "../assets/sfx/woosh-creature.ogg";
import wooshPointerUrl from "../assets/sfx/woosh-pointer.ogg";
import wooshGustUrl from "../assets/sfx/woosh-gust.ogg";
import chimesUrl from "../assets/sfx/chimes.ogg";
import motesUrl from "../assets/sfx/motes.ogg";
import windUrl from "../assets/sfx/wind.ogg";
import type { WooshVariant } from "./bootPrefs";

// Each variant is trimmed so its swell peaks about 0.4 s after it starts.
const WOOSH_URLS: Record<WooshVariant, string> = {
  classic: wooshUrl,
  flight: wooshFlightUrl,
  creature: wooshCreatureUrl,
  pointer: wooshPointerUrl,
  gust: wooshGustUrl,
};

const MASTER = 0.35;
// wind: grass and birds under the whole tail; its own fade ends about
// 0.6 s after the chimes (the clip runs 4.4 s from +0.6 s).
const GAIN = { woosh: 0.9, chimes: 1.0, motes: 0.5, wind: 1.0 };
const AT = { woosh: 0, chimes: 0.6, motes: 0.6, wind: 0.6 };

export type SoundLayer = keyof typeof GAIN;
type Layer = { source: AudioBufferSourceNode; gain: GainNode; startAt: number };

let ctx: AudioContext | null = null;
let buffers: Partial<Record<SoundLayer, AudioBuffer>> = {};
let loading: Promise<void> | null = null;
let playing: Partial<Record<SoundLayer, Layer>> = {};
let started = false;
let enabled = true;
// The visuals can finish before the longest clip; the context closes only
// once every layer has ended (or never started).
let disposeWanted = false;

async function load(name: SoundLayer, url: string): Promise<void> {
  if (!ctx) return;
  const res = await fetch(url);
  const data = await res.arrayBuffer();
  buffers[name] = await ctx.decodeAudioData(data);
}

/** Decode the layers ahead of the reveal (a few ms of work, off the intro). */
export function preloadBootSound(muted: boolean, woosh: WooshVariant = "classic"): void {
  enabled = !muted;
  if (!enabled || loading) return;
  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
  } catch {
    enabled = false;
    return;
  }
  loading = Promise.all([load("woosh", WOOSH_URLS[woosh] ?? wooshUrl), load("chimes", chimesUrl), load("motes", motesUrl), load("wind", windUrl)])
    .then(() => undefined)
    .catch(() => {
      enabled = false;
    });
}

function play(name: SoundLayer, when: number): void {
  if (!ctx) return;
  const buffer = buffers[name];
  if (!buffer) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  const level = GAIN[name] * MASTER * (name === "wind" ? windShape.volume : 1);
  gain.gain.value = level;
  source.connect(gain).connect(ctx.destination);
  // The wind fades out at a user-set point over a user-set time (settings);
  // the clip itself carries no fade-out.
  if (name === "wind") {
    const fadeStart = when + Math.min(windShape.fadeAt, buffer.duration);
    const fadeEnd = Math.min(fadeStart + windShape.fadeFor, when + buffer.duration);
    gain.gain.setValueAtTime(level, fadeStart);
    gain.gain.linearRampToValueAtTime(0, fadeEnd);
    source.stop(fadeEnd + 0.02);
  }
  // The chimes carry the tail of the intro: ease them out over their last
  // 40 percent so sound and motes end together, slowly.
  if (name === "chimes") {
    const end = when + buffer.duration;
    gain.gain.setValueAtTime(level, end - buffer.duration * 0.4);
    gain.gain.linearRampToValueAtTime(0, end);
  }
  source.start(when);
  playing[name] = { source, gain, startAt: when };
  source.onended = () => {
    if (playing[name]?.source === source) delete playing[name];
    maybeClose();
  };
}

/** Called the moment the reveal arms (the window turns opaque a frame later). */
export interface WindShape {
  volume: number;
  fadeAt: number;
  fadeFor: number;
}
let windShape: WindShape = { volume: 0.25, fadeAt: 3.2, fadeFor: 1.2 };

export function startBootSound(layers: Record<SoundLayer, boolean> = { woosh: true, chimes: true, motes: true, wind: true }, wind?: WindShape): void {
  if (!enabled || started || !ctx) return;
  started = true;
  if (wind) windShape = wind;
  const wanted = (Object.keys(AT) as SoundLayer[]).filter((name) => layers[name]);
  if (!wanted.length) return;
  const go = () => {
    if (!ctx || !enabled) return;
    const resume = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
    void resume.then(() => {
      if (!ctx) return;
      const t0 = ctx.currentTime + 0.01;
      for (const name of wanted) play(name, t0 + AT[name]);
    });
  };
  if (loading) void loading.then(go);
  else go();
}

/** Free the context once the intro is over and every layer has ended. */
export function disposeBootSound(): void {
  disposeWanted = true;
  maybeClose();
}

function maybeClose(): void {
  if (!disposeWanted || !ctx) return;
  if (Object.keys(playing).length > 0) return;
  // Layers scheduled but not yet started would still fire; give a pending
  // start (loading) a moment before giving up on it.
  if (started && loading) {
    void loading.then(() => {
      // The scheduled plays land a couple of microtasks after this; look again
      // once they have had the chance.
      window.setTimeout(() => {
        if (Object.keys(playing).length === 0) closeNow();
      }, 50);
    });
    return;
  }
  closeNow();
}

function closeNow(): void {
  const c = ctx;
  ctx = null;
  buffers = {};
  playing = {};
  if (c) void c.close().catch(() => undefined);
}
