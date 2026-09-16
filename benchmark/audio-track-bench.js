/**
 * Comparison benchmarks for single vs multi-audio-track clips, targeting the
 * regression from when multi-track support landed: sustained playback CPU
 * openClip phase breakdown (window.__benchmarkLastOpenTimings), seek-burst
 * latency/CPU, heap/RSS on open.
 *
 * Each benchmark returns a `{ single, multi }` pair for a side-by-side print.
 *
 * Clip selection is automatic via ffprobe (get-clip-info): first clip with
 * <=1 audio track is "single", first with >=2 is "multi". A missing side is
 * reported, not a failure.
 */

'use strict';

const { ipcRenderer } = require('electron');

const DEFAULT_PROBE_LIMIT = 40;

function basename(p) {
  if (!p) return '';
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * --single/--multi runner flags arrive here as env vars (set by runner.js
 * before spawning Electron). Resolves a pin string (filename or full path)
 * against `allClips`.
 */
async function resolvePinnedClip(pinStr, allClips) {
  if (!pinStr) return null;
  const wanted = basename(pinStr).toLowerCase();
  const match = allClips.find((c) => basename(c.originalName).toLowerCase() === wanted);
  if (!match) {
    console.warn(`[bench] pinned clip not found in library: ${pinStr}`);
    return null;
  }
  try {
    const info = await ipcRenderer.invoke('get-clip-info', match.originalName);
    const trackCount = Array.isArray(info?.audioTracks) ? info.audioTracks.length : 0;
    return {
      originalName: match.originalName,
      customName: match.customName,
      audioTrackCount: trackCount,
      duration: info?.format?.duration || null,
      pinned: true
    };
  } catch (err) {
    console.warn(`[bench] failed to probe pinned clip ${pinStr}: ${err.message}`);
    return null;
  }
}

/**
 * Walks `allClips`, ffprobing each until both a single- and multi-track
 * example are found (or `limit` hit). Honors BENCH_SINGLE_CLIP/BENCH_MULTI_CLIP
 * env vars (--single/--multi); a pinned clip is used as-is, overriding
 * auto-detection.
 */
async function categorizeClips(allClipsGetter, limit = DEFAULT_PROBE_LIMIT) {
  const allClips = typeof allClipsGetter === 'function' ? allClipsGetter() : allClipsGetter;
  if (!Array.isArray(allClips) || allClips.length === 0) {
    return { single: null, multi: null, probed: 0 };
  }
  const singlePin = process.env.BENCH_SINGLE_CLIP;
  const multiPin = process.env.BENCH_MULTI_CLIP;
  let single = await resolvePinnedClip(singlePin, allClips);
  let multi = await resolvePinnedClip(multiPin, allClips);
  let probed = (single ? 1 : 0) + (multi ? 1 : 0);

  if (single && multi) return { single, multi, probed };

  const max = Math.min(limit, allClips.length);
  for (let i = 0; i < max && (!single || !multi); i++) {
    const clip = allClips[i];
    // Don't double-count the pinned clip.
    if ((single && clip.originalName === single.originalName) ||
        (multi && clip.originalName === multi.originalName)) continue;
    probed++;
    try {
      const info = await ipcRenderer.invoke('get-clip-info', clip.originalName);
      const trackCount = Array.isArray(info?.audioTracks) ? info.audioTracks.length : 0;
      const record = {
        originalName: clip.originalName,
        customName: clip.customName,
        audioTrackCount: trackCount,
        duration: info?.format?.duration || null
      };
      if (trackCount >= 2 && !multi) multi = record;
      else if (trackCount <= 1 && !single) single = record;
    } catch (_) {
      // Skip clips that fail to probe.
    }
  }
  return { single, multi, probed };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForVideoReady(video, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (video.readyState >= 2) return;
    await delay(50);
  }
  throw new Error('Video readyState never reached HAVE_CURRENT_DATA');
}

function getMem() {
  if (typeof process !== 'undefined' && process.memoryUsage) {
    const m = process.memoryUsage();
    return { heap: m.heapUsed, rss: m.rss };
  }
  if (typeof performance !== 'undefined' && performance.memory) {
    return { heap: performance.memory.usedJSHeapSize, rss: 0 };
  }
  return { heap: 0, rss: 0 };
}

function getPlaybackQuality(video) {
  if (!video) return null;
  if (typeof video.getVideoPlaybackQuality === 'function') {
    const q = video.getVideoPlaybackQuality();
    return {
      droppedVideoFrames: q.droppedVideoFrames || 0,
      totalVideoFrames: q.totalVideoFrames || 0
    };
  }
  if (typeof video.webkitDroppedFrameCount === 'number') {
    return {
      droppedVideoFrames: video.webkitDroppedFrameCount,
      totalVideoFrames: video.webkitDecodedFrameCount || 0
    };
  }
  return null;
}

/** opens via harness openClip, waits for video ready; returns timings video-player.js writes to the side channel */
async function openClipAndCaptureTimings(harness, clip) {
  if (!harness.appFunctions.openClip) {
    throw new Error('openClip is not registered on the harness');
  }
  // Clear stale timings so we can detect failure to populate.
  try { delete window.__benchmarkLastOpenTimings; } catch (_) { /* ignore */ }
  if (harness.appFunctions.closePlayer) {
    try { harness.appFunctions.closePlayer(); } catch (_) {}
    await delay(200);
  }
  await harness.appFunctions.openClip(clip.originalName, clip.customName);
  const video = document.getElementById('video-player');
  await waitForVideoReady(video);
  // mark('end') is synchronous so this should already be set; poll briefly in case that changes
  for (let i = 0; i < 20 && !window.__benchmarkLastOpenTimings; i++) {
    await delay(10);
  }
  return window.__benchmarkLastOpenTimings || null;
}

/**
 * Samples CPU + memory + dropped frames at a fixed interval during playback.
 * CPU% is measured against wall clock: 100% = one pegged core, so max is cores * 100.
 */
async function samplePlaybackCPU(durationMs = 5000, sampleIntervalMs = 250) {
  const video = document.getElementById('video-player');
  if (!video) throw new Error('video element missing');

  // audio decoding happens regardless for multi-track clips (AudioTracksManager pushes its own
  // <audio> elements through the WebAudio graph); muting the video element just keeps it quiet
  const wasMuted = video.muted;
  const wasVolume = video.volume;
  video.muted = true;
  video.volume = 0;

  const samples = [];
  const startMem = getMem();
  const startQuality = getPlaybackQuality(video);
  let prevCpu = process.cpuUsage();
  let prevWall = performance.now();

  if (video.paused) {
    try { await video.play(); } catch (_) { /* benchmark continues even if play fails */ }
  }

  const endAt = performance.now() + durationMs;
  try {
    while (performance.now() < endAt) {
      await delay(sampleIntervalMs);
      const cpu = process.cpuUsage();
      const wall = performance.now();
      const wallDeltaUs = (wall - prevWall) * 1000;
      const userDeltaUs = cpu.user - prevCpu.user;
      const sysDeltaUs = cpu.system - prevCpu.system;
      const cpuPct = wallDeltaUs > 0 ? ((userDeltaUs + sysDeltaUs) / wallDeltaUs) * 100 : 0;
      samples.push({
        t: wall,
        cpuPct,
        userPct: wallDeltaUs > 0 ? (userDeltaUs / wallDeltaUs) * 100 : 0,
        sysPct: wallDeltaUs > 0 ? (sysDeltaUs / wallDeltaUs) * 100 : 0,
        heap: getMem().heap
      });
      prevCpu = cpu;
      prevWall = wall;
    }
  } finally {
    video.muted = wasMuted;
    video.volume = wasVolume;
  }

  const endMem = getMem();
  const endQuality = getPlaybackQuality(video);
  const cpuValues = samples.map((s) => s.cpuPct);
  const avg = cpuValues.length ? cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length : 0;
  const peak = cpuValues.length ? Math.max(...cpuValues) : 0;

  return {
    durationMs,
    sampleCount: samples.length,
    cpuAvgPct: avg,
    cpuPeakPct: peak,
    cpuUserAvgPct: samples.length ? samples.reduce((a, s) => a + s.userPct, 0) / samples.length : 0,
    cpuSysAvgPct: samples.length ? samples.reduce((a, s) => a + s.sysPct, 0) / samples.length : 0,
    heapDeltaBytes: endMem.heap - startMem.heap,
    heapEndBytes: endMem.heap,
    rssDeltaBytes: endMem.rss - startMem.rss,
    droppedFrames: endQuality && startQuality
      ? (endQuality.droppedVideoFrames - startQuality.droppedVideoFrames)
      : null,
    totalFrames: endQuality && startQuality
      ? (endQuality.totalVideoFrames - startQuality.totalVideoFrames)
      : null
  };
}

async function runPlaybackCPUFor(harness, clip, options) {
  const result = {
    clipName: clip.originalName,
    audioTrackCount: clip.audioTrackCount
  };
  await openClipAndCaptureTimings(harness, clip);
  const stats = await samplePlaybackCPU(options.durationMs, options.sampleIntervalMs);
  Object.assign(result, stats);
  return result;
}

/**
 * Runs an openClip pass, returns phase deltas + audio-track count. Phases
 * come from video-player.js's internal mark() calls via window.__benchmarkLastOpenTimings.
 */
async function runOpenPhasesFor(harness, clip) {
  const before = getMem();
  const start = performance.now();
  const captured = await openClipAndCaptureTimings(harness, clip);
  const total = performance.now() - start;
  const after = getMem();

  // timings are cumulative; convert to per-phase deltas
  const phaseDeltas = [];
  if (captured?.timings) {
    const entries = Object.entries(captured.timings);
    let prev = 0;
    for (const [name, t] of entries) {
      phaseDeltas.push({ name, delta: t - prev, cumulative: t });
      prev = t;
    }
  }
  return {
    clipName: clip.originalName,
    audioTrackCount: captured?.audioTrackCount ?? clip.audioTrackCount,
    totalMs: total,
    heapDeltaBytes: after.heap - before.heap,
    rssDeltaBytes: after.rss - before.rss,
    phases: phaseDeltas
  };
}

/** seeks across the timeline, measures end-to-end latency, CPU, and dropped frames when available */
async function runSeekBurstFor(harness, clip, options) {
  await openClipAndCaptureTimings(harness, clip);
  const video = document.getElementById('video-player');
  if (!video) throw new Error('video element missing');

  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`video duration not available for ${clip.originalName}`);
  }

  const positions = options.positions || [0.1, 0.4, 0.7, 0.2, 0.8, 0.5, 0.9, 0.3, 0.6, 0.05];
  const wasMuted = video.muted;
  video.muted = true;

  const startCpu = process.cpuUsage();
  const startWall = performance.now();
  const startQuality = getPlaybackQuality(video);
  const seekDurations = [];

  try {
    for (const pos of positions) {
      const target = duration * pos;
      const seekStart = performance.now();
      await new Promise((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.currentTime = target;
      });
      seekDurations.push(performance.now() - seekStart);
    }
  } finally {
    video.muted = wasMuted;
  }

  const endCpu = process.cpuUsage();
  const wallMs = performance.now() - startWall;
  const cpuUserMs = (endCpu.user - startCpu.user) / 1000;
  const cpuSysMs = (endCpu.system - startCpu.system) / 1000;
  const endQuality = getPlaybackQuality(video);

  const avgSeek = seekDurations.reduce((a, b) => a + b, 0) / seekDurations.length;
  const maxSeek = Math.max(...seekDurations);

  return {
    clipName: clip.originalName,
    audioTrackCount: clip.audioTrackCount,
    seekCount: positions.length,
    totalWallMs: wallMs,
    avgSeekMs: avgSeek,
    maxSeekMs: maxSeek,
    cpuUserMs,
    cpuSysMs,
    cpuPctOfWall: wallMs > 0 ? ((cpuUserMs + cpuSysMs) / wallMs) * 100 : 0,
    droppedFrames: endQuality && startQuality
      ? (endQuality.droppedVideoFrames - startQuality.droppedVideoFrames)
      : null
  };
}

/**
 * Heap/RSS snapshot around an open; settles 1s after so background work
 * (audio-track extraction, first-frame decode) is included.
 */
async function runMemoryFootprintFor(harness, clip) {
  if (harness.appFunctions.closePlayer) {
    try { harness.appFunctions.closePlayer(); } catch (_) {}
    await delay(500);
  }
  if (typeof global !== 'undefined' && typeof global.gc === 'function') {
    try { global.gc(); } catch (_) {}
  }
  await delay(200);
  const before = getMem();
  await openClipAndCaptureTimings(harness, clip);
  await delay(1000);
  const after = getMem();
  return {
    clipName: clip.originalName,
    audioTrackCount: clip.audioTrackCount,
    heapBeforeBytes: before.heap,
    heapAfterBytes: after.heap,
    heapDeltaBytes: after.heap - before.heap,
    rssBeforeBytes: before.rss,
    rssAfterBytes: after.rss,
    rssDeltaBytes: after.rss - before.rss
  };
}

/**
 * Runs `perBucketFn` against categorizeClips()'s single/multi example clips;
 * returns `{ single, multi, missing }` for the runner to print.
 */
async function runCompare(harness, perBucketFn, label, options = {}) {
  const cats = await categorizeClips(harness.appFunctions.allClips, options.probeLimit);
  const out = { label, single: null, multi: null, probed: cats.probed, missing: [] };
  if (cats.single) {
    try {
      out.single = await perBucketFn(harness, cats.single, options);
    } catch (err) {
      out.single = { error: err.message, clipName: cats.single.originalName };
    }
  } else {
    out.missing.push('single');
  }
  if (cats.multi) {
    try {
      out.multi = await perBucketFn(harness, cats.multi, options);
    } catch (err) {
      out.multi = { error: err.message, clipName: cats.multi.originalName };
    }
  } else {
    out.missing.push('multi');
  }

  // renderer console.log doesn't reach the spawned Electron's stdout; route the
  // comparison table through the main-process IPC marker handler instead
  try {
    await ipcRenderer.invoke('benchmark:outputMarker', 'AUDIO_TRACK_COMPARE', out);
  } catch (_) { /* ignore */ }
  return out;
}

async function benchmarkPlaybackCPUCompare(harness, options = {}) {
  const durationMs = options.durationMs || 5000;
  const sampleIntervalMs = options.sampleIntervalMs || 250;
  return runCompare(harness, runPlaybackCPUFor, 'playback_cpu', {
    ...options, durationMs, sampleIntervalMs
  });
}

async function benchmarkOpenPhasesCompare(harness, options = {}) {
  return runCompare(harness, runOpenPhasesFor, 'open_phases', options);
}

async function benchmarkSeekBurstCompare(harness, options = {}) {
  return runCompare(harness, runSeekBurstFor, 'seek_burst', options);
}

async function benchmarkMemoryFootprintCompare(harness, options = {}) {
  return runCompare(harness, runMemoryFootprintFor, 'memory_footprint', options);
}

module.exports = {
  categorizeClips,
  benchmarkPlaybackCPUCompare,
  benchmarkOpenPhasesCompare,
  benchmarkSeekBurstCompare,
  benchmarkMemoryFootprintCompare
};
