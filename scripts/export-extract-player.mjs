#!/usr/bin/env node
// Extract a clip into a `videoPlayer` export spec: a hi-res middle-frame
// thumbnail (stands in for the <video>) + the clip's real title and duration,
// with the playhead at the middle and no trim. Reads the same on-disk files the
// app reads (settings.json -> clipLocation, .clip_metadata/<clip>.customname)
// and grabs a full-resolution frame with the bundled ffmpeg.
//
//   node scripts/export-extract-player.mjs "<clip filename>" [options]
//     --time <sec>          playhead/frame timestamp (default: middle, duration/2)
//     --width <px>          player card width (default 960)
//     --no-share            hide the publish/share button
//     --clip-location <dir> / --user-data <dir> / --out <dir>
//
// See docs/component-mockups.md.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("@ffprobe-installer/ffprobe").path;

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);
const clipName = args.find((a) => !a.startsWith("--")) ?? opt("clip");
if (!clipName) {
  console.error('usage: node scripts/export-extract-player.mjs "<clip filename>" [--time <sec>] [--width <px>] [--no-share]');
  process.exit(1);
}

const userData = opt(
  "user-data",
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "clips"),
);
let clipLocation = opt("clip-location");
if (!clipLocation) {
  clipLocation = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")).clipLocation;
}
const metaFolder = path.join(clipLocation, ".clip_metadata");
const safe = clipName.replace(/\//g, "--");
const clipPath = path.join(clipLocation, clipName);
if (!fs.existsSync(clipPath)) {
  console.error("clip not found:", clipPath);
  process.exit(1);
}

const readMaybe = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const title =
  readMaybe(path.join(metaFolder, `${safe}.customname`))?.trim() || path.basename(clipName, path.extname(clipName));

const duration = parseFloat(
  execFileSync(
    ffprobePath,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", clipPath],
    { encoding: "utf8" },
  ).trim(),
);
const time = opt("time") != null ? parseFloat(opt("time")) : duration / 2; // middle, no trim

const outDir = path.resolve(opt("out", path.join(process.cwd(), "export-out", safe, "player")));
fs.mkdirSync(outDir, { recursive: true });
const thumb = path.join(outDir, "frame.png");
execFileSync(ffmpegPath, ["-y", "-ss", String(time), "-i", clipPath, "-frames:v", "1", "-q:v", "2", thumb], {
  stdio: "ignore",
});

const spec = {
  scene: "videoPlayer",
  background: "#0b0b0d",
  props: {
    thumbnail: thumb,
    title,
    currentSeconds: time,
    durationSeconds: duration,
    width: opt("width") != null ? Number(opt("width")) : 960,
    pad: 48,
    showShare: !has("no-share"),
  },
  settleMs: 300,
  layers: {
    composite: null,
    background: '[data-layer="background"]',
    card: '[data-layer="card"]',
    thumbnail: '[data-layer="thumbnail"]',
    controls: '[data-layer="controls"]',
    title: '[data-layer="title"]',
    actions: '[data-layer="actions"]',
    progress: '[data-layer="progress"]',
    times: '[data-layer="times"]',
  },
  fixtures: [],
};

const specPath = path.join(outDir, "spec.json");
fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
console.log("spec:    ", specPath);
console.log("frame:   ", thumb, `(middle @ ${time.toFixed(2)}s of ${duration.toFixed(1)}s)`);
console.log("title:   ", title);
console.log("\nNext: npm run build:renderer && node scripts/export-capture.mjs", JSON.stringify(specPath), "--scale 2");
