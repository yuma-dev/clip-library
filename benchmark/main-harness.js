/**
 * Instruments the main process for benchmarking: startup timing, IPC call
 * timing, FFmpeg operations, file system operations.
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

  /** @param {string} phase */
  markStartup(phase) {
    if (!this.isEnabled) return;
    
    this.metrics.startMark(`startup:${phase}`);
    this.log(`Startup phase started: ${phase}`);
  }

  /**
   * @param {string} phase
   * @returns {Object|null}
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

  recordAppReady() {
    if (!this.isEnabled) return;
    
    const appReadyTime = Date.now() - this.processStartTime;
    this.metrics.recordManual('startup:appReady', appReadyTime);
    this.log(`App ready in ${formatters.duration(appReadyTime)}`);
  }

  setupIPCInterception() {
    const originalHandle = ipcMain.handle.bind(ipcMain);
    const self = this;

    ipcMain.handle = function(channel, handler) {
      const wrappedHandler = async (event, ...args) => {
        const startTime = performance.now();
        const startMemory = process.memoryUsage().heapUsed;
        
        try {
          const result = await handler(event, ...args);
          
          const duration = performance.now() - startTime;
          const memoryDelta = process.memoryUsage().heapUsed - startMemory;

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

    this.metrics.recordManual(`ipc:${channel}`, duration, {
      memory: { heapUsedDelta: memoryDelta },
      isError
    });

    if (this.verbose && duration > 50) {
      this.log(`IPC [${channel}]: ${formatters.duration(duration)}`);
    }
  }

  setupBenchmarkIPC() {
    ipcMain.handle('benchmark:getMainMetrics', () => {
      return {
        summary: this.metrics.getSummary(),
        ipcTimings: this.getIPCStats(),
        memory: this.metrics.getMemorySnapshot()
      };
    });

    ipcMain.handle('benchmark:markPhase', (event, phase) => {
      this.metrics.startMark(`phase:${phase}`);
      return true;
    });

    ipcMain.handle('benchmark:endPhase', (event, phase) => {
      return this.metrics.endMark(`phase:${phase}`);
    });

    ipcMain.handle('benchmark:getResults', () => {
      return this.getResults();
    });

    ipcMain.handle('benchmark:reset', () => {
      this.metrics.reset();
      this.ipcTimings.clear();
      return true;
    });

    // for runner to capture
    ipcMain.handle('benchmark:outputResult', (event, result) => {
      process.stdout.write(`BENCHMARK_RESULT:${JSON.stringify(result)}\n`);
      this.log(`Result output: ${result.scenario}`);
      return true;
    });

    ipcMain.handle('benchmark:outputTiming', (event, timing) => {
      process.stdout.write(`OPENCLIP_TIMING:${JSON.stringify(timing)}\n`);
      return true;
    });

    // renderer console.log doesn't reach the spawned Electron's stdout; anything the
    // runner's line parser needs (e.g. AUDIO_TRACK_COMPARE) round-trips through here
    ipcMain.handle('benchmark:outputMarker', (event, marker, payload) => {
      const safeMarker = String(marker || '').replace(/[^A-Z0-9_]/gi, '');
      if (!safeMarker) return false;
      process.stdout.write(`${safeMarker}:${JSON.stringify(payload)}\n`);
      return true;
    });

    ipcMain.handle('benchmark:outputComplete', (event, data) => {
      process.stdout.write(`BENCHMARK_COMPLETE:${JSON.stringify(data)}\n`);
      this.log('Benchmark complete signal sent');
      return true;
    });

    ipcMain.handle('benchmark:quit', () => {
      this.log('Quitting app after benchmark');
      setTimeout(() => {
        app.quit();
      }, 500);
      return true;
    });

    // global.gc only exists if node started with --expose-gc
    ipcMain.handle('benchmark:gc', () => {
      if (global.gc) {
        global.gc();
        return true;
      }
      return false;
    });
  }

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

  getResults() {
    return {
      startup: this.getStartupMetrics(),
      ipc: this.getIPCStats(),
      metrics: this.metrics.getSummary(),
      memory: this.metrics.getMemorySnapshot(),
      timestamp: new Date().toISOString()
    };
  }

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
   * @param {string} name
   * @param {Function} fn
   * @returns {Function}
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
   * @param {string} operationName
   * @returns {Object} start/end/error functions
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
