// Per-clip game/application icon lookup (get-game-icon → { path, title }).
// Cached + in-flight-deduped at module scope so a card remounting (visibility
// churn, re-filter) never re-hits IPC for an icon it already resolved.

export interface GameIcon {
  /** Absolute icon path, or null when the clip has no resolvable icon. */
  path: string | null;
  /** Window/game title (tooltip), or null. */
  title: string | null;
}

const cache = new Map<string, GameIcon>();
const inflight = new Map<string, Promise<GameIcon>>();

export function getCachedGameIcon(name: string): GameIcon | undefined {
  return cache.get(name);
}

export async function loadGameIcon(name: string): Promise<GameIcon> {
  const cached = cache.get(name);
  if (cached) return cached;
  const pending = inflight.get(name);
  if (pending) return pending;

  const promise = (async () => {
    let result: GameIcon = { path: null, title: null };
    try {
      const data = (await window.clips.getGameIcon(name)) as
        | { path?: string | null; title?: string | null }
        | string
        | null;
      if (data && typeof data === "object") {
        result = { path: data.path ?? null, title: data.title ?? null };
      } else if (typeof data === "string") {
        result = { path: data, title: null };
      }
    } catch {
      /* leave as empty icon */
    }
    cache.set(name, result);
    inflight.delete(name);
    return result;
  })();

  inflight.set(name, promise);
  return promise;
}
