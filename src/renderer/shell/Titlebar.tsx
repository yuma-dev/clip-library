/**
 * Custom titlebar strip. The whole bar is a drag region; the native window
 * controls (min/max/close) are drawn by Electron's `titleBarOverlay` (configured
 * in main.js) at the top-right, so we don't render our own buttons — the main
 * process exposes no window-control IPC and we keep it that way (plan D2).
 */
export default function Titlebar() {
  return (
    <header className="titlebar">
      <div className="titlebar-drag" />
    </header>
  );
}
