// dev-only: wraps every window.clips.* method, timing dispatch to promise settle
// (backend latency as the frontend sees it: handler time + round-trip). pairs with
// perf-main.js timing the handler body, so spans nest and separate IPC overhead from real work

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
  // cheap only: arrays report length, skip byte-sizing big/opaque results
  if (Array.isArray(value)) return value.length;
  return undefined;
}

export function instrumentIpc(): void {
  const clips = (window as unknown as { clips?: Record<string, unknown> }).clips;
  if (!clips) return;

  for (const key of Object.keys(clips)) {
    // skip event subscriptions (onX returns an unsubscribe fn, timing is meaningless)
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
      // synchronous return, still recorded
      span(`ipc:${key}`, TID.ipc, start, wallMs() - start, { channel: key, argBytes: argBytes(args), interaction });
      return ret;
    };
  }
}
