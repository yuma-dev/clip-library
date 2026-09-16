#!/usr/bin/env node
'use strict';
// Decodes every startup-sound asset the way bootSound.ts does and prints
// saved intro prefs, to tell an undecodable file apart from a prefs bug.
//
//   node benchmark/probe-sound.js [--exe PATH]

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

async function main() {
  const template = path.join(root, 'benchmark', 'profiles', 'warm-template');
  const profile = path.join(os.tmpdir(), 'cliplib-bench', 'probe-profile');
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
    await new Promise((r) => setTimeout(r, 4000));
    const oggs = fs.readdirSync(path.join(root, "renderer-dist", "assets")).filter((f) => f.endsWith(".ogg")).map((f) => `assets/${f}`);
    const result = await page.evaluate(async (rels) => {
      const out = { prefs: window.__bootIntro ? window.__bootIntro.get() : null, assets: [] };
      const ctx = new AudioContext();
      for (const rel of rels) {
        const url = new URL(rel, location.href).href;
        try {
          const buf = await fetch(url).then((r) => r.arrayBuffer());
          const decoded = await ctx.decodeAudioData(buf.slice(0));
          out.assets.push({ rel, bytes: buf.byteLength, seconds: Math.round(decoded.duration * 100) / 100, channels: decoded.numberOfChannels });
        } catch (e) {
          out.assets.push({ rel, error: String(e && e.message ? e.message : e) });
        }
      }
      await ctx.close();
      return out;
    }, oggs);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
