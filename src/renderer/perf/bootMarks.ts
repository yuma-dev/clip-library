// Boot timeline marks for benchmark/cold-start.js.
//
// `window.__bootTrace` exists only when the app was launched with
// CLIPLIB_BOOT_TRACE=1 (preload.js installs it). Every helper here is a no-op
// otherwise, so call sites cost nothing in normal launches. Unlike the rest
// of src/renderer/perf this must work in packaged builds.

declare global {
  interface Window {
    __bootTrace?: { mark: (name: string, t?: number) => void };
  }
}

export function bootMark(name: string, t?: number): void {
  if (!window.__bootTrace) return;
  window.__bootTrace.mark(name, t);
  // Also a user-timing mark, so a Chromium trace of the launch carries the
  // same names (benchmark/analyze-trace.js aligns its windows on them).
  try {
    performance.mark(name);
  } catch {
    /* not critical */
  }
}

export function initBootMarks(): void {
  const trace = window.__bootTrace;
  if (!trace) return;
  trace.mark("renderer_script_start");

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        trace.mark(entry.name.replace(/-/g, "_"), performance.timeOrigin + entry.startTime);
      }
    });
    observer.observe({ type: "paint", buffered: true });
  } catch {
    /* paint timing unsupported */
  }

  // First card in the DOM, then the first real (cached, decoded) thumbnail.
  // Placeholder art is a bundled asset; real thumbnails live in thumbnail-cache.
  let sawCard = false;
  const poll = () => {
    const imgs = document.querySelectorAll<HTMLImageElement>(".clip-item img");
    if (!sawCard && imgs.length > 0) {
      sawCard = true;
      trace.mark("grid_first_card");
    }
    for (const img of imgs) {
      if (img.complete && img.naturalWidth > 0 && img.src.includes("thumbnail-cache")) {
        trace.mark("grid_first_thumb");
        return;
      }
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
}
