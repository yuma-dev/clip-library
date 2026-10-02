//! Dota 2 hero, K/D/A, last hits, game clock and score from Valve's Game
//! State Integration. Ported from dota-gsi by Tomas Farias (MIT),
//! https://github.com/tomasfarias/dota-gsi: src/components/{mod,players,heroes,team}.rs.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Deserializer};
use tracing::{info, warn};

use crate::util::{self, gsi};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "dota2",
    name: "Dota 2",
    blurb: "Hero, K/D/A, last hits, game clock and score.",
    setup: Some(
        "Add -gamestateintegration to the game's launch options in Steam. Works from the second time you start the game, it only reads its settings at launch.",
    ),
    credits: &[Credit {
        project: "dota-gsi",
        author: "Tomas Farias",
        url: "https://github.com/tomasfarias/dota-gsi",
        license: "MIT",
    }],
    options: &[
        Opt::toggle("show_stats", "Show K/D/A and last hits", "Your kills, deaths, assists, last hits and denies.", true),
        Opt::toggle("show_score", "Show score", "Radiant and Dire kills.", true),
        Opt::toggle("show_clock", "Show game clock", "The in-game clock instead of time since launch.", true),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[GAME_ID],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/570/header.jpg"),
    preview,
    scenarios: SCENARIOS,
    steam_game: true,
    listed: true,
};

const GAME_ID: &str = "356875988589740042";
const PORT: u16 = 41872;
const TOKEN: &str = "cliplib-dota2";
const DATA: &[&str] = &["provider", "map", "player", "hero"];
// heartbeat is 60 s, two missed ones means the game stopped talking
const STALE: Duration = Duration::from_secs(130);
const TICK: Duration = Duration::from_secs(3);
const HERO_ART: &str =
    "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/";

fn matches(t: &Target) -> bool {
    t.game_id == GAME_ID || util::exe_name(t) == "dota2.exe"
}

fn run(ctx: &Ctx) {
    match cfg_dir(ctx.target()) {
        Some(dir) => match gsi::install_cfg(&dir, PORT, TOKEN, DATA) {
            Ok(true) => info!("dota2: gsi cfg written, active from the next game start"),
            Ok(false) => {}
            Err(e) => warn!("dota2: gsi cfg not written: {e}"),
        },
        None => warn!("dota2: no dota\\cfg folder next to the exe"),
    }
    // GSI is off unless the game was started with it (since the March 2022 update)
    if let Some(cmd) = util::process::command_line(ctx.target().pid) {
        if !cmd.to_ascii_lowercase().contains("-gamestateintegration") {
            warn!("dota2: launched without -gamestateintegration, no data will come");
        }
    }
    let rx = match gsi::listen(PORT, TOKEN) {
        Ok(rx) => rx,
        Err(e) => {
            warn!(port = PORT, "dota2: gsi listen failed: {e}");
            return;
        }
    };
    let mut last_post: Option<Instant> = None;
    let mut clock = Clock::default();
    loop {
        let mut newest = None;
        while let Ok(v) = rx.try_recv() {
            newest = Some(v);
        }
        if let Some(v) = newest {
            last_post = Some(Instant::now());
            if let Ok(gs) = serde_json::from_value::<GameState>(v) {
                let mut live = build(&gs, Opts::from(ctx.settings()));
                if let Some(l) = live.as_mut() {
                    l.start_ms = l.start_ms.map(|s| clock.settle(s));
                }
                ctx.emit(live);
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

/// `<root>\game\dota\cfg\gamestate_integration` from `<root>\game\bin\win64\dota2.exe`.
fn cfg_dir(t: &Target) -> Option<PathBuf> {
    let exe = t.exe.clone().or_else(|| {
        let cmd = util::process::command_line(t.pid)?;
        util::process::split_args(&cmd)
            .into_iter()
            .next()
            .map(PathBuf::from)
    })?;
    let cfg = exe.parent()?.parent()?.parent()?.join("dota").join("cfg");
    cfg.is_dir().then(|| cfg.join("gamestate_integration"))
}

/// Posts arrive a second or so late and not on the second, so the derived
/// start wobbles; keep the old one unless it moved for real (a pause).
#[derive(Default)]
struct Clock {
    start: Option<i64>,
}

impl Clock {
    fn settle(&mut self, start: i64) -> i64 {
        match self.start {
            Some(s) if (s - start).abs() <= 2_000 => s,
            _ => {
                self.start = Some(start);
                start
            }
        }
    }
}

#[derive(Clone, Copy)]
struct Opts {
    stats: bool,
    score: bool,
    clock: bool,
}

impl Opts {
    fn from(s: &Settings) -> Self {
        Opts {
            stats: s.flag("show_stats"),
            score: s.flag("show_score"),
            clock: s.flag("show_clock"),
        }
    }
}

/// (key, label, sample payload) in the order a session goes
const SAMPLES: &[(&str, &str, &str)] = &[
    (
        "menu",
        "Main menu",
        r#"{"player": {"steamid": "1", "activity": "menu"}}"#,
    ),
    (
        "hero_selection",
        "Hero selection",
        r#"{
        "map": {"clock_time": -90, "game_state": "DOTA_GAMERULES_STATE_HERO_SELECTION", "win_team": "none",
            "radiant_score": 0, "dire_score": 0},
        "player": {"steamid": "1", "activity": "playing", "team_name": "radiant"},
        "hero": {"id": 0, "name": ""}
    }"#,
    ),
    (
        "strategy",
        "Strategy time",
        r#"{
        "map": {"clock_time": -60, "game_state": "DOTA_GAMERULES_STATE_STRATEGY_TIME", "win_team": "none",
            "radiant_score": 0, "dire_score": 0},
        "player": {"steamid": "1", "activity": "playing", "team_name": "dire"},
        "hero": {"id": 14, "name": "npc_dota_hero_pudge", "level": 1}
    }"#,
    ),
    (
        "in_game",
        "In game",
        r#"{
        "map": {"clock_time": 1720, "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "paused": false,
            "win_team": "none", "radiant_score": 31, "dire_score": 22},
        "player": {"steamid": "1", "activity": "playing", "kills": 9, "deaths": 3, "assists": 12,
            "last_hits": 245, "denies": 18, "team_name": "radiant"},
        "hero": {"id": 74, "name": "npc_dota_hero_invoker", "level": 18}
    }"#,
    ),
    (
        "won",
        "Post game",
        r#"{
        "map": {"clock_time": 2465, "game_state": "DOTA_GAMERULES_STATE_POST_GAME", "win_team": "radiant",
            "radiant_score": 47, "dire_score": 29},
        "player": {"steamid": "1", "activity": "playing", "kills": 14, "deaths": 4, "assists": 9,
            "last_hits": 412, "denies": 21, "team_name": "radiant"},
        "hero": {"id": 8, "name": "npc_dota_hero_juggernaut", "level": 25}
    }"#,
    ),
    (
        "spectating",
        "Spectating",
        r#"{
        "map": {"clock_time": 1385, "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "paused": false,
            "win_team": "none", "radiant_score": 18, "dire_score": 24},
        "player": {"team2": {"player0": {"steamid": "2", "kills": 6}}},
        "hero": {"team2": {"player0": {"id": 1, "name": "npc_dota_hero_antimage"}}}
    }"#,
    ),
];

const SCENARIOS: &[(&str, &str)] = &[
    ("menu", "Main menu"),
    ("hero_selection", "Hero selection"),
    ("strategy", "Strategy time"),
    ("in_game", "In game"),
    ("won", "Post game"),
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
        game: "Dota 2",
        icon: None,
        live: live.unwrap_or_default(),
    }
}

fn build(gs: &GameState, o: Opts) -> Option<Live> {
    // spectating sends players per team instead of one block; own stats only
    let me = gs
        .player
        .as_ref()
        .and_then(|v| Player::deserialize(v).ok())
        .filter(|p| !p.steamid.is_empty());
    let Some(map) = &gs.map else {
        return match &me {
            Some(p) if p.activity == "menu" => Some(Live {
                details: util::clamp("In the main menu"),
                ..Live::default()
            }),
            _ => None,
        };
    };
    let hero = me
        .as_ref()
        .and(gs.hero.as_ref())
        .and_then(|v| Hero::deserialize(v).ok())
        .filter(|h| h.id > 0);
    let short = hero
        .as_ref()
        .and_then(|h| h.name.strip_prefix("npc_dota_hero_"))
        .filter(|s| !s.is_empty());
    let hero_name = short.map(|s| {
        hero_title(s)
            .map(str::to_string)
            .unwrap_or_else(|| title_case(s))
    });

    let phase = match map.game_state.as_str() {
        "DOTA_GAMERULES_STATE_HERO_SELECTION" => "Hero selection",
        "DOTA_GAMERULES_STATE_STRATEGY_TIME" => "Strategy time",
        "DOTA_GAMERULES_STATE_PRE_GAME" | "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" => "",
        "DOTA_GAMERULES_STATE_POST_GAME" | "DOTA_GAMERULES_STATE_LAST" => "Post game",
        "DOTA_GAMERULES_STATE_CUSTOM_GAME_SETUP" => "Custom game setup",
        "DOTA_GAMERULES_STATE_DISCONNECT" => "Disconnected",
        _ => "Loading",
    };
    let in_game = phase.is_empty();
    let post = phase == "Post game";

    let level = hero.as_ref().and_then(|h| h.level).filter(|l| *l > 0);
    let details = match (&hero_name, level) {
        (Some(n), Some(lvl)) if in_game || post => format!("{n}, level {lvl}"),
        (Some(n), _) if !in_game => format!("{phase}, {n}"),
        (Some(n), _) => n.clone(),
        (None, _) if in_game => "In a match".to_string(),
        (None, _) => phase.to_string(),
    };

    let mut parts: Vec<String> = Vec::new();
    if post {
        let team = me.as_ref().map(|p| team_side(&p.team_name)).unwrap_or("");
        let win = team_side(&map.win_team);
        if !team.is_empty() && !win.is_empty() {
            parts.push(if team == win { "Won" } else { "Lost" }.to_string());
        }
    }
    if o.stats && (in_game || post) {
        if let Some(p) = &me {
            parts.push(format!("{}/{}/{}", p.kills, p.deaths, p.assists));
            parts.push(format!("{} LH / {} DN", p.last_hits, p.denies));
        }
    }
    if o.score && (in_game || post) {
        if let (Some(r), Some(d)) = (map.radiant_score, map.dire_score) {
            parts.push(format!("Radiant {r} - {d} Dire"));
        }
    }

    // clock_time is seconds since the horn, negative before it
    let start_ms = (o.clock && in_game && map.clock_time >= 0 && !map.paused)
        .then(|| util::now_ms() - map.clock_time * 1000);

    Some(Live {
        details: util::clamp(details),
        state: util::clamp(parts.join(" · ")),
        large_image: short.map(|s| format!("{HERO_ART}{s}.png")),
        large_text: hero_name.and_then(util::clamp),
        start_ms,
        ..Live::default()
    })
}

/// dota-gsi's Team: "radiant"/"team2", "dire"/"team3"
fn team_side(t: &str) -> &'static str {
    match t {
        "radiant" | "team2" => "radiant",
        "dire" | "team3" => "dire",
        _ => "",
    }
}

/// `some_hero` -> "Some Hero", for heroes newer than the table
fn title_case(name: &str) -> String {
    name.split('_')
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

// dota-gsi's model, cut down. `player` and `hero` are the local player's
// blocks when playing and per-team maps when spectating, so they stay raw
// until we know which.

#[derive(Deserialize)]
struct GameState {
    #[serde(default)]
    map: Option<Map>,
    #[serde(default)]
    player: Option<serde_json::Value>,
    #[serde(default)]
    hero: Option<serde_json::Value>,
}

#[derive(Deserialize, Default)]
struct Map {
    #[serde(default, deserialize_with = "num")]
    clock_time: i64,
    #[serde(default)]
    game_state: String,
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    win_team: String,
    // not in dota-gsi's Map, but the game sends them
    #[serde(default, deserialize_with = "opt_num")]
    radiant_score: Option<u32>,
    #[serde(default, deserialize_with = "opt_num")]
    dire_score: Option<u32>,
}

#[derive(Deserialize, Default)]
struct Player {
    #[serde(default)]
    steamid: String,
    /// menu, playing
    #[serde(default)]
    activity: String,
    #[serde(default, deserialize_with = "num")]
    kills: u32,
    #[serde(default, deserialize_with = "num")]
    deaths: u32,
    #[serde(default, deserialize_with = "num")]
    assists: u32,
    #[serde(default, deserialize_with = "num")]
    last_hits: u32,
    #[serde(default, deserialize_with = "num")]
    denies: u32,
    #[serde(default)]
    team_name: String,
}

#[derive(Deserialize, Default)]
struct Hero {
    /// -1 or 0 until picked
    #[serde(default, deserialize_with = "num")]
    id: i32,
    #[serde(default)]
    name: String,
    #[serde(default, deserialize_with = "opt_num")]
    level: Option<u32>,
}

fn num<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: std::str::FromStr + Default,
{
    Ok(opt_num(d)?.unwrap_or_default())
}

/// numbers or numeric strings, junk reads as None instead of failing the payload
fn opt_num<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: std::str::FromStr,
{
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Number(n) => n.to_string().parse().ok(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    })
}

fn hero_title(short: &str) -> Option<&'static str> {
    HEROES.iter().find(|(k, _)| *k == short).map(|(_, v)| *v)
}

/// npc_dota_hero_<short> to the localized name, from odota/dotaconstants heroes.json
static HEROES: &[(&str, &str)] = &[
    ("abaddon", "Abaddon"),
    ("abyssal_underlord", "Underlord"),
    ("alchemist", "Alchemist"),
    ("ancient_apparition", "Ancient Apparition"),
    ("antimage", "Anti-Mage"),
    ("arc_warden", "Arc Warden"),
    ("axe", "Axe"),
    ("bane", "Bane"),
    ("batrider", "Batrider"),
    ("beastmaster", "Beastmaster"),
    ("bloodseeker", "Bloodseeker"),
    ("bounty_hunter", "Bounty Hunter"),
    ("brewmaster", "Brewmaster"),
    ("bristleback", "Bristleback"),
    ("broodmother", "Broodmother"),
    ("centaur", "Centaur Warrunner"),
    ("chaos_knight", "Chaos Knight"),
    ("chen", "Chen"),
    ("clinkz", "Clinkz"),
    ("crystal_maiden", "Crystal Maiden"),
    ("dark_seer", "Dark Seer"),
    ("dark_willow", "Dark Willow"),
    ("dawnbreaker", "Dawnbreaker"),
    ("dazzle", "Dazzle"),
    ("death_prophet", "Death Prophet"),
    ("disruptor", "Disruptor"),
    ("doom_bringer", "Doom"),
    ("dragon_knight", "Dragon Knight"),
    ("drow_ranger", "Drow Ranger"),
    ("earth_spirit", "Earth Spirit"),
    ("earthshaker", "Earthshaker"),
    ("elder_titan", "Elder Titan"),
    ("ember_spirit", "Ember Spirit"),
    ("enchantress", "Enchantress"),
    ("enigma", "Enigma"),
    ("faceless_void", "Faceless Void"),
    ("furion", "Nature's Prophet"),
    ("grimstroke", "Grimstroke"),
    ("gyrocopter", "Gyrocopter"),
    ("hoodwink", "Hoodwink"),
    ("huskar", "Huskar"),
    ("invoker", "Invoker"),
    ("jakiro", "Jakiro"),
    ("juggernaut", "Juggernaut"),
    ("keeper_of_the_light", "Keeper of the Light"),
    ("kez", "Kez"),
    ("kunkka", "Kunkka"),
    ("largo", "Largo"),
    ("legion_commander", "Legion Commander"),
    ("leshrac", "Leshrac"),
    ("lich", "Lich"),
    ("life_stealer", "Lifestealer"),
    ("lina", "Lina"),
    ("lion", "Lion"),
    ("lone_druid", "Lone Druid"),
    ("luna", "Luna"),
    ("lycan", "Lycan"),
    ("magnataur", "Magnus"),
    ("marci", "Marci"),
    ("mars", "Mars"),
    ("medusa", "Medusa"),
    ("meepo", "Meepo"),
    ("mirana", "Mirana"),
    ("monkey_king", "Monkey King"),
    ("morphling", "Morphling"),
    ("muerta", "Muerta"),
    ("naga_siren", "Naga Siren"),
    ("necrolyte", "Necrophos"),
    ("nevermore", "Shadow Fiend"),
    ("night_stalker", "Night Stalker"),
    ("nyx_assassin", "Nyx Assassin"),
    ("obsidian_destroyer", "Outworld Devourer"),
    ("ogre_magi", "Ogre Magi"),
    ("omniknight", "Omniknight"),
    ("oracle", "Oracle"),
    ("pangolier", "Pangolier"),
    ("phantom_assassin", "Phantom Assassin"),
    ("phantom_lancer", "Phantom Lancer"),
    ("phoenix", "Phoenix"),
    ("primal_beast", "Primal Beast"),
    ("puck", "Puck"),
    ("pudge", "Pudge"),
    ("pugna", "Pugna"),
    ("queenofpain", "Queen of Pain"),
    ("rattletrap", "Clockwerk"),
    ("razor", "Razor"),
    ("riki", "Riki"),
    ("ringmaster", "Ring Master"),
    ("rubick", "Rubick"),
    ("sand_king", "Sand King"),
    ("shadow_demon", "Shadow Demon"),
    ("shadow_shaman", "Shadow Shaman"),
    ("shredder", "Timbersaw"),
    ("silencer", "Silencer"),
    ("skeleton_king", "Wraith King"),
    ("skywrath_mage", "Skywrath Mage"),
    ("slardar", "Slardar"),
    ("slark", "Slark"),
    ("snapfire", "Snapfire"),
    ("sniper", "Sniper"),
    ("spectre", "Spectre"),
    ("spirit_breaker", "Spirit Breaker"),
    ("storm_spirit", "Storm Spirit"),
    ("sven", "Sven"),
    ("techies", "Techies"),
    ("templar_assassin", "Templar Assassin"),
    ("terrorblade", "Terrorblade"),
    ("tidehunter", "Tidehunter"),
    ("tinker", "Tinker"),
    ("tiny", "Tiny"),
    ("treant", "Treant Protector"),
    ("troll_warlord", "Troll Warlord"),
    ("tusk", "Tusk"),
    ("undying", "Undying"),
    ("ursa", "Ursa"),
    ("vengefulspirit", "Vengeful Spirit"),
    ("venomancer", "Venomancer"),
    ("viper", "Viper"),
    ("visage", "Visage"),
    ("void_spirit", "Void Spirit"),
    ("warlock", "Warlock"),
    ("weaver", "Weaver"),
    ("windrunner", "Windranger"),
    ("winter_wyvern", "Winter Wyvern"),
    ("wisp", "Io"),
    ("witch_doctor", "Witch Doctor"),
    ("zuus", "Zeus"),
];

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: Opts = Opts {
        stats: true,
        score: true,
        clock: true,
    };

    fn gs(json: &str) -> GameState {
        serde_json::from_str(json).unwrap()
    }

    // shaped after dota-gsi's playing fixtures in src/components/mod.rs
    const PLAYING: &str = r#"{
        "provider": {"name": "Dota 2", "appid": 570, "version": 47, "timestamp": 1659017150},
        "map": {"name": "start", "matchid": "6700000000", "game_time": 700, "clock_time": 610,
            "daytime": true, "nightstalker_night": false, "radiant_score": 12, "dire_score": 8,
            "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "paused": false,
            "win_team": "none", "customgamename": ""},
        "player": {"steamid": "76561197000000000", "accountid": "1", "name": "me", "activity": "playing",
            "kills": 5, "deaths": 2, "assists": 7, "last_hits": 82, "denies": 12, "kill_streak": 0,
            "kill_list": {}, "commands_issued": 1000, "team_name": "dire", "gold": 600},
        "hero": {"xpos": 0, "ypos": 0, "id": 11, "name": "npc_dota_hero_nevermore", "level": 12, "alive": true},
        "auth": {"token": "cliplib-dota2"}
    }"#;

    #[test]
    fn in_progress() {
        let before = util::now_ms();
        let l = build(&gs(PLAYING), ALL).unwrap();
        assert_eq!(l.details.as_deref(), Some("Shadow Fiend, level 12"));
        assert_eq!(
            l.state.as_deref(),
            Some("5/2/7 · 82 LH / 12 DN · Radiant 12 - 8 Dire")
        );
        assert_eq!(
            l.large_image.as_deref(),
            Some("https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/nevermore.png")
        );
        assert_eq!(l.large_text.as_deref(), Some("Shadow Fiend"));
        let s = l.start_ms.unwrap();
        assert!((s - (before - 610_000)).abs() < 1000);

        let l = build(
            &gs(PLAYING),
            Opts {
                stats: false,
                score: false,
                clock: false,
            },
        )
        .unwrap();
        assert_eq!(l.state, None);
        assert_eq!(l.start_ms, None);
    }

    #[test]
    fn picking_and_post_game() {
        let pick = PLAYING
            .replace(
                "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",
                "DOTA_GAMERULES_STATE_HERO_SELECTION",
            )
            .replace(
                r#""id": 11, "name": "npc_dota_hero_nevermore""#,
                r#""id": -1, "name": """#,
            );
        let l = build(&gs(&pick), ALL).unwrap();
        assert_eq!(l.details.as_deref(), Some("Hero selection"));
        assert_eq!(l.state, None);
        assert_eq!(l.large_image, None);

        let strat = PLAYING.replace(
            "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",
            "DOTA_GAMERULES_STATE_STRATEGY_TIME",
        );
        assert_eq!(
            build(&gs(&strat), ALL).unwrap().details.as_deref(),
            Some("Strategy time, Shadow Fiend")
        );

        let post = PLAYING
            .replace(
                "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS",
                "DOTA_GAMERULES_STATE_POST_GAME",
            )
            .replace(r#""win_team": "none""#, r#""win_team": "dire""#);
        let l = build(&gs(&post), ALL).unwrap();
        assert!(l.state.unwrap().starts_with("Won · 5/2/7"));
        assert_eq!(l.start_ms, None);
    }

    #[test]
    fn menu_spectating_and_new_heroes() {
        let menu = r#"{"provider": {"name": "Dota 2", "appid": 570}, "player": {"steamid": "1", "activity": "menu"}, "draft": {}}"#;
        assert_eq!(
            build(&gs(menu), ALL).unwrap().details.as_deref(),
            Some("In the main menu")
        );
        // dota-gsi's idle payload: empty player block
        assert!(build(&gs(r#"{"provider": {}, "player": {}, "draft": {}}"#), ALL).is_none());

        let spec = r#"{"map": {"clock_time": 100, "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "radiant_score": 1, "dire_score": 2},
            "player": {"team2": {"player0": {"steamid": "1", "kills": 3}}},
            "hero": {"team2": {"player0": {"id": 1, "name": "npc_dota_hero_antimage"}}}}"#;
        let l = build(&gs(spec), ALL).unwrap();
        assert_eq!(l.details.as_deref(), Some("In a match"));
        assert_eq!(l.state.as_deref(), Some("Radiant 1 - 2 Dire"));
        assert_eq!(l.large_image, None);

        assert_eq!(hero_title("abyssal_underlord"), Some("Underlord"));
        assert_eq!(title_case("some_new_hero"), "Some New Hero");
    }

    #[test]
    fn clock_ignores_jitter() {
        let mut c = Clock::default();
        assert_eq!(c.settle(10_000), 10_000);
        assert_eq!(c.settle(11_500), 10_000);
        assert_eq!(c.settle(40_000), 40_000);
    }

    #[test]
    fn preview_follows_settings() {
        let on = preview(&Settings::new(&MANIFEST, serde_json::json!({})), "in_game").live;
        assert_eq!(on.details.as_deref(), Some("Invoker, level 18"));
        assert_eq!(
            on.state.as_deref(),
            Some("9/3/12 · 245 LH / 18 DN · Radiant 31 - 22 Dire")
        );
        assert!(on.start_ms.is_some() && on.large_image.is_some());
        let off = preview(
            &Settings::new(
                &MANIFEST,
                serde_json::json!({ "show_score": false, "show_clock": false }),
            ),
            "in_game",
        )
        .live;
        assert_eq!(off.state.as_deref(), Some("9/3/12 · 245 LH / 18 DN"));
        assert_eq!(off.start_ms, None);
    }

    #[test]
    fn every_scenario_has_a_card() {
        let st = Settings::new(&MANIFEST, serde_json::json!({}));
        assert_eq!(SCENARIOS.len(), SAMPLES.len());
        for ((k, l), (sk, sl, _)) in SCENARIOS.iter().zip(SAMPLES) {
            assert_eq!((k, l), (sk, sl));
            assert!(!preview(&st, k).live.is_empty(), "{k}");
        }
        assert_eq!(preview(&st, "").live, preview(&st, "menu").live);
        assert_eq!(
            preview(&st, "hero_selection").live.details.as_deref(),
            Some("Hero selection")
        );
        assert_eq!(
            preview(&st, "strategy").live.details.as_deref(),
            Some("Strategy time, Pudge")
        );
        assert!(preview(&st, "won")
            .live
            .state
            .unwrap()
            .starts_with("Won · 14/4/9"));
        assert_eq!(
            preview(&st, "spectating").live.state.as_deref(),
            Some("Radiant 18 - 24 Dire")
        );
    }

    #[test]
    fn matching() {
        assert!(matches(&Target {
            game_id: GAME_ID.into(),
            ..Target::default()
        }));
        let t = Target {
            exe: Some(PathBuf::from(r"D:\S\dota 2 beta\game\bin\win64\dota2.exe")),
            ..Target::default()
        };
        assert!(matches(&t));
        assert!(!matches(&Target::default()));
    }
}
