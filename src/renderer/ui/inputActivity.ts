// When did the user last touch the app? Background work that would cost a
// frame (card streaming) yields while input is recent, so scrolling and
// typing never share a frame with it. One set of passive listeners for the
// whole renderer.
let lastInputAt = -Infinity;
let installed = false;

const EVENTS = ["wheel", "scroll", "pointerdown", "pointermove", "keydown", "touchstart"] as const;

function note(): void {
  lastInputAt = performance.now();
}

export function installInputActivity(): void {
  if (installed) return;
  installed = true;
  for (const ev of EVENTS) window.addEventListener(ev, note, { capture: true, passive: true });
}

/** True if there was input within `withinMs`. */
export function inputRecently(withinMs: number): boolean {
  return performance.now() - lastInputAt < withinMs;
}
