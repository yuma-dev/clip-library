// overlap between discord participant ids and registered ClipLib share-server accounts
// fetched lazily once per session via get-share-users; empty map when not connected, same as no match

export interface ShareUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  /** discord id linked to this account, when the server exposes it */
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
        /* not connected/offline - no matches this session */
      }
    })();
  }
  return loadPromise;
}

export function getShareUserForDiscordId(discordId: string): ShareUser | null {
  return byDiscordId.get(discordId) ?? null;
}
