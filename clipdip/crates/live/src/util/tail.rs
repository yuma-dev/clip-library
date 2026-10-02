//! Follows a log file the way `tail -f` would, cheaply: each `poll` reads only
//! the bytes added since the last one. A file that shrinks or is recreated (a
//! new game launch rewrites its log) starts over from the top.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// one line longer than this is junk (a dumped blob), not something to parse
const MAX_PARTIAL: usize = 256 * 1024;

pub struct Tail {
    path: PathBuf,
    offset: u64,
    created: Option<SystemTime>,
    partial: Vec<u8>,
    started: bool,
    /// how much of an existing file the first poll reads, from its end
    first_read: u64,
}

impl Tail {
    /// `first_read`: bytes of history to read on the first poll (0 = only new
    /// lines). A session's state usually sits in the last few hundred KB.
    pub fn new(path: impl Into<PathBuf>, first_read: u64) -> Self {
        Tail {
            path: path.into(),
            offset: 0,
            created: None,
            partial: Vec::new(),
            started: false,
            first_read,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Calls `on` for every complete new line (without the line ending, lossy
    /// UTF-8). Missing file or any IO error is just "no new lines".
    pub fn poll(&mut self, mut on: impl FnMut(&str)) {
        let Ok(mut f) = File::open(&self.path) else {
            return;
        };
        let Ok(meta) = f.metadata() else { return };
        let len = meta.len();
        let created = meta.created().ok();
        if len < self.offset || (self.started && created != self.created) {
            self.offset = 0;
            self.partial.clear();
        }
        if !self.started {
            self.offset = len.saturating_sub(self.first_read);
            self.started = true;
        }
        self.created = created;
        if len <= self.offset {
            return;
        }
        if f.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let mut buf = Vec::new();
        let Ok(n) = f.take(len - self.offset).read_to_end(&mut buf) else {
            return;
        };
        self.offset += n as u64;
        self.partial.extend_from_slice(&buf);
        let Some(last_nl) = self.partial.iter().rposition(|&b| b == b'\n') else {
            if self.partial.len() > MAX_PARTIAL {
                self.partial.clear();
            }
            return;
        };
        for line in self.partial[..last_nl].split(|&b| b == b'\n') {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line.is_empty() || line.len() > MAX_PARTIAL {
                continue;
            }
            on(&String::from_utf8_lossy(line));
        }
        self.partial.drain(..=last_nl);
        if self.partial.len() > MAX_PARTIAL {
            self.partial.clear();
        }
    }
}

/// The newest file in `dir` whose name passes `want`, for games that start a new log per launch.
pub fn newest_file(dir: &Path, want: impl Fn(&str) -> bool) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| want(&e.file_name().to_string_lossy()))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_only_new_complete_lines() {
        let dir = std::env::temp_dir().join(format!("clipdip-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.log");
        std::fs::write(&p, "old 1\r\nold 2\n").unwrap();
        let mut t = Tail::new(&p, 0);
        let mut got = Vec::new();
        t.poll(|l| got.push(l.to_string()));
        assert!(got.is_empty(), "history skipped with first_read 0");
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        write!(f, "new 1\r\nhalf").unwrap();
        t.poll(|l| got.push(l.to_string()));
        assert_eq!(got, vec!["new 1"]);
        writeln!(f, " done").unwrap();
        t.poll(|l| got.push(l.to_string()));
        assert_eq!(got, vec!["new 1", "half done"]);
        // a relaunch truncates the log
        std::fs::write(&p, "fresh\n").unwrap();
        t.poll(|l| got.push(l.to_string()));
        assert_eq!(got.last().map(String::as_str), Some("fresh"));

        let mut h = Tail::new(&p, 1 << 20);
        let mut first = Vec::new();
        h.poll(|l| first.push(l.to_string()));
        assert_eq!(first, vec!["fresh"]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
