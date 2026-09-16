// Renderer telemetry client: batches, then sends via window.clips.telemetryReport
// (preload forwards it on the telemetry-report IPC channel to main/telemetry).
// Context/dims: numbers, booleans, enum strings only, never names/paths/error messages.

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
// same window main/telemetry uses, so either gate catches a code the other misses
const DEDUPE_WINDOW_MS = 60000;
const MAX_EVENTS_PER_SESSION = 100;
// main drops overflow past these per message; chunk here instead of losing it
const MAX_EVENTS_PER_MESSAGE = 50;
const MAX_METRICS_PER_MESSAGE = 100;
// backstop for a pathological loop recording metrics faster than we flush
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
// counted per route, drained as one sample per flush, not one per task
const longTaskCounts = new Map<string, number>();


/** djb2, mirrors hash32 in main/telemetry/index.js */
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

/** Never throws. Same code+fingerprint within DEDUPE_WINDOW_MS is dropped locally
 * so a render loop cannot flood the IPC channel. */
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
      // one explicit cap event, then nothing more
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

    // error/fatal flush now: a hard crash never fires beforeunload
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

function installErrorHandlers(): void {
  try {
    window.addEventListener("error", (event: ErrorEvent) => {
      // resource errors (404 thumbnail, bad video) also land here with no Error object
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

/** Label from closest [data-perf] ancestor; same convention as
 * perf/interactions.ts, copied since that tree is dev-only and stripped from prod. */
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
  // each observer guarded separately: an unsupported type must not kill the other
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

/** Install handlers, flush hooks and observers once. */
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
