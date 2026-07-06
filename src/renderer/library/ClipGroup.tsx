import { memo } from "react";
import ClipCard from "./ClipCard";
import type { ClipGroupData } from "./grouping";

interface ClipGroupProps {
  group: ClipGroupData;
  thumbnails: Map<string, string | null>;
  grayscaleIcons: boolean;
  collapsed: boolean;
  onToggle: (name: string) => void;
}

function ClipGroup({ group, thumbnails, grayscaleIcons, collapsed, onToggle }: ClipGroupProps) {
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

      {!collapsed ? (
        <div className="clip-group-content">
          {group.clips.map((clip) => (
            <ClipCard
              key={clip.originalName}
              clip={clip}
              thumbnailPath={thumbnails.get(clip.originalName) ?? null}
              grayscaleIcons={grayscaleIcons}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default memo(ClipGroup);
