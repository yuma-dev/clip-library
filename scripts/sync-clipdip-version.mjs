// Locks clipdip's version to ClipLib's. Clipdip ships inside ClipLib and is
// updated in lockstep (its self-updater is disabled), so an independent
// clipdip version number is worse than useless: telemetry reported 1.0.2
// forever, which killed per-version health comparisons and the server's
// regression tracking (issues reopen only when a fingerprint arrives from a
// NEWER app_version).
//
// Writes the root package.json version into clipdip/package.json, then runs
// clipdip's own sync (Cargo.toml workspace version, Cargo.lock, tauri.conf).
// Run as part of build:clipdip so every build and release stays in sync.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPkgPath = path.join(root, 'package.json');
const clipdipPkgPath = path.join(root, 'clipdip', 'package.json');

const version = JSON.parse(await readFile(rootPkgPath, 'utf8')).version;
const clipdipPkgRaw = await readFile(clipdipPkgPath, 'utf8');
const clipdipPkg = JSON.parse(clipdipPkgRaw);

if (clipdipPkg.version !== version) {
  clipdipPkg.version = version;
  await writeFile(clipdipPkgPath, `${JSON.stringify(clipdipPkg, null, 2)}\n`, 'utf8');
}

const { syncVersions } = await import(
  new URL('../clipdip/scripts/sync-version.mjs', import.meta.url)
);
const synced = await syncVersions();
console.log(`sync-clipdip-version: clipdip pinned to ClipLib v${synced}`);
