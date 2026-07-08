import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupClips, type ClipGroupData } from "./grouping";
import ClipGroup from "./ClipGroup";
import { ObserveContext, type ObserveFn } from "./visibility";
import { ClipGlow } from "./ClipGlow";
import { LibraryHover } from "./hoverController";
import { HoverContext } from "./hoverContext";
import { SelectionContext, type SelectionApi } from "./selectionContext";
import { RenameContext, type RenameFn } from "./renameContext";
import ContextMenuHost, { type ContextMenuHandle } from "./ContextMenuHost";
import { useToast } from "../ui/Toast";
import { useStreamedSlice } from "../ui/useStreamedSlice";
import type { LocalClip } from "./types";

interface ClipGridProps {
  clips: LocalClip[];
  thumbnails: Map<string, string | null>;
  grayscaleIcons: boolean;
  showNewIndicators: boolean;
  previewVolume: number;
  clipLocation: string;
  removeClips: (names: string[]) => void;
  renameClip: RenameFn;
  setClipTags: (originalName: string, tags: string[]) => void;
  globalTags: string[];
  addGlobalTag: (tag: string) => void;
}

const COLLAPSE_KEY = "clip-library:collapsed-groups";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function ClipGrid({
  clips,
  thumbnails,
  grayscaleIcons,
  showNewIndicators,
  previewVolume,
  clipLocation,
  removeClips,
  renameClip,
  setClipTags,
  globalTags,
  addGlobalTag,
}: ClipGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const glowCanvasRef = useRef<HTMLCanvasElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const selectedRef = useRef<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  // Live clip list for the context menu (selectionApi is memoized without it).
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const menuHostRef = useRef<ContextMenuHandle>(null);
  const [hover, setHover] = useState<LibraryHover | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const toast = useToast();

  // Shared visibility observer (hard-won §4.2), created lazily on first observe.
  const observe = useCallback<ObserveFn>((el) => {
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            (entry.target as HTMLElement).classList.toggle("cv-offscreen", !entry.isIntersecting);
          }
        },
        { root: scrollRef.current, rootMargin: "600px 0px" },
      );
    }
    observerRef.current.observe(el);
    return () => observerRef.current?.unobserve(el);
  }, []);

  // Glow + hover-preview controllers.
  useEffect(() => {
    if (!gridRef.current || !glowCanvasRef.current) return;
    const glow = new ClipGlow(glowCanvasRef.current, gridRef.current);
    const controller = new LibraryHover(glow, clipLocation);
    setHover(controller);
    return () => controller.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    hover?.setClipLocation(clipLocation);
  }, [hover, clipLocation]);
  useEffect(() => {
    hover?.setPreviewVolume(previewVolume);
  }, [hover, previewVolume]);
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  // --- Selection (imperative — class toggles, no re-render) ---
  const clearSelection = useCallback(() => {
    gridRef.current?.querySelectorAll(".clip-item.selected").forEach((el) => el.classList.remove("selected"));
    selectedRef.current.clear();
    anchorRef.current = null;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection]);

  const selectionApi = useMemo<SelectionApi>(
    () => ({
      isSelected: (name) => selectedRef.current.has(name),
      onCardClick: (e, clip) => {
        const el = e.currentTarget as HTMLElement;
        const name = clip.originalName;
        if (e.ctrlKey || e.metaKey) {
          if (selectedRef.current.has(name)) {
            selectedRef.current.delete(name);
            el.classList.remove("selected");
          } else {
            selectedRef.current.add(name);
            el.classList.add("selected");
            anchorRef.current = name;
          }
        } else if (e.shiftKey) {
          const grid = gridRef.current;
          if (!grid) return;
          // Range comes from DATA (all clips in expanded groups, in display
          // order), not from the DOM — cards still streaming in aren't mounted
          // yet, and a DOM-derived range would silently skip them. Mounted
          // cards get their class toggled here; not-yet-mounted ones pick it
          // up from selectedRef when they mount (ClipCard mount effect).
          const names = orderedNamesRef.current;
          const to = names.indexOf(name);
          const from = anchorRef.current ? names.indexOf(anchorRef.current) : to;
          grid.querySelectorAll(".clip-item.selected").forEach((n) => n.classList.remove("selected"));
          selectedRef.current.clear();
          if (to >= 0 && from >= 0) {
            const [s, en] = from <= to ? [from, to] : [to, from];
            for (let i = s; i <= en; i++) selectedRef.current.add(names[i]);
            grid.querySelectorAll<HTMLElement>(".clip-item").forEach((n) => {
              if (selectedRef.current.has(n.dataset.originalName ?? "")) n.classList.add("selected");
            });
          } else {
            el.classList.add("selected");
            selectedRef.current.add(name);
          }
          if (!anchorRef.current) anchorRef.current = name;
        } else if (selectedRef.current.size > 0) {
          clearSelection();
        } else if (window.legacyPlayer) {
          void window.legacyPlayer.openClip(clip.originalName, clip.customName);
        } else {
          toast.show("Player is still loading…");
        }
      },
      onCardContextMenu: (e, clip) => {
        e.preventDefault();
        // Right-clicking inside a multi-selection targets the whole selection
        // (bulk menu); right-clicking any other card targets just that card.
        const sel = selectedRef.current;
        const selection =
          sel.size > 1 && sel.has(clip.originalName)
            ? clipsRef.current.filter((c) => sel.has(c.originalName))
            : undefined;
        menuHostRef.current?.open(e.clientX, e.clientY, clip, selection);
      },
    }),
    [clearSelection, toast],
  );

  const handleDeleted = useCallback(
    (name: string) => {
      selectedRef.current.delete(name);
      removeClips([name]);
    },
    [removeClips],
  );

  // Group, then stabilize: filterClips/groupClips build fresh arrays on every
  // filter run even when a group's membership didn't change. Reusing the
  // previous group object when its clips are ref-identical lets memo(ClipGroup)
  // skip untouched groups entirely, and gives ClipGroup's mount-streaming a
  // meaningful "did this group actually change?" identity signal.
  const prevGroupsRef = useRef<Map<string, ClipGroupData>>(new Map());
  const groups = useMemo(() => {
    const fresh = groupClips(clips, Date.now());
    const prev = prevGroupsRef.current;
    return fresh.map((g) => {
      const old = prev.get(g.name);
      if (
        old &&
        old.clips.length === g.clips.length &&
        old.clips.every((c, i) => c === g.clips[i])
      ) {
        return old;
      }
      return g;
    });
  }, [clips]);
  // Commit-phase write: a concurrent render that gets discarded must not
  // poison the identity baseline the next render stabilizes against.
  useEffect(() => {
    prevGroupsRef.current = new Map(groups.map((g) => [g.name, g]));
  }, [groups]);

  // Stream the GROUPS too: every expanded group mounts 24 cards in the commit
  // it appears in, so mounting all ~25 groups at once is still a ~600-card
  // commit (the 700ms first frame in the 2026-07-08 startup trace). A few
  // groups fill the viewport; the rest stream in below the fold.
  const shownGroups = useStreamedSlice(groups, true, { initial: 4, perFrame: 3 }) ?? groups;

  // Display-ordered clip names across expanded groups — the source of truth
  // for shift-click ranges (kept in a ref so selectionApi stays stable and
  // SelectionContext consumers don't re-render on filter changes).
  const orderedNamesRef = useRef<string[]>([]);
  useEffect(() => {
    orderedNamesRef.current = groups
      .filter((g) => !collapsed[g.name])
      .flatMap((g) => g.clips.map((c) => c.originalName));
  }, [groups, collapsed]);

  // The header (diamond, aria-expanded) updates urgently for instant click
  // feedback; ClipGroup defers the expensive card mount itself. Persist
  // outside the updater (and off the click's critical path).
  const toggle = useCallback((name: string) => {
    setCollapsed((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  return (
    <ObserveContext.Provider value={observe}>
      <HoverContext.Provider value={hover}>
        <RenameContext.Provider value={renameClip}>
          <SelectionContext.Provider value={selectionApi}>
            <div className="clip-scroll" ref={scrollRef}>
              <div className="clip-grid" ref={gridRef}>
                <div className="clip-glow-wrap" aria-hidden="true">
                  <canvas className="clip-glow-canvas" ref={glowCanvasRef} width={16} height={9} />
                </div>
                {shownGroups.map((group) => (
                  <ClipGroup
                    key={group.name}
                    group={group}
                    thumbnails={thumbnails}
                    grayscaleIcons={grayscaleIcons}
                    showNewIndicators={showNewIndicators}
                    collapsed={Boolean(collapsed[group.name])}
                    onToggle={toggle}
                  />
                ))}
                {groups.length === 0 ? (
                  <div className="clip-empty">
                    <span className="clip-empty-mark dia" aria-hidden="true">
                      ◇
                    </span>
                    <p className="clip-empty-title">No clips match</p>
                    <p className="clip-empty-sub">Try a different search or clear your tag filters.</p>
                  </div>
                ) : null}
              </div>
            </div>
            <ContextMenuHost
              ref={menuHostRef}
              onDeleted={handleDeleted}
              setClipTags={setClipTags}
              globalTags={globalTags}
              addGlobalTag={addGlobalTag}
            />
          </SelectionContext.Provider>
        </RenameContext.Provider>
      </HoverContext.Provider>
    </ObserveContext.Provider>
  );
}

export default memo(ClipGrid);
