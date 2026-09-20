import { AudioLines, Volume2 } from "lucide-react";

// no choice to make here, a heads-up that the library gets listened to once in the background.
// shown as a step of the tour on fresh installs and as AnalysisIntro for everyone else. kept
// short on purpose: a wall of text gets skipped
export default function AnalysisStep() {
  return (
    <div className="ob-copy ob-single">
      <h1 className="ob-title">ClipLib needs to analyze your clips.</h1>
      <p className="ob-lede">
        It runs in the background and only while nothing is playing or exporting. You get two things
        out of it:
      </p>
      <div className="ob-cards">
        <div className="ob-card">
          <AudioLines size={17} />
          <strong>Waveforms</strong>
          <span>Every audio track drawn under the player timeline.</span>
        </div>
        <div className="ob-card">
          <Volume2 size={17} />
          <strong>Even loudness</strong>
          <span>Clips play at the same level. Off in Settings, Audio.</span>
        </div>
      </div>
      <p className="ob-lede ob-outro">The pill in the sidebar shows the progress.</p>
    </div>
  );
}
