#!/usr/bin/env node
// One ffmpeg for the library and clipdip: BtbN's win64 GPL build, pinned to a dated
// autobuild so every release encodes the same way. GPL because the export path needs
// libx264 and libmp3lame; BtbN over gyan's essentials because only it carries libdav1d,
// and libaom refuses NVENC AV1 bitstreams, which killed thumbnails on the gyan build.
// Cached at vendor/ffmpeg/, skipped when both exes exist. Resume + retry for flaky links.
import https from 'https';
import fs, { createWriteStream, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

export const FFMPEG_VERSION = '8.1.2';
const BUILD = 'n8.1.2-267-gb2f422d306';
export const DEFAULT_URL =
  `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-20-13-11/ffmpeg-${BUILD}-win64-gpl-8.1.zip`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'vendor', 'ffmpeg');
const CACHED_ZIP = path.join(CACHE_DIR, `ffmpeg-${BUILD}-win64-gpl.zip`);
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const BINARIES = ['ffmpeg.exe', 'ffprobe.exe'];
const ATTRIBUTION = `ClipLib and Clipdip FFmpeg Attribution

The bundled ffmpeg.exe and ffprobe.exe are FFmpeg ${FFMPEG_VERSION} (build ${BUILD}) from
https://github.com/BtbN/FFmpeg-Builds, licensed under the GNU General Public
License (GPL) version 2 or later. ClipLib and Clipdip run them as separate processes.

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.
FFmpeg project and source code: https://ffmpeg.org
Build scripts and library sources: https://github.com/BtbN/FFmpeg-Builds
License: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html

FFmpeg is free software; you may redistribute it and/or modify it under the
terms of the GNU GPL as published by the Free Software Foundation, either
version 2 of the License, or (at your option) any later version.
It is distributed WITHOUT ANY WARRANTY, including the implied warranties of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GPL for details.
You may replace these executables with compatible versions of your choice.
`;

// resumes from the bytes already on disk; github's cdn honours Range
function downloadOnce(url, dest) {
  return new Promise((resolve, reject) => {
    const have = existsSync(dest) ? fs.statSync(dest).size : 0;
    const headers = { 'User-Agent': 'cliplib-build' };
    if (have > 0) headers.Range = `bytes=${have}-`;
    https.get(url, { headers }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        return downloadOnce(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode === 416) {
        res.resume();
        return resolve(); // already complete
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const resumed = res.statusCode === 206;
      const total = (resumed ? have : 0) + parseInt(res.headers['content-length'] || '0', 10);
      let received = resumed ? have : 0;
      let previousPct = -1;
      res.on('data', chunk => {
        received += chunk.length;
        if (!total) return;
        const pct = Math.round((received / total) * 100);
        if (pct === previousPct) return;
        previousPct = pct;
        process.stdout.write(`\r  ${pct}% (${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)`);
      });
      const out = createWriteStream(dest, { flags: resumed ? 'a' : 'w' });
      pipeline(res, out).then(() => { process.stdout.write('\n'); resolve(); }, reject);
    }).on('error', reject);
  });
}

async function download(url, dest, attempts = 8) {
  for (let i = 1; ; i++) {
    try {
      await downloadOnce(url, dest);
      return;
    } catch (e) {
      if (i >= attempts) throw e;
      console.log(`\n  ${e.message}, retrying (${i}/${attempts})`);
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}

export async function fetchFfmpeg() {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (BINARIES.every(name => existsSync(path.join(CACHE_DIR, name)))) {
    console.log(`ffmpeg and ffprobe already cached: ${CACHE_DIR}`);
  } else {
    const url = process.env.CLIPLIB_FFMPEG_URL || DEFAULT_URL;
    console.log(`Downloading: ${url}`);
    await download(url, CACHED_ZIP);

    // list first: windows tar has no --include, and a zip from an override url may nest differently
    const entries = execFileSync(TAR, ['-tf', CACHED_ZIP], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/);
    const selected = BINARIES.map(name => {
      const entry = entries.find(value => value.endsWith(`/bin/${name}`) || value === name);
      if (!entry || entry.startsWith('/') || entry.split('/').includes('..')) {
        throw new Error(`${name} not found in the downloaded zip.`);
      }
      return entry;
    });
    const extractDir = fs.mkdtempSync(path.join(CACHE_DIR, 'extract-'));
    try {
      execFileSync(TAR, ['-xf', CACHED_ZIP, '-C', extractDir, ...selected], { stdio: 'inherit', windowsHide: true });
      for (const [index, name] of BINARIES.entries()) {
        fs.copyFileSync(path.join(extractDir, selected[index]), path.join(CACHE_DIR, name));
      }
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }

  fs.writeFileSync(path.join(CACHE_DIR, 'ATTRIBUTION.txt'), ATTRIBUTION);
  const version = execFileSync(path.join(CACHE_DIR, 'ffmpeg.exe'), ['-version'], {
    encoding: 'utf8', windowsHide: true
  }).split(/\r?\n/)[0];
  console.log(version);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fetchFfmpeg();
}
