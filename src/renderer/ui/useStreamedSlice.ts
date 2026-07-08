// Streamed mounting for card grids (extracted from library ClipGroup so the
// feed/profile grids share it). Mounting a card costs ~2ms (React + layout +
// paint), so a large list mounted in one commit blocks paint for seconds.
// Instead: mount a screenful immediately, then stream the rest one chunk per
// frame — time-to-content is one small commit, and no single frame does
// unbounded work.

import { useEffect, useState } from "react";

export interface StreamedSliceOptions {
  /** Mounted synchronously on first commit (default 24 — a screenful of cards). */
  initial?: number;
  /** Added per animation frame after that (default 80). */
  perFrame?: number;
}

/**
 * Returns the slice of `items` that should be mounted right now, or null while
 * `expanded` is false. Streams up to the full list across frames.
 *
 * Render-phase derived-state adjustments (callers should keep `items` identity
 * stable when membership didn't change):
 *  - collapsing resets the budget while content is unmounted, so a re-expand
 *    streams again instead of replaying one giant commit;
 *  - a shrunk list clamps the budget (never renders past the end);
 *  - a grown list keeps the current budget and streams up via the effect, so
 *    already-mounted cards are never unmounted (no flicker).
 */
export function useStreamedSlice<T>(
  items: T[],
  expanded: boolean,
  { initial = 24, perFrame = 80 }: StreamedSliceOptions = {},
): T[] | null {
  const [visible, setVisible] = useState(initial);

  const [prev, setPrev] = useState<{ items: T[]; expanded: boolean }>({ items, expanded });
  if (prev.items !== items || prev.expanded !== expanded) {
    setPrev({ items, expanded });
    if (!expanded) {
      if (visible !== initial) setVisible(initial);
    } else if (items.length < visible) {
      setVisible(Math.max(initial, items.length));
    }
  }

  useEffect(() => {
    if (!expanded || visible >= items.length) return;
    // rAF paces streaming to the display, but Chromium suspends rAF for
    // hidden/occluded windows — the timeout fallback keeps the stream
    // draining so the grid is complete when the user comes back.
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      setVisible((v) => Math.min(v + perFrame, items.length));
    };
    const raf = requestAnimationFrame(advance);
    const timer = window.setTimeout(advance, 64);
    return () => {
      advanced = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [expanded, visible, items.length, perFrame]);

  return expanded ? items.slice(0, Math.min(visible, items.length)) : null;
}
