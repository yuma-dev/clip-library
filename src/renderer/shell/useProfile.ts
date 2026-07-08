import { useCallback, useSyncExternalStore } from "react";

export interface Profile {
  connected: boolean;
  verifying: boolean;
  username: string;
  avatarUrl: string;
}

function first(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Reconstruct the Discord CDN avatar URL from id + hash (legacy behavior). */
function buildDiscordAvatarUrl(discordId: string, avatarHash: string): string {
  if (!discordId || !avatarHash) return "";
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(discordId)}/${encodeURIComponent(
    avatarHash,
  )}.webp?size=64`;
}

/** Pull username/avatar out of the varied test-share-connection response shape. */
function extractProfile(result: Record<string, unknown> | null): {
  username: string;
  avatarUrl: string;
} {
  const user = (result?.user && typeof result.user === "object" ? result.user : {}) as Record<
    string,
    unknown
  >;
  const avatarUrl =
    first(user.avatarUrl, result?.avatarUrl) ||
    buildDiscordAvatarUrl(
      first(user.discordId, user.discordID, user.discord_id),
      first(user.avatarHash, user.avatar_hash, user.discordAvatarHash),
    );
  return {
    username:
      first(user.username, user.displayName, user.name, result?.displayName, user.discordId) ||
      "ClipLib User",
    avatarUrl,
  };
}

// ---- Module-scope store ----
//
// The connection state is app-global (rail profile, feed page, player upload
// button all consume it), so verify ONCE per session instead of once per
// component mount — route switches render instantly from the shared state.
// Re-verifies on every cliplib-auth-event (connect/disconnect).

let state: Profile = { connected: false, verifying: true, username: "", avatarUrl: "" };
const listeners = new Set<() => void>();
let started = false;
let refreshSeq = 0;

function emit(next: Profile): void {
  state = next;
  for (const cb of listeners) cb();
}

async function refresh(): Promise<void> {
  const seq = ++refreshSeq;
  emit({ ...state, verifying: true });
  const result = (await window.clips
    .testShareConnection()
    .catch(() => null)) as Record<string, unknown> | null;
  if (seq !== refreshSeq) return; // superseded by a newer refresh
  if (result?.success) {
    const { username, avatarUrl } = extractProfile(result);
    emit({ connected: true, verifying: false, username, avatarUrl });
  } else {
    // Logged out: drop the cached feed lists so nothing keeps the feed
    // browsable (or leaks it to a different account connected later).
    try {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith("feed:list:")) sessionStorage.removeItem(key);
      }
    } catch {
      /* ignore */
    }
    emit({ connected: false, verifying: false, username: "", avatarUrl: "" });
  }
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  void refresh();
  window.clips.onCliplibAuthEvent(() => void refresh());
}

function subscribe(cb: () => void): () => void {
  ensureStarted();
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): Profile {
  return state;
}

/**
 * Real ClipLib account state (shared module store). Verifies via the existing
 * `test-share-connection` IPC once per session and re-verifies whenever a
 * `cliplib-auth-event` fires (connect/disconnect from Settings or the flow).
 */
export function useProfile(): Profile & { connect: () => void; disconnect: () => void } {
  const profile = useSyncExternalStore(subscribe, getSnapshot);

  const connect = useCallback(() => {
    window.clips.startCliplibAuth().catch(() => {});
  }, []);

  const disconnect = useCallback(() => {
    window.clips
      .disconnectCliplibAuth()
      .catch(() => {})
      .finally(() => void refresh());
  }, []);

  return { ...profile, connect, disconnect };
}
