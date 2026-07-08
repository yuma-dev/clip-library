// Cursor-paginated clip list for the feed. Ported from the reference website's
// `useClips` hook (cliplib share/src/hooks/useClips.ts), adapted to the app's
// typed `api.ts` client. Behavior preserved verbatim (except the page size —
// the server takes ~1s per authed query regardless of limit, and streamed
// card mounting makes big pages cheap, so bigger pages = fewer stalls):
//   - limit PAGE_SIZE, cursor pagination
//   - loadMore guarded by in-flight + hasMore refs
//   - request-version race guard (stale responses dropped)
//   - sessionStorage cache per persistKey (restore on mount → restoredFromCache)
//   - optimistic reaction/favorite mutators that also re-persist the cache

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { fetchClips, FeedApiError } from "./api";
import type { Clip } from "./types";

interface UseFeedClipsOptions {
  user?: string;
  mention?: string;
  game?: string;
  sort?: string;
  favorite?: string;
}

interface CachedClipState {
  clips: Clip[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number | null;
  savedAt: number;
}

function getCacheKey(persistKey?: string | null): string | null {
  if (!persistKey) return null;
  return `feed:list:v1:${persistKey}`;
}

/** One server round trip is ~1s warm regardless of page size; mounting is
 * streamed, so fetch big pages and grow the scroll area in big steps. */
const PAGE_SIZE = 60;

/** After page 1 paints, the entire remainder (server-reported total) is
 * fetched in ONE background request — clip rows are ~0.5KB of metadata, so
 * even a full library is ~1MB and the per-request auth/query overhead (~1s)
 * dominates anyway. The cap is a guard against pathological totals; anything
 * beyond it falls back to cursor pagination via InfiniteScroll, which also
 * covers servers that clamp `limit`. */
const MAX_EAGER_FETCH = 2000;

/** Cache younger than this skips the mount-time revalidate fetch entirely —
 * bouncing between views within half a minute shouldn't re-hit the share
 * server (each round trip is ~300ms and lands mid-navigation). */
const REVALIDATE_AFTER_MS = 30_000;

function readCachedState(storageKey: string): CachedClipState | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.clips)) return null;
    return {
      clips: parsed.clips,
      nextCursor: typeof parsed.nextCursor === "string" ? parsed.nextCursor : null,
      hasMore: Boolean(parsed.hasMore),
      total: typeof parsed.total === "number" ? parsed.total : null,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Drop every cached feed list so the next FeedPage mount refetches from the
 * server. Call after an action that changes what the feed should contain — e.g.
 * publishing a clip — since the 30s fresh-cache skip would otherwise show a
 * stale list that's missing the just-uploaded clip.
 */
export function invalidateFeedListCache(): void {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("feed:list:")) sessionStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Warm the sessionStorage cache for a filter combination before FeedPage ever
 * mounts (startup prefetch) — the page then paints instantly from cache.
 * No-op if that key is already cached this session.
 */
export async function prefetchFeedList(
  options: UseFeedClipsOptions,
  persistKey: string,
): Promise<void> {
  const storageKey = getCacheKey(persistKey);
  if (!storageKey || readCachedState(storageKey)) return;
  try {
    const { clips, nextCursor, total } = await fetchClips({ limit: PAGE_SIZE, ...options });
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ clips, nextCursor, hasMore: Boolean(nextCursor), total, savedAt: Date.now() }),
    );
  } catch {
    /* not connected / offline — the page fetches live and handles the error */
  }
}

export interface UseFeedClips {
  clips: Clip[];
  loading: boolean;
  hasMore: boolean;
  /** Full result-set size for the active filter (null until the server says). */
  total: number | null;
  restoredFromCache: boolean;
  /** Set on a 401 "not connected" (or other API error) so the page can react. */
  error: FeedApiError | null;
  loadMore: () => void;
  refresh: () => void;
  updateClipReaction: (clipId: string, emoji: string, action: "added" | "removed") => void;
  updateClipFavorite: (clipId: string, action: "added" | "removed") => void;
  /** Drop a clip from the list (owner deleted it in the player). */
  removeClip: (clipId: string) => void;
  /** Merge a partial update into a clip (owner edited title/mentions). */
  patchClip: (clipId: string, patch: Partial<Clip>) => void;
}

export function useFeedClips(
  options: UseFeedClipsOptions = {},
  persistKey?: string | null,
): UseFeedClips {
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState<number | null>(null);
  const totalRef = useRef<number | null>(null);
  const [restoredFromCache, setRestoredFromCache] = useState(false);
  const [error, setError] = useState<FeedApiError | null>(null);
  const cursorRef = useRef<string | null>(null);
  const optionsRef = useRef(options);
  const clipsRef = useRef<Clip[]>([]);
  const hasMoreRef = useRef(true);
  const fetchingRef = useRef(false);
  const requestVersionRef = useRef(0);
  optionsRef.current = options;

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  const persistCache = useCallback(
    (nextClips: Clip[], nextCursor: string | null, nextHasMore: boolean) => {
      const storageKey = getCacheKey(persistKey);
      if (!storageKey) return;
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            clips: nextClips,
            nextCursor,
            hasMore: nextHasMore,
            total: totalRef.current,
            savedAt: Date.now(),
          }),
        );
      } catch {
        /* ignore quota errors */
      }
    },
    [persistKey],
  );

  const setClipsAndPersist = useCallback(
    (value: SetStateAction<Clip[]>) => {
      setClips((prev) => {
        const nextClips =
          typeof value === "function" ? (value as (prev: Clip[]) => Clip[])(prev) : value;
        clipsRef.current = nextClips;
        persistCache(nextClips, cursorRef.current, hasMoreRef.current);
        return nextClips;
      });
    },
    [persistCache],
  );

  // One-shot guard for the eager remainder fetch (reset per filter change).
  const eagerLoadedRef = useRef(false);

  const doFetch = useCallback(
    async (reset = false, limitOverride?: number) => {
      if (!reset && fetchingRef.current) return;
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      fetchingRef.current = true;
      setLoading(true);
      try {
        const data = await fetchClips({
          limit: limitOverride ?? PAGE_SIZE,
          cursor: !reset ? cursorRef.current : null,
          user: optionsRef.current.user,
          mention: optionsRef.current.mention,
          game: optionsRef.current.game,
          sort: optionsRef.current.sort,
          favorite: optionsRef.current.favorite,
        });
        if (requestVersion !== requestVersionRef.current) return;
        setError(null);
        const nextClips = reset ? data.clips : [...clipsRef.current, ...data.clips];
        clipsRef.current = nextClips;
        setClips(nextClips);
        cursorRef.current = data.nextCursor;
        const nextHasMore = !!data.nextCursor;
        hasMoreRef.current = nextHasMore;
        setHasMore(nextHasMore);
        if (data.total != null) {
          totalRef.current = data.total;
          setTotal(data.total);
        }
        persistCache(nextClips, data.nextCursor, nextHasMore);
        // Complete the list in one background request once page 1 is up:
        // deferred a tick so this fetch's `finally` clears the in-flight
        // guard first. Failure (or a server that clamps `limit`) degrades
        // to normal cursor pagination.
        if (nextHasMore && data.total != null && !eagerLoadedRef.current) {
          const remaining = data.total - nextClips.length;
          if (remaining > 0 && remaining <= MAX_EAGER_FETCH) {
            eagerLoadedRef.current = true;
            window.setTimeout(() => void doFetchRef.current(false, remaining), 0);
          }
        }
      } catch (err) {
        if (requestVersion !== requestVersionRef.current) return;
        console.error("Failed to fetch clips:", err);
        if (err instanceof FeedApiError) setError(err);
      } finally {
        if (requestVersion === requestVersionRef.current) {
          fetchingRef.current = false;
          setLoading(false);
        }
      }
    },
    [persistCache],
  );
  // Self-reference for the deferred eager fetch (can't close over `doFetch`
  // inside its own useCallback definition).
  const doFetchRef = useRef(doFetch);
  doFetchRef.current = doFetch;

  const refresh = useCallback(() => {
    setRestoredFromCache(false);
    cursorRef.current = null;
    doFetch(true);
  }, [doFetch]);

  const loadMore = useCallback(() => {
    if (fetchingRef.current || !hasMoreRef.current) return;
    doFetch(false);
  }, [doFetch]);

  const optionsSignature = [
    options.user ?? "",
    options.mention ?? "",
    options.game ?? "",
    options.sort ?? "",
    options.favorite ?? "",
  ].join("|");

  useEffect(() => {
    requestVersionRef.current += 1;
    fetchingRef.current = false;
    eagerLoadedRef.current = false;
    const storageKey = getCacheKey(persistKey);
    if (storageKey) {
      const cached = readCachedState(storageKey);
      if (cached) {
        setRestoredFromCache(true);
        setError(null);
        clipsRef.current = cached.clips;
        cursorRef.current = cached.nextCursor;
        hasMoreRef.current = cached.hasMore;
        totalRef.current = cached.total;
        setClips(cached.clips);
        setHasMore(cached.hasMore);
        setTotal(cached.total);
        setLoading(false);
        // Stale-while-revalidate: paint the cached list instantly, then
        // refetch page 1 in the background so clips shared since the last
        // visit appear on re-entry (the fetch replaces the list on success
        // and leaves the cached one up on failure). Fresh caches skip the
        // refetch — quick view bounces shouldn't re-hit the server.
        if (Date.now() - cached.savedAt > REVALIDATE_AFTER_MS) {
          doFetch(true); // its success schedules the eager remainder fetch
        } else if (cached.hasMore && cached.total != null) {
          // Fresh but partial cache: still complete the list in one request.
          const remaining = cached.total - cached.clips.length;
          if (remaining > 0 && remaining <= MAX_EAGER_FETCH) {
            eagerLoadedRef.current = true;
            doFetch(false, remaining);
          }
        }
        return;
      }
    }

    setRestoredFromCache(false);
    cursorRef.current = null;
    clipsRef.current = [];
    hasMoreRef.current = true;
    totalRef.current = null;
    setClips([]);
    setHasMore(true);
    setTotal(null);
    doFetch(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doFetch, optionsSignature, persistKey]);

  const updateClipReaction = useCallback(
    (clipId: string, emoji: string, action: "added" | "removed") => {
      setClipsAndPersist((prev) =>
        prev.map((clip) => {
          if (clip.id !== clipId) return clip;
          const newCounts = { ...clip.reactionCounts };
          newCounts[emoji] = (newCounts[emoji] || 0) + (action === "added" ? 1 : -1);
          const newUserReactions =
            action === "added"
              ? [...clip.userReactions, emoji]
              : clip.userReactions.filter((e) => e !== emoji);
          return { ...clip, reactionCounts: newCounts, userReactions: newUserReactions };
        }),
      );
    },
    [setClipsAndPersist],
  );

  const updateClipFavorite = useCallback(
    (clipId: string, action: "added" | "removed") => {
      setClipsAndPersist((prev) =>
        prev.map((clip) =>
          clip.id !== clipId ? clip : { ...clip, isFavorited: action === "added" },
        ),
      );
    },
    [setClipsAndPersist],
  );

  const removeClip = useCallback(
    (clipId: string) => {
      setClipsAndPersist((prev) => prev.filter((clip) => clip.id !== clipId));
      if (totalRef.current != null) {
        totalRef.current = Math.max(0, totalRef.current - 1);
        setTotal(totalRef.current);
      }
    },
    [setClipsAndPersist],
  );

  const patchClip = useCallback(
    (clipId: string, patch: Partial<Clip>) => {
      setClipsAndPersist((prev) =>
        prev.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
      );
    },
    [setClipsAndPersist],
  );

  return {
    clips,
    loading,
    hasMore,
    total,
    restoredFromCache,
    error,
    loadMore,
    refresh,
    updateClipReaction,
    updateClipFavorite,
    removeClip,
    patchClip,
  };
}
