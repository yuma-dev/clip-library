import { memo, useEffect, useState, type CSSProperties } from "react";
import { AudioLines, Check } from "lucide-react";
import { useAnalysis } from "./useAnalysis";
import { useAppNav } from "./appNav";

const DONE_SHOWN_MS = 6000;
// a single opened clip queues one job too; the pill is for the library run
const LIBRARY_RUN_MIN = 3;

function fmtEta(seconds: number): string {
  if (seconds < 60) return "under a min";
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

// sits in the update pill's slot while the one-time library listen runs; the same look, its
// own colour. clicking opens Settings > Audio. shows "done" once for a few seconds after a run
function AnalysisPill() {
  const a = useAnalysis();
  const nav = useAppNav();
  // set once a run is big enough to show; stays through its last few clips so the pill does not
  // blink off before the done state. the done state only follows a run the pill showed
  const [libraryRun, setLibraryRun] = useState(false);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    if (a.running) {
      if (a.pending >= LIBRARY_RUN_MIN) setLibraryRun(true);
    } else if (libraryRun) {
      setLibraryRun(false);
      setShowDone(true);
    }
  }, [a.running, a.pending, libraryRun]);

  // its own effect: the run effect above re-runs on its own state change, which would clear a
  // timer it owned
  useEffect(() => {
    if (!showDone) return;
    const t = window.setTimeout(() => setShowDone(false), DONE_SHOWN_MS);
    return () => window.clearTimeout(t);
  }, [showDone]);

  const running = a.running && libraryRun;
  if (!running && !showDone) return null;

  const pct = a.total > 0 ? Math.min(100, Math.round((a.done / a.total) * 100)) : 0;
  const label = !running
    ? "Library analyzed"
    : a.paused
      ? "Analysis paused"
      : `Analyzing · ${a.pending.toLocaleString()} left`;
  const tip = !running
    ? "Every clip has its waveform and level"
    : a.paused
      ? "Waits while a clip plays or an export runs"
      : `${a.pending.toLocaleString()} clips to go${a.etaSeconds != null ? `, about ${fmtEta(a.etaSeconds)}` : ""}`;

  return (
    <button
      type="button"
      data-rail-tip={tip}
      className={`rail-update rail-update--analysis${running ? "" : " rail-update--analysis-done"}`}
      onClick={() => nav.openSettings("audio")}
      style={running ? ({ "--rail-update-pct": `${pct}%` } as CSSProperties) : undefined}
    >
      <span className="r-ico">{running ? <AudioLines size={15} /> : <Check size={15} />}</span>
      <span className="rail-label">{label}</span>
      {running && !a.paused && a.etaSeconds != null ? <span className="rail-update-pct-label rail-label">{fmtEta(a.etaSeconds)}</span> : null}
    </button>
  );
}

export default memo(AnalysisPill);
