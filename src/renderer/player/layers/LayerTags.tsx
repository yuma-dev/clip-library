import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties } from "react";
import { Captions } from "lucide-react";
import type { Layer } from "../../../types/clips";
import type { TrackView } from "../Waveform";
import { KindIcon, layerColor, trackInfo } from "./meta";
import { MIN_LEN, clamp, fmtTime, layerLabel } from "./model";
import { select, update, useLayers } from "./store";

const ROW = 21;

/** greedy rows: a tag takes the lowest row whose last tag ended before it starts */
export function tagRows(items: Layer[]): Map<string, number> {
  const ends: number[] = [];
  const rows = new Map<string, number>();
  for (const l of [...items].sort((a, b) => a.start - b.start)) {
    let r = ends.findIndex((e) => e <= l.start + 0.001);
    if (r < 0) {
      r = ends.length;
      ends.push(0);
    }
    ends[r] = l.end;
    rows.set(l.id, r);
  }
  return rows;
}

const video = () => document.getElementById("video-player") as HTMLVideoElement | null;

/** where the timeline sits inside the bar; the tags line up with it exactly */
function useTimelineBox(open: boolean) {
  const [box, setBox] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const tl = document.getElementById("progress-bar-container");
    if (!tl || !open) return;
    const measure = () => setBox({ left: tl.offsetLeft, width: tl.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(tl);
    return () => ro.disconnect();
  }, [open]);
  return box;
}

/** tags above the timeline, one per layer: click selects, the middle drags the whole range,
 * the ends drag start and end. the video follows an end while it moves */
export default function LayerTags({ tracks, open, onHeight }: { tracks: TrackView[] | null; open: boolean; onHeight: (px: number) => void }) {
  const { items, sel } = useLayers();
  const box = useTimelineBox(open);
  const [duration, setDuration] = useState(0);
  const rows = useMemo(() => tagRows(items), [items]);
  const rowCount = items.length ? Math.max(...rows.values()) + 1 : 0;

  useEffect(() => {
    const v = video();
    if (!v) return;
    const sync = () => setDuration(v.duration > 0 ? v.duration : 0);
    sync();
    v.addEventListener("durationchange", sync);
    v.addEventListener("loadedmetadata", sync);
    return () => {
      v.removeEventListener("durationchange", sync);
      v.removeEventListener("loadedmetadata", sync);
    };
  }, []);

  useEffect(() => onHeight(rowCount * ROW), [rowCount, onHeight]);

  if (!open || !duration || items.length === 0 || !box.width) return null;

  const onDown = (e: React.PointerEvent<HTMLDivElement>, l: Layer) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const edge = (e.target as HTMLElement).dataset.edge ?? "move";
    const v = video();
    if (v && !v.paused) v.pause();
    select(l.id);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const { start: s0, end: e0 } = l;
    const pps = box.width / duration;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      const dt = (ev.clientX - x0) / pps;
      if (edge === "start") {
        const start = clamp(s0 + dt, 0, e0 - MIN_LEN);
        update(l.id, { start });
        if (v) v.currentTime = start;
      } else if (edge === "end") {
        const end = clamp(e0 + dt, s0 + MIN_LEN, duration);
        update(l.id, { end });
        if (v) v.currentTime = end;
      } else {
        const len = e0 - s0;
        const start = clamp(s0 + dt, 0, duration - len);
        update(l.id, { start, end: start + len });
      }
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.classList.remove("dragging");
    };
    document.body.classList.add("dragging");
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const name = (o: number) => trackInfo(tracks, o).name;
  return (
    <div className="pl-tags" style={{ left: box.left, width: box.width, height: rowCount * ROW }}>
      {items.map((l) => {
        const label = layerLabel(l, name);
        return (
          <div
            key={l.id}
            className={`pl-tag${sel === l.id ? " is-sel" : ""}`}
            style={
              {
                left: `${(l.start / duration) * 100}%`,
                width: `${((l.end - l.start) / duration) * 100}%`,
                bottom: (rows.get(l.id) ?? 0) * ROW,
                "--c": layerColor(l, tracks),
              } as CSSProperties
            }
            title={`${label}, ${fmtTime(l.start)} to ${fmtTime(l.end)}. Drag to move, drag an end to change it.`}
            onPointerDown={(e) => onDown(e, l)}
          >
            <span className="pl-tag-edge is-start" data-edge="start" />
            {l.kind === "text" && l.source === "subtitles" ? <Captions size={11} strokeWidth={2.2} /> : <KindIcon kind={l.kind} size={11} strokeWidth={2.2} />}
            <span className="pl-tag-label">{label}</span>
            <span className="pl-tag-edge is-end" data-edge="end" />
          </div>
        );
      })}
    </div>
  );
}
