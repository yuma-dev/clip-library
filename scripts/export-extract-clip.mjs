#!/usr/bin/env node
// Extract a real clip into a disposable export spec + a HI-RES thumbnail.
//
// Reads the same on-disk files the app reads (settings.json -> clipLocation,
// .clip_metadata/*.customname|.tags|.gameinfo, icons/) and renders a
// full-resolution frame from the actual video with the bundled ffmpeg — the
// cached thumbnail is only 640x360, so we re-grab it at native size for crisp
// scaled assets. Output goes to export-out/<clip>/ (gitignored).
//
//   node scripts/export-extract-clip.mjs "<clip filename>" [options]
//     --time <sec>          frame timestamp (default: trim-less heuristic, duration/2 if >40s else 0)
//     --width <px>          card width baked into the spec (default 340)
//     --clip-location <dir> override the clip folder (default: from settings.json)
//     --user-data <dir>     override the Electron userData dir (default: %APPDATA%/clips)
//     --out <dir>           override the output dir (default: export-out/<clip>)
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
const clipName = args.find((a) => !a.startsWith("--")) ?? opt("clip");
if (!clipName) {
  console.error('usage: node scripts/export-extract-clip.mjs "<clip filename>" [--time <sec>] [--width <px>]');
  process.exit(1);
}

// --- resolve clip location (mirrors utils/settings-manager.js) ---
const userData = opt(
  "user-data",
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "clips"),
);
let clipLocation = opt("clip-location");
if (!clipLocation) {
  const settings = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
  clipLocation = settings.clipLocation;
}
if (!clipLocation) {
  console.error("could not resolve clipLocation; pass --clip-location");
  process.exit(1);
}

const metaFolder = path.join(clipLocation, ".clip_metadata");
const safe = clipName.replace(/\//g, "--"); // metadataSafeName (main/metadata.js)
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

// --- per-clip metadata (mirrors main/clips.js + main/metadata.js) ---
const customName =
  readMaybe(path.join(metaFolder, `${safe}.customname`))?.trim() ||
  path.basename(clipName, path.extname(clipName));
const tags = JSON.parse(readMaybe(path.join(metaFolder, `${safe}.tags`)) || "[]");
const stat = fs.statSync(clipPath);
const createdAt = Math.round(stat.birthtimeMs || stat.ctimeMs);

// --- game icon + Discord participants from .gameinfo (mirrors normalizeDiscordInfo) ---
let gameIcon = null;
const gi = readMaybe(path.join(metaFolder, `${safe}.gameinfo`));
if (gi) {
  const parsed = JSON.parse(gi);
  const raw = parsed.discord;
  const discord =
    raw && Array.isArray(raw.participants)
      ? {
          channel_id: typeof raw.channel_id === "string" ? raw.channel_id : null,
          channel_name: typeof raw.channel_name === "string" ? raw.channel_name : null,
          guild_id: typeof raw.guild_id === "string" ? raw.guild_id : null,
          participants: raw.participants
            .filter((p) => p && typeof p.id === "string" && p.id)
            .map((p) => ({
              id: p.id,
              username: typeof p.username === "string" ? p.username : "",
              global_name: typeof p.global_name === "string" ? p.global_name : null,
              nick: typeof p.nick === "string" ? p.nick : null,
              bot: p.bot === true,
              avatar_url: typeof p.avatar_url === "string" ? p.avatar_url : null,
            })),
        }
      : null;
  let iconAbs = null;
  if (parsed.icon_file) {
    const cand = path.join(clipLocation, "icons", parsed.icon_file);
    if (fs.existsSync(cand)) iconAbs = cand;
  }
  gameIcon = { path: iconAbs, title: parsed.window_title || null, discord: discord?.participants?.length ? discord : null };
}

// --- pick timestamp (mirrors main/thumbnails.js) ---
const ffprobeDuration = (file) =>
  parseFloat(
    execFileSync(
      ffprobePath,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file],
      { encoding: "utf8" },
    ).trim(),
  );
const duration = ffprobeDuration(clipPath);
const time = opt("time") != null ? parseFloat(opt("time")) : duration > 40 ? duration / 2 : 0;

// --- output ---
const outDir = path.resolve(opt("out", path.join(process.cwd(), "export-out", safe)));
fs.mkdirSync(outDir, { recursive: true });

// hi-res frame at native resolution (no -s downscale)
const thumbPath = path.join(outDir, "thumb.png");
execFileSync(ffmpegPath, ["-y", "-ss", String(time), "-i", clipPath, "-frames:v", "1", "-q:v", "2", thumbPath], {
  stdio: "ignore",
});

const spec = {
  scene: "clipCard",
  background: "#0f0f11",
  card: { width: opt("width") != null ? Number(opt("width")) : 340, glowOverflow: 55 },
  props: { grayscaleIcons: false, showNewIndicators: false },
  settleMs: 300,
  layers: {
    composite: null,
    background: '[data-layer="background"]',
    glow: '[data-layer="glow"]',
    card: ".clip-item",
    thumbnail: ".clip-item-media-container img",
    avatars: ".clip-participants",
    foot: ".clip-foot",
    gameicon: ".clip-game",
  },
  fixtures: [
    {
      clip: {
        originalName: clipName,
        customName,
        createdAt,
        thumbnailPath: thumbPath,
        isTrimmed: false,
        tags,
        isNewSinceLastSession: false,
      },
      gameIcon,
    },
  ],
};

const specPath = path.join(outDir, "spec.json");
fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

const people = (gameIcon?.discord?.participants || []).filter((p) => !p.bot).map((p) => p.global_name || p.username);
console.log("spec:       ", specPath);
console.log("thumbnail:  ", thumbPath, `(frame @ ${time.toFixed(2)}s of ${duration.toFixed(1)}s, native res)`);
console.log("customName: ", customName);
console.log("participants:", people.length ? people.join(", ") : "none");
console.log("\nNext: npm run build:renderer && node scripts/export-capture.mjs", JSON.stringify(specPath), "--scale 3");
