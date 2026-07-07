// Live performance profiler — RENDERER hub (dev-only).
//
// Collects Chrome Trace Event Format objects from every renderer probe (frames,
// long tasks, IPC, React commits, interactions) onto a wall-clock-anchored
// timeline that lines up with the main process (benchmark/perf-main.js). Also
// keeps a small live-stats snapshot for the HUD, and writes the merged trace to
// disk on dump.
//
// Everything here is gated by import.meta.env.DEV at the call sites in index.ts,
// so it tree-shakes out of the packaged bundle entirely.

export interface TraceEvent {
  name: string;
  cat?: string; // omitted on metadata (ph:'M') events
  ph: "X" | "i" | "C" | "M";
  ts: number; // microseconds, wall-clock anchored
  dur?: number; // microseconds (ph:'X')
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
  s?: "g" | "p" | "t"; // scope for instant events
}

// pid/tid lanes — keep in sync with benchmark/perf-main.js.
export const PID_RENDERER = 1;
export const TID = {
  frames: 10,
  longtask: 11,
  ipc: 12,
  react: 13,
  interaction: 14,
  layout: 15,
  loaf: 16, // long animation frames (full frame: script + style/layout + paint)
} as const;

const MAX_EVENTS = 100000;

// Anchor performance.now() to wall clock, same scheme as main → comparable ts.
const EPOCH_OFFSET_MS = Date.now() - performance.now();
export const wallMs = (): number => EPOCH_OFFSET_MS + performance.now();
const toTs = (ms: number): number => Math.round(ms * 1000);

export interface LiveStats {
  fps: number;
  lastLongTaskMs: number;
  lastLongTaskAgoMs: number;
  longTaskCount: number;
  inFlightIpc: number;
  worstInteraction: { label: string; durMs: number } | null;
  eventCount: number;
  droppedFrames: number;
}

const stats: LiveStats = {
  fps: 0,
  lastLongTaskMs: 0,
  lastLongTaskAgoMs: 0,
  longTaskCount: 0,
  inFlightIpc: 0,
  worstInteraction: null,
  eventCount: 0,
  droppedFrames: 0,
};

// The whole session accumulates here (from boot). A hotkey dump snapshots it —
// startup phases + everything since, in one file. Bounded by a ring cap.
let events: TraceEvent[] = [];
let lastLongTaskAt = 0;

function push(evt: TraceEvent): void {
  events.push(evt);
  if (events.length > MAX_EVENTS) events.splice(0, Math.floor(MAX_EVENTS * 0.1));
  stats.eventCount = events.length;
}

/** A completed span with a known start + duration (in ms). */
export function span(
  name: string,
  tid: number,
  startMs: number,
  durMs: number,
  args?: Record<string, unknown>,
): void {
  push({ name, cat: "renderer", ph: "X", ts: toTs(startMs), dur: Math.max(0, Math.round(durMs * 1000)), pid: PID_RENDERER, tid, args });
}

/** A zero-width marker at "now". */
export function instant(name: string, tid: number, args?: Record<string, unknown>): void {
  push({ name, cat: "renderer", ph: "i", ts: toTs(wallMs()), pid: PID_RENDERER, tid, args, s: "t" });
}

/** A counter track (e.g. FPS, layout-shift score). */
export function counter(name: string, values: Record<string, number>, tid: number): void {
  push({ name, cat: "renderer", ph: "C", ts: toTs(wallMs()), pid: PID_RENDERER, tid, args: values });
}

// --- live-stats mutators (called by the probes) --------------------------

export function reportFps(fps: number): void {
  stats.fps = fps;
}
export function reportDroppedFrame(): void {
  stats.droppedFrames += 1;
}
export function reportLongTask(durMs: number): void {
  stats.lastLongTaskMs = durMs;
  stats.longTaskCount += 1;
  lastLongTaskAt = wallMs();
}
export function reportIpcInFlight(delta: number): void {
  stats.inFlightIpc = Math.max(0, stats.inFlightIpc + delta);
}
export function reportInteraction(label: string, durMs: number): void {
  if (!stats.worstInteraction || durMs > stats.worstInteraction.durMs) {
    stats.worstInteraction = { label, durMs };
  }
}

export function getStats(): LiveStats {
  stats.lastLongTaskAgoMs = lastLongTaskAt ? wallMs() - lastLongTaskAt : 0;
  return { ...stats };
}

export function resetStats(): void {
  stats.longTaskCount = 0;
  stats.droppedFrames = 0;
  stats.worstInteraction = null;
}

// --- process metadata + dump ---------------------------------------------

function rendererMetadata(): TraceEvent[] {
  const meta = (tid: number, name: string, key: string): TraceEvent => ({
    name: key, ph: "M", ts: 0, pid: PID_RENDERER, tid, args: { name },
  });
  return [
    meta(0, "Renderer", "process_name"),
    meta(TID.frames, "frames", "thread_name"),
    meta(TID.longtask, "long tasks", "thread_name"),
    meta(TID.ipc, "IPC (renderer)", "thread_name"),
    meta(TID.react, "React commits", "thread_name"),
    meta(TID.interaction, "interactions", "thread_name"),
    meta(TID.layout, "layout", "thread_name"),
  ];
}

/**
 * Snapshot the whole renderer session (with lane metadata) to hand to main for
 * merging into one file. NON-draining, so repeated hotkey dumps each give the
 * full session from boot. "Clear" (clearBuffer) starts a fresh window.
 */
export function snapshotForDump(): TraceEvent[] {
  return [...rendererMetadata(), ...events];
}

/** Explicitly drop buffered events — starts a fresh capture window. */
export function clearBuffer(): void {
  events = [];
  stats.eventCount = 0;
}
