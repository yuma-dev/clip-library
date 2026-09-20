import { AudioLines, Volume2 } from "lucide-react";
import logoUrl from "../../../assets/logo.png";
import Waveform, { type TrackView } from "../player/Waveform";
import type { ClipWaveform } from "../../types/clips";
import type { CSSProperties } from "react";

// a real five-track recording, its analysis resampled to 56 bins and drawn by the timeline's own
// Waveform component so the strip looks like the thing it announces
const LEVELS: number[][] = [
  [0.49, 0.53, 0.99, 0.6, 0.61, 0.58, 0.49, 1.04, 0.88, 0.97, 1, 0.96, 0.98, 0.98, 1.01, 0.47, 1.01, 0.91, 0.4, 0.41, 0.88, 1.01, 0.96, 0.48, 1.01, 1.03, 1.03, 0.56, 0.46, 0.84, 0.47, 1.07, 1.01, 1.03, 0.99, 0.55, 0.58, 0.53, 0.59, 0.52, 0.54, 0.91, 0.95, 0.8, 0.82, 1.04, 1.03, 1.01, 1.03, 1.03, 0.89, 1.09, 0.97, 0.71, 0.66, 0.7],
  [0, 0, 0.65, 0.53, 0.6, 0.45, 0.42, 1.04, 0.89, 0.84, 0.46, 0.44, 0.98, 0.83, 0.61, 0.41, 0.34, 0.35, 0.36, 0.4, 0.88, 0.36, 0.37, 0, 0.8, 0.62, 0.55, 0.52, 0.4, 0.38, 0.41, 0.67, 0.34, 0.74, 0.84, 0, 0, 0, 0.55, 0.46, 0.38, 0.91, 0.96, 0.8, 0.83, 0.94, 0.85, 0.88, 0.81, 0.85, 0.88, 1.01, 0.76, 0.66, 0.4, 0.64],
  [0.47, 0, 0.99, 0, 0.5, 0, 0, 0, 0, 0.97, 0.99, 0.96, 0, 0.98, 1.01, 0.44, 1.01, 0.92, 0, 0, 0, 1.01, 0.96, 0.48, 1, 1.02, 1.03, 0, 0, 0.85, 0, 1.07, 1.02, 1.01, 0.98, 0, 0, 0.49, 0, 0, 0, 0.61, 0, 0, 0, 1.04, 1.03, 1.01, 1.02, 1.03, 0.66, 1.09, 0.96, 0.32, 0, 0.51],
  [0.49, 0.54, 0.55, 0.55, 0.62, 0.58, 0.48, 0.35, 0.42, 0.35, 0.44, 0.31, 0.27, 0.4, 0.41, 0.41, 0, 0.08, 0.09, 0.11, 0.41, 0.49, 0.37, 0.38, 0.14, 0.26, 0.35, 0.47, 0.36, 0.43, 0.44, 0.37, 0.48, 0.26, 0.47, 0.53, 0.58, 0.49, 0.39, 0.47, 0.55, 0.57, 0.56, 0.41, 0.5, 0.48, 0.48, 0.56, 0.59, 0.51, 0.53, 0.6, 0.58, 0.67, 0.66, 0.66],
  [0, 0.1, 0, 0, 0.1, 0, 0, 0.1, 0, 0, 0, 0, 0, 0.2, 0.21, 0.21, 0.21, 0.21, 0.21, 0.22, 0.21, 0.21, 0.2, 0.21, 0.21, 0.21, 0.21, 0.2, 0.22, 0.21, 0.2, 0.22, 0.2, 0.21, 0.21, 0.21, 0.22, 0.21, 0.21, 0.21, 0.21, 0.21, 0.21, 0.19, 0.19, 0.2, 0.19, 0.19, 0.19, 0.2, 0.21, 0.2, 0.21, 0.21, 0.21, 0.2],
];
// the player hides the Mix track, so it is the last, thinnest band; the intermittent voice track goes
// first so the others show where it is quiet. levels back to dBFS for the timeline component
const TRACKS = [
  { levels: 2, color: "#ec4899" },
  { levels: 1, color: "#a855f7" },
  { levels: 3, color: "#3b82f6" },
  { levels: 4, color: "#6ee7f0" },
  { levels: 0, color: "#f43f5e" },
];
const waveform: ClipWaveform = {
  rate: 10,
  tracks: TRACKS.map((t, i) => {
    const peak = LEVELS[t.levels].map((lv) => Math.round((lv * 48 - 54) * 10) / 10);
    return { ordinal: i, streamIndex: i, peak, rms: peak };
  }),
};
const tracksView: TrackView[] = TRACKS.map((t, i) => ({ ordinal: i, name: "track " + i, color: t.color, hidden: false, muted: false }));
// where the fake playhead sits, as the timeline's css var
const POS = "75%";

// no choice to make here, a heads-up that the library gets listened to once in the background.
// shown as a step of the tour on fresh installs and as AnalysisIntro for everyone else. kept
// short on purpose: a wall of text gets skipped
export default function AnalysisStep() {
  return (
    <div className="ob-copy ob-single ob-analysis">
      <h1 className="ob-title ob-analysis-title">
        <img className="ob-analysis-logo" src={logoUrl} alt="" draggable={false} />
        ClipLib needs to analyze your clips.
      </h1>
      <p className="ob-lede">
        It runs in the background and only while nothing is playing or exporting. You get two things
        out of it:
        <span className="ob-analysis-wave" style={{ "--pos": POS, "--ts": "0%", "--te": "100%" } as CSSProperties}>
          <Waveform waveform={waveform} tracks={tracksView} trimStart={0} trimEnd={1} />
          <i className="ob-analysis-playhead" />
        </span>
      </p>
      <div className="ob-cards">
        <div className="ob-card">
          <span className="ob-analysis-ico">
            <AudioLines size={17} />
          </span>
          <strong>Waveforms</strong>
          <span>Every audio track drawn under the player timeline.</span>
        </div>
        <div className="ob-card">
          <span className="ob-analysis-ico">
            <Volume2 size={17} />
          </span>
          <strong>Even loudness</strong>
          <span>Clips play at the same level. Off in Settings, Audio.</span>
        </div>
      </div>
      <p className="ob-lede ob-outro">The pill in the sidebar shows the progress.</p>
    </div>
  );
}
