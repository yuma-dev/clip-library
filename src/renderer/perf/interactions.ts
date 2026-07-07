// Interaction correlation (dev-only).
//
// The point: "opening a clip felt slow" should resolve into the whole causal
// chain — the click, the get-clip-info / extract-audio-tracks IPC it triggered,
// the long tasks, the first paint — not a scatter of unrelated numbers.
//
// We open a span on user input (or a manual mark()) and keep it open until
// things go QUIET: any IPC call or long frame refreshes a watchdog; when nothing
// happens for SETTLE_MS, the span closes. That captures async chains a fixed
// "one paint later" span would miss, while still ending on its own. A hard cap
// stops a runaway (e.g. a background poll) from holding it open forever.

import { span, reportInteraction, TID, wallMs } from "./trace";

const SETTLE_MS = 400; // quiet period that ends an interaction
const MAX_MS = 8000; // safety cap

interface Interaction {
  id: number;
  label: string;
  startMs: number;
}

let current: Interaction | null = null;
let seq = 0;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let hardTimer: ReturnType<typeof setTimeout> | null = null;

export function currentInteraction(): Interaction | null {
  return current;
}

function close(): void {
  if (!current) return;
  const dur = wallMs() - current.startMs;
  span(`⟶ ${current.label}`, TID.interaction, current.startMs, dur, { label: current.label });
  reportInteraction(current.label, dur);
  current = null;
  if (settleTimer) clearTimeout(settleTimer);
  if (hardTimer) clearTimeout(hardTimer);
  settleTimer = null;
  hardTimer = null;
}

/** Begin (or relabel) the active interaction. A fresh label starts a new span. */
export function beginInteraction(label: string): void {
  if (current && current.label !== label) close();
  if (!current) {
    current = { id: ++seq, label, startMs: wallMs() };
    hardTimer = setTimeout(close, MAX_MS);
  }
  noteActivity();
}

/** Refresh the settle watchdog — called by the IPC + frame probes. */
export function noteActivity(): void {
  if (!current) return;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(close, SETTLE_MS);
}

/** Auto-open interactions from raw user input, labelled by the target. */
export function startInteractionTracker(): void {
  const label = (e: Event): string => {
    const t = e.target as HTMLElement | null;
    if (!t || !t.closest) return e.type;
    const el = t.closest<HTMLElement>("[data-perf], button, a, [role='button'], .clip-card, input, textarea");
    const name = el?.dataset?.perf || el?.getAttribute("aria-label") || el?.className?.toString().split(" ")[0] || el?.tagName?.toLowerCase() || "unknown";
    return `${e.type}:${name}`;
  };
  const onInput = (e: Event): void => beginInteraction(label(e));
  window.addEventListener("pointerdown", onInput, { capture: true });
  window.addEventListener("keydown", onInput, { capture: true });
}
