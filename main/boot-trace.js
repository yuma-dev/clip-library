'use strict';
// Boot timeline for benchmark/cold-start.js.
//
// Enabled only when the process starts with CLIPLIB_BOOT_TRACE=1; every call
// is a no-op otherwise, so it costs nothing in normal launches. Marks are
// epoch milliseconds so main and renderer clocks line up and the harness can
// subtract its own spawn timestamp. The file is rewritten (atomically) a
// short moment after every new mark so the harness can watch it grow.
const path = require('path');

// '1' = timeline marks only; '2' = marks plus a Chromium content trace of the
// whole launch (chromium-trace.json next to boot-trace.json), for digging
// into what the renderer is doing between marks.
// '3' = marks plus a V8 CPU profile of the main process (main.cpuprofile).
const enabled = ['1', '2', '3'].includes(process.env.CLIPLIB_BOOT_TRACE);
const cpuProfileWanted = process.env.CLIPLIB_BOOT_TRACE === '3';
let cpuSession = null;
if (cpuProfileWanted) {
  const inspector = require('inspector');
  cpuSession = new inspector.Session();
  cpuSession.connect();
  cpuSession.post('Profiler.enable');
  cpuSession.post('Profiler.setSamplingInterval', { interval: 500 });
  cpuSession.post('Profiler.start');
}
const contentTraceWanted = process.env.CLIPLIB_BOOT_TRACE === '2';
let contentTraceStopped = false;
let contentTraceTimer = null;
const firstLineAt = Date.now();
const uptimeMsAtFirstLine = Math.round(process.uptime() * 1000);
const marks = {};
let outFile = null;
let writeTimer = null;

function write() {
  if (!outFile) return;
  const fs = require('fs');
  const data = JSON.stringify({
    version: 1,
    pid: process.pid,
    firstLineAt,
    uptimeMsAtFirstLine,
    processStartAt: firstLineAt - uptimeMsAtFirstLine,
    marks,
  });
  try {
    fs.writeFileSync(`${outFile}.tmp`, data);
    fs.renameSync(`${outFile}.tmp`, outFile);
  } catch (_) {
    /* the harness tolerates a missing or partial file */
  }
}

function scheduleWrite() {
  if (!outFile || writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    write();
  }, 150);
  if (writeTimer.unref) writeTimer.unref();
}

/** Record `name` once (first call wins) at `at` (epoch ms, default now). */
function mark(name, at) {
  if (!enabled || marks[name] !== undefined) return;
  marks[name] = typeof at === 'number' && Number.isFinite(at) ? at : Date.now();
  scheduleWrite();
  if (name === 'renderer_ready' && cpuProfileWanted) setTimeout(stopCpuProfile, 3000);
  if (name === 'renderer_ready' && contentTraceWanted) {
    clearTimeout(contentTraceTimer);
    contentTraceTimer = setTimeout(stopContentTrace, 4000);
  }
}

function stopCpuProfile() {
  if (!cpuSession || !outFile) return;
  const session = cpuSession;
  cpuSession = null;
  session.post('Profiler.stop', (error, result) => {
    if (error || !result) return;
    try {
      require('fs').writeFileSync(path.join(path.dirname(outFile), 'main.cpuprofile'), JSON.stringify(result.profile));
    } catch (_) { /* best effort */ }
    session.disconnect();
  });
}

function stopContentTrace() {
  if (!contentTraceWanted || contentTraceStopped || !outFile) return;
  contentTraceStopped = true;
  const { contentTracing } = require('electron');
  contentTracing.stopRecording(path.join(path.dirname(outFile), 'chromium-trace.json')).catch(() => {});
}

/** Call once app.whenReady has resolved: sets the output file and the IPC. */
function init({ ipcMain, userData }) {
  if (!enabled) return;
  outFile = path.join(userData, 'boot-trace.json');
  if (contentTraceWanted) {
    const { contentTracing } = require('electron');
    contentTracing.startRecording({
      included_categories: ['*', 'disabled-by-default-devtools.timeline', 'disabled-by-default-v8.compile'],
      recording_mode: 'record-until-full',
    }).then(() => { mark('content_trace_started'); }).catch(() => {});
    contentTraceTimer = setTimeout(stopContentTrace, 25000);
  }
  if (cpuProfileWanted) setTimeout(stopCpuProfile, 25000);
  ipcMain.on('boot-trace-mark', (_event, payload) => {
    if (payload && typeof payload.name === 'string') mark(payload.name, Number(payload.t));
  });
  scheduleWrite();
}

function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  write();
}

mark('main_first_line', firstLineAt);

module.exports = { enabled, mark, init, flush };
