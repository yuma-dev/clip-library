// Real replacement for the legacy `window.uiBlur` (the new renderer shipped a
// no-op shim). Refcounted so overlapping consumers compose; toggles a body
// class that blurs `.app-body` (sidebar + main grid) while leaving the inline
// overlays that sit ABOVE it — the wrapped legacy player, the feed player —
// crisp. The player's open/close paths call enable()/disable() directly.
//
// Portaled React modals (Modal.tsx and friends) blur their own background via
// `.modal-backdrop { backdrop-filter }` and deliberately do NOT go through here.
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
      // Snap the blur off (no reverse transition) so it doesn't linger over the
      // player's own close animation — mirrors the legacy `ui-blur-exit` trick.
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
