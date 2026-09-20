import type { ExportSpec } from "./types";

export interface Keyframe { time: number; value: unknown; easing?: "linear" | "smooth" | "hold" }
export interface Track { path: string; keys: Keyframe[]; step?: number }
export interface CursorKey {
  time: number;
  x?: number;
  y?: number;
  target?: string;
  anchor?: [number, number];
  pressed?: boolean;
  button?: "left" | "right";
  shape?: "arrow" | "pointer" | "text" | "grab" | "grabbing" | "resize";
  drag?: boolean;
}

export function sample(keys: Keyframe[], time: number): unknown {
  let a = keys[0];
  if (time <= a.time) return a.value;
  for (const b of keys.slice(1)) {
    if (time < b.time) {
      if (typeof a.value !== "number" || typeof b.value !== "number" || b.easing === "hold") return a.value;
      const t = (time - a.time) / (b.time - a.time);
      const ease = b.easing === "linear" ? t : t * t * (3 - 2 * t);
      return a.value + (b.value - a.value) * ease;
    }
    a = b;
  }
  return a.value;
}

export function frameSpec(spec: ExportSpec, time: number): ExportSpec {
  const next = structuredClone(spec);
  for (const track of spec.timeline?.tracks ?? []) {
    const parts = track.path.split(".");
    let node = next as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as Record<string, unknown>;
    }
    const value = sample(track.keys, time);
    node[parts[parts.length - 1]] = typeof value === "number" && track.step ? Math.round(value / track.step) * track.step : value;
  }
  return next;
}

export async function paintCursor(keys: CursorKey[], time: number, theme?: ExportSpec["cursorTheme"]): Promise<void> {
  const root = document.getElementById("export-root")!;
  let cursor = root.querySelector<HTMLElement>("[data-export-cursor]");
  if (!cursor) {
    cursor = document.createElement("div");
    cursor.dataset.exportCursor = "";
    cursor.dataset.layer = "cursor";
    cursor.innerHTML = theme ? '<img alt="" draggable="false">' : '<svg width="32" height="40" viewBox="0 0 32 40"><path d="M3 2 L3 30 L10 23 L16 36 L22 33 L16 21 L27 21 Z" fill="white" stroke="#17171b" stroke-width="2" stroke-linejoin="round"/></svg>';
    root.append(cursor);
  }
  const bounds = root.getBoundingClientRect();
  const point = (k: CursorKey) => {
    if (!k.target) return { x: k.x ?? 0, y: k.y ?? 0 };
    const el = root.querySelector(k.target);
    if (!el) throw new Error(`cursor target missing: ${k.target}`);
    const box = el.getBoundingClientRect();
    return { x: box.left - bounds.left + box.width * (k.anchor?.[0] ?? 0.5), y: box.top - bounds.top + box.height * (k.anchor?.[1] ?? 0.5) };
  };
  let a = keys[0], b = a;
  for (const key of keys) {
    if (key.time <= time) a = key;
    else { b = key; break; }
    b = a;
  }
  const p = point(a), q = point(b);
  const t = a === b ? 0 : Math.max(0, Math.min(1, (time - a.time) / (b.time - a.time)));
  const e = t * t * (3 - 2 * t);
  const shape = theme?.shapes[a.shape ?? "arrow"] ?? theme?.shapes.arrow;
  let hotX = 3, hotY = 2;
  if (shape) {
    const img = cursor.querySelector("img")!;
    if (img.src !== shape.src) img.src = shape.src;
    img.style.cssText = `width:${shape.width}px;height:${shape.height}px;max-width:none`;
    await img.decode();
    [hotX, hotY] = shape.hotspot;
  }
  let stateStart = keys.indexOf(a);
  while (stateStart > 0 && !!keys[stateStart - 1].pressed === !!a.pressed && !!keys[stateStart - 1].drag === !!a.drag) stateStart--;
  const age = Math.max(0, time - keys[stateStart].time);
  const press = Math.min(1, age / 0.09);
  const release = age < 0.24 ? 1 - 0.15 * Math.exp(-age * 16) * Math.cos(age * 24) : 1;
  const previous = keys[stateStart - 1];
  const scale = a.pressed ? 1 - 0.15 * press : previous?.pressed ? release : 1;
  const tilt = a.drag ? -7 * press : a.pressed ? (a.button === "right" ? 7 : -4) * press : 0;
  cursor.style.cssText = `position:absolute;left:${p.x + (q.x - p.x) * e - hotX}px;top:${p.y + (q.y - p.y) * e - hotY}px;z-index:100000;pointer-events:none;transform:scale(${scale}) rotate(${tilt}deg);transform-origin:${hotX}px ${hotY}px;filter:drop-shadow(0 ${a.pressed ? 1 : 3}px ${a.pressed ? 1 : 3}px #0008)`;
}
