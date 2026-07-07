import { useEffect, useRef } from "react";
import { Play } from "lucide-react";
import { startBlobAnimation } from "./blobAnimation";
import type { AmbientGlowSettings } from "./SettingsContext";

// Live ambient-glow preview: a mini "player" whose fake video content drives a
// blurred glow canvas behind it — same pipeline shape as the real player
// (source canvas → blur+saturate+opacity), so the smoothing / fps / blur /
// opacity settings read exactly like they will in the player. The full-screen
// player uses 40–120px of blur; the preview is ~4× smaller, so blur is scaled
// down to stay representative.

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
    return startBlobAnimation([video, glowCtx], {
      width: W,
      height: H,
      getFps: () => settingsRef.current.fps,
      getSmoothing: () => settingsRef.current.smoothing,
    });
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
