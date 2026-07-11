import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateChangelog } from './changelog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version, lastTag, body } = generateChangelog(root);
const draftFile = join(root, 'RELEASE_DRAFT.md');

writeFileSync(draftFile, `${body}\n`, 'utf8');

console.log(`\nRelease notes preview - v${version} (since ${lastTag ?? 'beginning'})\n`);
console.log('-'.repeat(50));
console.log(body);
console.log('-'.repeat(50));
console.log('\nEdit RELEASE_DRAFT.md to make changes, then run: npm run release');
console.log('To regenerate from scratch, delete RELEASE_DRAFT.md and re-run this command.\n');
