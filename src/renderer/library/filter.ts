import type { LocalClip } from "./types";

// System tags the tag filter always shows alongside global tags.
export const SYSTEM_TAGS = ["Untagged", "Unnamed"] as const;

export interface TagFilterState {
  /** Persisted selection — normal (AND-exclusion) mode. */
  saved: Set<string>;
  /** Focus selection — Ctrl/indicator click, OR mode over these tags. */
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

// --- Search parsing (mirrors legacy search-manager parseSearchTerms) ---
export interface SearchTerms {
  /** `@mention` terms, kept WITH the leading `@` (matched by substring below). */
  tags: string[];
  /** Plain text words. */
  text: string[];
}

export function parseSearchTerms(raw: string): SearchTerms {
  const terms = raw.trim().toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  return {
    tags: terms.filter((t) => t.startsWith("@") && t.length > 1),
    text: terms.filter((t) => !t.startsWith("@")),
  };
}

/**
 * Dropdown tag-filter predicate (ported verbatim from legacy
 * search-manager.matchesCurrentTagFilter). With an empty selection nothing
 * shows — deselecting a tag hides every clip carrying it.
 */
export function matchesTagFilter(clip: LocalClip, tags: TagFilterState): boolean {
  const selected = activeSelection(tags);
  if (selected.size === 0) return false;

  const clipTags = Array.isArray(clip.tags) ? clip.tags : [];
  const isUntagged = clipTags.length === 0;

  // The Untagged/Unnamed system-tag visibility guards are ALWAYS governed by
  // the persisted selection, even in focus (temporary) mode — focusing a tag
  // must not hide an unnamed or untagged clip that carries it. Only the actual
  // tag-membership test below switches to the temporary set. (Legacy
  // matchesCurrentTagFilter checks state.selectedTags for these guards.)
  if (isUntagged && !tags.saved.has("Untagged")) return false;
  if (isUnnamedClip(clip) && !tags.saved.has("Unnamed")) return false;

  if (clipTags.length > 0) {
    if (tags.isTemporary) return clipTags.some((t) => tags.temporary.has(t));
    return clipTags.every((t) => selected.has(t));
  }
  return tags.saved.has("Untagged");
}

// --- Collections (quick top-level filters, ANDed with search + tags) ---
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
  tags: TagFilterState;
  collection: Collection;
  /** Skip the tag-dropdown filter until the persisted selection has loaded. */
  applyTags?: boolean;
}

/**
 * Full library filter (ported from legacy search-manager.performSearch):
 * search terms first, then — only when the user hasn't typed `@mentions` —
 * the dropdown tag filter, then the active collection. Input order is
 * preserved (clips arrive newest-first).
 */
export function filterClips(clips: LocalClip[], input: FilterInput): LocalClip[] {
  const { tags, text } = parseSearchTerms(input.query);
  const hasSearch = tags.length > 0 || text.length > 0;
  const applyTags = input.applyTags !== false;

  return clips.filter((clip) => {
    if (hasSearch) {
      const hasTags =
        tags.length === 0 ||
        tags.every((t) => clip.tags.some((ct) => ct.toLowerCase().includes(t.slice(1))));
      const hasText =
        text.length === 0 ||
        text.every(
          (w) =>
            clip.customName.toLowerCase().includes(w) ||
            clip.originalName.toLowerCase().includes(w),
        );
      if (!hasTags || !hasText) return false;
    }

    // Typing `@mentions` bypasses the dropdown exclusions for those results.
    if (applyTags && tags.length === 0 && !matchesTagFilter(clip, input.tags)) return false;

    return matchesCollection(clip, input.collection);
  });
}
