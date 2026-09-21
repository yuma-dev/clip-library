import { require } from './electron-stub.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const run = promisify(execFile);
export const binaries = require('../../../main/ffmpeg-binaries');
export const api = require('../../../main/ffmpeg');
export const analysis = require('../../../main/audio-analysis');
export const thumbnails = require('../../../main/thumbnails');
export const root = path.resolve(import.meta.dirname, '../../..');

export async function command(args, binary = binaries.ffmpegPath) {
  return run(binary, args, { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
}

export async function fixture(t, sourceBinary = path.join(root, 'vendor/ffmpeg/ffmpeg.exe')) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplib-ffmpeg-'));
  const outputs = new Set();
  t.after(async () => {
    for (const output of outputs) await fs.rm(output, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  });
  const name = `Fixture Game ${path.basename(dir)} 12.00.00 01.01.2026.mp4`;
  const input = path.join(dir, name);
  await command(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-t', '6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', input], sourceBinary);
  await thumbnails.initThumbnailCache();
  const settings = () => ({ clipLocation: dir, exportQuality: 'discord', exportPreset: 'discord_fast',
    exportSizeGoal: 'discord_10mb', exportSpeedBias: 'fast' });
  const keep = result => {
    assert.equal(result.success, true, result.error);
    outputs.add(result.path);
    return result;
  };
  return { dir, name, input, settings, keep };
}

export function near(actual, expected, tolerance = 0.25) {
  assert.ok(Math.abs(Number(actual) - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
}

export async function checkVideo(result, duration) {
  assert.ok((await fs.stat(result.path)).size > 0);
  const info = await api.ffprobeAsync(result.path);
  near(info.format.duration, duration);
  assert.equal(info.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
  assert.equal(info.streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
  await command(['-v', 'error', '-xerror', '-i', result.path, '-map', '0', '-f', 'null', '-']);
  return info;
}

export async function prepareAnalysis(f) {
  analysis.init({ getSettings: f.settings });
  await analysis.remove(f.name);
}

export async function analyze(f, cold = true) {
  if (cold) await prepareAnalysis(f);
  return new Promise((resolve, reject) => {
    let measured;
    const timer = setTimeout(() => reject(new Error('audio analysis did not finish')), 20000);
    analysis.init({ getSettings: f.settings,
      getClipInfo: name => api.getClipInfo(name, f.settings, thumbnails),
      getClipNames: async () => [f.name],
      loudness: { record: async (_name, entry) => { measured = entry; } },
      send: (event, state) => {
        if (event === 'analysis-progress' && !state.running && state.pending === 0) {
          clearTimeout(timer);
          if (measured) resolve(measured);
          else reject(new Error('audio analysis ended without a result'));
        }
      }
    });
    analysis.enqueue(f.name, true);
  });
}
