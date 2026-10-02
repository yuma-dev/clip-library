//! Car, class and PI from Forza Horizon's Data Out telemetry, plus race position. Ported from
//! Forza-Horizon-Discord-Rich-Presence by 1Stalk (MIT),
//! https://github.com/1Stalk/Forza-Horizon-Discord-Rich-Presence: src-tauri/src/telemetry.rs,
//! discord.rs, modules/fh4.rs, fh5.rs, fh6.rs and cars.json.

use std::collections::HashMap;
use std::net::UdpSocket;
use std::time::{Duration, Instant};

use tracing::warn;

use crate::util::{clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "forza",
    name: "Forza Horizon 4, 5 and 6",
    blurb: "Shows your car with its class and PI, and your position in races.",
    setup: Some(
        "In Settings, HUD and Gameplay, turn on Data Out with IP 127.0.0.1 and port 8001 (or the port \
         picked below). Xbox app version: Windows blocks it from sending to local apps until you run this \
         once in an admin terminal: CheckNetIsolation LoopbackExempt -a -n=Microsoft.624F8B84B80_8wekyb3d8bbwe \
         (FH5) or -n=Microsoft.SunriseBaseGame_8wekyb3d8bbwe (FH4).",
    ),
    credits: &[Credit {
        project: "Forza Horizon Discord Rich Presence",
        author: "1Stalk",
        url: "https://github.com/1Stalk/Forza-Horizon-Discord-Rich-Presence",
        license: "MIT",
    }],
    options: &[Opt::choice(
        "port",
        "Data Out port",
        "Must match the port set in the game. Pick another one if SimHub already uses 8001.",
        "8001",
        &[("8001", "8001"), ("8002", "8002"), ("8003", "8003"), ("9999", "9999")],
    )],
    matches,
    run,
    priority: 10,
    game_ids: &["656353816370741248", "905961880789590076", "1445163122284429375"],
    // FH6's Steam header lives under a hashed, versioned path, FH5's is stable
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/1551360/header.jpg"),
    preview,
    scenarios: &[
        ("fh4", "Free roam, FH4"),
        ("fh5", "Free roam, FH5"),
        ("fh6", "Free roam, FH6"),
        ("race", "Racing"),
        ("unknown_car", "Unknown car"),
    ],
    steam_game: true,
    listed: true,
};

const FH4_IDS: &[&str] = &[MANIFEST.game_ids[0]];
const FH5_IDS: &[&str] = &[MANIFEST.game_ids[1]];
const FH6_IDS: &[&str] = &[MANIFEST.game_ids[2]];

// one table for all three games like the original: ordinals never clash between them
const CARS: &str = include_str!("forza/cars.tsv");

#[derive(Clone, Copy, Debug, PartialEq)]
enum Game {
    Fh4,
    Fh5,
    Fh6,
}

impl Game {
    fn of(t: &Target) -> Option<Game> {
        let id = t.game_id.as_str();
        if FH4_IDS.contains(&id) {
            return Some(Game::Fh4);
        }
        if FH5_IDS.contains(&id) {
            return Some(Game::Fh5);
        }
        if FH6_IDS.contains(&id) {
            return Some(Game::Fh6);
        }
        match exe_name(t).as_str() {
            "forzahorizon4.exe" => Some(Game::Fh4),
            "forzahorizon5.exe" => Some(Game::Fh5),
            "forzahorizon6.exe" => Some(Game::Fh6),
            _ => None,
        }
    }

    // the original's fallback line when OpenXBL has no rich presence string
    fn exploring(self) -> &'static str {
        match self {
            Game::Fh4 => "Exploring Great Britain",
            Game::Fh5 => "Exploring Mexico",
            Game::Fh6 => "Exploring Japan",
        }
    }

    // FH6 added R between S2 and X
    fn class(self, id: i32) -> &'static str {
        match (self, id) {
            (_, 0) => "D",
            (_, 1) => "C",
            (_, 2) => "B",
            (_, 3) => "A",
            (_, 4) => "S1",
            (_, 5) => "S2",
            (Game::Fh6, 6) => "R",
            (Game::Fh6, 7) => "X",
            (_, 6) => "X",
            _ => "Unknown",
        }
    }
}

fn matches(t: &Target) -> bool {
    Game::of(t).is_some()
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Packet {
    race_on: bool,
    car_ordinal: i32,
    car_class: i32,
    car_pi: i32,
    /// 0 outside events
    race_position: u8,
}

// Sled is 232 bytes, Horizon inserts 12 unknown bytes before the Dash part, so Dash
// offsets are Motorsport's + 12 (speed 256, race position 314). Full packet is 324 bytes.
fn parse(buf: &[u8]) -> Option<Packet> {
    // the original's floor, FH4/5 packets are 311-324 bytes
    if buf.len() < 311 {
        return None;
    }
    let i32_at = |o: usize| {
        buf.get(o..o + 4)
            .and_then(|b| b.try_into().ok())
            .map(i32::from_le_bytes)
            .unwrap_or(0)
    };
    Some(Packet {
        race_on: i32_at(0) != 0,
        car_ordinal: i32_at(212),
        car_class: i32_at(216),
        car_pi: i32_at(220),
        race_position: buf.get(314).copied().unwrap_or(0),
    })
}

/// What the card shows; rebuilt only when this changes.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Shown {
    car_ordinal: i32,
    car_class: i32,
    car_pi: i32,
    race_position: u8,
}

impl Shown {
    // keeps the last real car like the original (ordinal 0 = menus, loading), and only
    // trusts the race position while driving so a pause mid race doesn't flip it
    fn update(&mut self, p: &Packet) {
        if p.car_ordinal != 0 {
            self.car_ordinal = p.car_ordinal;
            self.car_class = p.car_class;
            self.car_pi = p.car_pi;
        }
        if p.race_on {
            self.race_position = p.race_position;
        }
    }
}

pub(crate) fn load_cars() -> HashMap<i32, &'static str> {
    CARS.lines()
        .filter_map(|l| {
            let (id, name) = l.split_once('\t')?;
            Some((id.trim().parse().ok()?, name.trim()))
        })
        .collect()
}

fn build(game: Game, s: &Shown, cars: &HashMap<i32, &str>) -> Option<Live> {
    // nothing seen yet: the original shows only the XBL line, which we don't have
    if s.car_ordinal == 0 {
        return None;
    }
    let details = if s.race_position > 0 {
        format!("Racing, P{}", s.race_position)
    } else {
        game.exploring().to_string()
    };
    let mut live = Live {
        details: clamp(details),
        ..Live::default()
    };
    // unknown cars get no car line, same as the original
    if let Some(name) = cars.get(&s.car_ordinal) {
        let class = game.class(s.car_class);
        // the original cuts names over 25 chars on the card and keeps the full one for the hover
        let short = if name.chars().count() > 25 {
            format!(
                "{}...",
                name.chars().take(22).collect::<String>().trim_end()
            )
        } else {
            name.to_string()
        };
        live.state = clamp(format!("{short} | {class} ({})", s.car_pi));
        live.large_text = clamp(format!("{name} | {class} ({})", s.car_pi));
    }
    Some(live)
}

// the only option is the port, which the card doesn't show
fn preview(_: &Settings, scenario: &str) -> Preview {
    let car = |car_ordinal, car_class, car_pi, race_position| Shown {
        car_ordinal,
        car_class,
        car_pi,
        race_position,
    };
    let (game, title, shown) = match scenario {
        "fh5" => (Game::Fh5, "Forza Horizon 5", car(461, 3, 800, 0)),
        "fh6" => (Game::Fh6, "Forza Horizon 6", car(4057, 3, 750, 0)),
        "race" => (Game::Fh5, "Forza Horizon 5", car(3781, 4, 880, 2)),
        // an ordinal the table doesn't know yet, so no car line
        "unknown_car" => (Game::Fh6, "Forza Horizon 6", car(5999, 5, 920, 0)),
        _ => (Game::Fh4, "Forza Horizon 4", car(1105, 1, 560, 0)),
    };
    Preview {
        game: title,
        icon: None,
        live: build(game, &shown, &load_cars()).unwrap_or_default(),
    }
}

fn run(ctx: &Ctx) {
    let Some(game) = Game::of(ctx.target()) else {
        return;
    };
    let port: u16 = ctx.choice("port").parse().unwrap_or(8001);
    let socket = match UdpSocket::bind(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(e) => {
            warn!(port, "forza: can't bind the Data Out port: {e}");
            return;
        }
    };
    // so the loop can notice the session ending while the game sends nothing
    if let Err(e) = socket.set_read_timeout(Some(Duration::from_secs(1))) {
        warn!("forza: set_read_timeout: {e}");
        return;
    }

    let cars = load_cars();
    let mut buf = [0u8; 512];
    let mut shown = Shown::default();
    let mut emitted: Option<Shown> = None;
    let mut last_build: Option<Instant> = None;

    while ctx.running() {
        // ~60 packets/s while the game runs, timeouts just fall through to the emit check
        if let Ok((n, _)) = socket.recv_from(&mut buf) {
            if let Some(p) = buf.get(..n).and_then(parse) {
                shown.update(&p);
            }
        }
        if emitted == Some(shown)
            || last_build.is_some_and(|t| t.elapsed() < Duration::from_secs(1))
        {
            continue;
        }
        ctx.emit(build(game, &shown, &cars));
        emitted = Some(shown);
        last_build = Some(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(race_on: i32, ordinal: i32, class: i32, pi: i32, position: u8) -> Vec<u8> {
        let mut b = vec![0u8; 324];
        b[0..4].copy_from_slice(&race_on.to_le_bytes());
        b[212..216].copy_from_slice(&ordinal.to_le_bytes());
        b[216..220].copy_from_slice(&class.to_le_bytes());
        b[220..224].copy_from_slice(&pi.to_le_bytes());
        b[256..260].copy_from_slice(&40.0f32.to_le_bytes());
        b[314] = position;
        b
    }

    fn target(id: &str, exe: Option<&str>) -> Target {
        Target {
            game_id: id.into(),
            exe: exe.map(Into::into),
            ..Target::default()
        }
    }

    #[test]
    fn matches_ids_and_exes() {
        assert_eq!(
            Game::of(&target("656353816370741248", None)),
            Some(Game::Fh4)
        );
        assert_eq!(
            Game::of(&target("905961880789590076", None)),
            Some(Game::Fh5)
        );
        assert_eq!(
            Game::of(&target("1445163122284429375", None)),
            Some(Game::Fh6)
        );
        assert_eq!(
            Game::of(&target("steam:1", Some(r"C:\Games\FH6\ForzaHorizon6.exe"))),
            Some(Game::Fh6)
        );
        assert!(!matches(&target("123", Some(r"C:\x\forza.exe"))));
    }

    #[test]
    fn parses_horizon_layout() {
        let p = parse(&packet(1, 3954, 5, 899, 3)).unwrap();
        assert_eq!(
            p,
            Packet {
                race_on: true,
                car_ordinal: 3954,
                car_class: 5,
                car_pi: 899,
                race_position: 3
            }
        );
        assert!(parse(&[0u8; 232]).is_none());
        // short but over the floor: position is past the end
        assert_eq!(
            parse(&packet(1, 247, 3, 700, 2)[..311])
                .unwrap()
                .race_position,
            0
        );
    }

    #[test]
    fn classes_per_game() {
        assert_eq!(Game::Fh5.class(6), "X");
        assert_eq!(Game::Fh6.class(6), "R");
        assert_eq!(Game::Fh6.class(7), "X");
        assert_eq!(Game::Fh4.class(9), "Unknown");
    }

    #[test]
    fn car_table_loads() {
        let cars = load_cars();
        assert!(cars.len() > 1300);
        assert_eq!(cars.get(&247), Some(&"1969 Toyota 2000GT"));
    }

    #[test]
    fn card_text() {
        let cars = load_cars();
        let mut s = Shown::default();
        assert_eq!(build(Game::Fh5, &s, &cars), None);

        s.update(&parse(&packet(1, 247, 3, 700, 0)).unwrap());
        let live = build(Game::Fh5, &s, &cars).unwrap();
        assert_eq!(live.details.as_deref(), Some("Exploring Mexico"));
        assert_eq!(live.state.as_deref(), Some("1969 Toyota 2000GT | A (700)"));

        // menus send ordinal 0 and race off: keep the car
        s.update(&parse(&packet(0, 0, 0, 0, 0)).unwrap());
        assert_eq!(build(Game::Fh5, &s, &cars), Some(live));

        s.update(&parse(&packet(1, 247, 3, 700, 4)).unwrap());
        assert_eq!(
            build(Game::Fh5, &s, &cars).unwrap().details.as_deref(),
            Some("Racing, P4")
        );
        // paused mid race
        s.update(&parse(&packet(0, 247, 3, 700, 0)).unwrap());
        assert_eq!(s.race_position, 4);
    }

    #[test]
    fn preview_card() {
        let p = preview(&Settings::new(&MANIFEST, serde_json::json!({})), "fh5");
        assert_eq!(p.game, "Forza Horizon 5");
        assert_eq!(p.live.details.as_deref(), Some("Exploring Mexico"));
        assert_eq!(
            p.live.state.as_deref(),
            Some("1998 Toyota Supra RZ | A (800)")
        );
        // no toggles to flip; the port choice must not change the card
        let other = preview(
            &Settings::new(&MANIFEST, serde_json::json!({ "port": "8002" })),
            "fh5",
        );
        assert_eq!(other.live, p.live);
        assert_eq!(MANIFEST.game_ids.len(), 3);
    }

    #[test]
    fn every_scenario_has_a_card() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            let p = preview(&s, key);
            assert!(!p.live.is_empty() && p.live.details.is_some(), "{key}");
        }
        let first = preview(&s, MANIFEST.scenarios[0].0);
        assert_eq!(preview(&s, "nope").live, first.live);
        assert_eq!(preview(&s, "").game, first.game);
        assert_eq!(
            first.live.details.as_deref(),
            Some("Exploring Great Britain")
        );
        assert_eq!(
            preview(&s, "fh6").live.details.as_deref(),
            Some("Exploring Japan")
        );
        assert_eq!(
            preview(&s, "race").live.details.as_deref(),
            Some("Racing, P2")
        );
        assert_eq!(preview(&s, "unknown_car").live.state, None);
    }

    #[test]
    fn long_and_unknown_cars() {
        let mut cars = HashMap::new();
        cars.insert(1, "2023 Dodge Challenger SRT Demon 170");
        let s = Shown {
            car_ordinal: 1,
            car_class: 7,
            car_pi: 999,
            race_position: 0,
        };
        let live = build(Game::Fh6, &s, &cars).unwrap();
        assert_eq!(live.details.as_deref(), Some("Exploring Japan"));
        assert_eq!(
            live.state.as_deref(),
            Some("2023 Dodge Challenger... | X (999)")
        );
        assert_eq!(
            live.large_text.as_deref(),
            Some("2023 Dodge Challenger SRT Demon 170 | X (999)")
        );

        let s = Shown {
            car_ordinal: 2,
            ..s
        };
        let live = build(Game::Fh6, &s, &cars).unwrap();
        assert_eq!(live.state, None);
        assert_eq!(live.details.as_deref(), Some("Exploring Japan"));
    }
}
