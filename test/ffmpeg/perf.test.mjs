import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, root } from './helpers/fixture.mjs';

test('prints median timings for three runs per operation', async t => {
  async function measure(directory) {
    const { stdout } = await run(process.execPath, [fileURLToPath(new URL('./helpers/benchmark.mjs', import.meta.url)), '--worker'], {
      env: { ...process.env, CLIPLIB_FFMPEG_DIR: directory },
      windowsHide: true, timeout: 110000, maxBuffer: 8 * 1024 * 1024
    });
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('FFMPEG_BENCHMARK='));
    assert.ok(line, stdout);
    return JSON.parse(line.slice('FFMPEG_BENCHMARK='.length));
  }
  const bundled = await measure(path.join(root, 'vendor', 'ffmpeg'));
  let baseline;
  if (process.env.CLIPLIB_FFMPEG_BASELINE) {
    const binary = path.resolve(process.env.CLIPLIB_FFMPEG_BASELINE);
    const probe = process.env.CLIPLIB_FFPROBE_BASELINE || path.join(path.dirname(binary), 'ffprobe.exe');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplib-ffmpeg-baseline-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    // copies allow an independently located ffprobe without adding another resolver override.
    await fs.copyFile(binary, path.join(directory, 'ffmpeg.exe'));
    await fs.copyFile(probe, path.join(directory, 'ffprobe.exe'));
    baseline = await measure(directory);
  }
  console.log(`bundled: ${bundled.version}`);
  console.log(`AV1 benchmark fixture encoder: ${bundled.av1Encoder}`);
  if (baseline) console.log(`baseline: ${baseline.version}`);
  else console.log('baseline: not configured (CLIPLIB_FFMPEG_BASELINE)');
  console.log('operation                       bundled ms  baseline ms  bundled/baseline');
  for (const [name, ms] of Object.entries(bundled.medians)) {
    const previous = baseline?.medians[name];
    console.log(`${name.padEnd(31)} ${ms.toFixed(1).padStart(10)}  ${previous == null ? 'n/a'.padStart(11) : previous.toFixed(1).padStart(11)}  ${previous == null ? 'n/a' : (ms / previous).toFixed(2)}`);
  }
});
