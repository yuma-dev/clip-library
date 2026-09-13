// Boot reveal: the hand-over from the native launcher's splash to the library.
//
// Main shows the window at opacity 0 once the compositor has framed the grid,
// then asks the renderer (boot-reveal) to put the library into the animation's
// first frame: the launcher's logo drawn at the exact same screen spot over a
// dark, far-away library. The renderer replies (boot-reveal-armed) once that
// frame is composited and main makes the window opaque. From there the camera
// flies through the logo: the logo grows past the viewport and fades while
// the whole library dollies in from 1.5x to rest and a vignette lifts. About
// a second, four composited layers (body, cover, vignette, hero), transform
// and opacity only; nothing repaints. Hover is off on the body meanwhile (a
// hover style would repaint a card tile inside the moving body); any press,
// wheel or key ends the intro at once and lands on the library at rest.
//
// Everything the animation moves exists before the window is revealed
// (prepareBootReveal, called right before renderer-ready): the library body is
// promoted to its own layer and the overlay is mounted while the window is
// still at OS opacity 0, so the pre-reveal compositor frames rasterise every
// texture the animation needs. Creating those layers at the first animated
// frame was a measured 67 ms stall (benchmark/analyze-reveal.js).
import { bootMark } from "../perf/bootMarks";
import type { BootRevealPayload } from "../../types/clips";
import titleUrl from "../../../assets/title.png";
import { holdStreaming, holdCommits, releaseBoot, onBootRelease } from "./bootHold";

const MEASURE_MS = 1200;
const SETTLE_MS = 1300;

let body: HTMLElement | null = null;
let shell: HTMLElement | null = null;
let overlay: HTMLDivElement | null = null;
let preparedLogo: BootRevealPayload["logo"] = null;
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

function buildOverlay(logo: BootRevealPayload["logo"]): HTMLDivElement {
  const origin = originOf(logo);
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

function placeBody(logo: BootRevealPayload["logo"]): void {
  if (!body) return;
  const origin = originOf(logo);
  const r = body.getBoundingClientRect();
  body.style.transformOrigin = `${origin.x - r.left}px ${origin.y - r.top}px`;
}

/**
 * Promote the library body, mount the overlay and hold the background
 * streaming, before renderer-ready. The window is at OS opacity 0 until the
 * reveal, so none of this is visible yet.
 */
export async function prepareBootReveal(): Promise<void> {
  if (reducedMotion()) return;
  holdStreaming();
  body = document.querySelector<HTMLElement>(".app-body");
  shell = document.querySelector<HTMLElement>(".app-shell");
  body?.classList.add("boot-pre");
  try {
    preparedLogo = (await window.clips?.getBootLogoRect?.()) ?? null;
  } catch {
    preparedLogo = null;
  }
  placeBody(preparedLogo);
  overlay = buildOverlay(preparedLogo);
  document.body.appendChild(overlay);
  // Never leave any of it behind if the reveal event does not arrive.
  window.setTimeout(clearPrepared, 8000);
}

function clearPrepared(): void {
  if (body) {
    body.classList.remove("boot-pre", "boot-dolly");
    body.style.removeProperty("transform-origin");
  }
  shell?.classList.remove("boot-clip");
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
    clearPrepared();
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
  shell?.classList.add("boot-clip");
  body?.classList.add("boot-dolly");
  for (const el of layer.children) el.classList.add("run");

  // Hold every animation at its first frame until main confirms the window is
  // opaque: the pause runs on the compositor, so releasing it costs nothing.
  const held = [body, ...layer.children].flatMap((el) => (el ? el.getAnimations() : []));
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
    clearPrepared();
  };
  onBootRelease(finish);
  window.setTimeout(() => {
    finish();
    releaseBoot();
  }, SETTLE_MS);
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
