import type { LocalClip } from "../library/types";

export interface BenchmarkContext {
  getClips(): LocalClip[];
  getFilteredClips(): LocalClip[];
  isLoading(): boolean;
  getQuery(): string;
  setQuery(value: string): void;
}

let current: BenchmarkContext | null = null;

export function setBenchmarkContext(context: BenchmarkContext): void {
  // Keep object identity stable: the runtime may already hold this bridge
  // while React replaces the closures on a later render.
  if (current) Object.assign(current, context);
  else current = context;
}

export function getBenchmarkContext(): BenchmarkContext | null {
  return current;
}
