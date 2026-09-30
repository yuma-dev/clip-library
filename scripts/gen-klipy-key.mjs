// embeds the KLIPY gif api key into the electron build. source is KLIPY_API_KEY or the
// gitignored klipy.key at the repo root; writes a gitignored json shipped in the asar.
// missing key isn't a build failure, the gif picker just says gifs are unavailable
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(root, 'main', 'klipy-key.generated.json');

let key = process.env.KLIPY_API_KEY || null;
if (!key) {
  try {
    key = readFileSync(path.join(root, 'klipy.key'), 'utf8').trim() || null;
  } catch {
    /* no secrets file in this checkout */
  }
}

writeFileSync(outPath, `${JSON.stringify({ key })}\n`);
console.log(`gen-klipy-key: ${key ? 'key embedded' : 'NO KEY FOUND, gif search disabled'}`);
