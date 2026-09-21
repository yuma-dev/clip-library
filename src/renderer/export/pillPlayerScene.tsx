// pillPlayer: the redesigned clip player (player/VideoPlayer.tsx + player.css) staged from a
// recipe. real stage, glow, pills, waveform timeline and speed drum; the <video> is export media,
// trim, playhead, mixer and hover state come from props, nothing here talks to the legacy player

import { useCallback, useState, type CSSProperties, type ReactElement } from "react";
import { ChevronLeft, ChevronRight, Copy, Maximize, Sparkle, Trash2, Upload } from "lucide-react";
import Waveform, { BINS, type TrackView } from "../player/Waveform";
import SpeedDrum from "../player/SpeedDrum";
import { AMBIENT_GLOW_DEFAULTS } from "../settings/SettingsContext";
import type { ClipWaveform } from "../../types/clips";
import type { ExportSpec } from "./types";
import { Media, mediaPath } from "./media";
import { MixerChip, MixerRow, VOLUME_ICON_NORMAL, type MixerTrack } from "./mixerRow";

// same as Timeline.tsx: the playhead never vanishes in silence
const PLAYHEAD_MIN = 8;

interface PillPlayerProps {
  title?: string;
  /** frame width in css px; 1728 is the app's 90% of a 1920 window */
  width?: number;
  /** canvas margin around the frame, room for the glow */
  pad?: number;
  durationSeconds?: number;
  currentSeconds?: number;
  trimStart?: number;
  trimEnd?: number;
  /** the analysis sidecar's envelope; null draws the not-analyzed placeholder */
  waveform?: ClipWaveform | null;
  /** multi-track clip: mixer rows and one band per visible track */
  tracks?: MixerTrack[];
  /** master level, single-track clips scale their band with it */
  gain?: number;
  /** 0 closed .. 1 open, the mixer's pop-in */
  mixerOpen?: number;
  /** ordinal whose hide button shows */
  hoverRow?: number;
  /** handle under the pointer, its line shows */
  activeHandle?: "start" | "end" | null;
  normalized?: boolean;
  speed?: number;
  navigation?: boolean;
  showShare?: boolean;
  glow?: { blur?: number; saturation?: number; opacity?: number } | false;
  frameWidth?: number;
  frameHeight?: number;
  cameraScale?: number;
  cameraX?: number;
  cameraY?: number;
  rootId?: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
const noop = () => {};

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function PillPlayerScene(spec: ExportSpec): ReactElement {
  const p = (spec.props ?? {}) as PillPlayerProps;
  const width = p.width ?? 1728;
  const pad = p.pad ?? 300;
  const height = (width * 9) / 16;
  const canvasW = width + 2 * pad;
  const canvasH = height + 2 * pad;
  const dur = p.durationSeconds ?? 0;
  const cur = clamp(p.currentSeconds ?? 0, 0, dur);
  const start = clamp(p.trimStart ?? 0, 0, dur);
  const end = clamp(p.trimEnd ?? dur, start, dur);
  const pos = dur ? cur / dur : 0;
  const ts = dur ? start / dur : 0;
  const te = dur ? end / dur : 1;
  const thumb = mediaPath(spec);
  const glow = { ...AMBIENT_GLOW_DEFAULTS, ...(p.glow || {}) };
  const glowOn = p.glow !== false && spec.media?.kind !== "color" && !!thumb;
  const tracks: TrackView[] | null = p.tracks
    ? p.tracks.map((t) => ({ ordinal: t.ordinal, name: t.name, color: t.color, hidden: !!t.hidden, muted: !!t.muted, volume: t.volume }))
    : null;
  const visibleRows = (p.tracks ?? []).filter((t) => !t.hidden);
  const hiddenRows = (p.tracks ?? []).filter((t) => t.hidden);
  const mixerOpen = clamp(p.mixerOpen ?? 0, 0, 1);

  // Timeline.tsx sizes the playhead to the tallest band under it each frame; same math, one render
  const [env, setEnv] = useState<number[] | null>(null);
  const onEnvelope = useCallback((e: number[] | null) => setEnv(e), []);
  let playheadH = 30;
  if (env) {
    const x = pos * (BINS - 1);
    const i = Math.floor(x);
    const half = env[i] + (env[Math.min(BINS - 1, i + 1)] - env[i]) * (x - i);
    playheadH = Math.max(PLAYHEAD_MIN, Math.round(half * 2 + 4));
  }

  // a background image, not <img>: the harness awaits every image's decode() and chromium never
  // settles it for the filtered frame glow
  const glowImage: CSSProperties = { backgroundImage: `url("file://${thumb}")`, backgroundSize: "cover", backgroundPosition: "center" };
  const containerStyle = {
    position: "absolute",
    left: 0,
    top: 0,
    width: canvasW,
    height: canvasH,
    overflow: "hidden",
    "--frame-top": `${pad}px`,
    "--frame-x": `${pad}px`,
    "--frame-bottom": `${pad}px`,
    "--glow-blur": `${glow.blur}px`,
    "--glow-sat": glow.saturation,
    "--glow-opacity": glow.opacity,
    transformOrigin: "0 0",
    transform: `scale(${p.cameraScale ?? 1}) translate(${-(p.cameraX ?? 0)}px, ${-(p.cameraY ?? 0)}px)`,
  } as CSSProperties;

  return (
    <div
      id={p.rootId ?? "export-root"}
      style={{ position: "relative", width: p.frameWidth ?? canvasW, height: p.frameHeight ?? canvasH, overflow: "hidden" }}
    >
      <div data-layer="background" style={{ position: "absolute", inset: 0, background: spec.background ?? "#0b0b0d" }} />
      <div id="player-container" style={containerStyle}>
        {glowOn ? <div className="pl-glow pl-glow-wide" data-layer="glow" style={glowImage} /> : null}
        <div className="pl-stage" style={{ "--ar": 16 / 9 } as CSSProperties}>
          {/* the breathe animation is off under the harness; sit between its two ends */}
          {glowOn ? <div className="pl-glow pl-glow-frame" data-layer="glow" style={{ ...glowImage, opacity: glow.opacity * 0.85 }} /> : null}
          <div className="pl-frame-box">
            {p.navigation ? (
              <>
                <button id="prev-video" className="video-nav-button" type="button" data-layer="nav">
                  <ChevronLeft size={18} strokeWidth={2.2} />
                </button>
                <button id="next-video" className="video-nav-button" type="button" data-layer="nav">
                  <ChevronRight size={18} strokeWidth={2.2} />
                </button>
              </>
            ) : null}
          </div>
          <div id="fullscreen-player" data-layer="card">
            <div id="video-container">
              <Media spec={spec} id="video-player" style={{ contain: "none", objectFit: "contain" } as CSSProperties} />
            </div>
            <div id="video-controls" className="visible" data-layer="controls">
              <div id="top-controls">
                <div className="pl-pill pl-title" data-layer="title">
                  <input type="text" id="clip-title" value={p.title ?? ""} readOnly spellCheck={false} />
                </div>
                <div className="pl-pill pl-actions" data-layer="actions">
                  <button id="export-button" type="button">
                    <Copy size={12} />
                    Copy
                  </button>
                  {p.showShare !== false ? (
                    <button id="share-button" type="button">
                      <Upload size={12} />
                      Post to feed
                    </button>
                  ) : null}
                  <button id="delete-button" type="button">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              <div id="bottom-controls" className="pl-pill pl-bar" data-layer="bar">
                <div id="volume-container">
                  {p.tracks ? (
                    <div
                      id="audio-tracks-panel"
                      data-layer="panel"
                      style={{
                        opacity: mixerOpen,
                        visibility: mixerOpen > 0 ? undefined : "hidden",
                        transform: `scale(${0.55 + mixerOpen * 0.45}) translateY(${(1 - mixerOpen) * 10}px)`,
                      }}
                    >
                      {hiddenRows.length > 0 ? (
                        <div className="mixer__hidden-tray" data-layer="tray">
                          {hiddenRows.map((t) => (
                            <MixerChip key={t.ordinal} track={t} />
                          ))}
                        </div>
                      ) : null}
                      <div className="mixer__tracks">
                        {visibleRows.map((t) => (
                          <MixerRow key={t.ordinal} track={t} hover={p.hoverRow === t.ordinal} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <button
                    id="volume-button"
                    type="button"
                    className={p.normalized ? "normalized" : undefined}
                    dangerouslySetInnerHTML={{ __html: VOLUME_ICON_NORMAL }}
                  />
                  <span className="pl-auto-mark" aria-hidden="true">
                    <Sparkle size={10} strokeWidth={2.2} fill="currentColor" />
                  </span>
                </div>
                <div id="current-time" data-layer="times">{fmtTime(cur)}</div>
                <div
                  id="progress-bar-container"
                  className={env ? "has-wave" : undefined}
                  data-layer="timeline"
                  style={{ "--pos": pct(pos), "--ts": pct(ts), "--te": pct(te) } as CSSProperties}
                >
                  <div className="tl-out tl-out-start" />
                  <div className="tl-out tl-out-end" />
                  <div id="progress-bar" style={{ left: pct(ts), right: pct(1 - te) }} />
                  <Waveform waveform={p.waveform ?? null} tracks={tracks} trimStart={ts} trimEnd={te} onEnvelope={onEnvelope} gain={p.gain ?? 1} />
                  <div id="playhead" style={{ height: playheadH, top: 20 - playheadH / 2 }} />
                  <div id="trim-start" style={{ left: pct(ts) }}>
                    <i style={p.activeHandle === "start" ? { opacity: 0.9 } : undefined} />
                  </div>
                  <div id="trim-end" style={{ right: pct(1 - te) }}>
                    <i style={p.activeHandle === "end" ? { opacity: 0.9 } : undefined} />
                  </div>
                </div>
                <div id="total-time" data-layer="times">{fmtTime(dur)}</div>
                <div id="speed-container">
                  <SpeedDrum rate={p.speed ?? 1} onChange={noop} />
                </div>
                <button id="fullscreen-button" type="button">
                  <Maximize size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
