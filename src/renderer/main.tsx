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

// preloads the 45MB emoji font now, was an 80ms main-thread decode mid-flip during boot reveal
try {
  void document.fonts.load('1em "Apple Color Emoji"').then(() => bootMark("emoji_font_loaded"));
} catch {
  /* font loading API unavailable: loads on first use instead */
}

// first, so window.onerror / unhandledrejection cover the startup path too
initTelemetry();

initGridDensity();
initGlowTuner();

// dynamic import keeps the benchmark harness out of normal startup, still in renderer-dist
if (window.__benchmarkConfig?.enabled) {
  void import("./benchmark/runtime").then(({ runBenchmarks }) => runBenchmarks());
}

// mirrors main-process log lines into the renderer console (legacy `log` IPC)
window.clips?.onLog?.(({ type, message }: { type: string; message: string }) => {
  const fn = (console as unknown as Record<string, (...a: unknown[]) => void>)[type];
  (typeof fn === "function" ? fn : console.log)(`[Main Process] ${message}`);
});

// outermost so it catches a provider blowing up; shared by both root.render() sites below
const Providers = ({ children }: { children: ReactNode }) => (
  <ErrorBoundary>
    <ToastProvider>
      <ConfirmProvider>
        <SettingsProvider>{children}</SettingsProvider>
      </ConfirmProvider>
    </ToastProvider>
  </ErrorBoundary>
);

// no <React.StrictMode>: double-mounts in dev, breaking the legacy player's one-time init (D1)
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// runs only on `npm run dev:trace` (preload sets __perfEnabled via CLIPS_PERF_STARTUP=1)
const perfEnabled =
  import.meta.env.DEV && (window as unknown as { __perfEnabled?: boolean }).__perfEnabled === true;

if (perfEnabled) {
  // dynamic import keeps the profiler out of prod; renders once after it loads so App
  // isn't mounted then remounted under Profiler (would re-run the legacy player's init)
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
