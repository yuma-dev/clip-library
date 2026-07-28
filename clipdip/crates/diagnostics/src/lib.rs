//! Anonymous, opt-out diagnostics + telemetry client for Clipdip.
//!
//! Talks to a self-hosted ingest server (`https://logs.yuma-homeserver.online`)
//! so failures on machines we don't own become visible. Three things flow:
//!
//! - **Heartbeat** every ~15 min → doubles as a config pull: the server can
//!   raise this install's log level (debug/trace, until an expiry) to debug a
//!   hard case, and advertise a `min_supported_version`.
//! - **Events** — `error` / `crash` / `capture_failure` / `custom`, queued to
//!   disk and flushed in batches with backoff. Idempotent on a client-generated
//!   `event_id`, so retries after ambiguous failures are safe no-ops.
//! - **Bundles** — a manual "export & upload diagnostics" zip.
//!
//! Identity is a random per-install UUID; no accounts, no PII. Telemetry is
//! opt-out: when the user disables it we simply stop calling the endpoints.
//!
//! The ingest key is injected at build time via `CLIPDIP_INGEST_KEY` (mirroring
//! the Discord client secret), with a runtime env fallback for local testing.
//! Without a key the client is inert — it never touches the network.
//!
//! ## Design
//! One dedicated manager thread owns all I/O (blocking `ureq`), mirroring the
//! Discord crate. A process-global handle lets deep call sites (the health
//! monitor, the panic hook) report without threading a handle through every
//! struct — the same "global switch" precedent [`clipdip_profile`] sets.

mod bundle;
mod client;
pub mod paths;
mod queue;

use client::{HttpClient, SendOutcome};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

const DEFAULT_BASE_URL: &str = "https://logs.yuma-homeserver.online";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(900); // 15 min
const HEARTBEAT_RETRY: Duration = Duration::from_secs(60);
const FLUSH_MIN_INTERVAL: Duration = Duration::from_secs(2); // rate limit: events ≤1/s
const FLUSH_MAX_BACKOFF: Duration = Duration::from_secs(300);
const TICK: Duration = Duration::from_secs(2);
const MAX_BATCH: usize = 100;
/// Read at most this many bytes off the tail of the log to attach to an event.
/// Well under the server's 1 MB decompressed cap, and plenty of context.
const LOG_TAIL_BYTES: u64 = 256 * 1024;
const MAX_MESSAGE_LEN: usize = 4_000;
const MAX_CONTEXT_BYTES: usize = 60_000; // server caps context at 64 KB

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Log verbosity the server can request for this install.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogLevel {
    Debug,
    Trace,
}

/// Event category — matches the server's `kind` enum.
#[derive(Clone, Copy, Debug)]
pub enum EventKind {
    Error,
    Crash,
    CaptureFailure,
    Custom,
}

impl EventKind {
    fn as_str(self) -> &'static str {
        match self {
            EventKind::Error => "error",
            EventKind::Crash => "crash",
            EventKind::CaptureFailure => "capture_failure",
            EventKind::Custom => "custom",
        }
    }
}

/// A telemetry event, before it's stamped with identity/id and queued.
pub struct Event {
    pub kind: EventKind,
    /// Short, stable slug (e.g. `wgc_no_frames`). Enables server-side grouping.
    pub code: Option<String>,
    pub message: Option<String>,
    pub context: Option<serde_json::Value>,
    /// Attach a gzipped tail of the app log. On for failures/crashes.
    pub attach_log: bool,
}

/// Options for [`init`].
pub struct InitOptions {
    /// Usually `env!("CARGO_PKG_VERSION")`.
    pub app_version: String,
    /// Current opt-out state (`true` = telemetry on).
    pub enabled: bool,
    /// Applied when the server changes this install's log level. `None` means
    /// "restore the default". Wired to the tracing reload handle in the app.
    pub on_log_level: Option<Box<dyn Fn(Option<LogLevel>) + Send + Sync>>,
    /// Override the ingest base URL (tests). Production uses the default.
    pub base_url: Option<String>,
}

/// Server response to a heartbeat / config pull.
#[derive(Debug, Deserialize)]
pub struct ServerConfig {
    #[serde(default)]
    pub log_level_override: Option<String>,
    #[serde(default)]
    pub override_expires_at: Option<String>,
    #[serde(default)]
    pub min_supported_version: Option<String>,
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

enum Cmd {
    Report(Event),
    SetEnabled(bool),
    UploadBundle {
        note: Option<String>,
        reply: crossbeam_channel::Sender<Result<i64, String>>,
    },
}

/// Live handle to the diagnostics manager thread. Cloneable via `Arc`.
pub struct Diagnostics {
    tx: crossbeam_channel::Sender<Cmd>,
    enabled: Arc<AtomicBool>,
    install_id: String,
    has_key: bool,
}

impl Diagnostics {
    pub fn install_id(&self) -> &str {
        &self.install_id
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Whether an ingest key was compiled into this build. When `false` the
    /// client is inert regardless of the opt-out toggle — nothing is sent.
    pub fn is_configured(&self) -> bool {
        self.has_key
    }

    /// Queue an event. Cheap and non-blocking — the manager thread stamps,
    /// persists and ships it. No-op when telemetry is disabled.
    pub fn report(&self, event: Event) {
        if !self.is_enabled() {
            return;
        }
        let _ = self.tx.send(Cmd::Report(event));
    }

    /// Flip the opt-out switch at runtime (from the settings toggle).
    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
        let _ = self.tx.send(Cmd::SetEnabled(on));
    }

    /// Build and upload a diagnostic bundle now, blocking until the server
    /// responds. Backed by the manager thread so it respects the same client /
    /// rate limits.
    pub fn upload_bundle_manual(&self, note: Option<String>) -> Result<i64, String> {
        if !self.has_key {
            return Err("diagnostics is not configured in this build".to_string());
        }
        let (reply, rx) = crossbeam_channel::bounded(1);
        self.tx
            .send(Cmd::UploadBundle { note, reply })
            .map_err(|_| "diagnostics thread is not running".to_string())?;
        rx.recv()
            .map_err(|_| "diagnostics thread dropped the request".to_string())?
    }
}

// ---------------------------------------------------------------------------
// Global singleton + free-function reporters
// ---------------------------------------------------------------------------

static GLOBAL: OnceLock<Arc<Diagnostics>> = OnceLock::new();
static APP_VERSION: OnceLock<String> = OnceLock::new();

/// Start the diagnostics client and install the process-global handle. Returns
/// the handle for the app to stash in its state (bundle uploads, toggle).
/// Idempotent: a second call returns the first handle.
pub fn init(opts: InitOptions) -> Arc<Diagnostics> {
    if let Some(existing) = GLOBAL.get() {
        return existing.clone();
    }

    let _ = APP_VERSION.set(opts.app_version.clone());
    let install_id = load_or_create_install_id();
    let enabled = Arc::new(AtomicBool::new(opts.enabled));
    let key = ingest_key();
    let has_key = key.is_some();
    let (tx, rx) = crossbeam_channel::unbounded();

    let handle = Arc::new(Diagnostics {
        tx,
        enabled: enabled.clone(),
        install_id: install_id.clone(),
        has_key,
    });
    let _ = GLOBAL.set(handle.clone());

    let base = opts.base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let app_version = opts.app_version;
    let on_log_level = opts.on_log_level;

    std::thread::Builder::new()
        .name("clipdip-diagnostics".into())
        .spawn(move || {
            run_manager(rx, enabled, install_id, app_version, base, key, on_log_level);
        })
        .expect("spawn diagnostics thread");

    if !has_key {
        tracing::info!("diagnostics: no CLIPDIP_INGEST_KEY compiled in — telemetry inert");
    }

    handle
}

/// Report a capture failure (health monitor, recovery paths). Attaches the log
/// tail. No-op if diagnostics isn't initialized or is disabled.
pub fn report_capture_failure(code: &str, message: impl Into<String>, context: serde_json::Value) {
    if let Some(d) = GLOBAL.get() {
        d.report(Event {
            kind: EventKind::CaptureFailure,
            code: Some(code.to_string()),
            message: Some(message.into()),
            context: Some(context),
            attach_log: true,
        });
    }
}

/// Report a generic error.
pub fn report_error(code: &str, message: impl Into<String>, context: Option<serde_json::Value>) {
    if let Some(d) = GLOBAL.get() {
        d.report(Event {
            kind: EventKind::Error,
            code: Some(code.to_string()),
            message: Some(message.into()),
            context,
            attach_log: true,
        });
    }
}

/// Synchronous crash reporter for the panic hook. The release build aborts on
/// panic (no unwinding), so we can't rely on the async manager flushing in
/// time — instead we stamp and append straight to the durable queue, and it
/// ships on the next launch. Safe and quick (a short file append).
pub fn report_crash(message: &str) {
    let Some(d) = GLOBAL.get() else {
        return;
    };
    if !d.is_enabled() {
        return;
    }
    let event = build_wire_event(
        &d.install_id,
        app_version(),
        EventKind::Crash,
        Some("panic"),
        Some(message),
        None,
        true,
    );
    let _ = queue::append(&event);
}

// ---------------------------------------------------------------------------
// Manager thread
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn run_manager(
    rx: crossbeam_channel::Receiver<Cmd>,
    enabled: Arc<AtomicBool>,
    install_id: String,
    app_version: String,
    base: String,
    key: Option<String>,
    on_log_level: Option<Box<dyn Fn(Option<LogLevel>) + Send + Sync>>,
) {
    let client = key
        .clone()
        .map(|k| HttpClient::new(base, k, install_id.clone(), app_version.clone()));

    let mut last_heartbeat: Option<Instant> = None;
    let mut next_flush = Instant::now();
    let mut backoff = FLUSH_MIN_INTERVAL;
    let mut current_override: Option<LogLevel> = None;

    loop {
        match rx.recv_timeout(TICK) {
            Ok(Cmd::Report(event)) => {
                if enabled.load(Ordering::Relaxed) {
                    let wire = build_wire_event(
                        &install_id,
                        &app_version,
                        event.kind,
                        event.code.as_deref(),
                        event.message.as_deref(),
                        event.context,
                        event.attach_log,
                    );
                    let _ = queue::append(&wire);
                    next_flush = Instant::now(); // try to ship promptly
                }
            }
            Ok(Cmd::SetEnabled(on)) => {
                enabled.store(on, Ordering::Relaxed);
                if !on {
                    // Honor opt-out fully: forget queued events and drop any
                    // active log-level override.
                    let _ = queue::rewrite(&[]);
                    if current_override.take().is_some() {
                        if let Some(cb) = &on_log_level {
                            cb(None);
                        }
                    }
                }
            }
            Ok(Cmd::UploadBundle { note, reply }) => {
                let result = match &client {
                    Some(c) if enabled.load(Ordering::Relaxed) => c.upload_bundle(note, "manual"),
                    Some(_) => Err("telemetry is disabled".to_string()),
                    None => Err("diagnostics is not configured in this build".to_string()),
                };
                let _ = reply.send(result);
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        }

        let Some(client) = &client else { continue };
        if !enabled.load(Ordering::Relaxed) {
            continue;
        }
        let now = Instant::now();

        // Heartbeat (also pulls config).
        let due = last_heartbeat.map_or(true, |t| now.duration_since(t) >= HEARTBEAT_INTERVAL);
        if due {
            match client.heartbeat() {
                Ok(cfg) => {
                    last_heartbeat = Some(now);
                    apply_config(cfg, &app_version, &mut current_override, on_log_level.as_deref());
                }
                Err(e) => {
                    tracing::debug!("diagnostics: heartbeat failed: {e}");
                    // Retry sooner than the full interval.
                    last_heartbeat = Some(now - HEARTBEAT_INTERVAL + HEARTBEAT_RETRY);
                }
            }
        }

        // Flush the event queue.
        if now >= next_flush {
            match flush_once(client) {
                FlushStep::Empty | FlushStep::Progressed => {
                    backoff = FLUSH_MIN_INTERVAL;
                    next_flush = Instant::now() + FLUSH_MIN_INTERVAL;
                }
                FlushStep::Retry(after) => {
                    backoff = (backoff * 2).min(FLUSH_MAX_BACKOFF);
                    let delay = after.unwrap_or(backoff);
                    next_flush = Instant::now() + delay;
                }
            }
        }
    }
}

enum FlushStep {
    Empty,
    Progressed,
    Retry(Option<Duration>),
}

/// Send one batch off the head of the queue. On success (or permanent drop),
/// rewrite the queue without those events.
fn flush_once(client: &HttpClient) -> FlushStep {
    let all = queue::read_all();
    if all.is_empty() {
        return FlushStep::Empty;
    }
    let take = all.len().min(MAX_BATCH);
    let batch = &all[..take];

    match client.send_events(batch) {
        SendOutcome::Accepted | SendOutcome::Drop => {
            let _ = queue::rewrite(&all[take..]);
            FlushStep::Progressed
        }
        SendOutcome::Retry(after) => FlushStep::Retry(after),
    }
}

/// Apply a heartbeat's config: raise/restore the log level (honoring expiry)
/// and warn if this build is below the server's minimum.
fn apply_config(
    cfg: ServerConfig,
    app_version: &str,
    current: &mut Option<LogLevel>,
    on_log_level: Option<&(dyn Fn(Option<LogLevel>) + Send + Sync)>,
) {
    if let Some(min) = cfg.min_supported_version.as_deref() {
        if version_lt(app_version, min) {
            tracing::warn!(
                "diagnostics: this build ({app_version}) is below the minimum supported \
                 version ({min}) — an update is recommended"
            );
        }
    }

    let expired = cfg
        .override_expires_at
        .as_deref()
        .and_then(parse_rfc3339)
        .map(|exp| exp <= chrono::Utc::now())
        .unwrap_or(false);

    let desired = if expired {
        None
    } else {
        match cfg.log_level_override.as_deref() {
            Some("debug") => Some(LogLevel::Debug),
            Some("trace") => Some(LogLevel::Trace),
            _ => None,
        }
    };

    if desired != *current {
        *current = desired;
        if let Some(cb) = on_log_level {
            cb(desired);
        }
        match desired {
            Some(l) => tracing::info!("diagnostics: server raised log level to {l:?}"),
            None => tracing::info!("diagnostics: log level restored to default"),
        }
    }
}

// ---------------------------------------------------------------------------
// Wire event construction
// ---------------------------------------------------------------------------

fn build_wire_event(
    install_id: &str,
    app_version: &str,
    kind: EventKind,
    code: Option<&str>,
    message: Option<&str>,
    context: Option<serde_json::Value>,
    attach_log: bool,
) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("install_id".into(), install_id.into());
    map.insert("app_version".into(), app_version.into());
    map.insert("client_ts".into(), chrono::Utc::now().to_rfc3339().into());
    map.insert(
        "event_id".into(),
        uuid::Uuid::new_v4().to_string().into(),
    );
    map.insert("kind".into(), kind.as_str().into());
    if let Some(code) = code {
        map.insert("code".into(), code.into());
    }
    if let Some(msg) = message {
        map.insert("message".into(), truncate(msg, MAX_MESSAGE_LEN).into());
    }
    if let Some(ctx) = context {
        // Drop context that would blow the server's 64 KB cap rather than have
        // the whole event rejected 400.
        if serde_json::to_string(&ctx).map(|s| s.len()).unwrap_or(0) <= MAX_CONTEXT_BYTES {
            map.insert("context".into(), ctx);
        } else {
            map.insert(
                "context".into(),
                serde_json::json!({ "_dropped": "context exceeded size limit" }),
            );
        }
    }
    if attach_log {
        if let Some(tail) = log_tail_b64() {
            map.insert("log".into(), tail.into());
        }
    }
    serde_json::Value::Object(map)
}

/// Read the tail of the app log, gzip it, base64-encode. `None` if there's no
/// log yet or anything goes wrong (never fatal to an event).
fn log_tail_b64() -> Option<String> {
    use base64::Engine;
    use std::io::{Read, Seek, SeekFrom};

    let path = paths::log_path()?;
    let mut f = std::fs::File::open(&path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(LOG_TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::new();
    f.read_to_end(&mut tail).ok()?;
    if tail.is_empty() {
        return None;
    }

    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut enc, &tail).ok()?;
    let gz = enc.finish().ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(gz))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn app_version() -> &'static str {
    APP_VERSION.get().map(String::as_str).unwrap_or("unknown")
}

/// Build-time ingest key (mirrors the Discord client secret), with a runtime
/// env fallback for local testing.
fn ingest_key() -> Option<String> {
    option_env!("CLIPDIP_INGEST_KEY")
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("CLIPDIP_INGEST_KEY").ok())
        .filter(|s| !s.is_empty())
}

fn load_or_create_install_id() -> String {
    if let Some(path) = paths::install_id_path() {
        if let Ok(existing) = std::fs::read_to_string(&path) {
            let trimmed = existing.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, &id);
        return id;
    }
    uuid::Uuid::new_v4().to_string()
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[truncated]", &s[..end])
}

fn parse_rfc3339(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&chrono::Utc))
}

/// Best-effort `a < b` for dotted numeric versions (e.g. `0.1.0`). Non-numeric
/// components compare as 0, and a parse miss yields `false` (don't nag on junk).
fn version_lt(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split(['.', '-', '+'])
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (va, vb) = (parse(a), parse(b));
    for i in 0..va.len().max(vb.len()) {
        let x = va.get(i).copied().unwrap_or(0);
        let y = vb.get(i).copied().unwrap_or(0);
        if x != y {
            return x < y;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare() {
        assert!(version_lt("0.1.0", "0.2.0"));
        assert!(version_lt("0.1.0", "0.1.1"));
        assert!(version_lt("1.9.0", "1.10.0"));
        assert!(!version_lt("1.0.0", "1.0.0"));
        assert!(!version_lt("2.0.0", "1.9.9"));
        assert!(!version_lt("junk", "junk"));
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        let s = "é".repeat(10); // 2 bytes each
        let out = truncate(&s, 5);
        assert!(out.contains("truncated"));
    }

    #[test]
    fn wire_event_has_required_fields() {
        let ev = build_wire_event(
            "abc",
            "0.1.0",
            EventKind::CaptureFailure,
            Some("wgc_no_frames"),
            Some("no frames"),
            Some(serde_json::json!({"backend": "wgc"})),
            false,
        );
        assert_eq!(ev["install_id"], "abc");
        assert_eq!(ev["kind"], "capture_failure");
        assert_eq!(ev["code"], "wgc_no_frames");
        assert!(ev["event_id"].as_str().unwrap().len() > 10);
        assert_eq!(ev["context"]["backend"], "wgc");
    }
}
