import { useEffect, useRef } from "react";
import type { CardGlowSettings } from "./SettingsContext";

// Live preview of the library card hover glow, replicating the grid pipeline
// exactly: the (real) thumbnail is downsampled into a 16×9 canvas, which CSS
// blows up behind the card with blur + saturate + brightness, screen-blended
// over black and masked so it fades at the edges (see .clip-glow-canvas).
// The grid card is ~400px wide with a 55px overflow and 10–100px of blur; this
// mock card is 150px, so lengths scale by 150/400 = 0.375.

const SCALE = 0.375;
const OVERFLOW = Math.round(55 * SCALE); // ≈21px bleed, like the grid's 55px
const CARD_W = 150;
const CARD_H = 84;

export default function CardGlowPreview({
  glow,
  thumb,
}: {
  glow: CardGlowSettings;
  /** Absolute path of a real library thumbnail (null → gradient fallback). */
  thumb: string | null;
}) {
  const thumbRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);

  // Draw the thumbnail once into both canvases (16×9 glow source + card thumb),
  // the same downsample the grid's ClipGlow does.
  useEffect(() => {
    const thumbCtx = thumbRef.current?.getContext("2d");
    const glowCtx = glowRef.current?.getContext("2d");
    if (!thumbCtx || !glowCtx) return;

    const fallback = () => {
      for (const [ctx, w, h] of [
        [thumbCtx, 320, 180],
        [glowCtx, 16, 9],
      ] as const) {
        const g = ctx.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, "#3b2d52");
        g.addColorStop(0.55, "#1d3a4a");
        g.addColorStop(1, "#233a25");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    };

    if (!thumb) {
      fallback();
      return;
    }
    const img = new Image();
    let cancelled = false;
    img.onload = () => {
      if (cancelled) return;
      thumbCtx.drawImage(img, 0, 0, 320, 180);
      glowCtx.drawImage(img, 0, 0, 16, 9);
    };
    img.onerror = () => {
      if (!cancelled) fallback();
    };
    img.src = `file://${thumb}`;
    return () => {
      cancelled = true;
    };
  }, [thumb]);

  return (
    <div className="cardglow-preview" aria-hidden="true">
      <div className="cardglow-preview-stage">
        <canvas
          ref={glowRef}
          className="cardglow-preview-glow"
          width={16}
          height={9}
          style={{
            left: -OVERFLOW,
            top: -OVERFLOW,
            width: CARD_W + OVERFLOW * 2,
            height: CARD_H + OVERFLOW * 2,
            filter: `blur(${Math.max(2, Math.round(glow.blur * SCALE))}px) saturate(${glow.saturate}) brightness(${glow.brightness})`,
            opacity: glow.enabled ? glow.opacity : 0,
          }}
        />
        <div className="cardglow-preview-card">
          <canvas ref={thumbRef} className="cardglow-preview-thumb" width={320} height={180} />
          <div className="cardglow-preview-foot">
            <div className="cardglow-preview-name">Clutch ace</div>
            <div className="cardglow-preview-meta">
              <span>2h ago</span>
              <span className="tag">Highlight</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
