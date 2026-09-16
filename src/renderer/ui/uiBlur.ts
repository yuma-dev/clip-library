// Real replacement for the legacy window.uiBlur (new renderer shipped a no-op
// shim). Refcounted so overlapping consumers compose; toggles ui-blur on body
// blurring .app-body while leaving inline overlays (legacy/feed player) crisp.
let count = 0;

function apply(): void {
  document.body.classList.toggle("ui-blur", count > 0);
}

export const uiBlur = {
  enable(): void {
    count += 1;
    if (count === 1) document.body.classList.add("ui-blur");
  },
  disable(): void {
    count = Math.max(0, count - 1);
    if (count === 0) {
      // snap off (no reverse transition) so it doesn't linger over the player's own
      // close animation, mirrors the legacy ui-blur-exit trick
      document.body.classList.add("ui-blur-exit");
      document.body.classList.remove("ui-blur");
      requestAnimationFrame(() => document.body.classList.remove("ui-blur-exit"));
    }
  },
  /** Force-clear the refcount (defensive; e.g. after an overlay is torn down). */
  reset(): void {
    count = 0;
    apply();
  },
};

/** Install the real implementation onto `window.uiBlur`, replacing the shim. */
export function installUiBlur(): void {
  (window as unknown as { uiBlur: typeof uiBlur }).uiBlur = uiBlur;
}
