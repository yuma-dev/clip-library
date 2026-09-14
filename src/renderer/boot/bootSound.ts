// Sound for the boot reveal: three short layers mixed live against the
// intro's real timing (src/renderer/boot/bootReveal.ts).
//
//  - woosh   as the logo flies through: trimmed so its swell peaks 0.42 s
//            after it starts; started as the reveal arms, so the peak lands
//            around the fastest part of the fly-through.
//  - landing as the library body settles (its transient at +0.78 s).
//  - motes   under the drifting motes (+0.6 s), with its own long tail.
//
// The clips are pre-trimmed and faded (assets/sfx, see benchmark/STARTUP.md)
// so nothing starts or stops abruptly. If the intro is cut short by input,
// the woosh and motes fade out in 60 ms and the landing plays at once, so
// the sound ends where the picture does. Nothing plays on the plain reveal.
import wooshUrl from "../assets/sfx/woosh.ogg";
import landingUrl from "../assets/sfx/landing.ogg";
import motesUrl from "../assets/sfx/motes.ogg";

const MASTER = 0.35;
const GAIN = { woosh: 0.9, landing: 0.8, motes: 0.5 };
const AT = { woosh: 0, landing: 0.78, motes: 0.6 };
const CUT_FADE_S = 0.06;

type Name = keyof typeof GAIN;
type Layer = { source: AudioBufferSourceNode; gain: GainNode; startAt: number };

let ctx: AudioContext | null = null;
let buffers: Partial<Record<Name, AudioBuffer>> = {};
let loading: Promise<void> | null = null;
let playing: Partial<Record<Name, Layer>> = {};
let started = false;
let enabled = true;

async function load(name: Name, url: string): Promise<void> {
  if (!ctx) return;
  const res = await fetch(url);
  const data = await res.arrayBuffer();
  buffers[name] = await ctx.decodeAudioData(data);
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
  loading = Promise.all([load("woosh", wooshUrl), load("landing", landingUrl), load("motes", motesUrl)])
    .then(() => undefined)
    .catch(() => {
      enabled = false;
    });
}

function play(name: Name, when: number): void {
  if (!ctx) return;
  const buffer = buffers[name];
  if (!buffer) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = GAIN[name] * MASTER;
  source.connect(gain).connect(ctx.destination);
  source.start(when);
  playing[name] = { source, gain, startAt: when };
  source.onended = () => {
    if (playing[name]?.source === source) delete playing[name];
  };
}

/** Called the moment the reveal arms (the window turns opaque a frame later). */
export function startBootSound(): void {
  if (!enabled || started || !ctx) return;
  started = true;
  const go = () => {
    if (!ctx || !enabled) return;
    const resume = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
    void resume.then(() => {
      if (!ctx) return;
      const t0 = ctx.currentTime + 0.01;
      for (const name of Object.keys(AT) as Name[]) play(name, t0 + AT[name]);
    });
  };
  if (loading) void loading.then(go);
  else go();
}

/** The intro was cut short by input: fade the sweeps out, land now. */
export function cutBootSound(): void {
  if (!ctx || !started) return;
  const now = ctx.currentTime;
  for (const name of ["woosh", "motes"] as Name[]) {
    const layer = playing[name];
    if (!layer) continue;
    layer.gain.gain.setValueAtTime(layer.gain.gain.value, now);
    layer.gain.gain.linearRampToValueAtTime(0, now + CUT_FADE_S);
    layer.source.stop(now + CUT_FADE_S + 0.01);
  }
  const landing = playing.landing;
  if (landing && landing.startAt > now) {
    landing.source.stop(now);
    delete playing.landing;
    play("landing", now);
  }
}

/** Free the context once the intro is over. */
export function disposeBootSound(): void {
  const c = ctx;
  ctx = null;
  buffers = {};
  playing = {};
  if (c) void c.close().catch(() => undefined);
}
