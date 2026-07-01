// Live grid-density tuning via the DevTools console (temporary dev aid until
// the Phase 6 settings zoom slider). Sets the `--clip-col` CSS variable that
// `.clip-group-content` uses for its column min-width, and persists the choice.
//
//   window.clipGrid.size(240)   // set column min-width in px
//   window.clipGrid.cols(6)     // approx. fit N columns in the current width
//   window.clipGrid.get()       // read current value
//   window.clipGrid.reset()     // back to default

const STORAGE_KEY = "clip-library:clip-col";
const DEFAULT_PX = 400;

function apply(px: number): void {
  document.documentElement.style.setProperty("--clip-col", `${px}px`);
}

interface ClipGridConsoleApi {
  size(px: number): number;
  cols(n: number): number;
  get(): string;
  reset(): void;
}

export function initGridDensity(): void {
  let initial = DEFAULT_PX;
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) initial = stored;
  } catch {
    /* ignore */
  }
  apply(initial);

  const api: ClipGridConsoleApi = {
    size(px: number) {
      const clamped = Math.max(120, Math.round(px));
      apply(clamped);
      try {
        localStorage.setItem(STORAGE_KEY, String(clamped));
      } catch {
        /* ignore */
      }
      // eslint-disable-next-line no-console
      console.log(`[clipGrid] column min-width = ${clamped}px`);
      return clamped;
    },
    cols(n: number) {
      const content = document.querySelector<HTMLElement>(".clip-group-content");
      const scroll = document.querySelector<HTMLElement>(".clip-scroll");
      const width = content?.clientWidth ?? (scroll ? scroll.clientWidth - 44 : window.innerWidth);
      const gap = 16;
      const px = Math.floor((width - gap * (n - 1)) / Math.max(1, n));
      return this.size(px);
    },
    get() {
      return getComputedStyle(document.documentElement).getPropertyValue("--clip-col").trim();
    },
    reset() {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      apply(DEFAULT_PX);
      // eslint-disable-next-line no-console
      console.log(`[clipGrid] reset to ${DEFAULT_PX}px`);
    },
  };

  (window as unknown as { clipGrid: ClipGridConsoleApi }).clipGrid = api;
  // eslint-disable-next-line no-console
  console.log(
    "%c[clipGrid]",
    "color:#c774e0;font-weight:bold",
    "tune density: window.clipGrid.size(240) or .cols(6); .get() / .reset()",
  );
}
