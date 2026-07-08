// "Everyone who's ever been in a call when you clipped" — the roster behind the
// search bar's `@mention` autocomplete and `@`-filtering.
//
// Discord participants are stamped into each clip's .gameinfo at record time;
// scanning every file on demand (get-clip-participants) yields both the deduped
// people list (dropdown) and a per-clip id index (grid filtering) in one pass.
// The scan runs once per session, lazily — triggered the first time the search
// field is focused or the library filter needs the index.

import { useSyncExternalStore } from "react";
import type { DiscordParticipant } from "./discord";
import { registerParticipants } from "./discord";

export interface Person {
  /** Discord user id — stable identity key. */
  id: string;
  /** Preferred display name (nick → global name → username). */
  displayName: string;
  username: string;
  /** How many local clips this person appears in (dropdown sort order). */
  count: number;
  /** Full snapshot — feeds the avatar + hover popover. */
  participant: DiscordParticipant;
}

interface RawPerson extends DiscordParticipant {
  count: number;
}

let people: Person[] = [];
/** clipName → lowercased searchable tokens for every participant in it. */
let mentionIndex = new Map<string, Set<string>>();
let loaded = false;
let loading = false;
/** Clip count the current roster was built from — a resync trigger. */
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

/** Lowercased tokens a `@mention` term is tested against for one participant. */
function tokensOf(p: DiscordParticipant): string[] {
  return [p.nick, p.global_name, p.username, displayNameOf(p)]
    .filter((t): t is string => Boolean(t))
    .map((t) => t.toLowerCase());
}

/**
 * Kick off (or refresh) the participant scan. Idempotent: no-ops while a scan
 * is in flight or when the roster already covers the current clip set. Safe to
 * call on every render — pass the live clip-name list.
 */
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

      // Seed the shared identity registry so hover popovers resolve names even
      // for people whose cards haven't mounted yet.
      for (const p of raw) {
        registerParticipants({ channel_id: null, channel_name: null, guild_id: null, participants: [p] }, 0);
      }

      loaded = true;
      builtForCount = forCount;
    })
    .catch(() => {
      /* scan failed (offline metadata, permissions) — leave the roster empty;
         the dropdown shows its empty state and callers retry on the next call */
    })
    .finally(() => {
      loading = false;
      emit();
    });
}

/** The current mention index (clipName → participant tokens). */
export function getMentionIndex(): Map<string, Set<string>> {
  return mentionIndex;
}

/** Whether the roster scan has resolved at least once this session. */
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

/** Re-render hook: fires when the roster / index loads or refreshes. */
export function useParticipantsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion);
}

/** People roster + load state for the `@mention` dropdown. */
export function useParticipants(): { people: Person[]; loaded: boolean } {
  useParticipantsVersion();
  return { people, loaded };
}
