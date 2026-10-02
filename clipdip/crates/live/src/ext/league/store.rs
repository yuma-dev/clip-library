//! CommunityDragon json with a disk cache, shared by the champion and augment lookups.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::de::DeserializeOwned;

use crate::util;

/// don't hammer CommunityDragon when it or the network is down
const RETRY_AFTER: Duration = Duration::from_secs(60);

pub struct Store {
    dir: Option<PathBuf>,
    pub agent: ureq::Agent,
    failed_at: Option<Instant>,
}

impl Store {
    pub fn new(dir: Option<PathBuf>) -> Store {
        Store {
            dir,
            agent: util::http::agent(),
            failed_at: None,
        }
    }

    /// GET `url`, parse it, keep the raw body on disk as `cached`
    pub fn fetch<T: DeserializeOwned>(&mut self, url: &str, cached: &str) -> Option<T> {
        if self.failed_at.is_some_and(|t| t.elapsed() < RETRY_AFTER) {
            return None;
        }
        let body = self
            .agent
            .get(url)
            .call()
            .ok()
            .and_then(|r| r.into_string().ok());
        let parsed = body
            .as_deref()
            .and_then(|b| serde_json::from_str::<T>(b).ok().map(|v| (b, v)));
        let Some((raw, value)) = parsed else {
            self.failed_at = Some(Instant::now());
            return None;
        };
        if let Some(dir) = &self.dir {
            write_atomic(&dir.join(cached), raw);
        }
        Some(value)
    }

    pub fn cached<T: DeserializeOwned>(&self, name: &str, max_age: Duration) -> Option<T> {
        let path = self.dir.as_ref()?.join(name);
        let age = std::fs::metadata(&path).ok()?.modified().ok()?;
        if SystemTime::now().duration_since(age).unwrap_or_default() > max_age {
            return None;
        }
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
    }
}

fn write_atomic(path: &Path, body: &str) {
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}
