// Grid navigation — port of legacy grid-navigation.js / clip-grid.js, extended
// with first-class keyboard support (legacy was gamepad-only in practice).
//
// Selection is a `grid-focused` class on one `.clip-item`; movement is
// index ±1 for left/right and a same-column linear scan for up/down (first
// card whose left edge is within one card-width of the current card's left).
// Any mouse move/press tears the focus ring down, matching the legacy
// controller-vs-mouse handoff.

const NAVIGATION_THROTTLE = 150; // ms between moves (legacy GRID_NAVIGATION_THROTTLE)

export type GridDirection = "up" | "down" | "left" | "right";

let enabled = false;
let focusIndex = 0;
let lastNavTime = 0;
let inputWatchInstalled = false;

/** The library grid, only while its keep-alive route host is visible. */
function gridEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".route-host:not(.hidden) .clip-grid");
}

/** Mounted cards in display order (collapsed groups don't mount cards). */
export function getVisibleCards(): HTMLElement[] {
  const grid = gridEl();
  return grid ? Array.from(grid.querySelectorAll<HTMLElement>(".clip-item:not(.hidden)")) : [];
}

function playerActive(): boolean {
  const overlay = document.getElementById("player-overlay");
  return Boolean(overlay && overlay.style.display === "block");
}

export function isGridNavigationEnabled(): boolean {
  return enabled;
}

function clearFocusClass(): void {
  document
    .querySelectorAll(".clip-item.grid-focused")
    .forEach((el) => el.classList.remove("grid-focused"));
}

function updateGridSelection(): void {
  const cards = getVisibleCards();
  clearFocusClass();
  const selected = cards[focusIndex];
  if (!selected) return;
  selected.classList.add("grid-focused");
  selected.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
}

/** Same-column scan: first card (by index) whose left is within one width. */
function findCardInDirection(cards: HTMLElement[], currentIndex: number, direction: "up" | "down"): number {
  const current = cards[currentIndex];
  if (!current) return currentIndex;
  const rect = current.getBoundingClientRect();
  if (direction === "up") {
    for (let i = currentIndex - 1; i >= 0; i--) {
      const r = cards[i].getBoundingClientRect();
      if (Math.abs(r.left - rect.left) < rect.width) return i;
    }
  } else {
    for (let i = currentIndex + 1; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (Math.abs(r.left - rect.left) < rect.width) return i;
    }
  }
  return currentIndex;
}

// Mouse takes over → drop the focus ring (legacy setupMouseKeyboardDetection).
function onMouseInput(): void {
  disableGridNavigation();
}
function installInputWatch(): void {
  if (inputWatchInstalled) return;
  inputWatchInstalled = true;
  document.addEventListener("mousemove", onMouseInput, { passive: true });
  document.addEventListener("mousedown", onMouseInput, { passive: true });
}
function removeInputWatch(): void {
  if (!inputWatchInstalled) return;
  inputWatchInstalled = false;
  document.removeEventListener("mousemove", onMouseInput);
  document.removeEventListener("mousedown", onMouseInput);
}

export function enableGridNavigation(): void {
  if (getVisibleCards().length === 0) return;
  enabled = true;
  focusIndex = 0;
  updateGridSelection();
  installInputWatch();
}

export function disableGridNavigation(): void {
  enabled = false;
  clearFocusClass();
  removeInputWatch();
}

export function moveGridSelection(direction: GridDirection): void {
  if (!enabled) return;
  const now = Date.now();
  if (now - lastNavTime < NAVIGATION_THROTTLE) return;
  lastNavTime = now;

  const cards = getVisibleCards();
  if (cards.length === 0) return;
  if (focusIndex >= cards.length) focusIndex = cards.length - 1;

  let next = focusIndex;
  switch (direction) {
    case "left":
      if (focusIndex > 0) next = focusIndex - 1;
      break;
    case "right":
      if (focusIndex < cards.length - 1) next = focusIndex + 1;
      break;
    case "up":
    case "down":
      next = findCardInDirection(cards, focusIndex, direction);
      break;
  }
  if (next !== focusIndex) {
    focusIndex = next;
    updateGridSelection();
  }
}

/** Open the focused clip in the player (Enter / gamepad A). */
export function openCurrentGridSelection(): void {
  if (!enabled) return;
  const selected = getVisibleCards()[focusIndex];
  const originalName = selected?.dataset.originalName;
  if (!originalName) return;
  const list = (window.legacyState?.currentClipList ?? []) as {
    originalName: string;
    customName: string;
  }[];
  const clip = list.find((c) => c.originalName === originalName);
  disableGridNavigation();
  // The wrapped openClip (VideoPlayer) attaches key handlers + marks watched.
  void window.legacyPlayer?.openClip(originalName, clip?.customName ?? originalName);
}

const ARROW_DIRECTIONS: Record<string, GridDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

let keyboardInstalled = false;

/**
 * Keyboard grid navigation (new over legacy, which was gamepad-only): arrows
 * move/summon the focus ring, Enter opens, Escape dismisses. Inactive while
 * the player overlay, a modal, or a text input has the stage.
 */
export function initGridKeyboardNavigation(): void {
  if (keyboardInstalled) return;
  keyboardInstalled = true;
  document.addEventListener("keydown", (e) => {
    if (playerActive() || isTypingTarget(e.target)) return;
    if (document.querySelector(".modal-backdrop, [role='dialog']")) return;

    const dir = ARROW_DIRECTIONS[e.key];
    if (dir) {
      if (getVisibleCards().length === 0) return;
      e.preventDefault();
      if (!enabled) enableGridNavigation();
      else moveGridSelection(dir);
    } else if (e.key === "Enter") {
      if (enabled) {
        e.preventDefault();
        openCurrentGridSelection();
      }
    } else if (e.key === "Escape") {
      if (enabled) disableGridNavigation();
    }
  });
}
