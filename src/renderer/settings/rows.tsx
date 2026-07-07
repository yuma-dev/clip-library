import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";

/** Titled card grouping related settings rows. */
export function SetGroup({
  title,
  children,
  aside,
  span2,
}: {
  title?: ReactNode;
  children: ReactNode;
  /** Right-aligned extras in the group header (badge, toggle, reset). */
  aside?: ReactNode;
  /** Span both columns of the settings page grid. */
  span2?: boolean;
}) {
  return (
    <section className={`set-group${span2 ? " span-2" : ""}`}>
      {title ? (
        <header className="set-group-head">
          <h3 className="set-group-title">{title}</h3>
          {aside ? <div className="set-group-aside">{aside}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** Small "reset to defaults" icon button for group headers. */
export function GroupReset({ onClick, label = "Reset to defaults" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="set-reset" title={label} aria-label={label} onClick={onClick}>
      <RotateCcw size={13} />
    </button>
  );
}

/** One setting: label + description on the left, control on the right. */
export function SetRow({
  title,
  description,
  children,
  status,
  managed,
  stacked,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Extra status line under the description (update check, diagnostics…). */
  status?: ReactNode;
  /** Dim + badge the row as controlled by the export preset. */
  managed?: boolean;
  /** Render the control full-width under the text instead of to the right. */
  stacked?: boolean;
}) {
  return (
    <div className={`set-row${managed ? " managed" : ""}${stacked ? " stacked" : ""}`}>
      <div className="set-row-info">
        <div className="set-row-title">
          {title}
          {managed ? <span className="set-badge">Set by preset</span> : null}
        </div>
        {description ? <div className="set-row-desc">{description}</div> : null}
        {status}
      </div>
      {children ? <div className="set-row-control">{children}</div> : null}
    </div>
  );
}

/** Colored status line for async operations (updates, diagnostics, uploads). */
export function StatusLine({
  tone,
  children,
}: {
  tone: "info" | "progress" | "success" | "error";
  children: ReactNode;
}) {
  return <div className={`set-status set-status-${tone}`}>{children}</div>;
}
