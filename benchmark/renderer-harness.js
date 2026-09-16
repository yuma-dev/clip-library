/**
 * Automates UI actions in the renderer and collects metrics: DOM rendering
 * clip loading, video player ops, search/filter, export.
 */

'use strict';

const { ipcRenderer } = require('electron');
const { Metrics, formatters } = require('./metrics');
const { OpenClipProfiler, benchmarkOpenClipDetailed } = require('./open-clip-profiler');

class RendererHarness {
  constructor() {
    this.metrics = new Metrics();
    this.isEnabled = typeof process !== 'undefined' && process.env && process.env.CLIPS_BENCHMARK === '1';
    this.verbose = typeof process !== 'undefined' && process.env && process.env.CLIPS_BENCHMARK_VERBOSE === '1';
    this.scenarios = [];
    this.currentScenario = null;
    this.results = [];
    
    // set by renderer.js
    this.appFunctions = {};
    
    if (this.isEnabled) {
      this.log('Renderer harness initialized');
      this.setupBenchmarkListeners();
    }
  }

  log(message, data = null) {
    if (this.verbose) {
      const prefix = `[Benchmark:Renderer]`;
      if (data) {
        console.log(prefix, message, data);
      } else {
        console.log(prefix, message);
      }
    }
  }

  /** @param {Object} functions */
  registerFunctions(functions) {
    this.appFunctions = { ...this.appFunctions, ...functions };
    this.log('Registered functions:', Object.keys(functions));
  }

  setupBenchmarkListeners() {
    ipcRenderer.on('benchmark:runScenario', async (event, scenarioName) => {
      try {
        const result = await this.runScenario(scenarioName);
        ipcRenderer.send('benchmark:scenarioComplete', { scenarioName, result });
      } catch (error) {
        ipcRenderer.send('benchmark:scenarioError', { scenarioName, error: error.message });
      }
    });

    ipcRenderer.on('benchmark:runAllScenarios', async () => {
      const results = await this.runAllScenarios();
      ipcRenderer.send('benchmark:allScenariosComplete', results);
    });
  }

  /**
   * @param {Function} condition
   * @param {number} timeout
   * @param {number} interval
   */
  async waitFor(condition, timeout = 30000, interval = 100) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      if (await condition()) {
        return true;
      }
      await this.delay(interval);
    }
    
    throw new Error(`Timeout waiting for condition after ${timeout}ms`);
  }

  /** @param {number} ms */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async waitForClipsLoaded() {
    await this.waitFor(() => {
      const grid = document.getElementById('clip-grid');
      return grid && grid.children.length > 0 && 
             !grid.innerHTML.includes('Loading');
    }, 60000);
  }

  async waitForVideoReady() {
    const video = document.getElementById('video-player');
    if (!video) throw new Error('Video player not found');
    
    await this.waitFor(() => {
      return video.readyState >= 2; // HAVE_CURRENT_DATA or higher
    }, 30000);
  }

  async benchmarkLoadClips() {
    this.log('Starting loadClips benchmark');

    // expand all groups first for realistic full-load timing
    localStorage.removeItem('clipGroupsCollapsed');
    // clear the first-paint snapshot so this measures a real cold load, not a cached render
    localStorage.removeItem('clip-library:clips-cache-v1');

    const clipGrid = document.getElementById('clip-grid');
    if (clipGrid) clipGrid.innerHTML = '';

    const { measurement } = await this.metrics.measure('loadClips', async () => {
      if (this.appFunctions.loadClips) {
        await this.appFunctions.loadClips();
      } else {
        // fallback: trigger via IPC
        await ipcRenderer.invoke('get-clips');
      }
    });

    await this.waitForClipsLoaded();

    // all rendered since groups are expanded
    const clipCount = document.querySelectorAll('.clip-item').length;
    const groupCount = document.querySelectorAll('.clip-group').length;

    this.log(`Rendered ${clipCount} clips in ${groupCount} groups`);

    return {
      ...measurement,
      clipCount,
      groupCount,
      perClip: measurement ? measurement.duration / clipCount : 0
    };
  }

  async benchmarkRenderClips() {
    this.log('Starting renderClips benchmark');
    
    const { measurement } = await this.metrics.measure('renderClips', async () => {
      if (this.appFunctions.renderClips && this.appFunctions.allClips) {
        await this.appFunctions.renderClips(this.appFunctions.allClips);
      }
    });
    
    const clipCount = document.querySelectorAll('.clip-item').length;
    
    return {
      ...measurement,
      clipCount,
      perClip: measurement ? measurement.duration / clipCount : 0
    };
  }

  /** @param {number} clipIndex */
  async benchmarkOpenClip(clipIndex = 0) {
    this.log(`Starting openClip benchmark for clip ${clipIndex}`);
    
    const clipItems = document.querySelectorAll('.clip-item');
    if (clipItems.length === 0) {
      throw new Error('No clips available to open');
    }
    
    const targetClip = clipItems[Math.min(clipIndex, clipItems.length - 1)];
    const originalName = targetClip.dataset.originalName;
    const customName = targetClip.querySelector('.clip-name')?.textContent || originalName;

    const video = document.getElementById('video-player');
    const wasMuted = video?.muted;
    if (video) video.muted = true;
    
    try {
      const { measurement } = await this.metrics.measure('openClip', async () => {
        if (this.appFunctions.openClip) {
          await this.appFunctions.openClip(originalName, customName);
        } else {
          // fallback: simulate click
          targetClip.click();
        }
      });
      
      await this.waitForVideoReady();
      
      return {
        ...measurement,
        clipName: originalName
      };
    } finally {
      if (video && wasMuted !== undefined) video.muted = wasMuted;
    }
  }

  // via FFprobe
  async benchmarkVideoMetadata() {
    this.log('Starting video metadata benchmark');
    
    const clipItems = document.querySelectorAll('.clip-item');
    if (clipItems.length === 0) {
      throw new Error('No clips available');
    }
    
    const originalName = clipItems[0].dataset.originalName;
    
    const { measurement } = await this.metrics.measure('getClipInfo', async () => {
      return await ipcRenderer.invoke('get-clip-info', originalName);
    });
    
    return measurement;
  }

  /** @param {string} searchTerm */
  async benchmarkSearch(searchTerm = 'test') {
    this.log(`Starting search benchmark with term: "${searchTerm}"`);
    
    const searchInput = document.getElementById('search-input');
    if (!searchInput) {
      throw new Error('Search input not found');
    }
    
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await this.delay(350); // wait for debounce
    
    const { measurement } = await this.metrics.measure('search', async () => {
      searchInput.value = searchTerm;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      
      await this.delay(350); // debounce + filter
    });
    
    const visibleClips = document.querySelectorAll('.clip-item:not([style*="display: none"])').length;
    
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    
    return {
      ...measurement,
      searchTerm,
      visibleClips
    };
  }

  async benchmarkSeek() {
    this.log('Starting seek benchmark');
    
    const video = document.getElementById('video-player');
    if (!video || video.readyState < 2) {
      throw new Error('Video not ready for seeking');
    }

    const wasMuted = video.muted;
    video.muted = true;
    
    try {
      const duration = video.duration;
      const seekPositions = [0.25, 0.5, 0.75, 0.1, 0.9];
      const results = [];
      
      for (const position of seekPositions) {
        const targetTime = duration * position;
        
        const { measurement } = await this.metrics.measure(`seek:${position}`, async () => {
          return new Promise((resolve) => {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              resolve();
            };
            video.addEventListener('seeked', onSeeked);
            video.currentTime = targetTime;
          });
        });
        
        results.push({
          position,
          targetTime,
          duration: measurement?.duration
        });
        
        await this.delay(100);
      }
      
      return results;
    } finally {
      video.muted = wasMuted;
    }
  }

  async benchmarkClosePlayer() {
    this.log('Starting closePlayer benchmark');
    
    const { measurement } = await this.metrics.measure('closePlayer', async () => {
      if (this.appFunctions.closePlayer) {
        this.appFunctions.closePlayer();
      } else {
        // try ESC key
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      }
      await this.delay(100);
    });
    
    return measurement;
  }

  // FPS and responsiveness as more clips become visible
  async benchmarkGridPerformance() {
    this.log('Starting grid performance benchmark');

    const results = {
      tests: [],
      recommendations: []
    };

    let initialClipCount = document.querySelectorAll('.clip-item').length;
    this.log(`Initial clips in DOM: ${initialClipCount}`);

    // simulate user expanding all groups
    const collapsedGroups = document.querySelectorAll('.clip-group.collapsed');
    this.log(`Expanding ${collapsedGroups.length} collapsed groups...`);

    for (const group of collapsedGroups) {
      const header = group.querySelector('.clip-group-header');
      if (header) {
        header.click();
        // wait for lazy loading to complete
        await this.delay(100);
      }
    }

    await this.delay(500);

    let totalClipsInDOM = document.querySelectorAll('.clip-item').length;
    this.log(`After expansion: ${totalClipsInDOM} clips in DOM`);

    const measureFPS = async (duration = 2000) => {
      let frameCount = 0;
      let lastTime = performance.now();
      const frames = [];

      return new Promise(resolve => {
        const countFrame = (now) => {
          frameCount++;
          const delta = now - lastTime;
          if (delta > 0) {
            frames.push(1000 / delta);
          }
          lastTime = now;

          if (performance.now() - frames[0] < duration) {
            requestAnimationFrame(countFrame);
          } else {
            const avgFPS = frames.length > 0 ? frames.reduce((a, b) => a + b, 0) / frames.length : 0;
            const minFPS = Math.min(...frames);
            resolve({ avgFPS, minFPS, frameCount });
          }
        };

        setTimeout(() => {
          lastTime = performance.now();
          frames.push(lastTime);
          requestAnimationFrame(countFrame);
        }, 100);
      });
    };

    const measureScrollPerformance = async () => {
      const clipGrid = document.getElementById('clip-grid');
      if (!clipGrid) return { scrollFPS: 0, jank: 0 };

      const startY = clipGrid.scrollTop;
      const maxScroll = clipGrid.scrollHeight - clipGrid.clientHeight;

      let frameCount = 0;
      let jankFrames = 0;
      let lastFrameTime = performance.now();

      return new Promise(resolve => {
        const scrollStep = () => {
          const now = performance.now();
          const frameDelta = now - lastFrameTime;

          if (frameDelta > 32) jankFrames++; // >32ms = <30fps
          frameCount++;
          lastFrameTime = now;

          clipGrid.scrollTop += 50;

          if (clipGrid.scrollTop < maxScroll - 100) {
            requestAnimationFrame(scrollStep);
          } else {
            clipGrid.scrollTop = startY;
            resolve({
              scrollFPS: frameCount / ((now - lastFrameTime) / 1000) || 60,
              jankFrames,
              totalFrames: frameCount,
              jankPercent: ((jankFrames / frameCount) * 100).toFixed(1)
            });
          }
        };
        requestAnimationFrame(scrollStep);
      });
    };

    const clipCount = document.querySelectorAll('.clip-item').length;
    this.log(`Testing with ${clipCount} clips visible`);

    const idleFPS = await measureFPS(1500);
    results.tests.push({
      clipCount,
      idleFPS: idleFPS.avgFPS.toFixed(1),
      minFPS: idleFPS.minFPS.toFixed(1)
    });

    const scrollPerf = await measureScrollPerformance();
    results.scrollPerformance = scrollPerf;

    const domStats = {
      totalElements: document.querySelectorAll('*').length,
      clipItems: document.querySelectorAll('.clip-item').length,
      images: document.querySelectorAll('img').length,
      videos: document.querySelectorAll('video').length
    };
    results.domStats = domStats;

    const clipItems = document.querySelectorAll('.clip-item');
    let hasBoxShadow = 0;
    let hasFilter = 0;
    let hasTransform = 0;

    if (clipItems.length > 0) {
      const sample = clipItems[0];
      const style = getComputedStyle(sample);
      if (style.boxShadow !== 'none') hasBoxShadow = clipItems.length;
      if (style.filter !== 'none') hasFilter = clipItems.length;
      if (style.transform !== 'none') hasTransform = clipItems.length;
    }

    results.cssStats = { hasBoxShadow, hasFilter, hasTransform };

    if (domStats.clipItems > 100) {
      results.recommendations.push(`High clip count (${domStats.clipItems}) - consider virtual scrolling`);
    }
    if (scrollPerf.jankPercent > 10) {
      results.recommendations.push(`Scroll jank detected (${scrollPerf.jankPercent}%) - optimize rendering`);
    }
    if (hasBoxShadow > 50) {
      results.recommendations.push(`${hasBoxShadow} elements with box-shadow - consider removing or simplifying`);
    }

    await ipcRenderer.invoke('benchmark:outputMarker', 'GRID_PERFORMANCE', results);

    return results;
  }

  async benchmarkStartupDetailed() {
    this.log('Starting detailed startup breakdown');

    const phases = [];
    const addPhase = (name, duration) => {
      phases.push({ name, duration });
      this.log(`  ${name}: ${duration.toFixed(1)}ms`);
    };

    const clipGrid = document.getElementById('clip-grid');
    if (clipGrid) clipGrid.innerHTML = '';

    let totalStart = performance.now();
    let phaseStart;

    phaseStart = performance.now();
    const clipLocation = await ipcRenderer.invoke("get-clip-location");
    addPhase('get-clip-location', performance.now() - phaseStart);

    phaseStart = performance.now();
    const newClipsInfo = await ipcRenderer.invoke("get-new-clips-info");
    addPhase('get-new-clips-info', performance.now() - phaseStart);

    // filesystem scan, the big one
    phaseStart = performance.now();
    let allClips = await ipcRenderer.invoke("get-clips");
    addPhase('get-clips (filesystem)', performance.now() - phaseStart);

    const clipCount = allClips.length;
    this.log(`  Clips found: ${clipCount}`);

    phaseStart = performance.now();
    const TAG_BATCH_SIZE = 50;
    let tagBatchTimes = [];

    for (let i = 0; i < allClips.length; i += TAG_BATCH_SIZE) {
      const batchStart = performance.now();
      const batch = allClips.slice(i, i + TAG_BATCH_SIZE);
      await Promise.all(batch.map(async (clip) => {
        clip.tags = await ipcRenderer.invoke("get-clip-tags", clip.originalName);
      }));
      tagBatchTimes.push(performance.now() - batchStart);
    }
    const totalTagTime = performance.now() - phaseStart;
    addPhase(`load-tags (${Math.ceil(clipCount / TAG_BATCH_SIZE)} batches)`, totalTagTime);

    phaseStart = performance.now();
    allClips.sort((a, b) => b.createdAt - a.createdAt);
    addPhase('sort-clips', performance.now() - phaseStart);

    phaseStart = performance.now();
    await ipcRenderer.invoke("load-global-tags");
    addPhase('load-global-tags', performance.now() - phaseStart);

    phaseStart = performance.now();
    if (this.appFunctions.renderClips) {
      await this.appFunctions.renderClips(allClips);
    }
    addPhase('render-clips (DOM)', performance.now() - phaseStart);

    phaseStart = performance.now();
    const renderedClips = document.querySelectorAll('.clip-item').length;
    const groupCount = document.querySelectorAll('.time-group').length;
    addPhase('DOM query', performance.now() - phaseStart);

    const totalTime = performance.now() - totalStart;

    const report = {
      totalTime,
      clipCount,
      renderedClips,
      groupCount,
      phases: phases.map(p => ({
        ...p,
        percentage: ((p.duration / totalTime) * 100).toFixed(1)
      })),
      tagBatchDetails: {
        batchCount: tagBatchTimes.length,
        batchTimes: tagBatchTimes,
        avgBatchTime: tagBatchTimes.length > 0 ?
          tagBatchTimes.reduce((a, b) => a + b, 0) / tagBatchTimes.length : 0
      }
    };

    // for the runner to display
    await ipcRenderer.invoke('benchmark:outputMarker', 'STARTUP_BREAKDOWN', report);

    return report;
  }

  async benchmarkThumbnailGeneration() {
    this.log('Starting thumbnail generation benchmark');
    
    const clipItems = document.querySelectorAll('.clip-item');
    if (clipItems.length === 0) {
      throw new Error('No clips available');
    }
    
    const clipNames = Array.from(clipItems).slice(0, 5).map(c => c.dataset.originalName);
    
    const { measurement } = await this.metrics.measure('thumbnailGeneration', async () => {
      return await ipcRenderer.invoke('generate-thumbnails-progressively', clipNames);
    });
    
    return {
      ...measurement,
      clipCount: clipNames.length
    };
  }

  // uses the real openClip function (not simulated), granular per-phase timing
  /** @param {Object} options */
  async benchmarkOpenClipDetailed(options = {}) {
    this.log('Starting detailed open clip profiler (using real openClip)');
    
    const videoPlayer = document.getElementById('video-player');
    const allClips = this.appFunctions.allClips ? 
      (typeof this.appFunctions.allClips === 'function' ? this.appFunctions.allClips() : this.appFunctions.allClips) : 
      [];
    
    if (allClips.length === 0) {
      throw new Error('No clips available for profiling');
    }

    const iterations = options.iterations || 5;
    const warmupRuns = options.warmupRuns || 1;
    const delayBetweenRuns = options.delayBetweenRuns || 2000;

    // mute to avoid loud audio during benchmark
    const originalVolume = videoPlayer.volume;
    const originalMuted = videoPlayer.muted;
    videoPlayer.muted = true;
    videoPlayer.volume = 0;
    this.log('Video muted for benchmark');

    const results = [];
    const clips = allClips.slice(0, Math.min(5, allClips.length));

    try {
      for (let w = 0; w < warmupRuns; w++) {
        this.log(`Warmup run ${w + 1}/${warmupRuns}`);
        const clip = clips[0];
        
        if (this.appFunctions.closePlayer) {
          this.appFunctions.closePlayer();
          await this.delay(200);
        }

        if (this.appFunctions.openClip) {
          await this.appFunctions.openClip(clip.originalName, clip.customName);
        }
        await this.delay(500);
      }

      for (let i = 0; i < iterations; i++) {
        const clip = clips[i % clips.length];
        this.log(`Iteration ${i + 1}/${iterations} - Clip: ${clip.originalName}`);

        if (this.appFunctions.closePlayer) {
          this.appFunctions.closePlayer();
          await this.delay(300);
        }

        const memBefore = this.getMemoryUsage();

        await this.delay(100);

        const startTime = performance.now();

        if (this.appFunctions.openClip) {
          await this.appFunctions.openClip(clip.originalName, clip.customName);
        }

        await this.waitForVideoReady();

        // settle time for the UI
        await this.delay(100);

        const endTime = performance.now();
        const duration = endTime - startTime;

        const memAfter = this.getMemoryUsage();

        results.push({
          clipName: clip.originalName,
          duration,
          memory: {
            before: memBefore,
            after: memAfter,
            delta: memAfter - memBefore
          }
        });

        this.log(`  Duration: ${duration.toFixed(1)}ms`);

        if (i < iterations - 1) {
          await this.delay(delayBetweenRuns);
        }
      }
    } finally {
      videoPlayer.muted = originalMuted;
      videoPlayer.volume = originalVolume;
      this.log('Video volume restored');
    }

    const durations = results.map(r => r.duration);
    const sorted = [...durations].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / sorted.length;
    const variance = sorted.length > 1
      ? sorted.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / (sorted.length - 1)
      : 0;

    const report = {
      runs: results.length,
      total: {
        avg,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        median: sorted[Math.floor(sorted.length / 2)],
        stdDev: Math.sqrt(variance),
        p95: sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1]
      },
      results
    };

    this.log('\n========== REAL OPEN CLIP BENCHMARK ==========');
    this.log(`Runs: ${report.runs}`);
    this.log(`Total Time: avg=${avg.toFixed(1)}ms, min=${sorted[0].toFixed(1)}ms, max=${sorted[sorted.length - 1].toFixed(1)}ms`);
    this.log(`StdDev: ${Math.sqrt(variance).toFixed(1)}ms`);
    this.log('Individual runs:');
    for (const r of results) {
      this.log(`  ${r.clipName}: ${r.duration.toFixed(1)}ms`);
    }
    this.log('================================================\n');

    return { report, rawResults: results };
  }

  getMemoryUsage() {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      return process.memoryUsage().heapUsed;
    }
    if (performance.memory) {
      return performance.memory.usedJSHeapSize;
    }
    return 0;
  }

  /** @param {string} scenarioName */
  async runScenario(scenarioName) {
    this.log(`Running scenario: ${scenarioName}`);
    this.currentScenario = scenarioName;
    
    const scenarioMap = {
      'loadClips': () => this.benchmarkLoadClips(),
      'renderClips': () => this.benchmarkRenderClips(),
      'openClip': () => this.benchmarkOpenClip(),
      'openClipDetailed': () => this.benchmarkOpenClipDetailed(),
      'startupDetailed': () => this.benchmarkStartupDetailed(),
      'videoMetadata': () => this.benchmarkVideoMetadata(),
      'search': () => this.benchmarkSearch(),
      'seek': () => this.benchmarkSeek(),
      'closePlayer': () => this.benchmarkClosePlayer(),
      'thumbnails': () => this.benchmarkThumbnailGeneration()
    };
    
    const scenario = scenarioMap[scenarioName];
    if (!scenario) {
      throw new Error(`Unknown scenario: ${scenarioName}`);
    }
    
    const result = await scenario();
    this.results.push({ scenario: scenarioName, result });
    this.currentScenario = null;
    
    return result;
  }

  async runAllScenarios() {
    this.log('Running all scenarios');
    
    const scenarios = [
      'loadClips',
      'openClip',
      'seek',
      'closePlayer',
      'search',
      'videoMetadata'
    ];
    
    const results = {};
    
    for (const scenario of scenarios) {
      try {
        results[scenario] = await this.runScenario(scenario);
        await this.delay(500); // pause between scenarios
      } catch (error) {
        results[scenario] = { error: error.message };
        this.log(`Scenario ${scenario} failed:`, error.message);
      }
    }
    
    return results;
  }

  getMetrics() {
    return {
      summary: this.metrics.getSummary(),
      memory: this.metrics.getMemorySnapshot(),
      results: this.results
    };
  }

  getDOMMetrics() {
    const entries = performance.getEntriesByType('measure');
    const paint = performance.getEntriesByType('paint');
    
    return {
      measures: entries.map(e => ({
        name: e.name,
        duration: e.duration,
        startTime: e.startTime
      })),
      paint: paint.map(e => ({
        name: e.name,
        startTime: e.startTime
      })),
      timing: {
        domContentLoaded: performance.timing?.domContentLoadedEventEnd - performance.timing?.navigationStart,
        load: performance.timing?.loadEventEnd - performance.timing?.navigationStart
      }
    };
  }

  reset() {
    this.metrics.reset();
    this.results = [];
  }
}

let instance = null;

function getRendererHarness() {
  if (!instance) {
    instance = new RendererHarness();
  }
  return instance;
}

module.exports = {
  RendererHarness,
  getRendererHarness
};
