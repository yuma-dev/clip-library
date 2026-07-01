import { memo } from "react";
import { ChevronDown } from "lucide-react";
import ClipCard from "./ClipCard";
import type { ClipGroupData } from "./grouping";

interface ClipGroupProps {
  group: ClipGroupData;
  thumbnails: Map<string, string | null>;
  collapsed: boolean;
  onToggle: (name: string) => void;
}

function ClipGroup({ group, thumbnails, collapsed, onToggle }: ClipGroupProps) {
  return (
    <section className="clip-group">
      <button
        type="button"
        className="clip-group-header"
        onClick={() => onToggle(group.name)}
        aria-expanded={!collapsed}
      >
        <ChevronDown size={16} className={`clip-group-chevron${collapsed ? " collapsed" : ""}`} />
        <h2 className="clip-group-title">{group.name}</h2>
        <span className="clip-group-count">{group.clips.length}</span>
        <span className="clip-group-divider" />
      </button>

      {!collapsed ? (
        <div className="clip-group-content">
          {group.clips.map((clip) => (
            <ClipCard key={clip.originalName} clip={clip} thumbnailPath={thumbnails.get(clip.originalName) ?? null} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default memo(ClipGroup);
