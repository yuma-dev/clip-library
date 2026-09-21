import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, fixture, near, thumbnails } from './helpers/fixture.mjs';

test('probes and extracts three audio tracks', async t => {
  const f = await fixture(t);
  for (const info of [await api.ffprobeAsync(f.input), await api.getClipInfo(f.name, f.settings, thumbnails)]) {
    near(info.format.duration, 6);
    const video = info.streams.filter(s => s.codec_type === 'video');
    assert.equal(video.length, 1);
    assert.equal(video[0].width, 1280);
    assert.equal(video[0].height, 720);
    assert.equal(info.streams.filter(s => s.codec_type === 'audio').length, 3);
  }
  const tracks = await api.extractAudioTracks(f.name, f.settings, thumbnails);
  assert.equal(tracks.length, 3);
  assert.equal(new Set(tracks.map(track => track.path)).size, 3);
  for (const track of tracks) {
    const info = await api.ffprobeAsync(track.path);
    near(info.format.duration, 6);
    assert.equal(info.streams.length, 1);
    assert.equal(info.streams[0].codec_name, 'aac');
  }
});
