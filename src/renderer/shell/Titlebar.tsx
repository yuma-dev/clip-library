import { PanelLeft, Pin } from "lucide-react";
import GamepadIndicator from "./GamepadIndicator";

interface TitlebarProps {
  /** Pinned = static width; the width button toggles collapsed/expanded. */
  pinned: boolean;
  /** Rail is currently in dynamic (hover-to-expand) mode. */
  dynamic: boolean;
  /** Rail is currently statically collapsed. */
  collapsed: boolean;
  /** Width button — toggles dynamic (unpinned) or collapsed (pinned). */
  onToggleWidth: () => void;
  /** Pin button — switches between dynamic and static modes. */
  onTogglePin: () => void;
}

/**
 * Custom titlebar strip. The whole bar is a drag region; native window controls
 * (min/max/close) sit at the top-right via Electron's `titleBarOverlay`. At the
 * far left, two tiny no-drag controls govern the rail:
 *   • width button — collapses/expands (pinned) or toggles hover-mode (unpinned)
 *   • pin — switches between dynamic (hover) and static (manual) behavior.
 */
export default function Titlebar({
  pinned,
  dynamic,
  collapsed,
  onToggleWidth,
  onTogglePin,
}: TitlebarProps) {
  const narrow = dynamic || collapsed;
  const widthTip = pinned
    ? collapsed
      ? "Expand sidebar"
      : "Collapse sidebar"
    : dynamic
      ? "Sidebar: Dynamic — click for Fixed"
      : "Sidebar: Fixed — click for Dynamic";

  return (
    <header className="titlebar">
      <button
        type="button"
        className={`titlebar-btn${narrow ? " active" : ""}`}
        onClick={onToggleWidth}
        title={widthTip}
        aria-label="Toggle sidebar width"
      >
        <PanelLeft size={15} />
      </button>
      <button
        type="button"
        className={`titlebar-btn${pinned ? " active" : ""}`}
        onClick={onTogglePin}
        title={pinned ? "Unpin sidebar (enable hover-expand)" : "Pin sidebar (manual collapse)"}
        aria-label="Pin sidebar"
      >
        <Pin size={14} />
      </button>
      <GamepadIndicator />
      <div className="titlebar-drag" />
    </header>
  );
}
