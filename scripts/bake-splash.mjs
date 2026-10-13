// Bakes the launcher splash from the setsu web component (assets/setsu). Headless chromium seeks
// every css animation to each frame, so the splash is the real brand animation, not a redraw.
// Writes clipdip/crates/launcher/splash.bin (frames for a few dpi scales, read by the launcher)
// and the stills the app takes over in place on reveal, one per moving part: assets/setsu/hero-glow.png
// and hero-corners.png, the size of the mark. the star itself is star.svg.
// Run after editing anything in assets/setsu: `npm run bake:splash`.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'assets', 'setsu');
const OUT_BIN = path.join(root, 'clipdip', 'crates', 'launcher', 'splash.bin');
// stacked (glow, corners, star.svg) they are exactly the launcher's last frame
const OUT_HEROES = ['hero-glow.png', 'hero-corners.png'].map((f) => path.join(SRC, f));

// logical px, the launcher window is this size at 100% dpi. the mark only, no name; the window
// has room for the cursor coming in from the lower right and the shadow at 1.6x
const WIN_W = 360;
const WIN_H = 360;
// the size the pre-Setsu splash logo had
const MARK = 140;
const FPS = 60;
// T.revealEnd in setsu-logo.js: the reveal is the splash's only minimum, the app may take over
// from here once the star is at rest
const HOLD_MS = 3050;
// L7 blinkturn period, starting at revealEnd like the design
const LOOP_MS = 2600;
// blinkturn is at rest outside 30%..78% of its period (rotate(90deg) on a 4-fold star looks like none)
const BLINK_FROM = 0.3;
const BLINK_TO = 0.78;
// the launcher takes the largest set not above the system scale and reports the rect it actually
// drew. every set adds a few MB to the launcher exe, so 1.75/2.5/3 get the next one down
const SCALES = process.env.SPLASH_SCALES ? process.env.SPLASH_SCALES.split(',').map(Number) : [1, 1.25, 1.5, 2];
const HERO_SCALE = 4;

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${pathToFileURL(path.join(SRC, 'setsu-logo.css'))}">
<style>html,body{margin:0;background:transparent;width:100%;height:100%;overflow:hidden}
body{display:grid;place-items:center}</style></head>
<body><div id="logo"></div><script src="${pathToFileURL(path.join(SRC, 'setsu-logo.js'))}"></script></body></html>`;

// playwright screenshots are 8-bit rgba, non-interlaced
function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('expected 8-bit rgba png');
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[o + x - 4] : 0;
      const b = y > 0 ? out[o - stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[o - stride + x - 4] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[o + x] = v & 255;
    }
  }
  return { width, height, pixels: out };
}

// straight rgba -> premultiplied bgra, what UpdateLayeredWindow takes
function premultiply({ width, height, pixels }) {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const al = pixels[i + 3];
    out[i] = Math.round((pixels[i + 2] * al) / 255);
    out[i + 1] = Math.round((pixels[i + 1] * al) / 255);
    out[i + 2] = Math.round((pixels[i] * al) / 255);
    out[i + 3] = al;
  }
  return out;
}

// only the box that changed since the previous frame, as a bytewise delta against it: the
// launcher keeps the last frame and adds this on top. static parts (the name, the corners
// during the loop) cost nothing
function packFrame(cur, prev, width, height) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (cur.readUInt32LE(i) === prev.readUInt32LE(i)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: 0, h: 0, data: Buffer.alloc(0) };
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const i = ((y0 + y) * width + x0) * 4;
    for (let k = 0; k < w * 4; k++) out[y * w * 4 + k] = (cur[i + k] - prev[i + k]) & 255;
  }
  return { x: x0, y: y0, w, h, data: zlib.deflateSync(out, { level: 9 }) };
}

async function openPage(browser, scale) {
  const page = await browser.newPage({ viewport: { width: WIN_W, height: WIN_H }, deviceScaleFactor: scale });
  // about:blank can't load file:// urls, a file page can
  const file = path.join(os.tmpdir(), 'setsu-splash-bake.html');
  fs.writeFileSync(file, html);
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await page.evaluate(async ({ mark, hold }) => {
    const logo = new window.SetsuLogo(document.getElementById('logo'), { size: mark });
    await logo.ready;
    const starts = { blinkturn: hold };
    let saved = [];
    // every phase at once, each animation seeked relative to when its class would have landed.
    // then the values go inline and the animations are cancelled: chromium keeps the raster
    // scale of a layer with a transform animation, so the star came out soft after a blink
    // and frames depended on what was seeked before
    window.__seek = (t) => {
      for (const [el, style] of saved) {
        if (style === null) el.removeAttribute('style');
        else el.setAttribute('style', style);
      }
      logo.set('icon', 'reveal', 'loop');
      getComputedStyle(logo.el).opacity;
      const anims = document.getAnimations();
      saved = [...new Set(anims.map((a) => a.effect.target))].map((el) => [el, el.getAttribute('style')]);
      for (const a of anims) {
        a.pause();
        a.currentTime = t - (starts[a.animationName] ?? 0);
      }
      // composite order, so the top one wins; one not in effect would commit the base value
      for (const a of anims) if (a.effect.getComputedTiming().progress !== null) a.commitStyles();
      for (const a of anims) a.cancel();
    };
    logo.set('icon', 'reveal', 'loop');
    // measure() counted a gap for the hidden name, the lone mark needs no shift
    logo.el.style.setProperty('--shift', '0px');
    logo.snap();
  }, { mark: MARK, hold: HOLD_MS });
  // the first paint draws images at low quality, the star came out soft; throw one away
  await page.evaluate((ms) => window.__seek(ms), HOLD_MS);
  await page.screenshot({ omitBackground: true });
  return page;
}

async function seek(page, t) {
  await page.evaluate((ms) => window.__seek(ms), t);
}

// mark box at rest, logical px relative to the window
async function markRect(page) {
  await seek(page, HOLD_MS);
  return page.evaluate(() => {
    const r = document.querySelector('.setsu .mark').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
}

// a few minutes of chromium, so only when something it reads changed (--force to redo)
const inputs = [fileURLToPath(import.meta.url), ...fs.readdirSync(SRC).filter((f) => !f.startsWith('hero')).map((f) => path.join(SRC, f))];
const outAge = (f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0);
// a SPLASH_SCALES test bake is newer than the inputs too, so the scales in the file count
const bakedScales = () => {
  if (!fs.existsSync(OUT_BIN)) return '';
  const b = fs.readFileSync(OUT_BIN);
  return Array.from({ length: b.readUInt16LE(28) }, (_, k) => b.readUInt16LE(32 + k * 8) / 100).join();
};
const fresh = Math.min(outAge(OUT_BIN), ...OUT_HEROES.map(outAge)) > Math.max(...inputs.map(outAge)) && bakedScales() === SCALES.join();
if (!process.argv.includes('--force') && !process.env.SPLASH_SCALES && fresh) {
  console.log('splash is up to date');
  process.exit(0);
}

const browser = await chromium.launch();
try {
  const frameCount = Math.round(((HOLD_MS + LOOP_MS) * FPS) / 1000);
  const sets = [];
  let rect = null;
  for (const scale of SCALES) {
    const page = await openPage(browser, scale);
    rect = rect ?? (await markRect(page));
    const frames = [];
    const w = Math.round(WIN_W * scale);
    const h = Math.round(WIN_H * scale);
    let prev = Buffer.alloc(w * h * 4);
    // one past the end is frame HOLD again, so the loop wraps with deltas only. seeked to HOLD
    // itself, not one period on: the star at 90deg rasterizes a few px off and that would pile
    // up every lap
    for (let i = 0; i <= frameCount; i++) {
      await seek(page, i === frameCount ? HOLD_MS : (i * 1000) / FPS);
      const shot = await page.screenshot({ omitBackground: true });
      if (process.env.SPLASH_DUMP && i % 15 === 0) fs.writeFileSync(path.join(process.env.SPLASH_DUMP, `${scale}-${String(i).padStart(3, '0')}.png`), shot);
      const png = decodePng(shot);
      if (png.width !== w || png.height !== h) throw new Error(`frame is ${png.width}x${png.height}, expected ${w}x${h}`);
      const cur = premultiply(png);
      frames.push(packFrame(cur, prev, w, h));
      prev = cur;
    }
    const bytes = frames.reduce((n, f) => n + f.data.length, 0);
    console.log(`scale ${scale}: ${frames.length} frames, ${(bytes / 1048576).toFixed(2)} MB`);
    sets.push({ scale, frames });
    await page.close();
  }

  // little endian. header 32 bytes: 'STSU', version, window w/h (logical), mark x/y/size
  // (logical x100), fps, frames per set, hold ms, loop ms, blink from/to (permille), set count.
  // then per set 8 bytes: scale x100, pad, absolute offset (so the launcher only touches
  // its own set). per frame: x, y, w, h (u16), zlib length (u32), zlib delta
  const head = Buffer.alloc(32 + sets.length * 8);
  head.write('STSU', 0, 'ascii');
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(WIN_W, 6);
  head.writeUInt16LE(WIN_H, 8);
  head.writeUInt16LE(Math.round(rect.x * 100), 10);
  head.writeUInt16LE(Math.round(rect.y * 100), 12);
  head.writeUInt16LE(Math.round(rect.w * 100), 14);
  head.writeUInt16LE(FPS, 16);
  head.writeUInt16LE(frameCount + 1, 18);
  head.writeUInt16LE(HOLD_MS, 20);
  head.writeUInt16LE(LOOP_MS, 22);
  head.writeUInt16LE(Math.round(BLINK_FROM * 1000), 24);
  head.writeUInt16LE(Math.round(BLINK_TO * 1000), 26);
  head.writeUInt16LE(sets.length, 28);
  const parts = [head];
  let offset = head.length;
  sets.forEach(({ scale, frames }, k) => {
    head.writeUInt16LE(Math.round(scale * 100), 32 + k * 8);
    head.writeUInt32LE(offset, 32 + k * 8 + 4);
    for (const f of frames) {
      const fh = Buffer.alloc(12);
      fh.writeUInt16LE(f.x, 0);
      fh.writeUInt16LE(f.y, 2);
      fh.writeUInt16LE(f.w, 4);
      fh.writeUInt16LE(f.h, 6);
      fh.writeUInt32LE(f.data.length, 8);
      parts.push(fh, f.data);
      offset += 12 + f.data.length;
    }
  });
  fs.writeFileSync(OUT_BIN, Buffer.concat(parts));
  console.log(`wrote ${path.relative(root, OUT_BIN)} (${(fs.statSync(OUT_BIN).size / 1048576).toFixed(2)} MB)`);

  // the stills the app puts where the launcher drew the mark (the --splash-logo rect) and around it
  const page = await openPage(browser, HERO_SCALE);
  await seek(page, HOLD_MS);
  // everything in the logo hidden but the part being shot
  const only = async (show, file) => {
    const tag = await page.addStyleTag({ content: `.setsu .lockup *{visibility:hidden}${show}{visibility:visible}` });
    fs.writeFileSync(file, await page.screenshot({ omitBackground: true, clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h } }));
    await tag.evaluate((el) => el.remove());
  };
  await only('.setsu .pt.glow,.setsu .pt.glow *', OUT_HEROES[0]);
  await only('.setsu .pt.c,.setsu .pt.c *', OUT_HEROES[1]);
  console.log(`wrote hero stills, mark ${JSON.stringify(rect)}`);
  await page.close();
} finally {
  await browser.close();
}
