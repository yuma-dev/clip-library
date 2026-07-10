#!/usr/bin/env node
// Assembles the distributable folder and zip from the already-built binary
// and cached ffmpeg.exe.
//
//   dist/clipdip-<version>/
//     clipdip.exe
//     ffmpeg.exe
//     ATTRIBUTION.txt
//   dist/clipdip-<version>.zip

import fs   from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Read version from package.json (single source of truth).
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const DIST_ROOT  = path.join(ROOT, 'dist');
const DIST_DIR   = path.join(DIST_ROOT, `clipdip-${version}`);
const ZIP_PATH   = path.join(DIST_ROOT, `clipdip-${version}.zip`);

const CLIP_EXE   = path.join(ROOT, 'target', 'release', 'clipdip.exe');
const FFMPEG_EXE = path.join(DIST_ROOT, 'ffmpeg-cache', 'ffmpeg.exe');
const ATTR_TXT   = path.join(DIST_ROOT, 'ATTRIBUTION.txt');

// ── Pre-flight checks ──────────────────────────────────────────────────────
for (const [label, p] of [
  ['clipdip.exe (run npm run build first)', CLIP_EXE],
  ['ffmpeg.exe  (run npm run fetch-ffmpeg first)', FFMPEG_EXE],
  ['ATTRIBUTION.txt', ATTR_TXT],
]) {
  if (!fs.existsSync(p)) throw new Error(`Missing ${label}: ${p}`);
}

// ── Assemble dist folder ───────────────────────────────────────────────────
console.log(`Assembling dist/clipdip-${version}/`);
if (fs.existsSync(DIST_DIR)) fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

fs.copyFileSync(CLIP_EXE,  path.join(DIST_DIR, 'clipdip.exe'));
fs.copyFileSync(FFMPEG_EXE, path.join(DIST_DIR, 'ffmpeg.exe'));
fs.copyFileSync(ATTR_TXT,  path.join(DIST_DIR, 'ATTRIBUTION.txt'));

for (const f of fs.readdirSync(DIST_DIR)) {
  const size = (fs.statSync(path.join(DIST_DIR, f)).size / 1e6).toFixed(1);
  console.log(`  ${f.padEnd(20)} ${size} MB`);
}

// ── Zip via Windows built-in tar ───────────────────────────────────────────
if (fs.existsSync(ZIP_PATH)) fs.rmSync(ZIP_PATH);
console.log(`Creating ${path.relative(ROOT, ZIP_PATH)}`);

// tar -a = auto format from extension (.zip → zip), -c = create, -f = file
execSync(`tar -a -c -f "${ZIP_PATH}" -C "${DIST_ROOT}" "clipdip-${version}"`, {
  stdio: 'inherit',
});

const sizeMB = (fs.statSync(ZIP_PATH).size / 1e6).toFixed(1);
console.log(`Done: dist/clipdip-${version}.zip  (${sizeMB} MB)`);
