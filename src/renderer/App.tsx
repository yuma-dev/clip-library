import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "./settings/SettingsContext";
import Titlebar from "./shell/Titlebar";
import Sidebar from "./shell/Sidebar";
import LibraryView from "./views/LibraryView";
import SettingsView from "./views/SettingsView";
import FeedPage from "./feed/FeedPage";
import FeedPlayer from "./feed/FeedPlayer";
import ProfilePage from "./feed/ProfilePage";
import { AppNavContext, type AppNav } from "./shell/appNav";
import { useProfile } from "./shell/useProfile";
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
  // Profile overlay (rendered over the routed view when set). Navigating via
  // the sidebar clears it (see `navigate`). Wired to deep children via AppNav.
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const navigate = useCallback((next: Route) => {
    setProfileUserId(null);
    setRoute(next);
  }, []);
  const appNav = useMemo<AppNav>(
    () => ({
      openProfile: (userId: string) => setProfileUserId(userId),
      closeProfile: () => setProfileUserId(null),
      openLibrary: () => {
        setProfileUserId(null);
        setRoute("library");
      },
    }),
    [],
  );
  const lib = useClips();
  const filter = useLibraryFilter(lib.clips);
  const readySent = useRef(false);

  // Keep-alive for the heavy routed views: once visited, library/feed stay
  // mounted (hidden via .route-host) so switching back is a style flip instead
  // of a full remount — rail-item switches cost 585-930ms in the 2026-07-08
  // trace, almost all of it re-mounting the target view's grid.
  const visitedRoutes = useRef({ library: false, feed: false });
  if (route === "library") visitedRoutes.current.library = true;
  if (route === "feed") visitedRoutes.current.feed = true;

  // Warm the online data shortly after launch, off the startup path: the
  // registered-user map (grid popovers), own account, and the default feed
  // page — so Feed/popovers open instantly instead of waiting ~1s each.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void import("./library/shareIdentity").then((m) => m.loadShareUsers());
      void import("./feed/me").then((m) => m.fetchMe());
      void Promise.all([
        import("./feed/useFeedClips"),
        import("./feed/feedFilters"),
      ]).then(([hook, ff]) =>
        hook.prefetchFeedList(ff.getFeedFilters(), ff.feedPersistKey()),
      );
    }, 1500);
    return () => window.clearTimeout(timer);
  }, []);

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

  // Logging out closes online-only surfaces: the feed route falls back to the
  // library and any open profile page closes (both need authentication).
  const profile = useProfile();
  const loggedOut = !profile.connected && !profile.verifying;
  useEffect(() => {
    if (!loggedOut) return;
    setProfileUserId(null);
    // Also drop the kept-alive feed — a cached feed must not stay browsable
    // (or even mounted) once the user is logged out.
    visitedRoutes.current.feed = false;
    setRoute((prev) => (prev === "feed" ? "library" : prev));
  }, [loggedOut]);

  // Live app settings (grid appearance + preview volume come from here so
  // changes in the Settings view apply immediately).
  const { settings } = useSettings();
  const grayscaleIcons = Boolean(settings.iconGreyscale);
  const showNewIndicators = settings.showNewClipsIndicators !== false;
  const previewVolume = settings.previewVolume ?? 0.1;

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
    <AppNavContext.Provider value={appNav}>
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
          onNavigate={navigate}
          clips={lib.clips}
          filter={filter}
          dynamic={railDynamic}
          collapsed={railCollapsed}
        />
        <main className="app-main">
          {/* Profile overlay takes precedence over the routed view. The routed
              view stays MOUNTED (display:none via .route-host) so closing the
              profile doesn't remount the feed/library — remounting re-ran the
              feed's fetch + mounted every card in one commit (855ms freeze on
              profile-back in the 2026-07-08 trace). */}
          {profileUserId ? <ProfilePage userId={profileUserId} /> : null}
          <div className={`route-host${profileUserId || route !== "library" ? " hidden" : ""}`}>
            {visitedRoutes.current.library ? (
              <LibraryView
                lib={lib}
                clips={filter.filteredClips}
                grayscaleIcons={grayscaleIcons}
                showNewIndicators={showNewIndicators}
                previewVolume={previewVolume}
                globalTags={filter.globalTags}
                addGlobalTag={filter.addGlobalTag}
              />
            ) : null}
          </div>
          <div className={`route-host${profileUserId || route !== "feed" ? " hidden" : ""}`}>
            {visitedRoutes.current.feed ? <FeedPage /> : null}
          </div>
          <div className={`route-host${profileUserId || route !== "settings" ? " hidden" : ""}`}>
            {route === "settings" ? <SettingsView lib={lib} filter={filter} /> : null}
          </div>
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
        markClipsWatched={lib.markClipsWatched}
      />
      {/* Feed player mounts once app-wide so any grid (feed route, profile
          overlay) can open remote clips through the feedPlayerBus. */}
      <FeedPlayer />
    </div>
    </AppNavContext.Provider>
  );
}
