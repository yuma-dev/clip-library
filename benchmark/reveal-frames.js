#!/usr/bin/env node
'use strict';
// Frames of the boot reveal from the PACKAGED app (dist/win-unpacked, npm run bench:build first),
// launched through the native launcher like a user would. The moment the reveal plays, every
// animation on the page is paused and seeked to each time in turn, so the frames are exact even
// on a loaded machine. Writes benchmark/results/reveal-<stamp>/<ms>.jpg plus sheet.png.
//
//   node benchmark/reveal-frames.js                       default times
//   node benchmark/reveal-frames.js --times 0,300,600,900
//
// Uses a copy of benchmark/profiles/warm-template (node benchmark/cold-start.js --make-profile,
// redo it now and then or the first start generates thumbnails for every newer clip) with the
// tour and the rebrand card marked seen so nothing covers the reveal. The intro tears
// itself down 1.6s into the reveal (real time), so keep the list short; later frames come out at
// rest. The app window shows on screen while it runs.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const appDir = path.join(root, 'dist', 'win-unpacked');
const launcher = path.join(appDir, 'Setsu Launcher.exe');
const template = path.join(__dirname, 'profiles', 'warm-template');
const profile = path.join(os.tmpdir(), 'cliplib-bench', 'reveal-frames');
const PORT = 9444;
const ATTEMPTS = 3;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const times = (arg('--times') || '0,200,330,420,500,600,700,850,1100,1400').split(',').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the bench app and anything it spawned (thumbnail ffmpeg, ffprobe) all run from dist; one left
// behind locks dist/ and the next electron-builder run fails with "Access is denied"
function killApp() {
  const dir = appDir.replace(/'/g, "''");
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | ? { $_.ExecutablePath -like '${dir}\\*' } | % { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
  } catch {}
}

// clips recorded after the template was made have no thumbnail in it: the first start makes them
// (spinners and glow fill-ins instead of cards in the frames), later starts reuse them
const STALE_DAYS = 7;

function seed() {
  if (!fs.existsSync(template)) throw new Error('no warm template, run node benchmark/cold-start.js --make-profile');
  const madeAt = fs.statSync(path.join(template, 'settings.json')).mtimeMs;
  const days = (Date.now() - madeAt) / 86400000;
  if (days > STALE_DAYS) console.log(`warm template is ${Math.floor(days)} days old, newer clips lack thumbnails; refresh it with node benchmark/cold-start.js --make-profile`);
  // a copy of an older template is thrown away, the rest of the time it is kept between runs
  const stamp = path.join(profile, '.template-made');
  const current = fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === String(madeAt);
  if (!current) {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelayMs: 200 });
    fs.cpSync(template, profile, { recursive: true });
    fs.writeFileSync(stamp, String(madeAt));
  }
  const file = path.join(profile, 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  settings.onboardingVersion = Math.max(Number(settings.onboardingVersion) || 0, 99);
  settings.setsuIntroSeen = true;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  fs.rmSync(path.join(profile, 'boot-trace.json'), { force: true });
}

async function attempt(outDir) {
  seed();
  const env = { ...process.env, CLIPLIB_PROFILE_DIR: profile, CLIPLIB_BOOT_TRACE: '1', CLIPLIB_SKIP_DEFERRED: 'updater,discord,clipdip,pins' };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(launcher, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 150 && !browser; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      } catch {
        await sleep(100);
      }
    }
    if (!browser) throw new Error(`no devtools on port ${PORT}`);
    let page;
    for (let i = 0; i < 150 && !page; i++) {
      page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('index.html'));
      if (!page) await sleep(100);
    }
    if (!page) throw new Error('app page never showed up');
    // the renderer holds the reveal paused for two frames, wait until it plays. polling gently:
    // a busy renderer misses its frame check and falls back to the plain reveal
    let caught = false;
    for (let i = 0; i < 600 && !caught; i++) {
      caught = await page
        .evaluate(() => {
          const a = document.querySelector('#boot-reveal .boot-star')?.getAnimations()[0];
          if (!a || a.playState !== 'running') return false;
          for (const x of document.getAnimations()) x.pause();
          return true;
        })
        .catch(() => false);
      if (!caught) await sleep(40);
    }
    if (!caught) return false;
    for (const t of times) {
      await page.evaluate((ms) => {
        for (const x of document.getAnimations()) x.currentTime = ms;
      }, t);
      await page.screenshot({ path: path.join(outDir, `${String(t).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85 });
    }
    return true;
  } finally {
    await browser?.close().catch(() => {});
    killApp();
  }
}

async function sheet(outDir) {
  const files = times.map((t) => `${String(t).padStart(5, '0')}.jpg`).filter((f) => fs.existsSync(path.join(outDir, f)));
  const cells = files.map((f) => `<figure><img src="data:image/jpeg;base64,${fs.readFileSync(path.join(outDir, f)).toString('base64')}"><figcaption>${Number(f.slice(0, 5))} ms</figcaption></figure>`).join('');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 2000, height: 600 } });
  await page.setContent(`<style>body{margin:0;background:#111;display:grid;grid-template-columns:repeat(5,1fr);gap:6px;padding:6px;font:14px sans-serif;color:#ccc}
    figure{margin:0}img{width:100%;display:block}figcaption{padding:4px 2px}</style>${cells}`);
  await page.screenshot({ path: path.join(outDir, 'sheet.png'), fullPage: true });
  await browser.close();
}

(async () => {
  if (!fs.existsSync(launcher)) throw new Error(`no packaged app at ${appDir}, run npm run bench:build`);
  killApp();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, 'results', `reveal-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  for (let i = 1; i <= ATTEMPTS; i++) {
    if (await attempt(outDir)) {
      await sheet(outDir);
      console.log(`frames in ${path.relative(root, outDir)} (sheet.png)`);
      return;
    }
    console.log(`attempt ${i}: the app took the plain reveal (no animation), retrying`);
  }
  throw new Error(`no animated reveal in ${ATTEMPTS} attempts`);
})().catch((error) => {
  killApp();
  console.error(error.message);
  process.exit(1);
});
