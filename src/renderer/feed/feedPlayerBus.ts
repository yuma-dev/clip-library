// Tiny module-scope bus decoupling clip grids from the feed player. The
// player mounts ONCE at App level and registers via `setFeedOpenHandler`;
// any grid (feed page, profile page tabs) opens a clip with `openFeedClip`,
// passing its own optimistic mutators so reactions/favorites made inside the
// player stay in sync with whichever list launched it.

import type { Clip } from "./types";

export interface FeedListSync {
  onReactionUpdate?: (clipId: string, emoji: string, action: "added" | "removed") => void;
  onFavoriteUpdate?: (clipId: string, action: "added" | "removed") => void;
}

export type FeedOpenHandler = (clip: Clip, list: Clip[], sync?: FeedListSync) => void;

let handler: FeedOpenHandler | null = null;

export function setFeedOpenHandler(fn: FeedOpenHandler | null): void {
  handler = fn;
}

export function openFeedClip(clip: Clip, list: Clip[], sync?: FeedListSync): void {
  if (handler) {
    handler(clip, list, sync);
  } else {
    console.warn("[feed] openFeedClip called but no handler is registered yet", clip.id);
  }
}
