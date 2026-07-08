import { memo, useDeferredValue } from "react";
import ClipCard from "./ClipCard";
import { useStreamedSlice } from "../ui/useStreamedSlice";
import type { ClipGroupData } from "./grouping";

interface ClipGroupProps {
  group: ClipGroupData;
  thumbnails: Map<string, string | null>;
  grayscaleIcons: boolean;
  showNewIndicators: boolean;
  collapsed: boolean;
  onToggle: (name: string) => void;
}

function ClipGroup({ group, thumbnails, grayscaleIcons, showNewIndicators, collapsed, onToggle }: ClipGroupProps) {
  // The header reacts to `collapsed` urgently (instant diamond/aria feedback);
  // the card mounting below runs as a deferred, interruptible render.
  // Streamed mounting itself lives in useStreamedSlice (shared with the feed);
  // group identity is stabilized by ClipGrid, so `group.clips` changing means
  // membership really changed.
  const expanded = !useDeferredValue(collapsed);
  const shown = useStreamedSlice(group.clips, expanded);

  return (
    <section className="clip-group">
      <button
        type="button"
        className="clip-group-header"
        onClick={() => onToggle(group.name)}
        aria-expanded={!collapsed}
      >
        {/* ◆ gradient diamond — rotates 45° when the group is open (design). */}
        <span className={`clip-group-diamond${collapsed ? "" : " open"}`} aria-hidden="true" />
        <h2 className="clip-group-title">{group.name}</h2>
        <span className="clip-group-count">{group.clips.length}</span>
        <span className="clip-group-divider" />
      </button>

      {shown ? (
        <div className="clip-group-content">
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
