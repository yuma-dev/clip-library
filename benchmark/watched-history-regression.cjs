// Isolated regression: never reads the user's profile or real clip library.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

async function loadClips(profile) {
  const source = await fs.readFile(path.join(__dirname, '../main/clips.js'), 'utf8');
  const module = { exports: {} };
  const noop = () => {};
  const stubs = {
    electron: { app: { getPath: () => profile } },
    '../utils/logger': { info: noop, warn: noop, error: noop },
    './telemetry': { event: noop, KIND: {}, SEVERITY: {} },
    './thumbnails': {},
    '../utils/pool': require('../utils/pool'),
    '../utils/activity-tracker': { logActivity: noop },
  };
  vm.runInNewContext(source, {
    require: name => name in stubs ? stubs[name] : require(name),
    module, Buffer, process, setInterval, clearInterval,
  }, { filename: 'main/clips.js' });
  return module.exports;
}

test('folder switches and empty/partial scans preserve watched history across restart', async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cliplib-watched-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  await fs.writeFile(path.join(profile, 'watched-clips.json'), JSON.stringify({ watched: ['old.mp4', 'nested/seen.mov'] }));
  let clips = await loadClips(profile);
  const settings = folder => async () => ({ clipLocation: path.join(profile, folder) });
  const check = async (folder, names, expected) => {
    const result = await clips.getNewClipsInfo(settings(folder), names);
    assert.deepEqual(Array.from(result.newClips), expected);
    assert.equal(result.totalNewCount, expected.length);
  };
  await check('A', ['old.mp4', 'nested/seen.mov', 'new.mp4'], ['new.mp4']);
  await check('B', ['other.mp4'], ['other.mp4']);
  await clips.markClipsWatched(['other.mp4']);
  await check('A', [], []);
  await check('A', ['old.mp4'], []);
  clips = await loadClips(profile);
  await check('A', ['old.mp4', 'nested/seen.mov', 'new.mp4'], ['new.mp4']);
  await check('B', ['other.mp4'], []);
  // A failed directory read also must not discard history.
  await clips.getNewClipsInfo(settings('missing'));
  await check('A', ['old.mp4', 'nested/seen.mov', 'new.mp4'], ['new.mp4']);
  await clips.markClipsWatched(['new.mp4']);
  clips = await loadClips(profile);
  await check('A', ['old.mp4', 'new.mp4'], []);
});
