import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ClipCard from "./ClipCard";
import { ObserveContext } from "./visibility";
import { useHover } from "./hoverContext";
import type { LocalClip } from "./types";

interface Props {
  clips: LocalClip[];
  thumbnails: Map<string, string | null>;
  grayscaleIcons: boolean;
  showNewIndicators: boolean;
}

/** Window rows, not individual cards: preserves CSS grid columns and the full
 * scrollbar while bounding React reconciliation, image decode and IPC work. */
function VirtualClipCards({ clips, thumbnails, grayscaleIcons, showNewIndicators }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const hover = useHover();
  const [viewport, setViewport] = useState({ cols: 1, rowH: 280, first: 0, rows: 12 });
  const totalRows = Math.ceil(clips.length / viewport.cols);
  const first = Math.min(viewport.first, Math.max(0, totalRows - viewport.rows));
  const last = Math.min(totalRows, first + viewport.rows);
  useEffect(() => () => hover?.leave(), [hover, clips, first, last]);

  const measure = useCallback(() => {
    const el = ref.current;
    const scroller = el?.closest<HTMLElement>(".clip-scroll");
    if (!el || !scroller || !el.clientWidth || !scroller.clientHeight) return;
    const card = el.querySelector<HTMLElement>(".clip-item");
    if (!card) return;
    const css = getComputedStyle(el);
    const cols = css.gridTemplateColumns.split(" ").filter(Boolean).length;
    const rowH = card.offsetHeight + (parseFloat(css.rowGap) || 16);
    if (!cols || rowH <= 16) return;
    // Base padding is 24px. Virtual padding never changes the element's top.
    const top = scroller.getBoundingClientRect().top - el.getBoundingClientRect().top - 24;
    const farAway = top + scroller.clientHeight < -3 * rowH || top > (Math.ceil(clips.length / cols) + 3) * rowH;
    const rows = farAway ? 1 : Math.ceil(scroller.clientHeight / rowH) + 7;
    const first = Math.max(0, Math.min(Math.floor(top / rowH) - 3, Math.ceil(clips.length / cols) - rows));
    setViewport((old) => old.cols === cols && old.rowH === rowH && old.first === first && old.rows === rows
      ? old : { cols, rowH, first, rows });
  }, [clips.length]);

  useLayoutEffect(() => {
    const el = ref.current;
    const scroller = el?.closest<HTMLElement>(".clip-scroll");
    if (!el || !scroller) return;
    let raf = 0;
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); });
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    observer.observe(scroller);
    // Card height also follows font/settings changes, not only window width.
    const card = el.querySelector(".clip-item");
    if (card) observer.observe(card);
    scroller.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
    };
  }, [measure]);

  return (
    // These rows are already windowed. Card-level culling would replace measured
    // row heights with intrinsic placeholders in distant groups.
    <ObserveContext.Provider value={null}>
      <div ref={ref} className="clip-group-content clip-group-virtual"
      style={{ paddingTop: 24 + first * viewport.rowH, paddingBottom: 44 + (totalRows - last) * viewport.rowH }}>
      {clips.slice(first * viewport.cols, last * viewport.cols).map((clip) => (
        <ClipCard key={clip.originalName} clip={clip}
          thumbnailPath={thumbnails.get(clip.originalName) ?? null}
          grayscaleIcons={grayscaleIcons} showNewIndicators={showNewIndicators} />
      ))}
      </div>
    </ObserveContext.Provider>
  );
}

export default memo(VirtualClipCards);
