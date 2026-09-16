// dev-only: wraps the app in React's <Profiler>; commits over the threshold become spans
// on the "React commits" lane so an expensive re-render shows up next to the long frame it caused

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";
import { span, TID, wallMs } from "./trace";
import { currentInteraction } from "./interactions";

const COMMIT_THRESHOLD_MS = 3; // ignore trivial commits to keep the trace legible

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration) => {
  if (actualDuration < COMMIT_THRESHOLD_MS) return;
  span(`<${id}> ${phase}`, TID.react, wallMs() - actualDuration, actualDuration, {
    phase,
    actualMs: Number(actualDuration.toFixed(2)),
    baseMs: Number(baseDuration.toFixed(2)),
    interaction: currentInteraction()?.label,
  });
};

export function PerfProfiler({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
