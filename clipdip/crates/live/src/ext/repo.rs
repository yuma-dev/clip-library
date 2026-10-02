//! Level, lobby and lobby size for R.E.P.O. from the game's own Player.log. Built from the log
//! lines the game writes (`Changed level to`, `Steam: Hosting lobby...`, `Player entered room`),
//! no reference project.

use std::path::PathBuf;
use std::time::Duration;

use crate::util::tail::Tail;
use crate::util::{art, clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "repo",
    name: "R.E.P.O.",
    blurb: "Shows the level you're on, with its picture, and whether you host or joined.",
    setup: None,
    credits: &[Credit {
        project: "R.E.P.O. Player.log",
        author: "semiwork",
        url: "https://store.steampowered.com/app/3241660",
        license: "docs",
    }],
    options: &[Opt::toggle(
        "show_party",
        "Show lobby size",
        "How many players are in your lobby while you host.",
        true,
    )],
    matches,
    run,
    priority: 10,
    game_ids: &["1344368447928401961"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/3241660/library_hero.jpg"),
    preview,
    scenarios: &[
        ("level", "In a level"),
        ("lobby", "Lobby"),
        ("truck", "Truck"),
        ("shop", "Service Station"),
        ("joined", "Joined a friend"),
        ("solo", "Singleplayer"),
        ("menu", "Main menu"),
    ],
    steam_game: true,
    listed: true,
};

const PACK: &str = "repo";
// the game's own lobby cap, mods raise it
const MAX_PLAYERS: u32 = 6;
// a session's levels sit in the last few hundred KB, a long one is around 30 KB per level
const HISTORY: u64 = 2 << 20;

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str()) || exe_name(t) == "repo.exe"
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Lobby {
    #[default]
    None,
    Hosting,
    Joined,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct State {
    /// what follows "Level - " in the log
    level: Option<String>,
    lobby: Lobby,
    /// you included, only known while hosting
    players: u32,
}

impl State {
    fn feed(&mut self, line: &str) {
        let line = line.trim();
        // the host logs "Changed level to", everyone else "updated level to"
        if let Some(l) = line
            .strip_prefix("Changed level to: ")
            .or_else(|| line.strip_prefix("updated level to: "))
        {
            self.level = Some(l.trim().trim_start_matches("Level - ").trim().to_string());
        } else if line.starts_with("Steam: Hosting lobby") {
            self.lobby = Lobby::Hosting;
            self.players = 1;
        } else if line.starts_with("Steam: Game lobby join requested")
            || line.starts_with("Steam: Joining lobby")
        {
            self.lobby = Lobby::Joined;
            self.players = 0;
        } else if line.starts_with("Player entered room: ") {
            if self.lobby == Lobby::Hosting {
                self.players = (self.players + 1).min(64);
            }
        } else if line.starts_with("Player left room: ") {
            if self.lobby == Lobby::Hosting {
                self.players = self.players.saturating_sub(1).max(1);
            }
        } else if line.starts_with("Leave to Main Menu") || line.starts_with("Steam: Leaving lobby")
        {
            self.lobby = Lobby::None;
            self.players = 0;
        }
    }
}

/// (log name, pack key, label); shops and arenas come in several themes
fn place(level: &str) -> Option<(&'static str, &'static str)> {
    let n = art::norm(level);
    let found = match n.as_str() {
        "manor" => ("manor", "Headman Manor"),
        "wizard" => ("wizard", "Swiftbroom Academy"),
        "arctic" => ("arctic", "McJannek Station"),
        "museum" => ("museum", "Museum of Human Art"),
        "lobbymenu" => ("lobby", "Lobby"),
        "lobby" => ("lobby", "Truck"),
        _ if n.starts_with("shop") => ("shop", "Service Station"),
        _ if n.starts_with("arena") => ("arena", "Disposal Arena"),
        _ => return None,
    };
    Some(found)
}

fn build(s: &State, settings: &Settings) -> Option<Live> {
    let level = s.level.as_deref()?;
    let n = art::norm(level);
    // splash and the menu's backdrop recording carry nothing worth a line
    if n == "splashscreen" || n == "recording" {
        return None;
    }
    if n == "mainmenu" {
        return Some(Live {
            details: clamp("Main menu"),
            ..Live::default()
        });
    }
    let mut live = Live::default();
    match place(level) {
        Some((key, label)) => {
            live.details = clamp(match key {
                "lobby" if label == "Lobby" => "In the lobby".to_string(),
                "lobby" => "In the truck".to_string(),
                "shop" => "At the Service Station".to_string(),
                "arena" => "In the Disposal Arena".to_string(),
                _ => label.to_string(),
            });
            live.large_image = Some(art::url(PACK, key));
            live.large_text = clamp(label);
        }
        None if n == "tutorial" => live.details = clamp("Tutorial"),
        // a level newer than this table: its log name is still readable
        None => live.details = clamp(level),
    }
    live.state = clamp(match s.lobby {
        Lobby::Hosting => "Hosting",
        Lobby::Joined => "In a friend's lobby",
        Lobby::None => "Singleplayer",
    });
    if s.lobby == Lobby::Hosting && s.players > 0 && settings.flag("show_party") {
        live.party = Some([s.players, MAX_PLAYERS.max(s.players)]);
    }
    Some(live)
}

fn preview(settings: &Settings, scenario: &str) -> Preview {
    let host = [
        "Steam: Hosting lobby...",
        "Changed level to: Level - Lobby Menu",
        "Player entered room: A",
        "Player entered room: B",
    ];
    let lines: Vec<&str> = match scenario {
        "lobby" => host.to_vec(),
        "truck" => [&host[..], &["Changed level to: Level - Lobby"]].concat(),
        "shop" => [&host[..], &["Changed level to: Level - Shop Forest"]].concat(),
        "joined" => vec![
            "Steam: Game lobby join requested: 1",
            "Changed level to: Level - Lobby Menu",
            "updated level to: Level - Museum",
        ],
        "solo" => vec!["Changed level to: Level - Arctic"],
        "menu" => vec!["Leave to Main Menu", "Changed level to: Level - Main Menu"],
        _ => [&host[..], &["Changed level to: Level - Manor"]].concat(),
    };
    let mut s = State::default();
    lines.iter().for_each(|l| s.feed(l));
    Preview {
        game: "R.E.P.O.",
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
            .join("semiwork")
            .join("Repo")
            .join("Player.log"),
    )
}

fn modified_ms(p: &std::path::Path) -> Option<i64> {
    let t = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn run(ctx: &Ctx) {
    let Some(path) = player_log() else { return };
    // the last launch's log stays until the game rewrites it on start, Tail notices that and
    // reads the new one from the top
    let fresh = modified_ms(&path).is_some_and(|m| m + 60_000 >= ctx.target().started_at_ms);
    let mut tail = Tail::new(path, if fresh { HISTORY } else { 0 });
    let mut state = State::default();
    loop {
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

    // from a real Player.log, names and ids replaced
    const HOST_LOG: &str = "VERSION: v0.4.2.1
Steam: Leaving lobby...
Leave to Main Menu
Changed level to: Level - Lobby Menu
Steam: Hosting lobby...
Steam: Lobby created with ID: 100000000000000001
Steam: Lobby entered with ID: 100000000000000001
I am the owner.
Game Mode: Multiplayer
Steam: Unlocking lobby...
Steam: Lobby member joined: Friend
Player entered room: Friend
Steam: Locking lobby...
Changed level to: Level - Manor
Changed level to: Level - Shop Forest
Changed level to: Level - Lobby
Changed level to: Level - Wizard";

    const JOIN_LOG: &str = "Steam: Game lobby join requested: 100000000000000002
Steam: Lobby entered with ID: 100000000000000002
Steam: Region: eu
Changed level to: Level - Lobby Menu
I am not the owner.
Joined room: 100000000000000002 eu
Game Mode: Multiplayer
updated level to: Level - Museum";

    fn settings(v: serde_json::Value) -> Settings {
        Settings::new(&MANIFEST, v)
    }

    fn feed(log: &str) -> State {
        let mut s = State::default();
        log.lines().for_each(|l| s.feed(l));
        s
    }

    #[test]
    fn host_session() {
        let s = feed(HOST_LOG);
        assert_eq!(s.level.as_deref(), Some("Wizard"));
        assert_eq!(s.lobby, Lobby::Hosting);
        assert_eq!(s.players, 2);
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.details.as_deref(), Some("Swiftbroom Academy"));
        assert_eq!(live.state.as_deref(), Some("Hosting"));
        assert_eq!(live.party, Some([2, 6]));
        assert_eq!(live.large_image, Some(art::url("repo", "wizard")));

        let mut s = s;
        s.feed("Player left room: Friend");
        s.feed("Changed level to: Level - Shop Suburb");
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.party, Some([1, 6]));
        assert_eq!(live.details.as_deref(), Some("At the Service Station"));
        assert_eq!(live.large_image, Some(art::url("repo", "shop")));
    }

    #[test]
    fn joined_session_has_no_count() {
        let s = feed(JOIN_LOG);
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.details.as_deref(), Some("Museum of Human Art"));
        assert_eq!(live.state.as_deref(), Some("In a friend's lobby"));
        assert_eq!(live.party, None);
    }

    #[test]
    fn menus_and_unknown_levels() {
        let mut s = State::default();
        assert_eq!(build(&s, &settings(serde_json::json!({}))), None);
        s.feed("Changed level to: Level - Splash Screen");
        assert_eq!(build(&s, &settings(serde_json::json!({}))), None);
        s.feed("Changed level to: Level - Main Menu");
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.details.as_deref(), Some("Main menu"));
        assert_eq!(live.state, None);
        s.feed("Changed level to: Level - Arena Race");
        assert_eq!(
            build(&s, &settings(serde_json::json!({})))
                .unwrap()
                .large_image,
            Some(art::url("repo", "arena"))
        );
        s.feed("Changed level to: Level - Bunker");
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.details.as_deref(), Some("Bunker"));
        assert_eq!(live.large_image, None);
        assert_eq!(live.state.as_deref(), Some("Singleplayer"));
    }

    #[test]
    fn matches_id_and_exe() {
        assert!(matches(&Target {
            game_id: "1344368447928401961".into(),
            ..Target::default()
        }));
        assert!(matches(&Target {
            game_id: "steam:1".into(),
            exe: Some(r"F:\Steam\REPO\REPO.exe".into()),
            ..Target::default()
        }));
        assert!(!matches(&Target {
            game_id: "1428188279433597048".into(),
            ..Target::default()
        }));
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
        assert_eq!(preview(&s, "lobby").live.party, Some([3, 6]));
        let off = settings(serde_json::json!({ "show_party": false }));
        assert_eq!(preview(&off, "lobby").live.party, None);
        assert_eq!(
            preview(&s, "truck").live.details.as_deref(),
            Some("In the truck")
        );
        assert_eq!(
            preview(&s, "solo").live.state.as_deref(),
            Some("Singleplayer")
        );
    }
}
