#!/usr/bin/env node
'use strict';
// Functional smoke test of the packaged app (dist/win-unpacked) with an
// isolated profile: the library paints, a clip opens in the player, the
// settings and feed routes render, and the deferred services come up.
//
//   node benchmark/smoke-packaged.js [--exe PATH] [--profile DIR] [--wait-before-open MS] [--card N] [--hover-wait MS] [--reset-cache]

const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

async function main() {
  // Playwright drives the Electron binary directly (ClipLib.exe is the native launcher).
  const exe = path.resolve(opt('--exe', path.join(root, 'dist', 'win-unpacked', 'ClipLib App.exe')));
  const template = path.join(root, 'benchmark', 'profiles', 'warm-template');
  const profile = opt('--profile', path.join(os.tmpdir(), 'cliplib-bench', 'smoke-profile'));
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelayMs: 200 });
  fs.cpSync(template, profile, { recursive: true });

  const env = { ...process.env, CLIPLIB_PROFILE_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: exe, env });
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  try {
    let page;
    for (let i = 0; i < 300 && !page; i++) {
      page = app.windows().find((p) => p.url().includes('renderer-dist'));
      if (!page) await new Promise((r) => setTimeout(r, 100));
    }
    if (!page) throw new Error('library window never appeared');

    await page.locator('.clip-item').first().waitFor({ timeout: 30000 });
    const cards = await page.locator('.clip-item').count();
    check('library grid painted', cards > 0, `${cards} cards mounted`);

    await page.waitForFunction(
      () => [...document.querySelectorAll('.clip-item img')].some((i) => i.complete && i.naturalWidth > 0 && i.src.includes('thumbnail-cache')),
      { timeout: 30000 },
    );
    check('thumbnails decoded', true);

    // The reveal waits for the compositor to frame the grid, a moment after
    // the thumbnails decode; give it a few seconds.
    let visible = false;
    for (let i = 0; i < 50 && !visible; i++) {
      visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.isMaximized()));
      if (!visible) await new Promise((r) => setTimeout(r, 100));
    }
    check('main window visible and maximized', visible);

    // Open the first clip in the player (optionally after the warmer had time).
    const waitBeforeOpen = Number(opt('--wait-before-open', 0));
    if (waitBeforeOpen > 0) await new Promise((r) => setTimeout(r, waitBeforeOpen));
    const cardIndex = Number(opt('--card', 0));
    const card = page.locator('.clip-item').nth(cardIndex);
    await card.scrollIntoViewIfNeeded();
    const cardName = await card.getAttribute('data-original-name');
    if (args.includes('--reset-cache') && cardName) {
      // Drop the probe and audio-track caches so the open is a true cold one.
      await page.evaluate((name) => window.clips.resetClipCache(name), cardName);
      await new Promise((r) => setTimeout(r, 300));
    }
    const hoverWait = Number(opt('--hover-wait', 0));
    if (hoverWait > 0) {
      // Hover triggers the clip warmer; give it time before the click.
      await card.hover();
      await new Promise((r) => setTimeout(r, hoverWait));
    }
    const clickAt = Date.now();
    await card.click();
    await page.waitForFunction(() => {
      const overlay = document.getElementById('player-overlay');
      const video = document.querySelector('#player-overlay video');
      return overlay && overlay.style.display !== 'none' && video && video.src.startsWith('file://');
    }, { timeout: 20000 });
    check('clip opens in the player', true);
    await page.waitForFunction(() => {
      const video = document.querySelector('#player-overlay video');
      return video && video.readyState >= 2;
    }, { timeout: 20000 }).then(() => check('video has data', true, `${Date.now() - clickAt} ms click to playable`), (e) => check('video has data', false, e.message.split('\n')[0]));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const overlay = document.getElementById('player-overlay');
      return !overlay || overlay.style.display === 'none';
    }, { timeout: 10000 });
    check('player closes', true);

    // Settings route (lazy chunk).
    const settingsNav = page.locator('[aria-label="Settings"], button:has-text("Settings"), .rail-item:has-text("Settings")').first();
    if (await settingsNav.count()) {
      await settingsNav.click();
      const ok = await page.locator('.settings-view, [class*="settings"]').first().waitFor({ timeout: 15000 }).then(() => true, () => false);
      check('settings route renders', ok);
    } else {
      check('settings route renders', false, 'no settings nav control found');
    }

    // Deferred services reached the log.
    await new Promise((r) => setTimeout(r, 4000));
    const logsDir = path.join(profile, 'logs');
    const latest = fs.readdirSync(logsDir).filter((f) => f.endsWith('.log')).map((f) => path.join(logsDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    const log = latest ? fs.readFileSync(latest, 'utf8') : '';
    check('ffmpeg verified after reveal', /FFmpeg version:/.test(log));
    check('NVENC probed after reveal', /NVENC status on startup/.test(log));
    check('file watcher set up', /File watcher set up for/.test(log));
    const errors = (log.match(/ ERROR /g) || []).length;
    check('no ERROR lines in log', errors === 0, `${errors} errors`);
  } finally {
    await app.close().catch(() => {});
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
