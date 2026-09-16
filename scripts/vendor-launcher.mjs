// Copies the native splash launcher into vendor/launcher/"ClipLib Launcher.exe"
// for electron-builder to place at the install root next to ClipLib.exe (name
// must stay stable, or the installer loses shortcut/taskbar pins on update).
// Launcher starts ClipLib.exe and fades out once its window is on screen.
// Run via `npm run vendor:launcher` (or as part of `npm run build`).
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const exe = join(repo, "clipdip", "target", "release", "cliplib-launcher.exe");
const outDir = join(repo, "vendor", "launcher");

if (!existsSync(exe)) {
  console.error(`vendor-launcher: missing ${exe}`);
  console.error("Build it first: npm run build:launcher");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const dest = join(outDir, "ClipLib Launcher.exe");
copyFileSync(exe, dest);
console.log(`vendor-launcher: ClipLib Launcher.exe (${(statSync(dest).size / 1024).toFixed(0)} KB) -> ${outDir}`);
