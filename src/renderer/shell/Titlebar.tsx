import { PanelLeft, Pin } from "lucide-react";
import GamepadIndicator from "./GamepadIndicator";

interface TitlebarProps {
  /** Pinned = static width; the width button toggles collapsed/expanded. */
  pinned: boolean;
  /** hover-to-expand mode */
  dynamic: boolean;
  collapsed: boolean;
  /** toggles dynamic (unpinned) or collapsed (pinned) */
  onToggleWidth: () => void;
  onTogglePin: () => void;
}

/** whole bar is a drag region; native window controls sit top-right via Electron's `titleBarOverlay`
 * two no-drag controls at left: width toggles collapse/hover-mode, pin switches dynamic/static */
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
