import "@fontsource-variable/inter";
import ReactDOM from "react-dom/client";
import type { ReactNode } from "react";
import App from "./App";
import { ToastProvider } from "./ui/Toast";
import { ConfirmProvider } from "./ui/ConfirmDialog";
import { SettingsProvider } from "./settings/SettingsContext";
import { initGridDensity } from "./library/gridDensity";
import { initGlowTuner } from "./library/glowConfig";
import { initTelemetry } from "./telemetry";
import ErrorBoundary from "./telemetry/ErrorBoundary";
import "./styles.css";
import { bootMark, initBootMarks } from "./perf/bootMarks";

initBootMarks();

// The emoji face is a 45 MB file loaded on the first emoji glyph. Left to
// itself that happened during the boot reveal animation, with its ~80 ms
// decode on the main thread mid-flip; asking for it now moves the decode into
// the quiet second before the window is shown.
try {
  void document.fonts.load('1em "Apple Color Emoji"').then(() => bootMark("emoji_font_loaded"));
} catch {
  /* font loading API unavailable: the face still loads on first use */
}

// First, so window.onerror / unhandledrejection cover the startup path too.
initTelemetry();

initGridDensity();
initGlowTuner();

// Source-level benchmarks run against the same React renderer as development.
// Dynamic loading keeps the harness out of normal startup execution while
// still including it in renderer-dist for `npm run benchmark`.
if (window.__benchmarkConfig?.enabled) {
  void import("./benchmark/runtime").then(({ runBenchmarks }) => runBenchmarks());
}

// Mirror main-process log lines into the renderer console (legacy `log` IPC).
window.clips?.onLog?.(({ type, message }: { type: string; message: string }) => {
  const fn = (console as unknown as Record<string, (...a: unknown[]) => void>)[type];
  (typeof fn === "function" ? fn : console.log)(`[Main Process] ${message}`);
});

// ErrorBoundary sits outermost so it also catches a provider blowing up, and
// so both root.render() call sites below get it without repeating themselves.
const Providers = ({ children }: { children: ReactNode }) => (
  <ErrorBoundary>
    <ToastProvider>
      <ConfirmProvider>
        <SettingsProvider>{children}</SettingsProvider>
      </ConfirmProvider>
    </ToastProvider>
  </ErrorBoundary>
);

// NOTE: no <React.StrictMode> — it double-mounts in dev, which breaks the
// wrapped legacy player's one-time imperative init against a stable DOM (D1).
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// Profiler runs ONLY on `npm run dev:trace` (preload sets window.__perfEnabled
// when CLIPS_PERF_STARTUP=1). Normal `npm run dev` skips it entirely; the
// import.meta.env.DEV guard also compile-strips it from production builds.
const perfEnabled =
  import.meta.env.DEV && (window as unknown as { __perfEnabled?: boolean }).__perfEnabled === true;

if (perfEnabled) {
  // Dynamic import keeps the profiler (and every probe it pulls in) out of the
  // production bundle. We render ONCE, after perf loads, so App isn't mounted
  // then remounted under the Profiler (which would re-run the legacy player's
  // one-time init). The native splash covers the brief wait.
  import("./perf").then(({ initPerf, PerfProfiler, PerfHud }) => {
    initPerf();
    root.render(
      <Providers>
        <PerfProfiler id="app">
          <App />
        </PerfProfiler>
        <PerfHud />
      </Providers>,
    );
  });
} else {
  root.render(
    <Providers>
      <App />
    </Providers>,
  );
}
