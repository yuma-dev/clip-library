// Feed time-group section, mirrors the library's ClipGroup markup exactly (.clip-group
// > .clip-group-header with diamond/title/count/divider > .clip-group-content grid)
// so feed sections read as the same app surface as the library.

import { memo, useDeferredValue } from "react";
import FeedClipCard from "./FeedClipCard";
import { useStreamedSlice } from "../ui/useStreamedSlice";
import type { Clip } from "./types";

interface FeedGroupProps {
  name: string;
  clips: Clip[];
  collapsed: boolean;
  onToggle: (name: string) => void;
  onReactionUpdate: (clipId: string, emoji: string, action: "added" | "removed") => void;
  onFavoriteUpdate: (clipId: string, action: "added" | "removed") => void;
  onOpen: (clip: Clip) => void;
}

function FeedGroup({
  name,
  clips,
  collapsed,
  onToggle,
  onReactionUpdate,
  onFavoriteUpdate,
  onOpen,
}: FeedGroupProps) {
  // same streamed mounting as the library's ClipGroup: a page (or cache-restored list)
  // mounts a screenful in one small commit and streams the rest
  const expanded = !useDeferredValue(collapsed);
  const shown = useStreamedSlice(clips, expanded);

  return (
    <section className="clip-group">
      <button
        type="button"
        className="clip-group-header"
        onClick={() => onToggle(name)}
        aria-expanded={!collapsed}
      >
        {/* gradient diamond, rotates 45deg when the group is open */}
        <span className={`clip-group-diamond${collapsed ? "" : " open"}`} aria-hidden="true" />
        <h2 className="clip-group-title">{name}</h2>
        <span className="clip-group-count">{clips.length}</span>
        <span className="clip-group-divider" />
      </button>

      {shown ? (
        <div className="clip-group-content">
          {shown.map((clip) => (
            <FeedClipCard
              key={clip.id}
              clip={clip}
              onReactionUpdate={onReactionUpdate}
              onFavoriteUpdate={onFavoriteUpdate}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default memo(FeedGroup);
