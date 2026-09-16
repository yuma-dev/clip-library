// Streamed mounting for card grids (shared by library/feed/profile). Mounting
// a card costs real main-thread time, so a big list in one commit blocks paint
// for seconds; stream a chunk per frame instead, sized from the prior frame's cost.

import { useEffect, useState } from "react";
import { isStreamingHeld, onStreamingRelease, isRevealed } from "../boot/bootHold";
import { inputRecently, installInputActivity } from "./inputActivity";

// frame budget the streaming may use, and the chunk size bounds
const TARGET_FRAME_MS = 12;
const MIN_CHUNK = 2;
const MAX_CHUNK = 96;
// off-screen groups are skipped by content-visibility:auto before reveal, so
// mounting is cheap there: stream as fast as the timer allows
const HIDDEN_CHUNK = 160;
const HIDDEN_TICK_MS = 12;
// hold streaming this long after input so the interaction gets the frames
const INPUT_QUIET_MS = 300;

// shared across lists: chunk size + issue frame + frame slot, so two lists
// never mount in the same frame
let chunkSize = 12;
let issuedAt = -1;
let frameSlot = -1;
let frameTaken = false;

// first call after a chunk measures that chunk's frame and adapts the size
function onFrame(frameTs: number): void {
  const slot = Math.floor(frameTs / 4);
  if (slot === frameSlot) return;
  frameSlot = slot;
  frameTaken = false;
  if (issuedAt >= 0) {
    const took = frameTs - issuedAt;
    issuedAt = -1;
    // before reveal, frames are sparse (only when compositor produces one) and
    // would read as slow; throughput is all that matters there
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
  /** Mounted synchronously on first commit (default 24, a screenful of cards). */
  initial?: number;
  /** Upper bound per chunk after that (default 80, capped at 96). */
  perFrame?: number;
}

/** Slice of items to mount now, or null while collapsed. Callers keep items
 * identity stable; collapse resets the budget, shrink clamps it, grow streams up. */
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
        // another list has this frame: next frame
        raf = requestAnimationFrame(advance);
        return;
      }
      advanced = true;
      setVisible((v) => Math.min(v + granted, items.length));
    };
    // rAF paces streaming to the display; the timeout covers an occluded
    // window, where Chromium suspends rAF
    const schedule = () => {
      raf = requestAnimationFrame(advance);
      // hidden windows get few frames; the timer carries the streaming there
      timer = window.setTimeout(() => advance(performance.now()), isRevealed() ? 64 : HIDDEN_TICK_MS);
    };
    // a hidden window gets no visible frame; mounting there only delays the first
    // visible frame (windows showed white at launch while streaming caught up)
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
