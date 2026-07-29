// Offline queue: NDJSON, one fully formed wire event per line.
//
// Every line carries an `event_id`, so resending after an ambiguous failure is
// a server-deduped no-op. Appends are SYNCHRONOUS on purpose: the uncaught
// exception handler and the panic path must be able to persist an event before
// process.exit(1), and events are rare enough (coalesced, capped per session)
// that the blocking cost is irrelevant.
//
// Never throws. A broken queue must not be able to take the app down.

const fs = require('fs');
const path = require('path');

const MAX_LINES = 5000;

let queuePath = null;

function init(userDataDir) {
  queuePath = path.join(userDataDir, 'telemetry-queue.jsonl');
}

function append(event) {
  if (!queuePath) return false;
  try {
    fs.appendFileSync(queuePath, `${JSON.stringify(event)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Malformed lines are skipped rather than allowed to poison the queue. */
function readAll() {
  if (!queuePath) return [];
  let raw;
  try {
    raw = fs.readFileSync(queuePath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* drop */
    }
  }
  return out;
}

/** Atomic rewrite (tmp + rename). Keeps the NEWEST MAX_LINES entries. */
function rewrite(events) {
  if (!queuePath) return 0;
  let dropped = 0;
  let kept = events;
  if (kept.length > MAX_LINES) {
    dropped = kept.length - MAX_LINES;
    kept = kept.slice(kept.length - MAX_LINES);
  }
  try {
    if (kept.length === 0) {
      try {
        fs.unlinkSync(queuePath);
      } catch {
        /* already gone */
      }
      return dropped;
    }
    const tmp = `${queuePath}.tmp`;
    fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, queuePath);
  } catch {
    /* keep whatever is on disk */
  }
  return dropped;
}

/**
 * Drop the first `count` lines, re-reading the file first.
 *
 * A flush snapshots the queue, awaits a request that can take 20 seconds, then
 * needs to remove exactly the batch it sent. Rewriting from the snapshot would
 * erase every event appended during that window, which is precisely when the
 * interesting ones arrive. Re-reading here keeps them: appends only ever go to
 * the end, so dropping the first N is safe regardless of what arrived since.
 */
function dropFirst(count) {
  if (count <= 0) return 0;
  return rewrite(readAll().slice(count));
}

function clear() {
  rewrite([]);
}

/** Enforce the line cap on disk. Called at init, since append does not trim. */
function trimToCap() {
  const all = readAll();
  if (all.length <= MAX_LINES) return 0;
  return rewrite(all);
}

module.exports = { init, append, readAll, rewrite, dropFirst, clear, trimToCap, MAX_LINES };
