// Feed filter state as a module-scope store: the SIDEBAR renders the filter
// controls while the feed route is active (replacing the library's
// collections/tags sections) and FeedPage derives its query + persist key from
// the same state. sessionStorage-persisted like the website (feed:filters:v1).

import { useSyncExternalStore } from "react";
import { fetchShareUsersAll } from "./api";
import type { ShareUser } from "./types";

const STORAGE_KEY = "feed:filters:v1";
export const SORTS = ["newest", "reactions", "comments"] as const;
export type FeedSort = (typeof SORTS)[number];

export interface FeedFilters {
  user?: string;
  mention?: string;
  game?: string;
  sort: FeedSort;
}

function load(): FeedFilters {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { sort: "newest" };
    const parsed = JSON.parse(raw);
    const sort = (SORTS as readonly string[]).includes(parsed?.sort) ? parsed.sort : "newest";
    return {
      user: typeof parsed?.userFilter === "string" ? parsed.userFilter : undefined,
      mention: typeof parsed?.mentionFilter === "string" ? parsed.mentionFilter : undefined,
      game: typeof parsed?.gameFilter === "string" ? parsed.gameFilter : undefined,
      sort,
    };
  } catch {
    return { sort: "newest" };
  }
}

let filters: FeedFilters = load();
// Options for the filter UI, fed from elsewhere: registered users (fetched
// once) and game names (derived from the loaded clips by FeedPage).
let users: ShareUser[] = [];
let games: string[] = [];
let usersRequested = false;

const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

function persist(): void {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        userFilter: filters.user || null,
        mentionFilter: filters.mention || null,
        gameFilter: filters.game || null,
        sort: filters.sort,
      }),
    );
  } catch {
    /* ignore quota */
  }
}

export function setFeedFilters(patch: Partial<FeedFilters>): void {
  filters = { ...filters, ...patch };
  persist();
  emit();
}

export function clearFeedFilters(): void {
  filters = { sort: "newest" };
  persist();
  emit();
}

export function hasActiveFeedFilters(f: FeedFilters = filters): boolean {
  return Boolean(f.user || f.mention || f.game || f.sort !== "newest");
}

export function getFeedFilters(): FeedFilters {
  return filters;
}

function keyPart(value?: string): string {
  return value ? encodeURIComponent(value) : "all";
}

/** Cache/persist key for a filter combination — shared by FeedPage + prefetch. */
export function feedPersistKey(f: FeedFilters = filters): string {
  return `feed:v1:u=${keyPart(f.user)}:m=${keyPart(f.mention)}:g=${keyPart(f.game)}:s=${keyPart(f.sort)}`;
}

/** FeedPage pushes the distinct game names out of the loaded clips. */
export function setFeedGames(next: string[]): void {
  if (next.length === games.length && next.every((g, i) => g === games[i])) return;
  games = next;
  emit();
}

/** Fetch the registered-users list once (for the posted-by/featuring pickers). */
export function ensureFeedUsersLoaded(): void {
  if (usersRequested) return;
  usersRequested = true;
  fetchShareUsersAll()
    .then((list) => {
      users = list;
      emit();
    })
    .catch(() => {
      usersRequested = false; // retry on next call
    });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useFeedFilters(): FeedFilters {
  return useSyncExternalStore(subscribe, () => filters);
}

export function useFeedFilterUsers(): ShareUser[] {
  return useSyncExternalStore(subscribe, () => users);
}

export function useFeedGames(): string[] {
  return useSyncExternalStore(subscribe, () => games);
}
