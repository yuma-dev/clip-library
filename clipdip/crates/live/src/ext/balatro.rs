//! Ante, round, blind, deck and stake from Balatro run saves. Format references: balatro-rs
//! by evanofslack (format only), https://github.com/evanofslack/balatro-rs: balatro-jkr; Distro
//! by dvrp0 (format only), https://github.com/dvrp0/distro: Distro.lua and util.lua.
//! The Lua reader is original code; no Lua is executed.

mod lua;

use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use flate2::read::DeflateDecoder;

use crate::util::{art, clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use lua::Value;

pub static MANIFEST: Manifest = Manifest {
    id: "balatro",
    name: "Balatro",
    blurb: "Shows your ante, round and blind, with your deck and stake.",
    setup: None,
    credits: &[
        Credit {
            project: "balatro-rs",
            author: "evanofslack",
            url: "https://github.com/evanofslack/balatro-rs",
            license: "format only",
        },
        Credit {
            project: "Distro",
            author: "dvrp0",
            url: "https://github.com/dvrp0/distro",
            license: "format only",
        },
    ],
    options: &[
        Opt::choice(
            "picture",
            "Picture",
            "What the big picture shows.",
            "auto",
            &[
                ("auto", "The blind while you play it, else your deck"),
                ("deck", "Always your deck"),
            ],
        ),
        Opt::toggle(
            "money",
            "Show money",
            "Your dollars next to the blind or shop.",
            true,
        ),
        Opt::toggle(
            "best_hand",
            "Show best hand",
            "Your best hand score this run, in the picture's hover text.",
            false,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[DISCORD_ID],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/2379780/library_hero.jpg"),
    preview,
    scenarios: &[
        ("menu", "Main menu"),
        ("early", "First blind"),
        ("shop", "Shop"),
        ("boss", "Boss blind"),
        ("endless", "Endless"),
    ],
    steam_game: true,
    listed: true,
};

const DISCORD_ID: &str = "1209665818464358430";

// the game writes the run on every state change (blind picked, hand played, shop), so 5 s is plenty
const POLL: Duration = Duration::from_secs(5);
// a late-game save with a big deck is a few hundred KB of text
const MAX_SAVE: u64 = 32 << 20;

fn matches(t: &Target) -> bool {
    t.game_id == DISCORD_ID || exe_name(t) == "balatro.exe"
}

/// G.STATES in globals.lua, only the ones the card names
#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    Playing,
    ChoosingBlind,
    Shop,
    Pack,
    CashOut,
    Other,
}

impl Phase {
    fn of(state: f64) -> Phase {
        match state as i64 {
            1..=3 | 19 => Phase::Playing,
            7 => Phase::ChoosingBlind,
            5 => Phase::Shop,
            9 | 10 | 15 | 17 | 18 => Phase::Pack,
            8 => Phase::CashOut,
            _ => Phase::Other,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct RunInfo {
    ante: i64,
    round: i64,
    endless: bool,
    /// 1 white .. 8 gold
    stake: i64,
    deck_key: String,
    deck_name: String,
    dollars: f64,
    phase: Phase,
    /// `bl_*` and display name of the blind being played or picked next
    blind_key: Option<String>,
    blind_name: Option<String>,
    best_hand: f64,
}

fn read_run(save: &Value) -> Option<RunInfo> {
    let game = save.get("GAME")?;
    let num = |path: &[&str]| game.at(path).and_then(Value::num).filter(|n| n.is_finite());
    let ante = num(&["round_resets", "ante"])? as i64;
    if ante < 1 {
        return None;
    }
    let win_ante = num(&["win_ante"]).unwrap_or(8.0) as i64;
    let won = game.get("won").and_then(Value::bool).unwrap_or(false);
    let phase = save
        .get("STATE")
        .and_then(Value::num)
        .map(Phase::of)
        .unwrap_or(Phase::Other);

    let back = save.get("BACK");
    let deck_key = back
        .and_then(|b| b.get("key"))
        .and_then(Value::str)
        .unwrap_or("b_red")
        .to_string();
    let deck_name = back
        .and_then(|b| b.get("name"))
        .and_then(Value::str)
        .map(str::to_string)
        .or_else(|| deck_label(&deck_key).map(str::to_string))
        .unwrap_or_default();

    let (blind_key, blind_name) = match phase {
        Phase::Playing => {
            let b = save.get("BLIND");
            let key = b
                .and_then(|b| b.get("config_blind"))
                .and_then(Value::str)
                .filter(|k| !k.is_empty());
            let name = b
                .and_then(|b| b.get("name"))
                .and_then(Value::str)
                .filter(|n| !n.is_empty());
            (key.map(str::to_string), name.map(str::to_string))
        }
        Phase::ChoosingBlind => {
            let on_deck = game
                .get("blind_on_deck")
                .and_then(Value::str)
                .unwrap_or("Small");
            let key = game
                .at(&["round_resets", "blind_choices", on_deck])
                .and_then(Value::str);
            (key.map(str::to_string), None)
        }
        _ => (None, None),
    };
    let blind_name = blind_name.or_else(|| {
        blind_key
            .as_deref()
            .and_then(blind_label)
            .map(str::to_string)
    });

    Some(RunInfo {
        ante,
        round: num(&["round"]).unwrap_or(0.0) as i64,
        endless: won && ante > win_ante,
        stake: num(&["stake"]).unwrap_or(1.0) as i64,
        deck_key,
        deck_name,
        dollars: num(&["dollars"]).unwrap_or(0.0),
        phase,
        blind_key,
        blind_name,
        best_hand: num(&["round_scores", "hand", "amt"]).unwrap_or(0.0),
    })
}

/// raw DEFLATE (love.data.compress 'deflate'), or plain text, which the game also reads
fn decode(bytes: &[u8]) -> Option<Value> {
    if bytes.len() as u64 > MAX_SAVE {
        return None;
    }
    if bytes.starts_with(b"return") {
        return lua::parse(std::str::from_utf8(bytes).ok()?);
    }
    let mut text = String::new();
    DeflateDecoder::new(bytes)
        .take(MAX_SAVE + 1)
        .read_to_string(&mut text)
        .ok()?;
    if text.len() as u64 > MAX_SAVE {
        return None;
    }
    lua::parse(&text)
}

const STAKES: [&str; 8] = [
    "White", "Red", "Green", "Black", "Blue", "Purple", "Orange", "Gold",
];

fn deck_label(key: &str) -> Option<&'static str> {
    DECKS.iter().find(|(k, _)| *k == key).map(|(_, n)| *n)
}

fn blind_label(key: &str) -> Option<&'static str> {
    BLINDS.iter().find(|(k, _)| *k == key).map(|(_, n)| *n)
}

const DECKS: &[(&str, &str)] = &[
    ("b_red", "Red Deck"),
    ("b_blue", "Blue Deck"),
    ("b_yellow", "Yellow Deck"),
    ("b_green", "Green Deck"),
    ("b_black", "Black Deck"),
    ("b_magic", "Magic Deck"),
    ("b_nebula", "Nebula Deck"),
    ("b_ghost", "Ghost Deck"),
    ("b_abandoned", "Abandoned Deck"),
    ("b_checkered", "Checkered Deck"),
    ("b_zodiac", "Zodiac Deck"),
    ("b_painted", "Painted Deck"),
    ("b_anaglyph", "Anaglyph Deck"),
    ("b_plasma", "Plasma Deck"),
    ("b_erratic", "Erratic Deck"),
    ("b_challenge", "Challenge Deck"),
];

const BLINDS: &[(&str, &str)] = &[
    ("bl_small", "Small Blind"),
    ("bl_big", "Big Blind"),
    ("bl_ox", "The Ox"),
    ("bl_hook", "The Hook"),
    ("bl_mouth", "The Mouth"),
    ("bl_fish", "The Fish"),
    ("bl_club", "The Club"),
    ("bl_manacle", "The Manacle"),
    ("bl_tooth", "The Tooth"),
    ("bl_wall", "The Wall"),
    ("bl_house", "The House"),
    ("bl_mark", "The Mark"),
    ("bl_wheel", "The Wheel"),
    ("bl_arm", "The Arm"),
    ("bl_psychic", "The Psychic"),
    ("bl_goad", "The Goad"),
    ("bl_water", "The Water"),
    ("bl_eye", "The Eye"),
    ("bl_plant", "The Plant"),
    ("bl_needle", "The Needle"),
    ("bl_head", "The Head"),
    ("bl_window", "The Window"),
    ("bl_serpent", "The Serpent"),
    ("bl_pillar", "The Pillar"),
    ("bl_flint", "The Flint"),
    ("bl_final_bell", "Cerulean Bell"),
    ("bl_final_leaf", "Verdant Leaf"),
    ("bl_final_vessel", "Violet Vessel"),
    ("bl_final_acorn", "Amber Acorn"),
    ("bl_final_heart", "Crimson Heart"),
];

// the pack avoids hotlink restrictions on the source wiki
fn deck_image(key: &str) -> Option<String> {
    deck_label(key)
        .filter(|_| key != "b_challenge")
        .map(|_| art::url("balatro", key))
}

fn blind_image(key: &str) -> Option<String> {
    blind_label(key).map(|_| art::url("balatro", key))
}

fn money(d: f64) -> String {
    if d < 0.0 {
        format!("-${}", -d as i64)
    } else {
        format!("${}", d as i64)
    }
}

// the game itself switches to e-notation past 1e11
fn score(n: f64) -> String {
    if !n.is_finite() {
        return "naneinf".into();
    }
    if n >= 1e11 {
        let exp = n.log10().floor() as i32;
        return format!("{:.3}e{exp}", n / 10f64.powi(exp));
    }
    let digits = (n as i64).to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `None` = no run going: the main menu card.
fn build(run: Option<&RunInfo>, s: &Settings) -> Live {
    let Some(r) = run else {
        return Live {
            details: clamp("Main menu"),
            ..Live::default()
        };
    };
    let details = if r.endless {
        format!("Endless, Ante {} · Round {}", r.ante, r.round)
    } else {
        format!("Ante {} · Round {}", r.ante, r.round)
    };

    let blind = r.blind_name.as_deref();
    let what = match (r.phase, blind) {
        (Phase::Playing, Some(b)) => Some(b.to_string()),
        (Phase::ChoosingBlind, Some(b)) => Some(format!("Next up: {b}")),
        (Phase::ChoosingBlind, None) => Some("Choosing a blind".to_string()),
        (Phase::Shop, _) => Some("In the shop".to_string()),
        (Phase::Pack, _) => Some("Opening a booster pack".to_string()),
        (Phase::CashOut, _) => Some("Cashing out".to_string()),
        _ => None,
    };
    let state = match (what, s.flag("money")) {
        (Some(w), true) => Some(format!("{w} · {}", money(r.dollars))),
        (Some(w), false) => Some(w),
        (None, true) => Some(money(r.dollars)),
        (None, false) => None,
    };

    let mut hover = r.deck_name.clone();
    if let Some(stake) = usize::try_from(r.stake.saturating_sub(1))
        .ok()
        .and_then(|i| STAKES.get(i))
    {
        hover = if hover.is_empty() {
            format!("{stake} Stake")
        } else {
            format!("{hover}, {stake} Stake")
        };
    }
    if s.flag("best_hand") && r.best_hand > 0.0 {
        hover = format!("{hover} · Best hand {}", score(r.best_hand));
    }

    let blind_pic = matches!(r.phase, Phase::Playing | Phase::ChoosingBlind)
        .then(|| r.blind_key.as_deref().and_then(blind_image))
        .flatten();
    let large_image = match s.choice("picture").as_str() {
        "deck" => deck_image(&r.deck_key),
        _ => blind_pic.or_else(|| deck_image(&r.deck_key)),
    };

    Live {
        details: clamp(details),
        state: state.and_then(clamp),
        large_image,
        large_text: clamp(hover),
        ..Live::default()
    }
}

fn preview(s: &Settings, scenario: &str) -> Preview {
    let run = |ante, round, phase, blind: Option<&str>, dollars, stake, deck: &str| RunInfo {
        ante,
        round,
        endless: ante > 8,
        stake,
        deck_key: deck.to_string(),
        deck_name: deck_label(deck).unwrap_or_default().to_string(),
        dollars,
        phase,
        blind_key: blind.map(str::to_string),
        blind_name: blind.and_then(blind_label).map(str::to_string),
        best_hand: 48_320.0,
    };
    let info = match scenario {
        "early" => Some(run(1, 1, Phase::Playing, Some("bl_small"), 4.0, 1, "b_red")),
        "shop" => Some(run(2, 5, Phase::Shop, None, 23.0, 3, "b_blue")),
        "boss" => Some(run(
            4,
            12,
            Phase::Playing,
            Some("bl_hook"),
            17.0,
            5,
            "b_checkered",
        )),
        "endless" => Some(RunInfo {
            best_hand: 3.2e14,
            ..run(
                11,
                34,
                Phase::ChoosingBlind,
                Some("bl_final_heart"),
                112.0,
                8,
                "b_plasma",
            )
        }),
        _ => None,
    };
    Preview {
        game: "Balatro",
        icon: None,
        live: build(info.as_ref(), s),
    }
}

fn save_dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join("Balatro"))
}

/// `["profile"]=n` in settings.jkr, 1 when missing
fn profile(dir: &std::path::Path) -> String {
    read_file(&dir.join("settings.jkr"))
        .and_then(|v| v.get("profile").and_then(Value::num))
        .filter(|n| (1.0..=99.0).contains(n))
        .map(|n| (n as i64).to_string())
        .unwrap_or_else(|| "1".into())
}

fn run(ctx: &Ctx) {
    let Some(dir) = save_dir() else { return };
    let session_start =
        SystemTime::UNIX_EPOCH + Duration::from_millis(ctx.target().started_at_ms.max(0) as u64);
    let mut seen: Option<(PathBuf, SystemTime)> = None;
    let mut info: Option<RunInfo> = None;
    loop {
        // the profile can change from the menu, settings.jkr is tiny
        let path = dir.join(profile(&dir)).join("save.jkr");
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        match mtime {
            // a save from before this launch is a run left for later: still the menu
            Some(t) if t >= session_start => {
                if seen.as_ref() != Some(&(path.clone(), t)) {
                    // a half-written file fails to inflate, the next tick gets it whole
                    info = read_file(&path).and_then(|v| read_run(&v));
                    if info.is_some() {
                        seen = Some((path, t));
                    }
                }
            }
            // gone after a game over, or never written
            _ => {
                info = None;
                seen = None;
            }
        }
        let live = if mtime.is_some_and(|t| t >= session_start) && info.is_none() {
            None
        } else {
            Some(build(info.as_ref(), ctx.settings()))
        };
        ctx.emit(live);
        if !ctx.sleep(POLL) {
            return;
        }
    }
}

fn read_file(path: &std::path::Path) -> Option<Value> {
    let f = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    f.take(MAX_SAVE + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_SAVE {
        return None;
    }
    decode(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::DeflateEncoder;
    use std::io::Write;

    // trimmed from what save_run() packs, same key order and spelling as STR_PACK output
    const SAVE: &str = r#"return {["cardAreas"]={["jokers"]={["cards"]={[1]={["save_fields"]={["center"]="j_joker",},},},},},["tags"]={},["GAME"]={["won"]=false,["round_scores"]={["hand"]={["label"]="Best Hand",["amt"]=1520,},["furthest_ante"]={["label"]="Ante",["amt"]=4,},},["win_ante"]=8,["stake"]=5,["round"]=11,["dollars"]=17,["blind"]="\"MANUAL_REPLACE\"",["blind_on_deck"]="Boss",["current_round"]={["hands_left"]=4,["discards_left"]=3,},["round_resets"]={["ante"]=4,["blind_ante"]=4,["blind_states"]={["Small"]="Defeated",["Big"]="Skipped",["Boss"]="Select",},["blind_choices"]={["Small"]="bl_small",["Big"]="bl_big",["Boss"]="bl_hook",},},},["STATE"]=7,["BLIND"]={["name"]="Big Blind",["config_blind"]="bl_big",["chips"]=2400,["boss"]=false,},["BACK"]={["name"]="Checkered Deck",["key"]="b_checkered",["pos"]={["x"]=1,["y"]=3,},},["VERSION"]="1.0.1o-FULL",}"#;

    fn settings(v: serde_json::Value) -> Settings {
        Settings::new(&MANIFEST, v)
    }

    fn deflate(s: &str) -> Vec<u8> {
        let mut e = DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
        e.write_all(s.as_bytes()).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn invalid_run_numbers_do_not_panic() {
        let bad = SAVE.replace(r#"["ante"]=4"#, r#"["ante"]=nan"#);
        assert!(read_run(&lua::parse(&bad).unwrap()).is_none());
        let bad = SAVE.replace(r#"["stake"]=5"#, r#"["stake"]=-1e30"#);
        let r = read_run(&lua::parse(&bad).unwrap()).unwrap();
        assert_eq!(
            build(Some(&r), &settings(serde_json::json!({})))
                .large_text
                .as_deref(),
            Some("Checkered Deck")
        );
    }

    #[test]
    fn matches_id_and_exe() {
        assert!(matches(&Target {
            game_id: DISCORD_ID.into(),
            ..Target::default()
        }));
        assert!(matches(&Target {
            game_id: "steam:2379780".into(),
            exe: Some(r"F:\Steam\Balatro\Balatro.exe".into()),
            ..Target::default()
        }));
        assert!(!matches(&Target {
            game_id: "1".into(),
            ..Target::default()
        }));
    }

    #[test]
    fn decodes_jkr() {
        let v = decode(&deflate(SAVE)).unwrap();
        assert_eq!(decode(SAVE.as_bytes()), Some(v.clone()));
        let r = read_run(&v).unwrap();
        assert_eq!((r.ante, r.round, r.stake, r.endless), (4, 11, 5, false));
        assert_eq!(r.phase, Phase::ChoosingBlind);
        assert_eq!(r.blind_key.as_deref(), Some("bl_hook"));
        assert_eq!(r.blind_name.as_deref(), Some("The Hook"));
        assert_eq!(r.deck_name, "Checkered Deck");
        assert!(decode(b"\x00garbage").is_none());
        // a save cut off mid write
        let full = deflate(SAVE);
        assert!(decode(&full[..full.len() / 2]).is_none());
    }

    #[test]
    fn real_settings_file_shape() {
        // settings.jkr from this PC, trimmed
        let v = decode(&deflate(r#"return {["version"]="1.0.1o-FULL",["paused"]=true,["ambient_control"]={["ambientFire1"]={["per"]=1.1,["vol"]=2.2232954062856e-322,},},["current_setup"]="New Run",["profile"]=2,["tutorial_complete"]=true,}"#)).unwrap();
        assert_eq!(v.get("profile").and_then(Value::num), Some(2.0));
    }

    #[test]
    fn playing_uses_the_blind_table() {
        let save = SAVE.replace(r#"["STATE"]=7"#, r#"["STATE"]=1"#);
        let r = read_run(&lua::parse(&save).unwrap()).unwrap();
        assert_eq!(r.phase, Phase::Playing);
        assert_eq!(r.blind_name.as_deref(), Some("Big Blind"));
        let live = build(Some(&r), &settings(serde_json::json!({})));
        assert_eq!(live.details.as_deref(), Some("Ante 4 · Round 11"));
        assert_eq!(live.state.as_deref(), Some("Big Blind · $17"));
        assert_eq!(
            live.large_image.as_deref(),
            Some(art::url("balatro", "bl_big").as_str())
        );
        assert_eq!(
            live.large_text.as_deref(),
            Some("Checkered Deck, Blue Stake")
        );
    }

    #[test]
    fn modded_and_missing_bits() {
        let save = SAVE
            .replace("b_checkered", "b_mod_thing")
            .replace("Checkered Deck", "Thing Deck")
            .replace(r#"["stake"]=5"#, r#"["stake"]=12"#);
        let r = read_run(&lua::parse(&save).unwrap()).unwrap();
        let live = build(
            Some(&r),
            &settings(serde_json::json!({ "picture": "deck" })),
        );
        assert_eq!(live.large_image, None);
        assert_eq!(live.large_text.as_deref(), Some("Thing Deck"));
        assert!(read_run(&lua::parse(r#"return {["STATE"]=5,}"#).unwrap()).is_none());
    }

    #[test]
    fn numbers() {
        assert_eq!(score(1520.0), "1,520");
        assert_eq!(score(123_456_789.0), "123,456,789");
        assert_eq!(score(3.2e14), "3.200e14");
        assert_eq!(money(-3.0), "-$3");
    }

    #[test]
    fn options_change_the_card() {
        let plain = preview(&settings(serde_json::json!({})), "boss").live;
        assert_eq!(plain.state.as_deref(), Some("The Hook · $17"));
        assert_eq!(
            plain.large_image.as_deref(),
            Some(art::url("balatro", "bl_hook").as_str())
        );
        let other = preview(
            &settings(serde_json::json!({ "money": false, "best_hand": true, "picture": "deck" })),
            "boss",
        )
        .live;
        assert_eq!(other.state.as_deref(), Some("The Hook"));
        assert_eq!(
            other.large_image.as_deref(),
            Some(art::url("balatro", "b_checkered").as_str())
        );
        assert_eq!(
            other.large_text.as_deref(),
            Some("Checkered Deck, Blue Stake · Best hand 48,320")
        );
    }

    #[test]
    fn every_scenario_has_a_card() {
        let s = settings(serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(preview(&s, key).live.details.is_some(), "{key}");
        }
        assert_eq!(
            preview(&s, "nope").live,
            preview(&s, MANIFEST.scenarios[0].0).live
        );
        assert_eq!(
            preview(&s, "menu").live.details.as_deref(),
            Some("Main menu")
        );
        let e = preview(&s, "endless").live;
        assert_eq!(e.details.as_deref(), Some("Endless, Ante 11 · Round 34"));
        assert_eq!(e.state.as_deref(), Some("Next up: Crimson Heart · $112"));
        assert_eq!(
            preview(&s, "shop").live.state.as_deref(),
            Some("In the shop · $23")
        );
        assert_eq!(
            preview(&s, "shop").live.large_image.as_deref(),
            Some(art::url("balatro", "b_blue").as_str())
        );
    }
}
