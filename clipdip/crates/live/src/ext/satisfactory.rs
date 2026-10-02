//! Satisfactory map and session details from installed logs, with Epic Games' Unreal
//! logging documentation (docs), https://dev.epicgames.com/documentation/en-us/unreal-engine/logging-in-unreal-engine

use super::unreal::{self, Game, Session};
use crate::util;
use crate::{Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "satisfactory",
    name: "Satisfactory",
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
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/526870/library_hero.jpg"),
    preview,
    scenarios: SCENARIOS,
    steam_game: true,
    listed: true,
};
const GAME_ID: &str = "1402416959819350078";
const CARD: unreal::MapCard = unreal::MapCard {
    slug: "satisfactory",
    appid: "526870",
    playing: "Building a factory",
    maps: &[
        unreal::MapDef {
            aliases: &["Map_Menu_1_02", "Map_Menu_1_01", "Map_Menu"],
            label: "In the main menu",
            key: "menu",
            menu: true,
        },
        unreal::MapDef {
            aliases: &["Persistent_Level"],
            label: "Building a factory",
            key: "world",
            menu: false,
        },
    ],
};
fn matches(t: &Target) -> bool {
    t.game_id == GAME_ID
        || t.steam_appid.as_deref() == Some("526870")
        || matches!(
            util::exe_name(t).as_str(),
            "factorygame-win64-shipping.exe" | "factorygame.exe"
        )
}
fn run(ctx: &Ctx) {
    unreal::run(ctx, &mut State::default());
}
#[derive(Default)]
struct State {}
impl Game for State {
    const PROJECT: &'static str = "FactoryGame";
    fn build(&mut self, s: &Session, settings: &Settings, _: bool) -> Option<Live> {
        CARD.build(
            s,
            settings,
            None,
            s.opt("MaxPlayers").and_then(|v| v.parse().ok()),
        )
    }
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
        "solo" => "/Game/FactoryGame/Map/GameLevel01/Persistent_Level",
        "host" => "/Game/FactoryGame/Map/GameLevel01/Persistent_Level?listen",
        "joined" => "steam.76561190000000001/Game/FactoryGame/Map/GameLevel01/Persistent_Level",
        "server" => "192.0.2.1:7777/Game/FactoryGame/Map/GameLevel01/Persistent_Level",
        _ => "/Game/FactoryGame/Map/MenuScenes/Map_Menu_1_02",
    };
    let mut log = format!("[2026.06.07-18.42.28:919][1]LogLoad: LoadMap: {url}\nLogWorld: Bringing World /Game/Maps/{} up for play", unreal::Url::parse(url).map());
    if key == "host" {
        log.push_str("\nLogNet: Login request: ?Name=Guest userId: Steam:Guest [0x0001] platform: Steam\nLogNet: Join succeeded: Guest");
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
        game: "Satisfactory",
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
        assert_eq!(preview(&set, "host").live.party, None);
        assert_eq!(
            preview(&set, "host").live.state.as_deref(),
            Some("Hosting - 2 players")
        );
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
            exe: Some(std::path::PathBuf::from("FactoryGame-Win64-Shipping.exe")),
            ..Target::default()
        }));
        assert!(!matches(&Target::default()));
    }
}
