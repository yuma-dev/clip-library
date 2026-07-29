// ClipLib telemetry. Full design and the server contract: docs/telemetry-cliplib-api.md
//
// Why this exists: cliplib had 168 catch blocks in the renderer and 4
// console.error calls. Most failures were converted into plausible-looking
// empty values, so a user with a broken library, no thumbnails, no audio tracks
// or a silently failed update produced zero server-visible signal.
//
// Rules for call sites:
//   - event() NEVER throws and NEVER returns a promise you have to await.
//   - kind is the urgency axis. Use 'silent_failure' whenever the user was not
//     told, which is the case for most of the sites this module instruments.
//   - context carries numbers, booleans and enum strings ONLY. No paths, no
//     file names, no tag text, no account identifiers. See the never-send list
//     in the design doc.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const identity = require('./identity');
const queue = require('./queue');
const client = require('./client');
const metrics = require('./metrics');
const usage = require('./usage');
const machineProfile = require('./machine');
const { scrubText } = require('./scrub');

const PRODUCT = 'cliplib';
const PROTOCOL = 1;

const TICK_MS = 2000;
const FLUSH_MIN_INTERVAL_MS = 2000;
const FLUSH_MAX_BACKOFF_MS = 300000;
const HEARTBEAT_INTERVAL_MS = 900000;
const MAX_BATCH = 100;
const MAX_EVENTS_PER_SESSION = 200;
// Crashes must never be starved by a noisy warning site, so fatal events get
// headroom above the general cap rather than competing for it.
const MAX_FATAL_EVENTS_PER_SESSION = 40;
const MAX_PENDING_METRICS = 1200;
const MAX_COALESCE_GATES = 5000;
const MAX_MESSAGE_LEN = 4000;
const MAX_CONTEXT_BYTES = 60000;
const LOG_TAIL_BYTES = 128 * 1024;
const DEFAULT_COALESCE_MS = 60000;

const KIND = {
  CRASH: 'crash',
  ERROR: 'error',
  SILENT_FAILURE: 'silent_failure',
  DATA_LOSS: 'data_loss',
  DEGRADED: 'degraded',
  CUSTOM: 'custom'
};

const SEVERITY = {
  DEBUG: 'debug',
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  FATAL: 'fatal'
};

const CODE_PATTERN = /^[a-z0-9_]{3,64}$/;

const state = {
  initialized: false,
  // Opt-out product default, so startup-path metrics recorded before init()
  // are not silently dropped. init() overrides this from settings and clears
  // everything collected so far when the user has telemetry off.
  enabled: true,
  configured: false,
  debug: process.env.CLIPS_TELEMETRY_DEBUG === '1',
  userDataDir: null,
  appVersion: '0.0.0',
  markerPath: null,
  sessionEndPath: null,
  sessionEnded: false,
  startedAtMs: Date.now(),
  eventsThisSession: 0,
  fatalEventsThisSession: 0,
  capReported: false,
  appInfo: {},
  lastSentAppInfo: null,
  machinePending: null,
  remoteConfig: {},
  nextFlushAt: 0,
  nextHeartbeatAt: 0,
  backoffMs: FLUSH_MIN_INTERVAL_MS,
  flushing: false,
  pendingMetrics: [],
  timer: null
};

const coalesceGates = new Map();

// Startup-path call sites (settings load, ffmpeg init, thumbnail cache init)
// run BEFORE init(). Buffer them rather than making every call site think about
// ordering; replayed verbatim once init lands.
const preInitBuffer = [];
const MAX_PREINIT = 50;

// ---------------------------------------------------------------- helpers ---

function hash32(input) {
  // djb2, matching the fingerprint scheme the renderer bridge uses.
  let h = 5381;
  const s = String(input);
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function truncateMessage(message) {
  if (typeof message !== 'string') return undefined;
  const scrubbed = scrubText(message);
  if (Buffer.byteLength(scrubbed, 'utf8') <= MAX_MESSAGE_LEN) return scrubbed;
  return `${Buffer.from(scrubbed, 'utf8').subarray(0, MAX_MESSAGE_LEN).toString('utf8')}…[truncated]`;
}

function sanitizeContext(context) {
  if (!context || typeof context !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      out[key] = scrubText(value).slice(0, 300);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      // Strings are scrubbed, primitives pass, anything else (objects, nested
      // arrays) is DROPPED. Previously non-strings passed through verbatim,
      // which would have shipped an object containing a path unscrubbed.
      out[key] = value
        .slice(0, 20)
        .map((v) => {
          if (typeof v === 'string') return scrubText(v).slice(0, 200);
          if (typeof v === 'number' || typeof v === 'boolean') return v;
          return undefined;
        })
        .filter((v) => v !== undefined);
    }
  }
  if (Object.keys(out).length === 0) return undefined;
  if (JSON.stringify(out).length > MAX_CONTEXT_BYTES) {
    return { _dropped: 'context exceeded size limit' };
  }
  return out;
}

function errorFields(error) {
  if (!error) return {};
  if (typeof error === 'string') return { message: error };
  const frames = typeof error.stack === 'string'
    ? error.stack.split('\n').slice(1, 4).map((l) => scrubText(l.trim()).slice(0, 200))
    : undefined;
  return {
    message: error.message ? String(error.message) : String(error),
    errorName: error.name || undefined,
    errno: error.code || undefined,
    frames
  };
}

/**
 * Last LOG_TAIL_BYTES of the current log, scrubbed then gzipped then base64.
 * cliplib scrubs its tails; clipdip does not. Clip filenames still survive the
 * scrub, which is why tails attach only to fatal events and to codes the server
 * explicitly promotes via attach_log_codes.
 */
function readLogTail() {
  try {
    const logger = require('../../utils/logger');
    const logPath = typeof logger.getLogPath === 'function' ? logger.getLogPath() : null;
    if (!logPath) return undefined;
    const { size } = fs.statSync(logPath);
    if (!size) return undefined;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    const scrubbed = scrubText(buffer.toString('utf8'));
    return zlib.gzipSync(Buffer.from(scrubbed, 'utf8')).toString('base64');
  } catch {
    return undefined;
  }
}

function gate(key, minIntervalMs) {
  const now = Date.now();
  const entry = coalesceGates.get(key);
  if (!entry) {
    // JS fingerprints are stack-derived, so a reload loop can mint new keys
    // indefinitely. Evict oldest-first rather than growing without bound.
    if (coalesceGates.size >= MAX_COALESCE_GATES) {
      const oldest = coalesceGates.keys().next();
      if (!oldest.done) coalesceGates.delete(oldest.value);
    }
    coalesceGates.set(key, { last: now, suppressed: 0 });
    return { send: true, occurrences: 1 };
  }
  if (now - entry.last < minIntervalMs) {
    entry.suppressed += 1;
    return { send: false, occurrences: 0 };
  }
  const occurrences = entry.suppressed + 1;
  entry.last = now;
  entry.suppressed = 0;
  return { send: true, occurrences };
}

function isMuted(code) {
  const muted = state.remoteConfig.muted_codes;
  return Array.isArray(muted) && muted.includes(code);
}

function shouldAttachLog(code, severity, explicit) {
  if (explicit === false) return false;
  if (severity === SEVERITY.FATAL) return true;
  if (explicit === true) return true;
  const promoted = state.remoteConfig.attach_log_codes;
  return Array.isArray(promoted) && promoted.includes(code);
}

// ----------------------------------------------------------------- events ---

/**
 * Record an event. Never throws, never blocks on the network.
 *
 * @param {string} code                snake_case, stable, greppable
 * @param {object} [opts]
 * @param {string} [opts.kind]         KIND.*  (default 'error')
 * @param {string} [opts.severity]     SEVERITY.* (default 'error')
 * @param {object} [opts.context]      numbers / booleans / enum strings only
 * @param {string} [opts.message]      free text, scrubbed and truncated
 * @param {Error}  [opts.error]        convenience: fills message/errno/frames
 * @param {string} [opts.surface]      main | renderer | preload | player | worker
 * @param {string} [opts.fingerprint]  grouping key; derived when omitted
 * @param {boolean}[opts.attachLog]    force the log tail on or off
 * @param {number} [opts.coalesceMs]   suppression window, default 60s
 */
function event(code, opts = {}) {
  try {
    if (!state.initialized) {
      if (preInitBuffer.length < MAX_PREINIT) preInitBuffer.push([code, opts]);
      return;
    }
    if (!state.enabled) return;
    if (!CODE_PATTERN.test(code)) return;
    if (isMuted(code)) return;

    const severity = opts.severity || SEVERITY.ERROR;
    const kind = opts.kind || KIND.ERROR;
    const derived = errorFields(opts.error);
    const fingerprint = opts.fingerprint
      || (derived.frames ? hash32(`${code}|${derived.errorName}|${derived.frames.join('|')}`) : undefined);

    // Cap BEFORE the coalesce gate, otherwise a post-cap error storm keeps
    // allocating gate entries for events that will never be sent.
    const isFatal = severity === SEVERITY.FATAL || kind === KIND.CRASH;
    const overCap = isFatal
      ? state.fatalEventsThisSession >= MAX_FATAL_EVENTS_PER_SESSION
      : state.eventsThisSession >= MAX_EVENTS_PER_SESSION;
    if (overCap) {
      if (!state.capReported) {
        state.capReported = true;
        // One explicit event rather than silent truncation.
        appendWire({
          event_id: crypto.randomUUID(),
          client_ts: new Date().toISOString(),
          kind: KIND.CUSTOM,
          severity: SEVERITY.WARNING,
          code: 'telemetry_event_cap_reached',
          surface: 'main',
          context: { cap: MAX_EVENTS_PER_SESSION, fatal_cap: MAX_FATAL_EVENTS_PER_SESSION }
        });
      }
      return;
    }

    const gateKey = fingerprint ? `${code}:${fingerprint}` : code;
    const result = gate(gateKey, opts.coalesceMs ?? DEFAULT_COALESCE_MS);
    if (!result.send) return;

    const context = sanitizeContext({
      ...opts.context,
      ...(derived.errno && !opts.context?.errno ? { errno: derived.errno } : {}),
      ...(derived.frames && !opts.context?.frames ? { frames: derived.frames } : {}),
      ...(result.occurrences > 1 ? { occurrences: result.occurrences } : {})
    });

    const wire = {
      event_id: crypto.randomUUID(),
      client_ts: new Date().toISOString(),
      kind,
      severity,
      code,
      surface: opts.surface || 'main',
      ...(fingerprint ? { fingerprint } : {}),
      ...(truncateMessage(opts.message || derived.message) ? { message: truncateMessage(opts.message || derived.message) } : {}),
      ...(context ? { context } : {})
    };

    if (shouldAttachLog(code, severity, opts.attachLog)) {
      const tail = readLogTail();
      if (tail) wire.log = tail;
    }

    if (isFatal) state.fatalEventsThisSession += 1;
    else state.eventsThisSession += 1;
    appendWire(wire);

    if (severity === SEVERITY.ERROR || severity === SEVERITY.FATAL) {
      state.nextFlushAt = Date.now() + FLUSH_MIN_INTERVAL_MS;
    }
  } catch {
    /* telemetry must never be able to break the app */
  }
}

function appendWire(wire) {
  if (state.debug) {
    // eslint-disable-next-line no-console
    console.log('[telemetry]', wire.severity, wire.code, JSON.stringify(wire.context || {}));
  }
  if (!state.configured) return;
  queue.append(wire);
}

/** Record a metric sample. See metrics.js for why we ship buckets. */
function metric(name, value, opts = {}) {
  try {
    if (!state.enabled) return;
    metrics.record(name, value, opts);
  } catch {
    /* ignore */
  }
}

/** Start a timer; call the returned function to record the elapsed ms. */
function timer(name, opts = {}) {
  const startedAt = Date.now();
  let stopped = false;
  return (extra = {}) => {
    if (stopped) return 0;
    stopped = true;
    const elapsed = Date.now() - startedAt;
    metric(name, elapsed, { unit: 'ms', ...opts, ...extra });
    return elapsed;
  };
}

// -------------------------------------------------------------- app block ---

/** Merge into the heartbeat `app` block. Sent only when the value changes. */
function setAppInfo(partial) {
  try {
    if (!partial || typeof partial !== 'object') return;
    for (const [key, value] of Object.entries(partial)) {
      if (value === undefined) continue;
      state.appInfo[key] = value;
    }
  } catch {
    /* ignore */
  }
}

function appInfoChanged() {
  const current = JSON.stringify(state.appInfo);
  return current !== state.lastSentAppInfo;
}

// ---------------------------------------------------------------- payload ---

function envelopeIdentity() {
  return {
    protocol: PROTOCOL,
    product: PRODUCT,
    install_id: identity.getInstallId(),
    app_version: state.appVersion,
    session_id: identity.getSessionId(),
    ...(identity.getMachineKey() ? { machine_key: identity.getMachineKey() } : {})
  };
}

function buildHeartbeat() {
  const beat = {
    session_started_at: identity.getSessionStartedAt(),
    channel: 'stable',
    install_id_source: identity.getInstallIdSource(),
    machine_key_source: identity.getMachineKeySource(),
    uptime_s: Math.round((Date.now() - state.startedAtMs) / 1000)
  };
  if (state.machinePending) beat.machine = state.machinePending;
  if (appInfoChanged() && Object.keys(state.appInfo).length) beat.app = { ...state.appInfo };
  return beat;
}

function applyRemoteConfig(body) {
  if (!body || typeof body !== 'object') return;
  state.remoteConfig = body;
  const interval = Number(body.heartbeat_interval_s);
  if (Number.isFinite(interval) && interval >= 60) {
    state.nextHeartbeatAt = Date.now() + interval * 1000;
  }
}

// ------------------------------------------------------------------ flush ---

async function flush({ heartbeat = false } = {}) {
  if (state.flushing || !state.enabled || !state.configured) return;
  state.flushing = true;
  try {
    const queued = queue.readAll();
    const batch = queued.slice(0, MAX_BATCH);
    // Metrics are drained into a pending buffer, not straight onto the wire:
    // a failed send must not lose the window, and re-recording a mean would
    // destroy the bucket distribution.
    if (heartbeat) {
      // Bounded: an unreachable server must not turn this into a growing
      // payload that eventually 413s and then can never succeed again.
      state.pendingMetrics = state.pendingMetrics
        .concat(metrics.drain())
        .slice(-MAX_PENDING_METRICS);
      const droppedSeries = metrics.takeDroppedSeries();
      if (droppedSeries > 0) {
        event('telemetry_metric_series_capped', {
          kind: KIND.CUSTOM,
          severity: SEVERITY.WARNING,
          context: { dropped: droppedSeries, cap: metrics.MAX_SERIES },
          coalesceMs: 3600000
        });
      }
    }
    const drainedMetrics = heartbeat ? state.pendingMetrics : [];

    if (!heartbeat && batch.length === 0) return;

    const sentAppInfo = JSON.stringify(state.appInfo);
    const sentMachine = state.machinePending;

    let result;
    if (heartbeat) {
      result = await client.post('/v1/ingest', {
        ...envelopeIdentity(),
        heartbeat: buildHeartbeat(),
        ...(batch.length ? { events: batch } : {}),
        ...(drainedMetrics.length ? { metrics: drainedMetrics } : {})
      });
    } else {
      result = await client.post('/v1/events', batch.map((e) => ({ ...envelopeIdentity(), ...e })));
    }

    if (result.outcome === 'accepted' || result.outcome === 'drop') {
      // dropFirst re-reads: anything appended during the await survives.
      if (batch.length) {
        const dropped = queue.dropFirst(batch.length);
        if (dropped > 0) {
          event('telemetry_queue_truncated', {
            kind: KIND.CUSTOM,
            severity: SEVERITY.WARNING,
            context: { dropped, cap: queue.MAX_LINES },
            coalesceMs: 3600000
          });
        }
      }
      state.backoffMs = FLUSH_MIN_INTERVAL_MS;
      state.nextFlushAt = Date.now() + FLUSH_MIN_INTERVAL_MS;
      // Metrics are discarded on a permanent 4xx too, exactly like the event
      // batch. Keeping them would grow the payload until it 413s, and a 413 is
      // itself a permanent 4xx, so the buffer could never drain again.
      if (heartbeat) state.pendingMetrics = [];
      if (result.outcome === 'accepted') {
        if (heartbeat) {
          if (sentMachine) state.machinePending = null;
          state.lastSentAppInfo = sentAppInfo;
        }
        applyRemoteConfig(result.body);
      }
    } else {
      // Retry: keep the batch AND keep pendingMetrics for the next attempt.
      state.backoffMs = Math.min(state.backoffMs * 2, FLUSH_MAX_BACKOFF_MS);
      const waitMs = result.retryAfterS ? result.retryAfterS * 1000 : state.backoffMs;
      state.nextFlushAt = Date.now() + waitMs;
    }
  } catch {
    state.backoffMs = Math.min(state.backoffMs * 2, FLUSH_MAX_BACKOFF_MS);
    state.nextFlushAt = Date.now() + state.backoffMs;
  } finally {
    state.flushing = false;
  }
}

function tick() {
  if (!state.enabled || !state.configured) return;
  const now = Date.now();
  if (now >= state.nextHeartbeatAt) {
    state.nextHeartbeatAt = now + HEARTBEAT_INTERVAL_MS;
    void flush({ heartbeat: true });
    return;
  }
  if (now >= state.nextFlushAt) {
    void flush({ heartbeat: false });
  }
}

// ------------------------------------------------------------- lifecycle ---

/**
 * The marker file makes crash-versus-clean-exit decidable. cliplib had no
 * clean-shutdown marker at all, so "did the previous session die" was
 * unanswerable from disk state.
 */
function claimDirtyMarker() {
  try {
    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(state.markerPath, 'utf8'));
    } catch {
      previous = null;
    }
    if (previous && previous.session_id) {
      const startedMs = Date.parse(previous.started_at);
      event('unclean_shutdown', {
        kind: KIND.CRASH,
        severity: SEVERITY.FATAL,
        coalesceMs: 0,
        // Summary line so the dashboard row is readable on its own. No version
        // here: the server normalises digits in issue titles for grouping, so
        // "3.1.0" would render as "<num>.0". It is already on the event and in
        // prev_app_version below.
        message: 'previous session did not exit cleanly',
        context: {
          prev_session_id: previous.session_id,
          prev_app_version: previous.app_version,
          // Wall time between the dead session starting and this launch. Not
          // its uptime: we cannot know when it actually died.
          prev_session_age_s: Number.isFinite(startedMs)
            ? Math.round((Date.now() - startedMs) / 1000)
            : undefined
        }
      });
    }
    fs.writeFileSync(
      state.markerPath,
      JSON.stringify({
        session_id: identity.getSessionId(),
        started_at: identity.getSessionStartedAt(),
        app_version: state.appVersion
      }),
      'utf8'
    );
  } catch {
    /* marker is best effort */
  }
}

function clearDirtyMarker() {
  try {
    fs.unlinkSync(state.markerPath);
  } catch {
    /* already gone */
  }
}

/**
 * Fire-and-forget session end. A session that stops heartbeating without one
 * is derived as `died` server-side; the client never sends that.
 *
 * @param {'quit'|'window_all_closed'|'update'|'shutdown'|'crash_restart'} reason
 */
function sessionEnd(reason) {
  try {
    if (!state.initialized || state.sessionEnded) return;
    state.sessionEnded = true;
    clearDirtyMarker();
    if (!state.enabled || !state.configured) return;

    const record = {
      product: PRODUCT,
      install_id: identity.getInstallId(),
      session_id: identity.getSessionId(),
      reason,
      uptime_s: Math.round((Date.now() - state.startedAtMs) / 1000),
      clean: true
    };

    // Persist BEFORE attempting the network. Electron does not wait for pending
    // sockets during quit, so a fire-and-forget POST usually loses the race with
    // process exit. Without this, almost every clean exit would arrive as a
    // session that simply stopped heartbeating, the server would derive it as
    // `died`, and the fleet crash rate would be meaningless.
    try {
      fs.writeFileSync(state.sessionEndPath, JSON.stringify(record), 'utf8');
    } catch {
      /* best effort */
    }

    void client
      .post('/v1/session/end', record, { timeoutMs: 2000 })
      .then((result) => {
        if (result.outcome === 'accepted') clearPendingSessionEnd();
      })
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

function clearPendingSessionEnd() {
  try {
    fs.unlinkSync(state.sessionEndPath);
  } catch {
    /* already gone */
  }
}

/**
 * Deliver the previous session's end record, if the quit raced us. Re-sending is
 * safe: the server keys on session_id, so a duplicate is an idempotent update.
 */
function flushPendingSessionEnd() {
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(state.sessionEndPath, 'utf8'));
  } catch {
    return;
  }
  if (!record || !record.session_id) {
    clearPendingSessionEnd();
    return;
  }
  void client
    .post('/v1/session/end', record)
    .then((result) => {
      if (result.outcome === 'accepted' || result.outcome === 'drop') clearPendingSessionEnd();
    })
    .catch(() => {});
}

function setEnabled(enabled) {
  const next = Boolean(enabled);
  if (next === state.enabled) return;
  state.enabled = next;
  if (!next) {
    // Off means off: stop the network and drop anything unsent.
    queue.clear();
    metrics.clear();
    coalesceGates.clear();
  } else {
    state.nextHeartbeatAt = Date.now() + 5000;
  }
}

function registerIpc(ipcMain) {
  if (!ipcMain) return;
  ipcMain.on('telemetry-report', (_e, payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      for (const item of (payload.events || []).slice(0, 50)) {
        if (!item || !CODE_PATTERN.test(item.code || '')) continue;
        const surface = ['renderer', 'player', 'preload', 'worker'].includes(item.surface)
          ? item.surface
          : 'renderer';
        event(item.code, {
          kind: item.kind,
          severity: item.severity,
          context: item.context,
          message: item.message,
          fingerprint: item.fingerprint,
          coalesceMs: item.coalesceMs,
          surface
        });
      }
      for (const m of (payload.metrics || []).slice(0, 100)) {
        if (!m || typeof m.name !== 'string') continue;
        metric(m.name, m.value, { unit: m.unit, dims: m.dims });
      }
    } catch {
      /* ignore malformed renderer payloads */
    }
  });
}

/**
 * @param {object} options
 * @param {string} options.userDataDir
 * @param {string} options.appVersion
 * @param {boolean} options.enabled          from settings.telemetry.enabled
 * @param {string} [options.clipdipInstallIdPath]
 * @param {object} [options.ipcMain]
 */
function init(options = {}) {
  try {
    if (state.initialized) return;
    state.userDataDir = options.userDataDir;
    state.appVersion = options.appVersion || '0.0.0';
    state.markerPath = path.join(options.userDataDir, 'telemetry-session');
    state.sessionEndPath = path.join(options.userDataDir, 'telemetry-session-end.json');
    state.configured = Boolean(client.resolveIngestKey());
    state.enabled = options.enabled !== false;

    queue.init(options.userDataDir);
    // append() does not trim, so a long offline stretch across many sessions
    // can leave the file over the cap. Enforce it once at startup.
    queue.trimToCap();
    identity.resolveInstallId(options.userDataDir, options.clipdipInstallIdPath);
    identity.startSession();
    state.initialized = true;

    claimDirtyMarker();
    registerIpc(options.ipcMain);

    if (!state.enabled) {
      preInitBuffer.length = 0;
      queue.clear();
      metrics.clear();
      return;
    }

    // Replay anything the startup path recorded before we were ready.
    const buffered = preInitBuffer.splice(0, preInitBuffer.length);
    for (const [code, opts] of buffered) event(code, opts);

    if (!state.configured && !state.debug) return;

    flushPendingSessionEnd();

    state.nextHeartbeatAt = Date.now() + 15000;
    state.nextFlushAt = Date.now() + FLUSH_MIN_INTERVAL_MS;
    state.timer = setInterval(tick, TICK_MS);
    if (typeof state.timer.unref === 'function') state.timer.unref();

    // Counts-only daily rollup, on its own timer. It re-checks isEnabled on
    // every run, so setEnabled(false) stops it without any further wiring.
    usage.init({
      userDataDir: options.userDataDir,
      isEnabled: () => state.enabled && state.configured,
      getAppVersion: () => state.appVersion,
      getAppInfo: () => ({ ...state.appInfo }),
      hash32
    });

    void identity.resolveMachineKey();
  } catch {
    state.initialized = false;
  }
}

/** Collect the machine block. Call after app.whenReady(). */
async function collectMachine(deps) {
  try {
    if (!state.initialized) return;
    state.machinePending = await machineProfile.collect(deps);
  } catch {
    /* best effort */
  }
}

module.exports = {
  init,
  event,
  metric,
  timer,
  setAppInfo,
  setEnabled,
  sessionEnd,
  collectMachine,
  isEnabled: () => state.enabled,
  isConfigured: () => state.configured,
  getRemoteConfig: () => state.remoteConfig,
  getSessionId: () => identity.getSessionId(),
  getInstallId: () => identity.getInstallId(),
  hash32,
  KIND,
  SEVERITY,
  PRODUCT
};
