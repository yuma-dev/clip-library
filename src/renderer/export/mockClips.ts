// Stub `window.clips` that replays a captured fixture, so any component reaching
// into the IPC facade renders exactly as in the live app — with no Electron main
// process behind it. Unknown methods resolve to empty values; `on*` event
// subscriptions are no-ops that return a no-op unsubscribe. This is the seam that
// makes the exporter component-agnostic: the harness never needs to know WHICH
// component it renders, only which fixture to serve.

import type { ClipFixture } from "./types";

export function installMockClips(fixtures: ClipFixture[]): void {
  const byName = new Map(fixtures.map((f) => [f.clip.originalName, f]));
  const iconOf = (n: string) => byName.get(n)?.gameIcon ?? null;
  const tagsOf = (n: string) => byName.get(n)?.clip.tags ?? [];
  const thumbOf = (n: string) => byName.get(n)?.clip.thumbnailPath ?? null;
  const mapNames = <T>(names: string[], f: (n: string) => T): Record<string, T> =>
    Object.fromEntries((names ?? []).map((n) => [n, f(n)]));

  const impl: Record<string, unknown> = {
    getGameIcon: async (n: string) => iconOf(n),
    getGameIconsBatch: async (names: string[]) => mapNames(names, iconOf),
    getClipTags: async (n: string) => tagsOf(n),
    getClipTagsBatch: async (names: string[]) => mapNames(names, tagsOf),
    getThumbnailPath: async (n: string) => thumbOf(n),
    getThumbnailPathsBatch: async (names: string[]) => mapNames(names, thumbOf),
    getClips: async () => fixtures.map((f) => f.clip),
    getSettings: async () => ({}),
  };

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === "clipdip") return new Proxy({}, handler);
      if (prop.startsWith("on")) return () => () => {}; // event sub -> no-op unsub
      return async () => undefined; // any other IPC call resolves empty
    },
  };

  (window as unknown as { clips: unknown }).clips = new Proxy(impl, handler);
}
