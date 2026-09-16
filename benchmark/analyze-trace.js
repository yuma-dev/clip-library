#!/usr/bin/env node
'use strict';
// Summarize a Chromium content trace recorded by `cold-start.js --trace`.
//
//   node benchmark/analyze-trace.js benchmark/results/chromium-trace-x-1.json [--from MARK --to MARK] [--boot boot-trace.json]
//
// per process/thread: longest complete events in the window, busiest event names, resource loads
// (URL + duration) from devtools.timeline. never prints the trace whole.

const fs = require('node:fs');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) throw new Error('trace file required');
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const top = Number(opt('--top', 25));
const fromMs = opt('--from') ? Number(opt('--from')) : null; // ms since trace start
const toMs = opt('--to') ? Number(opt('--to')) : null;

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = Array.isArray(raw) ? raw : raw.traceEvents;
const procNames = new Map();
const threadNames = new Map();
let t0 = Infinity;
for (const e of events) {
  if (e.ph === 'M' && e.name === 'process_name') procNames.set(e.pid, e.args.name);
  else if (e.ph === 'M' && e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args.name);
  if (typeof e.ts === 'number' && e.ts > 0 && e.ph !== 'M') t0 = Math.min(t0, e.ts);
}
const ms = (us) => Math.round((us - t0) / 100) / 10;
const inWindow = (e) => (fromMs === null || ms(e.ts) >= fromMs) && (toMs === null || ms(e.ts) <= toMs);
const label = (e) => `${procNames.get(e.pid) || 'pid' + e.pid}/${threadNames.get(`${e.pid}:${e.tid}`) || 'tid' + e.tid}`;

console.log(`events: ${events.length}, processes: ${[...procNames.values()].join(', ')}`);

const marksOfInterest = new Set(['navigationStart', 'domContentLoadedEventEnd', 'loadEventEnd', 'firstPaint', 'firstContentfulPaint',
  'RendererMainThreadCreated', 'ResourceSendRequest', 'ProcessLaunch', 'BrowserMain:MainMessageLoopRun']);
const marks = events.filter((e) => marksOfInterest.has(e.name) && inWindow(e))
  .map((e) => ({ t: ms(e.ts), name: e.name, where: label(e), url: e.args?.data?.url || '' }))
  .sort((a, b) => a.t - b.t).slice(0, 60);
console.log('\n== timeline marks (ms from trace start) ==');
for (const m of marks) console.log(`${String(m.t).padStart(8)}  ${m.name.padEnd(28)} ${m.where}${m.url ? '  ' + m.url.slice(-80) : ''}`);

// Resource loads: pair ResourceSendRequest with ResourceFinish by requestId.
const sends = new Map();
const loads = [];
for (const e of events) {
  const d = e.args?.data;
  if (!d) continue;
  if (e.name === 'ResourceSendRequest') sends.set(d.requestId, { t: ms(e.ts), url: d.url, where: label(e) });
  else if (e.name === 'ResourceFinish' || e.name === 'ResourceReceiveResponse') {
    const s = sends.get(d.requestId);
    if (s && e.name === 'ResourceFinish') loads.push({ ...s, end: ms(e.ts), dur: Math.round((ms(e.ts) - s.t) * 10) / 10 });
  }
}
console.log('\n== resource loads (start, duration ms) ==');
for (const l of loads.filter(inWindowByT).sort((a, b) => a.t - b.t).slice(0, 40)) {
  console.log(`${String(l.t).padStart(8)}  ${String(l.dur).padStart(8)}  ${l.url.slice(-100)}`);
}
function inWindowByT(l) { return (fromMs === null || l.t >= fromMs) && (toMs === null || l.t <= toMs); }

const complete = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number' && inWindow(e));
complete.sort((a, b) => b.dur - a.dur);
console.log(`\n== ${top} longest complete events ==`);
for (const e of complete.slice(0, top)) {
  const extra = e.args?.data?.url || e.args?.data?.functionName || e.args?.src_func || e.args?.data?.fileName || '';
  console.log(`${String(ms(e.ts)).padStart(8)}  ${String(Math.round(e.dur / 100) / 10).padStart(8)}  ${label(e).padEnd(40)} ${e.name}${extra ? '  ' + String(extra).slice(-70) : ''}`);
}

// sums dur across nesting, not real self time (no depth-0 filtering)
const byName = new Map();
for (const e of complete) {
  const k = `${label(e)} :: ${e.name}`;
  byName.set(k, (byName.get(k) || 0) + e.dur);
}
console.log(`\n== busiest thread::event by total duration (ms) ==`);
for (const [k, v] of [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  console.log(`${String(Math.round(v / 1000)).padStart(8)}  ${k}`);
}

const byThread = new Map();
for (const e of complete) {
  const k = label(e);
  const cur = byThread.get(k) || { total: 0, max: 0 };
  cur.total += e.dur;
  cur.max = Math.max(cur.max, e.dur);
  byThread.set(k, cur);
}
console.log(`\n== threads by summed event duration (ms; nested events double count) ==`);
for (const [k, v] of [...byThread.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 15)) {
  console.log(`${String(Math.round(v.total / 1000)).padStart(8)}  max ${String(Math.round(v.max / 1000)).padStart(6)}  ${k}`);
}
