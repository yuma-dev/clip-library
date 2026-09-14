// A short hold on the renderer's background work around the boot reveal.
//
// Measured without it (benchmark/cold-start.js, reveal frame notes): the main
// thread was mounting the rest of the 2,000-card grid at 64 cards per frame,
// 80 to 100 ms a frame, right through the reveal. That made the compositor
// miss frames of the reveal animation and delayed the window going opaque by
// 300 ms. Nothing that work produces is visible during the intro (the cards
// it mounts are below the fold), so it waits.
//
// Two levels:
//  - streaming (useStreamedSlice) is held from just before renderer-ready,
//    once the first viewport is filled, so the compositor frames a quiet
//    document;
//  - commits that touch every card (the fresh list reconcile, thumbnail
//    paths, tag batches) are held only while the animation itself plays, so a
//    fresh list that lands before the reveal still shows on the first frame.
// Any user input releases everything at once: the user's intent wins over
// the intro. A hard cap releases it regardless.

const HARD_CAP_MS = 5000;

let streamingHeld = false;
let commitsHeld = false;
let capTimer = 0;
const waiters: Array<() => void> = [];

const INPUT_EVENTS = ["wheel", "keydown", "pointerdown", "touchstart"] as const;

// A scroll wants the library to respond, not the intro to stop: it lifts the
// streaming hold and tells the reveal (which restores hover) while the
// visuals and sound play on. A press or key ends the intro so the action
// lands on a library at rest.
const scrollWaiters: Array<() => void> = [];
export function onScrollInput(cb: () => void): () => void {
  scrollWaiters.push(cb);
  return () => {
    const i = scrollWaiters.indexOf(cb);
    if (i >= 0) scrollWaiters.splice(i, 1);
  };
}

function onInput(e: Event): void {
  if (e.type === "wheel") {
    releaseStreaming();
    for (const cb of scrollWaiters.splice(0, scrollWaiters.length)) cb();
    return;
  }
  releaseBoot();
}

function flush(): void {
  const list = waiters.splice(0, waiters.length);
  for (const cb of list) cb();
}

/** Hold the card streaming (call once the first viewport is mounted). */
export function holdStreaming(): void {
  if (streamingHeld) return;
  streamingHeld = true;
  for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, { capture: true, passive: true });
  capTimer = window.setTimeout(releaseBoot, HARD_CAP_MS);
}

/** Also hold the whole-grid commits (call when the animation starts). */
export function holdCommits(): void {
  commitsHeld = true;
}

const streamWaiters: Array<() => void> = [];

// Set once main has revealed the window (with or without the intro). Before
// that, frames in the hidden window are sparse and throughput is all that
// matters, so pacing decisions wait for it.
let revealed = false;
export const markRevealed = (): void => {
  revealed = true;
};
export const isRevealed = (): boolean => revealed;

/** Lift only the streaming hold (the intro's visuals have settled; its tail
 *  may still play). Whole-grid commits keep waiting for releaseBoot. */
export function releaseStreaming(): void {
  if (!streamingHeld) return;
  streamingHeld = false;
  const list = streamWaiters.splice(0, streamWaiters.length);
  for (const cb of list) cb();
}

/** Run `cb` once streaming may resume (at once if it is not held). */
export function onStreamingRelease(cb: () => void): () => void {
  if (!streamingHeld) {
    cb();
    return () => {};
  }
  streamWaiters.push(cb);
  return () => {
    const i = streamWaiters.indexOf(cb);
    if (i >= 0) streamWaiters.splice(i, 1);
  };
}

/** Lift every hold and wake whoever waited. */
export function releaseBoot(): void {
  const wasHeld = streamingHeld || commitsHeld;
  releaseStreaming();
  streamingHeld = false;
  commitsHeld = false;
  window.clearTimeout(capTimer);
  for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput, { capture: true });
  if (wasHeld) flush();
}

export const isStreamingHeld = (): boolean => streamingHeld;
/** True from the pre-reveal hold until the intro has settled. */
export const isBootHeld = (): boolean => streamingHeld || commitsHeld;

/** Run `cb` once the hold lifts (or at once if nothing is held). Returns an unsubscribe. */
export function onBootRelease(cb: () => void): () => void {
  if (!streamingHeld && !commitsHeld) {
    cb();
    return () => {};
  }
  waiters.push(cb);
  return () => {
    const i = waiters.indexOf(cb);
    if (i >= 0) waiters.splice(i, 1);
  };
}

/** Resolves when whole-grid commits may run (immediately unless the animation plays). */
export function whenCommitsAllowed(): Promise<void> {
  if (!commitsHeld) return Promise.resolve();
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}
