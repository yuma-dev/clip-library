// Scene registry for the exporter. A "scene" mounts one real app component (with
// whatever wrapper chrome it needs) into a fixed export frame, tagging sub-parts
// with `data-layer` so the capture script can peel them into separate PNGs.
//
// Scenes are the DISPOSABLE, per-component part of the pipeline — add one when you
// want to export a new component; the harness + capture script stay untouched.
// The `clipCard` scene below doubles as the reference implementation.

import type { CSSProperties, ReactElement } from "react";
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

// ---------------------------------------------------------------------------
// audioMixer — the multi audio-track panel (player-legacy/audio-tracks-manager.js).
// Rendered statically from track data instead of a live Web Audio graph; the
// row visuals mirror _paintRow() exactly (fill = clamp(v/2,0,1), boosted colour
// when v > 1, value = round(v*100)%). Data comes from spec.props.tracks.
// ---------------------------------------------------------------------------

const BOOSTED_COLOR = "#f59e0b"; // matches audio-tracks-manager.js
const ICON_X =
  '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>';

interface MixerTrack {
  ordinal: number;
  name: string;
  volume: number; // 1 == 100%; range 0..2
  color: string; // #rrggbb
  muted?: boolean; // right-click soft mute (stays in mix, strikethrough)
  hidden?: boolean; // removed from mix -> floats in the hidden tray as a pill
}

// Hidden/disabled track: a "pill" chip in the tray above the panel (_buildChip).
function MixerChip({ track }: { track: MixerTrack }) {
  return (
    <button className="mixer__chip" type="button" style={{ color: track.color }} data-layer={`chip-${track.ordinal}`}>
      <span className="mixer__chip-dot" />
      <span className="mixer__chip-label">{track.name}</span>
    </button>
  );
}

function MixerRow({ track }: { track: MixerTrack }) {
  const v = track.volume;
  const above = v > 1;
  const pct = Math.max(0, Math.min(1, v / 2)) * 100;
  const rowStyle = {
    "--fill": `${pct}%`,
    "--c1": `${track.color}55`,
    "--c2": above ? `${BOOSTED_COLOR}aa` : `${track.color}88`,
    color: track.color,
  } as CSSProperties;
  return (
    <div className="mixer__row-wrap" data-layer={`row-${track.ordinal}`}>
      <div className={`mixer__row${track.muted ? " mixer__row--muted" : ""}`} data-ordinal={track.ordinal} style={rowStyle}>
        <div className="mixer__fill" />
        <div className="mixer__unity" />
        <div className="mixer__overlay">
          <button className="mixer__dot" type="button" aria-label="Change color" />
          <div className="mixer__name" title={track.name}>
            {track.name}
          </div>
          <div className="mixer__value">{Math.round(v * 100)}%</div>
          <button className="mixer__hide" type="button" aria-label="Hide from mix" dangerouslySetInnerHTML={{ __html: ICON_X }} />
        </div>
      </div>
    </div>
  );
}

function AudioMixerScene(spec: ExportSpec): ReactElement {
  const props = (spec.props ?? {}) as {
    tracks?: MixerTrack[];
    backdrop?: string | null;
    panelWidth?: number;
    pad?: number;
  };
  const tracks = props.tracks ?? [];
  const pad = props.pad ?? 44;
  const width = props.panelWidth ?? 320;
  const visible = tracks.filter((t) => !t.hidden);
  const hidden = tracks.filter((t) => t.hidden);
  return (
    <div id="export-root" style={{ position: "relative", display: "inline-block", padding: pad }}>
      <div data-layer="background" style={{ position: "absolute", inset: 0, background: spec.background ?? "#0f0f11", overflow: "hidden" }}>
        {props.backdrop ? (
          <img
            src={`file://${props.backdrop}`}
            alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(28px) brightness(0.5) saturate(1.15)", transform: "scale(1.15)" }}
          />
        ) : null}
      </div>
      <div
        id="audio-tracks-panel"
        data-layer="panel"
        style={{ position: "relative", width, margin: 0, animation: "none" }}
      >
        {hidden.length > 0 ? (
          <div className="mixer__hidden-tray" data-layer="tray">
            {hidden.map((t) => (
              <MixerChip key={t.ordinal} track={t} />
            ))}
          </div>
        ) : null}
        <div className="mixer__tracks">
          {visible.map((t) => (
            <MixerRow key={t.ordinal} track={t} />
          ))}
        </div>
      </div>
    </div>
  );
}

export const scenes: Record<string, Scene> = {
  clipCard: ClipCardScene,
  audioMixer: AudioMixerScene,
};
