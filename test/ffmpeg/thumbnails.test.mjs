import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { api, av1Fixture, fixture, near, recorderAv1Fixture, thumbnails } from './helpers/fixture.mjs';
import { generateLibraryThumbnail } from './helpers/thumbnail.mjs';

test('library thumbnails decode h264 and AV1 sources', { timeout: 60000 }, async t => {
  const recorder = () => {
    const input = recorderAv1Fixture();
    return { input, name: path.basename(input), settings: () => ({ clipLocation: path.dirname(input) }) };
  };
  await thumbnails.initThumbnailCache();
  for (const [codec, create, duration] of [['h264', fixture, 6], ['av1', av1Fixture, 6], ['recorder AV1 level 7.3', recorder, 0.1]]) {
    await t.test(`${codec} thumbnail has an image and metadata`, async () => {
      const f = await create(t);
      const output = await generateLibraryThumbnail(f);
      assert.equal(path.extname(output), '.jpg');
      assert.ok((await fs.stat(output)).size > 0);
      const info = await api.ffprobeAsync(output);
      assert.equal(info.streams[0].codec_name, 'mjpeg');
      assert.equal(info.streams[0].width, 640);
      assert.equal(info.streams[0].height, 360);
      const metadata = JSON.parse(await fs.readFile(`${output}.meta`, 'utf8'));
      assert.equal(metadata.clipName, f.name);
      assert.equal(metadata.startTime, 0);
      near(metadata.duration, duration, 0.01);
      assert.ok(Number.isFinite(metadata.timestamp));
    });
  }
  await t.test('AV1 screenshot is a readable image', async () => {
    const f = await av1Fixture(t);
    const output = path.join(f.dir, 'frame.png');
    await api.generateScreenshot(f.input, 3, output);
    assert.ok((await fs.stat(output)).size > 0);
    const info = await api.ffprobeAsync(output);
    assert.equal(info.streams[0].codec_name, 'png');
    assert.equal(info.streams[0].width, 640);
    assert.equal(info.streams[0].height, 360);
  });
});
