// Boot reveal: hand-over from the native launcher's splash to the library. Main shows
// the window at opacity 0, arms the intro (mark frozen over a dark cover), then the star
// opens into a star-shaped portal onto the library (starPortal.ts); transform/opacity only,
// so nothing repaints, and any press/wheel/key ends it early and lands at rest.
import { bootMark } from "../perf/bootMarks";
import type { BootRevealPayload } from "../../types/clips";
import cornersUrl from "../../../assets/setsu/hero-corners.png";
import glowUrl from "../../../assets/setsu/hero-glow.png";
import {
  animateCorner, animateFlash, animateGlow, animateHole, animateRim, animateStar, animateVignette,
  landsAt, portalScaleK, zoom, FLASH_RATIO, GLOW_AT_MS, HOLE_RATIO, MOTES_AT_MS, SOUND_DELAY_MS, UNSEEN,
} from "./starPortal";
import { holdStreaming, holdCommits, releaseBoot, releaseStreaming, onBootRelease, onScrollInput, markRevealed } from "./bootHold";
import { preloadBootSound, startBootSound, disposeBootSound } from "./bootSound";
import { getBootPrefs, installBootPrefsConsole, type BootPrefs } from "./bootPrefs";
import { trackPointer, rehoverUnderPointer } from "../library/rehover";

// Read once per launch (dev console changes apply at the next one).
let prefs: BootPrefs = getBootPrefs();

const MEASURE_MS = 1200;
const MEASURE_TAIL_MS = 6000;
// The body, cards and glow are back to normal here; the hold lifts. the last card lands by ~1.5s
const SETTLE_MS = 1600;
// motes drift on after the intro; overlay leaves when they finish or at this cap
const OVERLAY_CAP_MS = 5600;
const MAX_CARDS = 64;
const MOTES = 30;
// each mote's own run ends here, counted from MOTES_AT_MS
const MOTES_END_MS = 4400;
// The glow canvas is drawn at a quarter of the viewport; the blur is baked
// in at that scale (CSS scales it back up, blur hides the resolution).
const GLOW_SCALE = 0.25;
const GLOW_BLUR_PX = 11;
// everything in the overlay that animates; the reveal starts, holds and waits on these
const OVERLAY_PARTS = ".boot-cover, .boot-vignette, .boot-flash, .boot-part, .boot-mote";
const STAR_PATH = "M500 63A437 437 0 0 0 937 500A437 437 0 0 0 500 937A437 437 0 0 0 63 500A437 437 0 0 0 500 63Z";

/** a canvas `w` x `h` css px backed at `res` device px per css px, drawn once by `draw` in css px */
function canvasPart(className: string, w: number, h: number, res: number, draw: (ctx: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.className = className;
  c.width = Math.max(1, Math.round(w * res));
  c.height = Math.max(1, Math.round(h * res));
  const ctx = c.getContext("2d");
  if (ctx) {
    ctx.scale(c.width / w, c.height / h);
    draw(ctx);
  }
  return c;
}

/** STAR_PATH (a 1000 box) as a `size` px star centred in a `box` px square */
function starAt(box: number, size: number): string {
  const f = size / 1000;
  const o = (box - size) / 2;
  const p = (x: number, y: number) => `${(o + x * f).toFixed(2)} ${(o + y * f).toFixed(2)}`;
  const r = (437 * f).toFixed(2);
  return `M${p(500, 63)}A${r} ${r} 0 0 0 ${p(937, 500)}A${r} ${r} 0 0 0 ${p(500, 937)}A${r} ${r} 0 0 0 ${p(63, 500)}A${r} ${r} 0 0 0 ${p(500, 63)}Z`;
}
// the launcher's last frame, one layer per moving part (bake-splash.mjs): glow, corners, star
const CORNERS = [
  { dx: -1, dy: -1, clip: "inset(0 50% 50% 0)" },
  { dx: 1, dy: -1, clip: "inset(0 0 50% 50%)" },
  { dx: 1, dy: 1, clip: "inset(50% 0 0 50%)" },
  { dx: -1, dy: 1, clip: "inset(50% 50% 0 0)" },
];

let body: HTMLElement | null = null;
let shell: HTMLElement | null = null;
let overlay: HTMLDivElement | null = null;
let glowCanvas: HTMLCanvasElement | null = null;
let cards: HTMLElement[] = [];
let heads: HTMLElement[] = [];
let rail: HTMLElement | null = null;
let preparedLogo: BootRevealPayload["logo"] = null;
let heroDecoded: Promise<unknown> = Promise.resolve();
let installed = false;
let handled = false;
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

function img(className: string, src: string, css: string): HTMLImageElement {
  const el = document.createElement("img");
  el.className = className;
  el.src = src;
  el.draggable = false;
  el.alt = "";
  el.style.cssText = css;
  return el;
}

function buildOverlay(logo: BootRevealPayload["logo"]): HTMLDivElement {
  const origin = originOf(logo);
  // launched without the launcher: the star still opens the portal, from the middle
  const markSize = logo ? logo.w : Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.1);
  const box = `left:${origin.x - markSize / 2}px;top:${origin.y - markSize / 2}px;width:${markSize}px;height:${markSize}px;`;
  const el = document.createElement("div");
  el.id = "boot-reveal";
  el.dataset.k = String(portalScaleK(markSize));

  // the cover with a star-shaped hole in its middle, scaled about it: the portal. big enough to
  // still cover the farthest window corner when the star breathes in to 0.93
  const corners = [[0, 0], [window.innerWidth, 0], [0, window.innerHeight], [window.innerWidth, window.innerHeight]];
  const reach = Math.max(...corners.map(([x, y]) => Math.hypot(x - origin.x, y - origin.y)));
  const coverSize = Math.ceil((reach / 0.93) * 2) + 8;
  const hole = markSize * HOLE_RATIO;
  // the hole is cut in the svg's own path (evenodd), not with a css mask: a mask is a render pass the
  // gpu composites every frame, and its first use compiled a shader mid-reveal (a 200-480ms freeze
  // in traces). an svg path rasters once into the layer and the zoom only upscales it
  // a canvas, not a css mask or an svg (see starPortal zoom): drawn once, the gpu scales the texture.
  // half resolution is plenty, the hole's edge sits under the star until it grows soft anyway
  const dpr = window.devicePixelRatio || 1;
  const cover = canvasPart("boot-cover", coverSize, coverSize, dpr / 2, (ctx) => {
    ctx.fillStyle = "#050608";
    ctx.fill(new Path2D(`M0 0H${coverSize}V${coverSize}H0Z${starAt(coverSize, hole)}`), "evenodd");
  });
  cover.style.cssText = `left:${origin.x - coverSize / 2}px;top:${origin.y - coverSize / 2}px;width:${coverSize}px;height:${coverSize}px;`;
  el.appendChild(cover);

  // Darkness everywhere but around the logo; lifts as the library arrives.
  const vignette = document.createElement("div");
  vignette.className = "boot-vignette";
  vignette.style.cssText = `--boot-ox:${origin.x}px;--boot-oy:${origin.y}px;opacity:${UNSEEN};`;
  el.appendChild(vignette);

  // afterglow bloom; mounted at its starting scale so the will-change layer keeps
  // that raster scale, the 5x growth is just the GPU upscaling a small texture
  const flashSize = markSize * FLASH_RATIO;
  const flash = canvasPart("boot-flash", flashSize, flashSize, dpr / 2, (ctx) => {
    const r = flashSize / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, "rgba(199, 116, 224, 0.85)");
    g.addColorStop(0.35, "rgba(142, 50, 155, 0.35)");
    g.addColorStop(0.68, "rgba(142, 50, 155, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, flashSize, flashSize);
  });
  flash.style.cssText = `left:${origin.x - flashSize / 2}px;top:${origin.y - flashSize / 2}px;width:${flashSize}px;height:${flashSize}px;transform:${zoom(0.3)};opacity:${UNSEEN};`;
  if (!prefs.afterglow) flash.style.display = "none";
  el.appendChild(flash);

  // motes: light drifting up from the clips; created here (layer must exist
  // before the reveal), placed over the cards by placeMotes
  const rnd = seeded(0x5eed);
  const motesLayer = document.createElement("div");
  motesLayer.className = "boot-motes";
  for (let j = 0; j < (prefs.motes ? MOTES : 0); j++) {
    const m = document.createElement("div");
    m.className = "boot-mote";
    const dx = (rnd() - 0.5) * 80;
    const dy = -40 - rnd() * 90;
    const size = 2 + Math.round(rnd() * 2);
    const delay = 100 + j * 24;
    m.style.cssText = `left:-10px;top:-10px;width:${size}px;height:${size}px;--boot-dx:${dx.toFixed(0)}px;--boot-dy:${dy.toFixed(0)}px;--boot-d:${MOTES_AT_MS + delay}ms;--boot-dur:${MOTES_END_MS - delay}ms;`;
    motesLayer.appendChild(m);
  }
  el.appendChild(motesLayer);

  // every part decoded before the window turns opaque, or it pops in at the handoff
  const decodes: Promise<unknown>[] = [];
  const decode = (i: HTMLImageElement) => {
    if (typeof i.decode === "function") decodes.push(i.decode().catch(() => {}));
    return i;
  };
  if (logo) {
    el.appendChild(decode(img("boot-part boot-glowmark", glowUrl, box)));
    // the corners are css backgrounds (clip-path per quarter), decoded through a spare image
    const spare = new Image();
    spare.src = cornersUrl;
    decode(spare);
    for (const c of CORNERS) {
      const corner = document.createElement("div");
      corner.className = "boot-part boot-corner";
      corner.dataset.dx = String(c.dx);
      corner.dataset.dy = String(c.dy);
      corner.style.cssText = `${box}background-image:url("${cornersUrl}");clip-path:${c.clip};`;
      el.appendChild(corner);
    }
  }
  // star and rim at 2x the screen's density: crisp at rest, they're fading by the time they're big
  const star = canvasPart("boot-part boot-star", markSize, markSize, dpr * 2, (ctx) => {
    ctx.scale(markSize / 1000, markSize / 1000);
    ctx.fillStyle = "#fffeff";
    ctx.fill(new Path2D(STAR_PATH));
  });
  star.style.cssText = box;
  el.appendChild(star);
  // the portal's edge: a thin lit outline of the hole with its glow baked in (a css drop-shadow was
  // a render pass every frame and compiled a shader on first use). the canvas overhangs the mark
  // for the glow, same centre
  const rimPad = markSize * 0.25;
  const rimSize = markSize + rimPad * 2;
  const rim = canvasPart("boot-part boot-rim", rimSize, rimSize, dpr * 2, (ctx) => {
    ctx.translate(rimPad, rimPad);
    ctx.scale(markSize / 1000, markSize / 1000);
    const path = new Path2D(STAR_PATH);
    ctx.filter = "blur(30px)";
    ctx.strokeStyle = "rgba(216, 68, 221, 0.9)";
    ctx.lineWidth = 40;
    ctx.stroke(path);
    ctx.filter = "none";
    ctx.strokeStyle = "#f3dcff";
    ctx.lineWidth = 14;
    ctx.stroke(path);
  });
  rim.style.cssText = `left:${origin.x - rimSize / 2}px;top:${origin.y - rimSize / 2}px;width:${rimSize}px;height:${rimSize}px;opacity:${UNSEEN};`;
  el.appendChild(rim);
  heroDecoded = Promise.all(decodes);
  return el;
}

/** one Web Animation per overlay part (starPortal.ts); created playing, the caller holds them */
function startPortal(layer: HTMLElement): void {
  const k = Number(layer.dataset.k) || 1;
  const one = (sel: string) => layer.querySelector<HTMLElement>(sel);
  const cover = one(".boot-cover");
  if (cover) animateHole(cover);
  const vignette = one(".boot-vignette");
  if (vignette) animateVignette(vignette);
  const flash = one(".boot-flash");
  if (flash) animateFlash(flash);
  const glow = one(".boot-glowmark");
  if (glow) animateGlow(glow);
  for (const c of layer.querySelectorAll<HTMLElement>(".boot-corner")) animateCorner(c, Number(c.dataset.dx), Number(c.dataset.dy), k);
  const star = one(".boot-star");
  if (star) animateStar(star);
  const rim = one(".boot-rim");
  if (rim) animateRim(rim);
}

/** content-visibility groups near the intro's 1.5x-to-1x push get laid out/painted
 * mid-animation (250ms stall); mark them live, hide the rest, settleGrid lifts it. */
function markLiveGroups(): void {
  const vh = window.innerHeight;
  for (const el of document.querySelectorAll<HTMLElement>(".clip-group-content")) {
    const r = el.getBoundingClientRect();
    if (r.bottom > -vh * 0.5 && r.top < vh * 1.5) el.classList.add("boot-live");
  }
}

/** every visible card's thumbnail drawn blurred+saturated into one canvas behind the
 * cards (like the shared hover glow); baked in once so the intro only animates opacity. */
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

/** redraws the glow at cards' current positions; a fresh clip list can land between
 * prepare and reveal and shift the rows, so a stale glow reads as a ghost card. */
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
    // no thumbnail yet (still generating): glow in accent colour instead
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

/** promotes/mounts everything the intro moves and holds streaming, before
 * renderer-ready; creating those layers at the first frame cost 67ms (analyze-reveal.js). */
export async function prepareBootReveal(): Promise<void> {
  if (reducedMotion()) return;
  holdStreaming();
  trackPointer();
  // Sound layers decode now; muted when hover previews are muted.
  void Promise.resolve(window.clips?.getSettings?.())
    .then((s) => preloadBootSound(Number(s?.previewVolume ?? 1) <= 0))
    .catch(() => preloadBootSound(false));
  body = document.querySelector<HTMLElement>(".app-body");
  shell = document.querySelector<HTMLElement>(".app-shell");
  rail = document.querySelector<HTMLElement>(".rail");
  cards = visibleCards();
  heads = visibleHeaders();
  for (const el of [body, rail, ...heads, ...cards]) el?.classList.add("boot-pre");
  arm();
  body?.classList.add("boot-nohover");
  markLiveGroups();
  glowCanvas = prefs.glow ? buildGlowCanvas(cards) : null;
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
// still will-change promoted after settling; depromote() clears a few per frame
let promoted: HTMLElement[] = [];

/** visuals settled: hover back, animation classes off (end state = natural, no visual
 * change), glow canvas removed. will-change stays: dropping 40+ layers at once cost 120ms. */
function settleGrid(): void {
  if (body) {
    body.classList.remove("boot-nohover", "boot-dolly");
    body.style.removeProperty("transform-origin");
  }
  for (const el of document.querySelectorAll<HTMLElement>(".clip-group-content.boot-live")) el.classList.remove("boot-live");
  shell?.classList.remove("boot-clip");
  for (const el of [rail, ...heads, ...cards]) {
    if (!el) continue;
    el.classList.remove("boot-par");
    el.style.removeProperty("--boot-d");
  }
  glowCanvas?.remove();
  glowCanvas = null;
  promoted = [body, rail, ...heads, ...cards].filter((el): el is HTMLElement => !!el && el.classList.contains("boot-pre"));
  cards = [];
  heads = [];
  rehoverUnderPointer();
}

/** Drop the will-change promotions, `perFrame` elements a frame (or all at once). */
function depromote(perFrame: number): void {
  const list = promoted;
  promoted = [];
  const step = () => {
    for (const el of list.splice(0, perFrame)) el.classList.remove("boot-pre");
    if (list.length) requestAnimationFrame(step);
  };
  step();
}

/** the library sits in the intro's first frame while the window is still hidden, so everything is
 * rastered in the pose the animations start from. otherwise the first real frame re-rastered every
 * card at its new scale mid-reveal (60-160ms stalls in traces). onReveal swaps this for the
 * animations in the same task; their backwards fill holds the very same values */
function arm(): void {
  body?.classList.add("boot-armed");
  if (prefs.parallax) for (const el of [rail, ...heads, ...cards]) el?.classList.add("boot-armed");
}

function disarm(): void {
  for (const el of document.querySelectorAll(".boot-armed")) el.classList.remove("boot-armed");
}

function clearAll(): void {
  disarm();
  settleGrid();
  depromote(8);
  detachWind();
  overlay?.remove();
  overlay = null;
}

// motes sit in a fixed overlay; follow scroll via one transform write per scroll
// event on their promoted layer, so they track the content 1:1
let windOff: (() => void) | null = null;

function attachWind(layer: HTMLElement): void {
  const motes = layer.querySelector<HTMLElement>(".boot-motes");
  const scroller = document.querySelector<HTMLElement>(".clip-scroll");
  if (!motes || !scroller) return;
  const start = scroller.scrollTop;
  let raf = 0;
  const apply = () => {
    raf = 0;
    motes.style.transform = `translateY(${(start - scroller.scrollTop).toFixed(1)}px)`;
  };
  const onScroll = () => {
    if (!raf) raf = requestAnimationFrame(apply);
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  windOff = () => {
    scroller.removeEventListener("scroll", onScroll);
    if (raf) cancelAnimationFrame(raf);
  };
}

function detachWind(): void {
  windOff?.();
  windOff = null;
}

// bench only (CLIPLIB_BOOT_TRACE): forces a main-thread rAF loop every frame that a
// compositor-only animation wouldn't otherwise need; normal launches stay idle
function measureFrames(): void {
  if (!window.__bootTrace) return;
  let visChanges = 0;
  document.addEventListener("visibilitychange", () => {
    visChanges += 1;
    if (visChanges <= 4) bootMark(`visibility_${document.visibilityState}_${visChanges}`);
  });
  // two windows: the animation itself (1.2s) and the tail to 6s where held
  // work resumes and must not be felt either
  const deltas: number[] = [];
  const tail: number[] = [];
  let last = performance.now();
  const start = last;
  const stats = (list: number[]) => {
    const sorted = [...list].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : 0;
    return { frames: list.length, p95: Math.round(p95 * 10) / 10, max: Math.round(Math.max(0, ...list)), over25: list.filter((d) => d > 25).length };
  };
  const origin = performance.timeOrigin;
  let gaps = 0;
  const tick = (t: number) => {
    (t - start < MEASURE_MS ? deltas : tail).push(t - last);
    if (t - last > 90 && gaps < 3) {
      gaps += 1;
      bootMark(`tail_gap${gaps}_from`, origin + last);
      bootMark(`tail_gap${gaps}_to`, origin + t);
    }
    last = t;
    if (t - start < MEASURE_TAIL_MS) {
      requestAnimationFrame(tick);
      return;
    }
    window.clips?.bootRevealFrames({ animated: true, ...stats(deltas), tail: stats(tail) });
    bootMark("reveal_anim_done");
  };
  requestAnimationFrame(tick);
}

async function onReveal(payload: BootRevealPayload): Promise<void> {
  if (handled) return;
  handled = true;
  markRevealed();
  const animate = Boolean(payload?.animate) && !reducedMotion() && !!(body ?? document.querySelector(".app-body"));
  if (!animate) {
    // Take the pre-mounted overlay down and let that frame commit before the
    // window turns opaque, so the plain reveal never shows the logo twin.
    clearAll();
    disposeBootSound();
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

  // overlay mounted at prepare time; rebuilt only if the logo rect differs (maximize
  // can shift it a few px) or if prepare never ran
  const same = (a: BootRevealPayload["logo"], b: BootRevealPayload["logo"]) =>
    (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
  if (!overlay || !same(preparedLogo, logo)) {
    overlay?.remove();
    overlay = buildOverlay(logo);
    document.body.appendChild(overlay);
    placeBody(logo);
  }
  const layer = overlay;
  // a broken image just means that part is missing, the rest still runs
  await heroDecoded;

  // layout may have changed since prepare (fresh list landed): repick cards/headers
  // promote new ones, redraw glow at the new positions
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

  // Parallax delays: each piece lands just before the portal's edge reaches it.
  const origin = originOf(logo);
  const k = Number(layer.dataset.k) || 1;
  for (const el of [rail, ...heads, ...cards]) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const dist = Math.hypot(r.left + r.width / 2 - origin.x, r.top + r.height / 2 - origin.y);
    el.style.setProperty("--boot-d", `${Math.round(landsAt(dist, k))}ms`);
  }
  shell?.classList.add("boot-clip");
  body?.classList.add("boot-dolly");
  if (prefs.parallax) for (const el of [rail, ...heads, ...cards]) el?.classList.add("boot-par");
  disarm();
  if (glowCanvas) {
    glowCanvas.style.animationDelay = `${GLOW_AT_MS}ms`;
    glowCanvas.classList.add("run");
  }
  for (const el of layer.querySelectorAll(OVERLAY_PARTS)) el.classList.add("run");
  startPortal(layer);
  attachWind(layer);

  // hold every animation at its first frame til main confirms the window is opaque;
  // the pause runs on the compositor so releasing it costs nothing
  const animated = [body, rail, ...heads, ...cards, glowCanvas, ...layer.querySelectorAll<HTMLElement>(OVERLAY_PARTS)];
  const held = animated.flatMap((el) => (el ? el.getAnimations() : []));
  for (const a of held) a.pause();
  await twoFrames();
  window.clips?.bootRevealArmed();
  for (const a of held) a.play();
  // woosh as the portal opens, after the star breathes in
  startBootSound({ woosh: prefs.sound && prefs.woosh, chimes: prefs.sound && prefs.chimes, motes: prefs.sound && prefs.motesSound, wind: prefs.sound && prefs.wind }, SOUND_DELAY_MS / 1000);
  measureFrames();

  // hold lifts at settle time or at once on input, then jumps to end state
  let over = false; // everything torn down
  let settledNormally = false; // settle timer released the hold (not input)
  const cutShort = () => {
    if (over || settledNormally) return;
    over = true;
    for (const a of held) {
      try {
        a.finish();
      } catch {
        /* an animation removed with its element */
      }
    }
    clearAll();
    // sound plays on: the one part of the intro that doesn't block the user
    disposeBootSound();
  };
  onBootRelease(cutShort);
  // A scroll only needs the library to respond: hover back, holds lifted
  // the visuals and sound continue.
  onScrollInput(() => {
    body?.classList.remove("boot-nohover");
    rehoverUnderPointer();
  });
  window.setTimeout(() => {
    if (over) return;
    settledNormally = true;
    // streaming resumes (adaptively paced) once visuals settle; whole-grid commits
    // wait for the overlay so nothing heavy lands while the tail plays
    releaseStreaming();
    settleGrid();
  }, SETTLE_MS);
  // overlay comes down once its last animation finishes, never on a fixed
  // timer: a cut mid-fade reads as a pop
  const overlayAnims = [...layer.querySelectorAll<HTMLElement>(OVERLAY_PARTS)].flatMap((el) => el.getAnimations());
  const finished = Promise.allSettled(overlayAnims.map((a) => a.finished));
  const cap = new Promise<void>((resolve) => window.setTimeout(resolve, OVERLAY_CAP_MS));
  void Promise.race([finished, cap]).then(() => {
    if (over) return;
    over = true;
    clearAll();
    disposeBootSound();
    releaseBoot();
  });
}

/** Subscribe once; returns the unsubscribe for React's effect cleanup. */
export function installBootReveal(): () => void {
  if (installed || !window.clips?.onBootReveal) return () => {};
  installed = true;
  installBootPrefsConsole();
  prefs = getBootPrefs();
  const off = window.clips.onBootReveal((payload) => {
    void onReveal(payload);
  });
  return () => {
    off();
    installed = false;
  };
}
