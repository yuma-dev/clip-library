import { useEffect, useRef } from "react";
import { startBlobAnimation } from "./blobAnimation";
import type { CardGlowSettings } from "./SettingsContext";

// Live preview of the library card hover glow: a mock clip card with the same
// glow pipeline as the grid (16×9 source scaled up behind the card,
// blur+saturate+brightness, screen blend over black). Grid blur is 10–100px on
// a ~400px card; the mock card is ~180px wide, so blur scales down to match.

const W = 64;
const H = 36;
const BLUR_SCALE = 0.5;

export default function CardGlowPreview({ glow }: { glow: CardGlowSettings }) {
  const thumbRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const thumb = thumbRef.current?.getContext("2d");
    const glowCtx = glowRef.current?.getContext("2d");
    if (!thumb || !glowCtx) return;
    return startBlobAnimation([thumb, glowCtx], {
      width: W,
      height: H,
      getFps: () => 30,
      getSmoothing: () => 0.3,
    });
  }, []);

  return (
    <div className="cardglow-preview" aria-hidden="true">
      <canvas
        ref={glowRef}
        className="cardglow-preview-glow"
        width={W}
        height={H}
        style={{
          filter: `blur(${Math.round(glow.blur * BLUR_SCALE)}px) saturate(${glow.saturate}) brightness(${glow.brightness})`,
          opacity: glow.enabled ? glow.opacity : 0,
        }}
      />
      <div className="cardglow-preview-card">
        <canvas ref={thumbRef} className="cardglow-preview-thumb" width={W} height={H} />
        <div className="cardglow-preview-foot">
          <div className="cardglow-preview-name">Clutch ace</div>
          <div className="cardglow-preview-meta">
            <span>2h ago</span>
            <span className="tag">Highlight</span>
          </div>
        </div>
      </div>
    </div>
  );
}
