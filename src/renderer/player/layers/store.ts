import { useSyncExternalStore } from "react";
import type { Layer, LayerKind, TextLayer } from "../../../types/clips";
import { DEFAULT_LEN, MIN_LEN, clamp, isVisual, newId, rasterKey } from "./model";
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
  /** steps undo and redo can take */
  hist: { undo: number; redo: number };
}

let state: State = { clip: null, items: [], sel: null, menu: false, hist: { undo: 0, redo: 0 } };
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
let pending: { clip: string; items: Layer[]; keep: string[] } | null = null;

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

async function writeNow(job: { clip: string; items: Layer[]; keep: string[] }) {
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
  const res = await window.clips.saveLayers(job.clip, items, job.keep).catch((err) => ({ success: false, error: String(err) }));
  if (!res?.success) console.error("[layers] save failed:", res?.error);
}

function scheduleSave() {
  if (!state.clip) return;
  pending = { clip: state.clip, items: state.items, keep: historyMedia() };
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flush(), SAVE_MS);
}

export async function flush(): Promise<void> {
  window.clearTimeout(saveTimer);
  const job = pending;
  pending = null;
  if (job) await writeNow(job);
}

// undo and redo. a step is the layers plus the trim before an edit. edits of the same thing in quick
// succession (a drag, typing, a slider) fold into one step

interface Trim {
  start: number;
  end: number;
}
interface Snap {
  items: Layer[];
  trim: Trim | null;
}
const HISTORY = 200;
const MERGE_MS = 700;
let past: Snap[] = [];
let future: Snap[] = [];
let lastKey = "";
let lastAt = 0;
// set while undo puts a trim back, legacy reports that change like any other
let applying = false;

function liveTrim(): Trim | null {
  const s = window.legacyState;
  if (!s?.currentClip || !Number.isFinite(s.trimStartTime) || !Number.isFinite(s.trimEndTime)) return null;
  return { start: s.trimStartTime as number, end: s.trimEndTime as number };
}

const syncHist = () => set({ hist: { undo: past.length, redo: future.length } });

/** key: what is being edited; the same key within MERGE_MS joins the step before. "" never joins */
function record(key: string, before: Snap = { items: state.items, trim: liveTrim() }) {
  if (applying || !state.clip) return;
  const now = performance.now();
  const joins = key !== "" && key === lastKey && now - lastAt < MERGE_MS;
  lastKey = key;
  lastAt = now;
  if (joins) return;
  past.push(before);
  if (past.length > HISTORY) past.shift();
  future = [];
  syncHist();
}

function resetHistory() {
  past = [];
  future = [];
  lastKey = "";
  syncHist();
}

/** files a step in the history points at; the main process keeps them until the clip closes */
function historyMedia(): string[] {
  const out = new Set<string>();
  for (const snap of [...past, ...future]) {
    for (const l of snap.items) {
      if ((l.kind === "gif" || l.kind === "image" || l.kind === "sound") && l.file) out.add(l.file);
      if (l.kind === "text" && l.raster?.file) out.add(l.raster.file);
    }
  }
  return [...out];
}

function restore(snap: Snap) {
  lastKey = "";
  const sel = snap.items.some((l) => l.id === state.sel) ? state.sel : null;
  set({ items: snap.items, sel, menu: false });
  scheduleSave();
  const now = liveTrim();
  if (snap.trim && now && (Math.abs(snap.trim.start - now.start) > 1e-4 || Math.abs(snap.trim.end - now.end) > 1e-4)) {
    applying = true;
    try {
      window.legacyPlayer?.setTrim?.(snap.trim.start, snap.trim.end);
    } finally {
      applying = false;
    }
  }
}

export function undo(): boolean {
  const snap = past.pop();
  if (!snap) return false;
  future.push({ items: state.items, trim: liveTrim() });
  restore(snap);
  syncHist();
  return true;
}

export function redo(): boolean {
  const snap = future.pop();
  if (!snap) return false;
  past.push({ items: state.items, trim: liveTrim() });
  restore(snap);
  syncHist();
  return true;
}

// legacy owns the trim and says what it was before each change
window.addEventListener("cliplib:trim-change", (e) => {
  const d = (e as CustomEvent<{ clip: string; prev: Trim }>).detail;
  if (!d?.prev || d.clip !== state.clip) return;
  record("trim", { items: state.items, trim: d.prev });
});

/** the last save of a clip drops media only the history still held */
function closeHistory() {
  if (state.clip && (past.length || future.length)) pending = { clip: state.clip, items: state.items, keep: [] };
  resetHistory();
}

export function loadClip(clip: string, items: Layer[]) {
  pruneEmpty(null);
  closeHistory();
  void flush();
  set({ clip, items: Array.isArray(items) ? items : [], sel: null, menu: false });
}

export function closeClip() {
  pruneEmpty(null);
  closeHistory();
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

/** history: false for follow-ups the user didn't make, a download landing or a probed length */
export function update(id: string, patch: Partial<Layer>, opts: { history?: boolean } = {}) {
  if (opts.history !== false) record(`u:${id}:${Object.keys(patch).sort().join(",")}`);
  set({ items: state.items.map((l) => (l.id === id ? ({ ...l, ...patch } as Layer) : l)) });
  scheduleSave();
}

export function remove(id: string) {
  record("");
  set({ items: state.items.filter((l) => l.id !== id), sel: state.sel === id ? null : state.sel });
  scheduleSave();
}

/** a new layer at the playhead, selected; gif, image and sound come back without a file, the
 * popover fills it */
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
  else if (kind === "image") layer = { ...base, ...visual, kind, w: 14, x: 84, y: 22, file: null, aspect: 1 };
  else if (kind === "zoom") layer = { ...base, kind, x: 50, y: 50, scale: 1.6, ease: 0.4 };
  else if (kind === "speed") layer = { ...base, kind, rate: 0.5 };
  else if (kind === "blur") layer = { ...base, kind, x: 50, y: 50, w: 22, h: 12, mode: "blur", strength: 0.6 };
  else layer = { ...base, kind, file: null, name: "", level: 1, fade: 0, duration: 0 };
  Object.assign(layer, extra);
  if (!v.paused) v.pause();
  record("");
  set({ items: [...state.items, layer], sel: layer.id, menu: false });
  scheduleSave();
  return layer.id;
}

/** swaps the generated subtitle lines for a fresh set; hand-made text stays. [] just removes them */
export function replaceSubtitles(subs: TextLayer[]) {
  if (!state.clip) return;
  record("");
  const keep = state.items.filter((l) => !(l.kind === "text" && l.source === "subtitles"));
  set({ items: [...keep, ...subs], sel: null });
  scheduleSave();
}

/** edits many layers at once, e.g. every subtitle line after a style change */
export function mapItems(fn: (l: Layer) => Layer) {
  record("map");
  set({ items: state.items.map(fn) });
  scheduleSave();
}

// copy, paste and duplicate. the clipboard outlives the clip, so a layer can move to another one

let clipboard: { clip: string; items: Layer[] } | null = null;

export function copySelected(): boolean {
  const l = state.items.find((x) => x.id === state.sel);
  if (!l || !state.clip) return false;
  clipboard = { clip: state.clip, items: [structuredClone(l)] };
  return true;
}

export const canPaste = () => Boolean(clipboard?.items.length);

/** a copy of l with a new id; text renders its png again, and a subtitle line becomes hand-made
 * so the next subtitle run leaves it alone */
function fresh(l: Layer): Layer {
  const c = { ...structuredClone(l), id: newId() } as Layer;
  if (c.kind === "text") {
    c.raster = null;
    delete c.source;
  }
  return c;
}

/** media of a layer from another clip lives in that clip's folder, it gets its own copy */
function adoptMedia(clip: string, l: Layer) {
  if (l.kind !== "gif" && l.kind !== "image" && l.kind !== "sound") return;
  if (!l.file) return;
  window.clips
    .copyLayerMedia(clip, l.file)
    .then(({ file }) => {
      if (state.clip === clip && file !== l.file) update(l.id, { file }, { history: false });
    })
    .catch((err) => console.error("[layers] media copy failed:", err));
}

function insert(copies: Layer[]) {
  if (!state.clip || !copies.length) return;
  record("");
  set({ items: [...state.items, ...copies], sel: copies[copies.length - 1].id, menu: false });
  scheduleSave();
  for (const c of copies) adoptMedia(state.clip, c);
}

/** pastes at the playhead, same lengths and spacing as when copied */
export function paste(): boolean {
  const v = video();
  if (!clipboard?.items.length || !state.clip || !v || !(v.duration > 0)) return false;
  const dur = v.duration;
  const first = Math.min(...clipboard.items.map((l) => l.start));
  const at = clamp(v.currentTime, 0, Math.max(0, dur - MIN_LEN));
  const copies = clipboard.items.map((l) => {
    const c = fresh(l);
    const len = Math.min(l.end - l.start, dur);
    c.start = clamp(at + (l.start - first), 0, Math.max(0, dur - len));
    c.end = Math.min(dur, c.start + len);
    return c;
  });
  if (!v.paused) v.pause();
  insert(copies);
  return true;
}

/** a copy right after the selected layer, or on top of it nudged aside when the clip ends first */
export function duplicateSelected(): boolean {
  const l = state.items.find((x) => x.id === state.sel);
  const v = video();
  if (!l || !v || !(v.duration > 0)) return false;
  const len = l.end - l.start;
  const c = fresh(l);
  if (l.end + len <= v.duration + 0.001) {
    c.start = l.end;
    c.end = Math.min(v.duration, l.end + len);
  } else if (isVisual(c) || c.kind === "blur") {
    c.x = clamp(c.x + 3, 0, 100);
    c.y = clamp(c.y + 3, 0, 100);
  }
  insert([c]);
  return true;
}

const isEmpty = (l: Layer) =>
  l.kind === "gif" || l.kind === "image" || l.kind === "sound" ? !l.file : l.kind === "text" ? !l.text.trim() : false;

/** drops what was added and left blank (picker closed, no text typed) once it loses selection */
function pruneEmpty(except: string | null) {
  const keep = state.items.filter((l) => l.id === except || !isEmpty(l));
  if (keep.length === state.items.length) return;
  // the add that made the blank one leaves no step behind
  const top = past[past.length - 1];
  if (top && top.items.length === keep.length && top.items.every((l, i) => l.id === keep[i].id)) {
    past.pop();
    syncHist();
  }
  set({ items: keep });
  scheduleSave();
}
