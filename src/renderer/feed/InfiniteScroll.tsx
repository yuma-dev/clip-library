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
        if (entry.isIntersecting && !loading) {
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
