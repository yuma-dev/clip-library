import type { Layer, LayerAnim, TextLayer, TextStyle } from "../../../types/clips";
import type { TrackView } from "../Waveform";
import type { TextDetails } from "./controls";
import { MIN_LEN, newId } from "./model";

/** how generated subtitle lines look. one set for all of them, except color: every track has
 * its own, kept by track name so "Microphone FX" stays the same color from clip to clip */
export interface SubStyle extends TextDetails {
  style: TextStyle;
  size: number;
  ain: LayerAnim;
  aout: LayerAnim;
  /** track name to color; "clip" is the one voice of a single-track clip */
  colors: Record<string, string>;
  /** 0..100, where the bottom line sits */
  y: number;
}

export const SUB_DEFAULT: SubStyle = { style: "box", size: 3.2, ain: "fade", aout: "fade", colors: {}, y: 90 };
const KEY = "cliplib.subtitleStyle";
const DETAILS = ["outline", "shadow", "boxOpacity", "spacing", "opacity", "din", "dout"] as const;

/** the last style picked, per viewer; storage can be missing in some contexts */
export function loadSubStyle(): SubStyle {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (raw && typeof raw === "object") return { ...SUB_DEFAULT, ...raw, colors: { ...(raw.colors ?? {}) } };
  } catch {
    /* fall back to defaults */
  }
  return SUB_DEFAULT;
}

export function saveSubStyle(s: SubStyle) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* not kept, still applied */
  }
}

export const isSub = (l: Layer): l is TextLayer => l.kind === "text" && l.source === "subtitles";

/** a track color pulled towards white, dark mixer colors are hard to read on the box */
export function readable(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const v = parseInt(m[1], 16);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.35);
  return `#${((mix((v >> 16) & 255) << 16) | (mix((v >> 8) & 255) << 8) | mix(v & 255)).toString(16).padStart(6, "0")}`;
}

/** the key a line's color is kept under: its track's name, or "clip" without tracks */
export function colorKey(speaker: number | undefined, tracks: TrackView[] | null): string {
  if (speaker === undefined) return "clip";
  return tracks?.find((t) => t.ordinal === speaker)?.name || `Track ${speaker + 1}`;
}

/** a track's subtitle color: the one picked for it, else its mixer color made readable */
export function colorFor(style: SubStyle, speaker: number | undefined, tracks: TrackView[] | null): string {
  const picked = style.colors[colorKey(speaker, tracks)];
  if (picked) return picked;
  const t = speaker === undefined ? null : tracks?.find((x) => x.ordinal === speaker);
  return t ? readable(t.color) : "#ffffff";
}

const detailsOf = (style: SubStyle): Partial<TextLayer> => {
  const out: Partial<TextLayer> = {};
  for (const k of DETAILS) out[k] = style[k];
  return out;
};

/** people talking over each other: a line that overlaps one already placed in time goes above it.
 * heights in % of the frame height, the text size is % of its width */
function stack<T extends { start: number; end: number; text: string }>(lines: T[], size: number, style: TextStyle, bottomY: number, aspect: number): Array<T & { y: number }> {
  const row = size * aspect * 1.05;
  const pad = style === "box" ? size * aspect * 0.44 : size * aspect * 0.2;
  const bottomEdge = Math.min(99, bottomY + row / 2);
  const placed: Array<{ start: number; end: number; top: number; bottom: number }> = [];
  return [...lines]
    .sort((a, b) => a.start - b.start)
    .map((l) => {
      const h = l.text.split("\n").length * row + pad;
      let bottom = bottomEdge;
      for (;;) {
        const hit = placed.find((p) => p.start < l.end && l.start < p.end && p.top < bottom && bottom - h < p.bottom);
        if (!hit) break;
        bottom = hit.top - 0.8;
      }
      placed.push({ start: l.start, end: l.end, top: bottom - h, bottom });
      return { ...l, y: bottom - h / 2 };
    });
}

const aspectNow = () => {
  const v = document.getElementById("video-player") as HTMLVideoElement | null;
  return v?.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
};

/** fresh subtitle layers from transcribed lines */
export function buildSubtitles(
  lines: Array<{ start: number; end: number; text: string; speaker?: number }>,
  style: SubStyle,
  tracks: TrackView[] | null,
): TextLayer[] {
  return stack(lines, style.size, style.style, style.y, aspectNow()).map((l) => ({
    id: newId(),
    kind: "text",
    start: l.start,
    end: Math.max(l.end, l.start + MIN_LEN),
    x: 50,
    y: l.y,
    ain: style.ain,
    aout: style.aout,
    text: l.text,
    style: style.style,
    color: colorFor(style, l.speaker, tracks),
    size: style.size,
    ...detailsOf(style),
    raster: null,
    source: "subtitles",
    ...(l.speaker !== undefined ? { speaker: l.speaker } : {}),
  }));
}

/** the style the existing lines share, for the panel to show; null when there are none */
export function styleOf(items: Layer[], tracks: TrackView[] | null): SubStyle | null {
  const subs = items.filter(isSub);
  if (!subs.length) return null;
  const first = subs[0];
  const colors: Record<string, string> = {};
  for (const l of subs) colors[colorKey(l.speaker, tracks)] ??= l.color;
  // back from line centres to the anchor stack() starts from, or every restyle would creep
  const aspect = aspectNow();
  const row = first.size * aspect * 1.05;
  const pad = first.style === "box" ? first.size * aspect * 0.44 : first.size * aspect * 0.2;
  const edge = subs.reduce((m, l) => Math.max(m, l.y + (l.text.split("\n").length * row + pad) / 2), 0);
  const y = Math.round((edge - row / 2) * 10) / 10;
  const details: Partial<SubStyle> = {};
  for (const k of DETAILS) if (first[k] !== undefined) details[k] = first[k];
  return { style: first.style, size: first.size, ain: first.ain, aout: first.aout, colors, y, ...details };
}

/** a style change on every existing line; size, style and height move the stacking too */
export function restyle(items: Layer[], style: SubStyle, tracks: TrackView[] | null): Map<string, Partial<TextLayer>> {
  const subs = items.filter(isSub);
  const placed = new Map(stack(subs, style.size, style.style, style.y, aspectNow()).map((l) => [l.id, l.y]));
  const out = new Map<string, Partial<TextLayer>>();
  for (const l of subs) {
    out.set(l.id, {
      style: style.style,
      size: style.size,
      ain: style.ain,
      aout: style.aout,
      color: colorFor(style, l.speaker, tracks),
      ...detailsOf(style),
      y: placed.get(l.id) ?? l.y,
    });
  }
  return out;
}
