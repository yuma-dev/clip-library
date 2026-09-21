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

const fixtures = new WeakMap();

export function fixture(t, sourceBinary = path.join(root, 'vendor/ffmpeg/ffmpeg.exe'), codec = 'h264') {
  if (!fixtures.has(t)) fixtures.set(t, new Map());
  const cache = fixtures.get(t);
  const key = `${sourceBinary}:${codec}`;
  if (!cache.has(key)) cache.set(key, createFixture(t, sourceBinary, codec));
  return cache.get(key);
}

export const av1Fixture = t => fixture(t, undefined, 'av1');

export const recorderAv1Fixture = () => path.join(root, 'test/ffmpeg/fixtures/clipdip-av1-level73.mp4');

async function createFixture(t, sourceBinary, codec) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplib-ffmpeg-'));
  const outputs = new Set();
  t.after(async () => {
    for (const output of outputs) await fs.rm(output, { force: true });
    await fs.rm(dir, { recursive: true, force: true });
  });
  const name = `Fixture Game ${path.basename(dir)} 12.00.00 01.01.2026.mp4`;
  const input = path.join(dir, name);
  const inputs = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-t', '6'];
  const encode = (encoder, preset) => command([...inputs,
    '-c:v', encoder, '-preset', preset, '-threads', '2', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', input], sourceBinary);
  let encoder = codec === 'av1' ? 'av1_nvenc' : 'libx264';
  try {
    await encode(encoder, codec === 'av1' ? 'p1' : 'ultrafast');
  } catch (error) {
    if (codec !== 'av1' || !/Unknown encoder|Cannot load|No capable devices|unsupported device|does not support|not supported|minimum required|Driver does not support|OpenEncodeSessionEx failed/i.test(error.stderr || '')) throw error;
    encoder = 'libsvtav1';
    console.log('AV1 fixture: libsvtav1 fallback; NVENC bitstream case is not covered on this machine.');
    await encode(encoder, '12');
  }
  if (codec === 'av1' && encoder === 'av1_nvenc') console.log('AV1 fixture: av1_nvenc -preset p1');
  await thumbnails.initThumbnailCache();
  const settings = () => ({ clipLocation: dir, exportQuality: 'discord', exportPreset: 'discord_fast',
    exportSizeGoal: 'discord_10mb', exportSpeedBias: 'fast' });
  const keep = result => {
    assert.equal(result.success, true, result.error);
    outputs.add(result.path);
    return result;
  };
  return { dir, name, input, settings, keep, encoder };
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
