// Placeholder cards shown below the loaded feed while more pages exist. The
// share API is cursor-paginated with no total count, so the scroll area can't
// be pre-sized to the real list; these keep the scrollbar/visuals signalling
// "there's more" instead of the grid ending abruptly at the fetch boundary.
// Deliberately NOT .clip-item — they must not pick up hover glow/selection.

import { memo } from "react";

function SkeletonCards({ count = 12 }: { count?: number }) {
  return (
    <div className="clip-group-content feed-skeleton-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="feed-skeleton-card">
          <div className="feed-skeleton-media" />
          <div className="feed-skeleton-line" />
          <div className="feed-skeleton-line short" />
        </div>
      ))}
    </div>
  );
}

export default memo(SkeletonCards);
