// which game each clip is from, and the library's game list for the rail and the Set game
// picker. one get-library-games scan per clip count, rerun when the backfill or a manual pick
// rewrites a clip's game.

import { useSyncExternalStore } from "react";
import type { LibraryGame } from "../../types/clips";

export type { LibraryGame };

let games: LibraryGame[] = [];
/** game id per clip */
let byClip = new Map<string, string>();
/** lowercased game name per clip, for plain-text search */
let nameIndex = new Map<string, string>();
let loading = false;
let builtFor: string[] | null = null;
let dirty = true;

let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const cb of listeners) cb();
}

/** no-op while a scan runs or when the list is current; safe to call every render */
export function ensureGames(clipNames: string[]): void {
  if (loading || clipNames.length === 0) return;
  if (!dirty && builtFor && builtFor.length === clipNames.length) return;
  loading = true;
  dirty = false;
  const names = clipNames;
  void window.clips
    .getLibraryGames(names)
    .then((res) => {
      games = Array.isArray(res?.games) ? res.games : [];
      byClip = new Map(Object.entries(res?.byClip ?? {}));
      const nameOf = new Map(games.map((g) => [g.id, g.name.toLowerCase()] as const));
      nameIndex = new Map();
      for (const [clip, id] of byClip) {
        const n = nameOf.get(id);
        if (n) nameIndex.set(clip, n);
      }
      builtFor = names;
    })
    .catch(() => {
      dirty = true;
    })
    .finally(() => {
      loading = false;
      emit();
    });
}

window.clips?.onGameInfoUpdated?.(() => {
  dirty = true;
  if (builtFor) ensureGames(builtFor);
});

export function getGameOfClip(): Map<string, string> {
  return byClip;
}

export function getGameNameIndex(): Map<string, string> {
  return nameIndex;
}

export function getLibraryGames(): LibraryGame[] {
  return games;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getVersion(): number {
  return version;
}

export function useGamesVersion(): number {
  return useSyncExternalStore(subscribe, getVersion);
}

export function useLibraryGames(): LibraryGame[] {
  useGamesVersion();
  return games;
}

/** gamedb art is the 512px version Discord presence wants; lists show it at 16-30px. decoding and
 * uploading 512px pngs for a grid of cards stalled the boot reveal, the cdn sizes it for us */
export function listIconUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.startsWith("https://cdn.discordapp.com/") ? url.replace(/([?&]size=)\d+/, (_, key: string) => `${key}64`) : url;
}

/** art when there is some, else the exe icon clipdip saved */
export function gameIconSrc(g: { icon_url: string | null; iconPath?: string | null }): string | null {
  if (g.icon_url) return listIconUrl(g.icon_url);
  if (g.iconPath) return `file://${g.iconPath}`;
  return null;
}
