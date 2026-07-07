// Overlap between Discord participant ids and registered ClipLib (share
// server) accounts. Fetched lazily once per session via the existing
// get-share-users IPC; resolves to an empty map when the share account isn't
// connected, so callers can treat "no match" and "not connected" the same.

export interface ShareUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  /** Discord user id linked to the ClipLib account, when the server exposes it. */
  discordId: string | null;
}

const byDiscordId = new Map<string, ShareUser>();
let loadPromise: Promise<void> | null = null;

export function loadShareUsers(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const result = (await window.clips.getShareUsers()) as
          | { success?: boolean; users?: ShareUser[] }
          | null;
        if (result?.success && Array.isArray(result.users)) {
          for (const user of result.users) {
            if (user.discordId) byDiscordId.set(user.discordId, user);
          }
        }
      } catch {
        /* not connected / offline — no matches this session */
      }
    })();
  }
  return loadPromise;
}

export function getShareUserForDiscordId(discordId: string): ShareUser | null {
  return byDiscordId.get(discordId) ?? null;
}
