//! Durable offline event queue, stored as NDJSON. Events carry their
//! `event_id` before queuing, so a resend after an ambiguous failure is a
//! safe, server-deduped no-op.

use crate::paths;
use anyhow::{Context, Result};
use std::io::Write;

/// Drop the oldest events past this many lines if the server is down a while.
const MAX_LINES: usize = 5_000;

/// Appends one JSON line, creating the parent dir/file if needed. Safe from
/// any thread including the panic hook, a short append under the OS lock.
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

/// Malformed lines are skipped rather than poisoning the whole queue.
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

/// Atomic rewrite (temp file + rename) to hold `remaining`, enforcing [`MAX_LINES`].
pub fn rewrite(remaining: &[serde_json::Value]) -> Result<()> {
    let path = paths::queue_path().context("no queue path")?;

    if remaining.is_empty() {
        std::fs::remove_file(&path).ok();
        return Ok(());
    }

    // keep only the newest MAX_LINES if we've fallen badly behind
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
