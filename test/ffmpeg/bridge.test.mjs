import { test } from 'node:test';
import assert from 'node:assert/strict';
import { require } from './helpers/electron-stub.mjs';

test('recorder migration replaces managed paths and preserves existing user overrides', () => {
  const { writtenByClipLib, pickFfmpegPath } = require('../../../main/clipdip');
  const target = 'C:\\ClipLib\\resources\\ffmpeg\\ffmpeg.exe';
  for (const current of [
    'C:\\old\\node_modules\\ffmpeg-static\\ffmpeg.exe',
    'C:\\old\\ffmpeg-cache\\ffmpeg.exe',
    'C:\\old\\resources\\clipdip\\ffmpeg.exe',
    'C:\\old\\resources\\ffmpeg\\ffmpeg.exe',
    'G:/repo/VENDOR/FFMPEG/ffmpeg.exe'
  ]) {
    assert.equal(writtenByClipLib(current), true);
    assert.equal(pickFfmpegPath({ current, target, exists: () => true }), target);
  }
  const custom = 'C:\\tools\\ffmpeg.exe';
  assert.equal(writtenByClipLib(custom), false);
  assert.equal(pickFfmpegPath({ current: custom, target, exists: () => true }), custom);
  assert.equal(pickFfmpegPath({ current: custom, target, exists: () => false }), target);
  for (const current of [undefined, null, '', target]) {
    assert.equal(pickFfmpegPath({ current, target, exists: () => { throw Error('unexpected lookup'); } }), target);
  }
});

