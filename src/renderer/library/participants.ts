// discord participants are stamped into each clip's .gameinfo at record time
// get-clip-participants scans lazily (first search focus) into a dropdown roster + per-clip mention index

import { useSyncExternalStore } from "react";
import type { DiscordParticipant } from "./discord";
import { registerParticipants } from "./discord";

export interface Person {
  id: string;
  /** nick -> global_name -> username fallback order */
  displayName: string;
  username: string;
  /** clip count, dropdown sort order */
  count: number;
  /** feeds the avatar + hover popover */
  participant: DiscordParticipant;
}

interface RawPerson extends DiscordParticipant {
  count: number;
}

let people: Person[] = [];
/** clipName -> lowercased searchable tokens for its participants */
let mentionIndex = new Map<string, Set<string>>();
let loaded = false;
let loading = false;
/** clip count the roster was built from, triggers resync */
let builtForCount = -1;

let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const cb of listeners) cb();
}

function displayNameOf(p: DiscordParticipant): string {
  return p.nick || p.global_name || p.username || p.id;
}

function tokensOf(p: DiscordParticipant): string[] {
  return [p.nick, p.global_name, p.username, displayNameOf(p)]
    .filter((t): t is string => Boolean(t))
    .map((t) => t.toLowerCase());
}

/** no-ops mid-scan or once the roster covers this clip count; safe to call every render */
export function ensureParticipants(clipNames: string[]): void {
  if (loading) return;
  if (loaded && clipNames.length === builtForCount) return;
  if (clipNames.length === 0) return;

  loading = true;
  const forCount = clipNames.length;
  void window.clips
    .getClipParticipants(clipNames)
    .then((res) => {
      const raw: RawPerson[] = Array.isArray(res?.people) ? res.people : [];
      people = raw.map((p) => ({
        id: p.id,
        displayName: displayNameOf(p),
        username: p.username,
        count: p.count,
        participant: p,
      }));

      const index = new Map<string, Set<string>>();
      const byClip = res?.byClip ?? {};
      const byId = new Map(raw.map((p) => [p.id, p] as const));
      for (const [clipName, ids] of Object.entries(byClip)) {
        const tokens = new Set<string>();
        for (const id of ids) {
          const p = byId.get(id);
          if (p) for (const t of tokensOf(p)) tokens.add(t);
        }
        index.set(clipName, tokens);
      }
      mentionIndex = index;

      // seed the shared identity registry so hover popovers resolve before cards mount
      for (const p of raw) {
        registerParticipants({ channel_id: null, channel_name: null, guild_id: null, participants: [p] }, 0);
      }

      loaded = true;
      builtForCount = forCount;
    })
    .catch(() => {
      /* scan failed (offline/permissions) - roster stays empty, retried next call */
    })
    .finally(() => {
      loading = false;
      emit();
    });
}

export function getMentionIndex(): Map<string, Set<string>> {
  return mentionIndex;
}

export function participantsLoaded(): boolean {
  return loaded;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getVersion(): number {
  return version;
}

/** fires when the roster/index loads or refreshes */
export function useParticipantsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion);
}

export function useParticipants(): { people: Person[]; loaded: boolean } {
  useParticipantsVersion();
  return { people, loaded };
}
