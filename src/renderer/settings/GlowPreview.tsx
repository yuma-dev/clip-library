import { useEffect, useRef } from "react";
import { Play } from "lucide-react";
import type { AmbientGlowSettings } from "./SettingsContext";

// Live ambient-glow preview: a mini "player" whose fake video content (slow
// moving color blobs) drives a blurred glow canvas behind it — same pipeline
// shape as the real player (source canvas → blur+saturate+opacity), so the
// smoothing / fps / blur / opacity settings read exactly like they will in
// the player. The full-screen player uses 40–120px of blur; the preview is
// ~4× smaller, so blur is scaled down to stay representative.

const W = 64;
const H = 36;
const BLUR_SCALE = 0.45;

export default function GlowPreview({ glow }: { glow: AmbientGlowSettings }) {
  const videoRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef(glow);
  settingsRef.current = glow;

  useEffect(() => {
    const video = videoRef.current?.getContext("2d");
    const glowCtx = glowRef.current?.getContext("2d");
    if (!video || !glowCtx) return;

    let raf = 0;
    let last = 0;
    // Displayed hue trails a drifting target; the lerp factor is the
    // `smoothing` setting (lower = smoother), like the player's temporal
    // smoothing of sampled colors.
    let hue = 280;
    let t = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const s = settingsRef.current;
      const interval = 1000 / (s.fps || 30);
      if (now - last < interval) return;
      last = now;

      t += interval / 1000;
      const target = 280 + Math.sin(t * 0.5) * 120 + Math.sin(t * 0.13) * 60;
      hue += (target - hue) * Math.min(1, s.smoothing * 0.35);

      for (const ctx of [video, glowCtx]) {
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
  }, []);

  return (
    <div className="glow-preview" aria-hidden="true">
      <canvas
        ref={glowRef}
        className="glow-preview-glow"
        width={W}
        height={H}
        style={{
          filter: `blur(${Math.round(glow.blur * BLUR_SCALE)}px) saturate(${glow.saturation})`,
          opacity: glow.enabled ? glow.opacity : 0,
        }}
      />
      <div className="glow-preview-player">
        <canvas ref={videoRef} className="glow-preview-video" width={W} height={H} />
        <div className="glow-preview-controls">
          <Play size={9} fill="currentColor" />
          <div className="glow-preview-bar">
            <div className="glow-preview-bar-fill" />
          </div>
        </div>
      </div>
    </div>
  );
}
