#!/usr/bin/env node
'use strict';
// Interaction benchmark on the packaged app: scroll the library, type in the
// search field, collapse and expand a group, and report frame times and
// input-to-paint latencies. Numbers come from the renderer itself
// (requestAnimationFrame deltas, the Event Timing API and long animation
// frames), so they reflect what the user sees.
//
//   node benchmark/interaction-bench.js [--label X] [--runs N]

const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const label = opt('--label', 'interaction');
const runs = Number(opt('--runs', 1));

const pct = (values, p) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

async function measure(page, name, action) {
  await page.evaluate(() => {
    const w = window;
    w.__bench = { frames: [], events: [], loaf: [] };
    let last = performance.now();
    const tick = (t) => {
      w.__bench.frames.push(t - last);
      last = t;
      w.__bench.raf = requestAnimationFrame(tick);
    };
    w.__bench.raf = requestAnimationFrame(tick);
    try {
      w.__bench.eventObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__bench.events.push({ name: e.name, duration: e.duration, processing: e.processingEnd - e.processingStart });
      });
      w.__bench.eventObserver.observe({ type: 'event', durationThreshold: 16, buffered: false });
    } catch { /* unsupported */ }
    try {
      w.__bench.loafObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__bench.loaf.push(e.duration);
      });
      w.__bench.loafObserver.observe({ type: 'long-animation-frame', buffered: false });
    } catch { /* unsupported */ }
  });
  const startedAt = Date.now();
  await action();
  // Let the last frames land.
  await new Promise((r) => setTimeout(r, 400));
  const data = await page.evaluate(() => {
    const w = window;
    cancelAnimationFrame(w.__bench.raf);
    w.__bench.eventObserver?.disconnect();
    w.__bench.loafObserver?.disconnect();
    return { frames: w.__bench.frames, events: w.__bench.events, loaf: w.__bench.loaf };
  });
  const frames = data.frames.slice(1);
  return {
    name,
    wallMs: Date.now() - startedAt,
    frames: frames.length,
    frameP50: Math.round(pct(frames, 50) * 10) / 10,
    frameP95: Math.round(pct(frames, 95) * 10) / 10,
    frameMax: Math.round(Math.max(0, ...frames)),
    framesOver33: frames.filter((f) => f > 33).length,
    loafOver50: data.loaf.filter((d) => d > 50).length,
    loafMax: Math.round(Math.max(0, ...data.loaf)),
    eventMax: Math.round(Math.max(0, ...data.events.map((e) => e.duration))),
    eventP95: Math.round(pct(data.events.map((e) => e.duration), 95)),
    eventCount: data.events.length,
  };
}

async function runOnce(index) {
  const exe = path.join(root, 'dist', 'win-unpacked', 'ClipLib.exe');
  const template = path.join(root, 'benchmark', 'profiles', 'warm-template');
  const profile = path.join(os.tmpdir(), 'cliplib-bench', 'interaction-profile');
  if (!fs.existsSync(path.join(profile, 'settings.json'))) fs.cpSync(template, profile, { recursive: true });
  const env = { ...process.env, CLIPLIB_PROFILE_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: exe, env });
  const results = [];
  try {
    let page;
    for (let i = 0; i < 300 && !page; i++) {
      page = app.windows().find((p) => p.url().includes('renderer-dist'));
      if (!page) await new Promise((r) => setTimeout(r, 100));
    }
    if (!page) throw new Error('library window never appeared');
    await page.locator('.clip-item').first().waitFor({ timeout: 30000 });
    await page.bringToFront();
    // Let startup work (fresh list, tags, thumbnails, warmer) settle.
    await new Promise((r) => setTimeout(r, 9000));

    const scrollEl = page.locator('.clip-scroll').first();
    const box = await scrollEl.boundingBox();
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    // Park the real cursor on the grid too, so the synthetic pointer holds.
    execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${cx}, ${cy})`]);
    await page.mouse.move(cx, cy);

    results.push(await measure(page, 'scroll down 40 x 600px', async () => {
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, 600);
        await new Promise((r) => setTimeout(r, 50));
      }
    }));
    results.push(await measure(page, 'scroll up 40 x 600px', async () => {
      for (let i = 0; i < 40; i++) {
        await page.mouse.wheel(0, -600);
        await new Promise((r) => setTimeout(r, 50));
      }
    }));
    results.push(await measure(page, 'fling to bottom and back', async () => {
      await page.evaluate(() => { const el = document.querySelector('.clip-scroll'); el.scrollTop = el.scrollHeight; });
      await new Promise((r) => setTimeout(r, 800));
      await page.evaluate(() => { document.querySelector('.clip-scroll').scrollTop = 0; });
      await new Promise((r) => setTimeout(r, 800));
    }));

    const search = page.locator('.r-search input').first();
    results.push(await measure(page, 'type "league" in search', async () => {
      await search.click();
      await page.keyboard.type('league', { delay: 180 });
      await new Promise((r) => setTimeout(r, 300));
    }));
    results.push(await measure(page, 'clear search', async () => {
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await new Promise((r) => setTimeout(r, 500));
    }));
    await page.keyboard.press('Escape');

    const header = page.locator('.clip-group-header').first();
    results.push(await measure(page, 'collapse + expand first group', async () => {
      await header.click();
      await new Promise((r) => setTimeout(r, 500));
      await header.click();
      await new Promise((r) => setTimeout(r, 700));
    }));
  } finally {
    await app.close().catch(() => {});
  }
  return results;
}

async function main() {
  fs.mkdirSync(path.join(root, 'benchmark', 'results'), { recursive: true });
  for (let i = 1; i <= runs; i++) {
    const results = await runOnce(i);
    const w = Math.max(...results.map((r) => r.name.length));
    console.log(`\n${'scenario'.padEnd(w)}  frames  p50ms  p95ms  maxms  >33ms  loaf>50  event p95/max`);
    for (const r of results) {
      console.log(`${r.name.padEnd(w)}  ${String(r.frames).padStart(6)}  ${String(r.frameP50).padStart(5)}  ${String(r.frameP95).padStart(5)}  ${String(r.frameMax).padStart(5)}  ${String(r.framesOver33).padStart(5)}  ${String(r.loafOver50).padStart(7)}  ${String(r.eventP95).padStart(6)}/${r.eventMax}`);
    }
    fs.appendFileSync(path.join(root, 'benchmark', 'results', `${label}.jsonl`), `${JSON.stringify({ label, run: i, at: Date.now(), results })}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
