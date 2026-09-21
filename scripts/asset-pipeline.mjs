#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { ffmpegPath as ffmpeg } from '../main/ffmpeg-binaries.js';
import { formats, sceneIds, localOutput, validate } from './asset-pipeline/contract.mjs';
import { presets, preset } from './asset-pipeline/presets.mjs';
import { importCursorTheme } from './asset-pipeline/xcursor.mjs';
import { chooseMedia } from './asset-pipeline/media.mjs';
import { resetIsolation, isolateLayer } from './asset-pipeline/isolation.mjs';
import { previewHtml } from './asset-pipeline/review.mjs';
import { encodingArguments, flatten } from './asset-pipeline/codecs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args.shift();
const positional = [], options = {};
const preferences = JSON.parse(await fs.readFile(path.join(root,'export-out','preferences.json'),'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) positional.push(args[i]);
  else {
    const key = args[i].slice(2);
    if (!['out', 'formats', 'layers', 'scale', 'fps', 'time', 'background', 'clip', 'color', 'thumbnail', 'offset', 'cursor-theme'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error(`invalid option: ${args[i]}`);
    options[key] = args[++i];
  }
}

async function run(binary, argv) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, argv, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error(`${binary} exited ${code}: ${stderr}`)));
  });
}

async function outputDir(candidate) {
  const out = localOutput(root, candidate);
  // Real paths also catch junctions pointing outside the ignored tree.
  await fs.mkdir(path.join(root, 'export-out'), { recursive: true });
  let ancestor = out;
  while (true) {
    try { await fs.access(ancestor); break; } catch { ancestor = path.dirname(ancestor); }
  }
  const realBase = await fs.realpath(path.join(root, 'export-out'));
  const realAncestor = await fs.realpath(ancestor);
  const rel = path.relative(realBase, realAncestor);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Error('output junction leaves export-out');
  execFileSync('git', ['check-ignore', '-q', '--no-index', out], { cwd: root });
  if (execFileSync('git', ['ls-files', '--', path.relative(root, out)], { cwd: root, encoding: 'utf8' }).trim()) throw Error('output contains tracked files');
  try { await fs.mkdir(out); } catch (err) {
    if (err.code === 'ENOENT') { await fs.mkdir(path.dirname(out), { recursive: true }); await fs.mkdir(out); }
    else throw Error(`output already exists or cannot be created: ${out}`);
  }
  return out;
}

async function main() {
  if (command === 'list') {
    console.log(JSON.stringify({ version: 1, presets, scenes: sceneIds, formats, commands: ['init <preset>', 'validate <spec>', 'render <spec>'], sourceOptions:['--clip <file>', '--color #RRGGBB', '--thumbnail <file>', '--offset <seconds>', '--cursor-theme <folder>'] }, null, 2));
    return;
  }
  if (command === 'init') {
    if (!presets.includes(positional[0])) throw Error(`choose a preset: ${presets.join(', ')}`);
    const out = await outputDir(options.out ?? path.join(root, 'export-out', `${positional[0]}-${Date.now()}`));
    const thumb = path.join(out, 'demo.svg');
    await fs.writeFile(thumb, '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#102c40"/><stop offset="1" stop-color="#594888"/></linearGradient></defs><path fill="url(#g)" d="M0 0h1920v1080H0z"/><circle cx="1300" cy="320" r="150" fill="#e7c8ff"/><path d="M0 900L500 300 950 850 1500 450 1920 900v180H0" fill="#16242f"/><path d="M0 1000L700 700 1300 1000 1920 700v380H0" fill="#0a1720"/></svg>');
    const spec = preset(positional[0], thumb.replaceAll('\\', '/'));
    await chooseMedia(spec, options, out);
    if (options['cursor-theme'] ?? preferences.cursorTheme) spec.cursorTheme = await importCursorTheme(options['cursor-theme'] ?? preferences.cursorTheme, path.join(out, 'cursor'));
    validate(spec);
    await fs.writeFile(path.join(out, 'spec.json'), JSON.stringify(spec, null, 2));
    console.log(path.join(out, 'spec.json'));
    return;
  }
  if (!['render', 'validate'].includes(command) || !positional[0]) throw Error('usage: npm run assets -- list | init <preset> | validate <spec.json> | render <spec.json> [--formats png,frames,mov,webm,mp4] [--layers composite,trim,cursor] [--time seconds] [--scale 1] [--fps 30] [--background transparent|#111114] [--out export-out/name]');
  const specPath = path.resolve(positional[0]);
  const spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
  validate(spec);
  if (command === 'validate') { console.log('recipe valid'); return; }
  const selectedFormats = (options.formats ?? 'png').split(',');
  if (selectedFormats.some(x => !formats.includes(x))) throw Error(`formats: ${formats.join(', ')}`);
  const layers = spec.layers ?? { composite: null };
  const names = options.layers?.split(',') ?? Object.keys(layers);
  if (!names.length || names.some(name => !(name in layers))) throw Error('unknown layer');
  const scale = Number(options.scale ?? spec.captureScale ?? 2), fps = Number(options.fps ?? spec.timeline?.fps ?? 30), time = Number(options.time ?? 0);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4 || !Number.isInteger(fps) || fps < 1 || fps > 120 || !Number.isFinite(time) || time < 0 || time > (spec.timeline?.duration ?? 0)) throw Error('invalid scale, fps, or still time');
  const animated = selectedFormats.some(x => ['frames', 'mov', 'webm', 'mp4'].includes(x));
  if (animated && !spec.timeline) throw Error('animated exports need a timeline');
  const out = await outputDir(options.out ?? path.join(path.dirname(specPath), `render-${Date.now()}`));
  await chooseMedia(spec, options, out);
  const themePath = options['cursor-theme'] ?? (!spec.cursorTheme ? preferences.cursorTheme : undefined);
  if (themePath) spec.cursorTheme = await importCursorTheme(themePath, path.join(out, 'cursor'));
  if (options.background) spec.background = options.background;
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--force-color-profile=srgb'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: spec.viewport ?? { width: 1920, height: 1080 }, deviceScaleFactor: scale });
    page.on('pageerror', e => errors.push(e.message));
    // Assets are local by default; freeze external avatars before capture.
    await page.route(/^https?:/, route => route.abort());
    await page.addInitScript(s => { window.__EXPORT_SPEC__ = s; const NativeDate = Date; const now = s.clock ? NativeDate.parse(s.clock) : NativeDate.UTC(2026, 0, 2); window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }; }, spec);
    await page.goto(pathToFileURL(path.join(root, 'renderer-dist', 'export.html')).href);
    await page.waitForFunction(() => document.documentElement.dataset.exportReady === '1' || document.documentElement.dataset.exportError);
    const startupError = await page.evaluate(() => document.documentElement.dataset.exportError);
    if (startupError) throw Error(startupError);
    const capture = page.locator('#export-root');
    const bounds = await capture.boundingBox();
    if (!bounds || bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > page.viewportSize().width || bounds.y + bounds.height > page.viewportSize().height) throw Error('scene exceeds viewport; increase spec.viewport');
    const width = Math.round(bounds.width * scale), height = Math.round(bounds.height * scale);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color:{r:0,g:0,b:0,a:0} });
    async function captureFrame(file) {
      const result = await cdp.send('Page.captureScreenshot', { format:'png', optimizeForSpeed:true, fromSurface:true, captureBeyondViewport:true, clip:{...bounds,scale} });
      const png = Buffer.from(result.data, 'base64');
      if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) throw Error('Chromium capture dimensions differ from the requested raster size');
      await fs.writeFile(file, png);
    }
    const manifest = { version: 1, status: 'rendering', scene: spec.scene, appVersion: JSON.parse(await fs.readFile(path.join(root, 'package.json'))).version, specHash: createHash('sha256').update(JSON.stringify(spec)).digest('hex'), width, height, scale, fps, duration: animated ? spec.timeline.duration : 0, frames: animated ? Math.ceil(spec.timeline.duration * fps) : 1, stillTime: time, background: spec.background, layers, outputs: [], notes: ['All layers share a canvas and time origin.', 'MP4/JPEG flatten onto recipe background (black when transparent).', 'Backdrops and screen-blended glows may require editor blend modes.', 'Audio is not exported. Scene adapters stage UI state; they do not execute production IPC.'] };
    await fs.writeFile(path.join(out, 'spec.json'), JSON.stringify(spec, null, 2));
    const manifestPath = path.join(out, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    async function seek(seconds) {
      await page.evaluate(resetIsolation);
      await page.evaluate(async t => {
        document.getElementById('asset-isolation')?.remove();
        await window.__EXPORT_SEEK__(t);
      }, seconds);
      if (errors.length) throw Error(errors.join('\n'));
      const current = await capture.boundingBox();
      if (!current || ['x', 'y', 'width', 'height'].some(key => Math.abs(current[key] - bounds[key]) > 0.01)) throw Error('scene canvas changed during timeline; animate inside a fixed export-root');
    }
    async function isolate(layer) {
      await page.evaluate(isolateLayer, layer);
    }
    async function resetHidden() { await page.evaluate(resetIsolation); }
    const still = selectedFormats.some(x => ['png', 'jpg', 'webp'].includes(x));
    for (const name of names) await fs.mkdir(path.join(out,name));
    if (animated) {
      for (const name of names) await fs.mkdir(path.join(out,name,'frames'));
      for (let frame=0; frame<manifest.frames; frame++) {
        await seek(frame/fps);
        for (const name of names) {
          await resetHidden(); await isolate(layers[name]);
          await captureFrame(path.join(out,name,'frames',`${String(frame).padStart(6,'0')}.png`));
        }
        if (frame % (fps * 2) === 0) console.log(`captured ${frame}/${manifest.frames} frames (${names.length} layers)`);
      }
    }
    for (const name of names) {
      const dir = path.join(out, name);
      if (still) {
        await seek(time); await resetHidden(); await isolate(layers[name]);
        await captureFrame(path.join(dir,'still.png'));
        for (const format of selectedFormats.filter(x => ['png', 'jpg', 'webp'].includes(x))) {
          if (format !== 'png') await run(ffmpeg, ['-v', 'error', '-i', path.join(dir, 'still.png'), ...(format === 'jpg' ? ['-vf', flatten(spec.background)] : ['-c:v', 'libwebp', '-lossless', '1']), '-frames:v', '1', path.join(dir, `still.${format}`)]);
          manifest.outputs.push({ layer: name, format, file: `${name}/still.${format}` });
        }
      }
      if (animated) {
        const framesDir = path.join(dir, 'frames');
        manifest.outputs.push({ layer: name, format: 'frames', file: `${name}/frames/%06d.png`, alpha: true });
        for (const format of selectedFormats.filter(x => ['mp4', 'mov', 'webm'].includes(x))) {
          const encoding = encodingArguments(format,spec.background);
          await run(ffmpeg, ['-v', 'error', '-framerate', String(fps), '-i', path.join(framesDir, '%06d.png'), ...encoding, '-an', path.join(dir, `animation.${format}`)]);
          manifest.outputs.push({ layer: name, format, file: `${name}/animation.${format}`, alpha: format !== 'mp4' });
        }
      }
      console.log(`rendered ${name}`);
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    }
    manifest.status = 'complete';
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(out, 'preview.html'), previewHtml(manifest,names));
    console.log(manifestPath);
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
