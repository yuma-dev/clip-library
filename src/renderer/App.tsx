import { useEffect, useRef, useState } from "react";
import Titlebar from "./shell/Titlebar";
import Sidebar from "./shell/Sidebar";
import LibraryView from "./views/LibraryView";
import SettingsView from "./views/SettingsView";
import VideoPlayer from "./player/VideoPlayer";
import { useClips } from "./library/useClips";
import type { Route } from "./routes";

export default function App() {
  const [route, setRoute] = useState<Route>("library");
  const lib = useClips();
  const readySent = useRef(false);

  // Dismiss the splash once the first clip load resolves.
  useEffect(() => {
    if (!lib.loading && !readySent.current) {
      readySent.current = true;
      window.clips?.rendererReady();
    }
  }, [lib.loading]);

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="app-body">
        <Sidebar route={route} onNavigate={setRoute} clipCount={lib.clips.length} />
        <main className="app-main">
          {route === "library" ? <LibraryView lib={lib} /> : null}
          {route === "settings" ? <SettingsView /> : null}
        </main>
      </div>
      {/* Wrapped legacy player overlay (fixed; hidden until a clip is opened). */}
      <VideoPlayer clipLocation={lib.clipLocation} clips={lib.clips} renameClip={lib.renameClip} />
    </div>
  );
}
