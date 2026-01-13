/**
 * Benchmark Scenario Definitions
 * 
 * Defines all benchmark scenarios that can be run, including:
 * - Startup benchmarks
 * - Clip loading benchmarks
 * - Playback benchmarks
 * - Export benchmarks
 * - Search benchmarks
 * 
 * Note: Scenarios with `renderer: true` have implementations in renderer-harness.js
 */

'use strict';

/**
 * Scenario categories for organization
 */
const CATEGORIES = {
  STARTUP: 'startup',
  LOADING: 'loading',
  PLAYBACK: 'playback',
  EXPORT: 'export',
  SEARCH: 'search',
  THUMBNAILS: 'thumbnails'
};

/**
 * All available benchmark scenarios
 */
const SCENARIOS = {
  // ==================== LOADING SCENARIOS ====================

  load_clips: {
    id: 'load_clips',
    name: 'Load Clips from Disk',
    category: CATEGORIES.LOADING,
    description: 'Time to read clip files from filesystem and render to DOM',
    renderer: true,
    timeout: 120000
  },

  render_clips: {
    id: 'render_clips',
    name: 'Render Clip Grid',
    category: CATEGORIES.LOADING,
    description: 'Time to render clips to DOM',
    renderer: true,
    timeout: 30000
  },

  // ==================== PLAYBACK SCENARIOS ====================

  open_clip: {
    id: 'open_clip',
    name: 'Open Clip in Player',
    category: CATEGORIES.PLAYBACK,
    description: 'Time to open video player with a clip',
    renderer: true,
    iterations: 3,
    timeout: 30000
  },

  open_clip_detailed: {
    id: 'open_clip_detailed',
    name: 'Open Clip Detailed Profiling',
    category: CATEGORIES.PLAYBACK,
    description: 'Granular timing of each phase during clip opening - identifies bottlenecks and variance sources',
    renderer: true,
    iterations: 5,
    warmupRuns: 1,
    timeout: 120000
  },

  video_metadata: {
    id: 'video_metadata',
    name: 'Get Video Metadata (FFprobe)',
    category: CATEGORIES.PLAYBACK,
    description: 'Time for FFprobe to extract video information',
    renderer: true,
    iterations: 5,
    timeout: 30000
  },

  video_seek: {
    id: 'video_seek',
    name: 'Video Seek Operation',
    category: CATEGORIES.PLAYBACK,
    description: 'Time to seek to different positions in video',
    renderer: true,
    timeout: 30000
  },

  close_player: {
    id: 'close_player',
    name: 'Close Video Player',
    category: CATEGORIES.PLAYBACK,
    description: 'Time to close player and return to grid',
    renderer: true,
    timeout: 10000
  },

  // ==================== SEARCH SCENARIOS ====================

  search_simple: {
    id: 'search_simple',
    name: 'Simple Search (Short Term)',
    category: CATEGORIES.SEARCH,
    description: 'Search with a short search term',
    renderer: true,
    searchTerm: 'clip',
    timeout: 10000
  },

  search_complex: {
    id: 'search_complex',
    name: 'Complex Search (Long Term)',
    category: CATEGORIES.SEARCH,
    description: 'Search with a longer, more specific term',
    renderer: true,
    searchTerm: 'gameplay video 2024',
    timeout: 10000
  },

  // ==================== THUMBNAIL SCENARIOS ====================

  thumbnail_batch: {
    id: 'thumbnail_batch',
    name: 'Batch Thumbnail Generation',
    category: CATEGORIES.THUMBNAILS,
    description: 'Time to generate thumbnails for multiple clips',
    renderer: true,
    batchSize: 5,
    timeout: 120000
  }
};

/**
 * Predefined scenario suites for different testing needs
 */
const SUITES = {
  // Quick smoke test - minimal scenarios
  quick: [
    'load_clips',
    'open_clip',
    'close_player'
  ],

  // Standard benchmark - core functionality
  standard: [
    'load_clips',
    'open_clip',
    'video_metadata',
    'video_seek',
    'close_player',
    'search_simple'
  ],

  // Full benchmark - everything with renderer support
  full: Object.keys(SCENARIOS),

  // Playback-focused
  playback: [
    'open_clip',
    'video_metadata',
    'video_seek',
    'close_player'
  ],

  // Search-focused
  search: [
    'search_simple',
    'search_complex'
  ],

  // Open clip deep-dive - detailed profiling to find bottlenecks
  openclip: [
    'open_clip_detailed'
  ]
};

/**
 * Get scenarios for a specific suite
 * @param {string} suiteName - Name of the suite
 * @returns {Array} Array of scenario objects
 */
function getSuite(suiteName) {
  const suiteIds = SUITES[suiteName];
  if (!suiteIds) {
    throw new Error(`Unknown suite: ${suiteName}. Available: ${Object.keys(SUITES).join(', ')}`);
  }
  
  return suiteIds.map(id => SCENARIOS[id]).filter(Boolean);
}

/**
 * Get scenarios by category
 * @param {string} category - Category name
 * @returns {Array} Array of scenario objects
 */
function getByCategory(category) {
  return Object.values(SCENARIOS).filter(s => s.category === category);
}

/**
 * Get a single scenario by ID
 * @param {string} id - Scenario ID
 * @returns {Object|null} Scenario object or null
 */
function getScenario(id) {
  return SCENARIOS[id] || null;
}

/**
 * List all available scenarios
 * @returns {Array} Array of scenario summaries
 */
function listScenarios() {
  return Object.values(SCENARIOS).map(s => ({
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description,
    renderer: s.renderer || false
  }));
}

/**
 * List all available suites
 * @returns {Object} Suite names and their scenario counts
 */
function listSuites() {
  const result = {};
  for (const [name, ids] of Object.entries(SUITES)) {
    result[name] = {
      count: ids.length,
      scenarios: ids
    };
  }
  return result;
}

module.exports = {
  CATEGORIES,
  SCENARIOS,
  SUITES,
  getSuite,
  getByCategory,
  getScenario,
  listScenarios,
  listSuites
};
