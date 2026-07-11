#!/usr/bin/env node
// Export the ClipDip clip-saved overlay notification as a transparent frozen PNG
// and a transparent animated WebP.
//
// Renders the REAL overlay (clipdip/overlay.html) — not the design playground —
// by stubbing window.__TAURI_INTERNALS__ so the overlay runs its genuine
// saving -> saved flow (slide-in, comet border, flash, sheen sweep, sparkles)
// with zero changes to the production file. A tiny static server maps the
// overlay's `/logo250x250.png` to clipdip/assets (Vite's publicDir).
//
//   node scripts/export-overlay.mjs [options]
//     --scale <n>     deviceScaleFactor / supersample (default 3)
//     --seconds <s>   animation capture duration (default 2.8)
//     --out <dir>     output dir (default: export-out/overlay)
//     --lossy         smaller WebP (lossy q90) instead of lossless alpha
//
// Requires Playwright. See docs/component-mockups.md.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const scale = Number(opt("scale", "3")); // frozen still supersample
const animScale = Number(opt("anim-scale", "2")); // animation pass — lower = more fps (transparent screenshots are slow)
const seconds = Number(opt("seconds", "2.8"));
const lossy = args.includes("--lossy");
const outDir = path.resolve(opt("out", path.join(process.cwd(), "export-out", "overlay")));
const framesDir = path.join(outDir, "_frames");
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

const clipdipRoot = path.resolve(process.cwd(), "clipdip");
const overlayHtml = path.join(clipdipRoot, "overlay.html");
const assetsDir = path.join(clipdipRoot, "assets"); // Vite publicDir
if (!fs.existsSync(overlayHtml)) {
  console.error("overlay.html not found:", overlayHtml);
  process.exit(1);
}

// --- static server: /overlay.html -> source; everything else -> assets/ ------
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
const port = server.address().port;
const overlayUrl = `http://127.0.0.1:${port}/overlay.html`;

// --- Tauri stub: drives the overlay's real saving -> saved flow --------------
// overlay.html calls invoke("overlay_get_pending"); returning both a `saving`
// and a `saved` payload makes it show the comet, hold MIN_SAVING_MS, then run
// the full "Clip saved" payoff. auto_dismiss_secs:0 keeps it on screen.
const initScript = () => {
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      if (cmd === "overlay_get_pending") {
        return Promise.resolve({
          saving: { kind: "clip", rename_hotkey: "Ctrl+F10", corner: "bottom_right", auto_dismiss_secs: 0, sound: false },
          saved: { kind: "clip", path: "C:/Clips/clip.mp4" },
          recording: false,
        });
      }
      return Promise.resolve();
    },
    transformCallback: () => 1,
  };
  // Give the card generous margins so the glow/sparkles aren't clipped by the
  // screen corner (production sits at 2.4vh; we only move it for the capture).
  const css = ".anchor.bottom_right{right:140px!important;bottom:140px!important;}";
  const add = () => {
    const s = document.createElement("style");
    s.textContent = css;
    document.head.appendChild(s);
  };
  if (document.head) add();
  else document.addEventListener("DOMContentLoaded", add);
};

const browser = await chromium.launch({ args: ["--force-color-profile=srgb"] });
const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: scale });
await context.addInitScript(initScript);
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.warn("[overlay]", m.text());
});

// --- pass 1: reach the saved state, measure, capture the frozen still ---------
await page.goto(overlayUrl);
await page.waitForFunction(() => document.getElementById("card")?.classList.contains("saved"), null, { timeout: 15000 });
await page.waitForTimeout(360); // let flash/sheen/sparkles reach their peak

const pad = 90;
const box = await page.evaluate((p) => {
  const r = document.getElementById("card").getBoundingClientRect();
  const x = Math.max(0, Math.floor(r.left - p));
  const y = Math.max(0, Math.floor(r.top - p));
  const w = Math.min(window.innerWidth - x, Math.ceil(r.width + p * 2));
  const h = Math.min(window.innerHeight - y, Math.ceil(r.height + p * 2));
  return { x, y, width: w, height: h };
}, pad);

const frozen = path.join(outDir, "frozen.png");
await page.screenshot({ path: frozen, clip: box, omitBackground: true });
console.log("frozen:  ", path.relative(process.cwd(), frozen), `(${box.width}x${box.height} @ ${scale}x)`);

// --- pass 2: fresh context at animScale, capture slide-in -> payoff as frames -
const animCtx = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: animScale });
await animCtx.addInitScript(initScript);
const animPage = await animCtx.newPage();
await animPage.goto(overlayUrl, { waitUntil: "domcontentloaded" });
const start = Date.now();
let i = 0;
while (Date.now() - start < seconds * 1000) {
  await animPage.screenshot({ path: path.join(framesDir, `f_${String(i).padStart(4, "0")}.png`), clip: box, omitBackground: true });
  i++;
}
await browser.close();
server.close();

const frameCount = i;
const fps = Math.max(1, Math.round(frameCount / seconds));
console.log(`frames:   ${frameCount} over ${seconds}s -> ${fps}fps`);

// --- encode transparent animated WebP ----------------------------------------
const webp = path.join(outDir, "overlay.webp");
const enc = [
  "-y", "-framerate", String(fps), "-i", path.join(framesDir, "f_%04d.png"), "-loop", "0",
  "-c:v", "libwebp", ...(lossy ? ["-lossless", "0", "-q:v", "90"] : ["-lossless", "1"]),
  "-compression_level", "6", webp,
];
execFileSync(ffmpegPath, enc, { stdio: "ignore" });
fs.rmSync(framesDir, { recursive: true, force: true });

const kb = (fs.statSync(webp).size / 1024).toFixed(0);
console.log("animated:", path.relative(process.cwd(), webp), `(${kb}kb, ${lossy ? "lossy" : "lossless"} alpha)`);
console.log("\ndone ->", path.relative(process.cwd(), outDir));
