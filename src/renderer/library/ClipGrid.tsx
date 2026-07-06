import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupClips } from "./grouping";
import ClipGroup from "./ClipGroup";
import { ObserveContext, type ObserveFn } from "./visibility";
import { ClipGlow } from "./ClipGlow";
import { LibraryHover } from "./hoverController";
import { HoverContext } from "./hoverContext";
import { SelectionContext, type SelectionApi } from "./selectionContext";
import { RenameContext, type RenameFn } from "./renameContext";
import ContextMenuHost, { type ContextMenuHandle } from "./ContextMenuHost";
import { useToast } from "../ui/Toast";
import type { LocalClip } from "./types";

interface ClipGridProps {
  clips: LocalClip[];
  thumbnails: Map<string, string | null>;
  grayscaleIcons: boolean;
  clipLocation: string;
  removeClips: (names: string[]) => void;
  renameClip: RenameFn;
}

const COLLAPSE_KEY = "clip-library:collapsed-groups";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export default function ClipGrid({
  clips,
  thumbnails,
  grayscaleIcons,
  clipLocation,
  removeClips,
  renameClip,
}: ClipGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const glowCanvasRef = useRef<HTMLCanvasElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const selectedRef = useRef<Set<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
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
          const nodes = Array.from(grid.querySelectorAll<HTMLElement>(".clip-item"));
          const names = nodes.map((n) => n.dataset.originalName ?? "");
          const to = names.indexOf(name);
          const from = anchorRef.current ? names.indexOf(anchorRef.current) : to;
          grid.querySelectorAll(".clip-item.selected").forEach((n) => n.classList.remove("selected"));
          selectedRef.current.clear();
          if (to >= 0 && from >= 0) {
            const [s, en] = from <= to ? [from, to] : [to, from];
            for (let i = s; i <= en; i++) {
              nodes[i].classList.add("selected");
              selectedRef.current.add(names[i]);
            }
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
        menuHostRef.current?.open(e.clientX, e.clientY, clip);
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

  const groups = useMemo(() => groupClips(clips, Date.now()), [clips]);

  const toggle = useCallback((name: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [name]: !prev[name] };
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <ObserveContext.Provider value={observe}>
      <HoverContext.Provider value={hover}>
        <RenameContext.Provider value={renameClip}>
          <SelectionContext.Provider value={selectionApi}>
            <div className="clip-scroll" ref={scrollRef}>
              <div className="clip-grid" ref={gridRef}>
                <canvas className="clip-glow-canvas" ref={glowCanvasRef} width={16} height={9} aria-hidden="true" />
                {groups.map((group) => (
                  <ClipGroup
                    key={group.name}
                    group={group}
                    thumbnails={thumbnails}
                    grayscaleIcons={grayscaleIcons}
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
            <ContextMenuHost ref={menuHostRef} onDeleted={handleDeleted} />
          </SelectionContext.Provider>
        </RenameContext.Provider>
      </HoverContext.Provider>
    </ObserveContext.Provider>
  );
}
