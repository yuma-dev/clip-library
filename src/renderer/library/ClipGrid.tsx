import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupClips } from "./grouping";
import ClipGroup from "./ClipGroup";
import { ObserveContext, type ObserveFn } from "./visibility";
import { ClipGlow } from "./ClipGlow";
import { LibraryHover } from "./hoverController";
import { HoverContext } from "./hoverContext";
import type { LocalClip } from "./types";

interface ClipGridProps {
  clips: LocalClip[];
  thumbnails: Map<string, string | null>;
  clipLocation: string;
}

const COLLAPSE_KEY = "clip-library:collapsed-groups";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export default function ClipGrid({ clips, thumbnails, clipLocation }: ClipGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const glowCanvasRef = useRef<HTMLCanvasElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [hover, setHover] = useState<LibraryHover | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);

  // Shared visibility observer (hard-won §4.2), created lazily on the first
  // observe() call — refs are committed before child effects fire.
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

  // Glow + hover-preview controllers (imperative; the canvas + grid refs are
  // committed before this effect runs).
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
        <div className="clip-scroll" ref={scrollRef}>
          <div className="clip-grid" ref={gridRef}>
            {/* Shared glow canvas — behind the cards, unclipped (plan §Phase 3). */}
            <canvas className="clip-glow-canvas" ref={glowCanvasRef} width={16} height={9} aria-hidden="true" />
            {groups.map((group) => (
              <ClipGroup
                key={group.name}
                group={group}
                thumbnails={thumbnails}
                collapsed={Boolean(collapsed[group.name])}
                onToggle={() => toggle(group.name)}
              />
            ))}
          </div>
        </div>
      </HoverContext.Provider>
    </ObserveContext.Provider>
  );
}
