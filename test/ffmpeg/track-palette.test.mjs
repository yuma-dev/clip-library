import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { require } from './helpers/electron-stub.mjs';

const palette = require('../../../main/track-palette');

/** a fresh metadata module, its prefs cache is module state */
function freshMetadata() {
  delete require.cache[require.resolve('../../../main/metadata')];
  return require('../../../main/metadata');
}

test('every start hue keeps every pair of colors apart', () => {
  for (let start = 0; start < 360; start += 0.25) {
    const d = palette.closestPair(start);
    assert.ok(d >= palette.MIN_DIST, `start ${start}: closest pair ${d.toFixed(3)}`);
  }
  const p = palette.makePalette();
  assert.ok(palette.isPalette(p), p.join(' '));
  assert.equal(new Set(p).size, p.length);
});

test('track prefs roll the palette once and keep it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplib-palette-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const getPath = () => dir;
  const file = path.join(dir, 'trackPreferences.json');

  // two first reads at once share one roll
  let m = freshMetadata();
  const [a, b] = await Promise.all([m.getTrackPreferences(getPath), m.getTrackPreferences(getPath)]);
  const colors = a['track-palette'].colors;
  assert.ok(palette.isPalette(colors));
  assert.deepEqual(b['track-palette'].colors, colors);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8'))['track-palette'].colors, colors);

  // a user's pick sits next to it, and a later run reads the same palette back
  await m.saveTrackPreferences('Mic', { color: '#123456' }, getPath);
  m = freshMetadata();
  const again = await m.getTrackPreferences(getPath);
  assert.deepEqual(again['track-palette'].colors, colors);
  assert.equal(again.Mic.color, '#123456');

  // an older file without one gets it added, the picks stay
  await fs.writeFile(file, JSON.stringify({ Game: { hidden: true } }));
  m = freshMetadata();
  const old = await m.getTrackPreferences(getPath);
  assert.ok(palette.isPalette(old['track-palette'].colors));
  assert.equal(old.Game.hidden, true);

  // the dev reroll: new palette, saved colors gone, hidden flags kept
  await m.saveTrackPreferences('Mic', { color: '#123456' }, getPath);
  const before = old['track-palette'].colors;
  const rolled = await m.rerollTrackPalette(getPath);
  assert.ok(palette.isPalette(rolled));
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(after.Mic, undefined);
  assert.equal(after.Game.hidden, true);
  assert.deepEqual(after['track-palette'].colors, rolled);
  assert.notDeepEqual(rolled, before);

  // a file that doesn't parse is left alone
  await fs.writeFile(file, '{not json');
  m = freshMetadata();
  assert.deepEqual(await m.getTrackPreferences(getPath), {});
  assert.equal(await fs.readFile(file, 'utf8'), '{not json');
});
