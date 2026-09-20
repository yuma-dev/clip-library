import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import Waveform, { BINS, type TrackView } from "./Waveform";
import type { ClipWaveform } from "../../types/clips";

// px; above the silence thread (2 x 0.6 units) so the playhead never vanishes in quiet parts
const PLAYHEAD_MIN = 8;

interface TimelineProps {
  /** null while no clip is open */
  waveform: ClipWaveform | null;
  tracks: TrackView[] | null;
  open: boolean;
  /** master level, single-track clips scale their band with it */
  gain: number;
}

/** the bar inside the bottom pill. legacy still owns seeking on click, trim-handle drags, the
 * playhead and the volume-range widgets (it writes inline left/right on #playhead, #progress-bar,
 * #trim-start, #trim-end); this component adds the waveform, drag-to-seek and a rAF loop that
 * mirrors trim + playhead into css vars so the hairlines and waveform clip-paths follow. */
export default function Timeline({ waveform, tracks, open, gain }: TimelineProps) {
  const ref = useRef<HTMLDivElement>(null);
  // fractions of the full duration; only the waveform's end rounding needs them as state
  const [trim, setTrim] = useState({ start: 0, end: 1 });
  // tallest band per bin in svg units (1 unit = 1px here); the playhead grows and shrinks with it
  const envelopeRef = useRef<number[] | null>(null);
  const [hasWave, setHasWave] = useState(false);
  const onEnvelope = useCallback((env: number[] | null) => {
    envelopeRef.current = env;
    setHasWave(env !== null);
  }, []);

  useEffect(() => {
    const el = ref.current;
    const video = document.getElementById("video-player") as HTMLVideoElement | null;
    const playhead = document.getElementById("playhead");
    const controls = document.getElementById("video-controls");
    if (!el || !video || !playhead || !open) return;
    let raf = 0;
    let last = { pos: -1, ts: -1, te: -1, h: -1 };
    const loop = () => {
      const d = video.duration;
      const state = window.legacyState;
      // chrome faded out: nothing here is visible, and the var writes cost a style pass per frame
      const shown = !controls || controls.classList.contains("visible");
      if (d > 0 && state && shown) {
        const pos = Math.min(1, Math.max(0, video.currentTime / d));
        const ts = Math.min(1, Math.max(0, (state.trimStartTime ?? 0) / d));
        const te = Math.min(1, Math.max(ts, (state.trimEndTime ?? d) / d));
        if (pos !== last.pos) el.style.setProperty("--pos", `${(pos * 100).toFixed(3)}%`);
        // band half-height under the playhead, interpolated between bins; the svg centre sits at 20px
        const env = envelopeRef.current;
        let h = 30;
        if (env) {
          const x = pos * (BINS - 1);
          const i = Math.floor(x);
          const half = env[i] + (env[Math.min(BINS - 1, i + 1)] - env[i]) * (x - i);
          h = Math.max(PLAYHEAD_MIN, Math.round(half * 2 + 4));
        }
        if (h !== last.h) {
          playhead.style.height = `${h}px`;
          playhead.style.top = `${20 - h / 2}px`;
        }
        last.h = h;
        if (ts !== last.ts || te !== last.te) {
          el.style.setProperty("--ts", `${(ts * 100).toFixed(3)}%`);
          el.style.setProperty("--te", `${(te * 100).toFixed(3)}%`);
          setTrim({ start: ts, end: te });
        }
        last = { pos, ts, te, h };
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // drag anywhere seeks. runs after legacy's own mousedown (native listener on the same node), which
  // already seeked to the press point or claimed a trim handle via state.isDragging
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const state = window.legacyState;
    const video = document.getElementById("video-player") as HTMLVideoElement | null;
    const el = ref.current;
    if (!state || !video || !el || state.isDragging) return;
    const t = e.target as HTMLElement;
    if (t.closest(".volume-drag-control, .volume-start, .volume-end")) return;
    const seek = (clientX: number) => {
      const r = el.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      const time = pct * video.duration;
      state.wasLastSeekManual = true;
      state.isAutoResetDisabled = time < state.trimStartTime || time > state.trimEndTime;
      video.currentTime = time;
    };
    const move = (ev: MouseEvent) => seek(ev.clientX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      id="progress-bar-container"
      className={hasWave ? "has-wave" : undefined}
      ref={ref}
      onMouseDown={onMouseDown}
      style={{ "--pos": "0%", "--ts": "0%", "--te": "100%" } as CSSProperties}
    >
      <div className="tl-out tl-out-start" />
      <div className="tl-out tl-out-end" />
      <div id="progress-bar" />
      <Waveform waveform={waveform} tracks={tracks} trimStart={trim.start} trimEnd={trim.end} onEnvelope={onEnvelope} gain={gain} />
      <div id="playhead" />
      <div id="trim-start" title="Trim start">
        <i />
      </div>
      <div id="trim-end" title="Trim end">
        <i />
      </div>
      <div id="timeline-preview" className="timeline-preview">
        <canvas id="preview-canvas" width={160} height={90} />
        <div id="preview-timestamp" />
      </div>
    </div>
  );
}
