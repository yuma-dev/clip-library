// Placeholder cards for the not-yet-fetched remainder of a feed/profile list.
// With the server's `total` field the block is sized to the REAL remaining
// count, so the scroll area has its final length immediately (like the local
// library grid) and pages fill skeletons in place as they arrive. Falls back
// to a small fixed block when the server didn't report a total.
//
// Cheap at any count: mounting is streamed (they're tiny, so big chunks), and
// each card carries content-visibility:auto (safe here — skeletons have no
// hover shadow or selection outline to clip, unlike .clip-item).
// Deliberately NOT .clip-item — they must not pick up hover glow/selection.

import { memo, useMemo } from "react";
import { useStreamedSlice } from "../ui/useStreamedSlice";

const FALLBACK_COUNT = 12;

function SkeletonCards({ count }: { count: number | null }) {
  const n = count == null ? FALLBACK_COUNT : Math.max(0, count);
  const items = useMemo(() => Array.from({ length: n }, (_, i) => i), [n]);
  const shown = useStreamedSlice(items, true, { initial: 60, perFrame: 300 }) ?? [];
  if (n === 0) return null;
  return (
    <div className="clip-group-content feed-skeleton-grid" aria-hidden="true">
      {shown.map((i) => (
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
