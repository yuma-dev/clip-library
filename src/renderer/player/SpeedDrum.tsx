import { useEffect, useRef, useState } from "react";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ROW = 18;
// vertical drag distance per detent
const DRAG_STEP = 14;

const nearest = (rate: number) => {
  let best = 2;
  for (let i = 0; i < SPEEDS.length; i++) if (Math.abs(SPEEDS[i] - rate) < Math.abs(SPEEDS[best] - rate)) best = i;
  return best;
};

/** vertical wheel of playback speeds; scroll or drag a detent, the ring pulses on each step.
 * legacy's changeSpeed applies and persists the value, ratechange keeps the drum in sync with
 * whatever else sets the rate (clip open, space-hold boost). */
export default function SpeedDrum() {
  const [index, setIndex] = useState(2);
  const [tick, setTick] = useState(0);
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    const video = document.getElementById("video-player") as HTMLVideoElement | null;
    if (!video) return;
    const sync = () => setIndex(nearest(video.playbackRate));
    video.addEventListener("ratechange", sync);
    return () => video.removeEventListener("ratechange", sync);
  }, []);

  const step = (dir: number) => {
    const next = Math.min(SPEEDS.length - 1, Math.max(0, indexRef.current + dir));
    if (next === indexRef.current) return;
    setIndex(next);
    setTick((t) => t + 1);
    window.legacyPlayer?.changeSpeed(SPEEDS[next]);
  };

  return (
    <div
      className="pl-drum"
      title="Playback speed"
      onWheel={(e) => {
        e.stopPropagation();
        step(e.deltaY > 0 ? 1 : -1);
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        let y0 = e.clientY;
        const move = (ev: MouseEvent) => {
          const dy = ev.clientY - y0;
          if (Math.abs(dy) >= DRAG_STEP) {
            step(dy > 0 ? -1 : 1);
            y0 = ev.clientY;
          }
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      }}
    >
      <div className="pl-drum-roll" style={{ transform: `translateY(${11 - index * ROW}px)` }}>
        {SPEEDS.map((s, i) => (
          <div
            key={s}
            className="pl-drum-item"
            style={{
              opacity: i === index ? 1 : Math.max(0.12, 1 - Math.abs(i - index) * 0.5),
              transform: `scale(${i === index ? 1 : 0.82})`,
            }}
          >
            {s}x
          </div>
        ))}
      </div>
      {/* alternating animation names restart the pulse on every detent */}
      <div className="pl-drum-ring" style={{ animation: tick ? `pl-tick${tick % 2 ? "" : "-b"} .25s ease-out` : "none" }} />
    </div>
  );
}
