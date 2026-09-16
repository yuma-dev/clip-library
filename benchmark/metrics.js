/**
 * Benchmark Metrics Collection Module
 * 
 * Provides utilities for measuring timing, memory usage, and CPU consumption
 * with aggregation capabilities (min/max/avg/p95).
 */

'use strict';

class Metrics {
  constructor() {
    this.marks = new Map();
    this.measurements = new Map();
    this.cpuBaseline = null;
  }

  /** @param {string} name */
  startMark(name) {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    
    this.marks.set(name, {
      start: performance.now(),
      memory: {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        rss: memory.rss
      },
      cpu: {
        user: cpu.user,
        system: cpu.system
      }
    });
  }

  /**
   * @param {string} name
   * @returns {Object|null}
   */
  endMark(name) {
    const mark = this.marks.get(name);
    if (!mark) {
      console.warn(`[Metrics] No start mark found for: ${name}`);
      return null;
    }

    const endTime = performance.now();
    const endMemory = process.memoryUsage();
    const endCpu = process.cpuUsage();

    const measurement = {
      name,
      duration: endTime - mark.start,
      memory: {
        heapUsedDelta: endMemory.heapUsed - mark.memory.heapUsed,
        heapTotalDelta: endMemory.heapTotal - mark.memory.heapTotal,
        rssDelta: endMemory.rss - mark.memory.rss,
        heapUsedEnd: endMemory.heapUsed,
        heapTotalEnd: endMemory.heapTotal,
        rssEnd: endMemory.rss
      },
      cpu: {
        userDelta: (endCpu.user - mark.cpu.user) / 1000, // Convert to ms
        systemDelta: (endCpu.system - mark.cpu.system) / 1000
      },
      timestamp: Date.now()
    };

    if (!this.measurements.has(name)) {
      this.measurements.set(name, []);
    }
    this.measurements.get(name).push(measurement);

    this.marks.delete(name);

    return measurement;
  }

  /**
   * @param {string} name
   * @param {Function} fn
   * @returns {Promise<{result: any, measurement: Object}>}
   */
  async measure(name, fn) {
    this.startMark(name);
    try {
      const result = await fn();
      const measurement = this.endMark(name);
      return { result, measurement };
    } catch (error) {
      this.endMark(name);
      throw error;
    }
  }

  /**
   * @param {string} name
   * @param {Function} fn
   * @returns {{result: any, measurement: Object}}
   */
  measureSync(name, fn) {
    this.startMark(name);
    try {
      const result = fn();
      const measurement = this.endMark(name);
      return { result, measurement };
    } catch (error) {
      this.endMark(name);
      throw error;
    }
  }

  /**
   * for external timing
   * @param {string} name
   * @param {number} duration
   * @param {Object} [extra={}]
   */
  recordManual(name, duration, extra = {}) {
    const measurement = {
      name,
      duration,
      memory: extra.memory || { heapUsedDelta: 0 },
      cpu: extra.cpu || { userDelta: 0, systemDelta: 0 },
      timestamp: Date.now(),
      ...extra
    };

    if (!this.measurements.has(name)) {
      this.measurements.set(name, []);
    }
    this.measurements.get(name).push(measurement);

    return measurement;
  }

  /**
   * @param {string} name
   * @returns {Object|null}
   */
  getStats(name) {
    const measurements = this.measurements.get(name);
    if (!measurements || measurements.length === 0) {
      return null;
    }

    const durations = measurements.map(m => m.duration);
    const memoryDeltas = measurements.map(m => m.memory.heapUsedDelta);
    const cpuUser = measurements.map(m => m.cpu.userDelta);
    const cpuSystem = measurements.map(m => m.cpu.systemDelta);

    return {
      name,
      count: measurements.length,
      duration: this._calculateStats(durations),
      memory: this._calculateStats(memoryDeltas),
      cpuUser: this._calculateStats(cpuUser),
      cpuSystem: this._calculateStats(cpuSystem),
      measurements: measurements
    };
  }

  /**
   * Calculate statistical measures for an array of values
   * @private
   */
  _calculateStats(values) {
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / sorted.length;

    const squareDiffs = sorted.map(value => Math.pow(value - avg, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / squareDiffs.length;
    const stdDev = Math.sqrt(avgSquareDiff);

    const p50Index = Math.floor(sorted.length * 0.5);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);

    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: avg,
      sum: sum,
      stdDev: stdDev,
      p50: sorted[p50Index] || sorted[sorted.length - 1],
      p95: sorted[p95Index] || sorted[sorted.length - 1],
      p99: sorted[p99Index] || sorted[sorted.length - 1],
      count: sorted.length
    };
  }

  /** @returns {Object} */
  getSummary() {
    const summary = {};
    for (const [name] of this.measurements) {
      summary[name] = this.getStats(name);
    }
    return summary;
  }

  /** @returns {Object} */
  getAllMeasurements() {
    const all = {};
    for (const [name, measurements] of this.measurements) {
      all[name] = measurements;
    }
    return all;
  }

  /** @returns {Object} */
  getMemorySnapshot() {
    const mem = process.memoryUsage();
    return {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      rss: mem.rss,
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
      rssMB: Math.round(mem.rss / 1024 / 1024 * 100) / 100
    };
  }

  reset() {
    this.marks.clear();
    this.measurements.clear();
  }

  /** @returns {string} */
  toJSON() {
    return JSON.stringify({
      summary: this.getSummary(),
      raw: this.getAllMeasurements(),
      memorySnapshot: this.getMemorySnapshot(),
      exportedAt: new Date().toISOString()
    }, null, 2);
  }
}

const formatters = {
  /**
   * @param {number} ms
   * @returns {string}
   */
  duration(ms) {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}min`;
  },

  /**
   * @param {number} bytes
   * @returns {string}
   */
  bytes(bytes) {
    const sign = bytes < 0 ? '-' : '+';
    const abs = Math.abs(bytes);
    if (abs < 1024) return `${sign}${abs}B`;
    if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)}KB`;
    if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / 1024 / 1024).toFixed(1)}MB`;
    return `${sign}${(abs / 1024 / 1024 / 1024).toFixed(2)}GB`;
  },

  /** @param {number} value 0-1 */
  percent(value) {
    return `${(value * 100).toFixed(1)}%`;
  }
};

const globalMetrics = new Metrics();

module.exports = {
  Metrics,
  globalMetrics,
  formatters
};
