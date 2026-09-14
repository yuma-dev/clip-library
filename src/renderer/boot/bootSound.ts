// Sound for the boot reveal: three layers mixed live against the intro's
// real timing (src/renderer/boot/bootReveal.ts).
//
//  - woosh   as the logo flies through: trimmed so its swell peaks 0.42 s
//            after it starts; started as the reveal arms, so the peak lands
//            around the fastest part of the fly-through.
//  - chimes  and
//  - motes   together at +0.6 s, under the drifting motes, each with its
//            own natural tail.
//
// The clips are pre-trimmed and faded (assets/sfx, see benchmark/STARTUP.md)
// so nothing starts or stops abruptly. If the intro is cut short by input,
// every layer fades out in 60 ms so the sound ends where the picture does.
// Nothing plays on the plain reveal.
import wooshUrl from "../assets/sfx/woosh.ogg";
import chimesUrl from "../assets/sfx/chimes.ogg";
import motesUrl from "../assets/sfx/motes.ogg";

const MASTER = 0.35;
const GAIN = { woosh: 0.9, chimes: 1.0, motes: 0.5 };
const AT = { woosh: 0, chimes: 0.6, motes: 0.6 };
const CUT_FADE_S = 0.06;

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
export function preloadBootSound(muted: boolean): void {
  enabled = !muted;
  if (!enabled || loading) return;
  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
  } catch {
    enabled = false;
    return;
  }
  loading = Promise.all([load("woosh", wooshUrl), load("chimes", chimesUrl), load("motes", motesUrl)])
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
  gain.gain.value = GAIN[name] * MASTER;
  source.connect(gain).connect(ctx.destination);
  source.start(when);
  playing[name] = { source, gain, startAt: when };
  source.onended = () => {
    if (playing[name]?.source === source) delete playing[name];
    maybeClose();
  };
}

/** Called the moment the reveal arms (the window turns opaque a frame later). */
export function startBootSound(layers: Record<SoundLayer, boolean> = { woosh: true, chimes: true, motes: true }): void {
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

/** The intro was cut short by input: fade everything out quickly. */
export function cutBootSound(): void {
  if (!ctx || !started) return;
  const now = ctx.currentTime;
  for (const name of Object.keys(playing) as SoundLayer[]) {
    const layer = playing[name];
    if (!layer) continue;
    if (layer.startAt > now) {
      layer.source.stop(now);
      delete playing[name];
      continue;
    }
    layer.gain.gain.setValueAtTime(layer.gain.gain.value, now);
    layer.gain.gain.linearRampToValueAtTime(0, now + CUT_FADE_S);
    layer.source.stop(now + CUT_FADE_S + 0.01);
  }
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
