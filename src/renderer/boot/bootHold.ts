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

function onInput(): void {
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

/** Lift every hold and wake whoever waited. */
export function releaseBoot(): void {
  const wasHeld = streamingHeld || commitsHeld;
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
