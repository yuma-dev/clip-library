import { AudioLines, Volume2 } from "lucide-react";
import logoUrl from "../../../assets/logo.png";

// three bands like the player timeline draws them; fixed shapes so the step looks the same every time
const BARS = 56;
const BANDS = [
  { color: "#f43f5e", amp: 11, seed: 1.7 },
  { color: "#ec4899", amp: 8, seed: 4.1 },
  { color: "#3b82f6", amp: 6, seed: 9.3 },
];
function bandPath(amp: number, seed: number): string {
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i < BARS; i++) {
    const x = (i / (BARS - 1)) * 100;
    const t = i / BARS;
    const lv = 0.35 + 0.65 * Math.abs(Math.sin(i / 3.1 + seed)) * (0.5 + 0.5 * Math.abs(Math.sin(i * 0.9 + seed * 2)));
    const edge = Math.min(1, t * 12, (1 - t) * 12);
    const h = Math.max(0.6, lv * amp * edge);
    top.push(`${i ? "L" : "M"}${x.toFixed(1)} ${(13 - h).toFixed(1)}`);
    bottom.push(`L${x.toFixed(1)} ${(13 + h).toFixed(1)}`);
  }
  return top.join("") + bottom.reverse().join("") + "Z";
}

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
      </p>
      <svg className="ob-analysis-wave" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
        {BANDS.map((b, i) => (
          <path key={b.color} d={bandPath(b.amp, b.seed)} fill={b.color} opacity={0.8} style={i ? { mixBlendMode: "plus-lighter" } : undefined} />
        ))}
      </svg>
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
