#!/usr/bin/env node
// Export the ClipDip clip-saved overlay notification as a transparent frozen PNG
// and a transparent animated WebP.
//
// Renders the REAL overlay (clipdip/overlay.html) — not the design playground —
// by stubbing window.__TAURI_INTERNALS__ so the overlay runs its genuine
// saving -> saved flow (slide-in, comet border, flash, sheen, sparkles) with
// zero changes to the production file. A tiny static server maps the overlay's
// `/logo250x250.png` to clipdip/assets (Vite's publicDir).
//
// Two tricks make the animated WebP correct and smooth:
//   * node-webpmux muxes each frame with blend:false + dispose:true, so every
//     transparent frame fully REPLACES the previous one (ffmpeg's WebP encoder
//     composites them, which leaves ghost trails).
//   * The in-page animations are slowed (playbackRate) so real-time transparent
//     screenshots sample the motion densely; the WebP is then timed to play back
//     at true speed — high effective fps without a fast screenshotter.
//
//   node scripts/export-overlay.mjs [options]
//     --scale <n>     frozen still supersample (default 3)
//     --anim-scale <n>  animation pass scale (default 2)
//     --saving <s>    logical "Saving clip…" duration before the payoff (default 1.6)
//     --slow <f>      capture slow-mo factor, lower = more fps/bigger (default 0.4)
//     --lossy         smaller WebP (lossy per-frame) instead of lossless alpha
//     --out <dir>     output dir (default: export-out/overlay)
//
// Requires Playwright + node-webpmux. See docs/component-mockups.md.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import WebP from "node-webpmux";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const scale = Number(opt("scale", "3"));
const animScale = Number(opt("anim-scale", "2"));
const savingSeconds = Number(opt("saving", "1.6"));
const slow = Number(opt("slow", "0.4"));
const lossy = args.includes("--lossy");
const outDir = path.resolve(opt("out", path.join(process.cwd(), "export-out", "overlay")));
const framesDir = path.join(outDir, "_frames");
const webpDir = path.join(outDir, "_webp");
for (const d of [framesDir, webpDir]) {
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
}

const clipdipRoot = path.resolve(process.cwd(), "clipdip");
const overlayHtml = path.join(clipdipRoot, "overlay.html");
const assetsDir = path.join(clipdipRoot, "assets");
if (!fs.existsSync(overlayHtml)) {
  console.error("overlay.html not found:", overlayHtml);
  process.exit(1);
}

// --- static server: /overlay.html -> source; else -> assets/ -----------------
const mime = { ".html": "text/html", ".png": "image/png", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = url === "/" || url === "/overlay.html" ? overlayHtml : path.join(assetsDir, url);
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const overlayUrl = `http://127.0.0.1:${server.address().port}/overlay.html`;

// --- init script: Tauri stub + slow-mo + auto-fire of clip-saved -------------
// `overlay_get_pending` returns a `saving` payload only; a MutationObserver
// schedules the `clip-saved` event `savingSeconds` (logical) after the card
// enters, so the saving phase lasts exactly as long as we want. A 25ms timer
// pins every running animation to `slow` so screenshots sample motion densely.
const initScript = ({ slow, savingMs }) => {
  const listeners = {};
  const handlers = {};
  let nextId = 1;
  const fire = (event, payload) => {
    const id = listeners[event];
    if (id != null && handlers[id]) handlers[id]({ event, id, payload });
  };
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, a) => {
      if (cmd === "overlay_get_pending") {
        return Promise.resolve({
          saving: { kind: "clip", rename_hotkey: "Ctrl+F10", corner: "bottom_right", auto_dismiss_secs: 0, sound: false },
          recording: false,
        });
      }
      if (cmd === "plugin:event|listen") {
        listeners[a.event] = a.handler;
        return Promise.resolve(1);
      }
      return Promise.resolve();
    },
    transformCallback: (cb) => {
      const id = nextId++;
      handlers[id] = cb;
      return id;
    },
  };

  const boot = () => {
    // Margins so the glow/sparkles aren't clipped by the screen corner.
    const s = document.createElement("style");
    s.textContent = ".anchor.bottom_right{right:140px!important;bottom:140px!important;}";
    document.head.appendChild(s);

    if (slow < 1) {
      setInterval(() => {
        for (const a of document.getAnimations()) {
          try {
            if (a.playbackRate !== slow) a.playbackRate = slow;
          } catch (_) {
            /* ignore */
          }
        }
      }, 25);
    }

    // Fire the payoff `savingMs` (logical) after the card enters. Real delay is
    // scaled by 1/slow because the animations (and our perception of time) run
    // slow during capture.
    const card = document.getElementById("card");
    let fired = false;
    const obs = new MutationObserver(() => {
      if (fired || !card.classList.contains("entered")) return;
      fired = true;
      obs.disconnect();
      setTimeout(() => fire("clip-saved", { kind: "clip", path: "C:/Clips/clip.mp4" }), (savingMs / slow) || savingMs);
    });
    obs.observe(card, { attributes: true, attributeFilter: ["class"] });
  };
  if (document.getElementById("card")) boot();
  else document.addEventListener("DOMContentLoaded", boot);
};

const browser = await chromium.launch({ args: ["--force-color-profile=srgb"] });

// --- pass 1: frozen still (full speed, short saving) --------------------------
const ctx1 = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: scale });
await ctx1.addInitScript(initScript, { slow: 1, savingMs: 900 });
const page = await ctx1.newPage();
await page.goto(overlayUrl);
await page.waitForFunction(() => document.getElementById("card")?.classList.contains("saved"), null, { timeout: 15000 });
await page.waitForTimeout(380); // peak of flash/sheen/sparkles

const pad = 90;
const box = await page.evaluate((p) => {
  const r = document.getElementById("card").getBoundingClientRect();
  const x = Math.max(0, Math.floor(r.left - p));
  const y = Math.max(0, Math.floor(r.top - p));
  return { x, y, width: Math.min(window.innerWidth - x, Math.ceil(r.width + p * 2)), height: Math.min(window.innerHeight - y, Math.ceil(r.height + p * 2)) };
}, pad);

const frozen = path.join(outDir, "frozen.png");
await page.screenshot({ path: frozen, clip: box, omitBackground: true });
await ctx1.close();
console.log("frozen:  ", path.relative(process.cwd(), frozen), `(${box.width}x${box.height} @ ${scale}x)`);

// --- pass 2: slow-mo capture of slide-in -> saving -> payoff ------------------
const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: animScale });
await ctx2.addInitScript(initScript, { slow, savingMs: savingSeconds * 1000 });
const page2 = await ctx2.newPage();
await page2.goto(overlayUrl);
await page2.waitForFunction(() => document.getElementById("card")?.classList.contains("entered"), null, { timeout: 15000 });

// Logical seconds to record after entry: rest of slide-in + saving + payoff + tail.
const logicalSeconds = 0.5 + savingSeconds + 1.6 + 0.4;
const realMs = (logicalSeconds / slow) * 1000;
const start = Date.now();
let i = 0;
while (Date.now() - start < realMs) {
  await page2.screenshot({ path: path.join(framesDir, `f_${String(i).padStart(4, "0")}.png`), clip: box, omitBackground: true });
  i++;
}
const realElapsed = (Date.now() - start) / 1000;
await browser.close();
server.close();

const frameCount = i;
const fps = Math.max(1, Math.round(frameCount / (realElapsed * slow))); // logical fps
console.log(`frames:   ${frameCount} over ${realElapsed.toFixed(1)}s real -> ${fps}fps effective`);

// --- per-frame PNG -> WebP (ffmpeg), then mux with node-webpmux --------------
// blend:false makes each frame OVERWRITE the canvas (alpha included), so
// transparent regions clear the previous frame instead of trailing.
execFileSync(
  ffmpegPath,
  ["-y", "-i", path.join(framesDir, "f_%04d.png"), "-c:v", "libwebp", ...(lossy ? ["-q:v", "90"] : ["-lossless", "1"]), path.join(webpDir, "wf_%04d.webp")],
  { stdio: "ignore" },
);

const webpFiles = fs.readdirSync(webpDir).filter((f) => f.endsWith(".webp")).sort();
const delay = Math.round(1000 / fps);
const frames = [];
for (const f of webpFiles) {
  frames.push(await WebP.Image.generateFrame({ buffer: fs.readFileSync(path.join(webpDir, f)), delay, blend: false, dispose: true }));
}
const anim = await WebP.Image.getEmptyImage();
anim.convertToAnim();
const webp = path.join(outDir, "overlay.webp");
await anim.save(webp, { width: box.width * animScale, height: box.height * animScale, bgColor: [0, 0, 0, 0], loops: 0, frames });

fs.rmSync(framesDir, { recursive: true, force: true });
fs.rmSync(webpDir, { recursive: true, force: true });

const kb = (fs.statSync(webp).size / 1024).toFixed(0);
console.log("animated:", path.relative(process.cwd(), webp), `(${kb}kb, ${frameCount} frames @ ${fps}fps, ${lossy ? "lossy" : "lossless"} alpha)`);
console.log("\ndone ->", path.relative(process.cwd(), outDir));
