import { getBenchmarkContext, type BenchmarkContext } from "./context";

type MemoryUsage = { heapUsed: number; heapTotal: number; rss: number };
type Measurement = {
  duration: number;
  memory: { heapUsedDelta: number; heapTotalDelta: number; rssDelta: number };
};
type BenchmarkResult = {
  scenario: string;
  duration?: number;
  memory?: Measurement["memory"];
  details?: unknown;
  error?: string;
};

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function memoryUsage(): MemoryUsage {
  const processLike = (globalThis as unknown as {
    process?: { memoryUsage?: () => Partial<MemoryUsage> };
  }).process;
  const usage = processLike?.memoryUsage?.() ?? {};
  return {
    heapUsed: Number(usage.heapUsed) || 0,
    heapTotal: Number(usage.heapTotal) || 0,
    rss: Number(usage.rss) || 0,
  };
}

async function measure<T>(fn: () => Promise<T> | T): Promise<{ value: T; measurement: Measurement }> {
  const before = memoryUsage();
  const started = performance.now();
  const value = await fn();
  const after = memoryUsage();
  return {
    value,
    measurement: {
      duration: performance.now() - started,
      memory: {
        heapUsedDelta: after.heapUsed - before.heapUsed,
        heapTotalDelta: after.heapTotal - before.heapTotal,
        rssDelta: after.rss - before.rss,
      },
    },
  };
}

async function waitFor(predicate: () => boolean, timeout = 30_000, label = "condition"): Promise<void> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function nextPaint(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function videoElement(): HTMLVideoElement {
  const video = document.getElementById("video-player") as HTMLVideoElement | null;
  if (!video) throw new Error("Video player element not found");
  return video;
}

async function openClip(originalName: string, customName?: string): Promise<void> {
  const player = window.legacyPlayer;
  if (!player) throw new Error("Player module is not initialized");
  const video = videoElement();
  video.muted = true;
  await player.openClip(originalName, customName || originalName);
  await waitFor(() => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, 30_000, "video readiness");
}

async function closePlayer(): Promise<void> {
  await window.legacyPlayer?.closePlayer();
  await nextPaint();
}

async function ensurePlayerOpen(context: BenchmarkContext): Promise<void> {
  const video = videoElement();
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && window.legacyState?.currentClip) return;
  const clip = context.getClips()[0];
  if (!clip) throw new Error("No clips are available");
  await openClip(clip.originalName, clip.customName);
}

async function benchmarkLoadClips(): Promise<{ measurement: Measurement; details: unknown }> {
  const { value, measurement } = await measure(() => window.clips.getClips());
  return {
    measurement,
    details: { clipCount: Array.isArray(value) ? value.length : 0, operation: "filesystem scan" },
  };
}

async function benchmarkRenderClips(context: BenchmarkContext): Promise<{ measurement: Measurement; details: unknown }> {
  const originalQuery = context.getQuery();
  context.setQuery(`__benchmark_no_match_${Date.now()}__`);
  await waitFor(() => context.getFilteredClips().length === 0, 10_000, "empty filtered grid");
  await nextPaint();

  const { measurement } = await measure(async () => {
    context.setQuery(originalQuery);
    await waitFor(() => context.getFilteredClips().length > 0, 10_000, "restored filtered grid");
    await waitFor(() => document.querySelectorAll(".clip-item").length > 0, 10_000, "rendered clip cards");
    await nextPaint();
  });
  return {
    measurement,
    details: {
      clipCount: context.getFilteredClips().length,
      mountedCards: document.querySelectorAll(".clip-item").length,
    },
  };
}

async function benchmarkOpenClip(context: BenchmarkContext): Promise<{ measurement: Measurement; details: unknown }> {
  const clip = context.getClips()[0];
  if (!clip) throw new Error("No clips are available");
  await closePlayer();
  const { measurement } = await measure(() => openClip(clip.originalName, clip.customName));
  return { measurement, details: { clipName: clip.originalName } };
}

async function benchmarkVideoMetadata(context: BenchmarkContext): Promise<{ measurement: Measurement; details: unknown }> {
  const clip = context.getClips()[0];
  if (!clip) throw new Error("No clips are available");
  const { value, measurement } = await measure(() => window.clips.getClipInfo(clip.originalName));
  return { measurement, details: { clipName: clip.originalName, info: value } };
}

async function benchmarkSearch(
  context: BenchmarkContext,
  searchTerm: string,
): Promise<{ measurement: Measurement; details: unknown }> {
  const originalQuery = context.getQuery();
  const { measurement } = await measure(async () => {
    context.setQuery(searchTerm);
    await waitFor(() => context.getQuery() === searchTerm, 5_000, "search state");
    await nextPaint();
  });
  const visibleClips = context.getFilteredClips().length;
  context.setQuery(originalQuery);
  await nextPaint();
  return { measurement, details: { searchTerm, visibleClips } };
}

async function benchmarkSeek(context: BenchmarkContext): Promise<{ measurement: Measurement; details: unknown }> {
  await ensurePlayerOpen(context);
  const video = videoElement();
  const positions = [0.25, 0.5, 0.75, 0.1, 0.9];
  const seeks: Array<{ position: number; duration: number }> = [];
  const { measurement } = await measure(async () => {
    for (const position of positions) {
      const started = performance.now();
      const target = Math.max(0, video.duration * position);
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        video.addEventListener("seeked", done, { once: true });
        video.currentTime = target;
      });
      seeks.push({ position, duration: performance.now() - started });
    }
  });
  return { measurement, details: { seeks } };
}

async function benchmarkClosePlayer(context: BenchmarkContext): Promise<{ measurement: Measurement; details: unknown }> {
  await ensurePlayerOpen(context);
  const { measurement } = await measure(closePlayer);
  return { measurement, details: null };
}

async function benchmarkGridPerformance(): Promise<{ measurement: Measurement; details: unknown }> {
  const scroller = document.querySelector<HTMLElement>(".clip-scroll");
  if (!scroller) throw new Error("Clip scroller not found");
  const startTop = scroller.scrollTop;
  const frameDeltas: number[] = [];
  const { measurement } = await measure(
    () =>
      new Promise<void>((resolve) => {
        const started = performance.now();
        let previous = started;
        const frame = (now: number) => {
          frameDeltas.push(now - previous);
          previous = now;
          const elapsed = now - started;
          scroller.scrollTop = startTop + Math.min(scroller.scrollHeight, elapsed * 1.5);
          if (elapsed < 1_200) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      }),
  );
  scroller.scrollTop = startTop;
  const jankFrames = frameDeltas.filter((ms) => ms > 32).length;
  const sorted = [...frameDeltas].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const clipItems = document.querySelectorAll(".clip-item").length;
  return {
    measurement,
    details: {
      tests: [{ clipCount: clipItems, idleFPS: (1000 / Math.max(1, p95)).toFixed(1), minFPS: (1000 / Math.max(...frameDeltas, 1)).toFixed(1) }],
      scrollPerformance: {
        jankFrames,
        totalFrames: frameDeltas.length,
        jankPercent: frameDeltas.length ? ((jankFrames / frameDeltas.length) * 100).toFixed(1) : "0.0",
      },
      domStats: {
        totalElements: document.querySelectorAll("*").length,
        clipItems,
        images: document.querySelectorAll("img").length,
        videos: document.querySelectorAll("video").length,
      },
      cssStats: { hasBoxShadow: 0, hasFilter: 0, hasTransform: 0 },
      recommendations: [],
    },
  };
}

async function benchmarkStartupDetailed(context: BenchmarkContext): Promise<{ measurement: Measurement; details: unknown }> {
  const phases: Array<{ name: string; duration: number; percentage?: string }> = [];
  const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    const value = await fn();
    phases.push({ name, duration: performance.now() - started });
    return value;
  };
  const { measurement } = await measure(async () => {
    await phase("get-clip-location", () => window.clips.getClipLocation());
    const clips = await phase("get-clips (filesystem)", () => window.clips.getClips());
    const names = clips.map((clip) => String(clip.originalName));
    await phase("get-new-clips-info", () => window.clips.getNewClipsInfo(names));
    await phase("load-tags (batched)", async () => {
      for (let i = 0; i < names.length; i += 100) {
        await window.clips.getClipTagsBatch(names.slice(i, i + 100));
      }
    });
    await phase("load-global-tags", () => window.clips.loadGlobalTags());
    await phase("React grid paint", nextPaint);
  });
  for (const item of phases) item.percentage = ((item.duration / Math.max(1, measurement.duration)) * 100).toFixed(1);
  return {
    measurement,
    details: {
      totalTime: measurement.duration,
      clipCount: context.getClips().length,
      renderedClips: document.querySelectorAll(".clip-item").length,
      groupCount: document.querySelectorAll(".clip-group").length,
      phases,
      tagBatchDetails: { batchCount: Math.ceil(context.getClips().length / 100), batchTimes: [], avgBatchTime: 0 },
    },
  };
}

async function benchmarkThumbnailBatch(context: BenchmarkContext): Promise<{ measurement: Measurement; details: unknown }> {
  const names = context.getClips().slice(0, 5).map((clip) => clip.originalName);
  if (names.length === 0) throw new Error("No clips are available");
  const { measurement } = await measure(() => window.clips.generateThumbnailsProgressively(names));
  return { measurement, details: { clipCount: names.length } };
}

async function benchmarkOpenClipDetailed(context: BenchmarkContext): Promise<{ measurement: Measurement; details: unknown }> {
  const clips = context.getClips().slice(0, 5);
  if (clips.length === 0) throw new Error("No clips are available");
  const results: Array<{ clipName: string; duration: number; memory: { delta: number } }> = [];
  const { measurement } = await measure(async () => {
    for (const clip of clips) {
      await closePlayer();
      const before = memoryUsage();
      const started = performance.now();
      await openClip(clip.originalName, clip.customName);
      results.push({
        clipName: clip.originalName,
        duration: performance.now() - started,
        memory: { delta: memoryUsage().heapUsed - before.heapUsed },
      });
    }
  });
  const durations = results.map((item) => item.duration).sort((a, b) => a - b);
  const avg = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  return {
    measurement,
    details: {
      report: {
        runs: results.length,
        total: {
          avg,
          min: durations[0],
          max: durations[durations.length - 1],
          median: durations[Math.floor(durations.length / 2)],
          p95: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))],
          stdDev: Math.sqrt(durations.reduce((sum, value) => sum + (value - avg) ** 2, 0) / durations.length),
        },
        results,
      },
    },
  };
}

async function benchmarkAudio(context: BenchmarkContext, scenario: string): Promise<{ measurement: Measurement; details: unknown }> {
  if (!window.__runAudioBenchmark) throw new Error("Audio benchmark bridge is unavailable");
  const harness = {
    appFunctions: {
      allClips: context.getClips,
      openClip,
      closePlayer,
    },
  };
  const { value, measurement } = await measure(() => window.__runAudioBenchmark!(scenario, harness));
  return { measurement, details: value };
}

async function runScenario(context: BenchmarkContext, scenario: string): Promise<{ measurement: Measurement; details: unknown }> {
  switch (scenario) {
    case "load_clips": return benchmarkLoadClips();
    case "render_clips": return benchmarkRenderClips(context);
    case "open_clip": return benchmarkOpenClip(context);
    case "open_clip_detailed": return benchmarkOpenClipDetailed(context);
    case "video_metadata": return benchmarkVideoMetadata(context);
    case "video_seek": return benchmarkSeek(context);
    case "close_player": return benchmarkClosePlayer(context);
    case "search_simple": return benchmarkSearch(context, "clip");
    case "search_complex": return benchmarkSearch(context, "gameplay video 2024");
    case "grid_performance": return benchmarkGridPerformance();
    case "startup_detailed": return benchmarkStartupDetailed(context);
    case "thumbnail_batch": return benchmarkThumbnailBatch(context);
    case "playback_cpu_compare":
    case "open_phases_compare":
    case "seek_burst_compare":
    case "memory_footprint_compare":
      return benchmarkAudio(context, scenario);
    default:
      throw new Error(`Unknown benchmark scenario: ${scenario}`);
  }
}

export async function runBenchmarks(): Promise<void> {
  const scenarios = window.__benchmarkConfig?.scenarios ?? [];
  try {
    if (scenarios.length === 0) throw new Error("No benchmark scenarios were requested");
    await waitFor(() => {
      const context = getBenchmarkContext();
      return Boolean(context && !context.isLoading() && document.querySelector(".clip-item"));
    }, 60_000, "React library readiness");
    await delay(750);
    const context = getBenchmarkContext();
    if (!context) throw new Error("Benchmark context was not registered");

    for (const scenario of scenarios) {
      let result: BenchmarkResult;
      const started = performance.now();
      try {
        const { measurement, details } = await runScenario(context, scenario);
        result = { scenario, duration: measurement.duration, memory: measurement.memory, details };
      } catch (error) {
        result = {
          scenario,
          duration: performance.now() - started,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await window.clips.benchmarkOutputResult(result);
      await delay(250);
    }

    const main = await window.clips.benchmarkGetResults();
    await window.clips.benchmarkOutputComplete({ main });
  } catch (error) {
    await window.clips.benchmarkOutputMarker("BENCHMARK_FATAL", {
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => false);
  } finally {
    await window.clips.benchmarkQuit().catch(() => false);
  }
}
