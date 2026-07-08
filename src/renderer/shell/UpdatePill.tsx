import { memo, type CSSProperties } from "react";
import { Download, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { startUpdateDownload, useUpdater } from "./useUpdater";

// Four-point sparkle used for the hover star burst (Game Launcher style).
function StarSvg() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 784.11 815.53" aria-hidden>
      <path d="M392.05 0c-20.9,210.08 -184.06,378.41 -392.05,407.78 207.96,29.37 371.12,197.68 392.05,407.74 20.93,-210.06 184.09,-378.37 392.05,-407.74 -207.98,-29.38 -371.16,-197.69 -392.06,-407.78z" />
    </svg>
  );
}

// Update pill — sits between the stat cards and the profile card in the rail.
// Visual style copied from the Game Launcher rail updater: purple accent,
// progress fill while downloading, star burst on hover while available.
function UpdatePill() {
  const { phase, latestVersion, percent } = useUpdater();
  if (phase === "idle") return null;

  const busy = phase === "downloading";
  const label =
    phase === "available"
      ? "Update available"
      : phase === "downloading"
        ? "Downloading"
        : phase === "downloaded"
          ? "Launching installer…"
          : "Update failed";
  const tip = phase === "available" && latestVersion ? `${label} (v${latestVersion})` : label;
  const Icon =
    phase === "downloaded" ? RotateCcw : phase === "downloading" ? Loader2 : phase === "error" ? RefreshCw : Download;

  const handleClick = () => {
    // available → download; error → retry. Downloading/downloaded do nothing —
    // main launches the installer and quits on its own after the download.
    if (phase === "available" || phase === "error") void startUpdateDownload();
  };

  return (
    <button
      type="button"
      data-rail-tip={tip}
      className={`rail-update rail-update--${phase}`}
      onClick={handleClick}
      disabled={busy || phase === "downloaded"}
      style={busy ? ({ "--rail-update-pct": `${percent}%` } as CSSProperties) : undefined}
    >
      <span className="r-ico">
        <Icon size={15} className={busy ? "rail-update-spin" : undefined} />
      </span>
      <span className="rail-label">{label}</span>
      {busy ? <span className="rail-update-pct-label rail-label">{percent}%</span> : null}
      {phase === "available" && latestVersion ? (
        <span className="rail-update-version rail-label">v{latestVersion}</span>
      ) : null}
      {phase === "available" ? (
        <>
          <span className="rail-update-star star-1" aria-hidden><StarSvg /></span>
          <span className="rail-update-star star-2" aria-hidden><StarSvg /></span>
          <span className="rail-update-star star-3" aria-hidden><StarSvg /></span>
          <span className="rail-update-star star-4" aria-hidden><StarSvg /></span>
          <span className="rail-update-star star-5" aria-hidden><StarSvg /></span>
          <span className="rail-update-star star-6" aria-hidden><StarSvg /></span>
        </>
      ) : null}
    </button>
  );
}

export default memo(UpdatePill);
