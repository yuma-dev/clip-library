import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupClips } from "./grouping";
import ClipGroup from "./ClipGroup";
import { ObserveContext, type ObserveFn } from "./visibility";
import type { LocalClip } from "./types";

interface ClipGridProps {
  clips: LocalClip[];
  thumbnails: Map<string, string | null>;
}

const COLLAPSE_KEY = "clip-library:collapsed-groups";

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export default function ClipGrid({ clips, thumbnails }: ClipGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);

  // Shared visibility observer (hard-won §4.2). Created lazily on the first
  // observe() call — refs are committed before child effects fire, so the
  // scroll container (the observer root) is available by then.
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

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  // Clips arrive newest-first; regroup when the list changes.
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
      <div className="clip-scroll" ref={scrollRef}>
        <div className="clip-grid">
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
    </ObserveContext.Provider>
  );
}
