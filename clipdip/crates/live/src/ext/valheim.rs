//! Biome and session type for Valheim from the game's own Player.log. Built from the log lines
//! the game writes (`Joining server`, `Load world`, `Starting music <biome>`), no reference
//! project. The biome comes from the music the game starts, so it changes when the music does.

use std::path::PathBuf;
use std::time::Duration;

use crate::util::tail::Tail;
use crate::util::{art, clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "valheim",
    name: "Valheim",
    blurb: "Shows the last biome reported by music, and your session type.",
    setup: None,
    credits: &[Credit {
        project: "Valheim Player.log",
        author: "Iron Gate",
        url: "https://store.steampowered.com/app/892970",
        license: "docs",
    }],
    options: &[Opt::toggle(
        "show_server",
        "Show session type",
        "Whether you joined a server or opened your own world.",
        true,
    )],
    matches,
    run,
    priority: 10,
    game_ids: &["1124358970618953818"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/892970/library_hero.jpg"),
    preview,
    scenarios: &[
        ("menu", "Main menu"),
        ("loading", "Loading"),
        ("world", "Own world"),
        ("server", "On a server"),
        ("boss", "Boss fight"),
    ],
    steam_game: true,
    listed: true,
};

const PACK: &str = "valheim";
const APPID: &str = "892970";
const HISTORY: u64 = 1 << 20;

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str()) || exe_name(t) == "valheim.exe"
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Phase {
    #[default]
    Menu,
    Loading,
    World,
}

#[derive(Clone, Debug, Default, PartialEq)]
enum Place {
    #[default]
    Unknown,
    /// joined someone's server
    Server { dedicated: bool },
    /// your own world, hosted or alone
    World,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct State {
    known: bool,
    phase: Phase,
    place: Place,
    /// a pack key
    biome: Option<&'static str>,
    boss: bool,
}

/// "09/30/2026 16:16:08: text" -> "text"; lines from multi line blocks have no stamp
fn strip_stamp(line: &str) -> &str {
    let b = line.as_bytes();
    if b.get(2) == Some(&b'/') && b.get(5) == Some(&b'/') && line.get(19..21) == Some(": ") {
        return line.get(21..).unwrap_or(line);
    }
    line
}

/// Music names to biomes. `menu`, `home`, `morning`, `evening` and `combat` say nothing about where
/// you are, so they keep the last biome.
fn biome(music: &str) -> Option<&'static str> {
    let n = art::norm(music);
    Some(match n.as_str() {
        "meadows" => "meadows",
        "blackforest" | "forest" => "black-forest",
        "swamp" => "swamp",
        "mountain" | "mountains" => "mountain",
        "plains" => "plains",
        "mistlands" => "mistlands",
        "ashlands" => "ashlands",
        "deepnorth" => "deep-north",
        "ocean" | "sailing" => "ocean",
        _ => return None,
    })
}

fn label(key: &str) -> &'static str {
    match key {
        "meadows" => "Meadows",
        "black-forest" => "Black Forest",
        "swamp" => "Swamp",
        "mountain" => "Mountain",
        "plains" => "Plains",
        "mistlands" => "Mistlands",
        "ashlands" => "Ashlands",
        "deep-north" => "Deep North",
        _ => "Ocean",
    }
}

impl State {
    fn feed(&mut self, line: &str) {
        let line = strip_stamp(line.trim());
        if line.starts_with("Joining server '") {
            let dedicated = matches!(&self.place, Place::Server { dedicated: true });
            self.place = Place::Server { dedicated };
        } else if line.starts_with("Server Name : ") {
            self.place = Place::Server { dedicated: false };
        } else if let Some(d) = line.strip_prefix("Dedicated : ") {
            if let Place::Server { dedicated } = &mut self.place {
                *dedicated = d.trim().eq_ignore_ascii_case("true");
            }
        } else if line.starts_with("Load world: ") {
            if !matches!(self.place, Place::Server { .. }) || self.phase != Phase::Loading {
                self.place = Place::World;
            }
        } else if line.starts_with("Loading main scene") {
            self.known = true;
            self.phase = Phase::Loading;
            self.biome = None;
            self.boss = false;
        } else if line.starts_with("Spawned after ") {
            self.known = true;
            self.phase = Phase::World;
        } else if let Some(m) = line.strip_prefix("Starting music ") {
            let m = m.trim();
            if m == "menu" {
                self.known = true;
                self.phase = Phase::Menu;
                self.place = Place::Unknown;
                self.biome = None;
                self.boss = false;
            } else if let Some(b) = biome(m) {
                self.known = true;
                self.phase = Phase::World;
                self.biome = Some(b);
                self.boss = false;
            } else {
                self.boss = m.starts_with("boss");
            }
        } else if line.starts_with("Net scene destroyed") {
            self.known = true;
            self.phase = Phase::Menu;
            self.place = Place::Unknown;
            self.biome = None;
            self.boss = false;
        }
    }
}

fn build(s: &State, settings: &Settings) -> Option<Live> {
    if !s.known {
        return None;
    }
    let mut live = Live::default();
    if s.phase == Phase::Menu {
        live.details = clamp("Main menu");
        live.large_image = Some(art::url(PACK, "menu"));
        return Some(live);
    }
    if settings.flag("show_server") {
        live.state = clamp(match &s.place {
            Place::Server { dedicated: true } => "On a dedicated server",
            Place::Server { .. } => "In multiplayer",
            Place::World => "In your own world",
            Place::Unknown => "",
        });
    }
    if s.phase == Phase::Loading {
        live.details = clamp("Loading in");
        live.large_image = Some(art::steam_header(APPID));
        return Some(live);
    }
    match s.biome {
        Some(key) => {
            live.details = clamp(if s.boss {
                format!("Boss fight, {}", label(key))
            } else {
                label(key).to_string()
            });
            live.large_image = Some(art::url(PACK, key));
            live.large_text = clamp(label(key));
        }
        None => {
            live.details = clamp(if s.boss { "Boss fight" } else { "Exploring" });
            live.large_image = Some(art::steam_header(APPID));
        }
    }
    Some(live)
}

fn preview(settings: &Settings, scenario: &str) -> Preview {
    let join = [
        "09/30/2026 16:16:33: Loading main scene",
        "Server Name : Midgard",
        "Dedicated : False",
        "09/30/2026 16:16:38: Joining server 'Midgard' at PlayFab network 1",
        "09/30/2026 16:17:05: Spawned after 8.019993",
        "09/30/2026 16:17:08: Starting music meadows",
        "09/30/2026 16:22:50: Starting music home",
    ];
    let lines: Vec<&str> = match scenario {
        "loading" => vec!["09/30/2026 16:16:33: Loading main scene"],
        "world" => vec![
            "09/30/2026 16:16:33: Loading main scene",
            "09/30/2026 16:16:34: Load world: Asgard",
            "09/30/2026 16:17:05: Spawned after 8.0",
            "09/30/2026 16:18:00: Starting music blackforest",
        ],
        "boss" => [
            &join[..],
            &["09/30/2026 16:30:00: Starting music boss_eikthyr"],
        ]
        .concat(),
        "server" => join.to_vec(),
        _ => vec!["09/30/2026 16:16:18: Starting music menu"],
    };
    let mut s = State::default();
    lines.iter().for_each(|l| s.feed(l));
    Preview {
        game: "Valheim",
        icon: None,
        live: build(&s, settings).unwrap_or_default(),
    }
}

fn player_log() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local)
            .parent()?
            .join("LocalLow")
            .join("IronGate")
            .join("Valheim")
            .join("Player.log"),
    )
}

fn modified_ms(p: &std::path::Path) -> Option<i64> {
    let t = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn run(ctx: &Ctx) {
    let Some(path) = player_log() else { return };
    // the last launch's log stays until the game rewrites it on start, Tail notices that
    let fresh = modified_ms(&path).is_some_and(|m| m + 60_000 >= ctx.target().started_at_ms);
    let mut tail = Tail::new(path, if fresh { HISTORY } else { 0 });
    let mut state = State::default();
    let mut identity: Option<(Option<std::time::SystemTime>, u64)> = None;
    loop {
        if let Ok(meta) = std::fs::metadata(tail.path()) {
            let next = (meta.created().ok(), meta.len());
            if identity.is_some_and(|old| old.0 != next.0 || old.1 > next.1) {
                state = State::default();
            }
            identity = Some(next);
        } else {
            state = State::default();
        }
        tail.poll(|l| state.feed(l));
        ctx.emit(build(&state, ctx.settings()));
        if !ctx.sleep(Duration::from_secs(4)) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // from a real Player.log (mod and placement noise left out), the server renamed
    const LOG: &str = "09/30/2026 16:49:44: Loading: Starting to load scene: start.unity (169d0000c03be07e9ad3af5893)
09/30/2026 16:49:58: Starting music menu
09/30/2026 16:50:49: ZSteamMatchmaking got join request friend:76500000000000001  lobby:100000000000000001
09/30/2026 16:50:54: Loading main scene
09/30/2026 16:50:54: Connecting to server with PlayFab-backend 0000000000000000
09/30/2026 16:50:58: Get Lobby
Server Name : Midgard
Players : 2
Max players : 10
Dedicated : False
Community : False
09/30/2026 16:50:58: Joining server 'Midgard' at PlayFab network 00000000-0000-0000-0000-000000000000|AAAA from lobby 1
09/30/2026 16:51:19: Starting respawn
09/30/2026 16:51:27: Spawned after 8.019993
09/30/2026 16:51:29: Starting music meadows
09/30/2026 16:51:29: Resumed music meadows at 0
09/30/2026 16:55:52: Starting music home
09/30/2026 17:01:37: Starting music evening";

    fn settings(v: serde_json::Value) -> Settings {
        Settings::new(&MANIFEST, v)
    }

    #[test]
    fn joined_server() {
        let mut s = State::default();
        LOG.lines().for_each(|l| s.feed(l));
        assert_eq!(s.phase, Phase::World);
        assert_eq!(s.place, Place::Server { dedicated: false });
        // home and evening keep the biome
        assert_eq!(s.biome, Some("meadows"));
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.details.as_deref(), Some("Meadows"));
        assert_eq!(live.state.as_deref(), Some("In multiplayer"));
        assert_eq!(live.large_image, Some(art::url("valheim", "meadows")));
        let hidden = build(&s, &settings(serde_json::json!({ "show_server": false }))).unwrap();
        assert_eq!(hidden.state, None);

        s.feed("09/30/2026 17:21:50: Lost connection to server:ErrorDisconnected");
        s.feed("09/30/2026 17:21:51: Net scene destroyed");
        assert_eq!(
            build(&s, &settings(serde_json::json!({})))
                .unwrap()
                .details
                .as_deref(),
            Some("Main menu")
        );
    }

    #[test]
    fn own_world_and_dedicated() {
        let mut s = State::default();
        for l in [
            "09/30/2026 10:00:00: Loading main scene",
            "09/30/2026 10:00:01: Load world: Asgard",
        ] {
            s.feed(l);
        }
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.details.as_deref(), Some("Loading in"));
        assert_eq!(live.state.as_deref(), Some("In your own world"));
        s.feed("09/30/2026 10:00:09: Spawned after 8.0");
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.details.as_deref(), Some("Exploring"));
        assert_eq!(live.large_image, Some(art::steam_header("892970")));
        assert_eq!(
            build(&s, &settings(serde_json::json!({ "show_server": false })))
                .unwrap()
                .state,
            None
        );

        let mut d = State::default();
        for l in [
            "Server Name : Public",
            "Dedicated : True",
            "09/30/2026 10:00:01: Joining server 'Public' at 1.2.3.4:2456",
        ] {
            d.feed(l);
        }
        assert_eq!(d.place, Place::Server { dedicated: true });
        d.feed("09/30/2026 10:00:09: Spawned after 8.0");
        assert_eq!(
            build(&d, &settings(serde_json::json!({ "show_server": false })))
                .unwrap()
                .state
                .as_deref(),
            None
        );
    }

    #[test]
    fn stamps_and_music() {
        assert_eq!(
            strip_stamp("09/30/2026 16:16:08: Starting music meadows"),
            "Starting music meadows"
        );
        assert_eq!(strip_stamp("Players : 2"), "Players : 2");
        assert_eq!(biome("blackforest"), Some("black-forest"));
        assert_eq!(biome("home"), None);
        let mut s = State::default();
        let settings = settings(serde_json::json!({}));
        s.feed("noise");
        assert_eq!(build(&s, &settings), None);
        s.feed("09/30/2026 16:16:08: Starting music meadows");
        assert_eq!(
            build(&s, &settings).unwrap().details.as_deref(),
            Some("Meadows")
        );
        s.feed("09/30/2026 16:16:09: Joining server 'Private name' at 192.0.2.1:2456");
        let card = serde_json::to_string(&build(&s, &settings)).unwrap();
        assert!(!card.contains("Private name"));
        assert!(!card.contains("192.0.2.1"));
        assert!(matches(&Target {
            game_id: MANIFEST.game_ids[0].into(),
            ..Target::default()
        }));
        assert!(matches(&Target {
            exe: Some("valheim.exe".into()),
            ..Target::default()
        }));
        assert!(!matches(&Target::default()));
    }

    #[test]
    fn previews() {
        let s = settings(serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(preview(&s, key).live.details.is_some(), "{key}");
        }
        assert_eq!(
            preview(&s, "nope").live,
            preview(&s, MANIFEST.scenarios[0].0).live
        );
        assert_eq!(
            preview(&s, "boss").live.details.as_deref(),
            Some("Boss fight, Meadows")
        );
        assert_eq!(
            preview(&s, "world").live.details.as_deref(),
            Some("Black Forest")
        );
        let off = settings(serde_json::json!({ "show_server": false }));
        assert_ne!(
            preview(&off, "server").live.state,
            preview(&s, "server").live.state
        );
    }
}
