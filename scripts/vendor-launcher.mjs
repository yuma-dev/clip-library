// Copies the native splash launcher into vendor/launcher/"Setsu Launcher.exe"
// for electron-builder to place at the install root next to Setsu.exe. renaming Setsu.exe
// makes the update unpin the app (3.7.0 took that hit once for the Setsu rename).
// Launcher starts Setsu.exe and fades out once its window is on screen.
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
const dest = join(outDir, "Setsu Launcher.exe");
copyFileSync(exe, dest);
console.log(`vendor-launcher: Setsu Launcher.exe (${(statSync(dest).size / 1024).toFixed(0)} KB) -> ${outDir}`);
