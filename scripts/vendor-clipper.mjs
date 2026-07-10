// Copies the clipper binary (clipdip.exe) and its bundled ffmpeg into
// vendor/clipper/ so electron-builder's extraResources can ship them as
// resources/clipper/. Run before `npm run build`:
//
//   node scripts/vendor-clipper.mjs [path-to-clipdip-repo]
//
// The binaries are NOT committed (vendor/ is gitignored) — this script is the
// only supported way to refresh them.
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clipdipRepo = resolve(process.argv[2] ?? join(here, "..", "..", "clipdip"));
const outDir = join(here, "..", "vendor", "clipper");

const sources = [
  { from: join(clipdipRepo, "target", "release", "clipdip.exe"), to: "clipdip.exe", required: true },
  { from: join(clipdipRepo, "dist", "ffmpeg-cache", "ffmpeg.exe"), to: "ffmpeg.exe", required: true },
  { from: join(clipdipRepo, "ATTRIBUTION.txt"), to: "ATTRIBUTION.txt", required: false },
];

mkdirSync(outDir, { recursive: true });

for (const { from, to, required } of sources) {
  if (!existsSync(from)) {
    if (required) {
      console.error(`vendor-clipper: missing ${from}`);
      console.error("Build clipdip first: cargo build --release -p clipdip (and npm run fetch-ffmpeg for ffmpeg.exe)");
      process.exit(1);
    }
    console.warn(`vendor-clipper: skipping optional ${to} (not found)`);
    continue;
  }
  const dest = join(outDir, to);
  copyFileSync(from, dest);
  const mb = (statSync(dest).size / (1024 * 1024)).toFixed(1);
  console.log(`vendor-clipper: ${to} (${mb} MB)`);
}
console.log(`vendor-clipper: done -> ${outDir}`);
