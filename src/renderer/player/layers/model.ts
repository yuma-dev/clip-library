import type { Layer, LayerAnim, LayerKind, SpeedLayer, TextLayer, TextStyle, VisualLayer, VolumeLayer, ZoomKey, ZoomLayer } from "../../../types/clips";

// show/hide animation length in clip seconds; main/layer-export.js burns in the same
export const ANIM_S = 0.35;
// how long a new layer lasts when added at the playhead
export const DEFAULT_LEN: Record<LayerKind, number> = { volume: 3, text: 3, gif: 2.5, image: 3, zoom: 3, speed: 2, blur: 4, sound: 2 };
export const MIN_LEN = 0.2;

export const TEXT_STYLES: Array<{ id: TextStyle; name: string }> = [
  { id: "clean", name: "Clean" },
  { id: "outline", name: "Outline" },
  { id: "box", name: "Box" },
  { id: "loud", name: "Loud" },
];
export const TEXT_COLORS = ["#ffffff", "#fde047", "#c774e0", "#6ee7f0", "#f87171"];
// font size in % of the frame width
export const TEXT_SIZE_MIN = 1;
export const TEXT_SIZE_MAX = 20;
// eight each so they fill two rows of four; "slide" is the id of Rise from before it had company
const ANIMS: Record<LayerAnim, string> = {
  none: "None",
  fade: "Fade",
  pop: "Pop",
  zoom: "Zoom",
  slide: "Rise",
  drop: "Drop",
  side: "Slide",
  wipe: "Wipe",
  type: "Type",
};
const pick = (ids: LayerAnim[]): Array<[LayerAnim, string]> => ids.map((id) => [id, ANIMS[id]]);
export const SHOW_TEXT = pick(["none", "fade", "pop", "zoom", "slide", "drop", "wipe", "type"]);
export const SHOW_MEDIA = pick(["none", "fade", "pop", "zoom", "slide", "drop", "side", "wipe"]);
export const HIDE_ANIMS = pick(["none", "fade", "pop", "zoom", "slide", "drop", "side", "wipe"]);

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const pct = (level: number) => `${Math.round(level * 100)}%`;
export const newId = () => Math.random().toString(36).slice(2, 10);

export function fmtTime(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}
/** accepts 1:02.5, 62.5 or 62 */
export function parseTime(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = t.includes(":") ? t.split(":").reduce((acc, p) => acc * 60 + Number(p), 0) : Number(t);
  return Number.isFinite(n) ? n : null;
}

/** envelope of one volume layer at t, 1 outside it; linear ramp of fade seconds at both ends */
function layerGain(l: VolumeLayer, t: number): number {
  if (t < l.start || t > l.end) return 1;
  const f = Math.min(l.fade, (l.end - l.start) / 2);
  const k = f > 0 ? Math.min(1, (t - l.start) / f, (l.end - t) / f) : 1;
  return 1 + (l.level - 1) * k;
}

/** layer gain for a track at t; single-track clips pass ordinal 0 */
export function gainAt(layers: Layer[], ordinal: number, t: number): number {
  let g = 1;
  for (const l of layers) {
    if (l.kind !== "volume") continue;
    if (l.track !== "all" && l.track !== ordinal) continue;
    g *= layerGain(l, t);
  }
  return g;
}

export interface AnimState {
  opacity: number;
  scale: number;
  /** % of the frame width, rightwards and downwards */
  dx: number;
  dy: number;
  /** 0..1 of the width cut off at each side, wipe and type */
  clipL: number;
  clipR: number;
}

const backOut = (p: number) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);

// how far the moving ones travel, % of the frame width
const RISE = 3;
const SIDE = 4;

/** p runs 0 to 1 into the layer for show, out of it for hide. moves keep going the same way:
 * rise comes up from below and leaves upwards, drop falls in and falls out, slide goes left to right */
function apply(kind: LayerAnim, p: number, s: AnimState, out: boolean) {
  const away = Math.pow(1 - p, 3);
  const dir = out ? 1 : -1;
  if (kind === "fade") s.opacity *= p;
  else if (kind === "pop") {
    s.scale *= 0.4 + 0.6 * backOut(p);
    s.opacity *= Math.min(1, p / 0.4);
  } else if (kind === "zoom") {
    s.scale *= 1 + 0.6 * away;
    s.opacity *= p;
  } else if (kind === "slide") {
    s.dy -= dir * away * RISE;
    s.opacity *= p;
  } else if (kind === "drop") {
    s.dy += dir * away * RISE;
    s.opacity *= p;
  } else if (kind === "side") {
    s.dx += dir * away * SIDE;
    s.opacity *= p;
  } else if (kind === "wipe") {
    if (out) s.clipL = Math.max(s.clipL, 1 - p);
    else s.clipR = Math.max(s.clipR, 1 - p);
  }
}

/** what a visual layer looks like at t, mirrors buildOverlayGraph in main/layer-export.js */
export function animAt(l: VisualLayer, t: number): AnimState {
  const s: AnimState = { opacity: 1, scale: 1, dx: 0, dy: 0, clipL: 0, clipR: 0 };
  const dIn = Math.max(0.01, Math.min(l.din ?? ANIM_S, (l.end - l.start) / 2));
  const dOut = Math.max(0.01, Math.min(l.dout ?? ANIM_S, (l.end - l.start) / 2));
  const pin = clamp((t - l.start) / dIn, 0, 1);
  const pout = clamp((l.end - t) / dOut, 0, 1);
  if (l.ain === "type") {
    // one step per character; media has no characters and just shows
    if (l.kind === "text") {
      const n = Math.max(1, Array.from(l.text).length);
      const p = clamp((t - l.start) / Math.max(0.5, n * 0.05), 0, 1);
      s.clipR = 1 - Math.floor(p * n) / n;
    }
  } else if (l.ain !== "none") apply(l.ain, pin, s, false);
  if (l.aout !== "none" && l.aout !== "type") apply(l.aout, pout, s, true);
  return s;
}

/** what the export png of a text layer depends on */
export function rasterKey(l: TextLayer, refW: number): string {
  return JSON.stringify([l.text, l.style, l.color, l.size, l.outline, l.shadow, l.boxOpacity, l.spacing, refW]);
}

export const isVisual = (l: Layer): l is VisualLayer => l.kind === "text" || l.kind === "gif" || l.kind === "image";

export const ZOOM_MIN = 1.1;
export const ZOOM_MAX = 4;
export const SPEEDS = [0.25, 0.5, 0.75, 1.5, 2, 4];

const smooth = (p: number) => p * p * (3 - 2 * p);

/** 0..1, how far in a zoom is at t; eases in over its first ease seconds and out over its last */
function zoomWeight(l: ZoomLayer, t: number): number {
  if (t < l.start || t > l.end) return 0;
  const d = Math.min(l.ease, (l.end - l.start) / 2);
  if (d <= 0) return 1;
  return smooth(clamp(Math.min((t - l.start) / d, (l.end - t) / d), 0, 1));
}

// main/layers.js caps it the same; the export turns every key into a term of an ffmpeg expression
export const MAX_ZOOM_KEYS = 24;
// a playhead this close to a key edits that key instead of adding one next to it
export const KEY_NEAR = 0.05;

export type ZoomView = Omit<ZoomKey, "t">;

/** where a zoom looks at t before the move in and out: its one spot, or its keys with a smoothstep
 * between each pair. written as the first key plus one eased step per pair, the export's form */
export function zoomView(l: ZoomLayer, t: number): ZoomView {
  const keys = l.keys;
  if (!keys?.length) return { x: l.x, y: l.y, scale: l.scale };
  const rel = t - l.start;
  const v = { x: keys[0].x, y: keys[0].y, scale: keys[0].scale };
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    const p = smooth(clamp((rel - a.t) / Math.max(1e-3, b.t - a.t), 0, 1));
    v.x += (b.x - a.x) * p;
    v.y += (b.y - a.y) * p;
    v.scale += (b.scale - a.scale) * p;
  }
  return v;
}

/** index of the key at t, within KEY_NEAR, or -1 */
export function keyAt(l: ZoomLayer, t: number): number {
  const rel = t - l.start;
  return l.keys?.findIndex((k) => Math.abs(k.t - rel) <= KEY_NEAR) ?? -1;
}

/** the patch that sets the view at t. without keys it moves the one spot; with keys it edits the
 * key at t or adds one there, so after the first key every change at a new time is a new key */
export function viewPatch(l: ZoomLayer, t: number, v: Partial<ZoomView>): Partial<ZoomLayer> {
  if (!l.keys?.length) return v;
  const rel = clamp(t - l.start, 0, l.end - l.start);
  const at = keyAt(l, l.start + rel);
  if (at >= 0) return { keys: l.keys.map((k, i) => (i === at ? { ...k, ...v } : k)) };
  if (l.keys.length >= MAX_ZOOM_KEYS) return {};
  return { keys: [...l.keys, { t: rel, ...zoomView(l, l.start + rel), ...v }].sort((a, b) => a.t - b.t) };
}

/** adds a key at t holding the view there, or drops the key at t. the last key going leaves its view
 * as the zoom's one spot */
export function toggleKey(l: ZoomLayer, t: number): Partial<ZoomLayer> {
  const keys = l.keys ?? [];
  const at = keyAt(l, t);
  if (at < 0) {
    if (keys.length >= MAX_ZOOM_KEYS) return {};
    const rel = clamp(t - l.start, 0, l.end - l.start);
    return { keys: [...keys, { t: rel, ...zoomView(l, l.start + rel) }].sort((a, b) => a.t - b.t) };
  }
  if (keys.length > 1) return { keys: keys.filter((_, i) => i !== at) };
  const { x, y, scale } = keys[at];
  return { keys: undefined, x, y, scale };
}

/** the point that stays put while zooming in, so the view lands centred on x/y at full zoom. x/y is
 * kept where the zoomed view still fits inside the frame */
function zoomAnchor(view: ZoomView): { px: number; py: number } {
  const z = clamp(view.scale, ZOOM_MIN, ZOOM_MAX);
  const half = 0.5 / z;
  const cx = clamp(view.x / 100, half, 1 - half);
  const cy = clamp(view.y / 100, half, 1 - half);
  return { px: (cx * z - 0.5) / (z - 1), py: (cy * z - 0.5) / (z - 1) };
}

export interface ZoomState {
  z: number;
  /** left and top of the view in the zoomed frame, in frame widths and heights */
  ox: number;
  oy: number;
}

/** the video's zoom at t, mirrors zoomFilter in main/layer-export.js: the frame is scaled by z and
 * cut back to its size at ox/oy */
export function zoomAt(layers: Layer[], t: number): ZoomState {
  let z = 1;
  let ox = 0;
  let oy = 0;
  for (const l of layers) {
    if (l.kind !== "zoom") continue;
    const w = zoomWeight(l, t);
    if (!w) continue;
    const view = zoomView(l, t);
    const k = (clamp(view.scale, ZOOM_MIN, ZOOM_MAX) - 1) * w;
    const { px, py } = zoomAnchor(view);
    z += k;
    ox += px * k;
    oy += py * k;
  }
  return { z, ox: clamp(ox, 0, z - 1), oy: clamp(oy, 0, z - 1) };
}

/** speed layers multiply where they overlap; 1 outside all of them */
export function rateAt(layers: Layer[], t: number): number {
  let r = 1;
  for (const l of layers) if (l.kind === "speed" && t >= l.start && t < l.end) r *= (l as SpeedLayer).rate;
  return r;
}

/** real seconds of playback between source times a and b at base speed; sound layers run on this
 * clock since they are not slowed with the video */
export function playSeconds(layers: Layer[], a: number, b: number, base = 1): number {
  if (b <= a) return 0;
  const cuts = new Set([a, b]);
  for (const l of layers) {
    if (l.kind !== "speed") continue;
    if (l.start > a && l.start < b) cuts.add(l.start);
    if (l.end > a && l.end < b) cuts.add(l.end);
  }
  const xs = [...cuts].sort((p, q) => p - q);
  let out = 0;
  for (let i = 0; i < xs.length - 1; i++) out += (xs[i + 1] - xs[i]) / (base * rateAt(layers, (xs[i] + xs[i + 1]) / 2));
  return out;
}

export function layerLabel(l: Layer, trackName: (ordinal: number) => string): string {
  if (l.kind === "volume") {
    const who = l.track === "all" ? "All" : trackName(l.track);
    return `${who} ${l.level === 0 ? "muted" : pct(l.level)}`;
  }
  if (l.kind === "text") return l.text.split("\n")[0] || "Text";
  if (l.kind === "gif") return l.gif.title || "GIF";
  if (l.kind === "zoom") {
    if (!l.keys?.length) return `Zoom ${l.scale.toFixed(1)}x`;
    const zs = l.keys.map((k) => k.scale);
    const lo = Math.min(...zs).toFixed(1);
    const hi = Math.max(...zs).toFixed(1);
    return lo === hi ? `Zoom ${lo}x` : `Zoom ${lo}x to ${hi}x`;
  }
  if (l.kind === "speed") return `${l.rate < 1 ? "Slow" : "Fast"} ${l.rate}x`;
  if (l.kind === "blur") return l.mode === "pixelate" ? "Pixelate" : "Blur";
  if (l.kind === "sound") return l.name || "Sound";
  return "Image";
}
