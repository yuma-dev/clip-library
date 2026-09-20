import { memo, useEffect, useMemo } from "react";
import type { ClipWaveform } from "../../types/clips";

/** what the mixer knows about a track that the timeline needs to draw it */
export interface TrackView {
  ordinal: number;
  name: string;
  color: string;
  hidden: boolean;
  muted: boolean;
  /** mixer level 0..2; the band scales with it */
  volume?: number;
}

// bins across the full clip; the trim only reveals a part of the same path so trimming never
// stretches it
export const BINS = 240;
// symmetric band half-heights in a 26 unit tall box, first visible track widest
const AMPS = [12, 9, 7, 6, 5, 4.5, 4, 3.5];
const MAX_HALF = 12.5;
// silence keeps a thread of this half-height, tuned value from the lab's data-props
const FLOOR = 0.6;
// box moving average radius in bins
const SMOOTH = 1;
// bands round off over this fraction of the bar at each trim edge
const EDGE = 0.005;
// dBFS mapped onto 0..1.1: -54 is the floor, -6 reaches 1
const DB_FLOOR = -54;
const DB_SPAN = 48;
const GLOW_STD = 0.6;

const smoothstep = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/** max of the per-window peaks that fall into each bin, as 0..1.1 levels */
function binLevels(peak: number[]): number[] {
  const out = new Array<number>(BINS).fill(0);
  const n = peak.length;
  if (n === 0) return out;
  for (let i = 0; i < BINS; i++) {
    const from = Math.floor((i * n) / BINS);
    const to = Math.max(from + 1, Math.floor(((i + 1) * n) / BINS));
    let max = -Infinity;
    for (let j = from; j < to && j < n; j++) if (peak[j] > max) max = peak[j];
    out[i] = Math.max(0, (max - DB_FLOOR) / DB_SPAN);
  }
  return out.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let k = -SMOOTH; k <= SMOOTH; k++) {
      const j = i + k;
      if (j >= 0 && j < BINS) {
        s += out[j];
        c++;
      }
    }
    return s / c;
  });
}

function bandPath(levels: number[], amp: number, ts: number, te: number): string {
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i < BINS; i++) {
    const x = i / (BINS - 1);
    const taper = smoothstep((x - ts) / EDGE) * smoothstep((te - x) / EDGE);
    const h = Math.max(FLOOR, Math.min(MAX_HALF, levels[i] * amp)) * taper;
    const px = (x * 100).toFixed(2);
    top.push(`${i ? "L" : "M"}${px} ${(13 - h).toFixed(2)}`);
    bottom.push(`L${px} ${(13 + h).toFixed(2)}`);
  }
  return top.join("") + bottom.reverse().join("") + "Z";
}

/** the ahead-of-playhead tint: same hue, most of the saturation gone, lifted to a mid grey */
function desaturate(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#9aa3b4";
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  const grey = 0.3 * r + 0.59 * g + 0.11 * b;
  const mix = (c: number) => Math.round(Math.min(255, (c * 0.3 + grey * 0.7) * 0.55 + 100));
  return `#${((mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).padStart(6, "0")}`;
}

/** half-height of a band per bin, in svg units, before the trim taper */
function bandHalves(levels: number[], amp: number): number[] {
  return levels.map((lv) => Math.max(FLOOR, Math.min(MAX_HALF, lv * amp)));
}

/** the tallest band under each bin, in svg units, what the playhead sizes itself to */
export function envelopeOf(bands: Array<{ halves: number[] }>): number[] {
  const out = new Array<number>(BINS).fill(0);
  for (const b of bands) for (let i = 0; i < BINS; i++) if (b.halves[i] > out[i]) out[i] = b.halves[i];
  return out;
}

const SILENT = new Array<number>(BINS).fill(0);

interface WaveformProps {
  waveform: ClipWaveform | null;
  /** mixer view for multi-track clips; null until the mixer is up, then only visible tracks draw */
  tracks: TrackView[] | null;
  /** fractions of the full duration */
  trimStart: number;
  trimEnd: number;
  /** tallest band per bin, or null when nothing draws */
  onEnvelope?: (env: number[] | null) => void;
  /** master level 0..2 for single-track clips; multi-track bands read their own track's level */
  gain?: number;
}

/** per-track level bands behind the timeline; ahead of the playhead grey, behind it coloured with a
 * bloom. clip-path on the two wrappers is driven by css vars the timeline's rAF loop sets. */
function Waveform({ waveform, tracks, trimStart, trimEnd, onEnvelope, gain = 1 }: WaveformProps) {
  const bands = useMemo(() => {
    if (!waveform || waveform.tracks.length === 0) return [];
    if (waveform.tracks.length === 1) {
      const levels = binLevels(waveform.tracks[0].peak).map((lv) => lv * gain);
      return [{ key: "mono", halves: bandHalves(levels, 12), d: bandPath(levels, 12, trimStart, trimEnd), ahead: "#ffffff40", played: "#fff", opacity: 1 }];
    }
    if (!tracks) return [];
    const visible = tracks.filter((t) => !t.hidden);
    return visible.map((t, i) => {
      const data = waveform.tracks.find((w) => w.ordinal === t.ordinal);
      if (!data) return null;
      // muted: a flat white thread at the silence floor, its level no longer matters
      const level = Number.isFinite(t.volume) ? (t.volume as number) : 1;
      const levels = t.muted ? SILENT : binLevels(data.peak).map((lv) => lv * level);
      const amp = AMPS[Math.min(i, AMPS.length - 1)];
      return {
        key: String(t.ordinal),
        halves: bandHalves(levels, amp),
        d: bandPath(levels, amp, trimStart, trimEnd),
        ahead: t.muted ? "#ffffff66" : desaturate(t.color),
        played: t.muted ? "#fff" : t.color,
        opacity: 0.8,
      };
    }).filter((b): b is NonNullable<typeof b> => b !== null);
  }, [waveform, tracks, trimStart, trimEnd, gain]);

  useEffect(() => {
    onEnvelope?.(bands.length ? envelopeOf(bands) : null);
  }, [bands, onEnvelope]);

  if (bands.length === 0) return null;
  const multi = bands[0].key !== "mono";
  return (
    <>
      <div className="tl-wave tl-wave-ahead">
        <svg viewBox="0 0 100 26" preserveAspectRatio="none">
          <g opacity={multi ? 0.32 : 1}>
            {bands.map((b, i) => (
              <path key={b.key} d={b.d} fill={b.ahead} opacity={multi ? b.opacity : 1} style={i ? { mixBlendMode: "plus-lighter" } : undefined} />
            ))}
          </g>
        </svg>
      </div>
      <div className="tl-wave tl-wave-played">
        <svg viewBox="0 0 100 26" preserveAspectRatio="none">
          <defs>
            <filter id="tl-glow" x="-10%" y="-100%" width="120%" height="300%">
              <feGaussianBlur stdDeviation={GLOW_STD} result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g filter="url(#tl-glow)">
            {bands.map((b, i) => (
              <path key={b.key} d={b.d} fill={b.played} opacity={multi ? b.opacity : 1} style={i ? { mixBlendMode: "plus-lighter" } : undefined} />
            ))}
          </g>
        </svg>
      </div>
    </>
  );
}

export default memo(Waveform);
