import type { CSSProperties } from "react";

/** Shared production markup. Live exports are driven by exportToast.ts;
 * staged exports supply the same state through props without IPC or timers. */
export default function ExportProgress({ visible = false, progress = 0, clipboard = false }: {
  visible?: boolean;
  progress?: number;
  clipboard?: boolean;
}) {
  const complete = progress >= 100;
  return (
    <div id="export-toast" className={`export-toast${visible ? " show" : ""}`}>
      <div
        className={`export-toast-content${complete ? " complete" : ""}`}
        style={{ "--progress": `${progress}%` } as CSSProperties}
      >
        <div className="export-toast-header">
          <svg className="export-icon" viewBox="0 0 24 24">
            <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          <div className="export-text">
            <h3 className="export-title">
              {complete ? (clipboard ? "Copied to clipboard!" : "Export complete!") : "Exporting..."}
            </h3>
            <p className="export-progress-text">{progress}%</p>
          </div>
        </div>
      </div>
    </div>
  );
}
