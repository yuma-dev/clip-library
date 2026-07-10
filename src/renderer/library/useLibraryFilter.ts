import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  type Collection,
  type TagFilterState,
  activeSelection,
  filterClips,
  parseSearchTerms,
} from "./filter";
import {
  ensureParticipants,
  getMentionIndex,
  participantsLoaded,
  useParticipantsVersion,
} from "./participants";
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
  /** Create a new global tag (persists it and enables it in the filter). */
  addGlobalTag: (tag: string) => void;
  /** Rename a tag in the global list + selections (disk scan done by caller). */
  renameGlobalTag: (oldTag: string, newTag: string) => void;
  /** Remove a tag from the global list + selections (disk scan done by caller). */
  removeGlobalTag: (tag: string) => void;

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
    let restoreTimer: number | undefined;
    let lastInputAt = Date.now();
    const bumpInput = () => {
      lastInputAt = Date.now();
    };
    const removeIdleListeners = () => {
      window.removeEventListener("pointerdown", bumpInput, { capture: true });
      window.removeEventListener("keydown", bumpInput, { capture: true });
    };
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

      // Disaster recovery (legacy clip-grid behavior): rebuild the persisted
      // global tag list from per-clip tags on disk (e.g. after settings loss).
      // Display already self-heals via deriveGlobalTags; this repairs storage.
      // Deferred past startup AND gated on user idle: the scan reads every
      // clip's metadata on the main process (~400-600ms), so running it while
      // the user is opening clips stalls their IPC behind it.
      const runRestore = async () => {
        removeIdleListeners();
        try {
          const restore = (await window.clips.restoreMissingGlobalTags()) as {
            success?: boolean;
            restoredCount?: number;
          } | null;
          if (!cancelled && restore?.success && (restore.restoredCount ?? 0) > 0) {
            const reloaded = await window.clips.loadGlobalTags().catch(() => []);
            if (!cancelled && Array.isArray(reloaded)) setLoadedTags(reloaded.map(String));
          }
        } catch {
          /* recovery is best-effort */
        }
      };
      const tryRestore = () => {
        if (cancelled) return;
        if (Date.now() - lastInputAt < 5_000) {
          // User is active — check back shortly.
          restoreTimer = window.setTimeout(tryRestore, 5_000);
          return;
        }
        void runRestore();
      };
      window.addEventListener("pointerdown", bumpInput, { capture: true });
      window.addEventListener("keydown", bumpInput, { capture: true });
      restoreTimer = window.setTimeout(tryRestore, 15_000);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(restoreTimer);
      removeIdleListeners();
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

  // Create a new global tag: add it to the persisted universe and enable it in
  // the saved selection so a clip freshly tagged with it stays visible. If it's
  // already known, this is a no-op beyond ensuring it's selected.
  const addGlobalTag = useCallback(
    (raw: string) => {
      const tag = raw.trim();
      if (!tag) return;
      setLoadedTags((prev) => {
        if (prev.includes(tag)) return prev;
        const next = [...prev, tag];
        window.clips.saveGlobalTags(next).catch(() => {});
        return next;
      });
      setSaved((prev) => {
        if (prev.has(tag)) return prev;
        const next = new Set(prev);
        next.add(tag);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const renameGlobalTag = useCallback(
    (oldTag: string, newTag: string) => {
      setLoadedTags((prev) => {
        const next = prev.map((t) => (t === oldTag ? newTag : t));
        if (!next.includes(newTag)) next.push(newTag);
        window.clips.saveGlobalTags(next).catch(() => {});
        return next;
      });
      setSaved((prev) => {
        if (!prev.has(oldTag)) return prev;
        const next = new Set(prev);
        next.delete(oldTag);
        next.add(newTag);
        persist(next);
        return next;
      });
      setTemporary((prev) => {
        if (!prev.has(oldTag)) return prev;
        const next = new Set(prev);
        next.delete(oldTag);
        next.add(newTag);
        return next;
      });
    },
    [persist],
  );

  const removeGlobalTag = useCallback(
    (tag: string) => {
      setLoadedTags((prev) => {
        const next = prev.filter((t) => t !== tag);
        window.clips.saveGlobalTags(next).catch(() => {});
        return next;
      });
      setSaved((prev) => {
        if (!prev.has(tag)) return prev;
        const next = new Set(prev);
        next.delete(tag);
        persist(next);
        return next;
      });
      setTemporary((prev) => {
        if (!prev.has(tag)) return prev;
        const next = new Set(prev);
        next.delete(tag);
        if (next.size === 0) setIsTemporary(false);
        return next;
      });
    },
    [persist],
  );

  const tags: TagFilterState = useMemo(
    () => ({ saved, temporary, isTemporary }),
    [saved, temporary, isTemporary],
  );

  // `@mention` filtering needs the participant roster + per-clip index. It's a
  // full-library metadata scan, so only trigger it once the user actually types
  // an `@user` term (the roster is otherwise loaded lazily when the search field
  // is focused). Re-render when the scan resolves so the grid picks it up.
  const participantsVersion = useParticipantsVersion();
  const hasMentionQuery = useMemo(
    () => parseSearchTerms(query).mentions.length > 0,
    [query],
  );
  useEffect(() => {
    if (hasMentionQuery) ensureParticipants(clips.map((c) => c.originalName));
  }, [hasMentionQuery, clips]);

  // Filtering (and the 2,000-card grid render it feeds) runs against a
  // deferred copy of the criteria: the search input / tag buttons repaint
  // immediately, and React re-renders the grid as a low-priority,
  // interruptible pass instead of blocking every keystroke for ~450ms.
  const criteria = useMemo(
    () => ({
      query,
      tags,
      collection,
      applyTags: ready,
      // `participantsVersion` bumps identity when the scan resolves, forcing the
      // filter to re-run against the freshly built index.
      mentionIndex:
        hasMentionQuery && participantsLoaded() ? getMentionIndex() : undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, tags, collection, ready, hasMentionQuery, participantsVersion],
  );
  const deferredCriteria = useDeferredValue(criteria);

  const filteredClips = useMemo(
    () => filterClips(clips, deferredCriteria),
    [clips, deferredCriteria],
  );

  const selectedCount = useMemo(() => activeSelection(tags).size, [tags]);

  // Stable object identity so memoized consumers (Sidebar) only re-render
  // when a filter value actually changes.
  return useMemo(
    () => ({
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
      addGlobalTag,
      renameGlobalTag,
      removeGlobalTag,
      filteredClips,
    }),
    [
      query,
      collection,
      allTags,
      globalTags,
      tags,
      selectedCount,
      toggleTag,
      focusTag,
      showAllTags,
      hideAllTags,
      clearFocus,
      addGlobalTag,
      renameGlobalTag,
      removeGlobalTag,
      filteredClips,
    ],
  );
}
