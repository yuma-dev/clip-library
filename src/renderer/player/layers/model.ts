import type { Layer, LayerAnim, LayerKind, TextLayer, TextStyle, VolumeLayer } from "../../../types/clips";

// show/hide animation length in clip seconds; main/layer-export.js burns in the same
export const ANIM_S = 0.35;
// how long a new layer lasts when added at the playhead
export const DEFAULT_LEN: Record<LayerKind, number> = { volume: 3, text: 3, gif: 2.5, image: 3 };
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
export function animAt(l: Exclude<Layer, VolumeLayer>, t: number): AnimState {
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

export const isVisual = (l: Layer): l is Exclude<Layer, VolumeLayer> => l.kind !== "volume";

export function layerLabel(l: Layer, trackName: (ordinal: number) => string): string {
  if (l.kind === "volume") {
    const who = l.track === "all" ? "All" : trackName(l.track);
    return `${who} ${l.level === 0 ? "muted" : pct(l.level)}`;
  }
  if (l.kind === "text") return l.text.split("\n")[0] || "Text";
  if (l.kind === "gif") return l.gif.title || "GIF";
  return "Image";
}
