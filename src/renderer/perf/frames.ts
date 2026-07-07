// Frame + main-thread monitor (dev-only).
//
// Two sources of "the UI hitched":
//   1. a RAF loop measuring frame-to-frame delta — a long gap means a frame was
//      dropped (something blocked between paints);
//   2. PerformanceObserver for longtask / event-timing / layout-shift / paint —
//      attributes *why* (a long JS task, a slow event handler, layout thrash).
//
// Long frames and long tasks refresh the interaction watchdog so a slow chain
// stays attributed to the interaction that kicked it off.

import { span, instant, counter, reportFps, reportDroppedFrame, reportLongTask, TID, wallMs } from "./trace";
import { noteActivity, currentInteraction } from "./interactions";

const FRAME_BUDGET_MS = 1000 / 60; // ~16.7ms
const LONG_FRAME_MS = 50; // gap this large = a visible hitch
const FPS_REPORT_EVERY_MS = 500;

let rafId = 0;
const observers: PerformanceObserver[] = [];

function startFrameLoop(): void {
  let last = performance.now();
  let fpsWindowStart = last;
  let frames = 0;

  const tick = (now: number): void => {
    const delta = now - last;
    last = now;
    frames += 1;

    if (delta > LONG_FRAME_MS) {
      reportDroppedFrame();
      const start = wallMs() - delta;
      span(`long-frame ${Math.round(delta)}ms`, TID.frames, start, delta, {
        deltaMs: Math.round(delta),
        droppedApprox: Math.max(0, Math.round(delta / FRAME_BUDGET_MS) - 1),
        interaction: currentInteraction()?.label,
      });
      noteActivity();
    }

    const elapsed = now - fpsWindowStart;
    if (elapsed >= FPS_REPORT_EVERY_MS) {
      const fps = (frames * 1000) / elapsed;
      reportFps(Math.round(fps));
      counter("FPS", { fps: Math.round(fps) }, TID.frames);
      frames = 0;
      fpsWindowStart = now;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function observe(type: string, init: PerformanceObserverInit, cb: (entry: PerformanceEntry) => void): void {
  try {
    const obs = new PerformanceObserver((list) => list.getEntries().forEach(cb));
    obs.observe({ type, ...init } as PerformanceObserverInit);
    observers.push(obs);
  } catch {
    /* observer type unsupported in this Chromium — skip */
  }
}

function startObservers(): void {
  // Long tasks: >50ms of blocked main thread. The single biggest "where's my lag".
  observe("longtask", { buffered: true }, (e) => {
    reportLongTask(e.duration);
    span(`longtask ${Math.round(e.duration)}ms`, TID.longtask, wallMs() - e.duration, e.duration, {
      attribution: (e as unknown as { attribution?: unknown[] }).attribution?.length ?? 0,
      interaction: currentInteraction()?.label,
    });
    noteActivity();
  });

  // Event Timing: real input→handler→paint latency (click, keydown, etc.).
  observe("event", { durationThreshold: 16, buffered: true } as PerformanceObserverInit, (e) => {
    const ev = e as PerformanceEventTiming;
    span(`event:${ev.name} ${Math.round(ev.duration)}ms`, TID.interaction, wallMs() - ev.duration, ev.duration, {
      type: ev.name,
      processingMs: Math.round(ev.processingEnd - ev.processingStart),
      interaction: currentInteraction()?.label,
    });
  });

  // Layout shifts: unexpected reflow/jank (CLS-style, minus input-driven ones).
  observe("layout-shift", { buffered: true }, (e) => {
    const ls = e as unknown as { value: number; hadRecentInput: boolean };
    if (ls.hadRecentInput) return;
    counter("layout-shift", { value: Number(ls.value.toFixed(4)) }, TID.layout);
  });

  // Paints (first-paint / first-contentful-paint) — startup + route changes.
  observe("paint", { buffered: true }, (e) => {
    instant(e.name, TID.frames);
  });
}

export function startFrameMonitor(): void {
  startFrameLoop();
  startObservers();
}

export function stopFrameMonitor(): void {
  if (rafId) cancelAnimationFrame(rafId);
  observers.forEach((o) => o.disconnect());
  observers.length = 0;
}
