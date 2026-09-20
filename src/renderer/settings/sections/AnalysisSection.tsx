import { useState } from "react";
import { AudioLines, Check, Loader2, RotateCcw } from "lucide-react";
import { SetGroup } from "../rows";
import { useConfirm } from "../../ui/ConfirmDialog";
import { useToast } from "../../ui/Toast";
import { refreshAnalysis, useAnalysis } from "../../shell/useAnalysis";

function fmtEta(seconds: number) {
  if (seconds < 60) return "under a minute left";
  const min = Math.round(seconds / 60);
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  return `about ${h} h ${min % 60} min left`;
}

/** the one listen every clip gets: what it is for, where the library run stands, and the reset */
export default function AnalysisSection() {
  const a = useAnalysis();
  const { confirm } = useConfirm();
  const toast = useToast();
  const [resetting, setResetting] = useState(false);

  const scanning = a.running;
  const pct = a.total > 0 ? Math.min(100, (a.done / a.total) * 100) : 0;
  const allDone = a.loaded && !scanning && a.libraryTotal > 0 && a.analyzed >= a.libraryTotal;

  const reset = async () => {
    const ok = await confirm({
      title: "Analyze the library again",
      message: "Every clip is listened to again from scratch. Loudness matching and the timeline waveforms come back as clips finish, which takes a while on a big library.",
      confirmLabel: "Analyze again",
    });
    if (!ok) return;
    setResetting(true);
    try {
      await window.clips.resetAudioAnalysis();
      refreshAnalysis();
      toast.show("Listening to the library again", "success");
    } catch (err) {
      toast.show((err as Error)?.message ? `Reset failed: ${(err as Error).message}` : "Reset failed", "error");
    } finally {
      setResetting(false);
    }
  };

  return (
    <SetGroup
      title="Audio analysis"
      span2
      aside={
        <button type="button" className="btn btn-ghost set-inline-btn" onClick={() => void reset()} disabled={resetting || scanning}>
          <RotateCcw size={13} />
          Analyze again
        </button>
      }
    >
      <p className="set-group-blurb">
        ClipLib listens to each clip once and remembers what it heard: the level of every audio track for the waveform in the
        player, and how loud the clip is overall for loudness matching. New recordings are picked up as they land. It runs in
        the background at low priority and waits while a clip plays or an export runs.
      </p>
      <div className="analysis-card">
        <div className="analysis-head">
          <div className="loud-chart-title">
            <AudioLines size={14} />
            <span>Your library</span>
          </div>
          <div className={`loud-status${scanning ? " scanning" : allDone ? " done" : ""}`}>
            {scanning ? (
              <>
                <Loader2 size={13} className="loud-spin" />
                <span>
                  {a.paused
                    ? `Paused while a clip plays, ${a.pending.toLocaleString()} to go`
                    : `Listening, ${a.pending.toLocaleString()} to go${a.etaSeconds != null ? `, ${fmtEta(a.etaSeconds)}` : ""}`}
                </span>
              </>
            ) : allDone ? (
              <>
                <Check size={13} />
                <span>{a.analyzed.toLocaleString()} clips analyzed</span>
              </>
            ) : (
              <span>
                {a.analyzed.toLocaleString()} of {a.libraryTotal.toLocaleString()} clips analyzed
              </span>
            )}
          </div>
        </div>
        {scanning ? (
          <div className="loud-progress" role="progressbar" aria-valuemin={0} aria-valuemax={a.total} aria-valuenow={a.done}>
            <div className="loud-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
      </div>
    </SetGroup>
  );
}
