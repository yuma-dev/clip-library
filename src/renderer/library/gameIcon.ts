// Per-clip game icon lookup via get-game-icons-batch (returns {path, title}).
// Cached + in-flight deduped at module scope. loadGameIcon() calls coalesce
// per tick into batch IPC calls (2,000 concurrent calls used to saturate the main process for minutes).

import type { ClipGame } from "../../types/clips";
import type { ClipDiscordInfo } from "./discord";

export interface GameIcon {
  /** Absolute icon path, or null when the clip has no resolvable icon. */
  path: string | null;
  /** Window/game title (tooltip), or null. */
  title: string | null;
  /** Discord voice-call context recorded with the clip, or null. */
  discord: ClipDiscordInfo | null;
  /** Matched game, from the recorder or the library backfill, or null. */
  game: ClipGame | null;
}

const EMPTY: GameIcon = { path: null, title: null, discord: null, game: null };

const cache = new Map<string, GameIcon>();
const inflight = new Map<string, Promise<GameIcon>>();

// persists across sessions, else every launch re-resolved ~2000 icons through 10+ IPC batches
// (startup jank). Only the game backfill changes a clip later, and it names the clips it touched.
// v3 added `game` with its art; older entries would hide it until a reinstall.
const ICON_CACHE_KEY = "clip-library:game-icons-v3";

try {
  localStorage.removeItem("clip-library:game-icons-v1");
  localStorage.removeItem("clip-library:game-icons-v2");
} catch {
  /* storage unavailable */
}

try {
  const raw = localStorage.getItem(ICON_CACHE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as Record<string, Partial<GameIcon> | null>;
    for (const [name, icon] of Object.entries(parsed)) {
      if (icon && typeof icon === "object") {
        cache.set(name, {
          path: icon.path ?? null,
          title: icon.title ?? null,
          discord: icon.discord ?? null,
          game: icon.game ?? null,
        });
      }
    }
  }
} catch {
  /* corrupt/absent snapshot just means a cold resolve this launch */
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePersist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(ICON_CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
    } catch {
      /* quota, next launch refetches */
    }
  }, 5_000);
}

// Names queued for the next batch flush, with their pending resolvers.
const queue = new Map<string, (icon: GameIcon) => void>();
let flushScheduled = false;

/** How many clip names go into a single get-game-icons-batch IPC call. */
const BATCH_SIZE = 500;

export function getCachedGameIcon(name: string): GameIcon | undefined {
  return cache.get(name);
}

// any real icon from the user's library, for previews that need an example
export function anyCachedGameIconPath(): string | null {
  for (const icon of cache.values()) if (icon.path) return icon.path;
  return null;
}

function normalize(data: unknown): GameIcon {
  if (data && typeof data === "object") {
    const obj = data as { path?: string | null; title?: string | null; discord?: ClipDiscordInfo | null; game?: ClipGame | null };
    return { path: obj.path ?? null, title: obj.title ?? null, discord: obj.discord ?? null, game: obj.game ?? null };
  }
  if (typeof data === "string") return { path: data, title: null, discord: null, game: null };
  return EMPTY;
}

async function flushQueue(): Promise<void> {
  flushScheduled = false;
  const pending = new Map(queue);
  queue.clear();
  const names = [...pending.keys()];

  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const slice = names.slice(i, i + BATCH_SIZE);
    let results: Record<string, unknown> | null = null;
    try {
      results = (await window.clips.getGameIconsBatch(slice)) ?? {};
    } catch {
      /* transient IPC failure, resolve waiters empty but don't cache, so a
         later remount retries instead of blanking 500 icons until restart */
    }
    for (const name of slice) {
      const icon = results ? normalize(results[name]) : EMPTY;
      if (results) cache.set(name, icon);
      inflight.delete(name);
      pending.get(name)?.(icon);
    }
  }
  schedulePersist();
}

export function loadGameIcon(name: string): Promise<GameIcon> {
  const cached = cache.get(name);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(name);
  if (pending) return pending;

  const promise = new Promise<GameIcon>((resolve) => {
    queue.set(name, resolve);
    if (!flushScheduled) {
      flushScheduled = true;
      // Collect a few frames of mount waves into one flush (0ms flush was one
      // IPC batch per frame); 50ms is imperceptible and cuts batch count a lot.
      setTimeout(() => void flushQueue(), 50);
    }
  });

  inflight.set(name, promise);
  return promise;
}

// mounted cards that want to hear when the backfill rewrites their clip's game
const watchers = new Map<string, Set<() => void>>();

export function watchGameIcon(name: string, cb: () => void): () => void {
  let set = watchers.get(name);
  if (!set) {
    set = new Set();
    watchers.set(name, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) watchers.delete(name);
  };
}

window.clips?.onGameInfoUpdated?.((names: string[]) => {
  if (!Array.isArray(names)) return;
  for (const name of names) {
    cache.delete(name);
    for (const cb of watchers.get(name) ?? []) cb();
  }
  schedulePersist();
});
