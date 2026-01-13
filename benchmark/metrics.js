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

  /**
   * Start a timing mark
   * @param {string} name - Unique identifier for this measurement
   */
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
   * End a timing mark and record the measurement
   * @param {string} name - The mark identifier to end
   * @returns {Object|null} The measurement result or null if mark not found
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

    // Store measurement for aggregation
    if (!this.measurements.has(name)) {
      this.measurements.set(name, []);
    }
    this.measurements.get(name).push(measurement);

    // Clean up the mark
    this.marks.delete(name);

    return measurement;
  }

  /**
   * Measure an async function execution
   * @param {string} name - Measurement name
   * @param {Function} fn - Async function to measure
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
   * Measure a sync function execution
   * @param {string} name - Measurement name
   * @param {Function} fn - Function to measure
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
   * Record a manual measurement (for external timing)
   * @param {string} name - Measurement name
   * @param {number} duration - Duration in ms
   * @param {Object} [extra={}] - Additional data
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
   * Get aggregated statistics for a measurement
   * @param {string} name - Measurement name
   * @returns {Object|null} Aggregated stats or null if not found
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

    // Calculate standard deviation
    const squareDiffs = sorted.map(value => Math.pow(value - avg, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / squareDiffs.length;
    const stdDev = Math.sqrt(avgSquareDiff);

    // Calculate percentiles
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

  /**
   * Get all measurements as a summary object
   * @returns {Object} Summary of all measurements
   */
  getSummary() {
    const summary = {};
    for (const [name] of this.measurements) {
      summary[name] = this.getStats(name);
    }
    return summary;
  }

  /**
   * Get all raw measurements
   * @returns {Object} All raw measurements
   */
  getAllMeasurements() {
    const all = {};
    for (const [name, measurements] of this.measurements) {
      all[name] = measurements;
    }
    return all;
  }

  /**
   * Get current memory snapshot
   * @returns {Object} Current memory usage
   */
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

  /**
   * Reset all measurements
   */
  reset() {
    this.marks.clear();
    this.measurements.clear();
  }

  /**
   * Export measurements to JSON
   * @returns {string} JSON string of all measurements
   */
  toJSON() {
    return JSON.stringify({
      summary: this.getSummary(),
      raw: this.getAllMeasurements(),
      memorySnapshot: this.getMemorySnapshot(),
      exportedAt: new Date().toISOString()
    }, null, 2);
  }
}

// Helper functions for formatting
const formatters = {
  /**
   * Format duration in human-readable form
   * @param {number} ms - Duration in milliseconds
   * @returns {string} Formatted duration
   */
  duration(ms) {
    if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}min`;
  },

  /**
   * Format bytes in human-readable form
   * @param {number} bytes - Size in bytes
   * @returns {string} Formatted size
   */
  bytes(bytes) {
    const sign = bytes < 0 ? '-' : '+';
    const abs = Math.abs(bytes);
    if (abs < 1024) return `${sign}${abs}B`;
    if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)}KB`;
    if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / 1024 / 1024).toFixed(1)}MB`;
    return `${sign}${(abs / 1024 / 1024 / 1024).toFixed(2)}GB`;
  },

  /**
   * Format percentage
   * @param {number} value - Value between 0 and 1
   * @returns {string} Formatted percentage
   */
  percent(value) {
    return `${(value * 100).toFixed(1)}%`;
  }
};

// Singleton instance for shared use
const globalMetrics = new Metrics();

module.exports = {
  Metrics,
  globalMetrics,
  formatters
};
