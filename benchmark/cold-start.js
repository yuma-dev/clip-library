#!/usr/bin/env node
'use strict';
// Cold-start benchmark against the PACKAGED app (dist/win-unpacked), launched
// the way a user launches it: through the native splash launcher ClipLib.exe.
//
// Each run launches ClipLib.exe with an isolated, pre-seeded profile
// (CLIPLIB_PROFILE_DIR) and CLIPLIB_BOOT_TRACE=1, then watches the
// boot-trace.json the app writes (main/boot-trace.js) until the grid has
// painted a real thumbnail and the fresh clip list has been reconciled.
//
//   node benchmark/cold-start.js --make-profile        seed benchmark/profiles/warm-template from %APPDATA%\Clips
//   node benchmark/cold-start.js --label baseline      7 warm runs, median/p90 table, results appended as JSONL
//   node benchmark/cold-start.js --profile cold-cache  no localStorage snapshot, no thumbnail cache
//   node benchmark/cold-start.js --cold-fs             copy the app to a fresh folder per run (defeats the OS file cache)
//   npm run bench:startup                              build + 5 runs + regression check against benchmark/startup-thresholds.json
//
// Flags: --runs N (7), --exe PATH, --timeout MS (60000), --keep (leave scratch
// profiles), --reuse (seed once, keep the same profile for every run),
// --benchmark-mode (also set CLIPS_BENCHMARK=1: no updater, no discord),
// --trace (also record a Chromium content trace; analyze with benchmark/analyze-trace.js),
// --cpu (also record a V8 CPU profile of the main process; analyze with benchmark/analyze-cpuprofile.js),
// --settle MS (keep the app alive that long after the last mark, e.g. to let deferred services log),
// --pixel-probe (sample three screen points during launch and report white/dark/content runs),
// --env KEY=VAL (extra environment for the app, repeatable),
// --app-args "--flag --other" (extra Chromium/Electron switches for the app).

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profilesDir = path.join(root, 'benchmark', 'profiles');
const resultsDir = path.join(root, 'benchmark', 'results');
const scratchRoot = path.join(os.tmpdir(), 'cliplib-bench');

const PHASES = [
  'main_first_line', 'modules_loaded', 'app_ready', 'settings_loaded', 'window_constructed',
  'preload_start', 'preload_done', 'renderer_script_start', 'snapshot_hit', 'snapshot_miss',
  'first_paint', 'first_contentful_paint', 'grid_first_card', 'grid_first_thumb',
  'window_visible', 'renderer_ready', 'get_clips_resolved', 'get_clips_returned',
  'fresh_list_committed', 'thumb_paths_applied', 'tags_loaded',
  'reveal_gate_start', 'reveal_gate_decoded', 'ready_to_show', 'frame_1', 'frame_2', 'window_opaque',
];
// The run is over once all of these exist (or the timeout hits).
const DONE_MARKS = ['window_visible', 'grid_first_thumb', 'fresh_list_committed', 'thumb_paths_applied', 'tags_loaded'];

function parseArgs(argv) {
  const out = { runs: 7, profile: 'warm', timeout: 60000, label: '', exe: '', keep: false, coldFs: false, reuse: false, trace: false, cpu: false, settle: 0, pixelProbe: false, assert: false, extraEnv: {}, appArgs: [], makeProfile: false, benchmarkMode: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--runs') out.runs = Number(next());
    else if (a === '--profile') out.profile = next();
    else if (a === '--timeout') out.timeout = Number(next());
    else if (a === '--label') out.label = next();
    else if (a === '--exe') out.exe = next();
    else if (a === '--keep') out.keep = true;
    else if (a === '--reuse') out.reuse = true;
    else if (a === '--trace') out.trace = true;
    else if (a === '--cpu') out.cpu = true;
    else if (a === '--settle') out.settle = Number(next());
    else if (a === '--pixel-probe') out.pixelProbe = true;
    else if (a === '--assert') out.assert = true;
    else if (a === '--env') { const [k, ...v] = next().split('='); out.extraEnv[k] = v.join('='); }
    else if (a === '--app-args') out.appArgs = next().split(/s+/).filter(Boolean);
    else if (a === '--cold-fs') out.coldFs = true;
    else if (a === '--make-profile') out.makeProfile = true;
    else if (a === '--benchmark-mode') out.benchmarkMode = true;
    else throw new Error(`Unknown flag ${a}`);
  }
  if (!out.label) out.label = out.profile;
  return out;
}

function rmrf(p) {
  // A just-killed app can hold handles for a moment; keep trying.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelayMs: 100 });
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function makeProfile() {
  const src = path.join(process.env.APPDATA, 'Clips');
  const dest = path.join(profilesDir, 'warm-template');
  if (!fs.existsSync(path.join(src, 'settings.json'))) throw new Error(`No real profile at ${src}`);
  rmrf(dest);
  fs.mkdirSync(dest, { recursive: true });
  const copy = (name) => {
    const from = path.join(src, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, name), { recursive: true });
  };
  // GPUCache and the Dawn caches hold compiled shaders; without them every
  // launch recompiles what a real user already has on disk.
  for (const name of ['thumbnail-cache', 'Local Storage', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'global_tags.json', 'tagPreferences.json',
    'trackPreferences.json', 'watched-clips.json', 'last-clips.json']) copy(name);
  // Benchmark runs must never talk to the user's Discord, spawn clipdip or
  // pollute real telemetry. The clip folder stays the real library: it is
  // only read during boot, and thumbnails are keyed by absolute path so a
  // copy would invalidate the whole warm cache.
  const settings = JSON.parse(fs.readFileSync(path.join(src, 'settings.json'), 'utf8'));
  settings.enableDiscordRPC = false;
  settings.clipdip = { ...(settings.clipdip || {}), enabled: false, autostart: false };
  settings.telemetry = { ...(settings.telemetry || {}), enabled: false };
  settings.sharing = { ...(settings.sharing || {}), apiToken: '' };
  fs.writeFileSync(path.join(dest, 'settings.json'), JSON.stringify(settings, null, 2));
  console.log(`Seeded ${dest} (clipLocation ${settings.clipLocation})`);
}

function seedProfile(profile, dir) {
  const template = path.join(profilesDir, 'warm-template');
  if (!fs.existsSync(template)) throw new Error('Run with --make-profile first');
  rmrf(dir);
  const skip = profile === 'cold-cache' ? new Set(['Local Storage', 'thumbnail-cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) : new Set();
  fs.cpSync(template, dir, {
    recursive: true,
    filter: (p) => !skip.has(path.basename(p)) || path.dirname(p) !== template,
  });
}

function readTrace(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce(opts, index, exe) {
  // --reuse keeps one profile across runs (what a returning user has: a
  // settled Chromium profile); the default seeds a fresh copy per run.
  const profileDir = opts.reuse
    ? path.join(scratchRoot, `${opts.label}-${opts.profile}`)
    : path.join(scratchRoot, `${opts.label}-${opts.profile}-${index}`);
  if (!opts.reuse || !fs.existsSync(path.join(profileDir, 'settings.json'))) seedProfile(opts.profile, profileDir);
  const traceFile = path.join(profileDir, 'boot-trace.json');
  rmrf(traceFile);

  const env = { ...process.env, CLIPLIB_PROFILE_DIR: profileDir, CLIPLIB_BOOT_TRACE: opts.trace ? '2' : opts.cpu ? '3' : '1' };
  const cpuProfile = path.join(profileDir, 'main.cpuprofile');
  rmrf(cpuProfile);
  const chromiumTrace = path.join(profileDir, 'chromium-trace.json');
  rmrf(chromiumTrace);
  delete env.ELECTRON_RUN_AS_NODE;
  if (opts.benchmarkMode) env.CLIPS_BENCHMARK = '1';
  Object.assign(env, opts.extraEnv);

  // Screen-pixel probe: samples the centre of the primary screen every
  // ~25 ms so a white (or otherwise wrong) frame between the window
  // appearing and the library painting shows up as data.
  let probe = null;
  let probeOut = '';
  if (opts.pixelProbe) {
    probe = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'pixel-probe.ps1'), String(Math.min(opts.timeout, 6000))], { stdio: ['ignore', 'pipe', 'ignore'] });
    probe.stdout.on('data', (d) => { probeOut += d; });
    await new Promise((r) => { const check = () => (probeOut.includes('epoch,') ? r() : setTimeout(check, 20)); check(); });
  }
  const spawnAt = Date.now();
  const child = spawn(exe, opts.appArgs, { env, stdio: 'ignore', windowsHide: false });
  let trace = null;
  const deadline = spawnAt + opts.timeout;
  while (Date.now() < deadline) {
    await sleep(50);
    trace = readTrace(traceFile) || trace;
    if (trace && DONE_MARKS.every((m) => trace.marks[m] !== undefined) && (!opts.trace || fs.existsSync(chromiumTrace)) && (!opts.cpu || fs.existsSync(cpuProfile))) {
      if (opts.trace || opts.cpu) await sleep(1500);
      if (opts.settle) await sleep(opts.settle);
      break;
    }
    // The launcher exits at handoff; only stop early once the app itself is gone.
    if (child.exitCode !== null) {
      const appPid = trace?.pid;
      let appAlive = false;
      if (appPid) { try { process.kill(appPid, 0); appAlive = true; } catch { /* gone */ } }
      if (!appAlive) break;
    }
  }
  // ClipLib.exe is the native launcher and exits once the app is on screen;
  // the app's own pid is in the trace it wrote.
  for (const pid of new Set([trace?.pid, child.pid].filter(Boolean))) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
  await sleep(300);
  if (opts.trace && fs.existsSync(chromiumTrace)) {
    const dest = path.join(resultsDir, `chromium-trace-${opts.label}-${index}.json`);
    fs.copyFileSync(chromiumTrace, dest);
    console.log(`chromium trace: ${dest}`);
  }
  if (opts.cpu && fs.existsSync(cpuProfile)) {
    const dest = path.join(resultsDir, `main-${opts.label}-${index}.cpuprofile`);
    fs.copyFileSync(cpuProfile, dest);
    console.log(`cpu profile: ${dest}`);
  }
  if (!opts.keep && !opts.reuse) rmrf(profileDir);

  if (probe) {
    await new Promise((r) => { probe.on('exit', r); setTimeout(r, 7000); });
    const lines = probeOut.split(/\r?\n/).filter(Boolean);
    const epoch = Number((lines.find((l) => l.startsWith('epoch,')) || 'epoch,0').split(',')[1]);
    // Each sample line: t, then r,g,b for every probe point.
    const samples = lines.filter((l) => !l.startsWith('epoch,')).map((l) => l.split(',').map(Number)).map(([t, ...rest]) => ({ t: Math.round(epoch + t - spawnAt), pts: rest }));
    const kind = ({ pts }) => {
      const px = [];
      for (let i = 0; i + 2 < pts.length; i += 3) px.push(pts.slice(i, i + 3));
      if (px.every(([r, g, b]) => r > 200 && g > 200 && b > 200)) return 'WHITE';
      if (px.every(([r, g, b]) => r < 40 && g < 40 && b < 40)) return 'dark';
      return 'content';
    };
    const runs = [];
    for (const s of samples) { const k = kind(s); const last = runs[runs.length - 1]; if (last && last.k === k) last.to = s.t; else runs.push({ k, from: s.t, to: s.t }); }
    console.log(`  pixel probe: ${runs.map((r) => `${r.k} ${r.from}..${r.to}`).join(' | ')}`);
  }

  const rel = {};
  if (trace) {
    for (const [name, at] of Object.entries(trace.marks)) rel[name] = Math.round(at - spawnAt);
    rel.process_start = Math.round(trace.processStartAt - spawnAt);
  }
  return { label: opts.label, profile: opts.profile, coldFs: opts.coldFs, run: index, spawnAt, complete: Boolean(trace) && DONE_MARKS.every((m) => rel[m] !== undefined), marks: rel };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function printTable(results) {
  // Drop the first run when there are enough: it pays for the file cache.
  const pool = results.length >= 3 ? results.slice(1) : results;
  const rows = [];
  for (const phase of PHASES) {
    const values = pool.map((r) => r.marks[phase]).filter((v) => typeof v === 'number');
    if (!values.length) continue;
    rows.push({ phase, n: values.length, median: percentile(values, 50), p90: percentile(values, 90), min: Math.min(...values) });
  }
  const width = Math.max(...rows.map((r) => r.phase.length));
  console.log(`\n${'phase'.padEnd(width)}  ${'median'.padStart(7)}  ${'p90'.padStart(7)}  ${'min'.padStart(7)}  n`);
  for (const r of rows) {
    console.log(`${r.phase.padEnd(width)}  ${String(r.median).padStart(7)}  ${String(r.p90).padStart(7)}  ${String(r.min).padStart(7)}  ${r.n}`);
  }
  const incomplete = results.filter((r) => !r.complete).length;
  if (incomplete) console.log(`\n${incomplete} of ${results.length} runs hit the timeout before every done mark landed.`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.makeProfile) return makeProfile();

  // The user path: through the native splash launcher.
  const builtExe = path.join(root, 'dist', 'win-unpacked', 'ClipLib Launcher.exe');
  const baseExe = opts.exe ? path.resolve(opts.exe) : builtExe;
  if (!fs.existsSync(baseExe)) throw new Error(`No packaged app at ${baseExe} (run npm run bench:build)`);
  fs.mkdirSync(scratchRoot, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  let sha = 'unknown';
  try { sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(); } catch { /* not a repo */ }
  const asarBytes = fs.existsSync(path.join(path.dirname(baseExe), 'resources', 'app.asar'))
    ? fs.statSync(path.join(path.dirname(baseExe), 'resources', 'app.asar')).size : null;

  const results = [];
  for (let i = 1; i <= opts.runs; i++) {
    let exe = baseExe;
    let appCopy = null;
    if (opts.coldFs) {
      appCopy = path.join(scratchRoot, `app-${opts.label}-${i}-${Date.now()}`);
      fs.cpSync(path.dirname(baseExe), appCopy, { recursive: true });
      exe = path.join(appCopy, path.basename(baseExe));
    }
    const result = await runOnce(opts, i, exe);
    result.sha = sha;
    result.asarBytes = asarBytes;
    results.push(result);
    fs.appendFileSync(path.join(resultsDir, `${opts.label}.jsonl`), `${JSON.stringify(result)}\n`);
    const m = result.marks;
    console.log(`run ${i}: window ${m.window_visible ?? '-'}  first_thumb ${m.grid_first_thumb ?? '-'}  fresh_list ${m.fresh_list_committed ?? '-'}  tags ${m.tags_loaded ?? '-'}${result.complete ? '' : '  (incomplete)'}`);
    if (appCopy) rmrf(appCopy);
  }
  printTable(results);
  console.log(`\nlabel ${opts.label}  profile ${opts.profile}  sha ${sha}  asar ${asarBytes ? `${(asarBytes / 1048576).toFixed(1)} MB` : '-'}`);
  if (opts.assert) {
    // Regression guard: medians (first run dropped) against benchmark/startup-thresholds.json.
    const thresholds = JSON.parse(fs.readFileSync(path.join(root, 'benchmark', 'startup-thresholds.json'), 'utf8'));
    const limits = thresholds[opts.profile] || {};
    const pool = results.length >= 3 ? results.slice(1) : results;
    let failed = 0;
    for (const [phase, max] of Object.entries(limits)) {
      const values = pool.map((r) => r.marks[phase]).filter((v) => typeof v === 'number');
      const median = percentile(values, 50);
      const ok = median !== null && median <= max;
      if (!ok) failed += 1;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${phase} median ${median ?? '-'} ms (limit ${max})`);
    }
    if (asarBytes && thresholds.asar_bytes && asarBytes > thresholds.asar_bytes) {
      failed += 1;
      console.log(`FAIL  asar ${asarBytes} bytes (limit ${thresholds.asar_bytes})`);
    }
    if (failed) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
