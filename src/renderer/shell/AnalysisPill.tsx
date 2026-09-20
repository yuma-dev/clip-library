import { memo, useEffect, useState, type CSSProperties } from "react";
import { AudioLines, Check } from "lucide-react";
import { useAnalysis } from "./useAnalysis";
import { useAppNav } from "./appNav";

const DONE_SHOWN_MS = 6000;

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
  const [doneUntil, setDoneUntil] = useState(0);
  const [wasRunning, setWasRunning] = useState(false);

  useEffect(() => {
    if (a.running) setWasRunning(true);
    else if (wasRunning) {
      setWasRunning(false);
      setDoneUntil(Date.now() + DONE_SHOWN_MS);
      const t = window.setTimeout(() => setDoneUntil(0), DONE_SHOWN_MS);
      return () => window.clearTimeout(t);
    }
  }, [a.running, wasRunning]);

  const showDone = !a.running && doneUntil > Date.now();
  // a single opened clip queues one job too; the pill is for the library run
  if (!a.running && !showDone) return null;
  if (a.running && a.pending < 3) return null;

  const pct = a.total > 0 ? Math.min(100, Math.round((a.done / a.total) * 100)) : 0;
  const label = showDone
    ? "Library analyzed"
    : a.paused
      ? "Analysis paused"
      : `Analyzing · ${a.pending.toLocaleString()} left`;
  const tip = showDone
    ? "Every clip has its waveform and level"
    : a.paused
      ? "Waits while a clip plays or an export runs"
      : `${a.pending.toLocaleString()} clips to go${a.etaSeconds != null ? `, about ${fmtEta(a.etaSeconds)}` : ""}`;

  return (
    <button
      type="button"
      data-rail-tip={tip}
      className={`rail-update rail-update--analysis${showDone ? " rail-update--analysis-done" : ""}`}
      onClick={() => nav.openSettings("audio")}
      style={showDone ? undefined : ({ "--rail-update-pct": `${pct}%` } as CSSProperties)}
    >
      <span className="r-ico">{showDone ? <Check size={15} /> : <AudioLines size={15} />}</span>
      <span className="rail-label">{label}</span>
      {!showDone && a.etaSeconds != null ? <span className="rail-update-pct-label rail-label">{fmtEta(a.etaSeconds)}</span> : null}
    </button>
  );
}

export default memo(AnalysisPill);
