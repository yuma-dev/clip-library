/**
 * Benchmark scenario definitions. `renderer: true` scenarios are implemented
 * in renderer-harness.js.
 */

'use strict';

const CATEGORIES = {
  STARTUP: 'startup',
  LOADING: 'loading',
  PLAYBACK: 'playback',
  EXPORT: 'export',
  SEARCH: 'search',
  THUMBNAILS: 'thumbnails'
};

const SCENARIOS = {
  // startup scenarios

  startup_detailed: {
    id: 'startup_detailed',
    name: 'Startup Detailed Breakdown',
    category: CATEGORIES.STARTUP,
    description: 'Granular timing of each startup phase: settings, IPC calls, tag loading, rendering',
    renderer: true,
    timeout: 120000
  },

  grid_performance: {
    id: 'grid_performance',
    name: 'Grid Performance with Many Clips',
    category: CATEGORIES.LOADING,
    description: 'Measures FPS and CPU impact with varying numbers of visible clips',
    renderer: true,
    timeout: 60000
  },

  // loading scenarios

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

  // playback scenarios

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

  // search scenarios

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

  // audio track comparison scenarios: single vs multi-audio-track clip
  // picked automatically by ffprobing the loaded clip set

  playback_cpu_compare: {
    id: 'playback_cpu_compare',
    name: 'Playback CPU (single vs multi audio)',
    category: CATEGORIES.PLAYBACK,
    description: 'Samples CPU + memory + dropped frames over several seconds of playback for each bucket',
    renderer: true,
    timeout: 120000
  },

  open_phases_compare: {
    id: 'open_phases_compare',
    name: 'Open Clip Phases (single vs multi audio)',
    category: CATEGORIES.PLAYBACK,
    description: 'Breaks openClip into its internal phases for each bucket — pinpoints where multi-track adds cost',
    renderer: true,
    timeout: 60000
  },

  seek_burst_compare: {
    id: 'seek_burst_compare',
    name: 'Seek Burst (single vs multi audio)',
    category: CATEGORIES.PLAYBACK,
    description: 'Rapid series of seeks across the timeline, measuring latency + CPU + dropped frames',
    renderer: true,
    timeout: 60000
  },

  memory_footprint_compare: {
    id: 'memory_footprint_compare',
    name: 'Memory Footprint (single vs multi audio)',
    category: CATEGORIES.PLAYBACK,
    description: 'Heap + RSS delta on open for each bucket',
    renderer: true,
    timeout: 60000
  },

  // thumbnail scenarios

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

const SUITES = {
  quick: [
    'load_clips',
    'open_clip',
    'close_player'
  ],

  standard: [
    'load_clips',
    'open_clip',
    'video_metadata',
    'video_seek',
    'close_player',
    'search_simple'
  ],

  full: Object.keys(SCENARIOS),

  playback: [
    'open_clip',
    'video_metadata',
    'video_seek',
    'close_player'
  ],

  search: [
    'search_simple',
    'search_complex'
  ],

  // deep-dive: detailed profiling to find bottlenecks
  openclip: [
    'open_clip_detailed'
  ],

  startup: [
    'startup_detailed'
  ],

  // audio-track regression: single vs multi audio across CPU, open phases
  // seek bursts, memory footprint
  multitrack: [
    'open_phases_compare',
    'playback_cpu_compare',
    'seek_burst_compare',
    'memory_footprint_compare'
  ]
};

/**
 * @param {string} suiteName
 * @returns {Array}
 */
function getSuite(suiteName) {
  const suiteIds = SUITES[suiteName];
  if (!suiteIds) {
    throw new Error(`Unknown suite: ${suiteName}. Available: ${Object.keys(SUITES).join(', ')}`);
  }
  
  return suiteIds.map(id => SCENARIOS[id]).filter(Boolean);
}

/**
 * @param {string} category
 * @returns {Array}
 */
function getByCategory(category) {
  return Object.values(SCENARIOS).filter(s => s.category === category);
}

/**
 * @param {string} id
 * @returns {Object|null}
 */
function getScenario(id) {
  return SCENARIOS[id] || null;
}

/** @returns {Array} */
function listScenarios() {
  return Object.values(SCENARIOS).map(s => ({
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description,
    renderer: s.renderer || false
  }));
}

/** @returns {Object} suite name -> scenario count/list */
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
