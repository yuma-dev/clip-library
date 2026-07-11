#!/usr/bin/env node
// Extract a clip's real audio tracks into an `audioMixer` export spec (+ a
// blurred backdrop frame). Track names/order/channels come straight from the
// clip's audio streams via ffprobe, mirroring buildAudioTracksFromStreams()
// (main/ffmpeg.js): title tag -> non-generic handler_name -> "Track N". Palette
// colours are assigned by ordinal like AudioTracksManager.
//
//   node scripts/export-extract-audio-tracks.mjs "<clip filename>" [options]
//     --volumes 0.9,0.65,1.2,0.4   per-track volume (1 == 100%, >1 boosted); default all 1
//     --muted 3                    comma-separated ordinals to render soft-muted
//     --time <sec>                 backdrop frame timestamp (default duration/2 if >40s else 0)
//     --clip-location <dir>        override clip folder (default: from settings.json)
//     --user-data <dir>            override userData dir (default: %APPDATA%/clips)
//     --out <dir>                  output dir (default: export-out/<clip>/mixer)
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

// Same palette as player-legacy/audio-tracks-manager.js (COLOR_PALETTE).
const COLOR_PALETTE = ["#3b82f6", "#f43f5e", "#10b981", "#a855f7", "#f59e0b", "#06b6d4", "#ec4899", "#84cc16"];

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const clipName = args.find((a) => !a.startsWith("--")) ?? opt("clip");
if (!clipName) {
  console.error('usage: node scripts/export-extract-audio-tracks.mjs "<clip filename>" [--volumes a,b,c] [--muted i,j]');
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
const safe = clipName.replace(/\//g, "--");
const clipPath = path.join(clipLocation, clipName);
if (!fs.existsSync(clipPath)) {
  console.error("clip not found:", clipPath);
  process.exit(1);
}

// --- discover audio tracks (mirrors buildAudioTracksFromStreams) ---
const probe = JSON.parse(
  execFileSync(ffprobePath, ["-v", "error", "-show_streams", "-select_streams", "a", "-of", "json", clipPath], {
    encoding: "utf8",
  }),
);
const streams = (probe.streams || []).filter((s) => s && s.codec_type === "audio");
if (streams.length === 0) {
  console.error("clip has no audio tracks:", clipName);
  process.exit(1);
}

const volumes = (opt("volumes") ? opt("volumes").split(",").map(Number) : []).filter((n) => Number.isFinite(n));
const mutedSet = new Set((opt("muted") ? opt("muted").split(",") : []).map((s) => Number(s.trim())));

const tracks = streams.map((s, ordinal) => {
  const tags = s.tags || {};
  const rawTitle = typeof tags.title === "string" ? tags.title.trim() : "";
  const rawHandler = typeof tags.handler_name === "string" ? tags.handler_name.trim() : "";
  const handlerIsGeneric = !rawHandler || /^sound\s*handler$/i.test(rawHandler);
  const name = rawTitle || (handlerIsGeneric ? "" : rawHandler) || `Track ${ordinal + 1}`;
  return {
    ordinal,
    name,
    channels: Number.isFinite(s.channels) ? s.channels : null,
    color: COLOR_PALETTE[ordinal % COLOR_PALETTE.length],
    volume: volumes[ordinal] != null ? volumes[ordinal] : 1,
    muted: mutedSet.has(ordinal),
  };
});

// --- backdrop frame (native res; the scene blurs it) ---
const duration = parseFloat(
  execFileSync(
    ffprobePath,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", clipPath],
    { encoding: "utf8" },
  ).trim(),
);
const time = opt("time") != null ? parseFloat(opt("time")) : duration > 40 ? duration / 2 : 0;

const outDir = path.resolve(opt("out", path.join(process.cwd(), "export-out", safe, "mixer")));
fs.mkdirSync(outDir, { recursive: true });
const backdrop = path.join(outDir, "backdrop.png");
execFileSync(ffmpegPath, ["-y", "-ss", String(time), "-i", clipPath, "-frames:v", "1", "-q:v", "2", backdrop], {
  stdio: "ignore",
});

const layers = { composite: null, background: '[data-layer="background"]', panel: '[data-layer="panel"]' };
tracks.forEach((t) => (layers[`row-${t.ordinal}`] = `[data-layer="row-${t.ordinal}"]`));

const spec = {
  scene: "audioMixer",
  background: "#0f0f11",
  props: { tracks, backdrop, panelWidth: 320, pad: 44 },
  settleMs: 400,
  layers,
  fixtures: [],
};

const specPath = path.join(outDir, "spec.json");
fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
console.log("spec:    ", specPath);
console.log("backdrop:", backdrop, `(frame @ ${time.toFixed(2)}s)`);
console.log("tracks:");
tracks.forEach((t) =>
  console.log(`  #${t.ordinal} ${Math.round(t.volume * 100)}%`.padEnd(12), t.color, " ", t.name + (t.muted ? "  (muted)" : "")),
);
console.log("\nNext: npm run build:renderer && node scripts/export-capture.mjs", JSON.stringify(specPath), "--scale 3");
