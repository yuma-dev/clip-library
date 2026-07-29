// Renderer telemetry client.
//
// The renderer bundle is plain ESM (Vite) and cannot `require('electron')`, so
// everything batches here and leaves through `window.clips.telemetryReport`,
// which preload forwards on the `telemetry-report` channel. The real work
// (coalescing, disk queue, upload, opt-out) lives in main/telemetry.
//
// Rules for call sites:
//   - nothing in this module may throw into app code, so every entry point
//     swallows its own errors and returns void;
//   - context carries numbers, booleans and enum strings ONLY. No clip names,
//     file names, tag text, search queries, paths or account identifiers.
//     Error *messages* are deliberately never sent: they routinely embed the
//     file name that failed. Frames and the error name are enough to group.

import type { Route } from "../routes";
import type {
  TelemetryKind,
  TelemetryReport,
  TelemetrySeverity,
  TelemetrySurface,
  TelemetryWireEvent,
  TelemetryWireMetric,
} from "../../types/clips";

const CODE_PATTERN = /^[a-z0-9_]{3,64}$/;

const FLUSH_INTERVAL_MS = 5000;
// Same window main/telemetry uses, so a code that slips past one gate is still
// caught by the other.
const DEDUPE_WINDOW_MS = 60000;
const MAX_EVENTS_PER_SESSION = 100;
// main drops anything past these per message, so we chunk instead of losing it.
const MAX_EVENTS_PER_MESSAGE = 50;
const MAX_METRICS_PER_MESSAGE = 100;
// Backstop for a pathological loop recording metrics faster than we flush.
const MAX_PENDING_METRICS = 400;
const MAX_FRAMES = 3;
const MAX_FRAME_CHARS = 200;
const MAX_DIM_CHARS = 40;

export interface ReportEventOptions {
  kind?: TelemetryKind;
  severity?: TelemetrySeverity;
  surface?: TelemetrySurface;
  /** Numbers, booleans and enum strings only. */
  context?: Record<string, unknown>;
  /** Fills `frames` + `error_name` and derives the fingerprint. */
  error?: unknown;
  /** Grouping key; derived from code + error when omitted. */
  fingerprint?: string;
  coalesceMs?: number;
}

export interface ReportMetricOptions {
  unit?: "ms" | "bytes" | "count" | "ratio" | "mbps";
  dims?: Record<string, string | number | boolean>;
}

let pendingEvents: TelemetryWireEvent[] = [];
let pendingMetrics: TelemetryWireMetric[] = [];
let eventsThisSession = 0;
let capReported = false;
let flushTimer: number | undefined;
let installed = false;
let currentRoute: string = "library";

const lastSeen = new Map<string, number>();
// Long tasks are counted per route and drained as one sample per flush; a
// sample per task would swamp the batch during a bad frame storm.
const longTaskCounts = new Map<string, number>();

// ---------------------------------------------------------------- helpers ---

/** djb2, mirroring `hash32` in main/telemetry/index.js exactly. */
function hash32(input: string): string {
  let h = 5381;
  const s = String(input);
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Top 3 stack frames, trimmed and truncated. Never the full stack. */
export function framesOf(error: unknown): string[] {
  try {
    const stack = (error as { stack?: unknown } | null | undefined)?.stack;
    if (typeof stack !== "string") return [];
    return stack
      .split("\n")
      .slice(1, 1 + MAX_FRAMES)
      .map((line) => line.trim().slice(0, MAX_FRAME_CHARS));
  } catch {
    return [];
  }
}

function errorNameOf(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && name ? name : undefined;
}

/** Grouping key: djb2 over `code|error.name|top 3 stack frames`. */
export function fingerprint(code: string, error?: unknown): string {
  try {
    return hash32(`${code}|${errorNameOf(error) ?? ""}|${framesOf(error).join("|")}`);
  } catch {
    return hash32(code);
  }
}

/** The route every event is tagged with. App.tsx keeps this current. */
export function setTelemetryRoute(route: Route): void {
  currentRoute = route;
}

// --------------------------------------------------------------- transport ---

function transport(payload: TelemetryReport): void {
  window.clips?.telemetryReport?.(payload);
}

function drainLongTasks(): void {
  if (longTaskCounts.size === 0) return;
  for (const [route, count] of longTaskCounts) {
    pendingMetrics.push({ name: "ui.long_task_count", value: count, unit: "count", dims: { route } });
  }
  longTaskCounts.clear();
}

/** Send everything queued right now. Safe to call at any time. */
export function flushTelemetry(): void {
  try {
    if (flushTimer !== undefined) {
      window.clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    drainLongTasks();
    if (pendingEvents.length === 0 && pendingMetrics.length === 0) return;
    const events = pendingEvents;
    const metrics = pendingMetrics;
    pendingEvents = [];
    pendingMetrics = [];
    while (events.length > 0 || metrics.length > 0) {
      transport({
        events: events.splice(0, MAX_EVENTS_PER_MESSAGE),
        metrics: metrics.splice(0, MAX_METRICS_PER_MESSAGE),
      });
    }
  } catch {
    /* telemetry must never break the app */
  }
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = undefined;
    flushTelemetry();
  }, FLUSH_INTERVAL_MS);
}

// ------------------------------------------------------------------- api ---

/**
 * Record an event. Never throws, never returns anything to await.
 *
 * Same code + fingerprint inside DEDUPE_WINDOW_MS is dropped locally, so a
 * render loop cannot flood the IPC channel.
 */
export function reportEvent(code: string, opts: ReportEventOptions = {}): void {
  try {
    if (typeof code !== "string" || !CODE_PATTERN.test(code)) return;

    const fp = opts.fingerprint ?? fingerprint(code, opts.error);
    const key = `${code}|${fp}`;
    const now = Date.now();
    const seen = lastSeen.get(key);
    if (seen !== undefined && now - seen < DEDUPE_WINDOW_MS) return;
    lastSeen.set(key, now);

    if (eventsThisSession >= MAX_EVENTS_PER_SESSION) {
      // One explicit event rather than silent truncation, then nothing more.
      if (capReported) return;
      capReported = true;
      pendingEvents.push({
        code: "telemetry_renderer_cap_reached",
        kind: "custom",
        severity: "warning",
        surface: "renderer",
        context: { cap: MAX_EVENTS_PER_SESSION },
      });
      flushTelemetry();
      return;
    }
    eventsThisSession += 1;

    const severity = opts.severity ?? "error";
    const context: Record<string, unknown> = { route: currentRoute, ...opts.context };
    if (opts.error !== undefined && context.frames === undefined) {
      const frames = framesOf(opts.error);
      if (frames.length > 0) context.frames = frames;
    }
    if (opts.error !== undefined && context.error_name === undefined) {
      const name = errorNameOf(opts.error);
      if (name) context.error_name = name;
    }

    pendingEvents.push({
      code,
      kind: opts.kind ?? "error",
      severity,
      surface: opts.surface ?? "renderer",
      fingerprint: fp,
      context,
      ...(opts.coalesceMs !== undefined ? { coalesceMs: opts.coalesceMs } : {}),
    });

    // Anything at error or above goes out now: the next thing to happen may be
    // the window dying, and beforeunload does not fire on a hard crash.
    if (severity === "error" || severity === "fatal") flushTelemetry();
    else scheduleFlush();
  } catch {
    /* telemetry must never break the app */
  }
}

/** Record a metric sample. main buckets it; never send a precomputed average. */
export function reportMetric(name: string, value: number, opts: ReportMetricOptions = {}): void {
  try {
    if (typeof name !== "string" || name.length === 0) return;
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    if (pendingMetrics.length >= MAX_PENDING_METRICS) return;
    pendingMetrics.push({
      name,
      value,
      unit: opts.unit ?? "ms",
      ...(opts.dims ? { dims: opts.dims } : {}),
    });
    scheduleFlush();
  } catch {
    /* telemetry must never break the app */
  }
}

// ------------------------------------------------------------ installation ---

function installErrorHandlers(): void {
  try {
    window.addEventListener("error", (event: ErrorEvent) => {
      // Resource errors (a thumbnail 404, a video that won't load) also fire
      // here with the element as target and no Error object. Not our signal.
      if (event.target && event.target !== window) return;
      reportEvent("js_uncaught_error", { kind: "error", severity: "error", error: event.error });
    });
  } catch {
    /* ignore */
  }
  try {
    window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      reportEvent("js_unhandled_rejection", { kind: "error", severity: "error", error: event.reason });
    });
  } catch {
    /* ignore */
  }
}

function installLifecycleHooks(): void {
  try {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushTelemetry();
    });
    window.addEventListener("beforeunload", () => flushTelemetry());
  } catch {
    /* ignore */
  }
}

/**
 * Label for an interaction, from the closest `[data-perf]` ancestor. Same
 * convention as src/renderer/perf/interactions.ts, copied rather than imported:
 * that whole tree is dev-only and gets stripped from production builds.
 */
function interactionAction(entry: PerformanceEntry): string {
  try {
    const target = (entry as unknown as { target?: unknown }).target;
    if (target instanceof Element) {
      const perf = target.closest<HTMLElement>("[data-perf]")?.dataset?.perf;
      if (perf) return perf.slice(0, MAX_DIM_CHARS);
      const tag = target.tagName.toLowerCase();
      if (tag) return tag;
    }
    return entry.name || "unknown";
  } catch {
    return "unknown";
  }
}

function installPerformanceObservers(): void {
  // Entry types vary by Chromium version, so each observer is guarded on its
  // own: an unsupported one must not take the other down with it.
  try {
    const longTasks = new PerformanceObserver((list) => {
      const count = list.getEntries().length;
      if (count === 0) return;
      longTaskCounts.set(currentRoute, (longTaskCounts.get(currentRoute) ?? 0) + count);
      scheduleFlush();
    });
    longTasks.observe({ type: "longtask", buffered: true });
  } catch {
    /* longtask unsupported */
  }

  try {
    const interactions = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        reportMetric("ui.interaction_ms", Math.round(entry.duration), {
          unit: "ms",
          dims: { action: interactionAction(entry) },
        });
      }
    });
    // durationThreshold is Event Timing only and missing from the DOM lib types.
    interactions.observe({ type: "event", durationThreshold: 100, buffered: true } as PerformanceObserverInit);
  } catch {
    /* event timing unsupported */
  }
}

/** Install the global handlers, flush hooks and observers. Idempotent. */
export function initTelemetry(): void {
  try {
    if (installed) return;
    installed = true;
    installErrorHandlers();
    installLifecycleHooks();
    installPerformanceObservers();
  } catch {
    /* telemetry must never break the app */
  }
}
