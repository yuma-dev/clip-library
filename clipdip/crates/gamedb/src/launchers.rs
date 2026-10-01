//! Offline fallback for games Discord doesn't list: an exe inside a Steam
//! library or an Epic install folder is a game by definition, and the
//! launcher's own manifest names it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

const EPIC_MANIFESTS: &str = r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests";
/// a game installed while we run shows up after this
const RELOAD_AFTER: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug)]
pub(crate) struct LocalGame {
    pub store: &'static str,
    pub id: String,
    pub name: String,
}

struct SteamLib {
    loaded: Instant,
    /// games by lowercase installdir
    games: HashMap<String, LocalGame>,
}

struct EpicGame {
    /// lowercase, forward slashes, trailing slash
    dir: String,
    game: LocalGame,
}

#[derive(Default)]
pub(crate) struct Launchers {
    steam: Mutex<HashMap<PathBuf, SteamLib>>,
    epic: Mutex<Option<(Instant, Vec<EpicGame>)>>,
}

impl Launchers {
    pub fn lookup(&self, exe_path: &Path) -> Option<LocalGame> {
        let full = exe_path.to_string_lossy().replace('\\', "/");
        let lower = full.to_ascii_lowercase();
        if let Some(g) = self.steam(&full, &lower) {
            return Some(g);
        }
        self.epic(&lower)
    }

    fn steam(&self, full: &str, lower: &str) -> Option<LocalGame> {
        const MARK: &str = "/steamapps/common/";
        let at = lower.find(MARK)?;
        let rest = &lower[at + MARK.len()..];
        let installdir = rest.split('/').next().filter(|s| !s.is_empty())?;
        if !rest.contains('/') {
            return None;
        }
        // ascii lowercasing keeps byte offsets, so a slice of lower maps onto full
        let steamapps = PathBuf::from(&full[..at + "/steamapps".len()]);

        let mut libs = self.steam.lock();
        let stale = libs
            .get(&steamapps)
            .map(|l| l.loaded.elapsed() > RELOAD_AFTER || !l.games.contains_key(installdir))
            .unwrap_or(true);
        if stale {
            // a miss also reloads, but at most every 30s so a non-steam tool in common/ can't
            // make every focus change rescan
            let recent = libs
                .get(&steamapps)
                .map(|l| l.loaded.elapsed() < Duration::from_secs(30))
                .unwrap_or(false);
            if !recent {
                libs.insert(
                    steamapps.clone(),
                    SteamLib {
                        loaded: Instant::now(),
                        games: read_steam_manifests(&steamapps),
                    },
                );
            }
        }
        libs.get(&steamapps)?.games.get(installdir).cloned()
    }

    fn epic(&self, lower: &str) -> Option<LocalGame> {
        let mut cache = self.epic.lock();
        if cache.as_ref().map(|(t, _)| t.elapsed() > RELOAD_AFTER).unwrap_or(true) {
            *cache = Some((Instant::now(), read_epic_manifests(Path::new(EPIC_MANIFESTS))));
        }
        let (_, games) = cache.as_ref()?;
        games
            .iter()
            .find(|g| lower.starts_with(&g.dir))
            .map(|g| g.game.clone())
    }
}

fn read_steam_manifests(steamapps: &Path) -> HashMap<String, LocalGame> {
    let mut out = HashMap::new();
    let Ok(entries) = std::fs::read_dir(steamapps) else { return out };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.starts_with("appmanifest_") && name.ends_with(".acf")) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
        let (Some(id), Some(title), Some(dir)) = (
            acf_value(&text, "appid"),
            acf_value(&text, "name"),
            acf_value(&text, "installdir"),
        ) else {
            continue;
        };
        out.insert(
            dir.to_ascii_lowercase(),
            LocalGame {
                store: "steam",
                id,
                name: title,
            },
        );
    }
    out
}

/// First `"key"  "value"` pair in a Valve KeyValues text file. Keys in an
/// appmanifest's top level come before any nested block, so first is right.
pub(crate) fn acf_value(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix(&needle) else { continue };
        let rest = rest.trim();
        let rest = rest.strip_prefix('"')?;
        let end = rest.find('"')?;
        return Some(rest[..end].replace("\\\\", "\\"));
    }
    None
}

fn read_epic_manifests(dir: &Path) -> Vec<EpicGame> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        if e.path().extension().and_then(|x| x.to_str()) != Some("item") {
            continue;
        }
        let Ok(raw) = std::fs::read(e.path()) else { continue };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) else { continue };
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).filter(|x| !x.is_empty());
        let (Some(name), Some(loc), Some(id)) =
            (s("DisplayName"), s("InstallLocation"), s("CatalogItemId"))
        else {
            continue;
        };
        let mut dir = loc.replace('\\', "/").to_ascii_lowercase();
        if !dir.ends_with('/') {
            dir.push('/');
        }
        out.push(EpicGame {
            dir,
            game: LocalGame {
                store: "epic",
                id: id.to_string(),
                name: name.to_string(),
            },
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_acf_top_level_values() {
        let text = "\"AppState\"\n{\n\t\"appid\"\t\t\"1057090\"\n\t\"name\"\t\t\"Ori and the Will of the Wisps\"\n\t\"installdir\"\t\t\"Ori and the Will of the Wisps\"\n}";
        assert_eq!(acf_value(text, "appid").as_deref(), Some("1057090"));
        assert_eq!(acf_value(text, "name").as_deref(), Some("Ori and the Will of the Wisps"));
        assert_eq!(acf_value(text, "missing"), None);
    }
}
