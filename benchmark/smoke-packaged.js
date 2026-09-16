#!/usr/bin/env node
'use strict';
// Functional smoke test of the packaged app (dist/win-unpacked) with an
// isolated profile: library paints, a clip opens in the player, settings and
// feed routes render, deferred services come up.
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
  // drives the Electron binary directly; the launcher is "ClipLib Launcher.exe"
  const exe = path.resolve(opt('--exe', path.join(root, 'dist', 'win-unpacked', 'ClipLib.exe')));
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

    // reveal waits for the compositor to frame the grid, a moment after
    // thumbnails decode; give it a few seconds
    let visible = false;
    for (let i = 0; i < 50 && !visible; i++) {
      // inspector context sometimes reported destroyed for one call around
      // reveal (app stays up, seen 1 in 4 runs); a retry succeeds
      visible = await app
        .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.isMaximized()))
        .catch((error) => {
          if (!/context was destroyed/.test(String(error.message))) throw error;
          return false;
        });
      if (!visible) await new Promise((r) => setTimeout(r, 100));
    }
    check('main window visible and maximized', visible);

    // optionally wait for the warmer before opening
    const waitBeforeOpen = Number(opt('--wait-before-open', 0));
    if (waitBeforeOpen > 0) await new Promise((r) => setTimeout(r, waitBeforeOpen));
    const cardIndex = Number(opt('--card', 0));
    const card = page.locator('.clip-item').nth(cardIndex);
    await card.scrollIntoViewIfNeeded();
    const cardName = await card.getAttribute('data-original-name');
    if (args.includes('--reset-cache') && cardName) {
      // drop probe + audio-track caches for a true cold open
      await page.evaluate((name) => window.clips.resetClipCache(name), cardName);
      await new Promise((r) => setTimeout(r, 300));
    }
    const hoverWait = Number(opt('--hover-wait', 0));
    if (hoverWait > 0) {
      // hover triggers the clip warmer; preview only runs while window is focused
      await page.bringToFront();
      await card.hover();
      // Chromium tracks one mouse; OS cursor elsewhere on screen cancels the
      // synthetic hover
      const box = await card.boundingBox();
      if (box) {
        const cx = Math.round(box.x + box.width / 2);
        const cy = Math.round(box.y + box.height / 2);
        require('node:child_process').execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${cx}, ${cy})`]);
      }
      await new Promise((r) => setTimeout(r, hoverWait));
    }
    if (hoverWait > 0) {
      const previewBefore = await page.evaluate(() => Boolean(document.querySelector('.clip-preview-video')));
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await new Promise((r) => setTimeout(r, 100));
      const previewAfter = await page.evaluate(() => Boolean(document.querySelector('.clip-preview-video')));
      check('hover preview stops on window blur', previewBefore && !previewAfter, `preview ${previewBefore ? 'ran' : 'absent'} before, ${previewAfter ? 'still running' : 'gone'} after`);
      await card.hover();
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
