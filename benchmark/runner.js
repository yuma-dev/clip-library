#!/usr/bin/env node

/**
 * Benchmark Runner
 * 
 * CLI entry point for running benchmarks.
 * Spawns Electron in benchmark mode and orchestrates test execution.
 * 
 * Usage:
 *   npm run benchmark              # Run standard suite
 *   npm run benchmark -- --suite full
 *   npm run benchmark -- --scenario open_clip
 *   npm run benchmark -- --verbose
 *   npm run benchmark -- --output json
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getSuite, getScenario, listScenarios, listSuites, SUITES } = require('./scenarios');
const { generateConsoleReport, generateJSONReport, generateHTMLReport } = require('./report');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    suite: 'standard',
    scenario: null,
    verbose: false,
    output: 'console',
    outputFile: null,
    list: false,
    help: false,
    iterations: 1,
    warmup: true,
    timeout: 120000 // 2 minutes default timeout
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--suite':
      case '-s':
        options.suite = args[++i];
        break;
      case '--scenario':
        options.scenario = args[++i];
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--output':
      case '-o':
        options.output = args[++i];
        break;
      case '--output-file':
      case '-f':
        options.outputFile = args[++i];
        break;
      case '--list':
      case '-l':
        options.list = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--iterations':
      case '-i':
        options.iterations = parseInt(args[++i], 10) || 1;
        break;
      case '--no-warmup':
        options.warmup = false;
        break;
      case '--timeout':
      case '-t':
        options.timeout = parseInt(args[++i], 10) || 120000;
        break;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Clips Benchmark Runner

Usage: npm run benchmark [options]

Options:
  --suite, -s <name>      Run a predefined suite (default: standard)
                          Available: ${Object.keys(SUITES).join(', ')}
  --scenario <id>         Run a specific scenario by ID
  --verbose, -v           Show detailed output during execution
  --output, -o <format>   Output format: console, json, html (default: console)
  --output-file, -f       Save report to file (auto-generates name if not specified)
  --list, -l              List all available scenarios and suites
  --iterations, -i <n>    Run each scenario n times (default: 1)
  --no-warmup             Skip warmup run
  --timeout, -t <ms>      Timeout for benchmark run (default: 120000)
  --help, -h              Show this help message

Examples:
  npm run benchmark                        # Run standard suite
  npm run benchmark -- --suite full        # Run all scenarios
  npm run benchmark -- --scenario open_clip # Run single scenario
  npm run benchmark -- -v -o json          # Verbose with JSON output
  npm run benchmark -- --list              # Show available scenarios
`);
}

function showList() {
  console.log('\n=== Available Benchmark Suites ===\n');
  const suites = listSuites();
  for (const [name, info] of Object.entries(suites)) {
    console.log(`  ${name.padEnd(12)} (${info.count} scenarios)`);
    info.scenarios.slice(0, 3).forEach(s => console.log(`    - ${s}`));
    if (info.scenarios.length > 3) {
      console.log(`    ... and ${info.scenarios.length - 3} more`);
    }
    console.log();
  }

  console.log('\n=== Available Scenarios ===\n');
  const scenarios = listScenarios();
  const byCategory = {};
  
  scenarios.forEach(s => {
    if (!byCategory[s.category]) byCategory[s.category] = [];
    byCategory[s.category].push(s);
  });

  for (const [category, items] of Object.entries(byCategory)) {
    console.log(`[${category.toUpperCase()}]`);
    items.forEach(s => {
      console.log(`  ${s.id.padEnd(25)} ${s.name}`);
    });
    console.log();
  }
}

class BenchmarkRunner {
  constructor(options) {
    this.options = options;
    this.results = {
      startTime: new Date().toISOString(),
      options: options,
      system: this.getSystemInfo(),
      scenarios: {},
      summary: null
    };
    this.electronProcess = null;
  }

  getSystemInfo() {
    const os = require('os');
    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || 'Unknown',
      totalMemory: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 100) / 100 + ' GB',
      freeMemory: Math.round(os.freemem() / 1024 / 1024 / 1024 * 100) / 100 + ' GB'
    };
  }

  log(message, data = null) {
    if (this.options.verbose) {
      const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
      if (data) {
        console.log(`[${timestamp}] ${message}`, data);
      } else {
        console.log(`[${timestamp}] ${message}`);
      }
    }
  }

  async run() {
    console.log('\n=== Clips Benchmark Runner ===\n');
    console.log(`System: ${this.results.system.platform} ${this.results.system.arch}`);
    console.log(`CPU: ${this.results.system.cpuModel} (${this.results.system.cpus} cores)`);
    console.log(`Memory: ${this.results.system.totalMemory} total, ${this.results.system.freeMemory} free`);
    console.log();

    // Get scenarios to run
    let scenarios;
    if (this.options.scenario) {
      const scenario = getScenario(this.options.scenario);
      if (!scenario) {
        console.error(`Unknown scenario: ${this.options.scenario}`);
        console.log('Use --list to see available scenarios');
        process.exit(1);
      }
      scenarios = [scenario];
    } else {
      try {
        scenarios = getSuite(this.options.suite);
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    }

    // Filter to only renderer-executable scenarios
    const executableScenarios = scenarios.filter(s => s.renderer === true);
    
    console.log(`Running ${executableScenarios.length} executable scenarios from suite: ${this.options.suite}`);
    if (scenarios.length !== executableScenarios.length) {
      console.log(`  (${scenarios.length - executableScenarios.length} startup/non-renderer scenarios skipped)`);
    }
    if (this.options.iterations > 1) {
      console.log(`Iterations per scenario: ${this.options.iterations}`);
    }
    console.log();

    if (executableScenarios.length === 0) {
      console.log('No executable scenarios found. Exiting.');
      return this.results;
    }

    // Run warmup if enabled
    if (this.options.warmup && executableScenarios.length > 0) {
      console.log('Running warmup...');
      await this.runElectronBenchmark(executableScenarios.slice(0, 1), true);
      console.log('Warmup complete.\n');
    }

    // Run actual benchmarks
    console.log('Starting benchmarks...\n');
    
    for (let iteration = 0; iteration < this.options.iterations; iteration++) {
      if (this.options.iterations > 1) {
        console.log(`\n--- Iteration ${iteration + 1}/${this.options.iterations} ---\n`);
      }
      
      await this.runElectronBenchmark(executableScenarios, false, iteration);
    }

    // Calculate summary
    this.calculateSummary();
    
    // Generate report
    this.generateReport();

    return this.results;
  }

  async runElectronBenchmark(scenarios, isWarmup = false, iteration = 0) {
    return new Promise((resolve, reject) => {
      const electronPath = require('electron');
      const appPath = path.join(__dirname, '..');
      
      // Environment for benchmark mode
      const env = {
        ...process.env,
        CLIPS_BENCHMARK: '1',
        CLIPS_BENCHMARK_VERBOSE: this.options.verbose ? '1' : '0',
        CLIPS_BENCHMARK_SCENARIOS: JSON.stringify(scenarios.map(s => s.id)),
        CLIPS_BENCHMARK_WARMUP: isWarmup ? '1' : '0',
        CLIPS_BENCHMARK_ITERATION: String(iteration)
      };

      this.log('Spawning Electron with benchmark mode');
      this.log('Scenarios:', scenarios.map(s => s.id).join(', '));
      
      const electronProcess = spawn(electronPath, [appPath], {
        env,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      });

      this.electronProcess = electronProcess;
      let outputBuffer = '';
      let benchmarkData = null;
      let resultsReceived = 0;

      // Parse output line by line for better marker detection
      const processOutput = (output) => {
        outputBuffer += output;
        
        // Split by lines and process each
        const lines = outputBuffer.split('\n');
        // Keep incomplete last line in buffer
        outputBuffer = lines.pop() || '';
        
        for (const line of lines) {
          // Look for benchmark result markers
          if (line.includes('BENCHMARK_RESULT:')) {
            const match = line.match(/BENCHMARK_RESULT:(.+)/);
            if (match) {
              try {
                const result = JSON.parse(match[1]);
                resultsReceived++;
                if (!isWarmup) {
                  this.processScenarioResult(result, iteration);
                }
              } catch (e) {
                this.log('Failed to parse benchmark result:', e.message);
                this.log('Raw line:', line);
              }
            }
          }

          // Look for openClip timing breakdown
          if (line.includes('OPENCLIP_TIMING:')) {
            const match = line.match(/OPENCLIP_TIMING:(.+)/);
            if (match) {
              try {
                const timing = JSON.parse(match[1]);
                // Store timing data and print it
                if (!this.results.openClipTimings) {
                  this.results.openClipTimings = [];
                }
                this.results.openClipTimings.push(timing);

                // Print timing breakdown
                console.log(`\n  📊 openClip timing for ${timing.clip}:`);
                for (const [phase, data] of Object.entries(timing.breakdown)) {
                  const bar = '█'.repeat(Math.min(Math.floor(data.delta / 20), 30));
                  console.log(`     ${phase.padEnd(20)} +${data.delta.toFixed(0).padStart(4)}ms ${bar}`);
                }
                console.log(`     ${'TOTAL'.padEnd(20)} ${timing.total.toFixed(0).padStart(5)}ms`);
              } catch (e) {
                this.log('Failed to parse timing:', e.message);
              }
            }
          }

          // Look for startup detailed breakdown
          if (line.includes('STARTUP_BREAKDOWN:')) {
            const match = line.match(/STARTUP_BREAKDOWN:(.+)/);
            if (match) {
              try {
                const report = JSON.parse(match[1]);
                this.results.startupBreakdown = report;

                // Print detailed breakdown
                console.log('\n  ========== STARTUP DETAILED BREAKDOWN ==========');
                console.log(`  Total Time: ${report.totalTime.toFixed(1)}ms`);
                console.log(`  Clips: ${report.clipCount} found, ${report.renderedClips} rendered, ${report.groupCount} groups`);
                console.log('');
                console.log('  Phase                              Duration    % Total');
                console.log('  ' + '─'.repeat(55));

                // Sort for bottleneck analysis
                const sortedPhases = [...report.phases].sort((a, b) => b.duration - a.duration);

                for (const phase of report.phases) {
                  const bar = '█'.repeat(Math.round(parseFloat(phase.percentage) / 5));
                  const name = phase.name.padEnd(35);
                  const dur = `${phase.duration.toFixed(1)}ms`.padStart(8);
                  const pct = `${phase.percentage}%`.padStart(6);
                  console.log(`  ${name} ${dur} ${pct} ${bar}`);
                }

                console.log('  ' + '─'.repeat(55));
                console.log('');
                console.log('  TOP BOTTLENECKS:');
                for (let i = 0; i < Math.min(3, sortedPhases.length); i++) {
                  const p = sortedPhases[i];
                  console.log(`    ${i + 1}. ${p.name}: ${p.duration.toFixed(1)}ms (${p.percentage}%)`);
                }

                if (report.tagBatchDetails && report.tagBatchDetails.batchCount > 1) {
                  console.log('');
                  console.log(`  Tag Loading Details: ${report.tagBatchDetails.batchCount} batches`);
                  console.log(`    Avg batch: ${report.tagBatchDetails.avgBatchTime.toFixed(1)}ms`);
                  const batchTimes = report.tagBatchDetails.batchTimes;
                  console.log(`    Min batch: ${Math.min(...batchTimes).toFixed(1)}ms`);
                  console.log(`    Max batch: ${Math.max(...batchTimes).toFixed(1)}ms`);
                }

                console.log('  ================================================\n');
              } catch (e) {
                this.log('Failed to parse startup breakdown:', e.message);
              }
            }
          }

          // Look for final results
          if (line.includes('BENCHMARK_COMPLETE:')) {
            const match = line.match(/BENCHMARK_COMPLETE:(.+)/);
            if (match) {
              try {
                benchmarkData = JSON.parse(match[1]);
                this.log('Received complete benchmark data');
              } catch (e) {
                this.log('Failed to parse final results:', e.message);
              }
            }
          }

          if (this.options.verbose) {
            console.log(line);
          }
        }
      };

      electronProcess.stdout.on('data', (data) => {
        processOutput(data.toString());
      });

      electronProcess.stderr.on('data', (data) => {
        const output = data.toString();
        // Also check stderr for markers (Electron sometimes mixes streams)
        processOutput(output);
        
        if (this.options.verbose) {
          process.stderr.write(output);
        }
      });

      // Handle IPC messages from Electron
      electronProcess.on('message', (message) => {
        this.log('Received IPC message:', message?.type);
        
        if (message && message.type === 'benchmark:result') {
          resultsReceived++;
          if (!isWarmup) {
            this.processScenarioResult(message.data, iteration);
          }
        } else if (message && message.type === 'benchmark:complete') {
          benchmarkData = message.data;
        } else if (message && message.type === 'benchmark:progress') {
          if (!isWarmup) {
            console.log(`  ${message.scenario}: ${message.status}`);
          }
        }
      });

      electronProcess.on('close', (code) => {
        this.log(`Electron process exited with code ${code}`);
        this.log(`Results received: ${resultsReceived}/${scenarios.length}`);
        
        // Process any remaining buffer
        if (outputBuffer.trim()) {
          processOutput(outputBuffer + '\n');
        }
        
        if (benchmarkData && !isWarmup) {
          // Merge any additional data from the app
          if (benchmarkData.ipc) {
            this.results.ipc = benchmarkData.ipc;
          }
          if (benchmarkData.startup) {
            this.results.startup = benchmarkData.startup;
          }
          if (benchmarkData.main) {
            this.results.main = benchmarkData.main;
          }
        }
        
        resolve(benchmarkData);
      });

      electronProcess.on('error', (error) => {
        console.error('Failed to start Electron:', error.message);
        reject(error);
      });

      // Timeout for the entire benchmark run
      const timeout = this.options.timeout;
      const timeoutId = setTimeout(() => {
        if (electronProcess && !electronProcess.killed) {
          console.warn(`\nBenchmark timeout after ${timeout}ms - killing Electron process`);
          console.warn(`Results received so far: ${resultsReceived}/${scenarios.length}`);
          electronProcess.kill('SIGTERM');
        }
      }, timeout);

      electronProcess.on('close', () => {
        clearTimeout(timeoutId);
      });
    });
  }

  processScenarioResult(result, iteration) {
    const { scenario, duration, memory, error, details } = result;
    
    if (!scenario) {
      this.log('Received result without scenario name:', result);
      return;
    }
    
    if (!this.results.scenarios[scenario]) {
      this.results.scenarios[scenario] = {
        name: getScenario(scenario)?.name || scenario,
        runs: []
      };
    }

    this.results.scenarios[scenario].runs.push({
      iteration,
      duration,
      memory,
      error,
      details,
      timestamp: new Date().toISOString()
    });

    // Print progress
    if (error) {
      console.log(`  ✗ ${scenario}: FAILED - ${error}`);
    } else {
      console.log(`  ✓ ${scenario}: ${this.formatDuration(duration)}`);

      // Print grid performance results
      if (scenario === 'grid_performance' && details) {
        console.log('\n  ========== GRID PERFORMANCE ANALYSIS ==========');
        console.log(`  DOM Elements: ${details.domStats?.totalElements || 'N/A'}`);
        console.log(`  Clip Items: ${details.domStats?.clipItems || 'N/A'}`);
        console.log(`  Images: ${details.domStats?.images || 'N/A'}`);
        console.log('');

        if (details.tests && details.tests.length > 0) {
          console.log('  FPS MEASUREMENTS:');
          for (const test of details.tests) {
            console.log(`    ${test.clipCount} clips: ${test.idleFPS} FPS (min: ${test.minFPS})`);
          }
        }

        if (details.scrollPerformance) {
          console.log('');
          console.log('  SCROLL PERFORMANCE:');
          console.log(`    Jank frames: ${details.scrollPerformance.jankFrames}/${details.scrollPerformance.totalFrames} (${details.scrollPerformance.jankPercent}%)`);
        }

        if (details.cssStats) {
          console.log('');
          console.log('  CSS IMPACT:');
          if (details.cssStats.hasBoxShadow > 0) console.log(`    Box-shadow: ${details.cssStats.hasBoxShadow} elements`);
          if (details.cssStats.hasFilter > 0) console.log(`    Filter: ${details.cssStats.hasFilter} elements`);
          if (details.cssStats.hasTransform > 0) console.log(`    Transform: ${details.cssStats.hasTransform} elements`);
        }

        if (details.recommendations && details.recommendations.length > 0) {
          console.log('');
          console.log('  RECOMMENDATIONS:');
          for (const rec of details.recommendations) {
            console.log(`    ⚠ ${rec}`);
          }
        }

        console.log('  ================================================\n');
      }

      // Print detailed breakdown for startup_detailed scenario
      if (scenario === 'startup_detailed' && details && details.phases) {
        const report = details;
        console.log('\n  ========== STARTUP DETAILED BREAKDOWN ==========');
        console.log(`  Total Time: ${report.totalTime.toFixed(1)}ms`);
        console.log(`  Clips: ${report.clipCount} found, ${report.renderedClips} rendered, ${report.groupCount} groups`);
        console.log('');
        console.log('  Phase                              Duration    % Total');
        console.log('  ' + '─'.repeat(55));

        const sortedPhases = [...report.phases].sort((a, b) => b.duration - a.duration);

        for (const phase of report.phases) {
          const bar = '█'.repeat(Math.round(parseFloat(phase.percentage) / 5));
          const name = phase.name.padEnd(35);
          const dur = `${phase.duration.toFixed(1)}ms`.padStart(8);
          const pct = `${phase.percentage}%`.padStart(6);
          console.log(`  ${name} ${dur} ${pct} ${bar}`);
        }

        console.log('  ' + '─'.repeat(55));
        console.log('');
        console.log('  TOP BOTTLENECKS:');
        for (let i = 0; i < Math.min(3, sortedPhases.length); i++) {
          const p = sortedPhases[i];
          console.log(`    ${i + 1}. ${p.name}: ${p.duration.toFixed(1)}ms (${p.percentage}%)`);
        }

        if (report.tagBatchDetails && report.tagBatchDetails.batchCount > 1) {
          console.log('');
          console.log(`  Tag Loading Details: ${report.tagBatchDetails.batchCount} batches`);
          console.log(`    Avg batch: ${report.tagBatchDetails.avgBatchTime.toFixed(1)}ms`);
          const batchTimes = report.tagBatchDetails.batchTimes;
          console.log(`    Min batch: ${Math.min(...batchTimes).toFixed(1)}ms`);
          console.log(`    Max batch: ${Math.max(...batchTimes).toFixed(1)}ms`);
        }

        console.log('  ================================================\n');
      }
    }
  }

  calculateSummary() {
    const summary = {
      totalScenarios: Object.keys(this.results.scenarios).length,
      totalRuns: 0,
      passed: 0,
      failed: 0,
      byCategory: {}
    };

    for (const [id, data] of Object.entries(this.results.scenarios)) {
      const scenario = getScenario(id);
      const category = scenario?.category || 'other';
      
      if (!summary.byCategory[category]) {
        summary.byCategory[category] = { scenarios: [], totalDuration: 0 };
      }

      const successfulRuns = data.runs.filter(r => !r.error);
      const durations = successfulRuns.map(r => r.duration).filter(d => d !== undefined && d !== null);
      
      summary.totalRuns += data.runs.length;
      summary.passed += successfulRuns.length;
      summary.failed += data.runs.filter(r => r.error).length;

      if (durations.length > 0) {
        const stats = {
          id,
          name: data.name,
          min: Math.min(...durations),
          max: Math.max(...durations),
          avg: durations.reduce((a, b) => a + b, 0) / durations.length,
          runs: durations.length
        };
        
        summary.byCategory[category].scenarios.push(stats);
        summary.byCategory[category].totalDuration += stats.avg;
      }
    }

    // Sort categories by total duration (slowest first)
    for (const category of Object.values(summary.byCategory)) {
      category.scenarios.sort((a, b) => b.avg - a.avg);
    }

    this.results.summary = summary;
    this.results.endTime = new Date().toISOString();
  }

  generateReport() {
    console.log('\n');
    
    switch (this.options.output) {
      case 'json':
        const jsonReport = generateJSONReport(this.results);
        if (this.options.outputFile) {
          fs.writeFileSync(this.options.outputFile, jsonReport);
          console.log(`JSON report saved to: ${this.options.outputFile}`);
        } else {
          const filename = `benchmark-${Date.now()}.json`;
          fs.writeFileSync(filename, jsonReport);
          console.log(`JSON report saved to: ${filename}`);
        }
        break;
        
      case 'html':
        const htmlReport = generateHTMLReport(this.results);
        const htmlFile = this.options.outputFile || `benchmark-${Date.now()}.html`;
        fs.writeFileSync(htmlFile, htmlReport);
        console.log(`HTML report saved to: ${htmlFile}`);
        break;
        
      case 'console':
      default:
        console.log(generateConsoleReport(this.results));
        break;
    }
  }

  formatDuration(ms) {
    if (ms === undefined || ms === null) return '-';
    if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
    if (ms < 1000) return `${ms.toFixed(1)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}min`;
  }
}

// Main entry point
async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (options.list) {
    showList();
    process.exit(0);
  }

  const runner = new BenchmarkRunner(options);
  
  try {
    await runner.run();
    process.exit(0);
  } catch (error) {
    console.error('\nBenchmark failed:', error.message);
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
