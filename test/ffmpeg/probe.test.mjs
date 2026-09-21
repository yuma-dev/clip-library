import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { api, av1Fixture, fixture, near, recorderAv1Fixture, thumbnails } from './helpers/fixture.mjs';

test('recorder AV1 level 7.3 clip info has no audio tracks', async () => {
  const input = recorderAv1Fixture();
  const settings = () => ({ clipLocation: path.dirname(input) });
  const info = await api.getClipInfo(path.basename(input), settings, thumbnails);
  assert.equal(info.streams.find(s => s.codec_type === 'video').codec_name, 'av1');
  assert.equal(info.streams.filter(s => s.codec_type === 'audio').length, 0);
  assert.equal(info.audioTracks.length, 0);
});

test('probes and extracts three audio tracks', async t => {
  const f = await fixture(t);
  await t.test('AV1 clip info retains three audio tracks', async () => {
    const av1 = await av1Fixture(t);
    const info = await api.getClipInfo(av1.name, av1.settings, thumbnails);
    near(info.format.duration, 6);
    assert.equal(info.streams.find(s => s.codec_type === 'video').codec_name, 'av1');
    assert.equal(info.streams.filter(s => s.codec_type === 'audio').length, 3);
  });
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
