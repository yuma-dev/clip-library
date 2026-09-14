#!/usr/bin/env node
'use strict';
// Scroll-cost experiments on the packaged app: one launch, then a series of
// CSS overrides injected into the live page, each followed by the same wheel
// scroll, reporting frame times. Tells which part of the grid's styling makes
// a scroll frame expensive without a rebuild per hypothesis.
//
//   node benchmark/scroll-experiments.js [--cursor grid|edge] [--exe PATH] [--wait MS]

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
const cursorMode = opt('--cursor', 'grid');
const exeOverride = opt('--exe', '');
const waitMs = Number(opt('--wait', 9000));

const pct = (values, p) => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

const EXPERIMENTS = [
  ['baseline', ''],
  ['no content-visibility toggling', '.clip-item.cv-offscreen{content-visibility:visible!important}'],
  ['glow wrap hidden', '.clip-glow-wrap{display:none!important}'],
  ['no hover styles', '.clip-item:hover{transform:none!important}.clip-item:hover::before{opacity:0!important;display:none!important}.clip-item:hover .clip-item-media-container{border-color:inherit!important}'],
  ['no contain on cards', '.clip-item{contain:none!important}'],
  ['no will-change anywhere', '*{will-change:auto!important}'],
  ['no card z-index', '.clip-item{z-index:auto!important}'],
  ['cards without ::before', '.clip-item::before{display:none!important}'],
  ['groups content-visibility auto', '.clip-group-content{content-visibility:auto;contain-intrinsic-size:auto 1200px}'],
  ['groups cv auto + no card cull', '.clip-group-content{content-visibility:auto;contain-intrinsic-size:auto 1200px}.clip-item.cv-offscreen{content-visibility:visible!important}'],
];

async function measure(page, action) {
  await page.evaluate(() => {
    const w = window;
    w.__bench = { frames: [] };
    let last = performance.now();
    const tick = (t) => {
      w.__bench.frames.push(t - last);
      last = t;
      w.__bench.raf = requestAnimationFrame(tick);
    };
    w.__bench.raf = requestAnimationFrame(tick);
  });
  await action();
  await new Promise((r) => setTimeout(r, 300));
  const frames = await page.evaluate(() => {
    cancelAnimationFrame(window.__bench.raf);
    return window.__bench.frames.slice(1);
  });
  return { p50: Math.round(pct(frames, 50) * 10) / 10, p95: Math.round(pct(frames, 95) * 10) / 10, max: Math.round(Math.max(0, ...frames)), over33: frames.filter((f) => f > 33).length, n: frames.length };
}

async function main() {
  const exe = exeOverride ? path.resolve(exeOverride) : path.join(root, 'dist', 'win-unpacked', 'ClipLib.exe');
  const template = path.join(root, 'benchmark', 'profiles', 'warm-template');
  const profile = path.join(os.tmpdir(), 'cliplib-bench', 'scroll-profile');
  if (!fs.existsSync(path.join(profile, 'settings.json'))) fs.cpSync(template, profile, { recursive: true });
  const env = { ...process.env, CLIPLIB_PROFILE_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: exe, env });
  try {
    let page;
    for (let i = 0; i < 300 && !page; i++) {
      page = app.windows().find((p) => p.url().includes('renderer-dist'));
      if (!page) await new Promise((r) => setTimeout(r, 100));
    }
    await page.locator('.clip-item').first().waitFor({ timeout: 30000 });
    await page.bringToFront();
    await new Promise((r) => setTimeout(r, waitMs));
    const scrollEl = page.locator('.clip-scroll').first();
    const box = await scrollEl.boundingBox();
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    const park = cursorMode === 'edge' ? [Math.round(box.x + box.width) + 40, cy] : [cx, cy];
    execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${park[0]}, ${park[1]})`]);
    await page.mouse.move(park[0], park[1]);
    const mounted = await page.evaluate(() => document.querySelectorAll('.clip-item').length);
    console.log(`cards mounted: ${mounted}, cursor: ${cursorMode}\n`);
    console.log(`${'experiment'.padEnd(34)}  p50ms  p95ms  maxms  >33ms   n`);
    for (const [name, css] of EXPERIMENTS) {
      await page.evaluate((c) => {
        let el = document.getElementById('bench-style');
        if (!el) { el = document.createElement('style'); el.id = 'bench-style'; document.head.appendChild(el); }
        el.textContent = c;
        document.querySelector('.clip-scroll').scrollTop = 0;
      }, css);
      await new Promise((r) => setTimeout(r, 600));
      const r = await measure(page, async () => {
        for (let i = 0; i < 30; i++) {
          await page.mouse.wheel(0, 600);
          await new Promise((res) => setTimeout(res, 50));
        }
      });
      console.log(`${name.padEnd(34)}  ${String(r.p50).padStart(5)}  ${String(r.p95).padStart(5)}  ${String(r.max).padStart(5)}  ${String(r.over33).padStart(5)}  ${r.n}`);
    }
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
