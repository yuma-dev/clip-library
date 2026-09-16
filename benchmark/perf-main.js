/**
 * Live perf profiler, main-process side (dev-only). Not the offline runner
 * (main-harness.js + runner.js). Wraps ipcMain.handle to time each channel
 * (plus arg/result size), records startup phases before the window exists
 * exposes global __perf for finer spans (ffmpeg spawn, fs scans, thumbnail
 * gen), and buffers it all as Chrome Trace Event Format on a wall-clock
 * timeline shared with the renderer for one flame graph (chrome://tracing /
 * Perfetto).
 *
 * initPerfMain() no-ops unless dev; main.js requires this behind !app.isPackaged.
 *
 * CLIPS_PERF_STARTUP=1 (npm run dev:trace): stands in as main.js's
 * benchmarkHarness for the existing startup marks (moduleLoad / settingsLoad /
 * fileWatcherSetup / windowCreation / appReady); once the renderer signals
 * ready, merges main+renderer startup spans into one file and prints a phase
 * summary. A fallback timer guarantees a file even if the renderer never signals.
 */

'use strict';

const { ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// pid/tid lanes, keep in sync with the renderer (src/renderer/perf/trace.ts)
const PID_MAIN = 2;
const TID = {
  startup: 24, // startup phases (before/around window creation)
  ipc: 20,     // ipcMain.handle bodies
  ffmpeg: 21,  // ffmpeg operations (via __perf.ffmpeg)
  fs: 22,      // filesystem scans (via __perf.span)
  work: 23,    // anything else reported via __perf.span
};

const MAX_EVENTS = 100000; // ring cap; oldest dropped past this

// anchor performance.now() to wall clock so main + renderer timestamps line up;
// both processes anchor to Date.now()
const EPOCH_OFFSET_MS = Date.now() - performance.now();
const wallMs = () => EPOCH_OFFSET_MS + performance.now();
const toTs = (ms) => Math.round(ms * 1000); // Chrome trace ts is microseconds

// earliest timestamp visible: required at the top of main.js before the heavy
// requires, so this stands in for "process boot"
const BOOT_MS = wallMs();

let enabled = false;
let readySummaryPrinted = false;
let events = [];
const startupSummary = []; // [{ phase, ms, note }] in finalisation order

function push(evt) {
  events.push(evt);
  if (events.length > MAX_EVENTS) {
    // drop oldest 10% in one splice, cheaper than shifting per event
    events.splice(0, Math.floor(MAX_EVENTS * 0.1));
  }
}

/** completed span (ph:'X') on the main-process timeline */
function span(name, tid, startMs, durMs, args) {
  if (!enabled) return;
  push({
    name,
    cat: 'main',
    ph: 'X',
    ts: toTs(startMs),
    dur: Math.max(0, Math.round(durMs * 1000)),
    pid: PID_MAIN,
    tid,
    args: args || undefined,
  });
}

/** cheap byte estimate; avoids stringifying huge/circular payloads */
function roughBytes(value) {
  if (value == null) return 0;
  try {
    if (Buffer.isBuffer(value)) return value.length;
    if (typeof value === 'string') return value.length;
    if (Array.isArray(value)) return value.length; // count, not bytes (cheap)
    const s = JSON.stringify(value);
    return s ? s.length : 0;
  } catch {
    return -1; // circular / non-serialisable
  }
}

/**
 * Intercepts ipcMain.handle to time every channel body; must run before
 * handlers register (main.js requires this near the top).
 */
function interceptIpc() {
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = function (channel, handler) {
    // skip our own plumbing, would recurse and pollute the trace
    if (channel.startsWith('perf:') || channel.startsWith('benchmark:')) {
      return original(channel, handler);
    }
    const wrapped = async (event, ...args) => {
      const start = wallMs();
      let ok = true;
      let result;
      try {
        result = await handler(event, ...args);
        return result;
      } catch (err) {
        ok = false;
        throw err;
      } finally {
        span(channel, TID.ipc, start, wallMs() - start, {
          argBytes: args.length ? roughBytes(args) : 0,
          resultBytes: ok ? roughBytes(result) : undefined,
          error: ok ? undefined : true,
        });
      }
    };
    return original(channel, wrapped);
  };
}

// startup recorder: implements the slice of main-harness's interface main.js
// calls (markStartup / endStartup / recordAppReady); each phase becomes a span
// plus a terminal summary line

const startupMarks = new Map();

const startupRecorder = {
  markStartup(phase) {
    startupMarks.set(phase, wallMs());
  },
  endStartup(phase) {
    const start = startupMarks.get(phase);
    if (start == null) return null;
    const dur = wallMs() - start;
    startupMarks.delete(phase);
    span(phase, TID.startup, start, dur, { phase });
    startupSummary.push({ phase, ms: dur });
    return { duration: dur };
  },
  recordAppReady() {
    // whole boot to app ready, measured from the earliest point we can see
    const dur = wallMs() - BOOT_MS;
    span('app-ready', TID.startup, BOOT_MS, dur, { note: 'process boot → app ready' });
    startupSummary.push({ phase: 'app-ready', ms: dur, note: 'boot → ready' });
  },
};

function logStartupSummary(file) {
  const lines = ['', '[perf] startup trace ───────────────────────────'];
  for (const { phase, ms, note } of startupSummary) {
    const label = phase.padEnd(20);
    const time = `${ms.toFixed(1)} ms`.padStart(10);
    lines.push(`  ${label}${time}${note ? `   (${note})` : ''}`);
  }
  if (file) lines.push(`  → ${file}`);
  lines.push('─────────────────────────────────────────────', '');
  // stdout so it stands out from the app's own logging
  process.stdout.write(lines.join('\n') + '\n');
}

// trace assembly + write

/** process/thread metadata so Perfetto labels the lanes */
function processMetadata() {
  const meta = (pid, tid, name, key) => ({ name: key, ph: 'M', pid, tid, args: { name } });
  return [
    meta(PID_MAIN, 0, 'Main process', 'process_name'),
    meta(PID_MAIN, TID.startup, 'startup', 'thread_name'),
    meta(PID_MAIN, TID.ipc, 'IPC handlers', 'thread_name'),
    meta(PID_MAIN, TID.ffmpeg, 'ffmpeg', 'thread_name'),
    meta(PID_MAIN, TID.fs, 'filesystem', 'thread_name'),
    meta(PID_MAIN, TID.work, 'main work', 'thread_name'),
  ];
}

function fsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/**
 * Merges the main buffer with renderer events into one trace file. Non-draining:
 * the buffer is kept, so every dump yields the full session from boot, not fragments.
 */
function writeTrace(rendererEvents, meta) {
  const merged = [...processMetadata(), ...events, ...(rendererEvents || [])];
  const dir = path.join(__dirname, 'traces');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = (meta && meta.stamp) || fsStamp();
  const file = path.join(dir, `perf-trace-${stamp}.json`);
  const doc = { traceEvents: merged, displayTimeUnit: 'ms', metadata: meta || {} };
  fs.writeFileSync(file, JSON.stringify(doc));
  if (meta && meta.reveal) shell.showItemInFolder(file);
  return { file, eventCount: merged.length };
}

/** Handlers the renderer perf layer calls to sync clocks and pull/dump traces. */
function registerHandlers() {
  ipcMain.handle('perf:epoch', () => ({ epochOffsetMs: EPOCH_OFFSET_MS, nowMs: wallMs() }));

  // clears buffered main events; renderer merges them into its own trace
  ipcMain.handle('perf:flush', () => {
    const batch = events;
    events = [];
    return batch;
  });

  // hotkey dump: renderer hands us its full session, we merge our startup/IPC/
  // ffmpeg spans and write one file; app is alive during a keypress, so this
  // round-trip is reliable (unlike a quit-time one)
  ipcMain.handle('perf:dumpTrace', (_event, rendererEvents, meta) => writeTrace(rendererEvents, meta));
}

/**
 * global.__perf hook for other main modules to add finer spans without
 * importing this file, e.g.:
 *   const t = global.__perf?.ffmpeg('export:encode'); ... t?.end();
 *   global.__perf?.span('scan-clips', start, dur);
 */
function installGlobalHook() {
  global.__perf = {
    enabled: () => enabled,
    span: (name, startMs, durMs, args) => span(name, TID.work, startMs, durMs, args),
    fsSpan: (name, startMs, durMs, args) => span(name, TID.fs, startMs, durMs, args),
    ffmpeg: (name) => {
      const start = wallMs();
      return { end: (args) => span(name, TID.ffmpeg, start, wallMs() - start, args) };
    },
    now: wallMs,
  };
}

/**
 * Echoes startup phase timings to the terminal once the renderer signals ready.
 * Full trace saved on demand via the HUD's Dump button, see perf:dumpTrace.
 */
function printStartupSummaryWhenReady() {
  const SETTLE_MS = 1200;
  ipcMain.on('renderer-ready', () => {
    if (readySummaryPrinted) return;
    setTimeout(() => {
      if (readySummaryPrinted) return;
      readySummaryPrinted = true;
      logStartupSummary(null);
    }, SETTLE_MS);
  });
}

function initPerfMain({ isDev } = {}) {
  if (!isDev || enabled) return;
  enabled = true;
  interceptIpc();
  registerHandlers();
  installGlobalHook();
  printStartupSummaryWhenReady();
}

/** stands in as main.js's `benchmarkHarness` (see header) */
function getStartupRecorder() {
  return startupRecorder;
}

module.exports = { initPerfMain, getStartupRecorder };
