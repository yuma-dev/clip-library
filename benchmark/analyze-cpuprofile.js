#!/usr/bin/env node
'use strict';
// Summarize a .cpuprofile of the main process recorded by `cold-start.js --cpu`.
//
//   node benchmark/analyze-cpuprofile.js benchmark/results/main-x-1.cpuprofile [--top 40] [--bucket 250]
//
// self time by function, inclusive time by function, self time by file, timeline of dominant
// function per bucket

const fs = require('node:fs');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) throw new Error('cpuprofile required');
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const top = opt('--top', 40);
const bucketMs = opt('--bucket', 250);

const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);

const label = (n) => {
  const cf = n.callFrame;
  const fn = cf.functionName || '(anonymous)';
  const url = (cf.url || '').replace(/\\/g, '/');
  const short = url ? url.split('/').slice(-2).join('/') : '';
  return short ? `${fn} ${short}:${cf.lineNumber + 1}` : fn;
};
const fileOf = (n) => (n.callFrame.url || '(native)').replace(/\\/g, '/').split('/').slice(-3).join('/');
const isIdle = (n) => ['(idle)', '(program)', '(garbage collector)', '(root)'].includes(n.callFrame.functionName);

// Self time per node from samples + timeDeltas (microseconds).
const self = new Map();
const total = new Map();
let t = profile.startTime;
const timeline = new Map(); // bucket -> Map(label -> us)
let busyUs = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  const dt = profile.timeDeltas[i] || 0;
  t += dt;
  const n = nodes.get(id);
  self.set(id, (self.get(id) || 0) + dt);
  if (!isIdle(n)) busyUs += dt;
  // Inclusive: walk to root.
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const l = label(nodes.get(cur));
    if (seen.has(l)) continue;
    seen.add(l);
    total.set(l, (total.get(l) || 0) + dt);
  }
  const b = Math.floor((t - profile.startTime) / 1000 / bucketMs);
  if (!timeline.has(b)) timeline.set(b, new Map());
  const tm = timeline.get(b);
  const l = isIdle(n) ? '(idle)' : label(n);
  tm.set(l, (tm.get(l) || 0) + dt);
}

const ms = (us) => Math.round(us / 100) / 10;
console.log(`profile: ${ms(profile.endTime - profile.startTime)} ms wall, ${ms(busyUs)} ms busy on the main thread, ${profile.samples.length} samples`);

const bySelf = new Map();
for (const [id, us] of self) {
  const n = nodes.get(id);
  const l = isIdle(n) ? n.callFrame.functionName : label(n);
  bySelf.set(l, (bySelf.get(l) || 0) + us);
}
console.log(`\n== top ${top} by self time (ms) ==`);
for (const [l, us] of [...bySelf].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${String(ms(us)).padStart(9)}  ${l}`);

console.log(`\n== top ${top} by inclusive time (ms) ==`);
for (const [l, us] of [...total].filter(([l]) => !/^\((root|program|idle|garbage)/.test(l)).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${String(ms(us)).padStart(9)}  ${l}`);

const byFile = new Map();
for (const [id, us] of self) {
  const n = nodes.get(id);
  if (isIdle(n)) continue;
  const f = fileOf(n);
  byFile.set(f, (byFile.get(f) || 0) + us);
}
console.log(`\n== self time by file (ms) ==`);
for (const [f, us] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${String(ms(us)).padStart(9)}  ${f}`);

console.log(`\n== timeline (${bucketMs} ms buckets: busy ms, dominant function) ==`);
for (const [b, tm] of [...timeline].sort((a, b) => a[0] - b[0])) {
  const busy = [...tm].filter(([l]) => l !== '(idle)').reduce((a, [, us]) => a + us, 0);
  const [domLabel, domUs] = [...tm].filter(([l]) => l !== '(idle)').sort((a, b) => b[1] - a[1])[0] || ['', 0];
  console.log(`${String(b * bucketMs).padStart(7)}  ${String(ms(busy)).padStart(6)}  ${domLabel ? `${domLabel} (${ms(domUs)})` : ''}`);
}
