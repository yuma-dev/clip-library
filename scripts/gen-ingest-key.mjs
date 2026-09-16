// Embeds the diagnostics ingest key into the Electron build.
// Key lives in gitignored clipdip/.cargo/config.toml ([env] CLIPDIP_INGEST_KEY);
// this writes it to a gitignored JSON shipped in the asar for /v1/bundles uploads.
// Missing key isn't a build failure: uploader falls back to text log upload.
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
