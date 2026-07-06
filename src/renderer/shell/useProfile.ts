import { useCallback, useEffect, useState } from "react";

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

/**
 * Real ClipLib account state for the rail profile card. Verifies via the
 * existing `test-share-connection` IPC and re-verifies whenever a
 * `cliplib-auth-event` fires (connect/disconnect from Settings or the flow).
 */
export function useProfile(): Profile & { connect: () => void; disconnect: () => void } {
  const [profile, setProfile] = useState<Profile>({
    connected: false,
    verifying: true,
    username: "",
    avatarUrl: "",
  });

  const refresh = useCallback(async () => {
    setProfile((p) => ({ ...p, verifying: true }));
    const result = (await window.clips
      .testShareConnection()
      .catch(() => null)) as Record<string, unknown> | null;
    if (result?.success) {
      const { username, avatarUrl } = extractProfile(result);
      setProfile({ connected: true, verifying: false, username, avatarUrl });
    } else {
      setProfile({ connected: false, verifying: false, username: "", avatarUrl: "" });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsub = window.clips.onCliplibAuthEvent(() => void refresh());
    return unsub;
  }, [refresh]);

  const connect = useCallback(() => {
    window.clips.startCliplibAuth().catch(() => {});
  }, []);

  const disconnect = useCallback(() => {
    window.clips
      .disconnectCliplibAuth()
      .catch(() => {})
      .finally(() => void refresh());
  }, [refresh]);

  return { ...profile, connect, disconnect };
}
