// Give the card under the pointer its hover back after a spell in which
// pointer events were off (the boot intro, a scroll). React derives
// onMouseEnter from mouseover/mouseout pairs, so a mouseover coming from
// outside the card is what a real entry would deliver.
let last: { x: number; y: number } | null = null;
let tracking = false;

function onMove(e: MouseEvent): void {
  last = { x: e.clientX, y: e.clientY };
}

/** Start remembering the pointer position (idempotent, cheap). */
export function trackPointer(): void {
  if (tracking) return;
  tracking = true;
  window.addEventListener("mousemove", onMove, { passive: true });
}

/** Re-enter whatever card sits under the last known pointer position. */
export function rehoverUnderPointer(): void {
  if (!last) return;
  const target = document.elementFromPoint(last.x, last.y);
  const card = target?.closest<HTMLElement>(".clip-item");
  if (!card) return;
  card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body, clientX: last.x, clientY: last.y }));
}
