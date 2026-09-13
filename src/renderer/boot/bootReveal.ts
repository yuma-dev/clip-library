// Boot reveal: the hand-over from the native launcher's splash to the library.
//
// Main shows the window at opacity 0 once the compositor has framed the grid,
// then asks the renderer (boot-reveal) to put the library into the animation's
// first frame: the launcher's logo drawn at the exact same screen spot over a
// dark, far-away library. The renderer replies (boot-reveal-armed) once that
// frame is composited and main makes the window opaque. From there the camera
// flies through the logo: the logo grows past the viewport and fades inside a
// bloom of the accent colour, the whole library body pushes in from 1.5x to
// rest while the rail, the group headers and the cards land from their own
// depths, every card's colour glow blooms and settles, a vignette lifts and a
// few motes of light drift across the library for a moment. Transform and
// opacity only, on layers that all exist before the reveal; nothing repaints.
// Hover is off on the body meanwhile (a hover style would repaint a card tile
// inside the moving body); any press, wheel or key ends the intro at once and
// lands on the library at rest.
//
// Everything the animation moves exists before the window is revealed
// (prepareBootReveal, called right before renderer-ready): the body and the
// visible cards are promoted to their own layers, the glow is baked into a
// canvas and the overlay is mounted while the window is still at OS opacity 0,
// so the pre-reveal compositor frames rasterise every texture the animation
// needs. Creating those layers at the first animated frame was a measured
// 67 ms stall (benchmark/analyze-reveal.js).
import { bootMark } from "../perf/bootMarks";
import type { BootRevealPayload } from "../../types/clips";
import titleUrl from "../../../assets/title.png";
import { holdStreaming, holdCommits, releaseBoot, onBootRelease } from "./bootHold";

const MEASURE_MS = 1200;
// The body, cards and glow are back to normal here; the hold lifts.
const SETTLE_MS = 1300;
// The motes drift on a little longer, on their own overlay layers.
const OVERLAY_MS = 2300;
const MAX_CARDS = 64;
const MOTES = 30;
// Parallax: rail first, then headers, then rows from the top down.
const RAIL_MS = 60;
const HEAD_MS = 120;
const ROW_START_MS = 100;
const ROW_STEP_MS = 55;
const ROW_MAX = 8;
// The glow canvas is drawn at a quarter of the viewport; the blur is baked
// in at that scale (CSS scales it back up, blur hides the resolution).
const GLOW_SCALE = 0.25;
const GLOW_BLUR_PX = 11;

let body: HTMLElement | null = null;
let shell: HTMLElement | null = null;
let overlay: HTMLDivElement | null = null;
let glowCanvas: HTMLCanvasElement | null = null;
let cards: HTMLElement[] = [];
let heads: HTMLElement[] = [];
let rail: HTMLElement | null = null;
let preparedLogo: BootRevealPayload["logo"] = null;
let installed = false;
let handled = false;
// Last pointer position while the body ignores pointer events: when the
// intro ends, whatever card sits under the cursor gets its hover back.
let pointer: Point | null = null;
const onPointerMove = (e: MouseEvent) => {
  pointer = { x: e.clientX, y: e.clientY };
};

function rehover(): void {
  window.removeEventListener("mousemove", onPointerMove);
  if (!pointer) return;
  const target = document.elementFromPoint(pointer.x, pointer.y);
  const card = target?.closest<HTMLElement>(".clip-item");
  pointer = null;
  if (!card) return;
  // React derives onMouseEnter from mouseover/mouseout pairs; a mouseover
  // coming from outside the card is what a real entry would deliver.
  card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
}

const reducedMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Point = { x: number; y: number };

function originOf(logo: BootRevealPayload["logo"]): Point {
  return logo
    ? { x: logo.x + logo.w / 2, y: logo.y + logo.h / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

function twoFrames(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function inViewport(r: DOMRect): boolean {
  return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

function visibleCards(): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(".clip-item:not(.cv-offscreen)")) {
    if (!inViewport(el.getBoundingClientRect())) continue;
    out.push(el);
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

function visibleHeaders(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".clip-group-header")].filter((el) => inViewport(el.getBoundingClientRect()));
}

// Seeded so the motes fall the same way every launch (a fixed pattern reads
// as design; a different one each time reads as noise).
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function buildOverlay(logo: BootRevealPayload["logo"]): HTMLDivElement {
  const origin = originOf(logo);
  const logoSize = logo ? logo.w : Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.1);
  const el = document.createElement("div");
  el.id = "boot-reveal";

  // Solid at first (the library is not there yet), gone within the first
  // 400 ms as the body arrives.
  const cover = document.createElement("div");
  cover.className = "boot-cover";
  el.appendChild(cover);

  // Darkness everywhere but around the logo; lifts as the library arrives.
  const vignette = document.createElement("div");
  vignette.className = "boot-vignette";
  vignette.style.cssText = `--boot-ox:${origin.x}px;--boot-oy:${origin.y}px;`;
  el.appendChild(vignette);

  // Afterglow: a bloom that expands with the logo. Mounted at its starting
  // scale: a will-change layer keeps the raster scale it was created with,
  // so the 4.5x bloom is the GPU upscaling a small texture.
  const flashSize = logoSize * 3.2;
  const flash = document.createElement("div");
  flash.className = "boot-flash";
  flash.style.cssText = `left:${origin.x - flashSize / 2}px;top:${origin.y - flashSize / 2}px;width:${flashSize}px;height:${flashSize}px;`;
  el.appendChild(flash);

  // Motes: points of light drifting up from the clips after the library
  // lands. Created here (their layers must exist before the reveal), placed
  // over the cards by placeMotes.
  const rnd = seeded(0x5eed);
  for (let j = 0; j < MOTES; j++) {
    const m = document.createElement("div");
    m.className = "boot-mote";
    const dx = (rnd() - 0.5) * 80;
    const dy = -40 - rnd() * 90;
    const size = 2 + Math.round(rnd() * 2);
    m.style.cssText = `left:-10px;top:-10px;width:${size}px;height:${size}px;--boot-dx:${dx.toFixed(0)}px;--boot-dy:${dy.toFixed(0)}px;--boot-d:${100 + j * 24}ms;`;
    el.appendChild(m);
  }

  if (logo) {
    const hero = document.createElement("img");
    hero.className = "boot-hero";
    hero.src = titleUrl;
    hero.draggable = false;
    hero.alt = "";
    hero.style.cssText = `left:${logo.x}px;top:${logo.y}px;width:${logo.w}px;height:${logo.h}px;`;
    el.appendChild(hero);
  }
  return el;
}

/**
 * Grid glow: every visible card's thumbnail drawn, blurred and saturated,
 * into one canvas behind the cards (the look of the shared hover glow,
 * `.clip-glow-canvas`, for the whole viewport at once). The blur is baked
 * into the pixels here, once, so the intro only animates the canvas's
 * opacity: a CSS filter would be applied by the compositor every frame.
 */
function buildGlowCanvas(list: HTMLElement[]): HTMLCanvasElement | null {
  const grid = document.querySelector<HTMLElement>(".clip-grid");
  const scroller = document.querySelector<HTMLElement>(".clip-scroll");
  if (!grid || !scroller || !list.length) return null;
  const cw = scroller.clientWidth;
  const ch = scroller.clientHeight;
  const canvas = document.createElement("canvas");
  canvas.className = "boot-glow";
  canvas.width = Math.max(1, Math.round(cw * GLOW_SCALE));
  canvas.height = Math.max(1, Math.round(ch * GLOW_SCALE));
  canvas.style.cssText = `left:${scroller.scrollLeft}px;top:${scroller.scrollTop}px;width:${cw}px;height:${ch}px;`;
  if (!drawGlow(canvas, list)) return null;
  grid.insertBefore(canvas, grid.firstChild);
  return canvas;
}

/**
 * (Re)draw the glow for `list` at the cards' current positions. Called at
 * prepare and again at the reveal: a fresh clip list can land in between and
 * shift the rows, and a glow left at an old position reads as a ghost card.
 */
function drawGlow(canvas: HTMLCanvasElement, list: HTMLElement[]): boolean {
  const grid = document.querySelector<HTMLElement>(".clip-grid");
  const ctx = canvas.getContext("2d");
  if (!grid || !ctx) return false;
  const gridRect = grid.getBoundingClientRect();
  ctx.filter = "none";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  try {
    ctx.filter = `blur(${GLOW_BLUR_PX}px) saturate(1.6)`;
  } catch {
    /* no canvas filters: an unblurred glow is still a glow */
  }
  let drawn = 0;
  for (const card of list) {
    const img = card.querySelector<HTMLImageElement>("img");
    if (!img) continue;
    const r = img.getBoundingClientRect();
    const x = (r.left - gridRect.left) * GLOW_SCALE;
    const y = (r.top - gridRect.top) * GLOW_SCALE;
    const w = r.width * GLOW_SCALE;
    const h = r.height * GLOW_SCALE;
    // A card with no saved thumbnail yet (a new clip, still generating) glows
    // in the accent colour instead of a thumbnail's.
    if (!img.complete || !img.naturalWidth || !img.src.includes("thumbnail-cache")) {
      ctx.fillStyle = "rgba(199, 116, 224, 0.85)";
      ctx.fillRect(x, y, w, h);
      drawn += 1;
      continue;
    }
    try {
      ctx.drawImage(img, x, y, w, h);
      drawn += 1;
    } catch {
      /* a thumbnail that cannot be drawn just does not glow */
    }
  }
  return drawn > 0;
}

/** Scatter the motes over the cards on screen (none where there is no clip). */
function placeMotes(list: HTMLElement[]): void {
  if (!overlay) return;
  const motes = [...overlay.querySelectorAll<HTMLElement>(".boot-mote")];
  const rects = list.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0);
  const rnd = seeded(0xa11ce);
  motes.forEach((m, j) => {
    if (!rects.length) {
      m.style.display = "none";
      return;
    }
    const r = rects[j % rects.length];
    m.style.display = "";
    m.style.left = `${(r.left + r.width * (0.1 + rnd() * 0.8)).toFixed(0)}px`;
    m.style.top = `${(r.top + r.height * (0.2 + rnd() * 0.7)).toFixed(0)}px`;
  });
}

function placeBody(logo: BootRevealPayload["logo"]): void {
  if (!body) return;
  const origin = originOf(logo);
  const r = body.getBoundingClientRect();
  body.style.transformOrigin = `${origin.x - r.left}px ${origin.y - r.top}px`;
}

/**
 * Promote and mount everything the intro moves, and hold the background
 * streaming, before renderer-ready. The window is at OS opacity 0 until the
 * reveal, so none of this is visible yet.
 */
export async function prepareBootReveal(): Promise<void> {
  if (reducedMotion()) return;
  holdStreaming();
  window.addEventListener("mousemove", onPointerMove, { passive: true });
  body = document.querySelector<HTMLElement>(".app-body");
  shell = document.querySelector<HTMLElement>(".app-shell");
  rail = document.querySelector<HTMLElement>(".rail");
  cards = visibleCards();
  heads = visibleHeaders();
  for (const el of [body, rail, ...heads, ...cards]) el?.classList.add("boot-pre");
  glowCanvas = buildGlowCanvas(cards);
  try {
    preparedLogo = (await window.clips?.getBootLogoRect?.()) ?? null;
  } catch {
    preparedLogo = null;
  }
  placeBody(preparedLogo);
  overlay = buildOverlay(preparedLogo);
  document.body.appendChild(overlay);
  placeMotes(cards);
  // Never leave any of it behind if the reveal event does not arrive.
  window.setTimeout(clearAll, 8000);
}

/** The body, the grid and the rail back to normal (the overlay may stay). */
function clearGrid(): void {
  if (body) {
    body.classList.remove("boot-pre", "boot-dolly");
    body.style.removeProperty("transform-origin");
  }
  shell?.classList.remove("boot-clip");
  rehover();
  for (const el of [rail, ...heads, ...cards]) {
    if (!el) continue;
    el.classList.remove("boot-pre", "boot-par");
    el.style.removeProperty("--boot-d");
  }
  glowCanvas?.remove();
  glowCanvas = null;
  cards = [];
  heads = [];
}

function clearAll(): void {
  clearGrid();
  overlay?.remove();
  overlay = null;
}

// Bench mode only (CLIPLIB_BOOT_TRACE): a requestAnimationFrame loop forces a
// main-thread lifecycle every frame, which a compositor-only animation does
// not otherwise need; in normal launches the main thread stays idle instead.
function measureFrames(): void {
  if (!window.__bootTrace) return;
  const deltas: number[] = [];
  let last = performance.now();
  const start = last;
  const tick = (t: number) => {
    deltas.push(t - last);
    last = t;
    if (t - start < MEASURE_MS) {
      requestAnimationFrame(tick);
      return;
    }
    const sorted = [...deltas].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : 0;
    window.clips?.bootRevealFrames({
      animated: true,
      frames: deltas.length,
      p95: Math.round(p95 * 10) / 10,
      max: Math.round(Math.max(0, ...deltas)),
      over25: deltas.filter((d) => d > 25).length,
    });
    bootMark("reveal_anim_done");
  };
  requestAnimationFrame(tick);
}

async function onReveal(payload: BootRevealPayload): Promise<void> {
  if (handled) return;
  handled = true;
  const animate = Boolean(payload?.animate) && !reducedMotion() && !!(body ?? document.querySelector(".app-body"));
  if (!animate) {
    // Take the pre-mounted overlay down and let that frame commit before the
    // window turns opaque, so the plain reveal never shows the logo twin.
    clearAll();
    releaseBoot();
    await twoFrames();
    window.clips?.bootRevealArmed();
    return;
  }
  bootMark("reveal_anim_start");
  holdCommits();
  body = body ?? document.querySelector<HTMLElement>(".app-body");
  shell = shell ?? document.querySelector<HTMLElement>(".app-shell");
  const logo = payload.logo;

  // Overlay: mounted at prepare time; rebuilt only if the launcher's logo rect
  // differs from what main reported then (maximize can shift the content
  // area by a few pixels) or if prepare never ran.
  const same = (a: BootRevealPayload["logo"], b: BootRevealPayload["logo"]) =>
    (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
  if (!overlay || !same(preparedLogo, logo)) {
    overlay?.remove();
    overlay = buildOverlay(logo);
    document.body.appendChild(overlay);
    placeBody(logo);
  }
  const layer = overlay;
  const hero = layer.querySelector<HTMLImageElement>(".boot-hero");
  if (hero && !hero.complete && typeof hero.decode === "function") {
    try {
      await hero.decode();
    } catch {
      /* a broken image just means no hero; the rest still runs */
    }
  }

  // The layout may have changed since prepare (a fresh list landing in
  // between): pick the cards and headers on screen now, promote any that
  // were not, and redraw the glow where the cards are.
  const before = new Set([...cards, ...heads]);
  cards = visibleCards();
  heads = visibleHeaders();
  for (const el of [...cards, ...heads]) if (!before.has(el)) el.classList.add("boot-pre");
  for (const el of before) if (!cards.includes(el) && !heads.includes(el)) el.classList.remove("boot-pre");
  if (glowCanvas && !drawGlow(glowCanvas, cards)) {
    glowCanvas.remove();
    glowCanvas = null;
  }
  placeMotes(cards);

  // Parallax delays: rail, then headers, then cards by row from the top.
  if (rail) rail.style.setProperty("--boot-d", `${RAIL_MS}ms`);
  for (const el of heads) el.style.setProperty("--boot-d", `${HEAD_MS}ms`);
  const tops = [...new Set(cards.map((el) => Math.round(el.getBoundingClientRect().top)))].sort((a, b) => a - b);
  for (const el of cards) {
    const row = Math.min(ROW_MAX, tops.indexOf(Math.round(el.getBoundingClientRect().top)));
    el.style.setProperty("--boot-d", `${ROW_START_MS + Math.max(0, row) * ROW_STEP_MS}ms`);
  }
  shell?.classList.add("boot-clip");
  body?.classList.add("boot-dolly");
  for (const el of [rail, ...heads, ...cards]) el?.classList.add("boot-par");
  glowCanvas?.classList.add("run");
  for (const el of layer.children) el.classList.add("run");

  // Hold every animation at its first frame until main confirms the window is
  // opaque: the pause runs on the compositor, so releasing it costs nothing.
  const animated = [body, rail, ...heads, ...cards, glowCanvas, ...layer.children];
  const held = animated.flatMap((el) => (el ? el.getAnimations() : []));
  for (const a of held) a.pause();
  await twoFrames();
  window.clips?.bootRevealArmed();
  for (const a of held) a.play();
  measureFrames();

  // The hold lifts at settle time, or at once on any input: then the intro
  // jumps to its end state so the user's action lands on a library at rest.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    for (const a of held) {
      try {
        a.finish();
      } catch {
        /* an animation removed with its element */
      }
    }
    clearAll();
  };
  onBootRelease(finish);
  window.setTimeout(() => {
    if (done) return;
    // Release first: the re-hover in clearGrid needs the hold to be off.
    releaseBoot();
    clearGrid();
  }, SETTLE_MS);
  window.setTimeout(() => {
    done = true;
    clearAll();
  }, OVERLAY_MS);
}

/** Subscribe once; returns the unsubscribe for React's effect cleanup. */
export function installBootReveal(): () => void {
  if (installed || !window.clips?.onBootReveal) return () => {};
  installed = true;
  const off = window.clips.onBootReveal((payload) => {
    void onReveal(payload);
  });
  return () => {
    off();
    installed = false;
  };
}
