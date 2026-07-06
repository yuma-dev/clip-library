import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Collection,
  type TagFilterState,
  activeSelection,
  filterClips,
} from "./filter";
import type { LocalClip } from "./types";

export interface UseLibraryFilter {
  query: string;
  setQuery: (value: string) => void;

  collection: Collection;
  setCollection: (value: Collection) => void;

  /** All filterable tags in display order: system tags first, then global. */
  allTags: string[];
  globalTags: string[];
  tags: TagFilterState;
  /** Selected count over the total tag universe (for the "(x/y)" label). */
  selectedCount: number;
  totalCount: number;
  /** Normal click — toggle a tag in the persisted (AND-exclusion) selection. */
  toggleTag: (tag: string) => void;
  /** Ctrl / indicator click — focus a single tag (OR), or clear focus. */
  focusTag: (tag: string) => void;
  showAllTags: () => void;
  hideAllTags: () => void;
  clearFocus: () => void;

  /** clips run through search + tag + collection filters (newest-first). */
  filteredClips: LocalClip[];
}

/** Union of the persisted global-tags list and every tag present on a clip. */
function deriveGlobalTags(loaded: string[], clips: LocalClip[]): string[] {
  const set = new Set(loaded);
  for (const clip of clips) for (const t of clip.tags) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function useLibraryFilter(clips: LocalClip[]): UseLibraryFilter {
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState<Collection>("all");
  const [loadedTags, setLoadedTags] = useState<string[]>([]);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [temporary, setTemporary] = useState<Set<string>>(new Set());
  const [isTemporary, setIsTemporary] = useState(false);
  // Until the persisted selection loads, the tag filter is bypassed so no
  // tagged clip flashes hidden on first paint.
  const [ready, setReady] = useState(false);

  const globalTags = useMemo(() => deriveGlobalTags(loadedTags, clips), [loadedTags, clips]);
  const allTags = useMemo(() => ["Untagged", "Unnamed", ...globalTags], [globalTags]);

  // Load the global tag list + persisted selection once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [gt, prefs] = await Promise.all([
        window.clips.loadGlobalTags().catch(() => []),
        window.clips.getTagPreferences().catch(() => null),
      ]);
      if (cancelled) return;
      const list: string[] = Array.isArray(gt) ? gt.map(String) : [];
      setLoadedTags(list);

      const savedPrefs: string[] | null = Array.isArray(prefs) ? prefs.map(String) : null;
      if (savedPrefs && savedPrefs.length > 0) {
        const set = new Set(savedPrefs);
        // First-run migration: always surface Unnamed (legacy behavior).
        if (!set.has("Unnamed")) {
          set.add("Unnamed");
          window.clips.saveTagPreferences([...set]).catch(() => {});
        }
        setSaved(set);
      } else {
        setSaved(new Set(["Untagged", "Unnamed", ...list]));
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((set: Set<string>) => {
    window.clips.saveTagPreferences([...set]).catch(() => {});
  }, []);

  const toggleTag = useCallback(
    (tag: string) => {
      setIsTemporary(false);
      setTemporary(new Set());
      setSaved((prev) => {
        const next = new Set(prev);
        if (next.has(tag)) next.delete(tag);
        else next.add(tag);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const clearFocus = useCallback(() => {
    setIsTemporary(false);
    setTemporary(new Set());
  }, []);

  const focusTag = useCallback((tag: string) => {
    // Ctrl/indicator-click the already-sole focus tag exits focus mode.
    setTemporary((prev) => {
      const soleFocus = prev.size === 1 && prev.has(tag);
      setIsTemporary(!soleFocus);
      return soleFocus ? new Set() : new Set([tag]);
    });
  }, []);

  const showAllTags = useCallback(() => {
    clearFocus();
    const next = new Set(allTags);
    setSaved(next);
    persist(next);
  }, [allTags, clearFocus, persist]);

  const hideAllTags = useCallback(() => {
    clearFocus();
    const next = new Set<string>();
    setSaved(next);
    persist(next);
  }, [clearFocus, persist]);

  const tags: TagFilterState = useMemo(
    () => ({ saved, temporary, isTemporary }),
    [saved, temporary, isTemporary],
  );

  const filteredClips = useMemo(
    () => filterClips(clips, { query, tags, collection, applyTags: ready }),
    [clips, query, tags, collection, ready],
  );

  const selectedCount = useMemo(() => activeSelection(tags).size, [tags]);

  return {
    query,
    setQuery,
    collection,
    setCollection,
    allTags,
    globalTags,
    tags,
    selectedCount,
    totalCount: allTags.length,
    toggleTag,
    focusTag,
    showAllTags,
    hideAllTags,
    clearFocus,
    filteredClips,
  };
}
