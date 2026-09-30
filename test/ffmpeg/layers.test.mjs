import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { require } from './helpers/electron-stub.mjs';
import { api, binaries, command, fixture, run } from './helpers/fixture.mjs';

const layers = require('../../../main/layers');

const mediaDir = (f) => path.join(f.dir, '.clip_metadata', 'layers_media', f.name);

/** mean rgb of a 4x4 patch at x,y (px) of the frame at t */
async function pixel(file, t, x, y) {
  const { stdout } = await run(binaries.ffmpegPath, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `crop=4:4:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { encoding: 'buffer', windowsHide: true, timeout: 60000 });
  return [...stdout.subarray(0, 3)];
}

/** peak dB of the audio between from and to, after an optional filter */
async function peak(file, from, to, filter = 'anull') {
  const { stderr } = await command(['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn',
    '-af', `${filter},volumedetect`, '-f', 'null', '-']);
  const m = stderr.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  assert.ok(m, stderr);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

test('layers burn into exports and shape the audio', async (t) => {
  const f = await fixture(t);
  const media = mediaDir(f);
  await fs.mkdir(media, { recursive: true });
  const png = path.join(media, 'img-red.png');
  const gif = path.join(media, 'gif-blue.gif');
  await command(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=200x100', '-frames:v', '1', '-update', '1', png]);
  await command(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=100x100:r=10:d=0.5', gif]);

  await t.test('image, gif and an all-tracks mute', async () => {
    const saved = await layers.saveLayers(f.name, [
      { id: 'img', kind: 'image', start: 1, end: 3, x: 25, y: 25, w: 20, file: png, aspect: 2, ain: 'none', aout: 'none' },
      { id: 'gif', kind: 'gif', start: 3.5, end: 5.5, x: 75, y: 75, w: 10, file: gif, aspect: 1, ain: 'pop', aout: 'fade', gif: { id: 'blue', title: '', url: '' } },
      { id: 'mute', kind: 'volume', start: 2, end: 4, track: 'all', level: 0, fade: 0 },
    ], f.settings);
    assert.equal(saved.success, true, saved.error);
    const result = f.keep(await api.exportVideo(f.name, 0, 6, 1, 1, path.join(f.dir, 'layers.mp4'), f.settings));

    const [r, g, b] = await pixel(result.path, 2, 318, 178);
    assert.ok(r > 200 && g < 60 && b < 60, `image should be red at 2s, got ${[r, g, b]}`);
    const after = await pixel(result.path, 4.5, 318, 178);
    assert.ok(!(after[0] > 200 && after[1] < 60 && after[2] < 60), `image should be gone at 4.5s, got ${after}`);
    const [br, bg, bb] = await pixel(result.path, 4.5, 958, 538);
    assert.ok(bb > 180 && br < 60 && bg < 60, `gif should be blue at 4.5s, got ${[br, bg, bb]}`);

    assert.ok((await peak(result.path, 0.2, 1.8)) > -30, 'loud before the mute');
    assert.ok((await peak(result.path, 2.2, 3.8)) < -60, 'silent inside the mute');
  });

  await t.test('every show and hide animation builds a working graph', async () => {
    const anims = ['fade', 'pop', 'zoom', 'slide', 'drop', 'side', 'wipe'];
    const items = anims.map((a, i) => ({
      id: `a${i}`, kind: 'image', start: 0.3 + i * 0.7, end: 1.2 + i * 0.7, x: 20 + i * 10, y: 50, w: 8, file: png, aspect: 2,
      ain: a, aout: anims[(i + 3) % anims.length],
      // the details: own animation lengths and a see-through layer
      ...(i % 2 ? { din: 0.6, dout: 0.15, opacity: 0.5 } : {}),
    }));
    const saved = await layers.saveLayers(f.name, items, f.settings);
    assert.equal(saved.success, true, saved.error);
    // speed 1.5 on a middle trim moves every animation off the source clock
    f.keep(await api.exportVideo(f.name, 0.5, 5.5, 1, 1.5, path.join(f.dir, 'anims.mp4'), f.settings));
  });

  await t.test('a per-track layer only touches its track', async () => {
    // fixture streams: 1 = 440 Hz, 2 = 880 Hz; the 880 one is muted from 2 to 4
    await layers.saveLayers(f.name, [{ id: 'hi', kind: 'volume', start: 2, end: 4, track: 1, level: 0, fade: 0 }], f.settings);
    const audioMix = [
      { streamIndex: 1, ordinal: 0, volume: 1 },
      { streamIndex: 2, ordinal: 1, volume: 1 },
    ];
    const result = f.keep(await api.exportVideo(f.name, 0, 6, 1, 1, path.join(f.dir, 'track.mp4'), f.settings, null, { audioMix }));
    const highs = 'highpass=f=700:poles=2,highpass=f=700:poles=2';
    assert.ok((await peak(result.path, 0.2, 1.8, highs)) > -25, '880 Hz before');
    assert.ok((await peak(result.path, 2.3, 3.7, highs)) < -30, '880 Hz muted');
    assert.ok((await peak(result.path, 2.3, 3.7)) > -20, '440 Hz still plays');
  });

  await t.test('an old volume range becomes a layer and is dropped on save', async () => {
    await layers.saveLayers(f.name, [], f.settings);
    const legacy = path.join(f.dir, '.clip_metadata', `${f.name}.volumerange`);
    await fs.writeFile(legacy, JSON.stringify({ start: 1, end: 2, level: 0.3 }));
    const { items } = await layers.getLayers(f.name, f.settings);
    assert.deepEqual(items.map((l) => [l.kind, l.track, l.level]), [['volume', 'all', 0.3]]);
    await layers.saveLayers(f.name, items, f.settings);
    await assert.rejects(fs.access(legacy));
  });

  await t.test('media nothing points at is removed', async () => {
    await layers.saveLayers(f.name, [], f.settings);
    await assert.rejects(fs.access(png));
    await assert.rejects(fs.access(gif));
  });
});
