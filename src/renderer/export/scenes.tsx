// Scene registry for the exporter. A "scene" mounts one real app component (with
// whatever wrapper chrome it needs) into a fixed export frame, tagging sub-parts
// with `data-layer` so the capture script can peel them into separate PNGs.
//
// Scenes are the DISPOSABLE, per-component part of the pipeline — add one when you
// want to export a new component; the harness + capture script stay untouched.
// The `clipCard` scene below doubles as the reference implementation.

import type { ReactElement } from "react";
import ClipCard from "../library/ClipCard";
import type { ExportSpec, ClipFixture } from "./types";

export type Scene = (spec: ExportSpec) => ReactElement;

// Static copy of the hover glow (ClipGlow.ts): the thumbnail, blurred +
// screen-blended, bleeding `overflow`px around the 16:9 media box. Its own layer
// so it can be exported alone (drop it onto "Screen" blend in an editor).
function StaticGlow({ thumb, width, overflow }: { thumb: string | null; width: number; overflow: number }) {
  if (!thumb) return null;
  const mediaH = (width * 9) / 16;
  return (
    <div
      data-layer="glow"
      style={{
        position: "absolute",
        left: -overflow,
        top: -overflow,
        width: width + overflow * 2,
        height: mediaH + overflow * 2,
        zIndex: 1,
        pointerEvents: "none",
      }}
    >
      <img
        src={`file://${thumb}`}
        alt=""
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          filter: "blur(45px) saturate(1.6) brightness(1)",
          mixBlendMode: "screen",
          opacity: 0.6,
        }}
      />
    </div>
  );
}

function ClipCardScene(spec: ExportSpec): ReactElement {
  const f: ClipFixture | undefined = spec.fixtures[0];
  if (!f) return <div style={{ color: "#fff" }}>clipCard scene: no fixture</div>;
  const width = spec.card?.width ?? 340;
  const overflow = spec.card?.glowOverflow ?? 55;
  return (
    <div id="export-root" style={{ position: "relative", display: "inline-block", padding: overflow }}>
      <div
        data-layer="background"
        style={{ position: "absolute", inset: 0, background: spec.background ?? "#0f0f11" }}
      />
      <div className="clip-grid" style={{ position: "relative", padding: 0, width, zIndex: 2 }}>
        <StaticGlow thumb={f.clip.thumbnailPath} width={width} overflow={overflow} />
        <div style={{ position: "relative", zIndex: 2 }}>
          <ClipCard
            clip={f.clip}
            thumbnailPath={f.clip.thumbnailPath}
            grayscaleIcons={!!spec.props?.grayscaleIcons}
            showNewIndicators={!!spec.props?.showNewIndicators}
          />
        </div>
      </div>
    </div>
  );
}

export const scenes: Record<string, Scene> = {
  clipCard: ClipCardScene,
};
