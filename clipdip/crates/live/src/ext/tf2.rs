//! Map and class details, written independently from Kataiser/tf2-rich-presence
//! (GPL-3.0, format only), https://github.com/Kataiser/tf2-rich-presence:
//! TF2 Rich Presence/console_log.py, configs.py and test_resources/*.log

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const HEADER: &str = "https://cdn.cloudflare.steamstatic.com/steam/apps/440/header.jpg";
const CLASSES: &[&str] = &[
    "Scout", "Soldier", "Pyro", "Demoman", "Heavy", "Engineer", "Medic", "Sniper", "Spy",
];
const LINES: &[(&str, &str)] = &[
    ("Player count", "Player count"),
    ("Server name", "Match type"),
    ("Time on map", "Time on map"),
    ("Class", "Class"),
    ("Map", "Map"),
];
pub static MANIFEST: Manifest = Manifest {
    id: "tf2", name: "Team Fortress 2", blurb: "Map, match type, class and tracked kills.",
    setup: Some("Add -condebug to Team Fortress 2's Steam launch options, then restart the game. Class details need existing class-config echoes; kills need a saved player name."),
    credits: &[
        Credit { project: "tf2-rich-presence", author: "Kataiser", url: "https://github.com/Kataiser/tf2-rich-presence", license: "format only" },
        Credit { project: "Official Team Fortress Wiki", author: "Valve and wiki contributors", url: "https://wiki.teamfortress.com/wiki/Main_Page", license: "docs" },
    ],
    options: &[
        Opt::toggle("hide_queued_gamemode", "Hide queued mode", "Show a generic queue status.", false),
        Opt::choice("top_line", "First line", "Extra detail beside the map.", "Player count", LINES),
        Opt::choice("bottom_line", "Second line", "Server names are represented by match type for privacy.", "Server name", LINES),
        Opt::choice("image", "Picture", "Show map or class art when available.", "map", &[("map", "Map"), ("class", "Class")]),
    ],
    matches, run, priority: 10, game_ids: &["356888577310851072"], art: Some(HEADER), preview,
    scenarios: &[("menu", "Main menu"), ("queue", "In queue"), ("casual", "Casual"), ("competitive", "Competitive"), ("community", "Community"), ("post_game", "Post game")],
    steam_game: true, listed: true,
};
fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || t.game_id == "steam:440"
        || t.steam_appid.as_deref() == Some("440")
        || matches!(
            util::exe_name(t).as_str(),
            "tf.exe" | "tf_win64.exe" | "hl2.exe"
        ) && t.game_name.eq_ignore_ascii_case("Team Fortress 2")
        || matches!(util::exe_name(t).as_str(), "tf.exe" | "tf_win64.exe")
}
fn log_path(exe: &Path) -> Option<PathBuf> {
    Some(exe.parent()?.join("tf/console.log"))
}
#[derive(Clone, Copy, Debug, PartialEq, Default)]
enum Mode {
    #[default]
    Unknown,
    Casual,
    Competitive,
    Community,
    Mvm,
}
impl Mode {
    fn label(self) -> &'static str {
        match self {
            Self::Unknown => "In match",
            Self::Casual => "Casual",
            Self::Competitive => "Competitive",
            Self::Community => "Community",
            Self::Mvm => "Mann vs. Machine",
        }
    }
}
#[derive(Default)]
struct State {
    map: Option<String>,
    class: Option<String>,
    mode: Mode,
    queue: Option<Mode>,
    joining: Option<Mode>,
    matchmaking_connection: bool,
    players: Option<[u32; 2]>,
    kills: Option<u32>,
    start: Option<i64>,
    post: bool,
}
fn safe_map(raw: &str) -> Option<String> {
    let raw = raw
        .trim()
        .strip_prefix("workshop/")
        .unwrap_or(raw.trim())
        .split('.')
        .next()?;
    if raw.is_empty()
        || raw.len() > 100
        || !raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return None;
    }
    Some(raw.to_ascii_lowercase())
}
fn match_group(line: &str) -> Option<Mode> {
    if line.contains("12v12 Casual Match") {
        Some(Mode::Casual)
    } else if line.contains("6v6 Ladder Match") {
        Some(Mode::Competitive)
    } else if line.contains("MvM Practice") || line.contains("MvM MannUp") {
        Some(Mode::Mvm)
    } else {
        None
    }
}
impl State {
    fn disconnect(&mut self) {
        let queue = self.queue;
        *self = Self {
            queue,
            ..Self::default()
        };
    }
    fn parse(&mut self, line: &str, name: Option<&str>, now: Option<i64>) {
        let line = line.trim();
        if line.len() > 4096 || line.contains(" :  ") {
            return;
        }
        if line.starts_with("[PartyClient] Entering queue") {
            self.queue = match_group(line);
        }
        if line.starts_with("[PartyClient] Leaving queue") {
            self.joining = self.queue;
            self.queue = None;
        }
        if line.starts_with("Connecting to matchmaking server") {
            self.joining = self.joining.or(self.queue);
            self.mode = self.joining.unwrap_or(Mode::Unknown);
            self.matchmaking_connection = true;
        }
        if line.starts_with("Connected to ") && !self.matchmaking_connection {
            self.mode = Mode::Community;
            self.joining = None;
        }
        if let Some(map) = line.strip_prefix("Map:").and_then(safe_map) {
            if self.map.as_ref() != Some(&map) {
                self.class = None;
                self.players = None;
                self.kills = None;
                self.start = now;
            }
            self.joining = None;
            if map.starts_with("mvm_") {
                self.mode = Mode::Mvm;
            }
            self.map = Some(map);
            self.post = false;
        }
        if self.map.is_some() {
            if let Some(class) = line
                .strip_suffix(" selected")
                .filter(|c| CLASSES.contains(c))
            {
                self.class = Some(class.to_owned());
            }
            if let Some(rest) = line.strip_prefix("Players: ") {
                let parts: Vec<_> = rest.split_whitespace().take(3).collect();
                if let (Some(a), Some(b)) = (
                    parts.first().and_then(|v| v.parse::<u32>().ok()),
                    parts.get(2).and_then(|v| v.parse::<u32>().ok()),
                ) {
                    if b > 0 && b <= 256 && a <= b {
                        self.players = Some([a, b]);
                    }
                }
            }
            if let Some(rest) = line.strip_prefix("players : ") {
                let mut parts = rest.split_whitespace();
                let humans = parts.next().and_then(|s| s.parse::<u32>().ok());
                parts.next();
                let bots = parts.next().and_then(|s| s.parse::<u32>().ok());
                parts.next();
                let max = parts
                    .next()
                    .and_then(|s| s.strip_prefix('('))
                    .and_then(|s| s.parse::<u32>().ok());
                if let (Some(h), Some(b), Some(max)) = (humans, bots, max) {
                    let current = if self.mode == Mode::Mvm {
                        h
                    } else {
                        h.saturating_add(b)
                    };
                    if max > 0 && max <= 256 && current <= max {
                        self.players = Some([current, max]);
                    }
                }
            }
            if line.starts_with("hostname: Valve Matchmaking Server") && self.mode == Mode::Unknown
            {
                self.mode = Mode::Casual;
            }
            if let Some(name) = name.filter(|s| !s.is_empty()) {
                if let Some((killer, rest)) = line.split_once(" killed ") {
                    if killer == name
                        && rest.contains(" with ")
                        && !rest.starts_with(&format!("{name} with "))
                    {
                        self.kills = Some(self.kills.unwrap_or(0).saturating_add(1));
                    }
                }
            }
        }
        if line.starts_with("Disconnect:")
            || line.starts_with("Server shutting down")
            || line.starts_with("Host_Error")
            || line.starts_with("Connection failed after")
            || line.contains("ShutdownGC")
            || line.contains("destroyed CAsyncWavDataCache")
        {
            self.disconnect();
        }
        // lobby teardown can also happen while joining; only mark results after a map was observed
        if line.contains("Lobby destroyed") || line.contains("destroyed Lobby") {
            let post = self.map.is_some();
            self.disconnect();
            self.post = post;
        }
    }
}
#[derive(Deserialize)]
struct Art {
    name: String,
    url: String,
}
type Arts = BTreeMap<String, Art>;
fn arts() -> Arts {
    serde_json::from_str(include_str!("tf2/art.json")).unwrap_or_default()
}
fn line_value(s: &State, choice: &str, map: &str) -> Option<String> {
    match choice {
        "Player count" => s.players.map(|[a, b]| format!("{a}/{b} players")),
        "Server name" => Some(s.mode.label().to_owned()),
        "Class" => s.class.clone(),
        "Map" => Some(map.to_owned()),
        _ => None,
    }
}
fn build(s: &State, settings: &Settings, art: &Arts) -> Live {
    let Some(map) = &s.map else {
        let text = if s.queue.is_some() {
            if settings.flag("hide_queued_gamemode") {
                "In queue".to_owned()
            } else {
                format!("In queue, {}", s.queue.unwrap_or_default().label())
            }
        } else if s.post {
            "Post game".to_owned()
        } else {
            "Main menu".to_owned()
        };
        return Live {
            details: util::clamp(text),
            large_image: Some(HEADER.to_owned()),
            ..Live::default()
        };
    };
    let map_art = art.get(map);
    let map_label = map_art.map(|a| a.name.as_str()).unwrap_or(map);
    let class_art = s.class.as_ref().and_then(|c| art.get(c));
    let image = if settings.choice("image") == "class" {
        class_art.or(map_art)
    } else {
        map_art.or(class_art)
    };
    let top = line_value(s, &settings.choice("top_line"), map_label).filter(|v| v != map_label);
    let mut bottom = Vec::new();
    if let Some(v) = line_value(s, &settings.choice("bottom_line"), map_label) {
        bottom.push(v);
    }
    if let Some(class) = &s.class {
        if !bottom.contains(class) {
            bottom.push(class.clone());
        }
    }
    if let Some(kills) = s.kills {
        bottom.push(format!("{kills} tracked kills"));
    }
    if let Some(queue) = s.queue {
        bottom.push(if settings.flag("hide_queued_gamemode") {
            "In queue".to_owned()
        } else {
            format!("Queued for {}", queue.label())
        });
    }
    Live {
        details: util::clamp(
            top.map(|v| format!("{map_label}, {v}"))
                .unwrap_or_else(|| map_label.to_owned()),
        ),
        state: util::clamp(bottom.join(", ")),
        large_image: Some(
            image
                .map(|a| a.url.clone())
                .unwrap_or_else(|| HEADER.to_owned()),
        ),
        large_text: util::clamp(format!("{}, {map_label}", s.mode.label())),
        start_ms: if settings.choice("top_line") == "Time on map"
            || settings.choice("bottom_line") == "Time on map"
        {
            s.start
        } else {
            None
        },
        competing: s.mode == Mode::Competitive,
        ..Live::default()
    }
}
fn preview(settings: &Settings, scenario: &str) -> Preview {
    let mut s = State::default();
    match scenario {
        "queue" => s.queue = Some(Mode::Casual),
        "casual" | "competitive" | "community" => {
            s.map = Some("pl_badwater".to_owned());
            s.class = Some("Soldier".to_owned());
            s.players = Some([20, 24]);
            s.kills = Some(7);
            s.start = Some(1_700_000_000_000);
            s.mode = match scenario {
                "competitive" => Mode::Competitive,
                "community" => Mode::Community,
                _ => Mode::Casual,
            };
        }
        "post_game" => s.post = true,
        _ => (),
    }
    Preview {
        game: "Team Fortress 2",
        icon: None,
        live: build(&s, settings, &arts()),
    }
}
fn player_name(path: &Path) -> Option<String> {
    let path = path.parent()?.join("cfg/config.cfg");
    if std::fs::metadata(&path).ok()?.len() > 1024 * 1024 {
        return None;
    }
    let cfg = std::fs::read_to_string(path).ok()?;
    cfg.lines()
        .filter_map(|line| {
            let args = util::process::split_args(line);
            (args.first().is_some_and(|s| s == "name"))
                .then(|| args.get(1).cloned())
                .flatten()
        })
        .next_back()
        .filter(|s| !s.is_empty() && s.len() <= 128 && !s.contains(" :  "))
}
fn run(ctx: &Ctx) {
    let Some(path) = ctx.target().exe.as_deref().and_then(log_path) else {
        return;
    };
    let name = player_name(&path);
    let art = arts();
    let mut tail = util::tail::Tail::new(&path, 256 * 1024);
    let mut s = State::default();
    let mut first = true;
    let mut previous: Option<(u64, Option<SystemTime>)> = None;
    loop {
        let meta = std::fs::metadata(&path).ok();
        let valid = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .is_some_and(|t| t.as_millis() as i64 >= ctx.target().started_at_ms);
        if valid {
            if let Some(m) = meta {
                let current = (m.len(), m.created().ok());
                if previous.is_some_and(|p| current.0 < p.0 || current.1 != p.1) {
                    s = State::default();
                }
                previous = Some(current);
            }
            tail.poll(|line| s.parse(line, name.as_deref(), (!first).then(util::now_ms)));
            first = false;
            ctx.emit(Some(build(&s, ctx.settings(), &art)));
        } else {
            s = State::default();
            tail.poll(|_| {});
            ctx.emit(None);
        }
        if !ctx.sleep(Duration::from_secs(if valid { 5 } else { 15 })) {
            return;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn settings(v: serde_json::Value) -> Settings {
        Settings::new(&MANIFEST, v)
    }
    #[test]
    fn previews_and_options() {
        let a = settings(serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&a, key).live.is_empty());
        }
        assert_eq!(preview(&a, "oops").live, preview(&a, "menu").live);
        assert_ne!(
            preview(&a, "queue").live,
            preview(
                &settings(serde_json::json!({"hide_queued_gamemode":true})),
                "queue"
            )
            .live
        );
        assert_ne!(
            preview(&a, "casual").live.large_image,
            preview(&settings(serde_json::json!({"image":"class"})), "casual")
                .live
                .large_image
        );
        assert_ne!(
            preview(&a, "casual").live,
            preview(
                &settings(serde_json::json!({"top_line":"Time on map","bottom_line":"Class"})),
                "casual"
            )
            .live
        );
        assert!(preview(&a, "competitive").live.competing);
        assert!(!preview(&a, "queue").live.competing);
    }
    #[test]
    fn matchmaking_class_kills_disconnect() {
        let mut s = State::default();
        for line in [
            "[PartyClient] Entering queue for match group 6v6 Ladder Match",
            "[PartyClient] Leaving queue",
            "Connecting to matchmaking server",
            "Map: cp_process_final",
            "Soldier selected ",
            "players : 12 humans, 0 bots (12 max)",
            "Local Player killed Opponent with rocketlauncher.",
            "Other killed Opponent with rocketlauncher.",
        ] {
            s.parse(line, Some("Local Player"), Some(1000));
        }
        assert_eq!(s.mode, Mode::Competitive);
        assert_eq!(s.players, Some([12, 12]));
        assert_eq!(s.class.as_deref(), Some("Soldier"));
        assert_eq!(s.kills, Some(1));
        let live = build(&s, &settings(serde_json::json!({})), &arts());
        assert!(live.competing);
        s.parse("Disconnect: Disconnect by user.", None, None);
        assert!(s.map.is_none());
        assert!(s.class.is_none());
        assert!(s.kills.is_none());
    }
    #[test]
    fn privacy_and_malformed_lines() {
        let mut s = State::default();
        for line in [
            "Map: pl_badwater",
            "Players: 20 / 24",
            "Soldier selected",
            "hostname: 192.0.2.1",
            "User :  Map: secret",
            "User :  Disconnect:",
            "players : junk",
            "Spy selected extra",
        ] {
            s.parse(line, Some("Local"), None);
        }
        let live = build(&s, &settings(serde_json::json!({})), &arts());
        let text = serde_json::to_string(&live).unwrap();
        assert!(!text.contains("192.0.2.1"));
        assert!(!text.contains("User"));
        assert!(!text.contains("secret"));
        assert_eq!(s.start, None);
        assert_eq!(
            safe_map("workshop/pl_badwater.123"),
            Some("pl_badwater".to_owned())
        );
        assert!(safe_map("../../secret").is_none());
        assert_eq!(
            log_path(Path::new(r"C:\Steam\Team Fortress 2\tf_win64.exe")),
            Some(PathBuf::from(r"C:\Steam\Team Fortress 2").join("tf/console.log"))
        );
    }
    #[test]
    fn cancelled_ranked_queue_does_not_mark_community_competing() {
        let mut s = State::default();
        for line in [
            "[PartyClient] Entering queue for match group 6v6 Ladder Match",
            "[PartyClient] Leaving queue",
            "Connected to 192.0.2.1",
            "Map: pl_badwater",
        ] {
            s.parse(line, None, None);
        }
        assert_eq!(s.mode, Mode::Community);
        assert!(!build(&s, &settings(serde_json::json!({})), &arts()).competing);
        s.parse("Local killed Opponent with rocketlauncher.", None, None);
        assert_eq!(s.kills, None);
        s.parse("Local killed Local with world.", Some("Local"), None);
        assert_eq!(s.kills, None);
    }
    #[test]
    fn map_changes_and_art_fallback() {
        let mut s = State::default();
        s.parse("Connected to 192.0.2.1", None, None);
        s.parse("Map: pl_badwater", None, None);
        s.parse("Heavy selected", None, None);
        assert_eq!(s.mode, Mode::Community);
        s.parse("Map: custom_unknown", None, Some(3000));
        assert_eq!(s.class, None);
        assert_eq!(s.start, Some(3000));
        let a = arts();
        assert_eq!(a.len(), 54);
        for c in CLASSES {
            assert!(a.contains_key(*c));
        }
        assert_eq!(
            build(&s, &settings(serde_json::json!({})), &a)
                .large_image
                .as_deref(),
            Some(HEADER)
        );
        s.parse("Map: mvm_rottenburg", None, None);
        assert_eq!(s.mode, Mode::Mvm);
        s.parse("players : 6 humans, 22 bots (32 max)", None, None);
        assert_eq!(s.players, Some([6, 32]));
    }
}
