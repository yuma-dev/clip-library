const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const module = { exports: {} };
  modules.set(name, module.exports);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/library', name + '.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  new Function('require', 'module', 'exports', js)((id) => load(id.replace('./', '')), module, module.exports);
  return module.exports;
}
const { filterClips } = load('filter');
const { shuffleClips, monthsBefore } = load('shuffle');
const now = new Date(2026, 8, 18, 12).getTime();
const cutoff = monthsBefore(now, 2);
const clip = (name, tags, createdAt = cutoff - 1) => ({ originalName: name + '.mp4', customName: 'Moment ' + name, tags, createdAt, isTrimmed: false, thumbnailPath: null });
const allowed = clip('allowed', ['Favorite']);
const excluded = clip('excluded', ['Hidden']);
const unnamed = { ...clip('unnamed', []), customName: 'unnamed' };
const recent = clip('recent', ['Favorite'], cutoff);
const clips = [allowed, excluded, unnamed, recent];
const tags = { saved: new Set(['Favorite', 'Untagged']), temporary: new Set(), isTemporary: false };
const input = { query: '?older:2m', now, collection: 'all', tags };
assert.deepEqual(filterClips(clips, input), [allowed]);
assert.deepEqual(filterClips(clips, { ...input, query: '?older:2m #hidden' }), [excluded]);
const mentionIndex = new Map(clips.map(c => [c.originalName, new Set(['alex'])]));
assert.deepEqual(filterClips(clips, { ...input, query: '?older:2m @alex', mentionIndex }), [allowed]);
assert.deepEqual(filterClips(clips, { ...input, query: '?older:2m #hidden @alex', mentionIndex }), [excluded]);
assert.deepEqual(filterClips(clips, { ...input, tags: { ...tags, saved: new Set() } }), []);
assert.deepEqual(filterClips(clips, { ...input, tags: { ...tags, temporary: new Set(['Hidden']), isTemporary: true } }), [excluded]);
assert.deepEqual(filterClips(clips, { ...input, applyTags: false }), [allowed, excluded, unnamed]);
assert.strictEqual(filterClips(clips, { ...input, query: '?shuff', applyTags: false }), clips);
assert.deepEqual(filterClips(clips, { ...input, query: '?older:2m nonexistent' }), []);
assert.equal(monthsBefore(new Date(2024, 2, 31, 12).getTime(), 1), new Date(2024, 1, 29, 12).getTime());
// New immutable metadata must invalidate the normalized search cache.
filterClips([allowed], { ...input, query: 'moment' });
assert.deepEqual(filterClips([{ ...allowed, customName: 'Renamed' }], { ...input, query: 'renamed' }).length, 1);
const many = Array.from({ length: 10000 }, (_, i) => clip('clip-' + i, [i % 3 ? 'Favorite' : 'Hidden'], now - i * 86400000));
const ordered = shuffleClips(many, 123);
assert.equal(new Set(ordered).size, many.length);
assert.deepEqual(shuffleClips(many, 123), ordered);
assert.notDeepEqual(shuffleClips(many, 456), ordered);
assert.deepEqual(shuffleClips(many.slice(0, 100), 123), ordered.filter(c => many.slice(0, 100).includes(c)));
const queries = ['?older:2m', '?older:3m', '?older:6m', '?older:2m moment', '?older:2m #favorite'];
for (const query of queries) {
  assert.deepEqual(filterClips(ordered, { ...input, query }), shuffleClips(filterClips(many, { ...input, query }), 123));
}
function timed(run) {
  for (let i = 0; i < 20; i++) run(i);
  const samples = [];
  for (let i = 0; i < 150; i++) { const t = performance.now(); run(i); samples.push(performance.now() - t); }
  samples.sort((a, b) => a - b);
  return { medianMs: +samples[75].toFixed(3), p95Ms: +samples[142].toFixed(3) };
}
const before = timed(i => shuffleClips(filterClips(many, { ...input, query: queries[i % queries.length] }), 123));
const after = timed(i => filterClips(ordered, { ...input, query: queries[i % queries.length] }));
console.log(JSON.stringify({ checks: 'passed', clips: many.length, sortEveryEdit: before, cachedOrder: after }, null, 2));
