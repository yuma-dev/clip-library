//! Abiotic Factor map and session details from installed logs, with Epic Games' Unreal
//! logging documentation (docs), https://dev.epicgames.com/documentation/en-us/unreal-engine/logging-in-unreal-engine

use super::unreal::{self, Game, Session};
use crate::util;
use crate::{Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "abiotic_factor",
    name: "Abiotic Factor",
    blurb: "Map, hosting or joined, and known player count.",
    setup: None,
    credits: &[unreal::CREDIT],
    options: &[
        Opt::toggle("show_map", "Show map", "Map name and picture.", true),
        Opt::toggle(
            "show_session",
            "Show hosting or joined",
            "How you joined this game.",
            true,
        ),
        Opt::toggle(
            "show_players",
            "Show player count",
            "Only when the log reports it.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[GAME_ID],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/427410/library_hero.jpg"),
    preview,
    scenarios: SCENARIOS,
    steam_game: true,
    listed: true,
};
const GAME_ID: &str = "1235757738928111729";
const CARD: unreal::MapCard = unreal::MapCard {
    slug: "abiotic-factor",
    appid: "427410",
    playing: "Exploring the facility",
    maps: &[
        unreal::MapDef {
            aliases: &["MainMenu"],
            label: "In the main menu",
            key: "menu",
            menu: true,
        },
        unreal::MapDef {
            aliases: &["Facility"],
            label: "GATE Cascade Research Facility",
            key: "facility",
            menu: false,
        },
    ],
};
fn matches(t: &Target) -> bool {
    t.game_id == GAME_ID
        || t.steam_appid.as_deref() == Some("427410")
        || matches!(
            util::exe_name(t).as_str(),
            "abioticfactor-win64-shipping.exe" | "abioticfactor.exe"
        )
}
fn run(ctx: &Ctx) {
    unreal::run(ctx, &mut State::default());
}
#[derive(Default)]
struct State {
    players: Option<u32>,
    max: Option<u32>,
}
impl Game for State {
    const PROJECT: &'static str = "AbioticFactor";
    fn reset(&mut self, _: &Session) {
        self.players = None;
        self.max = None;
    }
    fn line(&mut self, _: &Session, _: Option<i64>, body: &str) -> bool {
        if !body.starts_with("LogOnlineSession: ") {
            return false;
        }
        for (key, value) in [
            ("PlayerCount", &mut self.players),
            ("MaxPlayers", &mut self.max),
        ] {
            if let Some(n) = session_number(body, key) {
                let changed = *value != Some(n);
                *value = Some(n);
                return changed;
            }
        }
        false
    }
    fn build(&mut self, s: &Session, settings: &Settings, _: bool) -> Option<Live> {
        CARD.build(
            s,
            settings,
            self.players.filter(|n| *n > 0),
            self.max
                .or_else(|| s.opt("MaxPlayers").and_then(|v| v.parse().ok())),
        )
    }
}

fn session_number(body: &str, key: &str) -> Option<u32> {
    let raw = body
        .split_once(&format!("{key}="))
        .map(|(_, r)| r)
        .or_else(|| {
            body.split_once(&format!("named ({key}) with value ("))
                .map(|(_, r)| r)
        })?;
    let digits: String = raw.chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<u32>().ok().filter(|n| *n <= 1024)
}

const SCENARIOS: &[(&str, &str)] = &[
    ("menu", "Main menu"),
    ("solo", "Solo"),
    ("host", "Hosting"),
    ("joined", "In a friend's game"),
    ("server", "Dedicated server"),
];
fn sample(key: &str) -> String {
    let url = match key {
        "solo" => "/Game/Maps/Facility",
        "host" => "/Game/Maps/Facility?listen?MaxPlayers=2",
        "joined" => "steam.76561190000000001/Game/Maps/Facility",
        "server" => "192.0.2.1:7777/Game/Maps/Facility",
        _ => "/Game/Maps/MainMenu",
    };
    let mut log = format!("[2026.06.07-18.42.28:919][1]LogLoad: LoadMap: {url}\nLogWorld: Bringing World /Game/Maps/{} up for play", unreal::Url::parse(url).map());
    if key == "host" {
        log.push_str("\nLogNet: Login request: ?Name=Guest userId: Steam:Guest [0x0001] platform: Steam\nLogNet: Join succeeded: Guest\nLogOnlineSession: EOS: EOS_SessionModification_AddAttribute() named (PlayerCount) with value (2)");
    }
    log
}
fn preview(settings: &Settings, scenario: &str) -> Preview {
    let key = SCENARIOS
        .iter()
        .find(|(k, _)| *k == scenario)
        .or(SCENARIOS.first())
        .map(|(k, _)| *k)
        .unwrap_or("menu");
    let mut game = State::default();
    let s = unreal::replay(&mut game, &sample(key));
    Preview {
        game: "Abiotic Factor",
        icon: None,
        live: game.build(&s, settings, false).unwrap_or_default(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn settings(v: serde_json::Value) -> Settings {
        Settings::new(&MANIFEST, v)
    }
    #[test]
    fn scenarios_and_fallback() {
        let set = settings(serde_json::json!({}));
        for (key, _) in SCENARIOS {
            let l = preview(&set, key).live;
            assert!(!l.is_empty(), "{key}");
            assert!(l.large_image.is_some(), "{key}");
            assert!(!l.competing);
        }
        assert_eq!(preview(&set, "unknown").live, preview(&set, "menu").live);
        assert!(preview(&set, "host")
            .live
            .state
            .as_deref()
            .is_some_and(|s| s.contains("Hosting")));
        assert!(preview(&set, "joined")
            .live
            .state
            .as_deref()
            .is_some_and(|s| s.contains("friend")));
        assert_eq!(
            preview(&set, "server").live.state.as_deref(),
            Some("On a server")
        );
        assert_eq!(preview(&set, "host").live.party, Some([2, 2]));
    }
    #[test]
    fn each_option_changes_preview() {
        let default = preview(&settings(serde_json::json!({})), "host").live;
        for option in MANIFEST.options {
            let set = settings(serde_json::json!({option.key: false}));
            assert_ne!(preview(&set, "host").live, default, "{}", option.key);
        }
    }
    #[test]
    fn unknown_maps_never_show_paths_or_private_options() {
        let mut g = State::default();
        let s = unreal::replay(&mut g, "LogLoad: LoadMap: 192.0.2.1:7777/Game/PrivateMap?Name=PrivateUser?ServerName=PrivateServer");
        let l = g
            .build(&s, &settings(serde_json::json!({})), false)
            .unwrap();
        assert_eq!(l.details.as_deref(), Some("In game"));
        assert_eq!(l.state.as_deref(), Some("On a server"));
    }
    #[test]
    fn game_detection() {
        assert!(matches(&Target {
            game_id: GAME_ID.into(),
            ..Target::default()
        }));
        assert!(matches(&Target {
            exe: Some(std::path::PathBuf::from("AbioticFactor-Win64-Shipping.exe")),
            ..Target::default()
        }));
        assert!(!matches(&Target::default()));
    }

    #[test]
    fn session_settings_update_counts_and_reset_on_return() {
        let mut game = State::default();
        let mut s = unreal::replay(&mut game, "LogLoad: LoadMap: /Game/Maps/Facility??listen?MaxPlayers=2\nLogOnlineSession: EOS: EOS_SessionModification_AddAttribute() named (PlayerCount) with value (2)\nLogOnlineSession: EOS: EOS_SessionModification_AddAttribute() named (MaxPlayers) with value (2)");
        let set = settings(serde_json::json!({}));
        assert_eq!(game.build(&s, &set, false).unwrap().party, Some([2, 2]));
        unreal::feed(
            &mut s,
            &mut game,
            "LogOnlineSession: Verbose: OSS: \t\tPlayerCount=1 : OnlineService",
        );
        assert_eq!(game.build(&s, &set, false).unwrap().party, Some([1, 2]));
        unreal::feed(&mut s, &mut game, "LogOnlineSession: EOS: EOS_SessionModification_AddAttribute() named (PlayerCount) with value (99999)");
        assert_eq!(game.players, Some(1));
        unreal::feed(&mut s, &mut game, "LogLoad: LoadMap: /Game/Maps/MainMenu");
        assert_eq!(game.players, None);
        assert_eq!(game.build(&s, &set, false).unwrap().party, None);
    }
}
