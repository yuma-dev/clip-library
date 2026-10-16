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

const URLS = { woosh: wooshUrl, chimes: chimesUrl, motes: motesUrl, wind: windUrl };

export type SoundLayer = keyof typeof GAIN;
export type SoundLevels = Record<SoundLayer, number>;
const LAYERS = Object.keys(GAIN) as SoundLayer[];
type Layer = { source: AudioBufferSourceNode; startAt: number };

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
async function load(c: AudioContext, into: Partial<Record<SoundLayer, AudioBuffer>>, name: SoundLayer): Promise<void> {
  try {
    const res = await fetch(URLS[name]);
    const data = await res.arrayBuffer();
    into[name] = await c.decodeAudioData(data);
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
  const c = ctx;
  if (!c) return;
  loading = Promise.all(LAYERS.map((name) => load(c, buffers, name))).then(() => undefined);
}

// scale is the user's volume for this layer (0..1) on top of the tuned mix
function schedule(c: AudioContext, name: SoundLayer, buffer: AudioBuffer, when: number, scale: number): AudioBufferSourceNode {
  const source = c.createBufferSource();
  source.buffer = buffer;
  const gain = c.createGain();
  const level = GAIN[name] * MASTER * scale;
  gain.gain.value = level;
  source.connect(gain).connect(c.destination);
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
  return source;
}

function play(name: SoundLayer, when: number, scale: number): void {
  if (!ctx) return;
  const buffer = buffers[name];
  if (!buffer) return;
  const source = schedule(ctx, name, buffer, when, scale);
  playing[name] = { source, startAt: when };
  source.onended = () => {
    if (playing[name]?.source === source) delete playing[name];
    maybeClose();
  };
}

/** Called the moment the reveal arms (the window turns opaque a frame later). */
export function startBootSound(levels: SoundLevels = { woosh: 1, chimes: 1, motes: 1, wind: 1 }): void {
  if (!enabled || started || !ctx) return;
  started = true;
  const wanted = LAYERS.filter((name) => levels[name] > 0);
  if (!wanted.length) return;
  const go = () => {
    if (!ctx || !enabled) return;
    const resume = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
    void resume.then(() => {
      if (!ctx) return;
      const t0 = ctx.currentTime + 0.01;
      for (const name of wanted) play(name, t0 + AT[name], levels[name]);
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

// settings preview gets its own context: the intro's one is closed by then
let preview: { ctx: AudioContext; buffers: Partial<Record<SoundLayer, AudioBuffer>>; ready: Promise<void>; live: AudioBufferSourceNode[] } | null = null;
let previewGen = 0;

/** Plays the intro mix at the given levels, cutting off any preview still playing. */
export function previewBootSound(levels: SoundLevels): void {
  if (!preview) {
    let c: AudioContext;
    try {
      c = new AudioContext();
    } catch {
      return;
    }
    const into: Partial<Record<SoundLayer, AudioBuffer>> = {};
    preview = { ctx: c, buffers: into, ready: Promise.all(LAYERS.map((name) => load(c, into, name))).then(() => undefined), live: [] };
  }
  const p = preview;
  for (const source of p.live) {
    try {
      source.stop();
    } catch {
      /* already ended */
    }
  }
  p.live = [];
  const gen = ++previewGen;
  void p.ready
    .then(() => p.ctx.resume())
    .then(() => {
      // a newer preview started while this one was loading
      if (gen !== previewGen || preview !== p) return;
      const t0 = p.ctx.currentTime + 0.02;
      for (const name of LAYERS) {
        const buffer = p.buffers[name];
        if (buffer && levels[name] > 0) p.live.push(schedule(p.ctx, name, buffer, t0 + AT[name], levels[name]));
      }
    })
    .catch(() => undefined);
}

export function disposeBootSoundPreview(): void {
  const p = preview;
  preview = null;
  if (p) void p.ctx.close().catch(() => undefined);
}
