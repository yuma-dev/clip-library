import { useCallback, useEffect, useState } from "react";
import type { LocalClip } from "./types";

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
   * Rename a clip's custom title. Persists via IPC, updates the list, and
   * reflects the change into the open legacy player. Returns true on success.
   */
  renameClip: (originalName: string, newName: string) => Promise<boolean>;
}

/**
 * Loads the local clip library + thumbnails + tags.
 * - clips render immediately (newest-first from `get-clips`);
 * - thumbnails come from one batch call, then progressive generation events;
 * - tags load in background batches of 50 (like the legacy renderer) and fill in.
 */
export function useClips(): UseClips {
  const [clips, setClips] = useState<LocalClip[]>([]);
  const [clipLocation, setClipLocation] = useState("");
  const [loading, setLoading] = useState(true);
  const [thumbnails, setThumbnails] = useState<Map<string, string | null>>(new Map());
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
      setClips(list);
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

      const missing = names.filter((n) => !tmap.get(n));
      if (missing.length > 0) {
        const res = (await window.clips
          .generateThumbnailsProgressively(missing)
          .catch(() => null)) as { needsGeneration?: number } | null;
        if (res?.needsGeneration) setGeneratingCount(res.needsGeneration);
      }

      // --- Tags: background batches of 50, fill in progressively. ---
      const TAG_BATCH = 50;
      for (let i = 0; i < list.length && !cancelled; i += TAG_BATCH) {
        const slice = list.slice(i, i + TAG_BATCH);
        const results = await Promise.all(
          slice.map(async (c) => {
            const tags = await window.clips.getClipTags(c.originalName).catch(() => []);
            return [c.originalName, Array.isArray(tags) ? (tags as string[]) : []] as const;
          }),
        );
        if (cancelled) return;
        const byName = new Map(results);
        setClips((prev) => prev.map((c) => (byName.has(c.originalName) ? { ...c, tags: byName.get(c.originalName)! } : c)));
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

  return { clips, clipLocation, loading, thumbnails, generatingCount, removeClips, renameClip };
}
