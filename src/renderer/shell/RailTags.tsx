import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { UseLibraryFilter } from "../library/useLibraryFilter";

interface RailTagsProps {
  filter: UseLibraryFilter;
}

/**
 * The liked purple tag-filter system, rehomed from the legacy dropdown into the
 * rail (plan §5, "keep this"). Visual model ported verbatim from the legacy
 * `.tagv2-item`: a right-edge bar marks inclusion; normal click toggles a tag in
 * the persisted AND-exclusion set; Ctrl-click or the bar focuses a single tag
 * (temporary "only show this tag" OR mode).
 *
 * Only the tag LIST scrolls — the section header, search and show/hide actions
 * stay pinned, and the list fades out at the bottom instead of hard-cutting.
 */
export default function RailTags({ filter }: RailTagsProps) {
  const [tagQuery, setTagQuery] = useState("");
  const { tags, globalTags, selectedCount, totalCount } = filter;

  const q = tagQuery.trim().toLowerCase();
  const systemTags = ["Untagged", "Unnamed"].filter((t) => t.toLowerCase().includes(q));
  const shownGlobal = useMemo(() => {
    const list = globalTags.filter((t) => t.toLowerCase().includes(q));
    if (!q) return list;
    return [...list].sort((a, b) => a.toLowerCase().indexOf(q) - b.toLowerCase().indexOf(q));
  }, [globalTags, q]);

  const renderRow = (tag: string) => {
    const isSelected = tags.saved.has(tag);
    const isFocused = tags.isTemporary && tags.temporary.has(tag);
    return (
      <button
        key={tag}
        type="button"
        className={`tagf-item${isSelected ? " selected" : ""}${isFocused ? " focused" : ""}`}
        title={tag}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) filter.focusTag(tag);
          else filter.toggleTag(tag);
        }}
      >
        <span
          className="tagf-indicator"
          data-tip="Only show this tag"
          onClick={(e) => {
            e.stopPropagation();
            filter.focusTag(tag);
          }}
        />
        <span className="tagf-label">{tag}</span>
      </button>
    );
  };

  return (
    <div className="rail-tags r-extra">
      <div className="rail-section-head">
        <span className="rail-section-title">Tags</span>
        <span className="rail-section-count">
          ({selectedCount}/{totalCount})
        </span>
        {tags.isTemporary ? (
          <button type="button" className="rail-section-action" onClick={filter.clearFocus}>
            Clear
          </button>
        ) : null}
      </div>

      <label className="tagf-search">
        <Search size={13} />
        <input
          value={tagQuery}
          onChange={(e) => setTagQuery(e.target.value)}
          placeholder="Filter tags…"
        />
      </label>

      <div className="tagf-actions">
        <button type="button" onClick={filter.showAllTags}>
          Show all
        </button>
        <button type="button" onClick={filter.hideAllTags}>
          Hide all
        </button>
      </div>

      <div className="tagf-list-wrap">
        <div className="tagf-list">
          {systemTags.map(renderRow)}
          {systemTags.length > 0 && shownGlobal.length > 0 ? <div className="tagf-divider" /> : null}
          {shownGlobal.map(renderRow)}
        </div>
      </div>
    </div>
  );
}
