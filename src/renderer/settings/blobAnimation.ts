// Shared fake-"video" animation for the glow previews: slow moving color
// blobs whose displayed hue trails a drifting target. Draws the same frame to
// every ctx (video + glow copies) so a CSS-filtered duplicate stays in sync.

export interface BlobAnimationOpts {
  width: number;
  height: number;
  /** Redraw throttle — mirrors the ambient glow fps setting. */
  getFps: () => number;
  /** Hue lerp factor per frame (lower = smoother), mirrors glow smoothing. */
  getSmoothing: () => number;
}

export function startBlobAnimation(
  contexts: CanvasRenderingContext2D[],
  { width: W, height: H, getFps, getSmoothing }: BlobAnimationOpts,
): () => void {
  let raf = 0;
  let last = 0;
  let hue = 280;
  let t = 0;

  const draw = (now: number) => {
    raf = requestAnimationFrame(draw);
    const interval = 1000 / (getFps() || 30);
    if (now - last < interval) return;
    last = now;

    t += interval / 1000;
    const target = 280 + Math.sin(t * 0.5) * 120 + Math.sin(t * 0.13) * 60;
    hue += (target - hue) * Math.min(1, getSmoothing() * 0.35);

    for (const ctx of contexts) {
      ctx.clearRect(0, 0, W, H);
      const g1 = ctx.createRadialGradient(
        W * (0.3 + 0.2 * Math.sin(t * 0.7)),
        H * (0.4 + 0.25 * Math.cos(t * 0.5)),
        2,
        W * 0.35,
        H * 0.45,
        W * 0.75,
      );
      g1.addColorStop(0, `hsl(${hue}, 85%, 60%)`);
      g1.addColorStop(1, `hsl(${hue + 60}, 70%, 22%)`);
      ctx.fillStyle = g1;
      ctx.fillRect(0, 0, W, H);

      const g2 = ctx.createRadialGradient(
        W * (0.7 + 0.18 * Math.cos(t * 0.6)),
        H * (0.6 + 0.25 * Math.sin(t * 0.4)),
        1,
        W * 0.7,
        H * 0.6,
        W * 0.5,
      );
      g2.addColorStop(0, `hsla(${hue + 140}, 90%, 65%, 0.85)`);
      g2.addColorStop(1, "transparent");
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, W, H);
    }
  };

  raf = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(raf);
}
