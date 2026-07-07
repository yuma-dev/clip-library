// Per-clip game/application icon lookup (get-game-icons-batch → { path, title }).
// Cached + in-flight-deduped at module scope so a card remounting (visibility
// churn, re-filter) never re-hits IPC for an icon it already resolved.
//
// Individual loadGameIcon() calls are coalesced: when the grid mounts, every
// card requests its icon in the same tick, so we collect names for one frame
// and resolve them with a handful of batch IPC calls instead of one round trip
// per clip (2,000 concurrent get-game-icon calls used to saturate the main
// process for minutes).

export interface GameIcon {
  /** Absolute icon path, or null when the clip has no resolvable icon. */
  path: string | null;
  /** Window/game title (tooltip), or null. */
  title: string | null;
}

const EMPTY: GameIcon = { path: null, title: null };

const cache = new Map<string, GameIcon>();
const inflight = new Map<string, Promise<GameIcon>>();

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
    const obj = data as { path?: string | null; title?: string | null };
    return { path: obj.path ?? null, title: obj.title ?? null };
  }
  if (typeof data === "string") return { path: data, title: null };
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
      // One macrotask gap collects the whole mount wave into a single flush.
      setTimeout(() => void flushQueue(), 0);
    }
  });

  inflight.set(name, promise);
  return promise;
}
