// Streamed mounting for card grids (extracted from library ClipGroup so the
// feed/profile grids share it). Mounting a card costs ~2ms (React + layout +
// paint), so a large list mounted in one commit blocks paint for seconds.
// Instead: mount a screenful immediately, then stream the rest one chunk per
// frame — time-to-content is one small commit, and no single frame does
// unbounded work.

import { useEffect, useState } from "react";
import { isStreamingHeld, onStreamingRelease, isRevealed } from "../boot/bootHold";

// Cards mounted per animation frame across ALL streaming lists. Each list
// used to take its full perFrame on its own, so when a filter cleared and
// every group streamed back at once, a single frame mounted ~2,000 cards
// (a 315 ms frame). The budget is shared per frame timestamp: the first
// lists to run in a frame get their share, the rest wait a frame.
// The budget adapts to what the machine keeps up with: a frame that arrived
// late (the previous chunk cost more than a frame) halves it, quick frames
// grow it back. 64 cards took 80 to 100 ms a frame in the launch traces,
// which is a visible stall once anything on screen is moving.
const MAX_BUDGET = 64;
const MIN_BUDGET = 8;
let frameBudget = 24;
let budgetFrame = -1;
let budgetLeft = 0;
let lastFrameTs = -1;
function takeBudget(frameTs: number, wanted: number): number {
  // Callbacks of one frame share a timestamp; timer-driven ones (occluded
  // window) do not, so quantize to ~8 ms slots for the budget to hold there.
  const slot = Math.floor(frameTs / 8);
  if (slot !== budgetFrame) {
    // Only once the window is on screen: hidden-window frames are sparse
    // and would read as slow ones, throttling the fill of the first viewport.
    if (lastFrameTs >= 0 && isRevealed()) {
      const delta = frameTs - lastFrameTs;
      if (delta > 24) frameBudget = Math.max(MIN_BUDGET, Math.floor(frameBudget / 2));
      else if (delta < 12) frameBudget = Math.min(MAX_BUDGET, frameBudget + 8);
    }
    lastFrameTs = frameTs;
    budgetFrame = slot;
    budgetLeft = frameBudget;
  }
  const granted = Math.min(wanted, budgetLeft);
  budgetLeft -= granted;
  return granted;
}

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
    let advanced = false;
    let raf = 0;
    let timer = 0;
    const advance = (frameTs: number) => {
      if (advanced) return;
      const granted = takeBudget(frameTs, perFrame);
      if (granted <= 0) {
        // Budget spent by other lists this frame: try again next frame.
        raf = requestAnimationFrame(advance);
        return;
      }
      advanced = true;
      setVisible((v) => Math.min(v + granted, items.length));
    };
    // rAF paces streaming to the display; the timeout fallback covers an
    // occluded window, where Chromium suspends rAF.
    let offRelease = () => {};
    const schedule = () => {
      // The boot reveal holds streaming for about a second (src/renderer/boot):
      // the cards this would mount are below the fold, and the main thread
      // must be quiet for the reveal animation to keep its frames.
      if (isStreamingHeld()) {
        offRelease = onStreamingRelease(schedule);
        return;
      }
      raf = requestAnimationFrame(advance);
      timer = window.setTimeout(() => advance(performance.now()), 64);
    };
    // A hidden document (the window not shown yet, or minimized) gets no
    // frame the user can see. Mounting cards there only makes the first
    // visible frame late: at launch the renderer was still busy streaming
    // when the window appeared, and Windows showed white until it caught
    // up. Wait for visibility instead.
    const onVisibility = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVisibility);
      schedule();
    };
    if (document.hidden) document.addEventListener('visibilitychange', onVisibility);
    else schedule();
    return () => {
      advanced = true;
      offRelease();
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [expanded, visible, items.length, perFrame]);

  return expanded ? items.slice(0, Math.min(visible, items.length)) : null;
}
