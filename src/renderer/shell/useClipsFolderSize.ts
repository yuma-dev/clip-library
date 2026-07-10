import { useEffect, useState } from "react";

const POLL_MS = 5 * 60 * 1000; // 5 min — main caches for 4 min, so most polls are cheap.

/** Format a byte count as a compact human string, e.g. "12.4 GB". */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${Math.round(value)} ${units[i]}`;
}

/**
 * Disk footprint (bytes) of the clip folder, or null until first fetched.
 *
 * Deliberately lazy: the first fetch is deferred to browser idle so it never
 * competes with startup, then it refreshes on a slow interval. Nothing depends
 * on this value, and the main process caches the walk — so it costs almost
 * nothing and never touches the render hot path.
 */
export function useClipsFolderSize(): number | null {
  const [bytes, setBytes] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchSize = () => {
      window.clips
        .getClipsFolderSize()
        .then((res) => {
          if (!cancelled && typeof res?.bytes === "number") setBytes(res.bytes);
        })
        .catch(() => {});
    };

    // Defer the first fetch to idle so it stays clear of the startup scan.
    const useIdle = typeof window.requestIdleCallback === "function";
    const idle = useIdle
      ? window.requestIdleCallback(fetchSize, { timeout: 10_000 })
      : window.setTimeout(fetchSize, 8_000);

    const interval = window.setInterval(fetchSize, POLL_MS);

    return () => {
      cancelled = true;
      if (useIdle) window.cancelIdleCallback(idle as number);
      else window.clearTimeout(idle as number);
      window.clearInterval(interval);
    };
  }, []);

  return bytes;
}
