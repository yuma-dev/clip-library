// Boot sound: three sfx layers mixed against the intro's timing (bootReveal.ts).
// woosh starts at 0 (peaks +0.4s, the fastest part of the fly-through); chimes/motes/
// wind start together at +0.6s, each with its own tail, wind fading out last. Clips
// are pre-trimmed/faded (assets/sfx); input never cuts the sound, only the visuals.
import wooshUrl from "../assets/sfx/woosh-gust.ogg";
import chimesUrl from "../assets/sfx/chimes.ogg";
import motesUrl from "../assets/sfx/motes.ogg";
import windUrl from "../assets/sfx/wind.ogg";
const MASTER = 0.35;
// wind: grass and birds far under the whole tail, fading from the moment it
// starts over 4.3 s so it is gone just after the chimes.
const GAIN = { woosh: 0.9, chimes: 1.0, motes: 0.5, wind: 0.07 };
const WIND_FADE_AT = 0;
const WIND_FADE_FOR = 4.3;
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

// One layer failing to fetch or decode must not silence the rest: each
// load settles on its own and only its layer is missing.
async function load(name: SoundLayer, url: string): Promise<void> {
  if (!ctx) return;
  try {
    const res = await fetch(url);
    const data = await res.arrayBuffer();
    buffers[name] = await ctx.decodeAudioData(data);
  } catch (error) {
    console.warn(`[boot sound] ${name} did not load: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Decode the layers ahead of the reveal (a few ms of work, off the intro). */
export function preloadBootSound(muted: boolean): void {
  enabled = !muted;
  if (!enabled || loading) return;
  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
  } catch {
    enabled = false;
    return;
  }
  loading = Promise.all([load("woosh", wooshUrl), load("chimes", chimesUrl), load("motes", motesUrl), load("wind", windUrl)]).then(() => undefined);
}

function play(name: SoundLayer, when: number): void {
  if (!ctx) return;
  const buffer = buffers[name];
  if (!buffer) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  const level = GAIN[name] * MASTER;
  gain.gain.value = level;
  source.connect(gain).connect(ctx.destination);
  // The wind fades out at play time; the clip itself carries no fade-out.
  let stopAt = 0;
  if (name === "wind") {
    const fadeStart = when + Math.min(WIND_FADE_AT, buffer.duration);
    const fadeEnd = Math.min(fadeStart + WIND_FADE_FOR, when + buffer.duration);
    gain.gain.setValueAtTime(level, fadeStart);
    gain.gain.linearRampToValueAtTime(0, fadeEnd);
    stopAt = fadeEnd + 0.02;
  }
  // chimes ease out over their last 40% so sound and motes end together, slowly
  if (name === "chimes") {
    const end = when + buffer.duration;
    gain.gain.setValueAtTime(level, end - buffer.duration * 0.4);
    gain.gain.linearRampToValueAtTime(0, end);
  }
  source.start(when);
  // stop() is only legal after start(); calling it first threw and silenced the wind
  if (stopAt) source.stop(stopAt);
  playing[name] = { source, gain, startAt: when };
  source.onended = () => {
    if (playing[name]?.source === source) delete playing[name];
    maybeClose();
  };
}

/** Called the moment the reveal arms (the window turns opaque a frame later). */
export function startBootSound(layers: Record<SoundLayer, boolean> = { woosh: true, chimes: true, motes: true, wind: true }): void {
  if (!enabled || started || !ctx) return;
  started = true;
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
  // a pending scheduled start (loading) still needs to fire; give it a moment
  if (started && loading) {
    void loading.then(() => {
      // scheduled plays land a few microtasks later; recheck after they land
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
