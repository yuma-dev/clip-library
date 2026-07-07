// Shared fake-"video" animation for the glow previews. With a base image
// (a real library thumbnail) it draws the image plus faint drifting color
// blobs — enough motion to demonstrate smoothing/update-rate without looking
// like a neon lamp. Without one it falls back to full-strength blobs.
// Draws the same frame to every ctx (video + glow copies) so a CSS-filtered
// duplicate stays in sync.

export interface BlobAnimationOpts {
  width: number;
  height: number;
  /** Redraw throttle — mirrors the ambient glow fps setting. */
  getFps: () => number;
  /** Hue lerp factor per frame (lower = smoother), mirrors glow smoothing. */
  getSmoothing: () => number;
  /** Real thumbnail to draw under the blobs (may resolve late — polled per frame). */
  getBaseImage?: () => CanvasImageSource | null;
}

export function startBlobAnimation(
  contexts: CanvasRenderingContext2D[],
  { width: W, height: H, getFps, getSmoothing, getBaseImage }: BlobAnimationOpts,
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

    const base = getBaseImage?.() ?? null;
    const blobAlpha = base ? 0.3 : 1;

    for (const ctx of contexts) {
      ctx.clearRect(0, 0, W, H);
      if (base) {
        try {
          ctx.drawImage(base, 0, 0, W, H);
        } catch {
          /* image not ready — blobs only this frame */
        }
      }
      ctx.globalAlpha = blobAlpha;
      const g1 = ctx.createRadialGradient(
        W * (0.3 + 0.2 * Math.sin(t * 0.7)),
        H * (0.4 + 0.25 * Math.cos(t * 0.5)),
        2,
        W * 0.35,
        H * 0.45,
        W * 0.75,
      );
      g1.addColorStop(0, `hsl(${hue}, 85%, 60%)`);
      g1.addColorStop(1, base ? "transparent" : `hsl(${hue + 60}, 70%, 22%)`);
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
      ctx.globalAlpha = 1;
    }
  };

  raf = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(raf);
}

/** Load a file path as an <img> for canvas drawing; resolves null on failure. */
export function loadPreviewImage(path: string | null): { get: () => HTMLImageElement | null } {
  let img: HTMLImageElement | null = null;
  if (path) {
    const el = new Image();
    el.onload = () => {
      img = el;
    };
    el.src = `file://${path}`;
  }
  return { get: () => img };
}
