import { useSyncExternalStore } from "react";
import type { Layer, LayerKind, TextLayer } from "../../../types/clips";
import { DEFAULT_LEN, MIN_LEN, clamp, newId, rasterKey } from "./model";
import { rasterizeText } from "./rasterize";

/** layers of the open clip. loaded from the open-state batch, saved 400 ms after the last edit
 * and flushed when the clip closes or switches. text layers get their export png re-rendered
 * right before a save whenever what they show changed */
interface State {
  clip: string | null;
  items: Layer[];
  sel: string | null;
  /** the add menu above the player bar, or its subtitles page */
  menu: false | "add" | "subs";
}

let state: State = { clip: null, items: [], sel: null, menu: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  emit();
};

export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const getLayers = () => state;
export function useLayers(): State {
  return useSyncExternalStore(subscribe, getLayers);
}

const SAVE_MS = 400;
let saveTimer: number | undefined;
let pending: { clip: string; items: Layer[] } | null = null;

const video = () => document.getElementById("video-player") as HTMLVideoElement | null;
const refWidth = () => video()?.videoWidth || 1920;

async function withRasters(clip: string, items: Layer[]): Promise<Layer[]> {
  const refW = refWidth();
  return Promise.all(
    items.map(async (l) => {
      if (l.kind !== "text") return l;
      const key = rasterKey(l, refW);
      if (!l.text.trim()) return { ...l, raster: null };
      if (l.raster?.key === key) return l;
      try {
        const { bytes, w, h } = await rasterizeText(l, refW);
        const { file } = await window.clips.writeLayerText(clip, l.id, bytes);
        return { ...l, raster: { file, w, h, refW, key } };
      } catch (err) {
        console.error("[layers] text render failed:", err);
        return l;
      }
    }),
  );
}

async function writeNow(job: { clip: string; items: Layer[] }) {
  const items = await withRasters(job.clip, job.items);
  // carry fresh rasters back into the live list, unless the user moved on meanwhile
  if (state.clip === job.clip) {
    const byId = new Map(items.map((l) => [l.id, l]));
    let changed = false;
    const next = state.items.map((l) => {
      const r = byId.get(l.id);
      if (l.kind === "text" && r?.kind === "text" && r.raster !== l.raster && rasterKey(l, refWidth()) === r.raster?.key) {
        changed = true;
        return { ...l, raster: r.raster };
      }
      return l;
    });
    if (changed) set({ items: next });
  }
  const res = await window.clips.saveLayers(job.clip, items).catch((err) => ({ success: false, error: String(err) }));
  if (!res?.success) console.error("[layers] save failed:", res?.error);
}

function scheduleSave() {
  if (!state.clip) return;
  pending = { clip: state.clip, items: state.items };
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flush(), SAVE_MS);
}

export async function flush(): Promise<void> {
  window.clearTimeout(saveTimer);
  const job = pending;
  pending = null;
  if (job) await writeNow(job);
}

export function loadClip(clip: string, items: Layer[]) {
  pruneEmpty(null);
  void flush();
  set({ clip, items: Array.isArray(items) ? items : [], sel: null, menu: false });
}

export function closeClip() {
  pruneEmpty(null);
  void flush();
  set({ clip: null, items: [], sel: null, menu: false });
}

export function select(id: string | null) {
  if (id === state.sel && !state.menu) return;
  pruneEmpty(id);
  set({ sel: id, menu: false });
}

export function setMenu(open: false | "add" | "subs") {
  set({ menu: open });
}

export function update(id: string, patch: Partial<Layer>) {
  set({ items: state.items.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) });
  scheduleSave();
}

export function remove(id: string) {
  set({ items: state.items.filter((l) => l.id !== id), sel: state.sel === id ? null : state.sel });
  scheduleSave();
}

/** a new layer at the playhead, selected; gif and image come back without a file, the popover fills it */
export function add(kind: LayerKind, extra: Partial<Layer> = {}): string | null {
  const v = video();
  if (!state.clip || !v || !(v.duration > 0)) return null;
  pruneEmpty(null);
  const dur = v.duration;
  const start = clamp(v.currentTime, 0, Math.max(0, dur - MIN_LEN));
  const end = Math.min(dur, start + DEFAULT_LEN[kind]);
  const base = { id: newId(), start, end: Math.max(end, start + MIN_LEN) };
  const visual = { x: 50, y: 50, ain: "fade" as const, aout: "fade" as const };
  let layer: Layer;
  if (kind === "volume") layer = { ...base, kind, track: "all", level: 0.5, fade: 0.3 };
  else if (kind === "text") layer = { ...base, ...visual, kind, text: "", style: "clean", color: "#ffffff", size: 4.6, y: 30, ain: "pop", raster: null } as TextLayer;
  else if (kind === "gif") layer = { ...base, ...visual, kind, w: 18, x: 76, y: 38, ain: "pop", file: null, aspect: 1, gif: { id: "", title: "", url: "" } };
  else layer = { ...base, ...visual, kind, w: 14, x: 84, y: 22, file: null, aspect: 1 };
  Object.assign(layer, extra);
  if (!v.paused) v.pause();
  set({ items: [...state.items, layer], sel: layer.id, menu: false });
  scheduleSave();
  return layer.id;
}

/** swaps the generated subtitle lines for a fresh set; hand-made text stays. [] just removes them */
export function replaceSubtitles(subs: TextLayer[]) {
  if (!state.clip) return;
  const keep = state.items.filter((l) => !(l.kind === "text" && l.source === "subtitles"));
  set({ items: [...keep, ...subs], sel: null });
  scheduleSave();
}

/** edits many layers at once, e.g. every subtitle line after a style change */
export function mapItems(fn: (l: Layer) => Layer) {
  set({ items: state.items.map(fn) });
  scheduleSave();
}

const isEmpty = (l: Layer) => (l.kind === "gif" || l.kind === "image" ? !l.file : l.kind === "text" ? !l.text.trim() : false);

/** drops what was added and left blank (picker closed, no text typed) once it loses selection */
function pruneEmpty(except: string | null) {
  const keep = state.items.filter((l) => l.id === except || !isEmpty(l));
  if (keep.length === state.items.length) return;
  set({ items: keep });
  scheduleSave();
}
