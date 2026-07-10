// Per-clip game/application icon lookup (get-game-icons-batch → { path, title }).
// Cached + in-flight-deduped at module scope so a card remounting (visibility
// churn, re-filter) never re-hits IPC for an icon it already resolved.
//
// Individual loadGameIcon() calls are coalesced: when the grid mounts, every
// card requests its icon in the same tick, so we collect names for one frame
// and resolve them with a handful of batch IPC calls instead of one round trip
// per clip (2,000 concurrent get-game-icon calls used to saturate the main
// process for minutes).

import type { ClipDiscordInfo } from "./discord";

export interface GameIcon {
  /** Absolute icon path, or null when the clip has no resolvable icon. */
  path: string | null;
  /** Window/game title (tooltip), or null. */
  title: string | null;
  /** Discord voice-call context recorded with the clip, or null. */
  discord: ClipDiscordInfo | null;
}

const EMPTY: GameIcon = { path: null, title: null, discord: null };

const cache = new Map<string, GameIcon>();
const inflight = new Map<string, Promise<GameIcon>>();

// Icon results are effectively immutable per clip (resolved from the game +
// Discord context recorded with it), so the whole cache — including "no icon"
// results, which are the majority — persists across sessions. Without this,
// every launch re-resolved ~2000 icons through 10+ IPC batches and re-rendered
// every visible card as answers streamed in (a chunk of the startup jank).
const ICON_CACHE_KEY = "clip-library:game-icons-v1";

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
      /* quota — next launch refetches */
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

function normalize(data: unknown): GameIcon {
  if (data && typeof data === "object") {
    const obj = data as { path?: string | null; title?: string | null; discord?: ClipDiscordInfo | null };
    return { path: obj.path ?? null, title: obj.title ?? null, discord: obj.discord ?? null };
  }
  if (typeof data === "string") return { path: data, title: null, discord: null };
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
      /* transient IPC failure — resolve waiters empty but DON'T cache, so a
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
      // Collect a few frames' worth of mount waves into one flush: cards (and
      // now groups) stream in across frames, so a 0ms flush produced one IPC
      // batch per frame. 50ms is imperceptible for icon pop-in and cuts the
      // batch count several-fold.
      setTimeout(() => void flushQueue(), 50);
    }
  });

  inflight.set(name, promise);
  return promise;
}
