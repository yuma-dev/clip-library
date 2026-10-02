//! CS2 map, mode, score and your K/A/D from Valve's Game State Integration.
//! Ported from cs2-gsi by ccc007ccc (MIT OR Apache-2.0),
//! https://github.com/ccc007ccc/cs2-gsi: src/model/*.rs, src/cfg.rs.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer};
use tracing::{info, warn};

use crate::util::{self, gsi};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "cs2",
    name: "Counter-Strike 2",
    blurb: "Map, mode, team score and your K/A/D.",
    setup: Some(
        "Works from the second time you start the game, it only reads its settings at launch.",
    ),
    credits: &[Credit {
        project: "cs2-gsi",
        author: "ccc007ccc",
        url: "https://github.com/ccc007ccc/cs2-gsi",
        license: "MIT OR Apache-2.0",
    }],
    options: &[
        Opt::toggle(
            "show_score",
            "Show score",
            "Team score from your side.",
            true,
        ),
        Opt::toggle(
            "show_stats",
            "Show K/A/D and MVPs",
            "Your own kills, assists, deaths and MVPs.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[GAME_ID],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg"),
    preview,
    scenarios: SCENARIOS,
    steam_game: true,
    listed: true,
};

const GAME_ID: &str = "1158877933042143272";
const PORT: u16 = 41871;
const TOKEN: &str = "cliplib-cs2";
// subset of cs2-gsi's default sections, only what the card shows
const DATA: &[&str] = &[
    "provider",
    "map",
    "round",
    "player_id",
    "player_state",
    "player_match_stats",
];
// heartbeat is 60 s, two missed ones means the game stopped talking
const STALE: Duration = Duration::from_secs(130);
const TICK: Duration = Duration::from_secs(3);

/// https://github.com/MurkyYT/cs2-map-icons, rebuilt from the game depot on every update
const MAP_ICONS: &str = "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/";

fn matches(t: &Target) -> bool {
    t.game_id == GAME_ID || util::exe_name(t) == "cs2.exe"
}

fn run(ctx: &Ctx) {
    match cfg_dir(ctx.target()) {
        Some(dir) => match gsi::install_cfg(&dir, PORT, TOKEN, DATA) {
            Ok(true) => info!("cs2: gsi cfg written, active from the next game start"),
            Ok(false) => {}
            Err(e) => warn!("cs2: gsi cfg not written: {e}"),
        },
        None => warn!("cs2: no csgo\\cfg folder next to the exe"),
    }
    let rx = match gsi::listen(PORT, TOKEN) {
        Ok(rx) => rx,
        Err(e) => {
            warn!(port = PORT, "cs2: gsi listen failed: {e}");
            return;
        }
    };
    let mut last_post: Option<Instant> = None;
    loop {
        let mut newest = None;
        while let Ok(v) = rx.try_recv() {
            newest = Some(v);
        }
        if let Some(v) = newest {
            last_post = Some(Instant::now());
            if let Ok(gs) = serde_json::from_value::<GameState>(v) {
                ctx.emit(build(&gs, Opts::from(ctx.settings())));
            }
        } else if last_post.is_some_and(|t| t.elapsed() > STALE) {
            last_post = None;
            ctx.emit(None);
        }
        if !ctx.sleep(TICK) {
            return;
        }
    }
}

/// `<root>\game\csgo\cfg` from `<root>\game\bin\win64\cs2.exe`.
fn cfg_dir(t: &Target) -> Option<PathBuf> {
    let exe = t.exe.clone().or_else(|| {
        let cmd = util::process::command_line(t.pid)?;
        util::process::split_args(&cmd)
            .into_iter()
            .next()
            .map(PathBuf::from)
    })?;
    let game = exe.parent()?.parent()?.parent()?;
    let dir = game.join("csgo").join("cfg");
    dir.is_dir().then_some(dir)
}

#[derive(Clone, Copy)]
struct Opts {
    score: bool,
    stats: bool,
}

impl Opts {
    fn from(s: &Settings) -> Self {
        Opts {
            score: s.flag("show_score"),
            stats: s.flag("show_stats"),
        }
    }
}

/// (key, label, sample payload) in the order a session goes
const SAMPLES: &[(&str, &str, &str)] = &[
    (
        "menu",
        "Main menu",
        r#"{"provider": {"steamid": "1"}, "player": {"steamid": "1", "activity": "menu"}}"#,
    ),
    (
        "warmup",
        "Warmup",
        r#"{
        "provider": {"steamid": "1"},
        "map": {"mode": "competitive", "name": "de_nuke", "phase": "warmup", "team_ct": {"score": 0}, "team_t": {"score": 0}},
        "player": {"steamid": "1", "team": "T", "activity": "playing",
            "match_stats": {"kills": 4, "assists": 0, "deaths": 2, "mvps": 0}}
    }"#,
    ),
    (
        "live",
        "Mid match",
        r#"{
        "provider": {"steamid": "1"},
        "map": {"mode": "competitive", "name": "de_mirage", "phase": "live",
            "team_ct": {"score": 9}, "team_t": {"score": 7}},
        "round": {"phase": "live"},
        "player": {"steamid": "1", "team": "CT", "activity": "playing",
            "match_stats": {"kills": 18, "assists": 4, "deaths": 11, "mvps": 3}}
    }"#,
    ),
    (
        "halftime",
        "Halftime",
        r#"{
        "provider": {"steamid": "1"},
        "map": {"mode": "competitive", "name": "de_ancient", "phase": "intermission",
            "team_ct": {"score": 6}, "team_t": {"score": 6}},
        "round": {"phase": "over"},
        "player": {"steamid": "1", "team": "T", "activity": "playing",
            "match_stats": {"kills": 11, "assists": 3, "deaths": 8, "mvps": 2}}
    }"#,
    ),
    (
        "won",
        "Match won",
        r#"{
        "provider": {"steamid": "1"},
        "map": {"mode": "competitive", "name": "de_dust2", "phase": "gameover",
            "team_ct": {"score": 13}, "team_t": {"score": 9}},
        "round": {"phase": "over"},
        "player": {"steamid": "1", "team": "CT", "activity": "playing",
            "match_stats": {"kills": 24, "assists": 6, "deaths": 14, "mvps": 5}}
    }"#,
    ),
    (
        "deathmatch",
        "Deathmatch",
        r#"{
        "provider": {"steamid": "1"},
        "map": {"mode": "deathmatch", "name": "de_inferno", "phase": "live", "team_ct": {"score": 0}, "team_t": {"score": 0}},
        "round": {"phase": "live"},
        "player": {"steamid": "1", "team": "CT", "activity": "playing",
            "match_stats": {"kills": 37, "assists": 2, "deaths": 19, "mvps": 0}}
    }"#,
    ),
    (
        "spectating",
        "Spectating",
        r#"{
        "provider": {"steamid": "1"},
        "map": {"mode": "competitive", "name": "de_inferno", "phase": "live",
            "team_ct": {"score": 4}, "team_t": {"score": 8}},
        "round": {"phase": "live"},
        "player": {"steamid": "2", "team": "T", "activity": "playing",
            "match_stats": {"kills": 15, "assists": 1, "deaths": 6, "mvps": 4}}
    }"#,
    ),
];

const SCENARIOS: &[(&str, &str)] = &[
    ("menu", "Main menu"),
    ("warmup", "Warmup"),
    ("live", "Mid match"),
    ("halftime", "Halftime"),
    ("won", "Match won"),
    ("deathmatch", "Deathmatch"),
    ("spectating", "Spectating"),
];

fn preview(s: &Settings, scenario: &str) -> Preview {
    let json = SAMPLES
        .iter()
        .find(|(k, _, _)| *k == scenario)
        .or(SAMPLES.first())
        .map(|(_, _, j)| *j)
        .unwrap_or("{}");
    let live = serde_json::from_str::<GameState>(json)
        .ok()
        .and_then(|gs| build(&gs, Opts::from(s)));
    Preview {
        game: "Counter-Strike 2",
        icon: None,
        live: live.unwrap_or_default(),
    }
}

fn build(gs: &GameState, o: Opts) -> Option<Live> {
    let Some(map) = &gs.map else {
        // no map block means main menu (or a loading screen)
        return match &gs.player {
            Some(p) if p.activity == "menu" => Some(Live {
                details: util::clamp("In the main menu"),
                ..Live::default()
            }),
            _ => None,
        };
    };
    if map.name.is_empty() {
        return None;
    }
    let short = map.name.rsplit('/').next().unwrap_or(&map.name);
    let (map_name, known) = match map_title(short) {
        Some(n) => (n.to_string(), true),
        None => (title_case(short), false),
    };
    let details = match mode_title(&map.mode) {
        Some(m) => format!("{m}, {map_name}"),
        None => map_name.clone(),
    };

    // player is whoever the camera follows; only the local player's own block counts
    let own = gs
        .player
        .as_ref()
        .filter(|p| !p.steamid.is_empty() && p.steamid == gs.provider.steamid);
    let side = own.map(|p| p.team.as_str()).unwrap_or("");

    let mut parts: Vec<String> = Vec::new();
    let team_mode = !matches!(
        map.mode.as_str(),
        "deathmatch" | "gungameprogressive" | "training" | "survival"
    );
    if o.score && team_mode {
        let (ct, t) = (map.team_ct.score, map.team_t.score);
        let (mine, theirs) = if side == "T" { (t, ct) } else { (ct, t) };
        let score = match side {
            "CT" | "T" => format!("{mine} - {theirs}"),
            _ => format!("CT {ct} - {t} T"),
        };
        parts.push(match map.phase.as_str() {
            "warmup" => "Warmup".to_string(),
            "intermission" => format!("Halftime, {score}"),
            "gameover" if side == "CT" || side == "T" => match mine.cmp(&theirs) {
                std::cmp::Ordering::Greater => format!("Won {score}"),
                std::cmp::Ordering::Less => format!("Lost {score}"),
                std::cmp::Ordering::Equal => format!("Draw {score}"),
            },
            "gameover" => format!("Final {score}"),
            _ => match gs.round.as_ref().map(|r| r.phase.as_str()) {
                Some("freezetime") => format!("{score}, buy time"),
                _ => score,
            },
        });
    } else if map.phase == "warmup" {
        parts.push("Warmup".to_string());
    }
    if o.stats {
        if let Some(p) = own {
            let s = &p.match_stats;
            let mut kad = format!("K/A/D {}/{}/{}", s.kills, s.assists, s.deaths);
            if s.mvps == 1 {
                kad.push_str(", 1 MVP");
            } else if s.mvps > 1 {
                kad.push_str(&format!(", {} MVPs", s.mvps));
            }
            parts.push(kad);
        }
    }

    // map.round is 0- or 1-based depending on who you ask, the scores are not
    let played = map.team_ct.score + map.team_t.score;
    let round =
        (map.phase == "live" && team_mode).then(|| format!("{map_name}, round {}", played + 1));
    // GSI can't tell a Premier match from a ranked map-pick one, both count; warmup is part of the match
    let ranked = matches!(
        map.mode.as_str(),
        "competitive" | "premier" | "scrimcomp2v2" | "scrimcomp5v5"
    ) && (side == "CT" || side == "T")
        && map.phase != "gameover";
    Some(Live {
        competing: ranked,
        details: util::clamp(details),
        state: util::clamp(parts.join(" · ")),
        large_image: known.then(|| format!("{MAP_ICONS}{short}.png")),
        large_text: known
            .then(|| round.unwrap_or(map_name))
            .and_then(util::clamp),
        ..Live::default()
    })
}

fn mode_title(mode: &str) -> Option<&'static str> {
    Some(match mode {
        "competitive" | "scrimcomp5v5" => "Competitive",
        "premier" => "Premier",
        "casual" => "Casual",
        "deathmatch" => "Deathmatch",
        "scrimcomp2v2" => "Wingman",
        "gungameprogressive" => "Arms Race",
        "gungametrbomb" => "Demolition",
        "training" => "Training",
        "custom" => "Custom",
        "cooperative" | "coopmission" => "Co-op",
        _ => return None,
    })
}

/// Maps that have an icon in MAP_ICONS; anything else gets a title-cased name and no art.
fn map_title(name: &str) -> Option<&'static str> {
    Some(match name {
        "de_ancient" => "Ancient",
        "de_ancient_night" => "Ancient Night",
        "de_anubis" => "Anubis",
        "de_dust2" => "Dust II",
        "de_inferno" => "Inferno",
        "de_mirage" => "Mirage",
        "de_nuke" => "Nuke",
        "de_overpass" => "Overpass",
        "de_train" => "Train",
        "de_vertigo" => "Vertigo",
        "de_basalt" => "Basalt",
        "de_edin" => "Edin",
        "de_palais" => "Palais",
        "de_whistle" => "Whistle",
        "de_golden" => "Golden",
        "de_rooftop" => "Rooftop",
        "de_jura" => "Jura",
        "de_grail" => "Grail",
        "de_thera" => "Thera",
        "de_mills" => "Mills",
        "de_assembly" => "Assembly",
        "de_memento" => "Memento",
        "de_brewery" => "Brewery",
        "de_dogtown" => "Dogtown",
        "de_sugarcane" => "Sugarcane",
        "de_palacio" => "Palacio",
        "de_poseidon" => "Poseidon",
        "de_sanctum" => "Sanctum",
        "de_cache" => "Cache",
        "de_cbble" => "Cobblestone",
        "de_canals" => "Canals",
        "de_lake" => "Lake",
        "de_stronghold" => "Stronghold",
        "de_transit" => "Transit",
        "de_warden" => "Warden",
        "cs_italy" => "Italy",
        "cs_office" => "Office",
        "cs_agency" => "Agency",
        "cs_alpine" => "Alpine",
        "cs_shelter" => "Shelter",
        "ar_baggage" => "Baggage",
        "ar_shoots" => "Shoots",
        "ar_shoots_night" => "Shoots Night",
        "ar_pool_day" => "Pool Day",
        _ => return None,
    })
}

/// `de_some_map` -> "Some Map"
fn title_case(name: &str) -> String {
    let base = match name.split_once('_') {
        Some((pre, rest)) if pre.len() <= 3 && !rest.is_empty() => rest,
        _ => name,
    };
    base.split('_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().chain(c).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// cs2-gsi's model, cut down to the fields above. Every node is optional and
// numbers arrive as strings, so everything defaults instead of failing.

#[derive(Deserialize, Default)]
struct GameState {
    #[serde(default)]
    provider: Provider,
    #[serde(default)]
    map: Option<Map>,
    #[serde(default)]
    round: Option<Round>,
    #[serde(default)]
    player: Option<Player>,
}

#[derive(Deserialize, Default)]
struct Provider {
    #[serde(default)]
    steamid: String,
}

#[derive(Deserialize, Default)]
struct Map {
    #[serde(default)]
    mode: String,
    #[serde(default)]
    name: String,
    /// warmup, live, intermission, gameover
    #[serde(default)]
    phase: String,
    #[serde(default)]
    team_ct: Team,
    #[serde(default)]
    team_t: Team,
}

#[derive(Deserialize, Default)]
struct Team {
    #[serde(default, deserialize_with = "num")]
    score: u32,
}

#[derive(Deserialize, Default)]
struct Round {
    /// freezetime, live, over
    #[serde(default)]
    phase: String,
}

#[derive(Deserialize, Default)]
struct Player {
    #[serde(default)]
    steamid: String,
    /// "CT" / "T", missing before a side is picked
    #[serde(default)]
    team: String,
    /// menu, playing, textinput
    #[serde(default)]
    activity: String,
    #[serde(default)]
    match_stats: MatchStats,
}

#[derive(Deserialize, Default)]
struct MatchStats {
    #[serde(default, deserialize_with = "num")]
    kills: i32,
    #[serde(default, deserialize_with = "num")]
    assists: i32,
    #[serde(default, deserialize_with = "num")]
    deaths: i32,
    #[serde(default, deserialize_with = "num")]
    mvps: i32,
}

/// cs2-gsi's de_num_or_str, but junk reads as 0 instead of failing the payload
fn num<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: std::str::FromStr + Default,
{
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Number(n) => n.to_string().parse().unwrap_or_default(),
        serde_json::Value::String(s) => s.trim().parse().unwrap_or_default(),
        _ => T::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: Opts = Opts {
        score: true,
        stats: true,
    };

    fn gs(json: &str) -> GameState {
        serde_json::from_str(json).unwrap()
    }

    // trimmed from cs2-gsi fixtures/sample_live_round.json
    const LIVE: &str = r#"{
        "provider": {"name": "Counter-Strike 2", "appid": "730", "steamid": "76561198000000001"},
        "map": {"mode": "competitive", "name": "de_dust2", "phase": "live", "round": "5",
            "team_ct": {"score": "3"}, "team_t": {"score": "1"}},
        "round": {"phase": "live", "win_team": "", "bomb": ""},
        "player": {"steamid": "76561198000000001", "name": "alice", "observer_slot": 0, "team": "T",
            "activity": "playing", "state": {"health": "100"},
            "match_stats": {"kills": "5", "assists": "1", "deaths": "2", "mvps": "1", "score": "16"}},
        "auth": {"token": "cliplib-cs2"}
    }"#;

    #[test]
    fn live_round() {
        let l = build(&gs(LIVE), ON).unwrap();
        assert_eq!(l.details.as_deref(), Some("Competitive, Dust II"));
        assert_eq!(l.state.as_deref(), Some("1 - 3 · K/A/D 5/1/2, 1 MVP"));
        assert_eq!(
            l.large_image.as_deref(),
            Some(
                "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/images/de_dust2.png"
            )
        );
        assert_eq!(l.large_text.as_deref(), Some("Dust II, round 5"));
        let l = build(
            &gs(LIVE),
            Opts {
                score: false,
                stats: false,
            },
        )
        .unwrap();
        assert_eq!(l.state, None);
    }

    #[test]
    fn spectating_hides_stats() {
        let json = LIVE.replace(
            "\"steamid\": \"76561198000000001\", \"name\"",
            "\"steamid\": \"76561198000000099\", \"name\"",
        );
        let l = build(&gs(&json), ON).unwrap();
        assert_eq!(l.state.as_deref(), Some("CT 3 - 1 T"));
    }

    #[test]
    fn menu_and_phases() {
        let menu =
            r#"{"provider": {"steamid": "1"}, "player": {"steamid": "1", "activity": "menu"}}"#;
        assert_eq!(
            build(&gs(menu), ON).unwrap().details.as_deref(),
            Some("In the main menu")
        );
        assert!(build(&gs(r#"{"provider": {}}"#), ON).is_none());

        let over = LIVE.replace(
            "\"phase\": \"live\", \"round\"",
            "\"phase\": \"gameover\", \"round\"",
        );
        assert!(build(&gs(&over), ON)
            .unwrap()
            .state
            .unwrap()
            .starts_with("Lost 1 - 3"));

        let buy = LIVE.replace(
            "\"round\": {\"phase\": \"live\"",
            "\"round\": {\"phase\": \"freezetime\"",
        );
        assert!(build(&gs(&buy), ON)
            .unwrap()
            .state
            .unwrap()
            .starts_with("1 - 3, buy time"));
    }

    #[test]
    fn deathmatch_and_workshop() {
        let dm = r#"{"provider": {"steamid": "1"},
            "map": {"mode": "deathmatch", "name": "workshop/123/de_my_map", "phase": "live", "round": 0},
            "player": {"steamid": "1", "team": "CT", "match_stats": {"kills": 20, "assists": 0, "deaths": 9, "mvps": 0}}}"#;
        let l = build(&gs(dm), ON).unwrap();
        assert_eq!(l.details.as_deref(), Some("Deathmatch, My Map"));
        assert_eq!(l.state.as_deref(), Some("K/A/D 20/0/9"));
        assert_eq!(l.large_image, None);
        assert_eq!(l.large_text, None);
    }

    #[test]
    fn preview_follows_settings() {
        let on = preview(&Settings::new(&MANIFEST, serde_json::json!({})), "live").live;
        assert_eq!(on.details.as_deref(), Some("Competitive, Mirage"));
        assert_eq!(on.state.as_deref(), Some("9 - 7 · K/A/D 18/4/11, 3 MVPs"));
        assert!(on.large_image.is_some());
        let off = preview(
            &Settings::new(&MANIFEST, serde_json::json!({ "show_stats": false })),
            "live",
        )
        .live;
        assert_eq!(off.state.as_deref(), Some("9 - 7"));
    }

    #[test]
    fn only_ranked_matches_compete() {
        let st = Settings::new(&MANIFEST, serde_json::json!({}));
        for k in ["warmup", "live", "halftime"] {
            assert!(preview(&st, k).live.competing, "{k}");
        }
        for k in ["menu", "won", "deathmatch", "spectating"] {
            assert!(!preview(&st, k).live.competing, "{k}");
        }
        let casual = SAMPLES[2].2.replace("\"competitive\"", "\"casual\"");
        let gs: GameState = serde_json::from_str(&casual).unwrap();
        assert!(!build(&gs, Opts::from(&st)).unwrap().competing);
    }

    #[test]
    fn every_scenario_has_a_card() {
        let st = Settings::new(&MANIFEST, serde_json::json!({}));
        assert_eq!(SCENARIOS.len(), SAMPLES.len());
        for ((k, l), (sk, sl, _)) in SCENARIOS.iter().zip(SAMPLES) {
            assert_eq!((k, l), (sk, sl));
            assert!(!preview(&st, k).live.is_empty(), "{k}");
        }
        assert_eq!(preview(&st, "nope").live, preview(&st, "menu").live);
        assert_eq!(
            preview(&st, "won").live.state.as_deref(),
            Some("Won 13 - 9 · K/A/D 24/6/14, 5 MVPs")
        );
        assert_eq!(
            preview(&st, "spectating").live.state.as_deref(),
            Some("CT 4 - 8 T")
        );
    }

    #[test]
    fn matching() {
        let t = Target {
            game_id: GAME_ID.into(),
            ..Target::default()
        };
        assert!(matches(&t));
        let t = Target {
            exe: Some(PathBuf::from(r"C:\S\game\bin\win64\cs2.exe")),
            ..Target::default()
        };
        assert!(matches(&t));
        assert!(!matches(&Target::default()));
    }
}
