// library grid zoom. sets `--clip-col`, the column min-width `.clip-group-content` fills with
// (feed and profile grids share it). settings.gridCardSize is the saved value; localStorage
// mirrors it so the boot snapshot lays out at the right size before settings arrive over IPC.
// the titlebar slider (shell/GridZoom.tsx) persists, this module applies and handles ctrl+wheel / ctrl+0

const STORAGE_KEY = "clip-library:clip-col";
export const GRID_SIZE_DEFAULT = 400;
export const GRID_SIZE_MIN = 220;
export const GRID_SIZE_MAX = 720;
export const GRID_SIZE_STEP = 10;
// detail is the new px; GridZoom follows it and saves
export const GRID_ZOOM_EVENT = "clip-grid-zoom";

let current = GRID_SIZE_DEFAULT;

export function getGridSize(): number {
  return current;
}

/** applies live and mirrors to localStorage, returns the clamped px */
export function applyGridSize(px: number): number {
  const next = Math.min(GRID_SIZE_MAX, Math.max(GRID_SIZE_MIN, Math.round(px)));
  current = next;
  document.documentElement.style.setProperty("--clip-col", `${next}px`);
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    /* next boot starts at default until settings load */
  }
  return next;
}

function announce(px: number): void {
  window.dispatchEvent(new CustomEvent<number>(GRID_ZOOM_EVENT, { detail: px }));
}

function libraryGridVisible(): boolean {
  return Boolean(document.querySelector(".route-host:not(.hidden) .clip-grid"));
}

export function initGridDensity(): void {
  let initial = GRID_SIZE_DEFAULT;
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) initial = stored;
  } catch {
    /* ignore */
  }
  applyGridSize(initial);

  // non-passive: chromium zooms the whole page on ctrl+wheel unless this cancels it
  document.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      const scroller = (e.target as Element | null)?.closest?.(".clip-scroll");
      if (!scroller?.querySelector(":scope > .clip-grid")) return;
      e.preventDefault();
      // exponential so a mouse notch (deltaY 100) is ~15% and trackpad pinch stays smooth
      announce(applyGridSize(current * Math.exp(-e.deltaY / 600)));
    },
    { passive: false },
  );

  // ctrl+0 is free: the app has no menu, so chromium's zoom reset shortcut is gone
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key !== "0") return;
    if (document.body.classList.contains("player-open") || !libraryGridVisible()) return;
    if ((e.target as HTMLElement | null)?.closest?.("input:not([type='range']), textarea, [contenteditable='true']")) return;
    e.preventDefault();
    announce(applyGridSize(GRID_SIZE_DEFAULT));
  });
}
