// IPC instrumentation (dev-only).
//
// Wraps every window.clips.* invoke method so each call is timed from dispatch
// to promise settle — this is backend latency AS THE FRONTEND SEES IT (main
// handler time + IPC round-trip), with no cooperation needed from main. Pairs
// with perf-main.js, which times the handler body on the other side; the two
// spans nest in the flame graph so you can tell IPC overhead from real work.
//
// Each call is tagged with the active interaction and refreshes its watchdog, so
// an async chain stays attributed to the click that started it.

import { span, reportIpcInFlight, TID, wallMs } from "./trace";
import { currentInteraction, noteActivity } from "./interactions";

function argBytes(args: unknown[]): number {
  if (!args.length) return 0;
  try {
    return JSON.stringify(args).length;
  } catch {
    return -1;
  }
}

function resultSize(value: unknown): number | undefined {
  // Cheap only: arrays report length; skip byte-sizing big/opaque results.
  if (Array.isArray(value)) return value.length;
  return undefined;
}

export function instrumentIpc(): void {
  const clips = (window as unknown as { clips?: Record<string, unknown> }).clips;
  if (!clips) return;

  for (const key of Object.keys(clips)) {
    // Skip event subscriptions (onX return an unsubscribe fn — timing is
    // meaningless) and the fire-and-forget signal.
    if (key.startsWith("on") || key === "rendererReady") continue;
    const orig = clips[key];
    if (typeof orig !== "function") continue;

    clips[key] = function instrumented(...args: unknown[]) {
      const start = wallMs();
      const interaction = currentInteraction()?.label;
      noteActivity();
      let ret: unknown;
      try {
        ret = (orig as (...a: unknown[]) => unknown).apply(this, args);
      } catch (err) {
        span(`ipc:${key} (throw)`, TID.ipc, start, wallMs() - start, { channel: key, error: true, interaction });
        throw err;
      }
      if (ret && typeof (ret as Promise<unknown>).then === "function") {
        reportIpcInFlight(+1);
        return (ret as Promise<unknown>).then(
          (value) => {
            reportIpcInFlight(-1);
            span(`ipc:${key}`, TID.ipc, start, wallMs() - start, {
              channel: key, argBytes: argBytes(args), resultCount: resultSize(value), interaction,
            });
            noteActivity();
            return value;
          },
          (err) => {
            reportIpcInFlight(-1);
            span(`ipc:${key} (reject)`, TID.ipc, start, wallMs() - start, { channel: key, error: true, interaction });
            noteActivity();
            throw err;
          },
        );
      }
      // Synchronous return — still record it.
      span(`ipc:${key}`, TID.ipc, start, wallMs() - start, { channel: key, argBytes: argBytes(args), interaction });
      return ret;
    };
  }
}
