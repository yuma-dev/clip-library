//! Well-known on-disk locations the diagnostics client reads and writes.
//!
//! Everything hangs off the same `clipdip` project dirs the rest of the app
//! uses, so the install id, offline event queue, and the log tail we attach to
//! events all live under `%LOCALAPPDATA%\clipdip\data\` on Windows. The config
//! file we bundle for manual uploads lives under the config dir.

use std::path::PathBuf;

fn dirs() -> Option<directories::ProjectDirs> {
    directories::ProjectDirs::from("", "", "clipdip")
}

/// `%LOCALAPPDATA%\clipdip\data`.
pub fn data_dir() -> Option<PathBuf> {
    dirs().map(|d| d.data_local_dir().to_path_buf())
}

/// The rolling app log the health monitor and pipeline write to. We attach the
/// tail of this to `capture_failure` / `crash` events.
pub fn log_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("logs").join("clipdip.log"))
}

/// Rotated-out previous log (present only after a >10 MB rotation at startup).
pub fn log_path_old() -> Option<PathBuf> {
    data_dir().map(|d| d.join("logs").join("clipdip.log.old"))
}

/// Newline-delimited JSON queue of events awaiting upload. Durable across
/// restarts so a crash report enqueued right before an abort still ships on the
/// next launch.
pub fn queue_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("diag-queue.jsonl"))
}

/// The persisted anonymous install id (a bare UUIDv4).
pub fn install_id_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("install_id"))
}

/// The user-editable config TOML. Safe to bundle — it holds no secrets (Discord
/// OAuth tokens live in a separate file that we deliberately never include).
pub fn config_path() -> Option<PathBuf> {
    dirs().map(|d| d.config_dir().join("config.toml"))
}

/// Dirty-shutdown marker: written at session start with the session's identity,
/// removed on any clean exit. Present at boot ⇒ the previous session died
/// without a shutdown path running (hard crash, taskkill, power loss).
pub fn dirty_marker_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("session_dirty"))
}

/// Lifetime clips-saved counter (a plain integer). Feeds the heartbeat's
/// `app.clips_saved_total`; kept out of config.toml so the ClipLib bridge's
/// config writes can never race it.
pub fn clips_saved_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("clips_saved_total"))
}
