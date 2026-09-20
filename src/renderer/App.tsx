import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "./settings/SettingsContext";
import Titlebar from "./shell/Titlebar";
import Sidebar from "./shell/Sidebar";
import LibraryView from "./views/LibraryView";
import FeedPlayer from "./feed/FeedPlayer";
import { AppNavContext, type AppNav } from "./shell/appNav";
import { useToast } from "./ui/Toast";
import { useProfile } from "./shell/useProfile";
import VideoPlayer from "./player/VideoPlayer";
import OnboardingGate from "./onboarding/OnboardingGate";
import AnalysisIntro from "./onboarding/AnalysisIntro";
import { useClips } from "./library/useClips";
import { useLibraryFilter } from "./library/useLibraryFilter";
import { installDebugTools } from "./shell/debugTools";
import { reportMetric, setTelemetryRoute } from "./telemetry";
import { bootMark } from "./perf/bootMarks";
import { installBootReveal, prepareBootReveal } from "./boot/bootReveal";
import type { Route } from "./routes";
import { setBenchmarkContext } from "./benchmark/context";

// Surfaces that are not on screen at launch load as their own chunks, so the
// boot bundle is the library and its shell only.
const SettingsView = lazy(() => import("./views/SettingsView"));
const FeedPage = lazy(() => import("./feed/FeedPage"));
const ProfilePage = lazy(() => import("./feed/ProfilePage"));

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
  // profile overlay, over the routed view when set; navigate() clears it, wired to children via AppNav
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  // read by navigate without recreating it each route change (its identity is a sidebar prop)
  const routeRef = useRef(route);
  routeRef.current = route;
  // Open rail switch, closed by the effect below once the new view has painted.
  const switchRef = useRef<{ from: Route; to: Route; startedAt: number } | null>(null);
  const navigate = useCallback((next: Route) => {
    const from = routeRef.current;
    if (from !== next) switchRef.current = { from, to: next, startedAt: performance.now() };
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
      openSettings: (section?: string) => {
        setProfileUserId(null);
        setRoute("settings");
        setSettingsIntent({ section, nonce: Date.now() });
      },
    }),
    [],
  );
  const lib = useClips();
  const filter = useLibraryFilter(lib.clips);
  const readySent = useRef(false);

  // current-state bridge for the benchmark runtime; getters avoid stale first-render snapshots
  setBenchmarkContext({
    getClips: () => lib.clips,
    getFilteredClips: () => filter.filteredClips,
    isLoading: () => lib.loading,
    getQuery: () => filter.query,
    setQuery: filter.setQuery,
  });

  // post-silent-update confirmation (Updated to vX): main fires once the running
  // version matches the update marker it wrote before restarting into the installer
  const toast = useToast();
  useEffect(() => {
    const unsubscribe = window.clips?.onAppUpdated?.((payload: { version?: string }) => {
      if (payload?.version) toast.show(`Updated to v${payload.version}`);
    });
    return unsubscribe;
  }, [toast]);

  // deep links from main (cliplib://settings/<section>, e.g. tray icon opening
  // Settings to Clipdip); nonce re-applies the section even on repeat clicks
  const [settingsIntent, setSettingsIntent] = useState<{ section?: string; nonce: number } | null>(null);
  useEffect(() => {
    const unsubscribe = window.clips?.onCliplibNavigate?.((payload: { view?: string; section?: string }) => {
      if (payload?.view !== "settings") return;
      setProfileUserId(null);
      setRoute("settings");
      setSettingsIntent({ section: payload.section, nonce: Date.now() });
    });
    return unsubscribe;
  }, []);

  // keep-alive: once visited, library/feed stay mounted (.route-host hidden) so
  // switching is a style flip; remounting cost 585-930ms in the 2026-07-08 trace
  const visitedRoutes = useRef({ library: false, feed: false });
  if (route === "library") visitedRoutes.current.library = true;
  if (route === "feed") visitedRoutes.current.feed = true;

  // Tag every telemetry event with the route the user was on.
  useEffect(() => setTelemetryRoute(route), [route]);

  // double rAF samples after paint, covering first-mount cost, not just the React commit
  useEffect(() => {
    const pending = switchRef.current;
    if (!pending || pending.to !== route) return;
    switchRef.current = null;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        reportMetric("ui.route_switch_ms", Math.round(performance.now() - pending.startedAt), {
          unit: "ms",
          dims: { from: pending.from, to: pending.to },
        });
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [route]);

  // warm online data off the startup path (user map, own account, default feed
  // page) so Feed/popovers open instantly instead of ~1s each
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

  // rail mode: pinned picks what the button toggles (unpinned: dynamic, auto-collapse
  // + hover; pinned: collapsed, static width), giving 3 modes total
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

  // logging out closes online-only surfaces: feed falls back to library, open profile closes
  const profile = useProfile();
  const loggedOut = !profile.connected && !profile.verifying;
  useEffect(() => {
    if (!loggedOut) return;
    setProfileUserId(null);
    // drop the kept-alive feed too, it can't stay browsable once logged out
    visitedRoutes.current.feed = false;
    setRoute((prev) => (prev === "feed" ? "library" : prev));
  }, [loggedOut]);

  // live settings, so grid appearance + preview volume changes apply immediately
  const { settings } = useSettings();
  const grayscaleIcons = Boolean(settings.iconGreyscale);
  const showNewIndicators = settings.showNewClipsIndicators !== false;
  const previewVolume = settings.previewVolume ?? 0.1;

  // Escape exits a temporary tag focus, unless the player is open (its own keybindings close it)
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

  // once the grid + visible thumbnails are ready, tell main to reveal after the
  // compositor frames this; undecoded thumbnails cost 100s of ms of GPU work, else Windows shows white
  useEffect(() => {
    if (lib.loading || readySent.current) return;
    readySent.current = true;
    let cancelled = false;
    (async () => {
      bootMark('reveal_gate_start');
      // img.decode() only settles on a render opportunity a hidden doc rarely gets; poll instead
      const loaded = () => {
        const imgs = [...document.querySelectorAll<HTMLImageElement>('.clip-item img')].slice(0, 24);
        const real = imgs.filter((img) => img.src.includes('thumbnail-cache'));
        return real.length === 0 || real.every((img) => img.complete && img.naturalWidth > 0);
      };
      const deadline = performance.now() + 250;
      while (!cancelled && !loaded() && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
      bootMark('reveal_gate_decoded');
      // streaming mounts a chunk per frame; wait briefly for the first viewport to fill
      const scroller = document.querySelector<HTMLElement>('.clip-scroll');
      const filled = () => !scroller || scroller.scrollHeight >= scroller.clientHeight + 120;
      // timer, not rAF: a never-shown window's rAF only fires once the compositor frames it
      const fillDeadline = performance.now() + 250;
      while (!cancelled && !filled() && performance.now() < fillDeadline) {
        await new Promise((r) => setTimeout(r, 16));
      }
      if (cancelled) return;
      bootMark('reveal_gate_filled');
      // quiet the main thread and promote the cards the animation will move
      // before the compositor frames the grid, so their textures already exist
      await prepareBootReveal();
      if (cancelled) return;
      window.clips?.rendererReady();
    })();
    return () => {
      cancelled = true;
    };
  }, [lib.loading]);

  // prefetch lazy route chunks (local files) once the library is up, so first visit isn't empty
  useEffect(() => {
    if (lib.loading) return;
    const timer = window.setTimeout(() => {
      void import("./views/SettingsView");
      void import("./feed/FeedPage");
      void import("./feed/ProfilePage");
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [lib.loading]);

  // Debug hooks: window.loadingScreenTest + Ctrl/Cmd+Shift+L, and the F6 egg.
  useEffect(() => installDebugTools(), []);
  useEffect(() => installBootReveal(), []);

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
          /* an open profile page lights up the Feed nav item too, since profiles are reached from feed */
          activeRoute={profileUserId ? "feed" : route}
          onNavigate={navigate}
          clips={lib.clips}
          filter={filter}
          dynamic={railDynamic}
          collapsed={railCollapsed}
        />
        <main className="app-main">
          {/* profile overlay stays over the routed view, which stays MOUNTED (.route-host
              hidden) so closing it doesn't remount feed/library (855ms freeze in the 2026-07-08 trace) */}
          {profileUserId ? (
            <Suspense fallback={null}>
              <ProfilePage userId={profileUserId} />
            </Suspense>
          ) : null}
          <div className={`route-host${profileUserId || route !== "library" ? " hidden" : ""}`}>
            {visitedRoutes.current.library ? (
              <LibraryView
                lib={lib}
                clips={filter.filteredClips}
                shuffled={filter.shuffled}
                grayscaleIcons={grayscaleIcons}
                showNewIndicators={showNewIndicators}
                previewVolume={previewVolume}
                globalTags={filter.globalTags}
                addGlobalTag={filter.addGlobalTag}
              />
            ) : null}
          </div>
          <div className={`route-host${profileUserId || route !== "feed" ? " hidden" : ""}`}>
            {visitedRoutes.current.feed ? (
              <Suspense fallback={null}>
                <FeedPage />
              </Suspense>
            ) : null}
          </div>
          <div className={`route-host${profileUserId || route !== "settings" ? " hidden" : ""}`}>
            {route === "settings" ? (
              <Suspense fallback={null}>
                <SettingsView lib={lib} filter={filter} intent={settingsIntent} />
              </Suspense>
            ) : null}
          </div>
        </main>
      </div>
      {/* legacy player overlay, fed the *filtered* list so prev/next matches the grid's search/tag focus */}
      <VideoPlayer
        clipLocation={lib.clipLocation}
        clips={filter.filteredClips}
        renameClip={lib.renameClip}
        removeClips={lib.removeClips}
        markClipsWatched={lib.markClipsWatched}
      />
      {/* feed player mounts app-wide so any grid can open remote clips via feedPlayerBus */}
      <FeedPlayer />
      {/* one-time 3.0 intro + ClipDip setup; wizard chunk loads only when opened, reopenable via __showOnboarding() */}
      <OnboardingGate />
      {/* the analysis heads-up for anyone past the tour; shows once when the library listen starts */}
      <AnalysisIntro />
    </div>
    </AppNavContext.Provider>
  );
}
