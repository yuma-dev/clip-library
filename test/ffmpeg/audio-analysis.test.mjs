import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, analyze } from './helpers/fixture.mjs';

test('audio analysis measures sine tracks and silence', async t => {
  const entry = await analyze(await fixture(t));
  assert.equal(entry.tracks.length, 3);
  assert.ok(Number.isFinite(entry.loudness.lufs));
  assert.ok(Number.isFinite(entry.loudness.peak));
  assert.equal(entry.loudness.mode, 'sum');
  for (const track of entry.tracks) {
    for (const field of ['peak', 'rms']) {
      assert.ok(track[field].length >= 59);
      assert.ok(track[field].every(Number.isFinite));
    }
  }
  for (const field of ['peak', 'rms']) {
    const silent = Math.max(...entry.tracks[2][field]);
    assert.ok(silent <= -80);
    for (const sine of entry.tracks.slice(0, 2)) assert.ok(Math.max(...sine[field]) > silent + 40);
  }
});
