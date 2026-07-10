import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalClip } from "./types";

// Last session's library snapshot — lets the grid paint instantly on launch
// while the real scan runs, instead of showing a loading screen for ~1s.
// The fresh get-clips result replaces it wholesale when it arrives.
const CLIPS_CACHE_KEY = "clip-library:clips-cache-v1";

interface ClipsCache {
  location: string;
  clips: LocalClip[];
  thumbnails: [string, string | null][];
}

function readClipsCache(): ClipsCache | null {
  try {
    const raw = localStorage.getItem(CLIPS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClipsCache;
    if (!Array.isArray(parsed?.clips) || !Array.isArray(parsed?.thumbnails)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeClipsCache(produce: () => ClipsCache): void {
  // Deferred + produced at write time, so thumbnails generated in the first
  // seconds of the session make it into the snapshot. ~400KB JSON write.
  setTimeout(() => {
    try {
      localStorage.setItem(CLIPS_CACHE_KEY, JSON.stringify(produce()));
    } catch {
      /* quota/serialization issues just mean no fast paint next launch */
    }
  }, 5000);
}

export interface UseClips {
  clips: LocalClip[];
  clipLocation: string;
  loading: boolean;
  /** originalName -> absolute thumbnail path (or null while missing). */
  thumbnails: Map<string, string | null>;
  /** How many thumbnails are still being generated (0 = idle). */
  generatingCount: number;
  /** Remove clips from the list (e.g. after a successful delete). */
  removeClips: (names: string[]) => void;
  /**
   * Mark clips as watched (player opened): clears their "new" highlight
   * immediately and persists via IPC so it survives restarts.
   */
  markClipsWatched: (names: string[]) => void;
  /**
   * Rename a clip's custom title. Persists via IPC, updates the list, and
   * reflects the change into the open legacy player. Returns true on success.
   */
  renameClip: (originalName: string, newName: string) => Promise<boolean>;
  /**
   * Replace a clip's tag list. Updates the list, persists via IPC, and reflects
   * the change into the open legacy player. Drives the grid "Manage tags" menu.
   */
  setClipTags: (originalName: string, tags: string[]) => void;
  /**
   * In-memory reflections of global tag management (settings → Manage tags).
   * Disk changes are done by the caller via `update-tag-in-all-clips` /
   * `remove-tag-from-all-clips`; these keep the loaded list in sync.
   */
  renameTagInClips: (oldTag: string, newTag: string) => void;
  removeTagFromClips: (tag: string) => void;
}

/**
 * Loads the local clip library + thumbnails + tags.
 * - clips render immediately (newest-first from `get-clips`);
 * - thumbnails come from one batch call, then progressive generation events;
 * - tags load in background batches of 50 (like the legacy renderer) and fill in.
 */
export function useClips(): UseClips {
  const cacheRef = useRef<ClipsCache | null | undefined>(undefined);
  if (cacheRef.current === undefined) cacheRef.current = readClipsCache();
  const cached = cacheRef.current;

  const [clips, setClips] = useState<LocalClip[]>(() => cached?.clips ?? []);
  const [clipLocation, setClipLocation] = useState(() => cached?.location ?? "");
  const [loading, setLoading] = useState(() => !cached);
  const [thumbnails, setThumbnails] = useState<Map<string, string | null>>(
    () => new Map(cached?.thumbnails ?? []),
  );
  const [generatingCount, setGeneratingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];

    (async () => {
      const [loc, raw, newInfo] = await Promise.all([
        window.clips.getClipLocation().catch(() => ""),
        window.clips.getClips().catch(() => []),
        window.clips.getNewClipsInfo().catch(() => ({ newClips: [] })),
      ]);
      if (cancelled) return;

      // Clips added since the last session — used to highlight them on load.
      const newSet = new Set<string>(Array.isArray(newInfo?.newClips) ? newInfo.newClips : []);

      const rawList: Record<string, unknown>[] = Array.isArray(raw) ? raw : [];
      const list: LocalClip[] = rawList.map((c) => ({
        originalName: String(c.originalName ?? ""),
        customName: String(c.customName ?? c.originalName ?? ""),
        createdAt: Number(c.createdAt ?? 0),
        thumbnailPath: (c.thumbnailPath as string | null) ?? null,
        isTrimmed: Boolean(c.isTrimmed),
        tags: [],
        isNewSinceLastSession: newSet.has(String(c.originalName ?? "")),
      }));

      setClipLocation(loc);
      // Reconcile against the cached snapshot instead of replacing wholesale:
      // swapping 2000+ object identities re-rendered every memoized card in
      // one commit (a ~600ms dropped frame at startup) and blanked the tags
      // until the tag batches refilled them. Unchanged clips keep their old
      // object (and cached tags — the batches below remain authoritative).
      setClips((prev) => {
        if (prev.length === 0) return list;
        const byName = new Map(prev.map((c) => [c.originalName, c]));
        return list.map((fresh) => {
          const old = byName.get(fresh.originalName);
          if (!old) return fresh;
          if (
            old.customName === fresh.customName &&
            old.createdAt === fresh.createdAt &&
            old.thumbnailPath === fresh.thumbnailPath &&
            old.isTrimmed === fresh.isTrimmed &&
            (old.isNewSinceLastSession ?? false) === (fresh.isNewSinceLastSession ?? false)
          ) {
            return old;
          }
          return { ...fresh, tags: old.tags };
        });
      });
      setLoading(false);

      // Live: a clip file lands while the app is running. Fetch its info, mark
      // it new, prepend it (dedup), then fill in its thumbnail + tags.
      unsubs.push(
        window.clips.onNewClipAdded(async (fileName: string) => {
          if (!fileName || cancelled) return;
          const info = (await window.clips.getNewClipInfo(fileName).catch(() => null)) as Record<
            string,
            unknown
          > | null;
          if (!info || cancelled) return;
          const clip: LocalClip = {
            originalName: String(info.originalName ?? fileName),
            customName: String(info.customName ?? ""),
            createdAt: Number(info.createdAt ?? 0),
            thumbnailPath: null,
            isTrimmed: false,
            tags: Array.isArray(info.tags) ? (info.tags as string[]) : [],
            isNewSinceLastSession: true,
          };
          setClips((prev) =>
            prev.some((c) => c.originalName === clip.originalName) ? prev : [clip, ...prev],
          );
          window.clips.generateThumbnailsProgressively([clip.originalName]).catch(() => {});
          const tags = await window.clips.getClipTags(clip.originalName).catch(() => []);
          if (cancelled) return;
          setClips((prev) =>
            prev.map((c) =>
              c.originalName === clip.originalName
                ? { ...c, tags: Array.isArray(tags) ? (tags as string[]) : [] }
                : c,
            ),
          );
        }),
      );

      const names = list.map((c) => c.originalName);

      // --- Thumbnails: authoritative batch, then generate the missing ones. ---
      const batch = (await window.clips
        .getThumbnailPathsBatch(names)
        .catch(() => ({}))) as Record<string, string | null>;
      if (cancelled) return;
      const tmap = new Map<string, string | null>(Object.entries(batch));
      setThumbnails(new Map(tmap));

      unsubs.push(
        window.clips.onThumbnailGenerated((payload: { clipName?: string; thumbnailPath?: string }) => {
          if (!payload?.clipName) return;
          tmap.set(payload.clipName, payload.thumbnailPath ?? null); // keep the cache snapshot source fresh
          setThumbnails((prev) => {
            const next = new Map(prev);
            next.set(payload.clipName!, payload.thumbnailPath ?? null);
            return next;
          });
        }),
      );
      unsubs.push(
        window.clips.onThumbnailProgress((payload: { current?: number; total?: number }) => {
          if (payload?.total != null && payload?.current != null) {
            setGeneratingCount(Math.max(0, payload.total - payload.current));
          }
        }),
      );
      unsubs.push(window.clips.onThumbnailGenerationComplete(() => setGeneratingCount(0)));
      // Main revalidates thumbnails on startup/location change; seed the
      // pending count so the indicator appears before the first progress tick.
      unsubs.push(
        window.clips.onThumbnailValidationStart((payload: { total?: number }) => {
          setGeneratingCount(Math.max(0, Number(payload?.total) || 0));
        }),
      );
      unsubs.push(
        window.clips.onThumbnailGenerationFailed((payload: { clipName?: string; error?: string }) => {
          console.error(`Failed to generate thumbnail for ${payload?.clipName}: ${payload?.error}`);
        }),
      );

      const missing = names.filter((n) => !tmap.get(n));
      if (missing.length > 0) {
        const res = (await window.clips
          .generateThumbnailsProgressively(missing)
          .catch(() => null)) as { needsGeneration?: number } | null;
        if (res?.needsGeneration) setGeneratingCount(res.needsGeneration);
      }

      // --- Tags: batched IPC (500 names per call), fill in per batch. ---
      // One round trip per 500 clips instead of one per clip; clips whose tags
      // stay empty keep their object identity so memoized cards skip re-render.
      const allTags: Record<string, string[]> = {};
      const TAG_BATCH = 500;
      const sameTags = (a: string[], b: string[]) =>
        a.length === b.length && a.every((t, i) => t === b[i]);
      for (let i = 0; i < list.length && !cancelled; i += TAG_BATCH) {
        const slice = list.slice(i, i + TAG_BATCH);
        const sliceNames = new Set(slice.map((c) => c.originalName));
        const byName = (await window.clips
          .getClipTagsBatch(slice.map((c) => c.originalName))
          .catch(() => ({}))) as Record<string, string[]>;
        if (cancelled) return;
        // The batch returns an entry for every requested name ([] when
        // tagless); an empty object means the IPC failed — keep current tags.
        if (Object.keys(byName).length === 0) continue;
        Object.assign(allTags, byName);
        // Authoritative for the clips in this batch (an absent entry means "no
        // tags" — cached tags carried over by the startup reconcile must be
        // cleared, not kept). Identity only changes when the tags differ.
        setClips((prev) =>
          prev.map((c) => {
            if (!sliceNames.has(c.originalName)) return c;
            const tags = Array.isArray(byName[c.originalName]) ? byName[c.originalName] : [];
            return sameTags(c.tags, tags) ? c : { ...c, tags };
          }),
        );
      }

      // Snapshot for the next launch's instant first paint. "New" flags are
      // session-relative, so they're stripped. Never cache an empty library —
      // a transient scan failure must not make later launches paint "no clips".
      if (list.length > 0) {
        writeClipsCache(() => ({
          location: loc,
          clips: list.map((c) => ({
            ...c,
            tags: Array.isArray(allTags[c.originalName]) ? allTags[c.originalName] : [],
            isNewSinceLastSession: false,
          })),
          // tmap is kept up to date by onThumbnailGenerated below, so thumbs
          // generated before the deferred write land in the snapshot too.
          thumbnails: [...tmap],
        }));
      }
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, []);

  const removeClips = useCallback((names: string[]) => {
    const set = new Set(names);
    setClips((prev) => prev.filter((c) => !set.has(c.originalName)));
  }, []);

  const markClipsWatched = useCallback((names: string[]) => {
    const set = new Set(names);
    setClips((prev) =>
      prev.some((c) => set.has(c.originalName) && c.isNewSinceLastSession)
        ? prev.map((c) =>
            set.has(c.originalName) && c.isNewSinceLastSession
              ? { ...c, isNewSinceLastSession: false }
              : c,
          )
        : prev,
    );
    window.clips.markClipsWatched(names).catch(() => {});
  }, []);

  const renameClip = useCallback(async (originalName: string, rawName: string) => {
    const newName = rawName.trim();
    const res = await window.clips.saveCustomName(originalName, newName).catch(() => null);
    if (!res?.success) return false;

    setClips((prev) =>
      prev.map((c) => (c.originalName === originalName ? { ...c, customName: newName } : c)),
    );

    // Reflect into the open legacy player, if it's showing this clip.
    const state = window.legacyState;
    if (state?.currentClip?.originalName === originalName) {
      state.currentClip.customName = newName;
      const input = document.getElementById("clip-title") as HTMLInputElement | null;
      // Don't stomp the field the user is actively typing in.
      if (input && document.activeElement !== input) input.value = newName;
    }
    return true;
  }, []);

  const setClipTags = useCallback((originalName: string, tags: string[]) => {
    setClips((prev) =>
      prev.map((c) => (c.originalName === originalName ? { ...c, tags } : c)),
    );
    window.clips.saveClipTags(originalName, tags).catch(() => {});
    // Reflect into the open legacy player, if it's showing this clip.
    const state = window.legacyState;
    if (state?.currentClip?.originalName === originalName) {
      state.currentClip.tags = tags;
    }
  }, []);

  const renameTagInClips = useCallback((oldTag: string, newTag: string) => {
    setClips((prev) =>
      prev.map((c) =>
        c.tags.includes(oldTag)
          ? { ...c, tags: c.tags.map((t) => (t === oldTag ? newTag : t)) }
          : c,
      ),
    );
    const state = window.legacyState;
    if (state?.currentClip?.tags?.includes(oldTag)) {
      state.currentClip.tags = state.currentClip.tags.map((t: string) => (t === oldTag ? newTag : t));
    }
  }, []);

  const removeTagFromClips = useCallback((tag: string) => {
    setClips((prev) =>
      prev.map((c) => (c.tags.includes(tag) ? { ...c, tags: c.tags.filter((t) => t !== tag) } : c)),
    );
    const state = window.legacyState;
    if (state?.currentClip?.tags?.includes(tag)) {
      state.currentClip.tags = state.currentClip.tags.filter((t: string) => t !== tag);
    }
  }, []);

  // Stable object identity so memoized consumers only re-render on real changes.
  return useMemo(
    () => ({
      clips,
      clipLocation,
      loading,
      thumbnails,
      generatingCount,
      removeClips,
      markClipsWatched,
      renameClip,
      setClipTags,
      renameTagInClips,
      removeTagFromClips,
    }),
    [
      clips,
      clipLocation,
      loading,
      thumbnails,
      generatingCount,
      removeClips,
      markClipsWatched,
      renameClip,
      setClipTags,
      renameTagInClips,
      removeTagFromClips,
    ],
  );
}
