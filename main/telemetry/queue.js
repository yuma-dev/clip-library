// Offline queue: NDJSON, one wire event per line, each with an event_id so a resend after an ambiguous
// failure is a server-deduped no-op. Appends are synchronous so the uncaught-exception/panic path can
// persist an event before process.exit(1). Never throws: a broken queue must not take the app down.

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

/** Drops the first `count` lines but re-reads the file first: a flush awaits a request that can take
 * 20s, and rewriting from the old snapshot would erase anything appended (to the end) during that wait. */
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
