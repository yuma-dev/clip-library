import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { api, av1Fixture, fixture, near, checkVideo, command } from './helpers/fixture.mjs';
import { electron } from './helpers/electron-stub.mjs';

test('exports video, audio, screenshots, speed and volume', async t => {
  const f = await fixture(t);
  await t.test('AV1 source exports a playable full h264 clip', async () => {
    const av1 = await av1Fixture(t);
    await checkVideo(av1.keep(await api.exportVideo(
      av1.name, 0, 6, 1, 1, path.join(av1.dir, 'full.mp4'), av1.settings)), 6);
  });
  const video = (name, volume = 1, speed = 1) => api.exportVideo(
    f.name, 0, 6, volume, speed, path.join(f.dir, `${name}.mp4`), f.settings);
  await t.test('default encoder exports a playable full clip', async () => {
    const result = f.keep(await video('full'));
    await checkVideo(result, 6);
    assert.ok(['h264_nvenc', 'libx264'].includes(result.encoder));
    console.log(`default export encoder: ${result.encoder}`);
  });
  await t.test('software fallback exports with libx264', async () => {
    // getNvencStatus returns its cached object, so no production hook is needed.
    const status = await api.getNvencStatus();
    const saved = { ...status };
    Object.assign(status, { available: false, reason: 'test software fallback', checkedAt: Date.now() });
    try {
      const result = f.keep(await video('software'));
      assert.equal(result.encoder, 'libx264');
      await checkVideo(result, 6);
    } finally {
      Object.assign(status, saved);
    }
  });
  await t.test('trim exports two seconds and writes the clipboard', async () => {
    const result = f.keep(await api.exportTrimmedVideo(f.name, 1, 3, 1, 1, f.settings));
    await checkVideo(result, 2);
    assert.equal(electron.clipboard.readBuffer('FileNameW').toString('ucs2'), `${result.path}\0`);
  });
  await t.test('share export stays below the Discord cap', async () => {
    const result = f.keep(await api.exportTrimmedVideoForShare(f.name, 0, 6, 1, 1, f.settings));
    await checkVideo(result, 6);
    assert.ok((await fs.stat(result.path)).size < Math.floor(9.5 * 1024 * 1024));
  });
  await t.test('audio exports as mp3', async () => {
    const result = f.keep(await api.exportAudio(f.name, 0, 6, 1, 1, path.join(f.dir, 'audio.mp3'), f.settings));
    const info = await api.ffprobeAsync(result.path);
    near(info.format.duration, 6);
    assert.equal(info.streams[0].codec_name, 'mp3');
  });
  await t.test('screenshot is a readable image', async () => {
    const output = path.join(f.dir, 'frame.png');
    await api.generateScreenshot(f.input, 2, output);
    assert.ok((await fs.stat(output)).size > 0);
    const info = await api.ffprobeAsync(output);
    assert.equal(info.streams[0].codec_name, 'png');
    assert.equal(info.streams[0].width, 640);
    assert.equal(info.streams[0].height, 360);
  });
  await t.test('speed 1.5 exports four seconds', async () => {
    await checkVideo(f.keep(await video('speed', 1, 1.5)), 4);
  });
  await t.test('volume zero exports silent audio', async () => {
    const result = f.keep(await video('silent', 0));
    await checkVideo(result, 6);
    const { stderr } = await command(['-hide_banner', '-i', result.path, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    const peak = stderr.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
    assert.ok(peak, stderr);
    assert.ok(Number(peak[1]) < -80 || peak[1] === '-inf', stderr);
  });
});
