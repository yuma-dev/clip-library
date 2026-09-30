// embeds the text log upload key (logs api /api/logs) into the electron build. source is
// LOGS_API_KEY or the gitignored logs.key at the repo root; writes a gitignored json shipped in
// the asar. missing key isn't a build failure, the text upload just reports it has no key
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(root, 'main', 'logs-key.generated.json');

let key = process.env.LOGS_API_KEY || null;
if (!key) {
  try {
    key = readFileSync(path.join(root, 'logs.key'), 'utf8').trim() || null;
  } catch {
    /* no secrets file in this checkout */
  }
}

writeFileSync(outPath, `${JSON.stringify({ key })}\n`);
console.log(`gen-logs-key: ${key ? 'key embedded' : 'NO KEY FOUND, text log upload disabled'}`);
