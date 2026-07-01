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
      const [loc, raw] = await Promise.all([
        window.clips.getClipLocation().catch(() => ""),
        window.clips.getClips().catch(() => []),
      ]);
      if (cancelled) return;

      const rawList: Record<string, unknown>[] = Array.isArray(raw) ? raw : [];
      const list: LocalClip[] = rawList.map((c) => ({
        originalName: String(c.originalName ?? ""),
        customName: String(c.customName ?? c.originalName ?? ""),
        createdAt: Number(c.createdAt ?? 0),
        thumbnailPath: (c.thumbnailPath as string | null) ?? null,
        isTrimmed: Boolean(c.isTrimmed),
        tags: [],
      }));

      setClipLocation(loc);
      setClips(list);
      setLoading(false);

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

  return { clips, clipLocation, loading, thumbnails, generatingCount, removeClips };
}
