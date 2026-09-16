// Daily usage rollup: docs/telemetry-cliplib-api.md section 7. One POST /v1/usage/daily per run, an array
// of COMPLETED days. Counts only, never clip names/tags/paths/urls/ids (clip identity hashed
// locally, hash unsent).
// Reads forward from a watermark, never rescans (unlike main/discord-widget.js:115); current day
// never rolls up.

const fs = require('fs');
const path = require('path');

const client = require('./client');
const identity = require('./identity');

const PRODUCT = 'cliplib';
const STATE_FILE = 'telemetry-usage-state.json';
const STATE_VERSION = 1;

// far enough in that the rollup can't compete with startup work, after the first heartbeat
const FIRST_RUN_DELAY_MS = 90000;
const RUN_INTERVAL_MS = 12 * 60 * 60 * 1000;

const MAX_BACKFILL_DAYS = 30;
// a line this long is corrupt, not a log entry; skip it to keep the byte cursor honest
const MAX_LINE_BYTES = 64 * 1024;
// Set of 8-char hashes per day; saturating bounds memory, the count becomes a floor, never a lie upward
const MAX_DISTINCT_CLIPS = 20000;
// guards a future call site inventing enum values; both dims are whitelisted so this should never bind
const MAX_ENUM_ROWS = 20;

const EXPORT_FORMATS = ['video', 'audio'];
const EXPORT_DESTINATIONS = ['file', 'clipboard', 'trimmed_clipboard', 'share_upload'];
const IMPORT_SOURCES = ['steelseries'];
// share_clip's `status` is whatever the share server returned, so it's whitelisted like any other enum
const SHARE_STATUSES = ['processing', 'queued', 'ready', 'complete', 'completed', 'failed', 'error'];
const SHARE_FAILED_STATUSES = ['failed', 'error'];

const state = {
  configured: false,
  running: false,
  userDataDir: null,
  statePath: null,
  logDir: null,
  isEnabled: () => false,
  getAppVersion: () => '0.0.0',
  getAppInfo: () => ({}),
  hash32: (input) => String(input),
  post: client.post,
  debug: process.env.CLIPS_TELEMETRY_DEBUG === '1',
  timers: []
};

// ------------------------------------------------------------------- days ---

/** activity-tracker.js:43 writes `new Date(now - tzOffset).toISOString()`, so it looks like UTC but is
 * local wall time already; the first 10 chars are the local day, don't convert timezone again. */
function dayOfTimestamp(timestamp) {
  if (typeof timestamp !== 'string' || timestamp.length < 10) return null;
  const day = timestamp.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function localDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** UTC arithmetic so a DST boundary can't produce a 23 or 25 hour day. */
function addDays(day, delta) {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  return new Date(ms + delta * 86400000).toISOString().slice(0, 10);
}

/** monthly log file a day lives in, keyed the way activity-tracker names it */
function monthOf(day) {
  return day.slice(0, 7);
}

function monthsBetween(startDay, endDay) {
  const out = [];
  let cursor = monthOf(startDay);
  const last = monthOf(endDay);
  for (let i = 0; i < 64 && cursor <= last; i += 1) {
    out.push(cursor);
    const [y, m] = cursor.split('-').map(Number);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    cursor = `${nextY}-${String(nextM).padStart(2, '0')}`;
  }
  return out;
}

function logPathForMonth(month) {
  return path.join(state.logDir, `user_activity_log_${month}.jsonl`);
}

// ------------------------------------------------------------------ state ---

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(state.statePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || raw.version !== STATE_VERSION) return freshState();
    return {
      version: STATE_VERSION,
      last_day: dayOfTimestamp(raw.last_day) || null,
      cursors: raw.cursors && typeof raw.cursors === 'object' ? { ...raw.cursors } : {}
    };
  } catch {
    return freshState();
  }
}

function freshState() {
  return { version: STATE_VERSION, last_day: null, cursors: {} };
}

/** atomic write, same tmp+rename shape queue.js uses, best effort */
function writeState(next) {
  try {
    const tmp = `${state.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    fs.renameSync(tmp, state.statePath);
  } catch {
    // losing the watermark costs a rescan, not correctness: the day gate still refuses last_day or earlier
  }
}

function pruneCursors(cursors, oldestMonth) {
  const out = {};
  for (const [month, offset] of Object.entries(cursors)) {
    if (month >= oldestMonth && Number.isFinite(offset)) out[month] = offset;
  }
  return out;
}

// ------------------------------------------------------------------- scan ---

/** Reads one monthly log forward from a byte offset, handing each line to onLine; onLine returns false to
 * stop, and the returned offset is then that line's START so the unconsumed tail is picked up next run.
 * @param {string} filePath
 * @param {number} startOffset
 * @param {(line:string) => boolean} onLine  return false to stop the scan
 * @returns {Promise<{offset:number, ok:boolean}>} */
function scanForward(filePath, startOffset, onLine) {
  return new Promise((resolve) => {
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      // no file for this month yet
      resolve({ offset: 0, ok: false });
      return;
    }

    // a cursor past EOF means the file was truncated/replaced; start over, the day gate stops any resend
    let from = Number.isFinite(startOffset) && startOffset >= 0 && startOffset <= size ? startOffset : 0;
    if (from === size) {
      resolve({ offset: from, ok: true });
      return;
    }

    const stream = fs.createReadStream(filePath, { start: from });
    let pending = Buffer.alloc(0);
    let consumed = from;
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ offset: consumed, ok });
    };

    stream.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let idx = pending.indexOf(0x0a);
      while (idx !== -1) {
        const line = pending.subarray(0, idx).toString('utf8');
        if (onLine(line) === false) {
          stream.destroy();
          done(true);
          return;
        }
        consumed += idx + 1;
        pending = pending.subarray(idx + 1);
        idx = pending.indexOf(0x0a);
      }
      if (pending.length > MAX_LINE_BYTES) {
        // unterminated garbage; drop and resync at the next newline
        consumed += pending.length;
        pending = Buffer.alloc(0);
      }
    });
    // a trailing partial line (append in flight) is left unconsumed so the next run reads it whole
    stream.on('end', () => done(true));
    stream.on('close', () => done(true));
    stream.on('error', () => done(false));
  });
}

// -------------------------------------------------------------- aggregate ---

function newBucket() {
  return {
    clips: new Set(),
    clipsSaturated: false,
    watchSeconds: 0,
    renames: 0,
    trims: 0,
    speedChanges: 0,
    volumeChanges: 0,
    deletes: 0,
    tagOps: 0,
    exports: new Map(),
    sharesAttempted: 0,
    sharesSucceeded: 0,
    imports: new Map(),
    entries: 0
  };
}

function enumOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : 'other';
}

function bump(map, key) {
  if (!map.has(key) && map.size >= MAX_ENUM_ROWS) return;
  map.set(key, (map.get(key) || 0) + 1);
}

/** Folds one activity entry into a day bucket; only counts come out of `details`. */
function countEntry(bucket, entry) {
  const details = entry.details && typeof entry.details === 'object' ? entry.details : {};
  bucket.entries += 1;
  switch (entry.type) {
    case 'watch_session': {
      const name = details.originalName || details.customName;
      if (name) {
        if (bucket.clips.size < MAX_DISTINCT_CLIPS) bucket.clips.add(state.hash32(name));
        else bucket.clipsSaturated = true;
      }
      const seconds = Number(details.durationSeconds);
      // a negative or day-long "session" is a clock/bookkeeping artefact, not watch time
      if (Number.isFinite(seconds) && seconds > 0 && seconds <= 86400) bucket.watchSeconds += seconds;
      break;
    }
    case 'rename':
      bucket.renames += 1;
      break;
    case 'trim':
      bucket.trims += 1;
      break;
    case 'speed_change':
      bucket.speedChanges += 1;
      break;
    case 'volume_change':
      bucket.volumeChanges += 1;
      break;
    case 'delete':
      bucket.deletes += 1;
      break;
    case 'tags_update_clip':
    case 'tags_update_global':
    case 'tags_restore_global':
      bucket.tagOps += 1;
      break;
    case 'export':
      bump(
        bucket.exports,
        `${enumOf(details.format, EXPORT_FORMATS)}|${enumOf(details.destination, EXPORT_DESTINATIONS)}`
      );
      break;
    case 'share_clip': {
      // share.js only logs after the upload was accepted, so attempted == logged; real failures are
      // in the event stream as share_upload_failed
      bucket.sharesAttempted += 1;
      const status = enumOf(details.status, SHARE_STATUSES);
      if (!SHARE_FAILED_STATUSES.includes(status)) bucket.sharesSucceeded += 1;
      break;
    }
    case 'import_start':
      bump(bucket.imports, enumOf(details.source, IMPORT_SOURCES));
      break;
    default:
      bucket.entries -= 1;
      break;
  }
}

function exportRows(map) {
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, count]) => {
      const [format, destination] = key.split('|');
      return { format, destination, count };
    });
}

function importRows(map) {
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([source, count]) => ({ source, count }));
}

/** `sessions`/`app_minutes` are absent on purpose: the activity log has no launch or foreground time, and
 * inventing them would poison the only numbers this endpoint exists for. Same for section 7's `features`/`errors`. */
function buildActivity(bucket) {
  return {
    clips_watched: bucket.clips.size,
    watch_minutes: Math.round(bucket.watchSeconds / 60),
    renames: bucket.renames,
    trims: bucket.trims,
    speed_changes: bucket.speedChanges,
    volume_changes: bucket.volumeChanges,
    deletes: bucket.deletes,
    tag_ops: bucket.tagOps,
    exports: exportRows(bucket.exports),
    shares_attempted: bucket.sharesAttempted,
    shares_succeeded: bucket.sharesSucceeded,
    imports: importRows(bucket.imports)
  };
}

function buildDay(day, bucket) {
  const machineKey = identity.getMachineKey();
  const app = state.getAppInfo();
  return {
    product: PRODUCT,
    install_id: identity.getInstallId(),
    ...(machineKey ? { machine_key: machineKey } : {}),
    day,
    app_version: state.getAppVersion(),
    ...(app && Object.keys(app).length ? { app } : {}),
    activity: buildActivity(bucket)
  };
}

// rollup

/** Rolls up every completed day the watermark hasn't covered, up to MAX_BACKFILL_DAYS back. Never throws.
 * @returns {Promise<Array<object>|null>} the days posted, or null when nothing ran */
async function runNow() {
  if (!state.configured || state.running) return null;
  if (!state.isEnabled()) return null;
  state.running = true;
  try {
    const persisted = readState();
    const today = localDay(new Date());
    const endDay = addDays(today, -1);
    const floor = addDays(today, -MAX_BACKFILL_DAYS);
    const startDay = persisted.last_day && addDays(persisted.last_day, 1) > floor
      ? addDays(persisted.last_day, 1)
      : floor;

    // already current, or the clock moved backwards - either way nothing left to send
    if (startDay > endDay) return null;

    const buckets = new Map();
    const cursors = { ...persisted.cursors };

    for (const month of monthsBetween(startDay, endDay)) {
      const before = Number.isFinite(cursors[month]) ? cursors[month] : 0;
      const { offset, ok } = await scanForward(logPathForMonth(month), before, (line) => {
        const text = line.trim();
        if (!text) return true;
        let entry;
        try {
          entry = JSON.parse(text);
        } catch {
          return true;
        }
        const day = dayOfTimestamp(entry && entry.timestamp);
        if (!day) return true;
        // entries are appended in order; stopping (not consuming) at the first line >= today keeps it
        // out of the rollup without losing it
        if (day > endDay) return false;
        // older than the backfill window or already rolled up; consume the bytes so the cursor
        // passes them once
        if (day < startDay) return true;
        if (!buckets.has(day)) buckets.set(day, newBucket());
        countEntry(buckets.get(day), entry);
        return true;
      });
      if (ok) cursors[month] = offset;
    }

    const days = [...buckets.entries()]
      .filter(([, bucket]) => bucket.entries > 0)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, bucket]) => buildDay(day, bucket));

    const advanced = {
      version: STATE_VERSION,
      last_day: endDay,
      cursors: pruneCursors(cursors, monthOf(addDays(floor, -1)))
    };

    if (days.length === 0) {
      // idle days still move the watermark, else a user who stops using the app rescans fully forever
      writeState(advanced);
      return [];
    }

    if (state.debug) {
      // eslint-disable-next-line no-console
      console.log('[telemetry] usage rollup', days.length, 'day(s)', JSON.stringify(days));
    }

    const result = await state.post('/v1/usage/daily', days);
    // 'retry' leaves the watermark to rebuild next run; 'drop' is a permanent 4xx, so advancing is the
    // only way out of resending the same rejected days forever
    if (result.outcome === 'accepted' || result.outcome === 'drop') writeState(advanced);
    return days;
  } catch {
    // a rollup that throws would take down whatever timer called it
    return null;
  } finally {
    state.running = false;
  }
}

/** @param {object} deps
 * @param {string} deps.userDataDir
 * @param {() => boolean} deps.isEnabled       telemetry on AND ingest configured
 * @param {() => string} deps.getAppVersion
 * @param {() => object} deps.getAppInfo       the heartbeat app block
 * @param {(input:any) => string} deps.hash32
 * @param {Function} [deps.post]               defaults to client.post */
function init(deps = {}) {
  try {
    if (state.configured || !deps.userDataDir) return;
    state.userDataDir = deps.userDataDir;
    state.statePath = path.join(deps.userDataDir, STATE_FILE);
    state.logDir = path.join(deps.userDataDir, 'activity_logs');
    if (typeof deps.isEnabled === 'function') state.isEnabled = deps.isEnabled;
    if (typeof deps.getAppVersion === 'function') state.getAppVersion = deps.getAppVersion;
    if (typeof deps.getAppInfo === 'function') state.getAppInfo = deps.getAppInfo;
    if (typeof deps.hash32 === 'function') state.hash32 = deps.hash32;
    if (typeof deps.post === 'function') state.post = deps.post;
    state.configured = true;

    // off the startup path, then twice a day; re-checks enabled every run so turning telemetry off
    // stops it dead
    const first = setTimeout(() => {
      void runNow();
    }, FIRST_RUN_DELAY_MS);
    const repeat = setInterval(() => {
      void runNow();
    }, RUN_INTERVAL_MS);
    for (const t of [first, repeat]) {
      if (typeof t.unref === 'function') t.unref();
      state.timers.push(t);
    }
  } catch {
    /* telemetry must never be able to break the app */
  }
}

module.exports = { init, runNow, STATE_FILE, MAX_BACKFILL_DAYS };
