/**
 * Main Process Benchmark Harness
 * 
 * Instruments the main process for benchmarking:
 * - Startup timing
 * - IPC call timing
 * - FFmpeg operations
 * - File system operations
 */

'use strict';

const { ipcMain, app } = require('electron');
const { Metrics, formatters } = require('./metrics');

class MainHarness {
  constructor() {
    this.metrics = new Metrics();
    this.ipcTimings = new Map();
    this.startupMarks = {};
    this.isEnabled = process.env.CLIPS_BENCHMARK === '1';
    this.verbose = process.env.CLIPS_BENCHMARK_VERBOSE === '1';
    
    // Record process start time
    this.processStartTime = Date.now();
    
    if (this.isEnabled) {
      this.log('Main harness initialized');
      this.setupIPCInterception();
      this.setupBenchmarkIPC();
    }
  }

  log(message, data = null) {
    if (this.verbose) {
      const prefix = `[Benchmark:Main]`;
      if (data) {
        console.log(prefix, message, data);
      } else {
        console.log(prefix, message);
      }
    }
  }

  /**
   * Mark a startup phase
   * @param {string} phase - Phase name
   */
  markStartup(phase) {
    if (!this.isEnabled) return;
    
    this.metrics.startMark(`startup:${phase}`);
    this.log(`Startup phase started: ${phase}`);
  }

  /**
   * End a startup phase mark
   * @param {string} phase - Phase name
   * @returns {Object|null} Measurement result
   */
  endStartup(phase) {
    if (!this.isEnabled) return null;
    
    const result = this.metrics.endMark(`startup:${phase}`);
    if (result) {
      this.log(`Startup phase completed: ${phase}`, 
        `${formatters.duration(result.duration)}`);
    }
    return result;
  }

  /**
   * Record app ready time
   */
  recordAppReady() {
    if (!this.isEnabled) return;
    
    const appReadyTime = Date.now() - this.processStartTime;
    this.metrics.recordManual('startup:appReady', appReadyTime);
    this.log(`App ready in ${formatters.duration(appReadyTime)}`);
  }

  /**
   * Setup IPC handler interception for timing
   */
  setupIPCInterception() {
    const originalHandle = ipcMain.handle.bind(ipcMain);
    const self = this;

    // Intercept ipcMain.handle to wrap handlers with timing
    ipcMain.handle = function(channel, handler) {
      const wrappedHandler = async (event, ...args) => {
        const startTime = performance.now();
        const startMemory = process.memoryUsage().heapUsed;
        
        try {
          const result = await handler(event, ...args);
          
          const duration = performance.now() - startTime;
          const memoryDelta = process.memoryUsage().heapUsed - startMemory;
          
          // Record IPC timing
          self.recordIPCTiming(channel, duration, memoryDelta);
          
          return result;
        } catch (error) {
          const duration = performance.now() - startTime;
          self.recordIPCTiming(channel, duration, 0, true);
          throw error;
        }
      };
      
      return originalHandle(channel, wrappedHandler);
    };
  }

  /**
   * Record IPC call timing
   */
  recordIPCTiming(channel, duration, memoryDelta, isError = false) {
    if (!this.ipcTimings.has(channel)) {
      this.ipcTimings.set(channel, []);
    }
    
    this.ipcTimings.get(channel).push({
      duration,
      memoryDelta,
      isError,
      timestamp: Date.now()
    });

    // Also record to metrics for aggregation
    this.metrics.recordManual(`ipc:${channel}`, duration, {
      memory: { heapUsedDelta: memoryDelta },
      isError
    });

    if (this.verbose && duration > 50) {
      this.log(`IPC [${channel}]: ${formatters.duration(duration)}`);
    }
  }

  /**
   * Setup benchmark-specific IPC handlers
   */
  setupBenchmarkIPC() {
    // Handler to get current metrics from main process
    ipcMain.handle('benchmark:getMainMetrics', () => {
      return {
        summary: this.metrics.getSummary(),
        ipcTimings: this.getIPCStats(),
        memory: this.metrics.getMemorySnapshot()
      };
    });

    // Handler to mark phases from renderer
    ipcMain.handle('benchmark:markPhase', (event, phase) => {
      this.metrics.startMark(`phase:${phase}`);
      return true;
    });

    // Handler to end phase marks from renderer
    ipcMain.handle('benchmark:endPhase', (event, phase) => {
      return this.metrics.endMark(`phase:${phase}`);
    });

    // Handler to get final benchmark results
    ipcMain.handle('benchmark:getResults', () => {
      return this.getResults();
    });

    // Handler to reset metrics
    ipcMain.handle('benchmark:reset', () => {
      this.metrics.reset();
      this.ipcTimings.clear();
      return true;
    });

    // Handler to output result to stdout (for runner to capture)
    ipcMain.handle('benchmark:outputResult', (event, result) => {
      // Write directly to stdout so runner can capture it
      process.stdout.write(`BENCHMARK_RESULT:${JSON.stringify(result)}\n`);
      this.log(`Result output: ${result.scenario}`);
      return true;
    });

    // Handler to output openClip timing breakdown to stdout
    ipcMain.handle('benchmark:outputTiming', (event, timing) => {
      process.stdout.write(`OPENCLIP_TIMING:${JSON.stringify(timing)}\n`);
      return true;
    });

    // Handler to output complete signal to stdout
    ipcMain.handle('benchmark:outputComplete', (event, data) => {
      process.stdout.write(`BENCHMARK_COMPLETE:${JSON.stringify(data)}\n`);
      this.log('Benchmark complete signal sent');
      return true;
    });

    // Handler to quit the app after benchmarks complete
    ipcMain.handle('benchmark:quit', () => {
      this.log('Quitting app after benchmark');
      setTimeout(() => {
        app.quit();
      }, 500);
      return true;
    });

    // Handler to trigger garbage collection if exposed
    ipcMain.handle('benchmark:gc', () => {
      if (global.gc) {
        global.gc();
        return true;
      }
      return false;
    });
  }

  /**
   * Get IPC statistics
   */
  getIPCStats() {
    const stats = {};
    
    for (const [channel, timings] of this.ipcTimings) {
      const durations = timings.map(t => t.duration);
      const errors = timings.filter(t => t.isError).length;
      
      if (durations.length === 0) continue;
      
      const sorted = [...durations].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      
      stats[channel] = {
        count: durations.length,
        errors,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: sum / sorted.length,
        total: sum,
        p95: sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1]
      };
    }
    
    return stats;
  }

  /**
   * Get complete benchmark results
   */
  getResults() {
    return {
      startup: this.getStartupMetrics(),
      ipc: this.getIPCStats(),
      metrics: this.metrics.getSummary(),
      memory: this.metrics.getMemorySnapshot(),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get startup-specific metrics
   */
  getStartupMetrics() {
    const summary = this.metrics.getSummary();
    const startupMetrics = {};
    
    for (const [key, value] of Object.entries(summary)) {
      if (key.startsWith('startup:')) {
        startupMetrics[key.replace('startup:', '')] = value;
      }
    }
    
    return startupMetrics;
  }

  /**
   * Instrument a function for benchmarking
   * @param {string} name - Measurement name
   * @param {Function} fn - Function to instrument
   * @returns {Function} Wrapped function
   */
  instrument(name, fn) {
    if (!this.isEnabled) return fn;
    
    const self = this;
    
    if (fn.constructor.name === 'AsyncFunction') {
      return async function(...args) {
        const { result } = await self.metrics.measure(name, () => fn.apply(this, args));
        return result;
      };
    }
    
    return function(...args) {
      const { result } = self.metrics.measureSync(name, () => fn.apply(this, args));
      return result;
    };
  }

  /**
   * Create a wrapper for FFmpeg operations
   * @param {string} operationName - Name of the FFmpeg operation
   * @returns {Object} Start and end functions
   */
  ffmpegTimer(operationName) {
    if (!this.isEnabled) {
      return {
        start: () => {},
        end: () => {},
        error: () => {}
      };
    }

    const self = this;
    const markName = `ffmpeg:${operationName}`;

    return {
      start: () => {
        self.metrics.startMark(markName);
        self.log(`FFmpeg operation started: ${operationName}`);
      },
      end: () => {
        const result = self.metrics.endMark(markName);
        if (result) {
          self.log(`FFmpeg operation completed: ${operationName}`, 
            formatters.duration(result.duration));
        }
        return result;
      },
      error: () => {
        self.metrics.endMark(markName);
        self.log(`FFmpeg operation failed: ${operationName}`);
      }
    };
  }
}

// Create singleton instance
let instance = null;

function getMainHarness() {
  if (!instance) {
    instance = new MainHarness();
  }
  return instance;
}

module.exports = {
  MainHarness,
  getMainHarness
};
