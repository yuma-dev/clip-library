import { useEffect, useRef, useState, type CSSProperties } from "react";
import Waveform, { type TrackView } from "./Waveform";
import type { ClipWaveform } from "../../types/clips";

interface TimelineProps {
  /** null while no clip is open */
  waveform: ClipWaveform | null;
  tracks: TrackView[] | null;
  open: boolean;
}

/** the bar inside the bottom pill. legacy still owns seeking on click, trim-handle drags, the
 * playhead and the volume-range widgets (it writes inline left/right on #playhead, #progress-bar,
 * #trim-start, #trim-end); this component adds the waveform, drag-to-seek and a rAF loop that
 * mirrors trim + playhead into css vars so the hairlines and waveform clip-paths follow. */
export default function Timeline({ waveform, tracks, open }: TimelineProps) {
  const ref = useRef<HTMLDivElement>(null);
  // fractions of the full duration; only the waveform's end rounding needs them as state
  const [trim, setTrim] = useState({ start: 0, end: 1 });

  useEffect(() => {
    const el = ref.current;
    const video = document.getElementById("video-player") as HTMLVideoElement | null;
    if (!el || !video || !open) return;
    let raf = 0;
    let last = { pos: -1, ts: -1, te: -1 };
    const loop = () => {
      const d = video.duration;
      const state = window.legacyState;
      if (d > 0 && state) {
        const pos = Math.min(1, Math.max(0, video.currentTime / d));
        const ts = Math.min(1, Math.max(0, (state.trimStartTime ?? 0) / d));
        const te = Math.min(1, Math.max(ts, (state.trimEndTime ?? d) / d));
        if (pos !== last.pos) el.style.setProperty("--pos", `${(pos * 100).toFixed(3)}%`);
        if (ts !== last.ts || te !== last.te) {
          el.style.setProperty("--ts", `${(ts * 100).toFixed(3)}%`);
          el.style.setProperty("--te", `${(te * 100).toFixed(3)}%`);
          setTrim({ start: ts, end: te });
        }
        last = { pos, ts, te };
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
    let moved = false;
    const seek = (clientX: number) => {
      const r = el.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      const time = pct * video.duration;
      state.wasLastSeekManual = true;
      state.isAutoResetDisabled = time < state.trimStartTime || time > state.trimEndTime;
      video.currentTime = time;
    };
    const move = (ev: MouseEvent) => {
      moved = true;
      seek(ev.clientX);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (!moved) return;
      // a release over the backdrop would otherwise read as a close click
      window.justFinishedDragging = true;
      window.setTimeout(() => {
        window.justFinishedDragging = false;
      }, 100);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      id="progress-bar-container"
      ref={ref}
      onMouseDown={onMouseDown}
      style={{ "--pos": "0%", "--ts": "0%", "--te": "100%" } as CSSProperties}
    >
      <div className="tl-out tl-out-start" />
      <div className="tl-out tl-out-end" />
      <div id="progress-bar" />
      <Waveform waveform={waveform} tracks={tracks} trimStart={trim.start} trimEnd={trim.end} />
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
