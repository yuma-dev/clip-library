// Current ClipLib account (`/auth/me`), cached per session. Used to detect
// "own" content: delete-own-comment, own-profile page, isAdmin affordances.
// Invalidated on every cliplib-auth-event (login/logout).

export interface Me {
  id: string;
  discordId: string;
  username: string;
  displayName: string;
  avatarHash: string | null;
  isAdmin: boolean;
  createdAt: string;
}

let cached: Me | null = null;
let inflight: Promise<Me | null> | null = null;
let listenerInstalled = false;

function installAuthListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.clips.onCliplibAuthEvent(() => {
    cached = null;
    inflight = null;
  });
}

export function getCachedMe(): Me | null {
  return cached;
}

export function fetchMe(): Promise<Me | null> {
  installAuthListener();
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = window.clips
    .shareApiRequest({ path: "/auth/me" })
    .then((res) => {
      inflight = null;
      const data = res.success ? (res.data as Record<string, unknown> | null) : null;
      if (data && typeof data.id === "string" && !data.pending) {
        cached = data as unknown as Me;
        return cached;
      }
      return null;
    })
    .catch(() => {
      inflight = null;
      return null;
    });
  return inflight;
}
