//! Which game is this exe? Matches a running exe (plus its window title when
//! that helps) against Discord's detectable-apps list, then local Steam/Epic
//! manifests. Only positive evidence counts: an app no rule claims is not a
//! game, so there is no list of non-games to maintain.
//!
//! Rules, strongest first:
//! - exe-path: a Discord rule with folders matches the path suffix (how Discord detects too)
//! - exe-title: several apps share the exe name, the window title picks one
//! - exe: a folderless Discord rule matches the exe name
//! - host-title: emulators and java, where the window title is the game
//! - steam / epic: the exe sits in a Steam library or Epic install folder
//! - title-stem: title equals a Discord app name and the exe name agrees with it

mod index;
mod launchers;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use index::{Fetched, Index};
use launchers::Launchers;

/// Discord's list changes daily but games we care about rarely move
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(6 * 3600);

/// emulators and runtimes whose window title names the game they run
const HOSTS: &[&str] = &[
    "ryujinx", "yuzu", "suyu", "sudachi", "citron", "eden", "dolphin", "cemu", "rpcs3",
    "pcsx2", "pcsx2-qt", "ppsspp", "ppssppwindows64", "retroarch", "duckstation",
    "duckstation-qt-x64-releaseltcg", "xemu", "xenia", "xenia_canary", "vita3k", "shadps4",
    "melonds", "mgba", "java", "javaw",
];

/// unreal/unity build suffixes that hide the game name in the exe stem
const STEM_SUFFIXES: &[&str] = &[
    "-win64-shipping", "-wingrts-shipping", "-wingdk-shipping", "-win64-test", "-win64",
    ".x64", "_x64", "-x64",
];

/// normalized store-name endings of builds that aren't the full game
const DEMO_SUFFIXES: &[&str] = &[" demo", " playtest", " prologue", " beta", " open beta"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    ExePath,
    ExeTitle,
    Exe,
    HostTitle,
    /// a store folder whose app Discord lists as a game
    SteamListed,
    EpicListed,
    /// a store folder Discord doesn't know, could be a tool (Wallpaper Engine)
    Steam,
    Epic,
    TitleStem,
}

impl Source {
    /// Exe rules, emulator titles and store apps Discord lists as games. The rest can catch a
    /// tool installed through Steam, so live detection lets those sessions lapse out of focus.
    /// Listed store apps count because an idle game left running in the background (Find The
    /// Needle) lost its card after 10 minutes.
    pub fn is_strong(self) -> bool {
        matches!(
            self,
            Source::ExePath
                | Source::ExeTitle
                | Source::Exe
                | Source::HostTitle
                | Source::SteamListed
                | Source::EpicListed
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Game {
    /// Discord application id, or `steam:<appid>` / `epic:<catalog id>` for
    /// games Discord doesn't list
    pub id: String,
    /// Discord's own app name, verbatim, case included: Discord drops its detected
    /// "Playing <name>" only when our activity's name matches it exactly
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub steam_appid: Option<String>,
    /// square-ish art usable as a rich presence image
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    pub source: Source,
}

pub struct GameDb {
    index: RwLock<Arc<Index>>,
    launchers: Launchers,
    cache_path: Option<PathBuf>,
    refresh_lock: Mutex<()>,
}

impl GameDb {
    /// Loads the cached index if there is one. Never touches the network;
    /// see [`GameDb::refresh_if_stale`] and [`GameDb::spawn_refresher`].
    pub fn open() -> Arc<Self> {
        let cache_path = directories::ProjectDirs::from("", "", "clipdip")
            .map(|d| d.data_local_dir().join("gamedb").join("detectable.json"));
        let index = match cache_path.as_deref() {
            Some(p) if p.exists() => Index::load(p).unwrap_or_else(|e| {
                warn!("gamedb: cache unreadable, starting empty: {e:#}");
                Index::empty()
            }),
            _ => Index::empty(),
        };
        info!(apps = index.apps.len(), version = %index.version(), "gamedb: opened");
        Arc::new(Self {
            index: RwLock::new(Arc::new(index)),
            launchers: Launchers::default(),
            cache_path,
            refresh_lock: Mutex::new(()),
        })
    }

    /// Builds from a raw Discord response body, for tests and tools.
    pub fn from_discord_json(body: &[u8]) -> Result<Arc<Self>> {
        let apps = index::parse_raw(body)?;
        Ok(Arc::new(Self {
            index: RwLock::new(Arc::new(Index::build(apps, None, None, now_unix()))),
            launchers: Launchers::default(),
            cache_path: None,
            refresh_lock: Mutex::new(()),
        }))
    }

    pub fn version(&self) -> String {
        self.index.read().version()
    }

    pub fn app_count(&self) -> usize {
        self.index.read().apps.len()
    }

    fn age(&self) -> Option<Duration> {
        let fetched = self.index.read().fetched_at;
        if fetched <= 0 {
            return None;
        }
        Some(Duration::from_secs((now_unix() - fetched).max(0) as u64))
    }

    /// Blocking. Refetches when the cache is missing or older than a week.
    /// Returns true when the index changed.
    pub fn refresh_if_stale(&self) -> Result<bool> {
        if self.age().map(|a| a < MAX_AGE).unwrap_or(false) {
            return Ok(false);
        }
        self.refresh()
    }

    fn refresh(&self) -> Result<bool> {
        let _guard = self.refresh_lock.lock();
        let current = self.index.read().clone();
        match index::fetch(&current, now_unix())? {
            Fetched::NotModified => {
                // same data, but restart the week so we don't ask again tomorrow
                let bumped = Index::build(
                    current.apps.clone(),
                    current.etag.clone(),
                    current.last_modified.clone(),
                    now_unix(),
                );
                self.persist(&bumped);
                *self.index.write() = Arc::new(bumped);
                info!("gamedb: detectable apps unchanged");
                Ok(false)
            }
            Fetched::New(fresh) => {
                info!(apps = fresh.apps.len(), version = %fresh.version(), "gamedb: detectable apps updated");
                self.persist(&fresh);
                *self.index.write() = Arc::new(fresh);
                Ok(true)
            }
        }
    }

    fn persist(&self, idx: &Index) {
        if let Some(p) = &self.cache_path {
            if let Err(e) = idx.save(p) {
                warn!("gamedb: cache write failed: {e:#}");
            }
        }
    }

    /// Background thread that keeps the cache under a week old.
    pub fn spawn_refresher(self: &Arc<Self>) {
        let db = Arc::clone(self);
        let _ = std::thread::Builder::new()
            .name("clipdip-gamedb".into())
            .spawn(move || {
                // stay out of the way of startup, the cached index serves until then
                std::thread::sleep(Duration::from_secs(20));
                loop {
                    let wait = match db.refresh_if_stale() {
                        Ok(_) => RETRY_AFTER_FAILURE,
                        Err(e) => {
                            warn!("gamedb: refresh failed: {e:#}");
                            RETRY_AFTER_FAILURE
                        }
                    };
                    std::thread::sleep(wait);
                }
            });
    }

    /// a Discord app by id, for settings previews of games not played yet
    pub fn app_by_id(&self, id: &str) -> Option<Game> {
        let idx = self.index.read().clone();
        let app = idx.apps.iter().position(|a| a.id == id)?;
        Some(game_from(&idx, app as u32, Source::Exe))
    }

    /// `stem` defaults to the exe file stem. `title` is only called when a
    /// rule needs it, reading it costs ~130us and can stall on a hung window.
    pub fn resolve(
        &self,
        exe_path: Option<&Path>,
        stem: Option<&str>,
        title: &mut dyn FnMut() -> Option<String>,
    ) -> Option<Game> {
        let idx = self.index.read().clone();
        let stem = stem
            .map(str::to_string)
            .or_else(|| exe_path.and_then(|p| p.file_stem()).map(|s| s.to_string_lossy().to_string()))?;
        if stem.trim().is_empty() {
            return None;
        }
        let mut forms = TitleForms { get: title, forms: None };
        let stem_lower = stem.to_lowercase();
        let lp = exe_path.map(|p| p.to_string_lossy().to_lowercase().replace('\\', "/"));

        let base = format!("{stem_lower}.exe");
        let rules = idx.by_exe.get(&base);
        let path_rule = || {
            let lp = lp.as_ref()?;
            rules?.iter().find(|r| lp.ends_with(&format!("/{}", r.rule)))
        };

        if HOSTS.contains(&stem_lower.as_str()) {
            if let Some(app) = host_title(&idx, &stem_lower, forms.get()) {
                return Some(game_from(&idx, app, Source::HostTitle));
            }
            // javaw.exe runs every modpack launcher too, only an exact install folder counts
            return path_rule().map(|r| game_from(&idx, r.app, Source::ExePath));
        }

        if let Some(rules) = rules {
            if let Some(r) = path_rule() {
                return Some(game_from(&idx, r.app, Source::ExePath));
            }
            let forms = forms.get();
            for r in rules {
                let app = &idx.apps[r.app as usize];
                if forms.iter().any(|f| names_of(app).any(|n| norm(n) == *f)) {
                    return Some(game_from(&idx, r.app, Source::ExeTitle));
                }
            }
            // folder rules exist to tell a game's generic exe apart from every other
            // game.exe, so with a known path only a folderless rule may match on name
            let pool: Vec<&index::Rule> = if lp.is_some() {
                rules.iter().filter(|r| !r.rule.contains('/')).collect()
            } else {
                rules.iter().collect()
            };
            if let Some(r) = pool.iter().find(|r| !r.launcher).or(pool.first()) {
                return Some(game_from(&idx, r.app, Source::Exe));
            }
        }

        if let Some(p) = exe_path {
            if let Some(local) = self.launchers.lookup(p) {
                let mapped = match local.store {
                    "steam" => idx.by_steam.get(&local.id).copied(),
                    _ => idx.by_epic.get(&local.id.to_ascii_lowercase()).copied(),
                }
                // demos and playtests have their own store id; the full game's entry carries the art
                .or_else(|| {
                    let n = norm(&local.name);
                    idx.by_name.get(&n).copied().or_else(|| {
                        DEMO_SUFFIXES
                            .iter()
                            .find_map(|s| n.strip_suffix(s))
                            .and_then(|base| idx.by_name.get(base.trim_end()).copied())
                    })
                });
                let steam = local.store == "steam";
                if let Some(app) = mapped {
                    let listed = if steam { Source::SteamListed } else { Source::EpicListed };
                    return Some(game_from(&idx, app, listed));
                }
                let source = if steam { Source::Steam } else { Source::Epic };
                return Some(Game {
                    id: format!("{}:{}", local.store, local.id),
                    name: local.name,
                    steam_appid: (local.store == "steam").then(|| local.id.clone()),
                    icon_url: (local.store == "steam").then(|| steam_art(&local.id)),
                    source,
                });
            }
        }

        let sq = stem_key(&stem_lower);
        // whole lines only: "Shape of Dreams - Run Manager" is a tool, cutting at " - " made it the game
        for f in forms.lines() {
            let Some(&app) = idx.by_name.get(&f) else { continue };
            let nq = f.replace(' ', "");
            // both signals have to agree: the title alone matched "Steam" for steamwebhelper.exe
            let agree = nq.chars().count() > 3
                && (nq.contains(&sq) || (sq.contains(&nq) && nq.len() * 2 >= sq.len()));
            if agree {
                return Some(game_from(&idx, app, Source::TitleStem));
            }
        }
        None
    }
}

struct TitleForms<'a> {
    get: &'a mut dyn FnMut() -> Option<String>,
    /// (every form, whole lines only)
    forms: Option<(Vec<String>, Vec<String>)>,
}

impl TitleForms<'_> {
    fn load(&mut self) -> &(Vec<String>, Vec<String>) {
        if self.forms.is_none() {
            let title = (self.get)();
            self.forms = Some(match title {
                Some(t) => (title_forms(&t), title_lines(&t)),
                None => (Vec::new(), Vec::new()),
            });
        }
        self.forms.as_ref().expect("filled above")
    }

    fn get(&mut self) -> &[String] {
        &self.load().0
    }

    fn lines(&mut self) -> Vec<String> {
        self.load().1.clone()
    }
}

fn names_of(app: &index::App) -> impl Iterator<Item = &String> {
    std::iter::once(&app.name).chain(app.aliases.iter())
}

fn host_title(idx: &Index, stem: &str, forms: &[String]) -> Option<u32> {
    let own = norm(stem).replace(' ', "");
    // the emulator's own "Ryujinx 1.3.269" line must not count as a game
    let forms: Vec<&String> = forms
        .iter()
        .filter(|f| !f.replace(' ', "").starts_with(&own))
        .collect();
    for f in &forms {
        if let Some(&app) = idx.by_name.get(f.as_str()) {
            return Some(app);
        }
    }
    // "minecraft neoforge 1 21 1": the longest app name the title starts with
    let mut best: Option<(usize, u32)> = None;
    for f in &forms {
        for (k, &app) in &idx.by_name {
            if k.len() > 4 && f.len() > k.len() && f.starts_with(k.as_str()) && f.as_bytes()[k.len()] == b' ' {
                if best.map(|(l, _)| k.len() > l).unwrap_or(true) {
                    best = Some((k.len(), app));
                }
            }
        }
    }
    best.map(|(_, app)| app)
}

// Discord's own icon is wrong for these (Star Citizen's is a power button), ours come from the art pack
const ICON_FIX: &[(&str, &str)] = &[(
    "452295596917784577",
    "https://cdn.jsdelivr.net/gh/yuma-dev/cliplib-rpc-assets@v3/star-citizen/logo.webp",
)];

fn game_from(idx: &Index, app: u32, source: Source) -> Game {
    let a = &idx.apps[app as usize];
    let fixed = ICON_FIX.iter().find(|(id, _)| *id == a.id).map(|(_, url)| url.to_string());
    let icon_url = fixed
        .or_else(|| {
            a.icon
                .as_ref()
                .map(|h| format!("https://cdn.discordapp.com/app-icons/{}/{h}.png?size=512", a.id))
        })
        .or_else(|| a.steam.as_deref().map(steam_art));
    Game {
        id: a.id.clone(),
        name: a.name.clone(),
        steam_appid: a.steam.clone(),
        icon_url,
        source,
    }
}

fn steam_art(appid: &str) -> String {
    format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_600x900.jpg")
}

/// Lowercase, alphanumerics separated by single spaces. Strips the
/// zero-width characters ARC Raiders pads its title with and trademark signs.
pub fn norm(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        match c {
            '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}' | '\u{00AD}' | '™' | '®' | '©' => {}
            '&' => {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str("and");
                space = true;
            }
            c if c.is_alphanumeric() => {
                if space && !out.is_empty() {
                    out.push(' ');
                }
                space = false;
                out.extend(c.to_lowercase());
            }
            _ => space = true,
        }
    }
    out
}

/// Candidate game names hidden in a window title: each line, and each line
/// cut at " - ", " | " and " (". "Rocket League (64-bit, DX11, Cooked)",
/// "Minecraft 1.21 - Singleplayer", Ryujinx's multi-line title, Dolphin's
/// "Dolphin 5.0 | JIT64 | Super Mario Sunshine (GMSE01)".
fn title_forms(title: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: &str| {
        let n = norm(s);
        if !n.is_empty() && !out.contains(&n) {
            out.push(n);
        }
    };
    for line in title.lines().map(str::trim).filter(|l| !l.is_empty()) {
        push(line);
        for seg in line.split(" | ") {
            push(seg);
            if let Some((head, _)) = seg.split_once(" - ") {
                push(head);
            }
            if let Some((head, _)) = seg.split_once(" (") {
                push(head);
            }
        }
    }
    out
}

fn title_lines(title: &str) -> Vec<String> {
    title.lines().map(norm).filter(|l| !l.is_empty()).collect()
}

fn stem_key(stem_lower: &str) -> String {
    let mut s = stem_lower;
    for suf in STEM_SUFFIXES {
        if let Some(t) = s.strip_suffix(suf) {
            s = t;
            break;
        }
    }
    norm(s).replace(' ', "")
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // shapes copied from the real list, trimmed to the fields we read
    const SAMPLE: &str = r#"[
      {"id":"700136079562375258","name":"VALORANT","aliases":["VALORANT"],"icon_hash":"11f8","executables":[{"name":"win64/valorant-win64-shipping.exe","os":"win32","is_launcher":false}],"third_party_skus":[{"distributor":"epic","id":"CBD5"}]},
      {"id":"1","name":"Spiral Knights","executables":[{"name":"spiral knights/java_vm/bin/javaw.exe","os":"win32"}],"third_party_skus":[]},
      {"id":"2","name":"Minecraft","executables":[{"name":"minecraft/runtime/jre-x64/1.8.0_25/bin/javaw.exe","os":"win32"}],"third_party_skus":[]},
      {"id":"3","name":"Star Conflict","executables":[{"name":"star conflict/game.exe","os":"win32"}],"third_party_skus":[]},
      {"id":"4","name":"Brave","icon_hash":null,"executables":[],"third_party_skus":[{"distributor":"steam","id":"301830"}]},
      {"id":"5","name":"Steam","executables":[],"third_party_skus":[]},
      {"id":"6","name":"Forza Horizon 6","executables":[],"third_party_skus":[]},
      {"id":"7","name":"Tomodachi Life: Living the Dream","executables":[],"third_party_skus":[]},
      {"id":"8","name":"ARC Raiders","executables":[{"name":"pioneergame.exe","os":"win32"}],"third_party_skus":[{"distributor":"steam","id":"1808500"}]},
      {"id":"9","name":"UNO","executables":[{"name":"uno.exe","os":"win32"}],"third_party_skus":[]},
      {"id":"10","name":"Uno Online","executables":[{"name":"uno.exe","os":"win32"}],"third_party_skus":[]},
      {"id":"11","name":"Rocket League","executables":[{"name":"rocketleague.exe","os":"darwin"},{"name":"win64/rocketleague.exe","os":"win32"}],"third_party_skus":[]},
      {"id":"12","name":"Pagoda","executables":[],"third_party_skus":[]},
      {"id":"13","name":"Find The Needle","icon_hash":"abc","executables":[],"third_party_skus":[{"distributor":"steam","id":"5160800"}]}
    ]"#;

    fn db() -> Arc<GameDb> {
        GameDb::from_discord_json(SAMPLE.as_bytes()).unwrap()
    }

    fn run(db: &GameDb, path: Option<&str>, stem: Option<&str>, title: Option<&str>) -> Option<(String, Source)> {
        let t = title.map(str::to_string);
        db.resolve(path.map(Path::new), stem, &mut || t.clone())
            .map(|g| (g.name, g.source))
    }

    #[test]
    fn exe_rule_with_folder_matches_path_suffix() {
        let db = db();
        let r = run(&db, Some(r"C:\Riot Games\VALORANT\live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe"), None, None);
        assert_eq!(r, Some(("VALORANT".into(), Source::ExePath)));
    }

    #[test]
    fn generic_exe_outside_its_folder_is_not_a_game() {
        let db = db();
        assert_eq!(run(&db, Some(r"D:\tools\thing\game.exe"), None, Some("Thing")), None);
        assert_eq!(
            run(&db, Some(r"D:\Games\Star Conflict\game.exe"), None, None),
            Some(("Star Conflict".into(), Source::ExePath))
        );
    }

    #[test]
    fn apps_without_exe_rules_never_match_on_name_alone() {
        let db = db();
        assert_eq!(run(&db, Some(r"C:\Program Files\BraveSoftware\brave.exe"), None, Some("YouTube - Brave")), None);
        assert_eq!(run(&db, Some(r"C:\Program Files (x86)\Steam\bin\cef\steamwebhelper.exe"), None, Some("Steam")), None);
    }

    #[test]
    fn title_picks_between_apps_sharing_an_exe() {
        let db = db();
        assert_eq!(run(&db, None, Some("UNO"), Some("UNO")), Some(("UNO".into(), Source::ExeTitle)));
    }

    #[test]
    fn zero_width_padding_is_ignored() {
        let db = db();
        let title = "\u{FEFF}AR\u{FEFF}C\u{200B}\u{200B} R\u{200B}a\u{FEFF}id\u{FEFF}er\u{200B}s";
        assert_eq!(run(&db, None, Some("PioneerGame"), Some(title)), Some(("ARC Raiders".into(), Source::ExeTitle)));
    }

    #[test]
    fn hosts_take_the_game_from_the_title() {
        let db = db();
        let ryu = "Ryujinx 1.3.269\nTomodachi Life: Living the Dream\nv1.0.0\n(010051F0207B2000) (64-bit)";
        assert_eq!(run(&db, Some(r"C:\emu\Ryujinx.exe"), None, Some(ryu)), Some(("Tomodachi Life: Living the Dream".into(), Source::HostTitle)));
        assert_eq!(
            run(&db, Some(r"C:\Users\x\AppData\Roaming\.minecraft\runtime\java-runtime-delta\bin\javaw.exe"), None, Some("Minecraft NeoForge* 1.21.1 - Singleplayer")),
            Some(("Minecraft".into(), Source::HostTitle))
        );
        assert_eq!(run(&db, Some(r"C:\Program Files\Java\bin\java.exe"), None, Some("IntelliJ IDEA")), None);
        // no path, unknown title: Spiral Knights' javaw rule must not claim a modpack launcher
        assert_eq!(run(&db, None, Some("javaw"), Some("Raspberry Flavoured 3.0.2")), None);
    }

    #[test]
    fn a_tool_named_after_its_game_is_not_the_game() {
        let db = db();
        assert_eq!(run(&db, None, Some("Pagoda Save Editor"), Some("Pagoda - Save Editor")), None);
    }

    #[test]
    fn title_and_stem_have_to_agree() {
        let db = db();
        assert_eq!(run(&db, None, Some("forzahorizon6"), Some("Forza Horizon 6")), Some(("Forza Horizon 6".into(), Source::TitleStem)));
        assert_eq!(run(&db, None, Some("PagodaSteam-Win64-Shipping"), Some("Pagoda  ")), Some(("Pagoda".into(), Source::TitleStem)));
        assert_eq!(run(&db, None, Some("notepad"), Some("Forza Horizon 6")), None);
    }

    #[test]
    fn steam_demo_maps_to_the_full_games_entry() {
        let lib = std::env::temp_dir().join(format!("gamedb-test-{}", std::process::id()));
        let steamapps = lib.join("steamapps");
        std::fs::create_dir_all(steamapps.join("common").join("Find The Needle Demo")).unwrap();
        std::fs::write(
            steamapps.join("appmanifest_5165210.acf"),
            "\"AppState\"\n{\n\t\"appid\"\t\t\"5165210\"\n\t\"name\"\t\t\"Find The Needle Demo\"\n\t\"installdir\"\t\t\"Find The Needle Demo\"\n}",
        )
        .unwrap();
        let exe = steamapps.join("common").join("Find The Needle Demo").join("FindTheNeedle.exe");
        let g = db().resolve(Some(&exe), None, &mut || None).unwrap();
        let _ = std::fs::remove_dir_all(&lib);
        assert_eq!((g.name.as_str(), g.id.as_str(), g.source), ("Find The Needle", "13", Source::SteamListed));
        // Discord lists it, so alt-tabbing away for a while keeps the session
        assert!(g.source.is_strong());
        assert!(!Source::Steam.is_strong());
        assert!(g.icon_url.unwrap().contains("/app-icons/13/abc.png"));
    }

    #[test]
    fn title_suffixes_are_cut() {
        let db = db();
        assert_eq!(
            run(&db, None, Some("RocketLeague"), Some("Rocket League (64-bit, DX11, Cooked)")),
            Some(("Rocket League".into(), Source::ExeTitle))
        );
    }

    #[test]
    fn title_is_only_read_when_needed() {
        let db = db();
        let mut calls = 0;
        let g = db.resolve(
            Some(Path::new(r"C:\Riot Games\VALORANT\live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe")),
            None,
            &mut || {
                calls += 1;
                None
            },
        );
        assert!(g.is_some());
        assert_eq!(calls, 0);
    }

    #[test]
    fn norm_handles_marks_and_ampersands() {
        assert_eq!(norm("Battlefield™ 6 Open Beta"), "battlefield 6 open beta");
        assert_eq!(norm("R.E.P.O."), "r e p o");
        assert_eq!(norm("Jötunnslayer: Hordes of Hel"), "jötunnslayer hordes of hel");
        assert_eq!(norm("Ori & the Will"), "ori and the will");
    }
}
