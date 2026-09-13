#!/usr/bin/env node
'use strict';
// What does the app do when nobody touches it? Launches the packaged app with
// the warm bench profile, waits for startup work to settle, then records CPU
// profiles of the renderer (CDP Profiler) and the main process (inspector)
// for a window, and prints per-process CPU seconds by process type.
//
//   node benchmark/idle-profile.js [--settle MS] [--window MS] [--cursor X,Y] [--trace]
// Profiles land in benchmark/results/idle-renderer.cpuprofile and
// idle-main.cpuprofile; analyze with benchmark/analyze-cpuprofile.js.

const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const settleMs = opt('--settle', 25000);
const windowMs = opt('--window', 10000);
// Where to park the real mouse cursor before measuring (hover states cost).
const cursorArg = (() => { const i = args.indexOf('--cursor'); return i >= 0 ? args[i + 1] : ''; })();

function cpuByType() {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like '*dist\\win-unpacked*' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { $t = 'main'; if ($_.CommandLine -match '--type=([a-z-]+)') { $t = $matches[1] }; '' + $_.ProcessId + '|' + $t + '|' + $p.TotalProcessorTime.TotalSeconds + '|' + [math]::Round($p.WorkingSet64/1MB) } }`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script]).toString();
  const rows = new Map();
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [pid, type, cpu, ws] = line.split('|');
    rows.set(Number(pid), { type, cpu: Number(cpu), ws: Number(ws) });
  }
  return rows;
}

async function main() {
  const exe = path.join(root, 'dist', 'win-unpacked', 'ClipLib App.exe');
  const template = path.join(root, 'benchmark', 'profiles', 'warm-template');
  const profile = path.join(os.tmpdir(), 'cliplib-bench', 'idle-profile');
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelayMs: 200 });
  fs.cpSync(template, profile, { recursive: true });
  const env = { ...process.env, CLIPLIB_PROFILE_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await electron.launch({ executablePath: exe, env });
  try {
    let page;
    for (let i = 0; i < 300 && !page; i++) {
      page = app.windows().find((p) => p.url().includes('renderer-dist'));
      if (!page) await new Promise((r) => setTimeout(r, 100));
    }
    if (!page) throw new Error('library window never appeared');
    await page.locator('.clip-item').first().waitFor({ timeout: 30000 });
    if (cursorArg) {
      const [x, y] = cursorArg.split(',').map(Number);
      execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`]);
      console.log(`cursor parked at ${x},${y}`);
    }
    console.log(`library up; settling ${settleMs} ms`);
    await new Promise((r) => setTimeout(r, settleMs));

    const before = cpuByType();
    const cdp = await page.context().newCDPSession(page);
    // --trace: also record a Chromium trace of the window (rendering categories).
    const traceWanted = args.includes('--trace');
    const traceEvents = [];
    if (traceWanted) {
      const browserCdp = await page.context().newCDPSession(page);
      browserCdp.on('Tracing.dataCollected', (e) => traceEvents.push(...e.value));
      const tracingComplete = new Promise((r) => browserCdp.once('Tracing.tracingComplete', r));
      await browserCdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink,cc,gpu,viz,toplevel', transferMode: 'ReportEvents' });
      global.__stopTrace = async () => { await browserCdp.send('Tracing.end'); await tracingComplete; };
    }
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
    await app.evaluate(() => {
      const inspector = process.mainModule.require('inspector');
      global.__idleSession = new inspector.Session();
      global.__idleSession.connect();
      global.__idleSession.post('Profiler.enable');
      global.__idleSession.post('Profiler.setSamplingInterval', { interval: 500 });
      global.__idleSession.post('Profiler.start');
    });
    await new Promise((r) => setTimeout(r, windowMs));
    const { profile: rendererProfile } = await cdp.send('Profiler.stop');
    const mainProfile = await app.evaluate(() => new Promise((resolve) => {
      global.__idleSession.post('Profiler.stop', (error, result) => {
        global.__idleSession.disconnect();
        resolve(error ? null : result.profile);
      });
    }));
    if (traceWanted) {
      await global.__stopTrace();
      fs.mkdirSync(path.join(root, 'benchmark', 'results'), { recursive: true });
      fs.writeFileSync(path.join(root, 'benchmark', 'results', 'idle-trace.json'), JSON.stringify({ traceEvents }));
      console.log(`trace: ${traceEvents.length} events -> benchmark/results/idle-trace.json`);
    }
    const after = cpuByType();

    fs.mkdirSync(path.join(root, 'benchmark', 'results'), { recursive: true });
    fs.writeFileSync(path.join(root, 'benchmark', 'results', 'idle-renderer.cpuprofile'), JSON.stringify(rendererProfile));
    if (mainProfile) fs.writeFileSync(path.join(root, 'benchmark', 'results', 'idle-main.cpuprofile'), JSON.stringify(mainProfile));

    console.log(`\nCPU seconds per process over ${windowMs} ms at rest:`);
    for (const [pid, a] of after) {
      const b = before.get(pid);
      const delta = b ? a.cpu - b.cpu : a.cpu;
      console.log(`  ${String(pid).padStart(6)}  ${a.type.padEnd(16)} ${delta.toFixed(2).padStart(6)} s  (${(delta / (windowMs / 1000) * 100).toFixed(0).padStart(3)}% of a core)  ${a.ws} MB`);
    }
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
