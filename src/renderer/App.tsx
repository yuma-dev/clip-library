import { useEffect, useState } from "react";

type BootState =
  | { phase: "booting" }
  | { phase: "ready"; clipCount: number; version: string; clipLocation: string }
  | { phase: "error"; message: string };

/**
 * Phase 1 skeleton shell. Its only jobs are to prove the toolchain end-to-end:
 *  - React + Tailwind v4 render,
 *  - the `window.clips` IPC facade reaches the unchanged main process, and
 *  - `rendererReady()` is signalled so the splash window dismisses.
 * The real shell (sidebar, top bar, grid) replaces this in Phase 2.
 */
export default function App() {
  const [state, setState] = useState<BootState>({ phase: "booting" });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!window.clips) {
          throw new Error("window.clips facade is not available (preload failed to load)");
        }
        const [clips, version, clipLocation] = await Promise.all([
          window.clips.getClips(),
          window.clips.getAppVersion(),
          window.clips.getClipLocation().catch(() => ""),
        ]);
        if (cancelled) return;
        setState({
          phase: "ready",
          clipCount: Array.isArray(clips) ? clips.length : 0,
          version: version ?? "",
          clipLocation: clipLocation ?? "",
        });
      } catch (err) {
        if (cancelled) return;
        setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        // Tell main the renderer is up so the splash window dismisses.
        window.clips?.rendererReady();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-6 shadow-2xl">
        <div className="mb-4 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-accent)]" />
          <h1 className="text-lg font-semibold tracking-tight">Clips — new renderer</h1>
        </div>

        {state.phase === "booting" && (
          <p className="text-sm text-[var(--color-text-secondary)]">Booting… contacting main process.</p>
        )}

        {state.phase === "ready" && (
          <dl className="space-y-2 text-sm">
            <Row label="IPC facade" value="connected" ok />
            <Row label="App version" value={state.version || "—"} />
            <Row label="Clips found" value={String(state.clipCount)} />
            <Row label="Clip location" value={state.clipLocation || "(not set)"} />
          </dl>
        )}

        {state.phase === "error" && (
          <div className="space-y-2">
            <Row label="IPC facade" value="error" />
            <p className="rounded-md bg-black/30 p-2 font-mono text-xs text-red-300">{state.message}</p>
          </div>
        )}

        <p className="mt-5 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-muted)]">
          Phase 1 scaffold. Shell, grid, and player land in later phases.
        </p>
      </div>
    </div>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-[var(--color-text-secondary)]">{label}</dt>
      <dd className={ok ? "text-green-400" : "text-[var(--color-text-primary)]"}>{value}</dd>
    </div>
  );
}
