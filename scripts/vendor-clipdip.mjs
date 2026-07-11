// Copies the clipdip binary from the in-repo cargo build (clipdip/ subtree)
// into vendor/clipdip/ so electron-builder's extraResources can ship it as
// resources/clipdip/. ffmpeg is NOT vendored — clipdip shares the library's
// ffmpeg via its config's output.ffmpeg_path (written by main/clipdip.js).
//
// Run via `npm run vendor:clipdip` (or as part of `npm run build`).
import { copyFileSync, mkdirSync, existsSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const exe = join(repo, "clipdip", "target", "release", "clipdip.exe");
const outDir = join(repo, "vendor", "clipdip");

if (!existsSync(exe)) {
  console.error(`vendor-clipdip: missing ${exe}`);
  console.error("Build it first: npm run build:clipdip");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
// Drop stale extras from the pre-merge layout (bundled ffmpeg etc.).
for (const stale of ["ffmpeg.exe", "ATTRIBUTION.txt"]) {
  rmSync(join(outDir, stale), { force: true });
}
const dest = join(outDir, "clipdip.exe");
copyFileSync(exe, dest);
console.log(`vendor-clipdip: clipdip.exe (${(statSync(dest).size / 1048576).toFixed(1)} MB) -> ${outDir}`);
