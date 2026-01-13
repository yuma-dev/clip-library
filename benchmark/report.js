/**
 * Benchmark Report Generator
 * 
 * Generates formatted reports from benchmark results:
 * - Console table output
 * - JSON export
 * - HTML report with visualizations
 */

'use strict';

const { formatters } = require('./metrics');
const { formatProfilerReport } = require('./open-clip-profiler');

/**
 * Generate a console-friendly report with ASCII tables
 * @param {Object} results - Benchmark results
 * @returns {string} Formatted console output
 */
function generateConsoleReport(results) {
  const lines = [];
  const { summary, scenarios, system, startup, ipc } = results;

  // Header
  lines.push('');
  lines.push('='.repeat(70));
  lines.push('                    CLIPS BENCHMARK RESULTS');
  lines.push('='.repeat(70));
  lines.push('');

  // System info
  lines.push('System Information:');
  lines.push(`  Platform:    ${system.platform} ${system.arch}`);
  lines.push(`  CPU:         ${system.cpuModel}`);
  lines.push(`  Cores:       ${system.cpus}`);
  lines.push(`  Memory:      ${system.totalMemory}`);
  lines.push('');

  // Summary
  if (summary) {
    lines.push('Summary:');
    lines.push(`  Total Scenarios: ${summary.totalScenarios}`);
    lines.push(`  Total Runs:      ${summary.totalRuns}`);
    lines.push(`  Passed:          ${summary.passed}`);
    lines.push(`  Failed:          ${summary.failed}`);
    lines.push('');
  }

  // Results by category
  if (summary && summary.byCategory) {
    for (const [category, data] of Object.entries(summary.byCategory)) {
      lines.push('');
      lines.push(`${category.toUpperCase()}`);
      lines.push('-'.repeat(70));
      
      // Table header
      lines.push(formatTableRow(['Operation', 'Avg', 'Min', 'Max', 'Runs'], [30, 10, 10, 10, 6]));
      lines.push('-'.repeat(70));
      
      for (const scenario of data.scenarios) {
        lines.push(formatTableRow([
          truncate(scenario.name, 28),
          formatDuration(scenario.avg),
          formatDuration(scenario.min),
          formatDuration(scenario.max),
          String(scenario.runs)
        ], [30, 10, 10, 10, 6]));
      }
      
      lines.push('-'.repeat(70));
      lines.push(`  Category Total: ${formatDuration(data.totalDuration)}`);
    }
  }

  // IPC Statistics
  if (ipc && Object.keys(ipc).length > 0) {
    lines.push('');
    lines.push('IPC CALL STATISTICS');
    lines.push('-'.repeat(70));
    lines.push(formatTableRow(['Channel', 'Calls', 'Avg', 'Total', 'P95'], [25, 8, 10, 12, 10]));
    lines.push('-'.repeat(70));

    // Sort by total time (slowest first)
    const sortedIPC = Object.entries(ipc)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 15); // Top 15

    for (const [channel, stats] of sortedIPC) {
      lines.push(formatTableRow([
        truncate(channel, 23),
        String(stats.count),
        formatDuration(stats.avg),
        formatDuration(stats.total),
        formatDuration(stats.p95)
      ], [25, 8, 10, 12, 10]));
    }
  }

  // Startup metrics
  if (startup && Object.keys(startup).length > 0) {
    lines.push('');
    lines.push('STARTUP METRICS');
    lines.push('-'.repeat(70));
    
    for (const [phase, data] of Object.entries(startup)) {
      if (data && data.duration) {
        lines.push(`  ${phase.padEnd(25)} ${formatDuration(data.duration.avg)}`);
      }
    }
  }

  // Check for detailed open clip profiler results
  if (scenarios) {
    for (const [scenarioId, scenarioData] of Object.entries(scenarios)) {
      if (scenarioId === 'open_clip_detailed') {
        // Find the first run with valid report data
        const runWithReport = scenarioData.runs?.find(r => r.details?.report);
        if (runWithReport?.details?.report) {
          lines.push('');
          const profilerLines = formatProfilerReport(runWithReport.details.report);
          lines.push(...profilerLines);
        }
      }
    }
  }

  // Bottleneck Analysis
  lines.push('');
  lines.push('BOTTLENECK ANALYSIS');
  lines.push('-'.repeat(70));
  
  const bottlenecks = analyzeBottlenecks(results);
  for (const issue of bottlenecks) {
    const icon = issue.severity === 'warning' ? '!' : issue.severity === 'info' ? 'i' : '✓';
    lines.push(`  ${icon} ${issue.message}`);
  }

  lines.push('');
  lines.push('='.repeat(70));
  lines.push(`Report generated at: ${new Date().toISOString()}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Format a table row with fixed column widths
 */
function formatTableRow(cells, widths) {
  return cells.map((cell, i) => {
    const width = widths[i] || 10;
    return String(cell).padEnd(width);
  }).join(' ');
}

/**
 * Truncate string to max length
 */
function truncate(str, maxLength) {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 2) + '..';
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms) {
  if (ms === undefined || ms === null) return '-';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}min`;
}

/**
 * Format bytes in human-readable form
 */
function formatBytes(bytes) {
  if (bytes === undefined || bytes === null) return '-';
  const sign = bytes < 0 ? '-' : '+';
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${sign}${abs}B`;
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)}KB`;
  if (abs < 1024 * 1024 * 1024) return `${sign}${(abs / 1024 / 1024).toFixed(1)}MB`;
  return `${sign}${(abs / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

/**
 * Analyze results for bottlenecks
 */
function analyzeBottlenecks(results) {
  const issues = [];
  const { summary, ipc } = results;

  if (!summary) return issues;

  // Find slowest operations
  const allScenarios = [];
  for (const category of Object.values(summary.byCategory || {})) {
    allScenarios.push(...category.scenarios);
  }
  
  allScenarios.sort((a, b) => b.avg - a.avg);
  
  if (allScenarios.length > 0) {
    const slowest = allScenarios[0];
    if (slowest.avg > 1000) {
      issues.push({
        severity: 'warning',
        message: `"${slowest.name}" is the slowest operation at ${formatDuration(slowest.avg)}`
      });
    }
  }

  // Check for high-frequency IPC calls
  if (ipc) {
    const highFrequency = Object.entries(ipc)
      .filter(([, stats]) => stats.count > 50 && stats.avg > 10);
    
    for (const [channel, stats] of highFrequency) {
      issues.push({
        severity: 'warning',
        message: `IPC "${channel}" called ${stats.count}x (avg ${formatDuration(stats.avg)}) - consider batching`
      });
    }
  }

  // Check startup time
  if (results.startup) {
    const totalStartup = Object.values(results.startup)
      .reduce((sum, data) => sum + (data?.duration?.avg || 0), 0);
    
    if (totalStartup > 3000) {
      issues.push({
        severity: 'warning',
        message: `Total startup time is ${formatDuration(totalStartup)} - consider lazy loading`
      });
    }
  }

  // Check for failed scenarios
  if (summary.failed > 0) {
    issues.push({
      severity: 'error',
      message: `${summary.failed} scenario(s) failed - check logs for details`
    });
  }

  // Add positive findings
  if (issues.filter(i => i.severity === 'warning').length === 0) {
    issues.push({
      severity: 'success',
      message: 'No significant performance issues detected'
    });
  }

  return issues;
}

/**
 * Generate JSON report
 * @param {Object} results - Benchmark results
 * @returns {string} JSON string
 */
function generateJSONReport(results) {
  return JSON.stringify({
    ...results,
    generated: new Date().toISOString(),
    version: '1.0'
  }, null, 2);
}

/**
 * Generate HTML report with charts
 * @param {Object} results - Benchmark results
 * @returns {string} HTML string
 */
function generateHTMLReport(results) {
  const { summary, scenarios, system, startup, ipc } = results;

  // Prepare chart data
  const categoryData = [];
  const scenarioData = [];
  
  if (summary && summary.byCategory) {
    for (const [category, data] of Object.entries(summary.byCategory)) {
      categoryData.push({
        name: category,
        duration: data.totalDuration
      });
      
      for (const scenario of data.scenarios) {
        scenarioData.push({
          category,
          name: scenario.name,
          avg: scenario.avg,
          min: scenario.min,
          max: scenario.max
        });
      }
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Clips Benchmark Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      line-height: 1.6;
      padding: 20px;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #00d4ff; margin-bottom: 10px; }
    h2 { color: #00d4ff; margin: 30px 0 15px; border-bottom: 1px solid #333; padding-bottom: 10px; }
    h3 { color: #aaa; margin: 20px 0 10px; }
    .meta { color: #888; margin-bottom: 30px; }
    .card {
      background: #16213e;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
    .stat-box {
      background: #0f3460;
      border-radius: 8px;
      padding: 15px;
      text-align: center;
    }
    .stat-value { font-size: 2em; color: #00d4ff; font-weight: bold; }
    .stat-label { color: #888; font-size: 0.9em; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #333; }
    th { background: #0f3460; color: #00d4ff; }
    tr:hover { background: #1f3a60; }
    .chart-container { position: relative; height: 300px; margin: 20px 0; }
    .warning { color: #ffc107; }
    .error { color: #dc3545; }
    .success { color: #28a745; }
    .issue { padding: 10px; margin: 5px 0; background: #0f3460; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Clips Benchmark Report</h1>
    <p class="meta">Generated: ${new Date().toISOString()}</p>

    <div class="grid">
      <div class="stat-box">
        <div class="stat-value">${summary?.totalScenarios || 0}</div>
        <div class="stat-label">Scenarios</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${summary?.passed || 0}</div>
        <div class="stat-label">Passed</div>
      </div>
      <div class="stat-box">
        <div class="stat-value">${summary?.failed || 0}</div>
        <div class="stat-label">Failed</div>
      </div>
    </div>

    <h2>System Information</h2>
    <div class="card">
      <table>
        <tr><td>Platform</td><td>${system?.platform} ${system?.arch}</td></tr>
        <tr><td>CPU</td><td>${system?.cpuModel}</td></tr>
        <tr><td>Cores</td><td>${system?.cpus}</td></tr>
        <tr><td>Memory</td><td>${system?.totalMemory}</td></tr>
      </table>
    </div>

    <h2>Performance by Category</h2>
    <div class="card">
      <div class="chart-container">
        <canvas id="categoryChart"></canvas>
      </div>
    </div>

    <h2>Scenario Results</h2>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Category</th>
            <th>Avg</th>
            <th>Min</th>
            <th>Max</th>
          </tr>
        </thead>
        <tbody>
          ${scenarioData.map(s => `
            <tr>
              <td>${s.name}</td>
              <td>${s.category}</td>
              <td>${formatDuration(s.avg)}</td>
              <td>${formatDuration(s.min)}</td>
              <td>${formatDuration(s.max)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    ${ipc && Object.keys(ipc).length > 0 ? `
    <h2>IPC Statistics</h2>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Channel</th>
            <th>Calls</th>
            <th>Avg</th>
            <th>Total</th>
            <th>P95</th>
          </tr>
        </thead>
        <tbody>
          ${Object.entries(ipc)
            .sort((a, b) => b[1].total - a[1].total)
            .slice(0, 20)
            .map(([channel, stats]) => `
              <tr>
                <td>${channel}</td>
                <td>${stats.count}</td>
                <td>${formatDuration(stats.avg)}</td>
                <td>${formatDuration(stats.total)}</td>
                <td>${formatDuration(stats.p95)}</td>
              </tr>
            `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}

    <h2>Bottleneck Analysis</h2>
    <div class="card">
      ${analyzeBottlenecks(results).map(issue => `
        <div class="issue ${issue.severity}">
          ${issue.severity === 'warning' ? '⚠️' : issue.severity === 'error' ? '❌' : '✅'}
          ${issue.message}
        </div>
      `).join('')}
    </div>

    <h2>Raw Data</h2>
    <div class="card">
      <details>
        <summary style="cursor: pointer; color: #00d4ff;">Click to expand JSON data</summary>
        <pre style="overflow: auto; padding: 15px; background: #0a0a15; border-radius: 4px; margin-top: 10px;">
${JSON.stringify(results, null, 2)}
        </pre>
      </details>
    </div>
  </div>

  <script>
    const categoryData = ${JSON.stringify(categoryData)};
    
    new Chart(document.getElementById('categoryChart'), {
      type: 'bar',
      data: {
        labels: categoryData.map(d => d.name.toUpperCase()),
        datasets: [{
          label: 'Total Duration (ms)',
          data: categoryData.map(d => d.duration),
          backgroundColor: '#00d4ff',
          borderColor: '#00a8cc',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: '#333' },
            ticks: { color: '#888' }
          },
          x: {
            grid: { color: '#333' },
            ticks: { color: '#888' }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

module.exports = {
  generateConsoleReport,
  generateJSONReport,
  generateHTMLReport,
  formatDuration,
  formatBytes,
  analyzeBottlenecks
};
