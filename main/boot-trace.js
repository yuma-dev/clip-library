'use strict';
// Boot timeline for benchmark/cold-start.js. No-op unless CLIPLIB_BOOT_TRACE
// is set; epoch-ms marks so main/renderer clocks line up, file rewritten atomically after each mark.
const path = require('path');

// '1' = timeline marks; '2' = marks + chromium content trace (chromium-trace.json);
// '3' = marks + V8 cpu profile of main process (main.cpuprofile)
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
// free-form boot facts (frame stats etc), written next to marks
const notes = {};
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
    notes,
  });
  try {
    fs.writeFileSync(`${outFile}.tmp`, data);
    fs.renameSync(`${outFile}.tmp`, outFile);
  } catch (_) {
    /* harness tolerates a missing or partial file */
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

/** first call wins; `at` defaults to now (epoch ms) */
function mark(name, at) {
  if (!enabled || marks[name] !== undefined) return;
  marks[name] = typeof at === 'number' && Number.isFinite(at) ? at : Date.now();
  scheduleWrite();
  if (name === 'renderer_ready' && cpuProfileWanted) setTimeout(stopCpuProfile, 3000);
  if (name === 'renderer_ready' && contentTraceWanted) {
    clearTimeout(contentTraceTimer);
    contentTraceTimer = setTimeout(stopContentTrace, Number(process.env.CLIPLIB_TRACE_STOP_MS) || 4000);
  }
}

/** non-timing fact; last call wins */
function note(name, value) {
  if (!enabled) return;
  notes[name] = value;
  scheduleWrite();
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

/** call after app.whenReady: sets the output file and the ipc listener */
function init({ ipcMain, userData }) {
  if (!enabled) return;
  outFile = path.join(userData, 'boot-trace.json');
  if (contentTraceWanted) {
    const { contentTracing } = require('electron');
    contentTracing.startRecording({
      // lean set: devtools-style renderer timeline without slowing the app down
      included_categories: (process.env.CLIPLIB_TRACE_CATEGORIES || 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,v8.execute,loading,disabled-by-default-v8.compile').split(','),
      recording_mode: 'record-until-full',
    }).then(() => { mark('content_trace_started'); }).catch(() => {});
    contentTraceTimer = setTimeout(stopContentTrace, Math.max(25000, (Number(process.env.CLIPLIB_TRACE_STOP_MS) || 0) + 5000));
  }
  if (cpuProfileWanted) setTimeout(stopCpuProfile, 25000);
  if (process.env.CLIPLIB_GPU_INFO === '1') {
    const { app } = require('electron');
    setTimeout(() => {
      Promise.all([app.getGPUInfo('complete'), Promise.resolve(app.getGPUFeatureStatus())]).then(([info, features]) => {
        require('fs').writeFileSync(path.join(userData, 'gpu-info.json'), JSON.stringify({ features, info }, null, 2));
      }).catch(() => {});
    }, 4000);
  }
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

module.exports = { enabled, mark, note, init, flush };
