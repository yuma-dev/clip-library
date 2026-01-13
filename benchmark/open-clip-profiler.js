/**
 * Detailed Open Clip Profiler
 * 
 * Provides granular timing for each phase of clip opening to identify
 * exactly what causes the perceived delay and variance.
 */

'use strict';

const { ipcRenderer } = require('electron');
const path = require('path');

class OpenClipProfiler {
  constructor() {
    this.results = [];
    this.currentProfile = null;
  }

  /**
   * Start a new profiling session
   */
  startProfile(clipName) {
    this.currentProfile = {
      clipName,
      startTime: performance.now(),
      phases: {},
      ipcCalls: [],
      events: [],
      memory: {
        start: this.getMemory(),
        end: null
      }
    };
    return this.currentProfile;
  }

  /**
   * Mark the start of a phase
   */
  startPhase(phaseName) {
    if (!this.currentProfile) return;
    this.currentProfile.phases[phaseName] = {
      start: performance.now(),
      end: null,
      duration: null
    };
  }

  /**
   * Mark the end of a phase
   */
  endPhase(phaseName) {
    if (!this.currentProfile || !this.currentProfile.phases[phaseName]) return;
    const phase = this.currentProfile.phases[phaseName];
    phase.end = performance.now();
    phase.duration = phase.end - phase.start;
    return phase.duration;
  }

  /**
   * Time an IPC call
   */
  async timeIPC(channel, ...args) {
    const start = performance.now();
    try {
      const result = await ipcRenderer.invoke(channel, ...args);
      const duration = performance.now() - start;
      if (this.currentProfile) {
        this.currentProfile.ipcCalls.push({ channel, duration, success: true });
      }
      return { result, duration };
    } catch (error) {
      const duration = performance.now() - start;
      if (this.currentProfile) {
        this.currentProfile.ipcCalls.push({ channel, duration, success: false, error: error.message });
      }
      throw error;
    }
  }

  /**
   * Record a video event timing
   */
  recordEvent(eventName) {
    if (!this.currentProfile) return;
    this.currentProfile.events.push({
      name: eventName,
      time: performance.now(),
      relativeTime: performance.now() - this.currentProfile.startTime
    });
  }

  /**
   * End the current profile
   */
  endProfile() {
    if (!this.currentProfile) return null;
    
    this.currentProfile.memory.end = this.getMemory();
    this.currentProfile.totalDuration = performance.now() - this.currentProfile.startTime;
    
    const result = this.currentProfile;
    this.results.push(result);
    this.currentProfile = null;
    
    return result;
  }

  /**
   * Get memory usage
   */
  getMemory() {
    if (typeof process !== 'undefined' && process.memoryUsage) {
      const mem = process.memoryUsage();
      return {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external
      };
    }
    // Fallback for renderer without node integration
    if (performance.memory) {
      return {
        heapUsed: performance.memory.usedJSHeapSize,
        heapTotal: performance.memory.totalJSHeapSize,
        external: 0
      };
    }
    return null;
  }

  /**
   * Get all results
   */
  getResults() {
    return this.results;
  }

  /**
   * Clear results
   */
  clear() {
    this.results = [];
    this.currentProfile = null;
  }

  /**
   * Generate a detailed report
   */
  generateReport() {
    if (this.results.length === 0) {
      return { error: 'No profiling data available' };
    }

    // Aggregate phase timings across all runs
    const phaseAggregates = {};
    const ipcAggregates = {};
    const totalDurations = [];

    for (const result of this.results) {
      totalDurations.push(result.totalDuration);

      // Aggregate phases
      for (const [phaseName, phase] of Object.entries(result.phases)) {
        if (phase.duration === null) continue;
        
        if (!phaseAggregates[phaseName]) {
          phaseAggregates[phaseName] = [];
        }
        phaseAggregates[phaseName].push(phase.duration);
      }

      // Aggregate IPC calls
      for (const ipc of result.ipcCalls) {
        if (!ipcAggregates[ipc.channel]) {
          ipcAggregates[ipc.channel] = [];
        }
        ipcAggregates[ipc.channel].push(ipc.duration);
      }
    }

    // Calculate statistics
    const calcStats = (arr) => {
      if (arr.length === 0) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      const avg = sum / arr.length;
      
      // Calculate variance correctly
      let variance = 0;
      if (arr.length > 1) {
        const squaredDiffs = arr.map(val => Math.pow(val - avg, 2));
        const sumSquaredDiffs = squaredDiffs.reduce((a, b) => a + b, 0);
        variance = sumSquaredDiffs / (arr.length - 1);
      }
      
      return {
        count: arr.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: avg,
        median: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1],
        variance: variance,
        stdDev: 0
      };
    };

    const phaseStats = {};
    for (const [name, durations] of Object.entries(phaseAggregates)) {
      const stats = calcStats(durations);
      if (stats) {
        stats.stdDev = Math.sqrt(stats.variance);
        stats.percentOfTotal = (stats.avg / (calcStats(totalDurations)?.avg || 1)) * 100;
        phaseStats[name] = stats;
      }
    }

    const ipcStats = {};
    for (const [channel, durations] of Object.entries(ipcAggregates)) {
      const stats = calcStats(durations);
      if (stats) {
        stats.stdDev = Math.sqrt(stats.variance);
        ipcStats[channel] = stats;
      }
    }

    const totalStats = calcStats(totalDurations);
    if (totalStats) {
      totalStats.stdDev = Math.sqrt(totalStats.variance);
    }

    return {
      runs: this.results.length,
      total: totalStats,
      phases: phaseStats,
      ipc: ipcStats,
      // Identify bottlenecks (phases taking >20% of total time)
      bottlenecks: Object.entries(phaseStats)
        .filter(([_, stats]) => stats.percentOfTotal > 20)
        .sort((a, b) => b[1].avg - a[1].avg)
        .map(([name, stats]) => ({
          phase: name,
          avgDuration: stats.avg,
          percentOfTotal: stats.percentOfTotal,
          variance: stats.stdDev
        })),
      // Identify high-variance phases (coefficient of variation > 0.5)
      highVariance: Object.entries(phaseStats)
        .filter(([_, stats]) => (stats.stdDev / stats.avg) > 0.5)
        .map(([name, stats]) => ({
          phase: name,
          avgDuration: stats.avg,
          stdDev: stats.stdDev,
          coefficientOfVariation: stats.stdDev / stats.avg
        }))
    };
  }
}

/**
 * Run a detailed benchmark of clip opening
 * @param {Object} options - Benchmark options
 * @returns {Object} Detailed profiling results
 */
async function benchmarkOpenClipDetailed(options = {}) {
  const {
    iterations = 5,
    warmupRuns = 1,
    delayBetweenRuns = 1000,
    testDifferentClips = true,
    getAllClips = null,
    videoPlayer = null,
    closePlayerFn = null,
    logger = console
  } = options;

  const profiler = new OpenClipProfiler();
  
  // Get clips to test
  let clips = [];
  if (getAllClips) {
    const allClips = typeof getAllClips === 'function' ? getAllClips() : getAllClips;
    clips = allClips.slice(0, testDifferentClips ? Math.min(5, allClips.length) : 1);
  }
  
  if (clips.length === 0) {
    return { error: 'No clips available for testing' };
  }

  logger.info(`[OpenClip Profiler] Starting detailed benchmark with ${iterations} iterations on ${clips.length} clips`);

  // Run warmup
  for (let w = 0; w < warmupRuns; w++) {
    logger.info(`[OpenClip Profiler] Warmup run ${w + 1}/${warmupRuns}`);
    await profileSingleOpen(profiler, clips[0], videoPlayer, closePlayerFn, logger);
    await delay(500);
  }
  profiler.clear(); // Clear warmup data

  // Run actual benchmark iterations
  for (let i = 0; i < iterations; i++) {
    const clipIndex = testDifferentClips ? (i % clips.length) : 0;
    const clip = clips[clipIndex];
    
    logger.info(`[OpenClip Profiler] Iteration ${i + 1}/${iterations} - Clip: ${clip.originalName}`);
    
    await profileSingleOpen(profiler, clip, videoPlayer, closePlayerFn, logger);
    
    if (i < iterations - 1) {
      await delay(delayBetweenRuns);
    }
  }

  const report = profiler.generateReport();
  
  // Log summary
  // Generate formatted console output
  const consoleOutput = formatProfilerReport(report);
  for (const line of consoleOutput) {
    logger.info(line);
  }

  return {
    report,
    rawResults: profiler.getResults()
  };
}

/**
 * Profile a single clip open operation
 */
async function profileSingleOpen(profiler, clip, videoPlayer, closePlayerFn, logger) {
  const profile = profiler.startProfile(clip.originalName);
  
  // Close any open player first
  if (closePlayerFn) {
    profiler.startPhase('closeExistingPlayer');
    await closePlayerFn();
    profiler.endPhase('closeExistingPlayer');
    await delay(100);
  }

  // Phase 1: Get thumbnail path
  profiler.startPhase('getThumbnailPath');
  const { result: thumbnailPath, duration: thumbDuration } = await profiler.timeIPC('get-thumbnail-path', clip.originalName);
  profiler.endPhase('getThumbnailPath');

  // Phase 2: Get clip data (parallel IPC calls)
  profiler.startPhase('getClipData');
  const clipDataStart = performance.now();
  
  // Time each IPC call individually even though they run in parallel
  const [clipInfoResult, trimResult, tagsResult] = await Promise.all([
    profiler.timeIPC('get-clip-info', clip.originalName),
    profiler.timeIPC('get-trim', clip.originalName),
    profiler.timeIPC('get-clip-tags', clip.originalName)
  ]);
  
  profiler.endPhase('getClipData');

  const clipInfo = clipInfoResult.result;
  const trimData = trimResult.result;
  
  // Phase 3: Set video source and wait for metadata
  profiler.startPhase('videoMetadataLoad');
  
  if (videoPlayer) {
    // Clear previous source
    if (videoPlayer.src) {
      videoPlayer.pause();
      videoPlayer.removeAttribute('src');
      videoPlayer.load();
    }
    
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        videoPlayer.removeEventListener('loadedmetadata', handler);
        reject(new Error('Metadata load timeout'));
      }, 10000);
      
      const handler = () => {
        clearTimeout(timeout);
        profiler.recordEvent('loadedmetadata');
        resolve();
      };
      
      videoPlayer.addEventListener('loadedmetadata', handler, { once: true });
      videoPlayer.src = `file://${clipInfo.format.filename}`;
    });
  }
  profiler.endPhase('videoMetadataLoad');

  // Phase 4: Initial seek
  profiler.startPhase('initialSeek');
  
  if (videoPlayer) {
    const seekTarget = trimData ? trimData.start : 
      (clipInfo.format.duration > 40 ? clipInfo.format.duration / 2 : 0);
    
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        videoPlayer.removeEventListener('seeked', handler);
        reject(new Error('Seek timeout'));
      }, 5000);
      
      const handler = () => {
        clearTimeout(timeout);
        profiler.recordEvent('seeked');
        resolve();
      };
      
      videoPlayer.addEventListener('seeked', handler, { once: true });
      videoPlayer.currentTime = seekTarget;
    });
  }
  profiler.endPhase('initialSeek');

  // Phase 5: Load volume settings
  profiler.startPhase('loadVolume');
  await profiler.timeIPC('get-volume', clip.originalName);
  profiler.endPhase('loadVolume');

  // Phase 6: Load speed settings  
  profiler.startPhase('loadSpeed');
  await profiler.timeIPC('get-speed', clip.originalName);
  profiler.endPhase('loadSpeed');

  // Phase 7: Start playback
  profiler.startPhase('startPlayback');
  
  if (videoPlayer) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        videoPlayer.removeEventListener('playing', handler);
        // Don't reject, just resolve - video might be paused intentionally
        resolve();
      }, 3000);
      
      const handler = () => {
        clearTimeout(timeout);
        profiler.recordEvent('playing');
        resolve();
      };
      
      videoPlayer.addEventListener('playing', handler, { once: true });
      videoPlayer.play().catch(e => {
        clearTimeout(timeout);
        videoPlayer.removeEventListener('playing', handler);
        // AbortError is expected when rapidly switching clips
        if (e.name !== 'AbortError') {
          logger.warn('Play error:', e);
        }
        resolve();
      });
    });
  }
  profiler.endPhase('startPlayback');

  // Phase 8: Wait for canplay (video ready for smooth playback)
  profiler.startPhase('canplayReady');
  
  if (videoPlayer) {
    if (videoPlayer.readyState >= 3) {
      // Already ready
      profiler.recordEvent('canplay');
    } else {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          videoPlayer.removeEventListener('canplay', handler);
          resolve();
        }, 3000);
        
        const handler = () => {
          clearTimeout(timeout);
          profiler.recordEvent('canplay');
          resolve();
        };
        
        videoPlayer.addEventListener('canplay', handler, { once: true });
      });
    }
  }
  profiler.endPhase('canplayReady');

  return profiler.endProfile();
}

/**
 * Helper delay function
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format duration for display
 */
function formatDuration(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Format a table row with fixed column widths
 */
function formatTableRow(values, widths) {
  return values.map((val, i) => {
    const str = String(val);
    const width = widths[i] || 10;
    return str.length > width ? str.substring(0, width - 2) + '..' : str.padEnd(width);
  }).join(' ');
}

/**
 * Generate a formatted console report from profiler results
 * @param {Object} report - The profiler report
 * @returns {string[]} Array of lines for console output
 */
function formatProfilerReport(report) {
  const lines = [];
  
  lines.push('');
  lines.push('═'.repeat(70));
  lines.push('           OPEN CLIP DETAILED PROFILER RESULTS');
  lines.push('═'.repeat(70));
  lines.push('');
  
  // Summary
  lines.push(`Runs: ${report.runs}`);
  if (report.total) {
    lines.push(`Total Time: avg=${formatDuration(report.total.avg)}, min=${formatDuration(report.total.min)}, max=${formatDuration(report.total.max)}`);
    lines.push(`Variance (stdDev): ${formatDuration(report.total.stdDev)}`);
  }
  lines.push('');
  
  // Phase breakdown table
  lines.push('PHASE BREAKDOWN (sorted by avg time)');
  lines.push('─'.repeat(70));
  lines.push(formatTableRow(['Phase', 'Avg', 'Min', 'Max', '% Total', 'StdDev'], [24, 10, 10, 10, 8, 10]));
  lines.push('─'.repeat(70));
  
  const sortedPhases = Object.entries(report.phases || {})
    .sort((a, b) => b[1].avg - a[1].avg);
  
  for (const [phase, stats] of sortedPhases) {
    lines.push(formatTableRow([
      phase,
      formatDuration(stats.avg),
      formatDuration(stats.min),
      formatDuration(stats.max),
      `${stats.percentOfTotal.toFixed(1)}%`,
      `±${formatDuration(stats.stdDev)}`
    ], [24, 10, 10, 10, 8, 10]));
  }
  lines.push('─'.repeat(70));
  lines.push('');
  
  // IPC breakdown
  lines.push('IPC CALL TIMINGS');
  lines.push('─'.repeat(70));
  lines.push(formatTableRow(['Channel', 'Avg', 'Min', 'Max', 'Calls', 'StdDev'], [28, 10, 10, 8, 6, 10]));
  lines.push('─'.repeat(70));
  
  const sortedIPC = Object.entries(report.ipc || {})
    .sort((a, b) => b[1].avg - a[1].avg);
  
  for (const [channel, stats] of sortedIPC) {
    lines.push(formatTableRow([
      channel,
      formatDuration(stats.avg),
      formatDuration(stats.min),
      formatDuration(stats.max),
      String(stats.count),
      `±${formatDuration(stats.stdDev)}`
    ], [28, 10, 10, 8, 6, 10]));
  }
  lines.push('─'.repeat(70));
  lines.push('');
  
  // Bottlenecks
  if (report.bottlenecks && report.bottlenecks.length > 0) {
    lines.push('⚠️  BOTTLENECKS (>20% of total time)');
    lines.push('─'.repeat(70));
    for (const b of report.bottlenecks) {
      const bar = '█'.repeat(Math.min(Math.floor(b.percentOfTotal / 2), 40));
      lines.push(`  ${b.phase.padEnd(22)} ${formatDuration(b.avgDuration).padEnd(10)} ${bar} ${b.percentOfTotal.toFixed(1)}%`);
    }
    lines.push('');
  }
  
  // High variance
  if (report.highVariance && report.highVariance.length > 0) {
    lines.push('⚠️  HIGH VARIANCE PHASES (coefficient of variation > 0.5)');
    lines.push('─'.repeat(70));
    for (const v of report.highVariance) {
      lines.push(`  ${v.phase.padEnd(22)} avg=${formatDuration(v.avgDuration)}, stdDev=${formatDuration(v.stdDev)}, CoV=${v.coefficientOfVariation.toFixed(2)}`);
    }
    lines.push('');
  }
  
  // Analysis
  lines.push('ANALYSIS');
  lines.push('─'.repeat(70));
  
  // Calculate what percentage of time is spent on each type of operation
  let ipcTime = 0, videoTime = 0, otherTime = 0;
  for (const [phase, stats] of sortedPhases) {
    if (phase.includes('IPC') || phase.includes('get') || phase.includes('load') && phase !== 'videoMetadataLoad') {
      ipcTime += stats.avg;
    } else if (phase.includes('video') || phase.includes('seek') || phase.includes('play') || phase.includes('canplay')) {
      videoTime += stats.avg;
    } else {
      otherTime += stats.avg;
    }
  }
  
  const totalTime = report.total?.avg || (ipcTime + videoTime + otherTime);
  
  // Recalculate based on actual phases
  const ipcPhases = ['getThumbnailPath', 'getClipData', 'loadVolume', 'loadSpeed'];
  const videoPhases = ['videoMetadataLoad', 'initialSeek', 'startPlayback', 'canplayReady'];
  
  let ipcTotal = 0, videoTotal = 0;
  for (const [phase, stats] of sortedPhases) {
    if (ipcPhases.includes(phase)) ipcTotal += stats.avg;
    if (videoPhases.includes(phase)) videoTotal += stats.avg;
  }
  
  lines.push(`  IPC Operations:     ${formatDuration(ipcTotal).padEnd(10)} (${((ipcTotal / totalTime) * 100).toFixed(1)}%)`);
  lines.push(`  Video Operations:   ${formatDuration(videoTotal).padEnd(10)} (${((videoTotal / totalTime) * 100).toFixed(1)}%)`);
  lines.push(`  Other:              ${formatDuration(totalTime - ipcTotal - videoTotal).padEnd(10)} (${(((totalTime - ipcTotal - videoTotal) / totalTime) * 100).toFixed(1)}%)`);
  lines.push('');
  
  // Recommendations
  lines.push('RECOMMENDATIONS');
  lines.push('─'.repeat(70));
  
  const recommendations = [];
  
  // Check for slow phases
  for (const [phase, stats] of sortedPhases) {
    if (phase === 'getThumbnailPath' && stats.avg > 20) {
      recommendations.push('• Cache thumbnail paths in memory to avoid repeated IPC calls');
    }
    if (phase === 'getClipData' && stats.avg > 15) {
      recommendations.push('• Consider caching clip metadata after first load');
    }
    if (phase === 'videoMetadataLoad' && stats.avg > 30) {
      recommendations.push('• Video metadata load is slow - ensure videos have fast-seek keyframes');
    }
    if (phase === 'initialSeek' && stats.avg > 30) {
      recommendations.push('• Initial seek is slow - consider seeking to nearest keyframe');
    }
    if (phase === 'startPlayback' && stats.avg > 50) {
      recommendations.push('• Playback startup is slow - check for heavy event handlers');
    }
  }
  
  // Check for high variance
  for (const v of (report.highVariance || [])) {
    if (v.phase === 'getThumbnailPath') {
      recommendations.push('• Thumbnail path lookup has high variance - check disk I/O');
    }
    if (v.phase === 'videoMetadataLoad') {
      recommendations.push('• Video metadata load has high variance - may depend on file size/location');
    }
  }
  
  if (recommendations.length === 0) {
    recommendations.push('• No significant issues detected');
  }
  
  for (const rec of [...new Set(recommendations)]) {  // Dedupe
    lines.push(rec);
  }
  
  lines.push('');
  lines.push('═'.repeat(70));
  lines.push('');
  
  return lines;
}

module.exports = {
  OpenClipProfiler,
  benchmarkOpenClipDetailed,
  profileSingleOpen,
  formatDuration,
  formatProfilerReport
};
