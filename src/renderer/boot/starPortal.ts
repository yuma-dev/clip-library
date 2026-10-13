// Star portal (B5 from setsu-branding/web/dist/setsu-boot-b5.html): the star breathes in, then a
// star-shaped hole in the cover rushes past the camera with the library behind it while the
// corners ride the notches outwards (the mockup's name is left out, the splash has none). the
// mockup computes every frame from t on the main thread; here each curve is sampled once into
// Web Animations keyframes so it runs on the compositor like the rest of the intro. tau is the
// mockup's clock (0 = portal opens), lengths are mockup px (mark 120) times k = mark size / 120.

/** star breathes in for this long before the portal opens; everything else is timed after it */
export const INHALE_MS = 300;
const MOCK_MARK = 120;
const STEP_MS = 8;

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const seg = (t: number, at: number, dur: number) => clamp((t - at) / dur);

function bezier(x1: number, y1: number, x2: number, y2: number): (p: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const X = (t: number) => ((ax * t + bx) * t + cx) * t;
  const Y = (t: number) => ((ay * t + by) * t + cy) * t;
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = p;
    for (let i = 0; i < 30; i++) {
      const x = X(t);
      if (Math.abs(x - p) < 1e-6) break;
      if (x < p) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return Y(t);
  };
}

const easeOut = bezier(0.16, 1, 0.3, 1);
const rush = bezier(0.55, 0, 0.9, 0.45);
const bloom = bezier(0.2, 0.8, 0.3, 1);

/** star and hole scale: breathe in to 0.93, then rush to 24x in 640ms */
function portalScale(tau: number): number {
  if (tau < -INHALE_MS) return 1;
  if (tau < 0) return 1 - 0.07 * easeOut(seg(tau, -INHALE_MS, INHALE_MS));
  return lerp(0.93, 24, rush(seg(tau, 0, 640)));
}

// chromium rasters an animated layer at the largest scale its keyframes reach (a perspective push
// too): vector parts here went to 24x (cover), 16x (rim), 5x (flash) and stalled the portal for
// 60-130ms. the zoomed parts are canvases (bootReveal.buildOverlay), fixed textures the gpu just
// scales, so plain scale() is fine
export const zoom = (s: number) => `scale(${s})`;
// parts that fade in from nothing sit at this instead of 0 until then: chromium skips rastering an
// opacity 0 layer, so it rastered them the frame they appeared (a 60-130ms stall); at this they
// raster during the hidden pre-roll and can't be seen
export const UNSEEN = 0.002;

type Frame = { transform?: string; opacity?: number };

/** samples a curve over tau into keyframes, played from the moment the reveal starts */
function track(el: Element, endTau: number, at: (tau: number) => Frame): Animation {
  const start = -INHALE_MS;
  const total = endTau - start;
  const frames: Keyframe[] = [];
  for (let t = 0; t <= total; t += STEP_MS) frames.push({ offset: t / total, ...at(start + t) });
  if (frames[frames.length - 1].offset !== 1) frames.push({ offset: 1, ...at(endTau) });
  return el.animate(frames, { duration: total, fill: "both", easing: "linear" });
}

export const animateStar = (el: Element) =>
  track(el, 240, (tau) => ({ transform: zoom(portalScale(tau)), opacity: 1 - easeOut(seg(tau, 20, 200)) }));

/** the cover, scaled about the hole in its middle */
export const animateHole = (el: Element) =>
  track(el, 700, (tau) => ({ transform: zoom(portalScale(tau)), opacity: 1 - seg(tau, 420, 260) }));

export const animateRim = (el: Element) =>
  track(el, 580, (tau) => ({ transform: zoom(portalScale(tau)), opacity: tau < 10 ? UNSEEN : seg(tau, 10, 60) * (1 - seg(tau, 260, 300)) }));

export const animateGlow = (el: Element) => track(el, 160, (tau) => ({ opacity: 1 - seg(tau, 0, 150) }));

export function animateCorner(el: Element, dx: number, dy: number, k: number): Animation {
  return track(el, 480, (tau) => {
    const over = Math.max(0, portalScale(tau) - 1);
    const d = 15.4 * over * k;
    return { transform: `translate(${dx * d}px,${dy * d}px) scale(${1 + 0.04 * over})`, opacity: 1 - seg(tau, 200, 260) };
  });
}

export function animateVignette(el: Element): Animation {
  return track(el, 1340, (tau) => ({ opacity: tau < 300 ? UNSEEN : 1 - seg(tau, 420, 900) }));
}

export function animateFlash(el: Element): Animation {
  return track(el, 1080, (tau) => {
    const e = bloom(seg(tau, 300, 760));
    return { transform: zoom(lerp(0.3, 5, e)), opacity: tau < 300 ? UNSEEN : 0.9 * (1 - e) };
  });
}

// the mockup lands each piece just before the hole reaches it, the far ones as late as 580ms in;
// with their 700ms entrance that left an empty grid under the glow once the cover was gone.
// the wave keeps its order but is squeezed into the first ~350ms
const WAVE_SQUEEZE = 0.55;

/** when a library piece `dist` px from the mark centre starts landing, ms after the reveal starts */
export function landsAt(dist: number, k: number): number {
  const d = Math.max(0, dist - 160 * k);
  let u = 0;
  while (u < 640 && 24 * k * portalScale(u) < d) u += 2;
  return INHALE_MS - 60 + Math.round(u * WAVE_SQUEEZE);
}

/** sizes in px for a mark `markSize` wide */
export const portalScaleK = (markSize: number) => markSize / MOCK_MARK;
// the hole is a hair smaller than the star so its edge hides under the rim
export const HOLE_RATIO = 0.99;
export const FLASH_RATIO = 4;
// mockup timings after the reveal starts (woosh at the portal opening, the rest +0.6s like before)
export const SOUND_DELAY_MS = INHALE_MS;
export const GLOW_AT_MS = INHALE_MS + 380;
export const MOTES_AT_MS = INHALE_MS + 300;
