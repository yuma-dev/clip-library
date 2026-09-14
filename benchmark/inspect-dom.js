#!/usr/bin/env node
'use strict';
// Dump what the boot intro may have left behind in the live DOM of the
// packaged app (classes, inline styles, promoted layers, running animations).
//
//   node benchmark/inspect-dom.js [--exe PATH] [--wait MS]

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
const exe = opt('--exe', '') ? path.resolve(opt('--exe', '')) : path.join(root, 'dist', 'win-unpacked', 'ClipLib.exe');
const waitMs = Number(opt('--wait', 12000));

async function main() {
  const template = path.join(root, 'benchmark', 'profiles', 'warm-template');
  const profile = path.join(os.tmpdir(), 'cliplib-bench', 'inspect-profile');
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
    await new Promise((r) => setTimeout(r, waitMs));
    const info = await page.evaluate(() => {
      const cs = (el) => (el ? getComputedStyle(el) : null);
      const shell = document.querySelector('.app-shell');
      const body = document.querySelector('.app-body');
      const rail = document.querySelector('.rail');
      const promoted = [];
      for (const el of document.querySelectorAll('body *')) {
        const s = getComputedStyle(el);
        if (s.willChange !== 'auto' || (s.transform !== 'none' && !el.classList.contains('clip-glow-wrap'))) {
          promoted.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} will-change=${s.willChange} transform=${s.transform.slice(0, 30)}`);
          if (promoted.length > 40) break;
        }
      }
      return {
        shellClass: shell?.className,
        bodyClass: body?.className,
        bodyStyle: body?.getAttribute('style'),
        bodyWillChange: cs(body)?.willChange,
        bodyTransform: cs(body)?.transform,
        railClass: rail?.className,
        bootOverlay: !!document.getElementById('boot-reveal'),
        bootGlow: !!document.querySelector('.boot-glow'),
        bootClassed: document.querySelectorAll('[class*="boot-"]').length,
        bootStyled: document.querySelectorAll('[style*="boot"]').length,
        cards: document.querySelectorAll('.clip-item').length,
        offscreen: document.querySelectorAll('.clip-item.cv-offscreen').length,
        animations: document.getAnimations().length,
        animationNames: document.getAnimations().slice(0, 12).map((a) => (a.animationName || a.constructor.name) + '@' + ((a.effect && a.effect.target && a.effect.target.className) || '')),
        promotedCount: promoted.length,
        promoted: promoted.slice(0, 40),
      };
    });
    console.log(JSON.stringify(info, null, 2));
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
