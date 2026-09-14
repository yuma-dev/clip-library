// Streamed mounting for card grids (extracted from library ClipGroup so the
// feed/profile grids share it). Mounting a card costs real main-thread time
// (React, then the layout, paint and compositing pass that follows the
// commit), so a large list mounted in one commit blocks paint for seconds.
// Instead: mount a screenful immediately, then stream the rest one chunk per
// animation frame, sized by feedback from the frame itself (the frame after
// a chunk tells how long the chunk really took, follow-up work included),
// and never while the user is interacting: a chunk that lands between two
// scroll frames costs the next one a layout and a compositing pass of the
// whole grid.

import { useEffect, useState } from "react";
import { isStreamingHeld, onStreamingRelease, isRevealed } from "../boot/bootHold";
import { inputRecently, installInputActivity } from "./inputActivity";

// Frame time the streaming may take a frame up to, and the chunk bounds.
const TARGET_FRAME_MS = 12;
const MIN_CHUNK = 2;
const MAX_CHUNK = 96;
// Before the window is on screen nothing is visible and offscreen groups are
// skipped by the browser (content-visibility: auto), so mounting is cheap:
// stream as fast as the timer allows and be done before the reveal.
const HIDDEN_CHUNK = 160;
const HIDDEN_TICK_MS = 12;
// After input, hold streaming this long so the interaction has the frames.
const INPUT_QUIET_MS = 300;

// Shared across lists: the chunk size, the frame it was issued in, and the
// frame slot so several lists never mount in the same frame.
let chunkSize = 12;
let issuedAt = -1;
let frameSlot = -1;
let frameTaken = false;

// Called on every frame a list gets to consider: the first call after a chunk
// measures that chunk's frame and adapts.
function onFrame(frameTs: number): void {
  const slot = Math.floor(frameTs / 4);
  if (slot === frameSlot) return;
  frameSlot = slot;
  frameTaken = false;
  if (issuedAt >= 0) {
    const took = frameTs - issuedAt;
    issuedAt = -1;
    // Before the window is on screen its frames are sparse (they come only
    // when the compositor produces one), which would read as slow ones;
    // throughput is all that matters there.
    if (!isRevealed()) return;
    if (took > TARGET_FRAME_MS * 1.5) chunkSize = Math.max(MIN_CHUNK, Math.floor(chunkSize * 0.6));
    else if (took > TARGET_FRAME_MS) chunkSize = Math.max(MIN_CHUNK, Math.floor(chunkSize * 0.85));
    else if (took < TARGET_FRAME_MS * 0.7) chunkSize = Math.min(MAX_CHUNK, Math.ceil(chunkSize * 1.3));
  }
}

function takeFrame(frameTs: number, wanted: number): number {
  if (frameTaken) return 0;
  frameTaken = true;
  issuedAt = frameTs;
  return Math.max(MIN_CHUNK, Math.min(isRevealed() ? Math.min(wanted, chunkSize) : HIDDEN_CHUNK));
}

export interface StreamedSliceOptions {
  /** Mounted synchronously on first commit (default 24 — a screenful of cards). */
  initial?: number;
  /** Upper bound per chunk after that (default 80, capped at 96). */
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
    installInputActivity();
    let advanced = false;
    let raf = 0;
    let timer = 0;
    let offRelease = () => {};
    const advance = (frameTs: number) => {
      if (advanced) return;
      if (isStreamingHeld()) {
        offRelease = onStreamingRelease(schedule);
        return;
      }
      onFrame(frameTs);
      if (isRevealed() && inputRecently(INPUT_QUIET_MS)) {
        raf = requestAnimationFrame(advance);
        return;
      }
      const granted = takeFrame(frameTs, perFrame);
      if (granted <= 0) {
        // Another list has this frame: next frame.
        raf = requestAnimationFrame(advance);
        return;
      }
      advanced = true;
      setVisible((v) => Math.min(v + granted, items.length));
    };
    // rAF paces streaming to the display; the timeout fallback covers an
    // occluded window, where Chromium suspends rAF.
    const schedule = () => {
      raf = requestAnimationFrame(advance);
      // Hidden windows get few frames; the timer carries the streaming there.
      timer = window.setTimeout(() => advance(performance.now()), isRevealed() ? 64 : HIDDEN_TICK_MS);
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
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [expanded, visible, items.length, perFrame]);

  return expanded ? items.slice(0, Math.min(visible, items.length)) : null;
}
