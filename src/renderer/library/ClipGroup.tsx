import { memo, useDeferredValue } from "react";
import type React from "react";
import ClipCard from "./ClipCard";
import VirtualClipCards from "./VirtualClipCards";
import { useStreamedSlice } from "../ui/useStreamedSlice";
import type { ClipGroupData } from "./grouping";

export interface GridLayoutHint {
  /** Columns the grid currently lays out, and one row's height plus gap. */
  cols: number;
  rowH: number;
}

interface ClipGroupProps {
  group: ClipGroupData;
  thumbnails: Map<string, string | null>;
  grayscaleIcons: boolean;
  showNewIndicators: boolean;
  collapsed: boolean;
  onToggle: (name: string) => void;
  /** Measured by ClipGrid; sizes a group the browser has not rendered yet. */
  layoutHint: GridLayoutHint | null;
}

function ClipGroup({ group, thumbnails, grayscaleIcons, showNewIndicators, collapsed, onToggle, layoutHint }: ClipGroupProps) {
  // Header reacts to `collapsed` urgently; card mounting below is a deferred
  // interruptible render. Group identity is stabilized by ClipGrid, so `group.clips` changing means
  // real membership change.
  const expanded = !useDeferredValue(collapsed);
  // A small first commit: the window is revealed only after it has painted
  // and the rest of the group streams in on the following frames.
  const virtualized = group.clips.length > 80;
  const shown = useStreamedSlice(group.clips, expanded && !virtualized, { initial: 12, perFrame: 80 });

  return (
    <section className="clip-group">
      <button
        type="button"
        className="clip-group-header"
        onClick={() => onToggle(group.name)}
        aria-expanded={!collapsed}
      >
        {/* gradient diamond, rotates 45deg when the group is open (design). */}
        <span className={`clip-group-diamond${collapsed ? "" : " open"}`} aria-hidden="true" />
        <h2 className="clip-group-title">{group.name}</h2>
        <span className="clip-group-count">{group.clips.length}</span>
        <span className="clip-group-divider" />
      </button>

      {expanded && virtualized ? (
        <VirtualClipCards clips={group.clips} thumbnails={thumbnails}
          grayscaleIcons={grayscaleIcons} showNewIndicators={showNewIndicators} />
      ) : shown ? (
        // Reserved height for a group content-visibility:auto skips (styles.css)
        // before layout, from the measured columns + row height.
        <div
          className="clip-group-content"
          style={
            layoutHint
              ? ({ "--group-h": `${Math.max(1, Math.ceil(shown.length / layoutHint.cols)) * layoutHint.rowH}px` } as React.CSSProperties)
              : undefined
          }
        >
          {shown.map((clip) => (
            <ClipCard
              key={clip.originalName}
              clip={clip}
              thumbnailPath={thumbnails.get(clip.originalName) ?? null}
              grayscaleIcons={grayscaleIcons}
              showNewIndicators={showNewIndicators}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default memo(ClipGroup);
