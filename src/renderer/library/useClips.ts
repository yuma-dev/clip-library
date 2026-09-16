import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalClip } from "./types";
import { bootMark } from "../perf/bootMarks";
import { whenCommitsAllowed } from "../boot/bootHold";

// forces consecutive whole-grid commits onto separate frames
const nextFrame = (pauseMs = 0) =>
  new Promise<void>((resolve) => requestAnimationFrame(() => (pauseMs ? setTimeout(resolve, pauseMs) : resolve())));

// last session's snapshot, paints the grid instantly instead of a ~1s loading screen
// while the real get-clips scan runs; replaced wholesale once that resolves
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
  // deferred so thumbnails generated in the first seconds land in the snapshot (~400KB JSON write)
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
  /** originalName -> absolute thumbnail path, null while missing */
  thumbnails: Map<string, string | null>;
  /** thumbnails still being generated, 0 = idle */
  generatingCount: number;
  removeClips: (names: string[]) => void;
  /** clears "new" highlight immediately, persists via IPC */
  markClipsWatched: (names: string[]) => void;
  /** persists via IPC, reflects into the open legacy player */
  renameClip: (originalName: string, newName: string) => Promise<boolean>;
  /** persists via IPC, reflects into the legacy player; drives grid "Manage tags" */
  setClipTags: (originalName: string, tags: string[]) => void;
  /** in-memory mirror of settings' Manage Tags; disk side done by the caller */
  renameTagInClips: (oldTag: string, newTag: string) => void;
  removeTagFromClips: (tag: string) => void;
}

/** clips render immediately, thumbnails batch then stream progressively, tags fill in batches of 500 */
export function useClips(): UseClips {
  const cacheRef = useRef<ClipsCache | null | undefined>(undefined);
  if (cacheRef.current === undefined) {
    cacheRef.current = readClipsCache();
    bootMark(cacheRef.current ? "snapshot_hit" : "snapshot_miss");
  }
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
      const [loc, raw] = await Promise.all([
        window.clips.getClipLocation().catch(() => ""),
        window.clips.getClips().catch(() => []),
      ]);
      if (cancelled) return;
      bootMark("get_clips_returned");
      // passing known names spares main a second walk of the library
      const knownNames = (Array.isArray(raw) ? raw : []).map((c) => String(c.originalName ?? ""));
      const newInfo = await window.clips.getNewClipsInfo(knownNames).catch(() => ({ newClips: [] }));
      if (cancelled) return;
      // wait out the boot intro before a commit that touches every card
      await whenCommitsAllowed();
      if (cancelled) return;
      await nextFrame();
      if (cancelled) return;

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
      // reconcile, don't replace wholesale: swapping 2000+ identities re-rendered every
      // card in one commit (~600ms dropped frame) and blanked tags until batches refilled
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
      requestAnimationFrame(() => bootMark("fresh_list_committed"));

      // a clip lands live: fetch its info, mark new, prepend (dedup), fill in thumbnail + tags
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

      // authoritative thumbnail batch; missing ones generate below
      const batch = (await window.clips
        .getThumbnailPathsBatch(names)
        .catch(() => ({}))) as Record<string, string | null>;
      if (cancelled) return;
      const tmap = new Map<string, string | null>(Object.entries(batch));

      // fetched now so round trips overlap the reveal hold; applied per batch further down
      const TAG_BATCH = 500;
      const tagBatches: Promise<Record<string, string[]>>[] = [];
      for (let i = 0; i < list.length; i += TAG_BATCH) {
        const slice = list.slice(i, i + TAG_BATCH);
        tagBatches.push(
          window.clips
            .getClipTagsBatch(slice.map((c) => c.originalName))
            .catch(() => ({})) as Promise<Record<string, string[]>>,
        );
      }

      await whenCommitsAllowed();
      if (cancelled) return;
      await nextFrame(40);
      if (cancelled) return;
      setThumbnails(new Map(tmap));
      requestAnimationFrame(() => bootMark("thumb_paths_applied"));

      unsubs.push(
        window.clips.onThumbnailGenerated((payload: { clipName?: string; thumbnailPath?: string }) => {
          if (!payload?.clipName) return;
          tmap.set(payload.clipName, payload.thumbnailPath ?? null); // keeps the cache snapshot fresh
          setThumbnails((prev) => {
            const next = new Map(prev);
            next.set(payload.clipName!, payload.thumbnailPath ?? null);
            return next;
          });
        }),
      );
      unsubs.push(
        window.clips.onThumbnailProgress((payload: { current?: number; total?: number }) => {
          progressSeen = true;
          if (payload?.total != null && payload?.current != null) {
            setGeneratingCount(Math.max(0, payload.total - payload.current));
          }
        }),
      );
      // once a progress/completion event arrives it owns the count; the generation call's return goes stale
      let progressSeen = false;
      unsubs.push(window.clips.onThumbnailGenerationComplete(() => { progressSeen = true; setGeneratingCount(0); }));
      // main revalidates on startup/location change; seed the count before the first progress tick
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

      // tags below must not wait on this; cold cache takes seconds for the first thumbnail
      const missing = names.filter((n) => !tmap.get(n));
      const generation =
        missing.length > 0
          ? (window.clips.generateThumbnailsProgressively(missing).catch(() => null) as Promise<{
              needsGeneration?: number;
            } | null>)
          : null;

      // clips whose tags stay empty keep their object identity so memoized cards skip re-render
      const allTags: Record<string, string[]> = {};
      const sameTags = (a: string[], b: string[]) =>
        a.length === b.length && a.every((t, i) => t === b[i]);
      for (let i = 0; i < list.length && !cancelled; i += TAG_BATCH) {
        const slice = list.slice(i, i + TAG_BATCH);
        const sliceNames = new Set(slice.map((c) => c.originalName));
        const byName = await tagBatches[i / TAG_BATCH];
        if (cancelled) return;
        await whenCommitsAllowed();
        if (cancelled) return;
        await nextFrame(40);
        if (cancelled) return;
        // empty object means the IPC call itself failed - keep current tags
        if (Object.keys(byName).length === 0) continue;
        Object.assign(allTags, byName);
        // absent entry means "no tags", clears cached tags from the reconcile above
        setClips((prev) =>
          prev.map((c) => {
            if (!sliceNames.has(c.originalName)) return c;
            const tags = Array.isArray(byName[c.originalName]) ? byName[c.originalName] : [];
            return sameTags(c.tags, tags) ? c : { ...c, tags };
          }),
        );
      }

      requestAnimationFrame(() => bootMark("tags_loaded"));

      if (generation) {
        const res = await generation;
        if (!cancelled && !progressSeen && res?.needsGeneration) setGeneratingCount(res.needsGeneration);
      }

      // "new" flags are session-relative, stripped here; never cache an empty
      // library or a transient scan failure paints "no clips" next launch
      if (list.length > 0) {
        writeClipsCache(() => ({
          location: loc,
          clips: list.map((c) => ({
            ...c,
            tags: Array.isArray(allTags[c.originalName]) ? allTags[c.originalName] : [],
            isNewSinceLastSession: false,
          })),
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

    // reflect into the legacy player, if it's showing this clip
    const state = window.legacyState;
    if (state?.currentClip?.originalName === originalName) {
      state.currentClip.customName = newName;
      const input = document.getElementById("clip-title") as HTMLInputElement | null;
      // don't stomp the field the user is actively typing in
      if (input && document.activeElement !== input) input.value = newName;
    }
    return true;
  }, []);

  const setClipTags = useCallback((originalName: string, tags: string[]) => {
    setClips((prev) =>
      prev.map((c) => (c.originalName === originalName ? { ...c, tags } : c)),
    );
    window.clips.saveClipTags(originalName, tags).catch(() => {});
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

  // stable object identity so memoized consumers only re-render on real changes
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
