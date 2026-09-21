import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { FFMPEG_VERSION, DEFAULT_URL, fetchFfmpeg } from '../../scripts/fetch-ffmpeg.mjs';
import { binaries } from './helpers/fixture.mjs';

test('download pin matches attribution and the cached executable', async () => {
  assert.equal(typeof fetchFfmpeg, 'function');
  assert.ok(DEFAULT_URL.includes(FFMPEG_VERSION));
  assert.ok(DEFAULT_URL.endsWith('.zip'));
  const attribution = await fs.readFile(new URL('../../vendor/ffmpeg/ATTRIBUTION.txt', import.meta.url), 'utf8');
  assert.ok(attribution.includes(FFMPEG_VERSION));
  assert.equal((await binaries.verify()).match(/^ffmpeg version n?([^\s-]+)/)[1], FFMPEG_VERSION);
});
