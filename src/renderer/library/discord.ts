// Discord voice-call context attached to clips by the recorder (inside
// .gameinfo, surfaced through get-game-icons-batch — see main/metadata.js).
//
// Usernames/avatars change over time and each clip only snapshots the
// identities at record time, so this module also keeps a session-wide
// registry of the *latest* known identity per Discord user id: whenever a
// clip's participants load, they're registered with the clip's timestamp and
// the newest snapshot wins. Every card then renders the freshest identity we
// know of, even on old clips.

import { useSyncExternalStore } from "react";

export interface DiscordParticipant {
  /** Discord user id — the cross-clip identity key. */
  id: string;
  username: string;
  global_name: string | null;
  nick: string | null;
  bot: boolean;
  avatar_url: string | null;
}

export interface ClipDiscordInfo {
  channel_id: string | null;
  channel_name: string | null;
  guild_id: string | null;
  participants: DiscordParticipant[];
}

/** Preferred display name: server nick → global name → username. */
export function participantDisplayName(p: DiscordParticipant): string {
  return p.nick || p.global_name || p.username || p.id;
}

// ---- Latest-identity registry ----

const latest = new Map<string, { at: number; participant: DiscordParticipant }>();
let version = 0;
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getVersion(): number {
  return version;
}

/** Record a clip's participant snapshot; newer clip timestamps win per user. */
export function registerParticipants(info: ClipDiscordInfo, clipCreatedAt: number): void {
  let changed = false;
  for (const p of info.participants) {
    const existing = latest.get(p.id);
    if (!existing || clipCreatedAt > existing.at) {
      latest.set(p.id, { at: clipCreatedAt, participant: p });
      changed = true;
    }
  }
  if (changed) {
    version++;
    for (const cb of listeners) cb();
  }
}

/** Latest known identity for a participant (falls back to the snapshot itself). */
export function resolveLatest(p: DiscordParticipant): DiscordParticipant {
  return latest.get(p.id)?.participant ?? p;
}

/**
 * Re-render hook: subscribes to registry updates so a mounted card picks up a
 * fresher name/avatar when a newer clip's metadata loads later.
 */
export function useIdentityVersion(): number {
  return useSyncExternalStore(subscribe, getVersion);
}
