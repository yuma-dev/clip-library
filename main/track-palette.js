'use strict';
/** each install's own default track colors, made once from a random start hue and kept in
 * trackPreferences.json. eight hues 45 deg apart, handed out in steps of 135 deg, so track 1 and 2
 * (game and mic, usually) are a split-complement pair and 1, 2, 3 split the wheel. oklch, with
 * lightness bent per hue the way hand-made palettes do it: yellows lifted so they don't go
 * mustard, blues lowered so they don't wash out. colors a user picked are kept per track name and
 * win over these */

const COUNT = 8;
// 3 of 8 slots per track, coprime with 8 so every slot gets used once
const STEP = 3;
const C = 0.15;
// smallest oklab distance between two colors of one palette. every start hue gives 0.099 or more
// even where gamut clipping pulls chroma in (cyan, blue), golden-angle steps went down to 0.070
const MIN_DIST = 0.095;

/** degrees between two hues, 0..180 */
const hueGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const bump = (h, at, width) => Math.exp(-((hueGap(h, at) / width) ** 2));

/** lightness for a hue: 0.72 base, up to 0.84 around yellow (95), down to 0.66 around blue (265) */
const lightness = (h) => 0.72 + 0.12 * bump(h, 95, 35) - 0.06 * bump(h, 265, 40);

function oklchToRgb(l, c, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
}

const inGamut = (rgb) => rgb.every((x) => x >= -1e-4 && x <= 1 + 1e-4);

/** the hue at its lightness, chroma pulled in until it fits srgb. returns the oklab point and hex */
function color(hDeg) {
  const l = lightness(hDeg);
  let c = C;
  let rgb = oklchToRgb(l, c, hDeg);
  while (!inGamut(rgb) && c > 0.02) {
    c -= 0.005;
    rgb = oklchToRgb(l, c, hDeg);
  }
  const h = (hDeg * Math.PI) / 180;
  const hex = `#${rgb.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('')}`;
  return { hex, lab: [l, c * Math.cos(h), c * Math.sin(h)] };
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/** eight hex colors in ordinal order; rand is 0..1, Math.random unless a test pins it */
function makePalette(rand = Math.random) {
  const start = rand() * 360;
  return Array.from({ length: COUNT }, (_, i) => color((start + ((i * STEP) % COUNT) * (360 / COUNT)) % 360).hex);
}

/** oklab distance of the closest pair, for the test that holds MIN_DIST */
function closestPair(start) {
  const cols = Array.from({ length: COUNT }, (_, i) => color((start + i * (360 / COUNT)) % 360).lab);
  let closest = Infinity;
  for (let i = 0; i < COUNT; i++) for (let j = i + 1; j < COUNT; j++) closest = Math.min(closest, dist(cols[i], cols[j]));
  return closest;
}

const isPalette = (v) => Array.isArray(v) && v.length === COUNT && v.every((x) => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x));

module.exports = { makePalette, isPalette, closestPair, MIN_DIST };
