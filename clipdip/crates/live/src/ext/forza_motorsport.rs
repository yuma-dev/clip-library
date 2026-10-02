//! Car, track and position from Motorsport Data Out. Packet layout from 1Stalk's
//! Forza Horizon Discord Rich Presence (MIT), adapted to Motorsport Dash offsets:
//! https://github.com/1Stalk/Forza-Horizon-Discord-Rich-Presence: telemetry.rs
//! Ordinals from Szymon Bluma (MIT), https://github.com/bluemanos/forza-motorsport-car-track-ordinal: fm8/*.json

use crate::util::shm::i32_at;
use crate::util::{art, clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use std::collections::HashMap;
use std::net::UdpSocket;
use std::time::{Duration, Instant};

pub static MANIFEST: Manifest = Manifest {
    id: "forza_motorsport", name: "Forza Motorsport", blurb: "Shows your car, track, class and race position.",
    setup: Some("In Settings, Gameplay and HUD, turn on Data Out with IP 127.0.0.1 and port 8001, or the port picked below."),
    credits: &[
        Credit { project: "Forza Horizon Discord Rich Presence", author: "1Stalk", url: "https://github.com/1Stalk/Forza-Horizon-Discord-Rich-Presence", license: "MIT" },
        Credit { project: "Forza Motorsport car and track ordinals", author: "Szymon Bluma", url: "https://github.com/bluemanos/forza-motorsport-car-track-ordinal", license: "MIT" },
    ],
    options: &[
        Opt::choice("port", "Data Out port", "Must match the game. Use another port if a telemetry app already uses 8001.", "8001", &[("8001","8001"),("8002","8002"),("8003","8003"),("9999","9999")]),
        Opt::toggle("show_car", "Show car", "Your car, class and performance index.", true),
        Opt::toggle("show_position", "Show position", "Your race position and lap.", true),
    ], matches, run, priority: 10, game_ids: &["1161181430911598633"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/2440510/header.jpg"),
    preview, scenarios: &[("menu", "In the menus"), ("practice", "Practice (session type unavailable)"), ("qualifying", "Qualifying (session type unavailable)"), ("race", "Racing")], steam_game: true, listed: true,
};
fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || t.steam_appid.as_deref() == Some("2440510")
        || exe_name(t) == "forza_gaming.desktop.x64_release_final.exe"
}
#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct Packet {
    active: bool,
    car: i32,
    class: i32,
    pi: i32,
    position: u8,
    lap: u16,
    track: i32,
}
fn parse(b: &[u8]) -> Option<Packet> {
    // Horizon inserts bytes before Dash; accepting it would misread every race field
    if !matches!(b.len(), 311 | 331) {
        return None;
    }
    let active = i32_at(b, 0)?;
    let car = i32_at(b, 212)?;
    let class = i32_at(b, 216)?;
    let pi = i32_at(b, 220)?;
    if !(0..=1).contains(&active)
        || car < 0
        || !(0..=8).contains(&class)
        || !(0..=9999).contains(&pi)
    {
        return None;
    }
    Some(Packet {
        active: active == 1,
        car,
        class,
        pi,
        position: *b.get(302)?,
        lap: u16::from_le_bytes(b.get(300..302)?.try_into().ok()?),
        track: if b.len() == 331 { i32_at(b, 327)? } else { -1 },
    })
}
fn table(text: &'static str) -> HashMap<i32, &'static str> {
    text.lines()
        .filter_map(|l| {
            let (id, name) = l.split_once('\t')?;
            Some((id.parse().ok()?, name))
        })
        .collect()
}
fn load_cars() -> HashMap<i32, &'static str> {
    let mut cars = super::forza::load_cars();
    cars.extend(table(include_str!("forza_motorsport/cars.tsv")));
    cars
}
fn build(p: &Packet, s: &Settings, cars: &HashMap<i32, &str>, tracks: &HashMap<i32, &str>) -> Live {
    let image = Some(art::steam_header("2440510"));
    if p.car == 0 {
        return Live {
            details: clamp("In the menus"),
            large_image: image,
            ..Live::default()
        };
    }
    let label = if !p.active {
        "Paused"
    } else if p.position > 0 {
        "Racing"
    } else {
        "On track"
    };
    let track = tracks.get(&p.track).copied();
    let mut parts = Vec::new();
    if s.flag("show_car") {
        let car = cars
            .get(&p.car)
            .map(|c| c.to_string())
            .unwrap_or_else(|| "Driving".into());
        let class = match p.class {
            0 => "E",
            1 => "D",
            2 => "C",
            3 => "B",
            4 => "A",
            5 => "S",
            6 => "R",
            7 => "P",
            8 => "X",
            _ => "Unknown",
        };
        parts.push(format!("{car} - {class} ({})", p.pi));
    }
    if p.active && s.flag("show_position") && p.position > 0 {
        parts.push(format!("P{} - Lap {}", p.position, u32::from(p.lap) + 1));
    }
    Live {
        details: clamp(
            track
                .map(|t| format!("{label} - {t}"))
                .unwrap_or_else(|| label.into()),
        ),
        state: clamp(parts.join(" - ")),
        large_image: image,
        large_text: track.and_then(clamp),
        ..Live::default()
    }
}
fn preview(s: &Settings, scenario: &str) -> Preview {
    let p = match scenario {
        "practice" | "qualifying" => Packet {
            active: true,
            car: 2740,
            class: 2,
            pi: 450,
            track: 110,
            ..Packet::default()
        },
        "race" => Packet {
            active: true,
            car: 2740,
            class: 2,
            pi: 450,
            track: 110,
            position: 3,
            lap: 5,
        },
        _ => Packet::default(),
    };
    Preview {
        game: "Forza Motorsport",
        icon: None,
        live: build(
            &p,
            s,
            &load_cars(),
            &table(include_str!("forza_motorsport/tracks.tsv")),
        ),
    }
}
fn run(ctx: &Ctx) {
    let cars = load_cars();
    let tracks = table(include_str!("forza_motorsport/tracks.tsv"));
    let port = ctx.choice("port").parse::<u16>().unwrap_or(8001);
    while ctx.running() {
        let Ok(socket) = UdpSocket::bind(("127.0.0.1", port)) else {
            ctx.emit(None);
            if !ctx.sleep(Duration::from_secs(10)) {
                return;
            }
            continue;
        };
        if socket
            .set_read_timeout(Some(Duration::from_secs(1)))
            .is_err()
        {
            return;
        }
        let mut buf = [0u8; 2048];
        let mut pending = None;
        let mut last_valid = Instant::now();
        let mut emitted = Instant::now() - Duration::from_secs(1);
        while ctx.running() {
            match socket.recv_from(&mut buf) {
                Ok((n, _)) => {
                    if let Some(p) = parse(buf.get(..n).unwrap_or_default()) {
                        pending = Some(p);
                        last_valid = Instant::now();
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => {
                    ctx.emit(None);
                    if !ctx.sleep(Duration::from_secs(10)) {
                        return;
                    }
                    break;
                }
            }
            if last_valid.elapsed() > Duration::from_secs(5) {
                pending = None;
            }
            if emitted.elapsed() >= Duration::from_secs(1) {
                ctx.emit(
                    pending
                        .as_ref()
                        .map(|p| build(p, ctx.settings(), &cars, &tracks)),
                );
                emitted = Instant::now();
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dash_and_extended_offsets() {
        let mut b = vec![0; 331];
        for (at, v) in [(0, 1i32), (212, 2740), (216, 2), (220, 450), (327, 110)] {
            b[at..at + 4].copy_from_slice(&v.to_le_bytes());
        }
        b[300..302].copy_from_slice(&5u16.to_le_bytes());
        b[302] = 3;
        let p = parse(&b).unwrap();
        assert_eq!(p.position, 3);
        assert_eq!(p.lap, 5);
        assert_eq!(p.track, 110);
        let old = parse(&b[..311]).unwrap();
        assert_eq!(old.track, -1);
        assert!(parse(&b[..324]).is_none());
        assert!(parse(&b[..232]).is_none());
        b[0] = 2;
        assert!(parse(&b).is_none());
    }
    #[test]
    fn previews_and_classes() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            let p = preview(&s, key);
            assert!(p.live.details.is_some());
            assert!(!p.live.competing);
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        let off = Settings::new(&MANIFEST, serde_json::json!({"show_car":false}));
        assert_ne!(
            preview(&s, "race").live.state,
            preview(&off, "race").live.state
        );
        assert!(preview(&s, "race").live.state.unwrap().contains("C (450)"));
        assert!(preview(&s, "race")
            .live
            .details
            .unwrap()
            .contains("Barcelona"));
    }
}
