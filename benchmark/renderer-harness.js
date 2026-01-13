/**
 * Renderer Process Benchmark Harness
 * 
 * Automates UI actions and collects renderer-side metrics:
 * - DOM rendering performance
 * - Clip loading and display
 * - Video player operations
 * - Search/filter performance
 * - Export operations
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
    
    // Store references to app functions (to be set by renderer.js)
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

  /**
   * Register app functions that can be benchmarked
   * @param {Object} functions - Object containing app functions
   */
  registerFunctions(functions) {
    this.appFunctions = { ...this.appFunctions, ...functions };
    this.log('Registered functions:', Object.keys(functions));
  }

  /**
   * Setup benchmark event listeners
   */
  setupBenchmarkListeners() {
    // Listen for benchmark commands from main process
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
   * Wait for a condition to be true
   * @param {Function} condition - Function that returns true when condition is met
   * @param {number} timeout - Maximum wait time in ms
   * @param {number} interval - Check interval in ms
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

  /**
   * Delay execution
   * @param {number} ms - Milliseconds to delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Wait for DOM to be ready with clips
   */
  async waitForClipsLoaded() {
    await this.waitFor(() => {
      const grid = document.getElementById('clip-grid');
      return grid && grid.children.length > 0 && 
             !grid.innerHTML.includes('Loading');
    }, 60000);
  }

  /**
   * Wait for video player to be ready
   */
  async waitForVideoReady() {
    const video = document.getElementById('video-player');
    if (!video) throw new Error('Video player not found');
    
    await this.waitFor(() => {
      return video.readyState >= 2; // HAVE_CURRENT_DATA or higher
    }, 30000);
  }

  /**
   * Benchmark: Load clips from disk
   */
  async benchmarkLoadClips() {
    this.log('Starting loadClips benchmark');
    
    // Clear current clips if any
    const clipGrid = document.getElementById('clip-grid');
    if (clipGrid) clipGrid.innerHTML = '';
    
    // Measure the loadClips function
    const { measurement } = await this.metrics.measure('loadClips', async () => {
      if (this.appFunctions.loadClips) {
        await this.appFunctions.loadClips();
      } else {
        // Fallback: trigger via IPC
        await ipcRenderer.invoke('get-clips');
      }
    });
    
    // Wait for DOM to update
    await this.waitForClipsLoaded();
    
    // Count clips
    const clipCount = document.querySelectorAll('.clip-item').length;
    
    return {
      ...measurement,
      clipCount,
      perClip: measurement ? measurement.duration / clipCount : 0
    };
  }

  /**
   * Benchmark: Render clips to DOM
   */
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

  /**
   * Benchmark: Open a clip in the player
   * @param {number} clipIndex - Index of clip to open (default: 0)
   */
  async benchmarkOpenClip(clipIndex = 0) {
    this.log(`Starting openClip benchmark for clip ${clipIndex}`);
    
    const clipItems = document.querySelectorAll('.clip-item');
    if (clipItems.length === 0) {
      throw new Error('No clips available to open');
    }
    
    const targetClip = clipItems[Math.min(clipIndex, clipItems.length - 1)];
    const originalName = targetClip.dataset.originalName;
    const customName = targetClip.querySelector('.clip-name')?.textContent || originalName;

    // Mute video during benchmark
    const video = document.getElementById('video-player');
    const wasMuted = video?.muted;
    if (video) video.muted = true;
    
    try {
      const { measurement } = await this.metrics.measure('openClip', async () => {
        if (this.appFunctions.openClip) {
          await this.appFunctions.openClip(originalName, customName);
        } else {
          // Fallback: simulate click
          targetClip.click();
        }
      });
      
      // Wait for video to be ready
      await this.waitForVideoReady();
      
      return {
        ...measurement,
        clipName: originalName
      };
    } finally {
      // Restore mute state
      if (video && wasMuted !== undefined) video.muted = wasMuted;
    }
  }

  /**
   * Benchmark: Video metadata loading (FFprobe)
   */
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

  /**
   * Benchmark: Search performance
   * @param {string} searchTerm - Term to search for
   */
  async benchmarkSearch(searchTerm = 'test') {
    this.log(`Starting search benchmark with term: "${searchTerm}"`);
    
    const searchInput = document.getElementById('search-input');
    if (!searchInput) {
      throw new Error('Search input not found');
    }
    
    // Clear search first
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await this.delay(350); // Wait for debounce
    
    const { measurement } = await this.metrics.measure('search', async () => {
      searchInput.value = searchTerm;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      
      // Wait for search to complete (debounce + filter)
      await this.delay(350);
    });
    
    const visibleClips = document.querySelectorAll('.clip-item:not([style*="display: none"])').length;
    
    // Clear search
    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    
    return {
      ...measurement,
      searchTerm,
      visibleClips
    };
  }

  /**
   * Benchmark: Video seek operation
   */
  async benchmarkSeek() {
    this.log('Starting seek benchmark');
    
    const video = document.getElementById('video-player');
    if (!video || video.readyState < 2) {
      throw new Error('Video not ready for seeking');
    }

    // Mute during seek benchmark
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
        
        await this.delay(100); // Small delay between seeks
      }
      
      return results;
    } finally {
      video.muted = wasMuted;
    }
  }

  /**
   * Benchmark: Close player
   */
  async benchmarkClosePlayer() {
    this.log('Starting closePlayer benchmark');
    
    const { measurement } = await this.metrics.measure('closePlayer', async () => {
      if (this.appFunctions.closePlayer) {
        this.appFunctions.closePlayer();
      } else {
        // Try ESC key
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      }
      await this.delay(100);
    });
    
    return measurement;
  }

  /**
   * Benchmark: Thumbnail generation
   */
  async benchmarkThumbnailGeneration() {
    this.log('Starting thumbnail generation benchmark');
    
    const clipItems = document.querySelectorAll('.clip-item');
    if (clipItems.length === 0) {
      throw new Error('No clips available');
    }
    
    // Get clip names
    const clipNames = Array.from(clipItems).slice(0, 5).map(c => c.dataset.originalName);
    
    const { measurement } = await this.metrics.measure('thumbnailGeneration', async () => {
      return await ipcRenderer.invoke('generate-thumbnails-progressively', clipNames);
    });
    
    return {
      ...measurement,
      clipCount: clipNames.length
    };
  }

  /**
   * Benchmark: Detailed open clip profiling using REAL openClip function
   * Provides granular timing for each phase of clip opening
   * @param {Object} options - Profiling options
   */
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

    // MUTE the video to prevent loud audio during benchmarks
    const originalVolume = videoPlayer.volume;
    const originalMuted = videoPlayer.muted;
    videoPlayer.muted = true;
    videoPlayer.volume = 0;
    this.log('Video muted for benchmark');

    const results = [];
    const clips = allClips.slice(0, Math.min(5, allClips.length));

    try {
      // Warmup runs
      for (let w = 0; w < warmupRuns; w++) {
        this.log(`Warmup run ${w + 1}/${warmupRuns}`);
        const clip = clips[0];
        
        // Close player if open
        if (this.appFunctions.closePlayer) {
          this.appFunctions.closePlayer();
          await this.delay(200);
        }

        // Call the REAL openClip function
        if (this.appFunctions.openClip) {
          await this.appFunctions.openClip(clip.originalName, clip.customName);
        }
        await this.delay(500);
      }

      // Actual benchmark runs
      for (let i = 0; i < iterations; i++) {
        const clip = clips[i % clips.length];
        this.log(`Iteration ${i + 1}/${iterations} - Clip: ${clip.originalName}`);

        // Close player if open
        if (this.appFunctions.closePlayer) {
          this.appFunctions.closePlayer();
          await this.delay(300);
        }

        // Measure memory before
        const memBefore = this.getMemoryUsage();

        // Wait for any pending operations
        await this.delay(100);

        // Start timing
        const startTime = performance.now();

        // Call the REAL openClip function
        if (this.appFunctions.openClip) {
          await this.appFunctions.openClip(clip.originalName, clip.customName);
        }

        // Wait for video to be ready and playing
        await this.waitForVideoReady();

        // Wait a bit more for UI to settle
        await this.delay(100);

        const endTime = performance.now();
        const duration = endTime - startTime;

        // Measure memory after
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
      // Restore original volume settings
      videoPlayer.muted = originalMuted;
      videoPlayer.volume = originalVolume;
      this.log('Video volume restored');
    }

    // Calculate statistics
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

    // Log summary
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

  /**
   * Get current memory usage
   */
  getMemoryUsage() {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      return process.memoryUsage().heapUsed;
    }
    if (performance.memory) {
      return performance.memory.usedJSHeapSize;
    }
    return 0;
  }

  /**
   * Run a specific scenario by name
   * @param {string} scenarioName - Name of scenario to run
   */
  async runScenario(scenarioName) {
    this.log(`Running scenario: ${scenarioName}`);
    this.currentScenario = scenarioName;
    
    const scenarioMap = {
      'loadClips': () => this.benchmarkLoadClips(),
      'renderClips': () => this.benchmarkRenderClips(),
      'openClip': () => this.benchmarkOpenClip(),
      'openClipDetailed': () => this.benchmarkOpenClipDetailed(),
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

  /**
   * Run all registered scenarios in sequence
   */
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
        await this.delay(500); // Pause between scenarios
      } catch (error) {
        results[scenario] = { error: error.message };
        this.log(`Scenario ${scenario} failed:`, error.message);
      }
    }
    
    return results;
  }

  /**
   * Get all collected metrics
   */
  getMetrics() {
    return {
      summary: this.metrics.getSummary(),
      memory: this.metrics.getMemorySnapshot(),
      results: this.results
    };
  }

  /**
   * Collect DOM performance metrics
   */
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

  /**
   * Reset all metrics
   */
  reset() {
    this.metrics.reset();
    this.results = [];
  }
}

// Create singleton instance
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
