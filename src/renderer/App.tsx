import { useCallback, useEffect, useRef, useState } from "react";
import Titlebar from "./shell/Titlebar";
import Sidebar from "./shell/Sidebar";
import LibraryView from "./views/LibraryView";
import SettingsView from "./views/SettingsView";
import VideoPlayer from "./player/VideoPlayer";
import { useClips } from "./library/useClips";
import { useLibraryFilter } from "./library/useLibraryFilter";
import type { Route } from "./routes";

const PIN_KEY = "clip-library:rail-pinned";
const DYNAMIC_KEY = "clip-library:rail-dynamic";
const COLLAPSED_KEY = "clip-library:rail-collapsed";

const readBool = (key: string) => localStorage.getItem(key) === "1";
const writeBool = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
};

export default function App() {
  const [route, setRoute] = useState<Route>("library");
  const lib = useClips();
  const filter = useLibraryFilter(lib.clips);
  const readySent = useRef(false);

  // Rail mode. Two axes: `pinned` picks what the titlebar button toggles —
  //   unpinned → button toggles `dynamic` (auto-collapse, hover to expand);
  //   pinned   → button toggles `collapsed` (static width, no hover).
  // Yields three modes: static-expanded, dynamic-hover, static-collapsed.
  const [pinned, setPinned] = useState(() => readBool(PIN_KEY));
  const [dynamic, setDynamic] = useState(() => readBool(DYNAMIC_KEY));
  const [collapsed, setCollapsed] = useState(() => readBool(COLLAPSED_KEY));

  const railDynamic = !pinned && dynamic;
  const railCollapsed = pinned && collapsed;

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      writeBool(PIN_KEY, next);
      return next;
    });
  }, []);

  const toggleWidth = useCallback(() => {
    if (pinned) {
      setCollapsed((prev) => {
        const next = !prev;
        writeBool(COLLAPSED_KEY, next);
        return next;
      });
    } else {
      setDynamic((prev) => {
        const next = !prev;
        writeBool(DYNAMIC_KEY, next);
        return next;
      });
    }
  }, [pinned]);

  // Game-icon greyscale (settings; defaults on to match the design).
  const [grayscaleIcons, setGrayscaleIcons] = useState(true);
  useEffect(() => {
    window.clips
      .getSettings()
      .then((s) => setGrayscaleIcons(s?.iconGreyscale ?? true))
      .catch(() => {});
  }, []);

  // Escape exits an active tag focus ("only show this tag") — but not while the
  // player is open, where Escape closes the player (handled by its own
  // keybindings, bound on document only while a clip is open).
  const isTemporary = filter.tags.isTemporary;
  const clearFocus = filter.clearFocus;
  useEffect(() => {
    if (!isTemporary) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const overlay = document.getElementById("player-overlay");
      if (overlay && overlay.style.display !== "none") return;
      clearFocus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isTemporary, clearFocus]);

  // Dismiss the splash once the first clip load resolves.
  useEffect(() => {
    if (!lib.loading && !readySent.current) {
      readySent.current = true;
      window.clips?.rendererReady();
    }
  }, [lib.loading]);

  return (
    <div className="app-shell">
      <Titlebar
        pinned={pinned}
        dynamic={railDynamic}
        collapsed={railCollapsed}
        onToggleWidth={toggleWidth}
        onTogglePin={togglePin}
      />
      <div className={`app-body${railDynamic ? " rail-floating" : ""}`}>
        <Sidebar
          route={route}
          onNavigate={setRoute}
          clips={lib.clips}
          filter={filter}
          dynamic={railDynamic}
          collapsed={railCollapsed}
        />
        <main className="app-main">
          {route === "library" ? (
            <LibraryView lib={lib} clips={filter.filteredClips} grayscaleIcons={grayscaleIcons} />
          ) : null}
          {route === "settings" ? <SettingsView /> : null}
        </main>
      </div>
      {/* Wrapped legacy player overlay (fixed; hidden until a clip is opened).
          Fed the *filtered* list so prev/next walks the same clips the grid
          shows (respecting the active search / tag focus), not the full library. */}
      <VideoPlayer
        clipLocation={lib.clipLocation}
        clips={filter.filteredClips}
        renameClip={lib.renameClip}
        removeClips={lib.removeClips}
      />
    </div>
  );
}
