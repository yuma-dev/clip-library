import { useEffect, useMemo, useRef } from "react";
import { Play } from "lucide-react";
import { loadPreviewImage, startBlobAnimation } from "./blobAnimation";
import type { AmbientGlowSettings } from "./SettingsContext";

// Live ambient-glow preview: a mini "player" showing a real library thumbnail
// (plus faint drifting color so smoothing/fps are visible) driving a glow
// canvas behind it — the player's pipeline (16×9 source → blur+saturate,
// opacity). The real player blurs 40–120px across a ~1400px-wide video; this
// preview's video is 160px, so blur scales by ~0.12 to look like the real thing.

const W = 64;
const H = 36;
const BLUR_SCALE = 0.12;

export default function GlowPreview({
  glow,
  thumb,
}: {
  glow: AmbientGlowSettings;
  /** Absolute path of a real library thumbnail (null → gradient fallback). */
  thumb: string | null;
}) {
  const videoRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef(glow);
  settingsRef.current = glow;
  const image = useMemo(() => loadPreviewImage(thumb), [thumb]);

  useEffect(() => {
    const video = videoRef.current?.getContext("2d");
    const glowCtx = glowRef.current?.getContext("2d");
    if (!video || !glowCtx) return;
    return startBlobAnimation([video, glowCtx], {
      width: W,
      height: H,
      getFps: () => settingsRef.current.fps,
      getSmoothing: () => settingsRef.current.smoothing,
      getBaseImage: () => image.get(),
    });
  }, [image]);

  return (
    <div className="glow-preview" aria-hidden="true">
      <canvas
        ref={glowRef}
        className="glow-preview-glow"
        width={W}
        height={H}
        style={{
          filter: `blur(${Math.max(2, Math.round(glow.blur * BLUR_SCALE))}px) saturate(${glow.saturation})`,
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
