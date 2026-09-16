import type { ReactNode } from "react";

interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
}

/** CSS hover tooltip for buttons/icons; use Popover instead for
 * edge-sensitive or dynamic placement. */
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
