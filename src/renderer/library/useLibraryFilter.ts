import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import { shuffleClips, shuffleSettings } from "./shuffle";
import type { LocalClip } from "./types";

export interface UseLibraryFilter {
  query: string;
  setQuery: (value: string) => void;

  collection: Collection;
  setCollection: (value: Collection) => void;

  /** system tags first, then global, in display order */
  allTags: string[];
  globalTags: string[];
  tags: TagFilterState;
  /** selected count over the total tag universe, for the "(x/y)" label */
  selectedCount: number;
  totalCount: number;
  /** normal click: toggle in the persisted (AND-exclusion) selection */
  toggleTag: (tag: string) => void;
  /** ctrl/indicator click: focus a single tag (OR), or clear focus */
  focusTag: (tag: string) => void;
  showAllTags: () => void;
  hideAllTags: () => void;
  clearFocus: () => void;
  addGlobalTag: (tag: string) => void;
  /** disk scan done by the caller */
  renameGlobalTag: (oldTag: string, newTag: string) => void;
  /** disk scan done by the caller */
  removeGlobalTag: (tag: string) => void;

  filteredClips: LocalClip[];
  shuffled?: boolean;
  reshuffle?: () => void;
}

/** union of the persisted global-tags list and every tag present on a clip */
function deriveGlobalTags(loaded: string[], clips: LocalClip[]): string[] {
  const set = new Set(loaded);
  for (const clip of clips) for (const t of clip.tags) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function useLibraryFilter(clips: LocalClip[]): UseLibraryFilter {
  const [query, updateQuery] = useState("");
  const queryRef = useRef("");
  const [shuffleSession, setShuffleSession] = useState(() => ({ seed: Math.random() * 0xffffffff, now: Date.now() }));
  const reshuffle = useCallback(() => {
    setShuffleSession({ seed: Math.random() * 0xffffffff, now: Date.now() });
  }, []);
  const setQuery = useCallback((value: string) => {
    if (shuffleSettings(value).enabled && !shuffleSettings(queryRef.current).enabled) reshuffle();
    queryRef.current = value;
    updateQuery(value);
  }, [reshuffle]);
  const [collection, setCollection] = useState<Collection>("all");
  const [loadedTags, setLoadedTags] = useState<string[]>([]);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [temporary, setTemporary] = useState<Set<string>>(new Set());
  const [isTemporary, setIsTemporary] = useState(false);
  // bypassed until the persisted selection loads, so no tagged clip flashes hidden on first paint
  const [ready, setReady] = useState(false);

  const globalTags = useMemo(() => deriveGlobalTags(loadedTags, clips), [loadedTags, clips]);
  const allTags = useMemo(() => ["Untagged", "Unnamed", ...globalTags], [globalTags]);

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
      if (savedPrefs !== null) {
        // Empty and Unnamed-disabled selections are deliberate preferences too.
        setSaved(new Set(savedPrefs));
      } else {
        setSaved(new Set(["Untagged", "Unnamed", ...list]));
      }
      setReady(true);

      // rebuilds the persisted tag list from disk after settings loss (legacy behavior)
      // gated on user idle: the scan takes ~400-600ms and would stall IPC while opening clips
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
    // ctrl/indicator-click on the already-sole focus tag exits focus mode
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

  // adds to the persisted universe and enables it in the saved selection so a freshly-tagged clip
  // stays visible
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

  // `@mention` needs a full-library scan, only triggered once the user types an `@` term
  const participantsVersion = useParticipantsVersion();
  const hasMentionQuery = useMemo(
    () => parseSearchTerms(query).mentions.length > 0,
    [query],
  );
  useEffect(() => {
    if (hasMentionQuery) ensureParticipants(clips.map((c) => c.originalName));
  }, [hasMentionQuery, clips]);

  // filtering (and the 2000-card grid it feeds) runs against a deferred copy of the
  // criteria so the grid re-renders as a low-priority pass, not blocking each keystroke
  const criteria = useMemo(
    () => ({
      query,
      tags,
      collection,
      applyTags: ready,
      now: shuffleSession.now,
      shuffleSeed: shuffleSession.seed,
      // participantsVersion forces a re-run once the scan resolves
      mentionIndex:
        hasMentionQuery && participantsLoaded() ? getMentionIndex() : undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, tags, collection, ready, hasMentionQuery, participantsVersion, shuffleSession],
  );
  const deferredCriteria = useDeferredValue(criteria);

  const shuffled = shuffleSettings(deferredCriteria.query).enabled;
  // Sort once per seed/library change, never per search or tag-filter edit.
  const orderedClips = useMemo(
    () => shuffled ? shuffleClips(clips, deferredCriteria.shuffleSeed) : clips,
    [clips, shuffled, deferredCriteria.shuffleSeed],
  );
  const matches = useMemo(
    () => filterClips(orderedClips, deferredCriteria),
    [orderedClips, deferredCriteria],
  );
  // Equivalent queries retain the committed result identity. Commit-phase writes
  // keep abandoned concurrent renders from becoming the comparison baseline.
  const previousMatches = useRef(matches);
  const filteredClips = matches.length === previousMatches.current.length &&
    matches.every((clip, i) => clip === previousMatches.current[i])
    ? previousMatches.current : matches;
  useEffect(() => { previousMatches.current = filteredClips; }, [filteredClips]);

  const selectedCount = useMemo(() => activeSelection(tags).size, [tags]);

  // stable identity so memoized consumers (Sidebar) only re-render on real changes
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
      shuffled,
      reshuffle,
    }),
    [
      setQuery,
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
      shuffled,
      reshuffle,
    ],
  );
}
