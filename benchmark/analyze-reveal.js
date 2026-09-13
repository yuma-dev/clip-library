#!/usr/bin/env node
'use strict';
// Frame-level view of the boot reveal animation from a Chromium trace recorded
// with `cold-start.js --trace` and CLIPLIB_TRACE_CATEGORIES including
// "benchmark,viz" (the frame pipeline reporter).
//
//   node benchmark/analyze-reveal.js benchmark/results/chromium-trace-x-2.json [--window MS] [--discover]
//
// Aligns on the renderer's user-timing mark `reveal_anim_start` (set by
// src/renderer/boot/bootReveal.ts) and, for the next --window ms (1300):
//  - lists renderer main-thread tasks over 8 ms with what they ran;
//  - counts compositor frames from PipelineReporter events: presented,
//    dropped, and the gaps between presented frames.
// --discover prints the event names seen in the window instead (for finding
// the right names when Chromium renames things).

const fs = require('node:fs');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) throw new Error('trace file required');
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const windowMs = Number(opt('--window', 1300));
const discover = args.includes('--discover');
// --around MS: list the longest events on every thread from MS-5 to MS+90
// (ms after reveal_anim_start), to see what all processes did in a stall.
const around = opt('--around') ? Number(opt('--around')) : null;

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = Array.isArray(raw) ? raw : raw.traceEvents;
const procNames = new Map();
const threadNames = new Map();
for (const e of events) {
  if (e.ph === 'M' && e.name === 'process_name') procNames.set(e.pid, e.args.name);
  else if (e.ph === 'M' && e.name === 'thread_name') threadNames.set(`${e.pid}:${e.tid}`, e.args.name);
}
const tname = (e) => threadNames.get(`${e.pid}:${e.tid}`) || '';
const pname = (e) => procNames.get(e.pid) || '';

const start = events.find((e) => e.name === 'reveal_anim_start' && (e.cat || '').includes('blink.user_timing'));
if (!start) throw new Error('no reveal_anim_start user-timing mark in the trace (was the reveal animated?)');
const t0 = start.ts;
const t1 = t0 + windowMs * 1000;
const inWin = (e) => typeof e.ts === 'number' && e.ts >= t0 && e.ts <= t1;
const ms = (us) => Math.round((us - t0) / 100) / 10;
const rendererPid = start.pid;
console.log(`reveal_anim_start at trace ts ${t0} (renderer pid ${rendererPid}); window ${windowMs} ms`);

if (discover) {
  const names = new Map();
  for (const e of events) {
    if (!inWin(e)) continue;
    const k = `${pname(e)}/${tname(e)} :: ${e.cat} :: ${e.name} (${e.ph})`;
    names.set(k, (names.get(k) || 0) + 1);
  }
  for (const [k, v] of [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 120)) console.log(String(v).padStart(6), k);
  process.exit(0);
}

if (around !== null) {
  const a0 = t0 + (around - 5) * 1000;
  const a1 = t0 + (around + 90) * 1000;
  const hits = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number' && e.ts >= a0 && e.ts <= a1 && e.dur >= 500)
    .sort((a, b) => b.dur - a.dur).slice(0, 40);
  console.log(`\n== longest events on any thread, +${around - 5} to +${around + 90} ms ==`);
  for (const e of hits) {
    const extra = e.args?.data?.functionName || e.args?.src_func || e.args?.data?.url || '';
    console.log(`  +${String(ms(e.ts)).padStart(7)}  ${String(Math.round(e.dur / 100) / 10).padStart(6)} ms  ${(pname(e) + '/' + tname(e)).padEnd(34)} ${e.name}${extra ? '  ' + String(extra).slice(-60) : ''}`);
  }
}

// Renderer main-thread tasks in the window.
const main = events.filter((e) => e.pid === rendererPid && tname(e) === 'CrRendererMain' && e.ph === 'X' && typeof e.dur === 'number' && inWin(e));
const tasks = main.filter((e) => e.name === 'ThreadControllerImpl::RunTask' || e.name === 'RunTask' || e.name === 'MessageLoop::RunTask').sort((a, b) => a.ts - b.ts);
const long = tasks.filter((e) => e.dur >= 8000);
console.log(`\nrenderer main thread: ${tasks.length} tasks, ${long.length} over 8 ms, busy ${Math.round(tasks.reduce((s, e) => s + e.dur, 0) / 1000)} ms of ${windowMs}`);
// What the main thread spent its time on (nested events double count).
const byName = new Map();
const taskSet = new Set(tasks);
for (const e of main) {
  if (taskSet.has(e)) continue;
  const k = e.name + (e.args?.data?.functionName ? '(' + e.args.data.functionName + ')' : '');
  byName.set(k, (byName.get(k) || 0) + e.dur);
}
console.log(`  busiest: ${[...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k} ${Math.round(v / 1000)}`).join(', ')}`);
for (const t of long) {
  const children = main.filter((c) => c.ts >= t.ts && c.ts + c.dur <= t.ts + t.dur && c !== t && c.dur >= 1000)
    .sort((a, b) => b.dur - a.dur).slice(0, 4)
    .map((c) => `${c.name}${c.args?.data?.functionName ? '(' + c.args.data.functionName + ')' : ''} ${Math.round(c.dur / 100) / 10}`);
  console.log(`  +${String(ms(t.ts)).padStart(7)} ms  ${String(Math.round(t.dur / 100) / 10).padStart(6)} ms  ${children.join(' | ')}`);
}

// Compositor frames: PipelineReporter async events (benchmark,viz) carry the
// frame's fate in args.chrome_frame_reporter.state on the end event.
const reporters = events.filter((e) => e.name === 'PipelineReporter' && (e.ph === 'b' || e.ph === 'e' || e.ph === 'S' || e.ph === 'F') && e.pid === rendererPid);
const byId = new Map();
for (const e of reporters) {
  const id = e.id2?.local || e.id2?.global || e.id;
  const cur = byId.get(id) || {};
  if (e.ph === 'b' || e.ph === 'S') cur.begin = e;
  else cur.end = e;
  byId.set(id, cur);
}
const frames = [...byId.values()].filter((f) => f.begin && f.end && f.begin.ts >= t0 && f.begin.ts <= t1);
const state = (f) => f.end.args?.chrome_frame_reporter?.state || f.begin.args?.chrome_frame_reporter?.state || f.end.args?.state || '?';
const counts = new Map();
for (const f of frames) counts.set(state(f), (counts.get(state(f)) || 0) + 1);
console.log(`\ncompositor (renderer PipelineReporter): ${frames.length} frames in window`);
for (const [k, v] of counts) console.log(`  ${k}: ${v}`);
const dropped = frames.filter((f) => state(f) === 'STATE_DROPPED').map((f) => ms(f.begin.ts)).sort((a, b) => a - b);
if (dropped.length) console.log(`  dropped at: ${dropped.map((t) => `+${t}`).join(' ')}`);
const animFrames = frames.filter((f) => (f.begin.args?.chrome_frame_reporter || {}).has_compositor_animation);
console.log(`  frames with a compositor animation: ${animFrames.length} (${animFrames.filter((f) => state(f) === 'STATE_DROPPED').length} dropped)`);
const presented = frames.filter((f) => /PRESENTED/.test(state(f))).map((f) => f.end.ts).sort((a, b) => a - b);
const gaps = [];
for (let i = 1; i < presented.length; i++) gaps.push((presented[i] - presented[i - 1]) / 1000);
if (gaps.length) {
  const sorted = [...gaps].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  console.log(`  presented gaps: median ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms, ${gaps.filter((g) => g > 25).length} over 25 ms`);
  const big = gaps.map((g, i) => ({ g, at: ms(presented[i]) })).filter((x) => x.g > 25);
  for (const b of big) console.log(`    gap ${b.g.toFixed(0)} ms after +${b.at} ms`);
}
