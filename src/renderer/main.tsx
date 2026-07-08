import "@fontsource-variable/inter";
import ReactDOM from "react-dom/client";
import type { ReactNode } from "react";
import App from "./App";
import { ToastProvider } from "./ui/Toast";
import { ConfirmProvider } from "./ui/ConfirmDialog";
import { SettingsProvider } from "./settings/SettingsContext";
import { initGridDensity } from "./library/gridDensity";
import { initGlowTuner } from "./library/glowConfig";
import "./styles.css";

initGridDensity();
initGlowTuner();

// Mirror main-process log lines into the renderer console (legacy `log` IPC).
window.clips?.onLog?.(({ type, message }: { type: string; message: string }) => {
  const fn = (console as unknown as Record<string, (...a: unknown[]) => void>)[type];
  (typeof fn === "function" ? fn : console.log)(`[Main Process] ${message}`);
});

const Providers = ({ children }: { children: ReactNode }) => (
  <ToastProvider>
    <ConfirmProvider>
      <SettingsProvider>{children}</SettingsProvider>
    </ConfirmProvider>
  </ToastProvider>
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
