import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { av1Fixture, binaries, command, recorderAv1Fixture, root } from './helpers/fixture.mjs';

test('bundled binaries expose the required codecs', async t => {
  const version = await binaries.verify();
  assert.match(version, /^ffmpeg version /);
  assert.ok(Number(version.match(/^ffmpeg version n?(\d+)/)[1]) >= 7);
  assert.match((await command(['-version'], binaries.ffprobePath)).stdout, /^ffprobe version /);
  assert.equal(binaries.isBundled, false);
  assert.equal(binaries.ffmpegDir, path.join(root, 'vendor', 'ffmpeg'));
  for (const file of [binaries.ffmpegPath, binaries.ffprobePath]) assert.ok((await fs.stat(file)).isFile());
  const encoders = (await command(['-hide_banner', '-encoders'])).stdout;
  for (const name of ['libx264', 'aac', 'aac_mf', 'libmp3lame', 'h264_nvenc']) {
    assert.match(encoders, new RegExp(`\\s${name}\\s`));
  }
  const decoders = (await command(['-hide_banner', '-decoders'])).stdout;
  assert.match(decoders, /\sh264\s/);
  assert.match(decoders, /\slibdav1d\s/, 'bundled FFmpeg must include libdav1d for recorder AV1 thumbnails');
  const f = await av1Fixture(t);
  await command(['-ss', '3', '-i', f.input, '-frames:v', '1', '-f', 'null', '-']);
});

test('recorder AV1 level 7.3 decodes without hardware acceleration', async () => {
  // libaom rejects level 7.3 headers; libdav1d is what makes this pass.
  const { stderr } = await command(['-i', recorderAv1Fixture(), '-frames:v', '1', '-f', 'null', '-']);
  assert.doesNotMatch(stderr, /Bitstream not supported/i);
});
