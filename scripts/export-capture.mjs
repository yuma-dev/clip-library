#!/usr/bin/env node
// Capture a component-mockup spec into layered, high-res PNGs.
//
// Loads the built exporter (renderer-dist/export.html) over a file:// origin in
// headless Chromium — file:// so ClipCard's `file://<abs path>` <img> sources
// (hi-res thumbnail, game icon) resolve — injects the spec, waits for the frame
// to signal ready, then screenshots #export-root once per layer. Non-composite
// layers hide every sibling (visibility, so layout/registration is preserved),
// giving perfectly aligned transparent layers that stack in any editor.
//
//   node scripts/export-capture.mjs <spec.json> [options]
//     --scale <n>            deviceScaleFactor / supersample (default 3)
//     --out <dir>           output dir (default: <spec dir>/png@<scale>x)
//     --only <a,b,c>        capture only these layers (default: all in spec.layers)
//
// Requires `npm run build:renderer` first. See docs/component-mockups.md.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const specPath = args.find((a) => !a.startsWith("--")) ?? opt("spec");
if (!specPath) {
  console.error("usage: node scripts/export-capture.mjs <spec.json> [--scale <n>] [--out <dir>] [--only <a,b>]");
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const scale = Number(opt("scale", "3"));
const outDir = path.resolve(opt("out", path.join(path.dirname(specPath), `png@${scale}x`)));
fs.mkdirSync(outDir, { recursive: true });

const exportHtml = path.resolve(process.cwd(), "renderer-dist", "export.html");
if (!fs.existsSync(exportHtml)) {
  console.error("built exporter missing:", exportHtml, "\nRun: npm run build:renderer");
  process.exit(1);
}

const layers = spec.layers ?? { composite: null };
const only = opt("only");
const wanted = only ? only.split(",") : Object.keys(layers);

const browser = await chromium.launch({
  args: ["--allow-file-access-from-files", "--force-color-profile=srgb"],
});
const context = await browser.newContext({ deviceScaleFactor: scale });
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.warn("[page error]", m.text());
});

await page.addInitScript((s) => {
  window.__EXPORT_SPEC__ = s;
}, spec);
await page.goto(pathToFileURL(exportHtml).href);
await page.waitForFunction(() => document.documentElement.getAttribute("data-export-ready") === "1", null, {
  timeout: 30000,
});

// Show only the target subtree; keep #export-root itself visible (so Playwright
// still considers it screenshottable) and preserve every element's box so all
// layers share one coordinate frame.
async function isolate(selector) {
  await page.evaluate((sel) => {
    const root = document.getElementById("export-root");
    if (!root) return;
    const all = root.querySelectorAll("*");
    all.forEach((el) => (el.style.visibility = "")); // reset
    if (sel == null) return; // composite: everything visible
    all.forEach((el) => (el.style.visibility = "hidden"));
    document.querySelectorAll(sel).forEach((t) => {
      t.style.visibility = "visible";
      t.querySelectorAll("*").forEach((c) => (c.style.visibility = "visible"));
    });
  }, selector);
}

const rootLoc = page.locator("#export-root");
for (const name of wanted) {
  if (!(name in layers)) {
    console.warn("skip unknown layer:", name);
    continue;
  }
  await isolate(layers[name]);
  const file = path.join(outDir, `${name}.png`);
  await rootLoc.screenshot({ path: file, omitBackground: true });
  console.log("wrote", path.relative(process.cwd(), file));
}

await browser.close();
console.log(`\ndone -> ${path.relative(process.cwd(), outDir)} (${scale}x)`);
