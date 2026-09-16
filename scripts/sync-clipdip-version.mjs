// Locks clipdip's version to ClipLib's (its self-updater is disabled; they
// ship and update in lockstep). Telemetry once reported 1.0.2 forever, which
// broke per-version health comparisons and regression tracking.
// Writes root package.json's version into clipdip/package.json, then runs
// clipdip's own sync (Cargo.toml, Cargo.lock, tauri.conf). Part of build:clipdip.
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
