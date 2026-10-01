import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { require } from './helpers/electron-stub.mjs';
import { api, binaries, command, fixture, near, run } from './helpers/fixture.mjs';

const layers = require('../../../main/layers');
const { buildTimeMap } = require('../../../main/layer-export');

const mediaDir = (f) => path.join(f.dir, '.clip_metadata', 'layers_media', f.name);

/** peak dB of the audio between from and to, after an optional filter */
async function peak(file, from, to, filter = 'anull') {
  const { stderr } = await command(['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn',
    '-af', `${filter},volumedetect`, '-f', 'null', '-']);
  const m = stderr.match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  assert.ok(m, stderr);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

/** raw rgb of a whole frame at t, scaled to 64x36 */
async function frame(file, t) {
  const { stdout } = await run(binaries.ffmpegPath, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { encoding: 'buffer', windowsHide: true, timeout: 60000 });
  return stdout;
}

/** biggest step between neighbouring pixels on a row across the yellow to blue bar edge at x 640 */
async function edge(file, t) {
  const { stdout } = await run(binaries.ffmpegPath, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', 'crop=48:2:616:300', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
  { encoding: 'buffer', windowsHide: true, timeout: 60000 });
  let max = 0;
  // the first of the two rows, yuv420 can't crop to one
  for (let i = 3; i < 48 * 3; i += 3) max = Math.max(max, Math.abs(stdout[i + 2] - stdout[i - 1]));
  return max;
}

const diff = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
};

test('time map: speed layers multiply and map both ways past the edges', () => {
  const m = buildTimeMap([
    { kind: 'speed', start: 2, end: 4, rate: 0.5 },
    { kind: 'speed', start: 3, end: 5, rate: 2 },
  ], 1, 5, 1);
  // relative: 0-1 @1, 1-2 @0.5, 2-3 @1 (0.5 * 2), 3-4 @2, 4-5 @1
  near(m.outDur, 1 + 2 + 1 + 0.5 + 1, 0.001);
  near(m.out(1.5), 2, 0.001);
  near(m.out(-1), -1, 0.001);
  assert.equal(m.segmented, true);
  assert.equal(buildTimeMap([], 0, 4, 2).segmented, false);
  near(buildTimeMap([], 0, 4, 2).outDur, 2, 0.001);
});

test('zoom, blur, speed and sound layers export', async (t) => {
  const f = await fixture(t);
  const media = mediaDir(f);
  await fs.mkdir(media, { recursive: true });
  const beep = path.join(media, 'snd-beep.wav');
  // every save drops media no layer points at, so each part writes its own beep
  const makeBeep = async () => {
    await fs.mkdir(media, { recursive: true });
    await command(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=3000:sample_rate=48000:duration=1', beep]);
  };
  const highs = 'highpass=f=2000:poles=2,highpass=f=2000:poles=2';

  await t.test('speed layers change the length, video and audio alike', async () => {
    await layers.saveLayers(f.name, [{ id: 's', kind: 'speed', start: 1, end: 3, rate: 0.5 }], f.settings);
    const result = f.keep(await api.exportVideo(f.name, 0, 6, 1, 1, path.join(f.dir, 'speed.mp4'), f.settings));
    const info = await api.ffprobeAsync(result.path);
    near(info.format.duration, 8, 0.3);
    for (const s of info.streams) near(Number(s.duration), 8, 0.3);
  });

  await t.test('a sound plays at its mapped time on a single-stream mix', async () => {
    await makeBeep();
    await layers.saveLayers(f.name, [
      { id: 's', kind: 'speed', start: 0, end: 2, rate: 2 },
      { id: 'b', kind: 'sound', start: 3, end: 4, file: beep, name: 'beep', level: 1, fade: 0, duration: 1 },
    ], f.settings);
    // 0-2 at 2x is one second, so the sound starts at 2 s of output
    const result = f.keep(await api.exportVideo(f.name, 0, 6, 1, 1, path.join(f.dir, 'sound.mp4'), f.settings));
    near((await api.ffprobeAsync(result.path)).format.duration, 5, 0.3);
    const inside = await peak(result.path, 2.2, 2.8, highs);
    const before = await peak(result.path, 0.2, 1.7, highs);
    assert.ok(inside > -20, `beep inside its window, ${inside} dB`);
    assert.ok(inside - before > 15, `no beep before it, ${before} dB vs ${inside} dB`);
  });

  await t.test('a sound is mixed into a multi-track export and an mp3', async () => {
    await makeBeep();
    await layers.saveLayers(f.name, [{ id: 'b', kind: 'sound', start: 1, end: 2, file: beep, name: 'beep', level: 1, fade: 0.1, duration: 1 }], f.settings);
    const audioMix = [
      { streamIndex: 1, ordinal: 0, volume: 1 },
      { streamIndex: 2, ordinal: 1, volume: 1 },
    ];
    const video = f.keep(await api.exportVideo(f.name, 0, 4, 1, 1, path.join(f.dir, 'mix.mp4'), f.settings, null, { audioMix }));
    assert.ok((await peak(video.path, 1.2, 1.8, highs)) > -20, 'beep in the video');
    const audio = f.keep(await api.exportAudio(f.name, 0, 4, 1, 1, path.join(f.dir, 'mix.mp3'), f.settings));
    const mp3 = await peak(audio.path, 1.2, 1.8, highs);
    const quiet = await peak(audio.path, 2.5, 3.5, highs);
    assert.ok(mp3 - quiet > 15, `beep in the mp3, ${mp3} dB vs ${quiet} dB after it`);
  });

  await t.test('a sound still plays with every track muted', async () => {
    await makeBeep();
    await layers.saveLayers(f.name, [{ id: 'b', kind: 'sound', start: 1, end: 2, file: beep, name: 'beep', level: 1, fade: 0, duration: 1 }], f.settings);
    const video = f.keep(await api.exportVideo(f.name, 0, 4, 1, 1, path.join(f.dir, 'muted.mp4'), f.settings, null, { audioMix: [] }));
    near((await api.ffprobeAsync(video.path)).format.duration, 4, 0.3);
    // the bed is stereo, the mono beep loses 3 dB to the upmix
    assert.ok((await peak(video.path, 1.2, 1.8, highs)) > -24, 'beep over the muted tracks');
    assert.ok((await peak(video.path, 2.5, 3.5)) < -60, 'silence after the beep');
    const audio = f.keep(await api.exportAudio(f.name, 0, 4, 1, 1, path.join(f.dir, 'muted.mp3'), f.settings, { audioMix: [] }));
    assert.ok((await peak(audio.path, 1.2, 1.8, highs)) > -24, 'beep in the mp3');
  });

  await t.test('a sound plays on a clip without an audio stream', async () => {
    const name = `Silent ${f.name}`;
    await command(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '4',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(f.dir, name)]);
    const silentMedia = path.join(f.dir, '.clip_metadata', 'layers_media', name);
    await fs.mkdir(silentMedia, { recursive: true });
    const file = path.join(silentMedia, 'snd-beep.wav');
    await command(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=3000:sample_rate=48000:duration=1', file]);
    await layers.saveLayers(name, [{ id: 'b', kind: 'sound', start: 1, end: 2, file, name: 'beep', level: 1, fade: 0, duration: 1 }], f.settings);
    const video = f.keep(await api.exportVideo(name, 0, 4, 1, 1, path.join(f.dir, 'silent.mp4'), f.settings));
    const info = await api.ffprobeAsync(video.path);
    near(info.format.duration, 4, 0.3);
    assert.ok(info.streams.some((s) => s.codec_type === 'audio'), 'an audio stream for the sound');
    assert.ok((await peak(video.path, 1.2, 1.8, highs)) > -24, 'beep in the video');
    const audio = f.keep(await api.exportAudio(name, 0, 4, 1, 1, path.join(f.dir, 'silent.mp3'), f.settings));
    assert.ok((await peak(audio.path, 1.2, 1.8, highs)) > -24, 'beep in the mp3');
  });

  await t.test('zoom and blur change the picture only inside their time', async () => {
    const plain = f.keep(await (async () => {
      await layers.saveLayers(f.name, [], f.settings);
      return api.exportVideo(f.name, 0, 6, 1, 1, path.join(f.dir, 'plain.mp4'), f.settings);
    })());
    await layers.saveLayers(f.name, [
      { id: 'z', kind: 'zoom', start: 1, end: 2.5, x: 30, y: 30, scale: 2, ease: 0.2 },
      { id: 'b', kind: 'blur', start: 3, end: 4, x: 50, y: 50, w: 60, h: 60, mode: 'blur', strength: 0.8 },
      { id: 'p', kind: 'blur', start: 4.5, end: 5.5, x: 50, y: 50, w: 60, h: 60, mode: 'pixelate', strength: 0.5 },
    ], f.settings);
    const fxd = f.keep(await api.exportVideo(f.name, 0, 6, 1, 1, path.join(f.dir, 'fx.mp4'), f.settings));
    near((await api.ffprobeAsync(fxd.path)).format.duration, 6, 0.3);
    const same = diff(await frame(plain.path, 0.5), await frame(fxd.path, 0.5));
    const zoomed = diff(await frame(plain.path, 1.8), await frame(fxd.path, 1.8));
    const pixel = diff(await frame(plain.path, 5), await frame(fxd.path, 5));
    assert.ok(same < 2, `same before the zoom, ${same}`);
    assert.ok(zoomed > 12, `zoomed in, ${zoomed}`);
    const sharp = await edge(plain.path, 3.5);
    assert.ok(sharp > 150, `the bar edge is sharp without blur, ${sharp}`);
    const soft = await edge(fxd.path, 3.5);
    assert.ok(soft < sharp / 3, `blurred edge ${soft} vs ${sharp}`);
    assert.ok(pixel > same * 3 + 1, `pixelated, ${pixel}`);
  });

  await t.test('zoom keys move the view and hold it at each key', async () => {
    // ease 0 so the static pair cuts at 2 s instead of easing through it
    await layers.saveLayers(f.name, [
      { id: 'a', kind: 'zoom', start: 1, end: 2, x: 25, y: 25, scale: 2, ease: 0 },
      { id: 'b', kind: 'zoom', start: 2, end: 3, x: 75, y: 70, scale: 3, ease: 0 },
    ], f.settings);
    const held = f.keep(await api.exportVideo(f.name, 0, 4, 1, 1, path.join(f.dir, 'zoom-held.mp4'), f.settings));
    await layers.saveLayers(f.name, [
      { id: 'k', kind: 'zoom', start: 1, end: 3, x: 50, y: 50, scale: 1.6, ease: 0, keys: [
        { t: 0.3, x: 25, y: 25, scale: 2 },
        { t: 1.7, x: 75, y: 70, scale: 3 },
      ] },
    ], f.settings);
    const keyed = f.keep(await api.exportVideo(f.name, 0, 4, 1, 1, path.join(f.dir, 'zoom-keyed.mp4'), f.settings));
    const first = diff(await frame(held.path, 1.2), await frame(keyed.path, 1.2));
    const last = diff(await frame(held.path, 2.8), await frame(keyed.path, 2.8));
    const between = diff(await frame(held.path, 1.9), await frame(keyed.path, 1.9));
    assert.ok(first < 2, `first key's view held before it, ${first}`);
    assert.ok(last < 2, `last key's view held after it, ${last}`);
    assert.ok(between > first * 3 + 1, `moving between the keys, ${between}`);
  });

  await t.test('an image follows a zoom it sticks to, and stays put when it does not', async () => {
    const red = path.join(media, 'img-red.png');
    const zoomed = async (follow, out) => {
      await fs.mkdir(media, { recursive: true });
      await command(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', red]);
      await layers.saveLayers(f.name, [
        { id: 'i', kind: 'image', start: 0, end: 4, x: 30, y: 30, w: 8, aspect: 1, file: red, ain: 'none', aout: 'none' },
        { id: 'z', kind: 'zoom', start: 0.5, end: 3.5, x: 30, y: 30, scale: 2, ease: 0, follow },
      ], f.settings);
      return f.keep(await api.exportVideo(f.name, 0, 4, 1, 1, path.join(f.dir, out), f.settings));
    };
    // rgb at a spot of a 320x180 frame
    const px = (buf, x, y) => [...buf.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
    const isRed = ([r, g, b]) => r > 180 && g < 80 && b < 80;
    const stuck = await frame((await zoomed(['media'], 'zoom-img-stuck.mp4')).path, 2);
    const kept = await frame((await zoomed([], 'zoom-img-kept.mp4')).path, 2);
    // zooming 2x on 30%,30% brings that spot to the middle and doubles the image, 8% becomes 16%
    assert.ok(isRed(px(stuck, 160, 90)), `stuck image in the middle, ${px(stuck, 160, 90)}`);
    assert.ok(isRed(px(stuck, 160 + 20, 90)), `and twice as wide, ${px(stuck, 180, 90)}`);
    assert.ok(isRed(px(kept, 96, 54)), `kept image where it was, ${px(kept, 96, 54)}`);
    assert.ok(!isRed(px(kept, 160, 90)), 'kept image not moved to the middle');

    // half speed over the first 2 s: output 0.8 is source 0.4, before the zoom; output 1.4 is 0.7, in it
    await fs.mkdir(media, { recursive: true });
    await command(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64', '-frames:v', '1', red]);
    await layers.saveLayers(f.name, [
      { id: 's', kind: 'speed', start: 0, end: 2, rate: 0.5 },
      { id: 'i', kind: 'image', start: 0, end: 4, x: 30, y: 30, w: 8, aspect: 1, file: red, ain: 'none', aout: 'none' },
      { id: 'z', kind: 'zoom', start: 0.5, end: 3.5, x: 30, y: 30, scale: 2, ease: 0 },
    ], f.settings);
    const slow = f.keep(await api.exportVideo(f.name, 0, 4, 1, 1, path.join(f.dir, 'zoom-img-slow.mp4'), f.settings));
    const before = await frame(slow.path, 0.8);
    const during = await frame(slow.path, 1.4);
    assert.ok(isRed(px(before, 96, 54)) && !isRed(px(before, 160, 90)), `not zoomed yet at 0.8 s, ${px(before, 160, 90)}`);
    assert.ok(isRed(px(during, 160, 90)), `zoomed at 1.4 s, ${px(during, 160, 90)}`);
  });

  await t.test('sounds slow down with a speed layer unless it leaves them alone', async () => {
    const run = async (sounds, out) => {
      await makeBeep();
      await layers.saveLayers(f.name, [
        { id: 's', kind: 'speed', start: 1, end: 4, rate: 0.5, sounds },
        { id: 'b', kind: 'sound', start: 1, end: 4, file: beep, name: 'beep', level: 1, fade: 0, duration: 1 },
      ], f.settings);
      return f.keep(await api.exportVideo(f.name, 0, 5, 1, 1, path.join(f.dir, out), f.settings));
    };
    // the one second beep starts at 1 s of output; at half speed it runs to 3 s, left alone to 2 s
    const slowed = await run(true, 'snd-slowed.mp4');
    const normal = await run(false, 'snd-normal.mp4');
    const late = { slowed: await peak(slowed.path, 2.3, 2.8, highs), normal: await peak(normal.path, 2.3, 2.8, highs) };
    const early = await peak(normal.path, 1.2, 1.8, highs);
    assert.ok(late.slowed > -20, `slowed beep still playing at 2.5 s, ${late.slowed} dB`);
    assert.ok(early - late.normal > 15, `normal beep over by 2.5 s, ${late.normal} dB vs ${early} dB`);
  });

  await t.test('undo keeps media alive, paste copies it from another clip', async () => {
    await makeBeep();
    await layers.saveLayers(f.name, [], f.settings, [beep]);
    await fs.access(beep);
    const other = `Other ${f.name}`;
    await fs.copyFile(f.input, path.join(f.dir, other));
    const { file } = await layers.copyMedia(other, beep, f.settings);
    assert.notEqual(file, beep);
    await fs.access(file);
    await assert.rejects(layers.copyMedia(other, f.input, f.settings));
    await layers.saveLayers(f.name, [], f.settings);
    await assert.rejects(fs.access(beep));
  });
});
