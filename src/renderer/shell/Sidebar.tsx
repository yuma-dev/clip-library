import { memo, useCallback, useMemo, useState } from "react";
import { CircleDashed, Layers, Scissors, Sparkles } from "lucide-react";
import { routes, type Route } from "../routes";
import { useToast } from "../ui/Toast";
import { useProfile } from "./useProfile";
import { useClipsFolderSize, formatBytes } from "./useClipsFolderSize";
import RailTags from "./RailTags";
import RailProfile from "./RailProfile";
import RailSearch from "./RailSearch";
import UpdatePill from "./UpdatePill";
import FeedRailFilters from "../feed/FeedRailFilters";
import type { UseLibraryFilter } from "../library/useLibraryFilter";
import type { Collection } from "../library/filter";
import type { LocalClip } from "../library/types";

interface SidebarProps {
  route: Route;
  /** Nav highlight target — differs from `route` when an online overlay (a
   *  profile page) is open, so the Feed item stays active over any route. */
  activeRoute: Route;
  onNavigate: (route: Route) => void;
  clips: LocalClip[];
  filter: UseLibraryFilter;
  /** Dynamic (hover-to-expand) rail. */
  dynamic: boolean;
  /** Statically collapsed rail (no hover-expand). */
  collapsed: boolean;
}

const COLLECTIONS: { id: Collection; label: string; icon: typeof Layers }[] = [
  { id: "all", label: "All clips", icon: Layers },
  { id: "new", label: "New", icon: Sparkles },
  { id: "untagged", label: "Untagged", icon: CircleDashed },
  { id: "trimmed", label: "Trimmed", icon: Scissors },
];

const WEEK_MS = 7 * 86_400_000;

// Nav rail — 300px primary surface (design handoff): merged logo+search, nav,
// scrollable collections + tag filter, stat cards, real profile card.
function Sidebar({
  route,
  activeRoute,
  onNavigate,
  clips,
  filter,
  dynamic,
  collapsed,
}: SidebarProps) {
  const toast = useToast();
  // Feed requires a ClipLib login — the nav item locks while logged out.
  const { connected, verifying } = useProfile();
  const feedLocked = !connected && !verifying;

  const counts = useMemo(() => {
    const now = Date.now();
    let week = 0;
    let untagged = 0;
    let trimmed = 0;
    let isNew = 0;
    for (const c of clips) {
      if (now - c.createdAt <= WEEK_MS) week++;
      if (c.tags.length === 0) untagged++;
      if (c.isTrimmed) trimmed++;
      if (c.isNewSinceLastSession) isNew++;
    }
    return { total: clips.length, week, untagged, trimmed, isNew };
  }, [clips]);

  // Clip-folder disk usage — lazily fetched, refreshed slowly, nothing depends on it.
  const folderBytes = useClipsFolderSize();

  // Collapsed-rail hover title — flies out to the right, over the grid. The
  // rail clips its own overflow, so the tip is rendered as a fixed sibling and
  // positioned from the hovered row's rect (delegated so every row is covered).
  const [tip, setTip] = useState<{ label: string; y: number } | null>(null);
  const onRailOver = useCallback(
    (e: React.MouseEvent) => {
      if (!collapsed) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-rail-tip]");
      if (!el) {
        setTip(null);
        return;
      }
      const label = el.getAttribute("data-rail-tip") ?? "";
      const r = el.getBoundingClientRect();
      const y = r.top + r.height / 2;
      setTip((prev) => (prev && prev.label === label && prev.y === y ? prev : { label, y }));
    },
    [collapsed],
  );

  const collectionCount = (id: Collection) => {
    switch (id) {
      case "new":
        return counts.isNew;
      case "untagged":
        return counts.untagged;
      case "trimmed":
        return counts.trimmed;
      default:
        return counts.total;
    }
  };

  return (
    <>
    <aside
      className={`rail${dynamic ? " dynamic" : ""}${collapsed ? " collapsed" : ""}`}
      onMouseOver={onRailOver}
      onMouseLeave={() => setTip(null)}
    >
      {/* Merged logo → search field (syntax highlighting + #tag/@user autocomplete). */}
      <RailSearch filter={filter} clips={clips} />

      <nav className="rail-nav">
        {routes.map(({ id, label, icon: Icon, disabled }) => {
          const locked = disabled || (id === "feed" && feedLocked);
          const tip = disabled ? `${label} (soon)` : locked ? `${label} (sign in)` : label;
          const active = activeRoute === id;
          return (
            <button
              key={id}
              type="button"
              data-rail-tip={tip}
              className={`rail-item${active ? " active" : ""}${locked ? " soon" : ""}`}
              onClick={() => {
                if (disabled) toast.show(`${label} is coming soon`);
                else if (locked) toast.show("Connect to ClipLib to browse the feed");
                else onNavigate(id);
              }}
            >
              {active ? <span className="rail-item-mark" aria-hidden="true" /> : null}
              <span className="r-ico">
                <Icon size={17} />
              </span>
              <span className="rail-label">{label}</span>
              {id === "library" ? <span className="rail-count-pill r-label">{counts.total}</span> : null}
              {disabled ? <span className="rail-soon r-label">soon</span> : null}
            </button>
          );
        })}
      </nav>

      <div className="rail-divider" />

      {route === "feed" ? (
        /* Feed route: contextual filters replace the library sections. */
        <FeedRailFilters />
      ) : (
        <>
          {/* Collections stay pinned; only the tag list below scrolls. */}
          <div className="rail-section rail-section-fixed">
            <div className="rail-section-head">
              <span className="rail-section-title">Collections</span>
            </div>
            <div className="rail-collections">
              {COLLECTIONS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  data-rail-tip={label}
                  className={`rail-collection${filter.collection === id ? " active" : ""}`}
                  onClick={() => filter.setCollection(id)}
                >
                  <span className="r-ico">
                    <Icon size={15} />
                  </span>
                  <span className="rail-label">{label}</span>
                  <span className="rail-collection-count r-label">{collectionCount(id)}</span>
                </button>
              ))}
            </div>
          </div>

          <RailTags filter={filter} />

          <div className="rail-stats r-extra">
            <div className="rail-stat">
              <div className="rail-stat-figure">{counts.total}</div>
              <div className="rail-stat-label">clips</div>
            </div>
            <div className="rail-stat">
              <div className="rail-stat-figure accent">{counts.week}</div>
              <div className="rail-stat-label">this week</div>
            </div>
            <div className="rail-stat">
              <div className="rail-stat-figure">{folderBytes == null ? "—" : formatBytes(folderBytes)}</div>
              <div className="rail-stat-label">on disk</div>
            </div>
          </div>
        </>
      )}

      {/* App update pill (only rendered while an update is available/in flight). */}
      <UpdatePill />

      <RailProfile />
    </aside>

    {collapsed && tip ? (
      <div className="rail-fly-tip" style={{ top: tip.y }} role="tooltip">
        {tip.label}
      </div>
    ) : null}
    </>
  );
}

export default memo(Sidebar);
