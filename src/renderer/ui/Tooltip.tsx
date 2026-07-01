import type { ReactNode } from "react";

interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
}

/**
 * Lightweight CSS hover tooltip. Good for buttons/icons; for edge-sensitive or
 * dynamic placement use a Popover instead.
 */
export default function Tooltip({ label, children, side = "top" }: TooltipProps) {
  return (
    <span className="tt-wrap">
      {children}
      <span className={`tt tt-${side}`} role="tooltip">
        {label}
      </span>
    </span>
  );
}
