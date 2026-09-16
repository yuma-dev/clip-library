import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupClips, type ClipGroupData } from "./grouping";
import ClipGroup, { type GridLayoutHint } from "./ClipGroup";
import { ObserveContext, type ObserveFn } from "./visibility";
import { isBootHeld, onBootRelease } from "../boot/bootHold";
import { trackPointer, rehoverUnderPointer } from "./rehover";
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
  // Columns + row height of the grid, for content-visibility-skipped groups'
  // intrinsic size. Measured after mount and on resize.
  const [layoutHint, setLayoutHint] = useState<GridLayoutHint | null>(null);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const content = grid.querySelector<HTMLElement>(".clip-group-content");
      const card = content?.querySelector<HTMLElement>(".clip-item");
      if (!content || !card) return;
      const cols = getComputedStyle(content).gridTemplateColumns.split(" ").filter(Boolean).length;
      const gap = parseFloat(getComputedStyle(content).rowGap) || 16;
      const rowH = card.offsetHeight + gap;
      if (cols > 0 && rowH > 0) {
        setLayoutHint((prev) => (prev && prev.cols === cols && prev.rowH === rowH ? prev : { cols, rowH }));
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(grid);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const toast = useToast();

  // Shared visibility observer, created lazily on first observe. Boot intro
  // holds entries rather than dropping them (a lost first report would leave
  // cards un-culled all session: 1,000 painted offscreen cards cost 47ms compositing, 79ms scroll frames).
  const pendingCullRef = useRef<Map<HTMLElement, boolean>>(new Map());
  const observe = useCallback<ObserveFn>((el) => {
    if (!observerRef.current) {
      const apply = (target: HTMLElement, offscreen: boolean) => target.classList.toggle("cv-offscreen", offscreen);
      observerRef.current = new IntersectionObserver(
        (entries) => {
          if (isBootHeld()) {
            for (const entry of entries) pendingCullRef.current.set(entry.target as HTMLElement, !entry.isIntersecting);
            onBootRelease(() => {
              // A thousand toggles in one frame were a 130 ms frame right
              // after the intro; a slice per frame keeps it invisible.
              const pending = [...pendingCullRef.current];
              pendingCullRef.current = new Map();
              const step = () => {
                for (const [target, offscreen] of pending.splice(0, 120)) apply(target, offscreen);
                if (pending.length) requestAnimationFrame(step);
              };
              step();
            });
            return;
          }
          for (const entry of entries) apply(entry.target as HTMLElement, !entry.isIntersecting);
        },
        // Three screens of lead: at 12,000px/s wheel speed, rows un-cull a
        // dozen frames before showing so layout/paint don't land on the frame they appear in.
        { root: scrollRef.current, rootMargin: "3000px 0px" },
      );
    }
    observerRef.current.observe(el);
    return () => {
      observerRef.current?.unobserve(el);
      pendingCullRef.current.delete(el as HTMLElement);
    };
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

  // No hover while scrolling: :hover's transform+shadow promote a layer per
  // card, re-running compositing (47ms/card, 79ms scroll frames). Pointer events are off during
  // scroll, back 120ms after the last event.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    trackPointer();
    let timer = 0;
    let active = false;
    const stop = () => {
      timer = 0;
      active = false;
      scroller.classList.remove("is-scrolling");
      rehoverUnderPointer();
    };
    const bump = () => {
      if (!active) {
        active = true;
        scroller.classList.add("is-scrolling");
        hover?.leave();
      }
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(stop, 120);
    };
    scroller.addEventListener("scroll", bump, { passive: true });
    scroller.addEventListener("wheel", bump, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", bump);
      scroller.removeEventListener("wheel", bump);
      if (timer) window.clearTimeout(timer);
      scroller.classList.remove("is-scrolling");
    };
  }, [hover]);
  useEffect(() => {
    hover?.setPreviewVolume(previewVolume);
  }, [hover, previewVolume]);
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  // Selection: imperative class toggles, no re-render.
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
          // Range comes from DATA, not the DOM: streaming-in cards aren't
          // mounted yet and would be silently skipped; unmounted ones pick up selection on mount (ClipCard).
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
        // Right-click inside a multi-selection targets it all (bulk menu); any other card targets
        // just itself.
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

  // Stabilize: groupClips builds fresh arrays every run even if unchanged;
  // reuse the previous group object when clips are ref-identical so memo(ClipGroup) skips it.
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

  // Stream the groups too: mounting all ~25 at once is still a ~600-card
  // commit (700ms first frame, 2026-07-08 trace); a few fill the viewport, rest stream in below the fold.
  const shownGroups = useStreamedSlice(groups, true, { initial: 2, perFrame: 3 }) ?? groups;

  // Display-ordered names across expanded groups, source of truth for
  // shift-click ranges; kept in a ref so selectionApi/context stay stable.
  const orderedNamesRef = useRef<string[]>([]);
  useEffect(() => {
    orderedNamesRef.current = groups
      .filter((g) => !collapsed[g.name])
      .flatMap((g) => g.clips.map((c) => c.originalName));
  }, [groups, collapsed]);

  // Header updates urgently for instant click feedback; ClipGroup defers the
  // card mount. Persist outside the updater, off the click's critical path.
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
                    layoutHint={layoutHint}
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
