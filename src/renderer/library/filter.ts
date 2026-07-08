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

// --- Search parsing ---
// Two typed prefixes drive the search: `#tag` filters by clip tag, `@user`
// filters by Discord call participant. Everything else is plain-text search.
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
    text: terms.filter((t) => !t.startsWith("#") && !t.startsWith("@")),
  };
}

/**
 * Dropdown tag-filter predicate (ported verbatim from legacy
 * search-manager.matchesCurrentTagFilter). With an empty selection nothing
 * shows — deselecting a tag hides every clip carrying it.
 */
export function matchesTagFilter(clip: LocalClip, tags: TagFilterState): boolean {
  const clipTags = Array.isArray(clip.tags) ? clip.tags : [];
  const isUntagged = clipTags.length === 0;

  // Focus mode ("only show this tag", OR over the focus set): a clip matches
  // iff it carries a focused tag. "Untagged"/"Unnamed" act as focusable
  // pseudo-tags. Crucially, the AND-exclusion Untagged/Unnamed guards below do
  // NOT apply here — focusing a real tag must show every clip carrying it,
  // including unnamed ones (freshly captured clips have no custom name yet).
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
  /**
   * clipName → lowercased participant tokens, for `@mention` filtering. When
   * omitted the roster hasn't loaded yet, so `@mention` filtering is skipped
   * (the grid stays full) until the scan resolves.
   */
  mentionIndex?: Map<string, Set<string>>;
}

/**
 * Full library filter: typed search terms first (`#tag`, `@user`, plain text),
 * then — only when the user hasn't typed a `#tag`/`@user` term — the dropdown
 * tag filter, then the active collection. Input order is preserved (clips
 * arrive newest-first).
 */
export function filterClips(clips: LocalClip[], input: FilterInput): LocalClip[] {
  const { tags, mentions, text } = parseSearchTerms(input.query);
  const hasSearch = tags.length > 0 || mentions.length > 0 || text.length > 0;
  const applyTags = input.applyTags !== false;
  const mentionIndex = input.mentionIndex;

  return clips.filter((clip) => {
    if (hasSearch) {
      const hasTags =
        tags.length === 0 ||
        tags.every((t) => clip.tags.some((ct) => ct.toLowerCase().includes(t)));
      const hasText =
        text.length === 0 ||
        text.every(
          (w) =>
            clip.customName.toLowerCase().includes(w) ||
            clip.originalName.toLowerCase().includes(w),
        );
      // `@user` matches when the clip's participants include the term. Until the
      // roster loads (mentionIndex undefined) the mention filter is a no-op, so
      // the grid stays full instead of flashing empty mid-scan.
      const hasMentions =
        mentions.length === 0 ||
        !mentionIndex ||
        (() => {
          const toks = mentionIndex.get(clip.originalName);
          if (!toks) return false;
          return mentions.every((m) => [...toks].some((t) => t.includes(m)));
        })();
      if (!hasTags || !hasText || !hasMentions) return false;
    }

    // A typed `#tag`/`@user` search bypasses the persisted dropdown exclusions.
    if (
      applyTags &&
      tags.length === 0 &&
      mentions.length === 0 &&
      !matchesTagFilter(clip, input.tags)
    )
      return false;

    return matchesCollection(clip, input.collection);
  });
}
