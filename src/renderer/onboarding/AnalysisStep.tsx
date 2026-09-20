import { AudioLines, Volume2 } from "lucide-react";
import { useAnalysis } from "../shell/useAnalysis";

// no choice to make here, a heads-up that the library gets listened to once in the background.
// shown as a step of the tour on fresh installs and as AnalysisIntro for everyone else
export default function AnalysisStep() {
  const count = useAnalysis().libraryTotal;
  const minutes = Math.max(1, Math.round((count * 0.6) / 60));
  return (
    <div className="ob-copy ob-single">
      <div className="ob-kicker">
        <span className="dia">◇</span> One listen per clip
      </div>
      <h1 className="ob-title">ClipLib hears your clips</h1>
      <p className="ob-lede">
        Each clip gets listened to once, in the background and only while you are not playing or
        exporting. That is where two things come from:
      </p>
      <div className="ob-cards">
        <div className="ob-card">
          <AudioLines size={17} />
          <strong>Waveform timeline</strong>
          <span>Every audio track drawn under the player timeline, game, mic and voice chat each in their own colour.</span>
        </div>
        <div className="ob-card">
          <Volume2 size={17} />
          <strong>Even loudness</strong>
          <span>Clips play at about the same level, so you stop reaching for the volume between them. Off in Settings, Audio.</span>
        </div>
      </div>
      <p className="ob-lede ob-outro">
        {count > 0
          ? `About ${minutes} min for your ${count.toLocaleString()} clips. A pill in the sidebar shows how far along it is.`
          : "A pill in the sidebar shows how far along it is."}
      </p>
    </div>
  );
}
