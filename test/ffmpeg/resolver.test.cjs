const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function loadModule(file, stubs, globals = {}) {
  const filename = path.join(__dirname, '../..', file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename), process: {},
    require: name => name in stubs ? stubs[name] : require(name),
    ...globals
  }, { filename });
  return module.exports;
}

test('resolution prefers packaged ffmpeg and falls back to the development cache', () => {
  const resourcesPath = path.resolve('fixture-resources');
  const packaged = path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  const bundled = loadModule('main/ffmpeg-binaries.js', {
    fs: { existsSync: file => file === packaged }
  }, { process: { resourcesPath } });
  assert.equal(bundled.isBundled, true);
  assert.equal(bundled.ffmpegPath, packaged);
  assert.equal(bundled.ffprobePath, path.join(resourcesPath, 'ffmpeg', 'ffprobe.exe'));
  for (const process of [{}, { resourcesPath }]) {
    const dev = loadModule('main/ffmpeg-binaries.js', {
      fs: { existsSync: () => false }
    }, { process });
    assert.equal(dev.isBundled, false);
    assert.equal(dev.ffmpegDir, path.resolve(__dirname, '../../vendor/ffmpeg'));
  }
});

test('verification names either missing executable and reports execution failures', async () => {
  for (const missing of ['ffmpeg.exe', 'ffprobe.exe']) {
    const binaries = loadModule('main/ffmpeg-binaries.js', {
      fs: { existsSync: file => path.basename(file) !== missing }
    });
    await assert.rejects(binaries.verify(), error =>
      error.message.includes(missing) && error.message.includes('run npm run fetch-ffmpeg'));
  }
  const binaries = loadModule('main/ffmpeg-binaries.js', {
    fs: { existsSync: () => true },
    child_process: { execFile: (file, args, options, callback) => callback(new Error('invalid executable')) }
  });
  await assert.rejects(binaries.verify(), /invalid executable.*run npm run fetch-ffmpeg/);
});

test('verification returns only the version line', async () => {
  const binaries = loadModule('main/ffmpeg-binaries.js', {
    fs: { existsSync: () => true },
    child_process: { execFile: (file, args, options, callback) => {
      assert.equal(path.basename(file), 'ffmpeg.exe');
      assert.equal(args[0], '-version');
      callback(null, 'ffmpeg version n8.1\r\nbuild details\r\n');
    } }
  });
  assert.equal(await binaries.verify(), 'ffmpeg version n8.1');
});

test('directory override takes precedence over packaged binaries', () => {
  const directory = path.resolve('baseline-binaries');
  const binaries = loadModule('main/ffmpeg-binaries.js', {
    fs: { existsSync: () => true }
  }, { process: { resourcesPath: path.resolve('fixture-resources'), env: { CLIPLIB_FFMPEG_DIR: directory } } });
  assert.equal(binaries.ffmpegDir, directory);
  assert.equal(binaries.ffmpegPath, path.join(directory, 'ffmpeg.exe'));
  assert.equal(binaries.ffprobePath, path.join(directory, 'ffprobe.exe'));
});


