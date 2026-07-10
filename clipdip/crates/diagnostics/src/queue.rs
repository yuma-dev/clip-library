//! Durable offline event queue, stored as newline-delimited JSON.
//!
//! Each line is a fully-formed wire event (install id, event id, kind, …) ready
//! to POST. Events are stamped with their `event_id` *before* they hit the
//! queue, so a resend after an ambiguous failure is a safe, server-deduped
//! no-op. Only the manager thread mutates the file, except for the panic-hook
//! crash path which appends synchronously (see [`append`]).

use crate::paths;
use anyhow::{Context, Result};
use std::io::Write;

/// Never let the queue grow without bound if the server is down for a long
/// time — drop the oldest events past this many lines.
const MAX_LINES: usize = 5_000;

/// Append one wire event as a single JSON line. Creates the parent dir and file
/// if needed. Safe to call from any thread (including the panic hook): it's a
/// short append under the OS file lock, not the hot capture path.
pub fn append(event: &serde_json::Value) -> Result<()> {
    let path = paths::queue_path().context("no queue path")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut line = serde_json::to_string(event).context("serialize event")?;
    line.push('\n');
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .context("open queue for append")?;
    f.write_all(line.as_bytes()).context("append event")?;
    Ok(())
}

/// Parse every queued event. Malformed lines are skipped rather than poisoning
/// the whole queue.
pub fn read_all() -> Vec<serde_json::Value> {
    let Some(path) = paths::queue_path() else {
        return Vec::new();
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    contents
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Rewrite the queue file to hold exactly `remaining` (atomically via a temp
/// file + rename). Passing an empty slice removes the file. Also enforces the
/// [`MAX_LINES`] cap, dropping the oldest.
pub fn rewrite(remaining: &[serde_json::Value]) -> Result<()> {
    let path = paths::queue_path().context("no queue path")?;

    if remaining.is_empty() {
        std::fs::remove_file(&path).ok();
        return Ok(());
    }

    // Keep only the newest MAX_LINES if we've fallen badly behind.
    let start = remaining.len().saturating_sub(MAX_LINES);
    let kept = &remaining[start..];

    let mut body = String::with_capacity(kept.len() * 256);
    for ev in kept {
        if let Ok(s) = serde_json::to_string(ev) {
            body.push_str(&s);
            body.push('\n');
        }
    }

    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, body.as_bytes()).context("write temp queue")?;
    std::fs::rename(&tmp, &path).context("rename temp queue")?;
    Ok(())
}
