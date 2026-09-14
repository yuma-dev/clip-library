// Streamed mounting for card grids (extracted from library ClipGroup so the
// feed/profile grids share it). Mounting a card costs ~2ms (React + layout +
// paint), so a large list mounted in one commit blocks paint for seconds.
// Instead: mount a screenful immediately, then stream the rest in idle time,
// each chunk sized to the idle slack the browser reports and the measured
// cost of a card, so streaming never takes a frame from anything on screen.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isStreamingHeld, onStreamingRelease } from "../boot/bootHold";

const MAX_CHUNK = 64;
// Idle callbacks report the slack left in the current frame (up to ~50 ms
// when nothing else is going on). Keep a margin for layout and paint, which
// happen after the commit and are not counted in the measurement.
const IDLE_MARGIN_MS = 3;
// Measured render-plus-commit time per card, smoothed across all lists and
// builds (the React dev build is several times slower than production).
let perCardMs = 1.5;
let measured = false;
function noteCost(cards: number, ms: number): void {
  if (cards <= 0 || ms <= 0) return;
  const sample = ms / cards;
  perCardMs = measured ? perCardMs * 0.7 + sample * 0.3 : sample;
  measured = true;
}
function chunkFor(slackMs: number, wanted: number): number {
  const fit = Math.floor((slackMs - IDLE_MARGIN_MS) / perCardMs);
  return Math.max(1, Math.min(wanted, MAX_CHUNK, fit));
}

type IdleDeadline = { timeRemaining(): number; didTimeout: boolean };
type IdleHandle = number;
const idle = {
  request(cb: (d: IdleDeadline) => void, timeout: number): IdleHandle {
    const w = window as unknown as { requestIdleCallback?: (cb: (d: IdleDeadline) => void, o?: { timeout: number }) => number };
    if (typeof w.requestIdleCallback === "function") return w.requestIdleCallback(cb, { timeout });
    // No idle API: a timer with a fixed, modest slack.
    return window.setTimeout(() => cb({ timeRemaining: () => 8, didTimeout: false }), 32) as unknown as number;
  },
  cancel(handle: IdleHandle): void {
    const w = window as unknown as { cancelIdleCallback?: (h: number) => void };
    if (typeof w.cancelIdleCallback === "function") w.cancelIdleCallback(handle);
    window.clearTimeout(handle);
  },
};

export interface StreamedSliceOptions {
  /** Mounted synchronously on first commit (default 24 — a screenful of cards). */
  initial?: number;
  /** Upper bound per idle chunk after that (default 80, capped at 64). */
  perFrame?: number;
}

/**
 * Returns the slice of `items` that should be mounted right now, or null while
 * `expanded` is false. Streams up to the full list across idle periods.
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

  // Cost measurement: the chunk that was just requested and when, read back
  // once its render has committed (layout effects run after DOM mutation).
  const pending = useRef<{ cards: number; at: number } | null>(null);
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    noteCost(p.cards, performance.now() - p.at);
  });

  useEffect(() => {
    if (!expanded || visible >= items.length) return;
    let advanced = false;
    let handle: IdleHandle = 0;
    const advance = (deadline: IdleDeadline) => {
      if (advanced) return;
      // A timed-out callback has no slack to report; take a small chunk.
      const slack = deadline.didTimeout ? IDLE_MARGIN_MS + perCardMs * 4 : deadline.timeRemaining();
      const granted = chunkFor(slack, perFrame);
      advanced = true;
      pending.current = { cards: granted, at: performance.now() };
      setVisible((v) => Math.min(v + granted, items.length));
    };
    // Idle time paces streaming to what the frame has left; the timeout
    // keeps it moving in a busy or occluded window.
    let offRelease = () => {};
    const schedule = () => {
      // The boot intro holds streaming for about a second (src/renderer/boot):
      // the cards this would mount are below the fold, and the main thread
      // must be quiet for the reveal animation to keep its frames.
      if (isStreamingHeld()) {
        offRelease = onStreamingRelease(schedule);
        return;
      }
      handle = idle.request(advance, 200);
    };
    // A hidden document (the window not shown yet, or minimized) gets no
    // frame the user can see. Mounting cards there only makes the first
    // visible frame late: at launch the renderer was still busy streaming
    // when the window appeared, and Windows showed white until it caught
    // up. Wait for visibility instead.
    const onVisibility = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onVisibility);
      schedule();
    };
    if (document.hidden) document.addEventListener("visibilitychange", onVisibility);
    else schedule();
    return () => {
      advanced = true;
      offRelease();
      idle.cancel(handle);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [expanded, visible, items.length, perFrame]);

  return expanded ? items.slice(0, Math.min(visible, items.length)) : null;
}
