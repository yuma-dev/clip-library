import assert from 'node:assert/strict';
import path from 'node:path';
import { api, analyze, prepareAnalysis, fixture, thumbnails, binaries } from './fixture.mjs';

export async function benchmark(t) {
  const f = await fixture(t);
  const operations = {
    exportVideo: () => api.exportVideo(f.name, 0, 6, 1, 1, path.join(f.dir, 'full.mp4'), f.settings).then(f.keep),
    exportTrimmedVideoForShare: () => api.exportTrimmedVideoForShare(f.name, 0, 6, 1, 1, f.settings).then(f.keep),
    generateScreenshot: () => api.generateScreenshot(f.input, 2, path.join(f.dir, 'frame.png')),
    ffprobeAsync: () => api.ffprobeAsync(f.input),
    getClipInfo: () => api.getClipInfo(f.name, f.settings, thumbnails),
    audioAnalysis: () => analyze(f, false)
  };
  const medians = {};
  for (const [name, operation] of Object.entries(operations)) {
    const times = [];
    for (let i = 0; i < 3; i++) {
      if (name === 'getClipInfo') await api.resetClipCache(f.name, f.settings, thumbnails);
      if (name === 'audioAnalysis') await prepareAnalysis(f);
      const start = performance.now();
      await operation();
      times.push(performance.now() - start);
    }
    medians[name] = times.sort((a, b) => a - b)[1];
    assert.ok(Number.isFinite(medians[name]));
  }
  return { medians, version: await binaries.verify(), binary: binaries.ffmpegPath };
}

if (process.argv[2] === '--worker') {
  const cleanup = [];
  try {
    const result = await benchmark({ after: callback => cleanup.push(callback) });
    console.log(`FFMPEG_BENCHMARK=${JSON.stringify(result)}`);
  } finally {
    for (const callback of cleanup.reverse()) await callback();
  }
}
