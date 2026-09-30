import { useEffect, useRef, useState } from "react";
import type { BlurLayer, Layer, ZoomLayer } from "../../../types/clips";
import { ZOOM_MAX, ZOOM_MIN, clamp, keyAt, viewPatch, zoomAt, zoomView } from "./model";
import { getLayers, select, update, useLayers } from "./store";

// zoom and blur, the layers that change the video itself. both live in source pixels: a blur box
// zooms with the frame, text and media on top don't. main/layer-export.js does blur, then zoom

const video = () => document.getElementById("video-player") as HTMLVideoElement | null;

/** blur radius and pixel block size in frame widths at full strength; export uses the same */
export const BLUR_SIGMA = 0.02;
export const PIXEL_BLOCK = 0.05;

/** the zoom preview: scales the video element about the frame's top left and moves it so the view
 * matches the export's crop. the fx box over the video (blur boxes) gets the same transform. while a
 * zoom layer is selected the frame stays whole so its box can be placed */
export function installZoom(): () => void {
  let raf = 0;
  let was = false;
  const clear = (v: HTMLVideoElement | null) => {
    if (!was) return;
    was = false;
    if (v) {
      v.style.transform = "";
      v.style.transformOrigin = "";
    }
    const box = document.getElementById("video-container");
    if (box) box.style.clipPath = "";
    const fx = document.querySelector<HTMLElement>(".pl-fx");
    if (fx) fx.style.transform = "";
  };
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const v = video();
    const { clip, items, sel } = getLayers();
    const editing = items.find((l) => l.id === sel)?.kind === "zoom";
    if (!v || !clip || editing || !v.videoWidth || !items.some((l) => l.kind === "zoom")) {
      clear(v);
      return;
    }
    const { z, ox, oy } = zoomAt(items, v.currentTime);
    if (z <= 1.0001) {
      clear(v);
      return;
    }
    // object-fit: contain, the frame sits centred in the element
    const ew = v.clientWidth;
    const eh = v.clientHeight;
    const s = Math.min(ew / v.videoWidth, eh / v.videoHeight);
    const cw = v.videoWidth * s;
    const ch = v.videoHeight * s;
    const offX = (ew - cw) / 2;
    const offY = (eh - ch) / 2;
    was = true;
    v.style.transformOrigin = `${offX}px ${offY}px`;
    v.style.transform = `translateZ(0) translate(${-ox * cw}px, ${-oy * ch}px) scale(${z})`;
    // fullscreen letterboxes; the zoomed frame must not spill into the bars
    const box = document.getElementById("video-container");
    if (box) box.style.clipPath = offX > 0.5 || offY > 0.5 ? `inset(${offY}px ${offX}px)` : "";
    const fx = document.querySelector<HTMLElement>(".pl-fx");
    if (fx) fx.style.transform = `translate(${-ox * 100}%, ${-oy * 100}%) scale(${z})`;
  };
  raf = requestAnimationFrame(loop);
  return () => {
    cancelAnimationFrame(raf);
    was = true;
    clear(video());
  };
}

/** drag inside a box in % of the frame; move or resize, the caller turns the delta into a patch */
function dragBox(e: React.PointerEvent<HTMLElement>, onMove: (dx: number, dy: number, resize: boolean) => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const v = video();
  if (v && !v.paused) v.pause();
  const frame = (e.currentTarget.closest(".pl-fx") as HTMLElement | null)?.getBoundingClientRect();
  if (!frame) return;
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const resize = (e.target as HTMLElement).classList.contains("pl-layer-resize");
  const x0 = e.clientX;
  const y0 = e.clientY;
  const move = (ev: PointerEvent) => onMove(((ev.clientX - x0) / frame.width) * 100, ((ev.clientY - y0) / frame.height) * 100, resize);
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

/** the video's time, re-rendering while it moves; the zoom box and its keys follow the playhead */
export function usePlayhead(): number {
  const [t, setT] = useState(() => video()?.currentTime ?? 0);
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = video()?.currentTime ?? 0;
      setT((p) => (p === now ? p : now));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return t;
}

/** the zoomed view at the playhead as a box on the whole frame, dimming what gets cut. with keys a
 * drag sets the key at the playhead, see viewPatch */
function ZoomBox({ l }: { l: ZoomLayer }) {
  const t = usePlayhead();
  const view = zoomView(l, t);
  const size = 100 / view.scale;
  const cx = clamp(view.x, size / 2, 100 - size / 2);
  const cy = clamp(view.y, size / 2, 100 - size / 2);
  const keyed = !!l.keys?.length;
  const onKey = keyed && keyAt(l, t) >= 0;
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // the drag pauses the video, so t holds for the whole drag
    const w0 = size;
    const half = w0 / 2;
    dragBox(e, (dx, dy, resize) => {
      const cur = getLayers().items.find((x) => x.id === l.id);
      if (cur?.kind !== "zoom") return;
      if (resize) {
        const scale = clamp(100 / Math.max(100 / ZOOM_MAX, w0 + Math.max(dx, dy) * 2), ZOOM_MIN, ZOOM_MAX);
        update(l.id, viewPatch(cur, t, { scale: Math.round(scale * 100) / 100 }));
        return;
      }
      update(l.id, viewPatch(cur, t, { x: clamp(cx + dx, half, 100 - half), y: clamp(cy + dy, half, 100 - half) }));
    });
  };
  return (
    <div
      className={`pl-zoombox${onKey ? " is-key" : ""}`}
      style={{ left: `${cx - size / 2}%`, top: `${cy - size / 2}%`, width: `${size}%`, height: `${size}%` }}
      onPointerDown={onDown}
      title={keyed ? "Drag to set the zoom at the playhead, this adds a keyframe there" : "Drag to place the zoom, drag the corner to zoom more or less"}
    >
      <span className="pl-zoombox-label">
        {view.scale.toFixed(1)}x
        {onKey ? <i className="pl-zoombox-key" /> : null}
      </span>
      <i className="pl-layer-resize" />
    </div>
  );
}

/** one blur box, drawn from the video every frame. blur uses a css filter on a canvas that reaches
 * past the box by two radii so the edges stay covered; pixelate draws one canvas pixel per block */
function BlurBox({ l, selected }: { l: BlurLayer; selected: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lRef = useRef(l);
  lRef.current = l;

  useEffect(() => {
    let raf = 0;
    let lastT = -1;
    let lastKey = "";
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const v = video();
      const box = boxRef.current;
      const canvas = canvasRef.current;
      if (!v || !box || !canvas || !v.videoWidth || box.style.display === "none") return;
      const b = lRef.current;
      const key = JSON.stringify([b.x, b.y, b.w, b.h, b.mode, b.strength, box.offsetWidth]);
      if (v.currentTime === lastT && key === lastKey && !v.seeking) return;
      lastT = v.currentTime;
      lastKey = key;
      const vw = v.videoWidth;
      const vh = v.videoHeight;
      const rx = ((b.x - b.w / 2) / 100) * vw;
      const ry = ((b.y - b.h / 2) / 100) * vh;
      const rw = (b.w / 100) * vw;
      const rh = (b.h / 100) * vh;
      // screen px per source px
      const k = box.offsetWidth / Math.max(1, rw);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      if (b.mode === "pixelate") {
        const block = Math.max(2, b.strength * PIXEL_BLOCK * vw);
        canvas.width = Math.max(1, Math.ceil(rw / block));
        canvas.height = Math.max(1, Math.ceil(rh / block));
        Object.assign(canvas.style, { left: "0", top: "0", width: `${(canvas.width * block * k).toFixed(1)}px`, height: `${(canvas.height * block * k).toFixed(1)}px`, filter: "", imageRendering: "pixelated" });
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(v, rx, ry, canvas.width * block, canvas.height * block, 0, 0, canvas.width, canvas.height);
        return;
      }
      const sigma = Math.max(1, b.strength * BLUR_SIGMA * vw);
      const m = sigma * 2;
      const sx = Math.max(0, rx - m);
      const sy = Math.max(0, ry - m);
      const sw = Math.min(vw, rx + rw + m) - sx;
      const sh = Math.min(vh, ry + rh + m) - sy;
      // the blur hides detail anyway, a small canvas is plenty
      const res = Math.min(1, 480 / Math.max(sw, sh));
      canvas.width = Math.max(1, Math.round(sw * res));
      canvas.height = Math.max(1, Math.round(sh * res));
      Object.assign(canvas.style, {
        left: `${((sx - rx) * k).toFixed(1)}px`,
        top: `${((sy - ry) * k).toFixed(1)}px`,
        width: `${(sw * k).toFixed(1)}px`,
        height: `${(sh * k).toFixed(1)}px`,
        filter: `blur(${(sigma * k).toFixed(2)}px)`,
        imageRendering: "",
      });
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    select(l.id);
    const { x: x0, y: y0, w: w0, h: h0 } = l;
    dragBox(e, (dx, dy, resize) => {
      if (resize) {
        // the corner moves, the opposite corner stays
        const w = clamp(w0 + dx, 1, 100);
        const h = clamp(h0 + dy, 1, 100);
        update(l.id, { w, h, x: clamp(x0 - w0 / 2 + w / 2, 0, 100), y: clamp(y0 - h0 / 2 + h / 2, 0, 100) });
        return;
      }
      update(l.id, { x: clamp(x0 + dx, 0, 100), y: clamp(y0 + dy, 0, 100) });
    });
  };

  return (
    <div
      ref={boxRef}
      data-id={l.id}
      className={`pl-blur${selected ? " is-sel" : ""}`}
      style={{ left: `${l.x - l.w / 2}%`, top: `${l.y - l.h / 2}%`, width: `${l.w}%`, height: `${l.h}%`, display: "none" }}
      onPointerDown={onDown}
    >
      <canvas ref={canvasRef} />
      {selected ? <i className="pl-layer-resize" title="Drag to resize" /> : null}
    </div>
  );
}

export const hasFx = (items: Layer[]) => items.some((l) => l.kind === "zoom" || l.kind === "blur");

/** inside the layer stage's frame box, under the text and media layers */
export function FxStage() {
  const { items, sel } = useLayers();
  const blurs = items.filter((l): l is BlurLayer => l.kind === "blur");
  const zoom = items.find((l): l is ZoomLayer => l.kind === "zoom" && l.id === sel) ?? null;
  const ref = useRef<HTMLDivElement>(null);
  const blursRef = useRef(blurs);
  blursRef.current = blurs;
  const selRef = useRef(sel);
  selRef.current = sel;

  // which boxes show at the playhead; the selected one stays, dimmed, so it can be placed
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = video();
      const root = ref.current;
      if (!v || !root) return;
      const t = v.currentTime;
      for (const b of blursRef.current) {
        const el = root.querySelector<HTMLElement>(`.pl-blur[data-id="${b.id}"]`);
        if (!el) continue;
        const inside = t >= b.start && t <= b.end;
        const show = inside || selRef.current === b.id;
        el.style.display = show ? "" : "none";
        el.classList.toggle("is-outside", !inside);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!blurs.length && !zoom) return null;
  return (
    <div className="pl-fx" ref={ref}>
      {blurs.map((b) => (
        <BlurBox key={b.id} l={b} selected={sel === b.id} />
      ))}
      {zoom ? <ZoomBox l={zoom} /> : null}
    </div>
  );
}
