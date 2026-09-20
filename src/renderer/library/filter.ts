import { monthsBefore, shuffleSettings } from "./shuffle";
import type { LocalClip } from "./types";

// System tags the tag filter always shows alongside global tags.
export const SYSTEM_TAGS = ["Untagged", "Unnamed"] as const;

export interface TagFilterState {
  /** Persisted selection, normal (AND-exclusion) mode. */
  saved: Set<string>;
  /** Focus selection, Ctrl/indicator click, OR mode over these tags. */
  temporary: Set<string>;
  /** When true, `temporary` drives filtering instead of `saved`. */
  isTemporary: boolean;
}

/** The effective selection set for the current mode. */
export function activeSelection(tags: TagFilterState): Set<string> {
  return tags.isTemporary ? tags.temporary : tags.saved;
}

/** A clip is "unnamed" when its custom name still equals the bare file name. */
export function isUnnamedClip(clip: LocalClip): boolean {
  const base = clip.originalName.replace(/\.[^/.]+$/, "");
  return clip.customName === base;
}

// Typed prefixes drive search (? controls shuffle): `#tag` filters clip tag, `@user` filters
// Discord call participant; everything else is plain text.
export interface SearchTerms {
  /** `#tag` terms, WITHOUT the leading `#` (lowercased). */
  tags: string[];
  /** `@user` terms, WITHOUT the leading `@` (lowercased). */
  mentions: string[];
  /** Plain text words. */
  text: string[];
}

export function parseSearchTerms(raw: string): SearchTerms {
  const terms = raw.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  return {
    tags: terms.filter((t) => t.startsWith("#") && t.length > 1).map((t) => t.slice(1)),
    mentions: terms.filter((t) => t.startsWith("@") && t.length > 1).map((t) => t.slice(1)),
    text: terms.filter((t) => !t.startsWith("#") && !t.startsWith("@") && !t.startsWith("?")),
  };
}

/** Ported verbatim from legacy search-manager.matchesCurrentTagFilter: with
 * an empty selection nothing shows, deselecting a tag hides every clip carrying it. */
// Both clip metadata and selection sets are immutable in the library hook.
const tagMatchCache = new WeakMap<TagFilterState, WeakMap<LocalClip, boolean>>();
export function matchesTagFilter(clip: LocalClip, tags: TagFilterState): boolean {
  let cache = tagMatchCache.get(tags);
  if (!cache) { cache = new WeakMap(); tagMatchCache.set(tags, cache); }
  const cached = cache.get(clip);
  if (cached !== undefined) return cached;
  const matches = computeTagMatch(clip, tags);
  cache.set(clip, matches);
  return matches;
}

function computeTagMatch(clip: LocalClip, tags: TagFilterState): boolean {
  const clipTags = Array.isArray(clip.tags) ? clip.tags : [];
  const isUntagged = clipTags.length === 0;

  // Focus mode (OR over the focus set): "Untagged"/"Unnamed" are focusable
  // pseudo-tags, and the AND-exclusion guards below don't apply here.
  if (tags.isTemporary) {
    const focus = tags.temporary;
    if (focus.size === 0) return false;
    if (isUntagged && focus.has("Untagged")) return true;
    if (isUnnamedClip(clip) && focus.has("Unnamed")) return true;
    return clipTags.some((t) => focus.has(t));
  }

  // Persisted AND-exclusion mode: with an empty selection nothing shows, and
  // deselecting any tag a clip carries hides that clip.
  const selected = tags.saved;
  if (selected.size === 0) return false;
  if (isUntagged && !selected.has("Untagged")) return false;
  if (isUnnamedClip(clip) && !selected.has("Unnamed")) return false;
  if (clipTags.length > 0) return clipTags.every((t) => selected.has(t));
  return selected.has("Untagged");
}

// collections: quick top-level filters, ANDed with search + tags
export type Collection = "all" | "new" | "untagged" | "trimmed";

export function matchesCollection(clip: LocalClip, collection: Collection): boolean {
  switch (collection) {
    case "new":
      return Boolean(clip.isNewSinceLastSession);
    case "untagged":
      return clip.tags.length === 0;
    case "trimmed":
      return Boolean(clip.isTrimmed);
    default:
      return true;
  }
}

export interface FilterInput {
  query: string;
  /** Reference time for relative shuffle exclusions. */
  now?: number;
  tags: TagFilterState;
  collection: Collection;
  /** Skip the tag-dropdown filter until the persisted selection has loaded. */
  applyTags?: boolean;
  /** clipName to lowercased participant tokens; omitted means the roster
   * hasn't loaded, so `@mention` filtering is skipped until the scan resolves. */
  mentionIndex?: Map<string, Set<string>>;
}

// Clip objects are replaced by useClips when names/tags change. Weak keys let
// old snapshots be collected and avoid lowercasing the library on every keypress.
const searchCache = new WeakMap<LocalClip, { name: string; original: string; tags: string[] }>();
function searchable(clip: LocalClip) {
  let entry = searchCache.get(clip);
  if (!entry) {
    entry = { name: clip.customName.toLowerCase(), original: clip.originalName.toLowerCase(), tags: clip.tags.map((t) => t.toLowerCase()) };
    searchCache.set(clip, entry);
  }
  return entry;
}

/** Search intersects saved/focus filters, except an explicit #tag overrides them.
 * Input order is preserved, including a precomputed shuffle order. */
export function filterClips(clips: LocalClip[], input: FilterInput): LocalClip[] {
  const { tags, mentions, text } = parseSearchTerms(input.query);
  const shuffle = shuffleSettings(input.query);
  const cutoff = shuffle.months > 0 ? monthsBefore(input.now ?? Date.now(), shuffle.months) : null;
  const applyTags = input.applyTags !== false && tags.length === 0;
  const mentionIndex = input.mentionIndex;
  const result: LocalClip[] = [];

  clipLoop: for (const clip of clips) {
    if (cutoff !== null && !(clip.createdAt < cutoff)) continue;
    if (!matchesCollection(clip, input.collection)) continue;
    if (applyTags && !matchesTagFilter(clip, input.tags)) continue;
    if (text.length || tags.length) {
      const entry = searchable(clip);
      for (const word of text) {
        if (!entry.name.includes(word) && !entry.original.includes(word)) continue clipLoop;
      }
      for (const tag of tags) {
        if (!entry.tags.some((t) => t.includes(tag))) continue clipLoop;
      }
    }
    // The roster scan is asynchronous; preserve the existing loading behavior.
    if (mentions.length && mentionIndex) {
      const tokens = mentionIndex.get(clip.originalName);
      if (!tokens) continue;
      for (const mention of mentions) {
        let found = false;
        for (const token of tokens) {
          if (token.includes(mention)) { found = true; break; }
        }
        if (!found) continue clipLoop;
      }
    }
    result.push(clip);
  }
  // No-op queries (e.g. typing a partial ? command) must not reconcile the grid.
  return result.length === clips.length ? clips : result;
}
