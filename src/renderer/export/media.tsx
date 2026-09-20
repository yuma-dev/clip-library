import type { CSSProperties } from "react";
import type { ExportSpec } from "./types";

export function mediaPath(spec: ExportSpec): string | undefined {
  return spec.media?.thumbnail ?? spec.props?.thumbnail as string | undefined ?? spec.fixtures[0]?.clip.thumbnailPath ?? undefined;
}

export function Media({ spec, id, playing = true, style }: { spec: ExportSpec; id: string; playing?: boolean; style?: CSSProperties }) {
  const color = spec.media?.kind === "color" ? spec.media.color : undefined;
  const video = spec.media?.kind === "clip" ? spec.media.path : spec.props?.video as string | undefined;
  const common = { id, "data-layer": "thumbnail", style: { width: "100%", height: "100%", objectFit: "cover" as const, ...style } };
  if (color) return <div {...common} style={{ ...common.style, background: color }} />;
  if (video && playing) return <video {...common} data-export-video data-time={spec.props?.mediaTime as number | undefined} data-offset={spec.media?.offset ?? spec.props?.videoOffset ?? 0} src={`file://${video}`} muted preload="auto" />;
  const thumb = mediaPath(spec);
  return <img {...common} src={thumb ? `file://${thumb}` : undefined} alt="" />;
}

export function Glow({ spec, source, player = false, width, height, active = 1 }: { spec: ExportSpec; source: string; player?: boolean; width: number; height: number; active?: number }) {
  const defaults = player ? { blur:80, opacity:0.7, saturation:1.5, overflow:100 } : { blur:45, opacity:0.6, saturation:1.6, overflow:55 };
  const config = { ...defaults, ...(spec.props?.glow as object ?? {}) };
  const extraHeight = player ? config.overflow * 2 * 9 / 16 : config.overflow * 2;
  return <canvas className={player ? undefined : "clip-glow-canvas"} width={16} height={9} data-layer="glow" data-glow-source={spec.media?.kind === "color" ? "#no-image-source" : source}
    style={{ position:"absolute", left:-config.overflow, top:-extraHeight / 2, width:width + config.overflow * 2, height:height + extraHeight, pointerEvents:"none", filter:`blur(${config.blur}px) saturate(${config.saturation})`, opacity:config.opacity * active, transform:player ? undefined : `scale(${0.95 + active * 0.05})`, mixBlendMode:player ? "normal" : "screen" }} />;
}
