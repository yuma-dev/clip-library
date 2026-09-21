// mixer rows for the export scenes, rendered statically from track data; visuals mirror
// player-legacy/audio-tracks-manager.js _paintRow() (fill=clamp(v/2,0,1)), styles from player.css

import type { CSSProperties } from "react";

export const BOOSTED_COLOR = "#f59e0b"; // matches audio-tracks-manager.js
const ICON_X =
  '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>';

// exact app volume glyph (player-legacy/video-player.js volumeIcons.normal, default volume 1),
// Material Symbols speaker-with-waves
export const VOLUME_ICON_NORMAL =
  '<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M760-481q0-83-44-151.5T598-735q-15-7-22-21.5t-2-29.5q6-16 21.5-23t31.5 0q97 43 155 131.5T840-481q0 108-58 196.5T627-153q-16 7-31.5 0T574-176q-5-15 2-29.5t22-21.5q74-34 118-102.5T760-481ZM280-360H160q-17 0-28.5-11.5T120-400v-160q0-17 11.5-28.5T160-600h120l132-132q19-19 43.5-8.5T480-703v446q0 27-24.5 37.5T412-228L280-360Zm380-120q0 42-19 79.5T591-339q-10 6-20.5.5T560-356v-250q0-12 10.5-17.5t20.5.5q31 25 50 63t19 80ZM400-606l-86 86H200v80h114l86 86v-252ZM300-480Z"/></svg>';

export interface MixerTrack {
  ordinal: number;
  name: string;
  volume: number; // 1 == 100%; range 0..2
  color: string; // #rrggbb
  muted?: boolean; // right-click soft mute (stays in mix, strikethrough)
  hidden?: boolean; // removed from mix, floats in the hidden tray as a pill
}

// hidden/disabled track: a "pill" chip in the tray above the panel (_buildChip)
export function MixerChip({ track }: { track: MixerTrack }) {
  return (
    <button className="mixer__chip" type="button" style={{ color: track.color }} data-layer={`chip-${track.ordinal}`}>
      <span className="mixer__chip-dot" />
      <span className="mixer__chip-label">{track.name}</span>
    </button>
  );
}

// hover: the app reveals the hide button on the row under the pointer
export function MixerRow({ track, hover = false }: { track: MixerTrack; hover?: boolean }) {
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
          <button className="mixer__hide" type="button" aria-label="Hide from mix" style={hover ? { opacity: 1 } : undefined} dangerouslySetInnerHTML={{ __html: ICON_X }} />
        </div>
      </div>
    </div>
  );
}
