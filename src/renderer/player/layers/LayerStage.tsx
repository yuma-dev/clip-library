import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TextLayer, VisualLayer } from "../../../types/clips";
import { FxStage, hasFx } from "./fx";
import { fileUrl } from "./meta";
import { animAt, clamp, isVisual, overlayZoomAt } from "./model";
import { drawText, loadTextFont } from "./rasterize";
import { getLayers, select, update, useLayers } from "./store";

type Visual = VisualLayer;
const video = () => document.getElementById("video-player") as HTMLVideoElement | null;

/** the same canvas the export png comes from, drawn at the on-screen size */
function TextCanvas({ l, frameW }: { l: TextLayer; frameW: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let live = true;
    void loadTextFont(l).then(() => live && setFontReady(true));
    return () => {
      live = false;
    };
  }, [l.style]);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || !frameW) return;
    const refW = Math.min(3840, Math.round(frameW * (window.devicePixelRatio || 1)));
    const canvas = drawText(l.text ? l : { ...l, text: " " }, refW);
    canvas.style.width = `${(canvas.width / refW) * 100}cqw`;
    canvas.style.display = "block";
    host.replaceChildren(canvas);
  }, [l.text, l.style, l.color, l.size, frameW, fontReady]);
  return <span ref={ref} className="pl-layer-text" />;
}

function Body({ l, frameW }: { l: Visual; frameW: number }) {
  if (l.kind === "text") return <TextCanvas l={l} frameW={frameW} />;
  const src = l.file ? fileUrl(l.file) : l.kind === "gif" && l.gif.url ? l.gif.url : null;
  if (!src) return <span className="pl-layer-empty" style={{ width: `${l.w}cqw`, aspectRatio: String(l.aspect) }} />;
  return <img src={src} alt="" draggable={false} style={{ width: `${l.w}cqw`, aspectRatio: String(l.aspect) }} />;
}

/** the zoom a layer on top gets at t; none while a zoom is selected, the frame stays whole then */
function zoomFor(l: Visual, t: number) {
  const { items, sel } = getLayers();
  if (items.find((x) => x.id === sel)?.kind === "zoom") return { z: 1, ox: 0, oy: 0 };
  return overlayZoomAt(items, l, t);
}

/** the visual layers over the video, in a box with the video's own aspect so % positions match the
 * export in fullscreen too. a frame loop sets visibility, the show/hide animation and the zoom of
 * the layers that follow it from the playhead; the selected layer stays visible (dimmed outside its
 * time) so it can be placed */
export default function LayerStage() {
  const { items, sel } = useLayers();
  const visuals = items.filter(isVisual);
  const boxRef = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLDivElement>());
  const itemsRef = useRef(visuals);
  itemsRef.current = visuals;
  const selRef = useRef(sel);
  selRef.current = sel;

  const hasVisuals = visuals.length > 0;
  const fx = hasFx(items);
  // on-screen frame width, text is drawn for it so it stays sharp at any window size
  const [frameW, setFrameW] = useState(0);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => setFrameW(box.offsetWidth));
    ro.observe(box);
    setFrameW(box.offsetWidth);
    return () => ro.disconnect();
  }, [hasVisuals, fx]);
  useEffect(() => {
    if (!hasVisuals) return;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = video();
      if (!v) return;
      const t = v.currentTime;
      let zoomed = false;
      for (const l of itemsRef.current) {
        const el = els.current.get(l.id);
        if (!el) continue;
        const inside = t >= l.start && t <= l.end;
        const selected = selRef.current === l.id;
        if (!inside && !selected) {
          if (el.style.display !== "none") el.style.display = "none";
          continue;
        }
        if (el.style.display === "none") el.style.display = "";
        const a = inside ? animAt(l, t) : { opacity: 0.45, scale: 1, dx: 0, dy: 0, clipL: 0, clipR: 0 };
        el.classList.toggle("is-outside", !inside);
        el.style.opacity = String(a.opacity * (l.opacity ?? 1));
        // a followed zoom scales the frame by z and cuts it at ox/oy, the layer sits on that frame
        const { z, ox, oy } = zoomFor(l, t);
        if (z > 1.0001) zoomed = true;
        el.style.left = `${(l.x / 100) * z * 100 - ox * 100}%`;
        el.style.top = `${(l.y / 100) * z * 100 - oy * 100}%`;
        el.style.transform = `translate(-50%, -50%) translate(${a.dx}cqw, ${a.dy}cqw) scale(${a.scale * z})`;
        const body = el.firstElementChild as HTMLElement | null;
        if (body) body.style.clipPath = a.clipL || a.clipR ? `inset(0 ${a.clipR * 100}% 0 ${a.clipL * 100}%)` : "";
      }
      // zoomed layers pushed past the frame's edge are cut there, like the export
      boxRef.current?.classList.toggle("is-zoomed", zoomed);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [hasVisuals]);

  const onDown = (e: React.PointerEvent<HTMLDivElement>, l: Visual) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const v = video();
    if (v && !v.paused) v.pause();
    select(l.id);
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const resizing = (e.target as HTMLElement).classList.contains("pl-layer-resize");
    const x0 = e.clientX;
    const y0 = e.clientY;
    const { x: lx, y: ly } = l;
    const size0 = l.kind === "text" ? l.size : l.w;
    // a zoomed layer moves by frame pixels, so the pointer's travel shrinks by the zoom
    const { z } = zoomFor(l, video()?.currentTime ?? 0);
    const move = (ev: PointerEvent) => {
      if (resizing) {
        // diagonal drag, away from the centre grows
        const f = Math.max(0.05, 1 + (ev.clientX - x0 + ev.clientY - y0) / (240 * z));
        if (l.kind === "text") update(l.id, { size: clamp(size0 * f, 0.5, 60) });
        else update(l.id, { w: clamp(size0 * f, 0.5, 1000) });
        return;
      }
      update(l.id, {
        x: clamp(lx + ((ev.clientX - x0) / box.width / z) * 100, 0, 100),
        y: clamp(ly + ((ev.clientY - y0) / box.height / z) * 100, 0, 100),
      });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  if (!hasVisuals && !fx) return null;
  return (
    <div className="pl-layers">
      <div className="pl-layers-box" ref={boxRef}>
        <FxStage />
        {visuals.map((l) => (
          <div
            key={l.id}
            ref={(el) => {
              if (el) els.current.set(l.id, el);
              else els.current.delete(l.id);
            }}
            className={`pl-layer${sel === l.id ? " is-sel" : ""}`}
            style={{ left: `${l.x}%`, top: `${l.y}%`, display: "none" }}
            onPointerDown={(e) => onDown(e, l)}
          >
            <div className="pl-layer-body">
              <Body l={l} frameW={frameW} />
            </div>
            {sel === l.id ? <i className="pl-layer-resize" title="Drag to resize" /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
