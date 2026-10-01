//! Discord's detectable-apps list, cut down to what matching needs and cached
//! on disk in our own compact form. The raw list is ~13 MB of JSON; the cache
//! keeps id, name, aliases, icon, store ids and windows exe rules.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

use crate::norm;

const DETECTABLE_URL: &str = "https://discord.com/api/v9/applications/detectable";
/// bump when the cache layout changes, older files get refetched
const CACHE_FORMAT: u32 = 1;

#[derive(Deserialize)]
struct RawApp {
    id: String,
    name: String,
    #[serde(default)]
    aliases: Option<Vec<String>>,
    #[serde(default)]
    executables: Option<Vec<RawExe>>,
    #[serde(default)]
    icon_hash: Option<String>,
    #[serde(default)]
    third_party_skus: Option<Vec<RawSku>>,
}

#[derive(Deserialize)]
struct RawExe {
    name: String,
    #[serde(default)]
    os: String,
    #[serde(default)]
    is_launcher: bool,
}

#[derive(Deserialize)]
struct RawSku {
    #[serde(default)]
    distributor: String,
    #[serde(default)]
    id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct App {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steam: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epic: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exes: Vec<Exe>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Exe {
    /// lowercase, forward slashes, e.g. `win64/valorant-win64-shipping.exe`
    pub rule: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub launcher: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize, Deserialize)]
pub(crate) struct CacheFile {
    pub format: u32,
    #[serde(default)]
    pub etag: Option<String>,
    #[serde(default)]
    pub last_modified: Option<String>,
    /// unix seconds
    pub fetched_at: i64,
    pub apps: Vec<App>,
}

/// One exe rule pointing back at its app.
pub(crate) struct Rule {
    pub app: u32,
    pub rule: String,
    pub launcher: bool,
}

pub(crate) struct Index {
    pub apps: Vec<App>,
    /// rules keyed by the exe file name they end in
    pub by_exe: HashMap<String, Vec<Rule>>,
    /// app by normalized name or alias
    pub by_name: HashMap<String, u32>,
    pub by_steam: HashMap<String, u32>,
    pub by_epic: HashMap<String, u32>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub fetched_at: i64,
}

impl Index {
    pub fn empty() -> Self {
        Self::build(Vec::new(), None, None, 0)
    }

    pub fn build(
        apps: Vec<App>,
        etag: Option<String>,
        last_modified: Option<String>,
        fetched_at: i64,
    ) -> Self {
        let mut by_exe: HashMap<String, Vec<Rule>> = HashMap::new();
        let mut by_name = HashMap::new();
        let mut by_steam = HashMap::new();
        let mut by_epic = HashMap::new();
        for (i, app) in apps.iter().enumerate() {
            let i = i as u32;
            for exe in &app.exes {
                let base = exe.rule.rsplit('/').next().unwrap_or(&exe.rule).to_string();
                by_exe.entry(base).or_default().push(Rule {
                    app: i,
                    rule: exe.rule.clone(),
                    launcher: exe.launcher,
                });
            }
            // first claim wins, the list is roughly ordered by app age so the original game keeps
            // its name over later re-releases
            for n in std::iter::once(&app.name).chain(app.aliases.iter()) {
                let k = norm(n);
                if !k.is_empty() {
                    by_name.entry(k).or_insert(i);
                }
            }
            if let Some(s) = &app.steam {
                by_steam.entry(s.clone()).or_insert(i);
            }
            if let Some(e) = &app.epic {
                by_epic.entry(e.to_ascii_lowercase()).or_insert(i);
            }
        }
        Self {
            apps,
            by_exe,
            by_name,
            by_steam,
            by_epic,
            etag,
            last_modified,
            fetched_at,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.apps.is_empty()
    }

    /// Identifies the data the index was built from. Callers that remember
    /// "this clip had no match" retry once it changes.
    pub fn version(&self) -> String {
        self.last_modified
            .clone()
            .or_else(|| self.etag.clone())
            .unwrap_or_else(|| "none".into())
    }

    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
        let file: CacheFile = serde_json::from_slice(&raw).context("parse gamedb cache")?;
        if file.format != CACHE_FORMAT {
            return Err(anyhow!("gamedb cache format {} (want {CACHE_FORMAT})", file.format));
        }
        Ok(Self::build(file.apps, file.etag, file.last_modified, file.fetched_at))
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let file = CacheFile {
            format: CACHE_FORMAT,
            etag: self.etag.clone(),
            last_modified: self.last_modified.clone(),
            fetched_at: self.fetched_at,
            apps: self.apps.clone(),
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // tmp + rename so the cli and the running app never read half a file
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&file)?)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

pub(crate) enum Fetched {
    NotModified,
    New(Index),
}

/// Conditional GET against Discord. `NotModified` when the ETag still matches.
pub(crate) fn fetch(prev: &Index, now: i64) -> Result<Fetched> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("clipdip/", env!("CARGO_PKG_VERSION")))
        .build();
    let mut req = agent.get(DETECTABLE_URL);
    if !prev.is_empty() {
        if let Some(etag) = &prev.etag {
            req = req.set("If-None-Match", etag);
        }
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(304, _)) => return Ok(Fetched::NotModified),
        Err(e) => return Err(anyhow!("fetch detectable apps: {e}")),
    };
    if resp.status() == 304 {
        return Ok(Fetched::NotModified);
    }
    let etag = resp.header("etag").map(str::to_string);
    let last_modified = resp.header("last-modified").map(str::to_string);
    // into_string caps at 10 MB and the list is past that, so read it ourselves
    let mut body = Vec::new();
    resp.into_reader()
        .take(128 * 1024 * 1024)
        .read_to_end(&mut body)
        .context("read detectable apps")?;
    let apps = parse_raw(&body)?;
    drop(body);
    if apps.len() < 1000 {
        // a broken or truncated response must not replace a good cache
        return Err(anyhow!("detectable apps list suspiciously short ({})", apps.len()));
    }
    Ok(Fetched::New(Index::build(apps, etag, last_modified, now)))
}

pub(crate) fn parse_raw(body: &[u8]) -> Result<Vec<App>> {
    let raw: Vec<RawApp> = serde_json::from_slice(body).context("parse detectable apps")?;
    Ok(raw.into_iter().map(compact).collect())
}

fn compact(a: RawApp) -> App {
    let mut steam = None;
    let mut epic = None;
    for sku in a.third_party_skus.unwrap_or_default() {
        let Some(id) = sku.id.filter(|s| !s.is_empty()) else { continue };
        match sku.distributor.as_str() {
            "steam" if steam.is_none() => steam = Some(id),
            "epic" if epic.is_none() => epic = Some(id),
            _ => {}
        }
    }
    let exes = a
        .executables
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.os == "win32")
        .map(|e| Exe {
            rule: e.name.to_lowercase().replace('\\', "/").trim_start_matches('/').to_string(),
            launcher: e.is_launcher,
        })
        .collect();
    let aliases = a
        .aliases
        .unwrap_or_default()
        .into_iter()
        .filter(|al| al != &a.name)
        .collect();
    App {
        id: a.id,
        name: a.name,
        aliases,
        icon: a.icon_hash.filter(|h| !h.is_empty()),
        steam,
        epic,
        exes,
    }
}
