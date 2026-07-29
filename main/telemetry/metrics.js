// Metric aggregation: bucket histograms, not quantiles.
//
// Quantiles do not merge across installs; buckets do. Each install ships sparse
// {upper_bound: count} maps over a FIXED ladder per unit, the server sums them,
// and the fleet p50/p95 falls out correctly. Never send a client-computed
// percentile; averaging percentiles is meaningless.

// These MUST match the server's ladders exactly, or a bucket bound the server
// does not recognise 400s the request. Verified against the live API on
// 2026-07-29; the server accepts exactly four units and these bounds.
// Do not "improve" a ladder here without changing the server in the same pass.
const LADDERS = {
  ms: [1, 2, 5, 10, 50, 100, 500, 1000, 5000, 10000, 30000, 60000, 300000],
  bytes: [
    1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 268435456,
    1073741824, 4294967296
  ],
  count: [1, 2, 5, 10, 25, 50, 100, 500, 1000, 5000],
  // Server-side `ratio` is a bounded fraction: 0 to 1, then overflow. It is NOT
  // suitable for an unbounded speedup like an encode realtime factor.
  ratio: [0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99, 1]
};

const UNITS = Object.keys(LADDERS);

// dims are capped hard: three keys, enum-ish values only. Free strings here
// would explode server-side cardinality.
const MAX_DIMS = 3;
// ipc.handler_ms and ipc.call_ms are both dimmed by channel, and there are ~95
// channels, so 200 was not enough headroom. Overflow is reported rather than
// silently dropped: a capped metric set looks like full coverage otherwise.
const MAX_SERIES = 600;

const series = new Map();
let droppedSeries = 0;
let unsupportedUnits = 0;

function dimsKey(dims) {
  if (!dims) return '';
  return Object.keys(dims)
    .sort()
    .slice(0, MAX_DIMS)
    .map((k) => `${k}=${dims[k]}`)
    .join(',');
}

function normalizeDims(dims) {
  if (!dims || typeof dims !== 'object') return undefined;
  const keys = Object.keys(dims).sort().slice(0, MAX_DIMS);
  if (keys.length === 0) return undefined;
  const out = {};
  for (const k of keys) {
    const v = dims[k];
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'boolean' || typeof v === 'number' ? v : String(v).slice(0, 40);
  }
  return Object.keys(out).length ? out : undefined;
}

function isKnownUnit(unit) {
  return Object.prototype.hasOwnProperty.call(LADDERS, unit);
}

function bucketFor(unit, value) {
  const ladder = isKnownUnit(unit) ? LADDERS[unit] : LADDERS.count;
  for (const bound of ladder) {
    if (value <= bound) return String(bound);
  }
  return 'inf';
}

function record(name, value, { unit = 'ms', dims } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
  // Drop unknown units here rather than letting the server reject them. A
  // single invalid metric 400s the whole /v1/ingest envelope, and the client
  // treats 400 as permanent, so it would discard the heartbeat and the entire
  // event batch riding along with it.
  if (!isKnownUnit(unit)) {
    unsupportedUnits += 1;
    return;
  }
  const normalized = normalizeDims(dims);
  const key = `${name}|${unit}|${dimsKey(normalized)}`;
  let entry = series.get(key);
  if (!entry) {
    if (series.size >= MAX_SERIES) {
      droppedSeries += 1;
      return;
    }
    entry = {
      name,
      unit,
      dims: normalized,
      count: 0,
      sum: 0,
      min: value,
      max: value,
      buckets: {}
    };
    series.set(key, entry);
  }
  entry.count += 1;
  entry.sum += value;
  if (value < entry.min) entry.min = value;
  if (value > entry.max) entry.max = value;
  const bucket = bucketFor(unit, value);
  entry.buckets[bucket] = (entry.buckets[bucket] || 0) + 1;
}

/** Drain everything accumulated so far. Called on the heartbeat tick. */
function drain() {
  if (series.size === 0) return [];
  const out = [];
  for (const entry of series.values()) {
    out.push({
      name: entry.name,
      unit: entry.unit,
      count: entry.count,
      sum: Math.round(entry.sum * 1000) / 1000,
      min: Math.round(entry.min * 1000) / 1000,
      max: Math.round(entry.max * 1000) / 1000,
      buckets: entry.buckets,
      ...(entry.dims ? { dims: entry.dims } : {})
    });
  }
  series.clear();
  return out;
}

function size() {
  return series.size;
}

/** Number of distinct series refused since the last call, then reset. */
function takeDroppedSeries() {
  const dropped = droppedSeries;
  droppedSeries = 0;
  return dropped;
}

/** Samples dropped for an unsupported unit since the last call, then reset. */
function takeUnsupportedUnits() {
  const dropped = unsupportedUnits;
  unsupportedUnits = 0;
  return dropped;
}

function clear() {
  series.clear();
  droppedSeries = 0;
  unsupportedUnits = 0;
}

module.exports = {
  record, drain, size, clear, takeDroppedSeries, takeUnsupportedUnits,
  isKnownUnit, MAX_SERIES, LADDERS, UNITS
};
