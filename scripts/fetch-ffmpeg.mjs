#!/usr/bin/env node
// Downloads the BtbN LGPL-essentials ffmpeg build and caches ffmpeg.exe at
// dist/ffmpeg-cache/ffmpeg.exe. Safe to run repeatedly — skips the download
// if the cache already exists.

import https from 'https';
import fs    from 'fs';
import path  from 'path';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { pipeline } from 'stream/promises';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT       = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR  = path.join(ROOT, 'ffmpeg-cache');
const CACHED_EXE = path.join(CACHE_DIR, 'ffmpeg.exe');
const CACHED_ZIP = path.join(CACHE_DIR, 'ffmpeg-lgpl.zip');

// BtbN LGPL-essentials build — no GPL libs, smallest redistributable set.
// Update the tag when a newer release is available.
// GitHub Releases API endpoint — finds the right asset name automatically.
const RELEASES_API =
  'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest';

function copyToDist() {
  const distCacheDir = path.join(ROOT, 'dist', 'ffmpeg-cache');
  fs.mkdirSync(distCacheDir, { recursive: true });
  fs.copyFileSync(CACHED_EXE, path.join(distCacheDir, 'ffmpeg.exe'));
  console.log('Copied ffmpeg.exe to dist/ffmpeg-cache/');

  const rootAttr = path.join(ROOT, 'ATTRIBUTION.txt');
  const distAttr = path.join(ROOT, 'dist', 'ATTRIBUTION.txt');
  if (fs.existsSync(rootAttr)) {
    fs.mkdirSync(path.dirname(distAttr), { recursive: true });
    fs.copyFileSync(rootAttr, distAttr);
    console.log('Copied ATTRIBUTION.txt to dist/');
  }
}

if (existsSync(CACHED_EXE)) {
  console.log(`ffmpeg already cached: ${CACHED_EXE}`);
  copyToDist();
  process.exit(0);
}

mkdirSync(CACHE_DIR, { recursive: true });

// Fetch JSON from a URL, following redirects.
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'clipdip-build', 'Accept': 'application/vnd.github+json' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Follow redirects (GitHub releases → CDN) and stream to disk.
function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'clipdip-build' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      res.on('data', chunk => {
        received += chunk.length;
        if (total) {
          const pct = Math.round((received / total) * 100);
          process.stdout.write(`\r  ${pct}% (${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)`);
        }
      });
      const out = createWriteStream(dest);
      pipeline(res, out).then(() => { process.stdout.write('\n'); resolve(); }, reject);
    }).on('error', reject);
  });
}

// Resolve the download URL via the GitHub Releases API.
console.log('Resolving latest LGPL ffmpeg release from BtbN...');
const releaseJson = await fetchJson(RELEASES_API);
// Pick win64 LGPL (no shared libs — self-contained ffmpeg.exe).
// Prefer stable tags (n8.x > n7.x > master) over the nightly master build.
const candidates = (releaseJson.assets ?? []).filter(a =>
  a.name.includes('win64') &&
  a.name.includes('lgpl')  &&
  !a.name.includes('shared') &&
  a.name.endsWith('.zip')
);
if (!candidates.length) {
  console.error('Available assets:', releaseJson.assets?.map(a => a.name));
  throw new Error('Could not find a win64-lgpl zip in the latest BtbN release.');
}
// Sort: versioned stable releases (n8.1, n7.1, …) before master.
candidates.sort((a, b) => {
  const stableA = /n\d+\.\d+/.test(a.name);
  const stableB = /n\d+\.\d+/.test(b.name);
  if (stableA !== stableB) return stableA ? -1 : 1;
  return b.name.localeCompare(a.name); // higher version string wins
});
const asset = candidates[0];
const FFMPEG_URL = asset.browser_download_url;
console.log(`Downloading: ${asset.name}`);
console.log(`  ${FFMPEG_URL}`);
await download(FFMPEG_URL, CACHED_ZIP);

// Extract ffmpeg.exe from the zip using Windows built-in tar (Win 10+).
console.log('Extracting ffmpeg.exe...');
const extractDir = path.join(CACHE_DIR, 'extract');
fs.mkdirSync(extractDir, { recursive: true });
execSync(`tar -xf "${CACHED_ZIP}" --strip-components=2 -C "${extractDir}" --include="*/bin/ffmpeg.exe"`, {
  stdio: 'inherit',
});

// tar --include isn't universally supported on Windows tar; fall back to
// extracting everything and finding the exe.
const found = findFile(extractDir, 'ffmpeg.exe');
if (!found) {
  // Retry: extract all, search.
  execSync(`tar -xf "${CACHED_ZIP}" -C "${extractDir}"`, { stdio: 'inherit' });
  const retry = findFile(extractDir, 'ffmpeg.exe');
  if (!retry) throw new Error('ffmpeg.exe not found in downloaded zip.');
  fs.copyFileSync(retry, CACHED_EXE);
} else {
  fs.copyFileSync(found, CACHED_EXE);
}

fs.rmSync(extractDir, { recursive: true, force: true });

const sizeMB = (fs.statSync(CACHED_EXE).size / 1e6).toFixed(1);
console.log(`Cached: ${CACHED_EXE}  (${sizeMB} MB)`);

copyToDist();

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}
