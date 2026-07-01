import { useEffect, useState } from "react";
import Titlebar from "./shell/Titlebar";
import Sidebar from "./shell/Sidebar";
import LibraryView from "./views/LibraryView";
import SettingsView from "./views/SettingsView";
import type { Route } from "./routes";

export default function App() {
  const [route, setRoute] = useState<Route>("library");
  const [clipCount, setClipCount] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const clips = await window.clips.getClips();
        if (!cancelled) setClipCount(Array.isArray(clips) ? clips.length : 0);
      } catch {
        // Non-fatal for the shell; the Library view surfaces load state.
      } finally {
        if (!cancelled) setReady(true);
        // Dismiss the splash once the shell has its first data.
        window.clips?.rendererReady();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="app-body">
        <Sidebar route={route} onNavigate={setRoute} clipCount={clipCount} />
        <main className="app-main">
          {route === "library" ? <LibraryView clipCount={clipCount} ready={ready} /> : null}
          {route === "settings" ? <SettingsView /> : null}
        </main>
      </div>
    </div>
  );
}
