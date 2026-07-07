/**
 * Live Performance Profiler — MAIN PROCESS side (dev-only).
 *
 * This is NOT the offline benchmark runner (that's main-harness.js + runner.js).
 * This module powers the always-on, real-use profiler you toggle inside the app
 * during development. It:
 *   - wraps every ipcMain.handle to time the handler body (backend "where did
 *     the time go" for each channel), plus arg/result size,
 *   - records STARTUP phases before the window even exists (see startup mode),
 *   - exposes a global `__perf` hook so hot spots inside handlers (ffmpeg spawn,
 *     fs scans, thumbnail gen) can add finer spans incrementally,
 *   - buffers everything as Chrome Trace Event Format objects on a shared,
 *     wall-clock-anchored timeline so main + renderer events line up in one
 *     flame graph (chrome://tracing / Perfetto).
 *
 * Gating: initPerfMain() is a no-op unless dev. Nothing here is reachable in a
 * packaged build — main.js only requires it behind `!app.isPackaged`.
 *
 * Startup trace mode (CLIPS_PERF_STARTUP=1, wired by `npm run dev:trace`):
 *   - stands in as main.js's `benchmarkHarness` so the startup mark sites
 *     already placed there (moduleLoad / settingsLoad / fileWatcherSetup /
 *     windowCreation / appReady) feed this trace with zero new marks,
 *   - once the renderer signals ready, asks it to dump, then MERGES renderer +
 *     main startup spans into one file and prints a phase summary to the
 *     terminal. A fallback timer guarantees a file even if the renderer never
 *     signals.
 */

'use strict';

const { ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// pid/tid lanes — keep in sync with the renderer (src/renderer/perf/trace.ts).
const PID_MAIN = 2;
const TID = {
  startup: 24, // startup phases (before/around window creation)
  ipc: 20,     // ipcMain.handle bodies
  ffmpeg: 21,  // ffmpeg operations (via __perf.ffmpeg)
  fs: 22,      // filesystem scans (via __perf.span)
  work: 23,    // anything else reported via __perf.span
};

const MAX_EVENTS = 100000; // ring cap; oldest dropped past this

// Anchor performance.now() (monotonic, sub-ms) to wall clock so main + renderer
// timestamps are directly comparable. Both processes anchor to Date.now().
const EPOCH_OFFSET_MS = Date.now() - performance.now();
const wallMs = () => EPOCH_OFFSET_MS + performance.now();
const toTs = (ms) => Math.round(ms * 1000); // Chrome trace ts is microseconds

// Earliest timestamp we can see: this module is required at the very top of
// main.js, before the heavy requires. Used as the "process boot" reference.
const BOOT_MS = wallMs();

let enabled = false;
let readySummaryPrinted = false;
let events = [];
const startupSummary = []; // [{ phase, ms, note }] in finalisation order

function push(evt) {
  events.push(evt);
  if (events.length > MAX_EVENTS) {
    // Drop the oldest 10% in one splice rather than shifting per-event.
    events.splice(0, Math.floor(MAX_EVENTS * 0.1));
  }
}

/** Record a completed span (ph:'X') on the main-process side of the timeline. */
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

/** Cheap, safe byte estimate. Avoids stringifying huge/circular payloads. */
function roughBytes(value) {
  if (value == null) return 0;
  try {
    if (Buffer.isBuffer(value)) return value.length;
    if (typeof value === 'string') return value.length;
    if (Array.isArray(value)) return value.length; // count, not bytes (cheap)
    const s = JSON.stringify(value);
    return s ? s.length : 0;
  } catch {
    return -1; // uncountable (circular / non-serialisable)
  }
}

/**
 * Intercept ipcMain.handle so every channel body is timed. Must run BEFORE any
 * handlers are registered (main.js requires this near the top).
 */
function interceptIpc() {
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = function (channel, handler) {
    // Never instrument our own plumbing — would recurse / pollute the trace.
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

// --- startup recorder ------------------------------------------------------
//
// Implements the small slice of main-harness's interface that main.js calls
// (markStartup / endStartup / recordAppReady). Each phase becomes a span on the
// startup lane plus a line in the terminal summary.

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
    // Whole boot → app ready, measured from the earliest point we can see.
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
  // Direct to stdout so it stands out from the app's own logging.
  process.stdout.write(lines.join('\n') + '\n');
}

// --- trace assembly + write ------------------------------------------------

/** Process/thread name metadata so Perfetto labels the lanes. */
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
 * Merge the main buffer with any renderer events and write one trace file.
 * NON-draining: the buffer is kept, so every dump (hotkey or auto) yields the
 * full session from boot — one continuous capture, not a series of fragments.
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

  // Return + clear the buffered main events (renderer merges into its trace).
  ipcMain.handle('perf:flush', () => {
    const batch = events;
    events = [];
    return batch;
  });

  // Hotkey dump: the renderer hands us its full session, we merge our own
  // startup + IPC + ffmpeg spans and write one file. The app is alive during a
  // keypress, so this round-trip is reliable (unlike a quit-time one).
  ipcMain.handle('perf:dumpTrace', (_event, rendererEvents, meta) => writeTrace(rendererEvents, meta));
}

/**
 * Public hook other main modules can use to add finer spans without importing
 * this file directly, e.g.:
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
 * Once the renderer signals ready, echo the startup phase timings to the
 * terminal for immediate feedback. The full trace (startup + everything since)
 * is saved on demand with the HUD's Dump button — see perf:dumpTrace.
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

/** Startup recorder that stands in as main.js's `benchmarkHarness` (see header). */
function getStartupRecorder() {
  return startupRecorder;
}

module.exports = { initPerfMain, getStartupRecorder };
