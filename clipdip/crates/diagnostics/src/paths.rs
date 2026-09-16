//! On-disk locations the diagnostics client reads and writes: data under
//! `%LOCALAPPDATA%\clipdip\data\`, bundled config under the config dir.

use std::path::PathBuf;

fn dirs() -> Option<directories::ProjectDirs> {
    directories::ProjectDirs::from("", "", "clipdip")
}

/// `%LOCALAPPDATA%\clipdip\data`.
pub fn data_dir() -> Option<PathBuf> {
    dirs().map(|d| d.data_local_dir().to_path_buf())
}

/// Rolling app log; its tail is attached to `capture_failure` / `crash` events.
pub fn log_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("logs").join("clipdip.log"))
}

/// Rotated-out previous log (present only after a >10 MB rotation at startup).
pub fn log_path_old() -> Option<PathBuf> {
    data_dir().map(|d| d.join("logs").join("clipdip.log.old"))
}

/// NDJSON queue of events awaiting upload, durable across restarts.
pub fn queue_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("diag-queue.jsonl"))
}

/// The persisted anonymous install id (a bare UUIDv4).
pub fn install_id_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("install_id"))
}

/// User-editable config TOML, safe to bundle (Discord OAuth tokens live elsewhere).
pub fn config_path() -> Option<PathBuf> {
    dirs().map(|d| d.config_dir().join("config.toml"))
}

/// Written at session start, removed on clean exit; present at boot means the
/// previous session died (crash, taskkill, power loss).
pub fn dirty_marker_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("session_dirty"))
}

/// Feeds heartbeat's `app.clips_saved_total`; kept out of config.toml so
/// ClipLib bridge writes can't race it.
pub fn clips_saved_path() -> Option<PathBuf> {
    data_dir().map(|d| d.join("clips_saved_total"))
}
