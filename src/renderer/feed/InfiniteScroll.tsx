// IntersectionObserver sentinel — fires onLoadMore when scrolled near the end.
// Ported from the reference website's InfiniteScroll (600px rootMargin).

import { useEffect, useRef } from "react";

interface InfiniteScrollProps {
  onLoadMore: () => void;
  hasMore: boolean;
  loading: boolean;
}

export default function InfiniteScroll({ onLoadMore, hasMore, loading }: InfiniteScrollProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !hasMore) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Fire when near the sentinel OR already past it — the skeleton block
        // gives the scrollbar its full length, so the user can jump straight
        // to the bottom, far below the sentinel. Cursor pagination can't seek,
        // so keep chain-loading (this effect re-runs on every loading flip,
        // and the fresh observer fires an initial callback) until the loaded
        // content catches up and the sentinel drops below the viewport again.
        const scrolledPast = entry.boundingClientRect.top < 0;
        if ((entry.isIntersecting || scrolledPast) && !loading) {
          onLoadMore();
        }
      },
      { rootMargin: "600px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, loading]);

  return (
    <div ref={ref} className="feed-sentinel">
      {loading && <div className="feed-spinner" aria-label="Loading" />}
    </div>
  );
}
