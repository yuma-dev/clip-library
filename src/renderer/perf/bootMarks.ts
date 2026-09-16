// boot timeline marks for benchmark/cold-start.js
// window.__bootTrace exists only under CLIPLIB_BOOT_TRACE=1 (preload.js); otherwise every
// helper here is a no-op. unlike the rest of perf/, this must work in packaged builds

declare global {
  interface Window {
    __bootTrace?: { mark: (name: string, t?: number) => void };
  }
}

export function bootMark(name: string, t?: number): void {
  if (!window.__bootTrace) return;
  window.__bootTrace.mark(name, t);
  // also a user-timing mark so a Chromium trace shares names with benchmark/analyze-trace.js
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

  // first card in the DOM, then the first real thumbnail (placeholder art is a bundled asset)
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
