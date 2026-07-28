// Embeds the diagnostics ingest key into the Electron build.
//
// The key lives only in the gitignored clipdip/.cargo/config.toml ([env]
// CLIPDIP_INGEST_KEY), where cargo compiles it into the clipdip binary. The
// Electron side needs it too for uploading unified diagnostic bundles to
// /v1/bundles, so the build writes it to a gitignored JSON file that ships
// inside the asar. Missing key is not a build failure: the uploader falls
// back to the text log upload.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(root, 'main', 'ingest-key.generated.json');

let key = process.env.CLIPDIP_INGEST_KEY || null;
if (!key) {
  try {
    const raw = readFileSync(path.join(root, 'clipdip', '.cargo', 'config.toml'), 'utf8');
    key = raw.match(/CLIPDIP_INGEST_KEY\s*=\s*"([^"]+)"/)?.[1] ?? null;
  } catch {
    /* no secrets file in this checkout */
  }
}

writeFileSync(outPath, `${JSON.stringify({ key })}\n`);
console.log(`gen-ingest-key: ${key ? 'key embedded' : 'NO KEY FOUND, bundle upload will fall back to text logs'}`);
