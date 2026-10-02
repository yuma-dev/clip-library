//! Session, circuit and position from F1 24/25 UDP telemetry. Layout from EA's
//! official UDP specifications (docs), and mini-sector/f1-packets by Ben-Lukas
//! Thornton (MIT), https://github.com/mini-sector/f1-packets: packets/session,
//! packets/lap_data.rs and enums/track.rs. Player names are never decoded.

use crate::util::{art, clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use std::net::UdpSocket;
use std::time::{Duration, Instant};

pub static MANIFEST: Manifest = Manifest {
    id: "f1", name: "F1 24 and 25", blurb: "Shows the session, circuit, race position and lap.",
    setup: Some("In Telemetry Settings, turn on UDP telemetry with IP 127.0.0.1, port 20777 and format 2024 or 2025. Turn off UDP broadcast."),
    credits: &[
        Credit { project: "f1-packets", author: "Ben-Lukas Thornton", url: "https://github.com/mini-sector/f1-packets", license: "MIT" },
        Credit { project: "F1 24 and 25 UDP specifications", author: "Electronic Arts", url: "https://forums.ea.com/blog/f1-games-game-info-hub-en/ea-sports%E2%84%A2-f1%C2%AE25-udp-specification/12187347", license: "docs" },
    ], options: &[Opt::toggle("show_position", "Show position", "Your position and lap.", true),
        Opt::toggle("show_track", "Show circuit", "The circuit name next to the session.", true)],
    matches, run, priority:10, game_ids:&["1376968272905371698","1245104458417967184"],
    art:Some("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3059520/76dc8ac45f1bd6dec26e04434ca1c8814e7bb330/header.jpg"),
    preview, scenarios:&[("menu","In the menus"),("practice","Practice"),("qualifying","Qualifying"),("race","Race"),("time_trial","Time trial")],
    steam_game:true, listed:true,
};
fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || matches!(t.steam_appid.as_deref(), Some("2488620" | "3059520"))
        || matches!(exe_name(t).as_str(), "f1_24.exe" | "f1_25.exe")
}
#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct State {
    uid: Option<u64>,
    session: Option<u8>,
    track: i8,
    total_laps: u8,
    paused: bool,
    spectating: bool,
    position: u8,
    lap: u8,
    cars: u8,
    ended: bool,
}
#[derive(Debug, PartialEq)]
enum Data {
    Session {
        kind: u8,
        track: i8,
        laps: u8,
        paused: bool,
        spectating: bool,
    },
    Lap {
        position: u8,
        lap: u8,
        cars: u8,
    },
    Start,
    End,
}
fn decode(b: &[u8]) -> Option<(u64, Data)> {
    let format = u16::from_le_bytes(b.get(0..2)?.try_into().ok()?);
    if !matches!(format, 2024 | 2025) || *b.get(5)? != 1 {
        return None;
    }
    let uid = u64::from_le_bytes(b.get(7..15)?.try_into().ok()?);
    let data = match *b.get(6)? {
        1 => {
            if b.len() != 753 {
                return None;
            }
            let kind = *b.get(35)?;
            let track = *b.get(36)? as i8;
            if kind > 18 || track < -1 || *b.get(43)? > 1 || *b.get(44)? > 1 {
                return None;
            }
            Data::Session {
                kind,
                track,
                laps: *b.get(32)?,
                paused: *b.get(43)? == 1,
                spectating: *b.get(44)? == 1,
            }
        }
        2 => {
            if b.len() != 1285 {
                return None;
            }
            let player = *b.get(27)? as usize;
            if player >= 22 {
                return None;
            }
            let at = 29 + 57 * player;
            let result = *b.get(at + 45)?;
            if result > 7 {
                return None;
            }
            let valid = result >= 2;
            let position = if valid { *b.get(at + 32)? } else { 0 };
            if position > 22 {
                return None;
            }
            let cars = (0..22)
                .filter(|i| matches!(b.get(29 + 57 * i + 45), Some(2..=7)))
                .count() as u8;
            Data::Lap {
                position,
                lap: if valid { *b.get(at + 33)? } else { 0 },
                cars,
            }
        }
        3 => {
            if b.len() != 45 {
                return None;
            }
            match b.get(29..33)? {
                b"SSTA" => Data::Start,
                b"SEND" => Data::End,
                _ => return None,
            }
        }
        _ => return None,
    };
    Some((uid, data))
}
impl State {
    fn apply(&mut self, uid: u64, data: Data) {
        if self.uid != Some(uid) {
            *self = State {
                uid: Some(uid),
                track: -1,
                ..State::default()
            };
        }
        match data {
            Data::Session {
                kind,
                track,
                laps,
                paused,
                spectating,
            } => {
                if self.session != Some(kind) || self.track != track {
                    self.position = 0;
                    self.lap = 0;
                    self.cars = 0;
                }
                self.session = Some(kind);
                self.track = track;
                self.total_laps = laps;
                self.paused = paused;
                self.spectating = spectating;
                self.ended = false;
            }
            Data::Lap {
                position,
                lap,
                cars,
            } => {
                if !self.ended {
                    self.position = position;
                    self.lap = lap;
                    self.cars = cars;
                }
            }
            Data::Start => {
                *self = State {
                    uid: Some(uid),
                    track: -1,
                    ..State::default()
                }
            }
            Data::End => {
                *self = State {
                    uid: Some(uid),
                    ended: true,
                    track: -1,
                    ..State::default()
                }
            }
        }
    }
}
fn track_name(id: i8) -> Option<&'static str> {
    Some(match id {
        0 => "Melbourne",
        1 => "Paul Ricard",
        2 => "Shanghai",
        3 => "Sakhir",
        4 => "Barcelona",
        5 => "Monaco",
        6 => "Montreal",
        7 => "Silverstone",
        8 => "Hockenheim",
        9 => "Hungaroring",
        10 => "Spa-Francorchamps",
        11 => "Monza",
        12 => "Singapore",
        13 => "Suzuka",
        14 => "Abu Dhabi",
        15 => "Austin",
        16 => "Interlagos",
        17 => "Austria",
        18 => "Sochi",
        19 => "Mexico City",
        20 => "Baku",
        21 => "Sakhir short",
        22 => "Silverstone short",
        23 => "Austin short",
        24 => "Suzuka short",
        25 => "Hanoi",
        26 => "Zandvoort",
        27 => "Imola",
        28 => "Portimao",
        29 => "Jeddah",
        30 => "Miami",
        31 => "Las Vegas",
        32 => "Lusail",
        39 => "Silverstone reverse",
        40 => "Austria reverse",
        41 => "Zandvoort reverse",
        _ => return None,
    })
}
fn image(app: &str) -> String {
    if app == "3059520" {
        "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3059520/76dc8ac45f1bd6dec26e04434ca1c8814e7bb330/header.jpg".into()
    } else {
        art::steam_header(app)
    }
}
fn build(s: &State, settings: &Settings, app: &str) -> Live {
    let Some(kind) = s.session.filter(|k| *k != 0) else {
        return Live {
            details: clamp("In the menus"),
            large_image: Some(image(app)),
            ..Live::default()
        };
    };
    let label = if s.spectating {
        "Spectating"
    } else {
        match kind {
            1..=4 => "Practice",
            5..=9 => "Qualifying",
            10..=14 => "Sprint qualifying",
            15..=17 => "Race",
            18 => "Time trial",
            _ => "On track",
        }
    };
    let track = track_name(s.track);
    let mut parts = Vec::new();
    if s.paused {
        parts.push("Paused".into());
    }
    if !s.spectating && settings.flag("show_position") {
        if s.position > 0 && kind != 18 {
            parts.push(if s.cars >= s.position {
                format!("P{} of {}", s.position, s.cars)
            } else {
                format!("P{}", s.position)
            });
        }
        if s.lap > 0 && (15..=17).contains(&kind) {
            parts.push(if s.total_laps > 0 {
                format!("Lap {}/{}", s.lap.min(s.total_laps), s.total_laps)
            } else {
                format!("Lap {}", s.lap)
            });
        }
    }
    Live {
        details: clamp(if settings.flag("show_track") {
            track
                .map(|t| format!("{label} - {t}"))
                .unwrap_or_else(|| label.into())
        } else {
            label.into()
        }),
        state: clamp(parts.join(" - ")),
        large_image: Some(image(app)),
        large_text: track.and_then(clamp),
        ..Live::default()
    }
}
fn preview(settings: &Settings, scenario: &str) -> Preview {
    let kind = match scenario {
        "practice" => Some(1),
        "qualifying" => Some(5),
        "race" => Some(15),
        "time_trial" => Some(18),
        _ => None,
    };
    let state = State {
        session: kind,
        track: 7,
        position: 4,
        lap: 12,
        cars: 20,
        total_laps: 26,
        ..State::default()
    };
    Preview {
        game: "F1 25",
        icon: None,
        live: build(&state, settings, "3059520"),
    }
}
fn run(ctx: &Ctx) {
    let app = if ctx.target().game_id == "1245104458417967184"
        || ctx.target().steam_appid.as_deref() == Some("2488620")
        || exe_name(ctx.target()) == "f1_24.exe"
    {
        "2488620"
    } else {
        "3059520"
    };
    while ctx.running() {
        let Ok(socket) = UdpSocket::bind(("127.0.0.1", 20777)) else {
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
        let mut buf = [0u8; 4096];
        let mut state = State::default();
        let mut valid = None;
        let mut emitted = Instant::now() - Duration::from_secs(1);
        while ctx.running() {
            match socket.recv_from(&mut buf) {
                Ok((n, _)) => {
                    if let Some((uid, data)) = decode(buf.get(..n).unwrap_or_default()) {
                        state.apply(uid, data);
                        valid = Some(Instant::now());
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
            if valid.is_some_and(|t| t.elapsed() > Duration::from_secs(5)) {
                state = State::default();
                valid = None;
            }
            if emitted.elapsed() >= Duration::from_secs(1) {
                ctx.emit(valid.map(|_| build(&state, ctx.settings(), app)));
                emitted = Instant::now();
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn packet(format: u16, id: u8, len: usize) -> Vec<u8> {
        let mut b = vec![0; len];
        b[0..2].copy_from_slice(&format.to_le_bytes());
        b[5] = 1;
        b[6] = id;
        b[7..15].copy_from_slice(&42u64.to_le_bytes());
        b
    }
    #[test]
    fn both_formats_and_player_offsets() {
        for format in [2024, 2025] {
            let mut b = packet(format, 1, 753);
            b[35] = 15;
            b[36] = 7;
            b[32] = 26;
            let (uid, data) = decode(&b).unwrap();
            let mut s = State::default();
            s.apply(uid, data);
            let mut lap = packet(format, 2, 1285);
            lap[27] = 3;
            let at = 29 + 57 * 3;
            lap[at + 32] = 4;
            lap[at + 33] = 12;
            lap[at + 45] = 2;
            let (uid, data) = decode(&lap).unwrap();
            s.apply(uid, data);
            assert_eq!(s.position, 4);
            assert_eq!(s.lap, 12);
            lap[27] = 255;
            assert!(decode(&lap).is_none());
            assert!(decode(&b[..752]).is_none());
            b[0..2].copy_from_slice(&2023u16.to_le_bytes());
            assert!(decode(&b).is_none());
        }
    }
    #[test]
    fn resets_session_and_end() {
        let mut s = State {
            uid: Some(42),
            session: Some(15),
            lap: 12,
            position: 4,
            ..State::default()
        };
        s.apply(
            43,
            Data::Lap {
                position: 2,
                lap: 1,
                cars: 20,
            },
        );
        assert_eq!(s.session, None);
        s.apply(43, Data::End);
        assert_eq!(s.position, 0);
        assert!(s.ended);
        let mut b = packet(2025, 3, 45);
        b[29..33].copy_from_slice(b"SEND");
        assert_eq!(decode(&b).unwrap().1, Data::End);
        let mut unknown = packet(2025, 4, 1284);
        unknown[29..36].copy_from_slice(b"Private");
        assert!(decode(&unknown).is_none());
    }
    #[test]
    fn previews_and_options() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(preview(&s, key).live.details.is_some());
            assert!(!preview(&s, key).live.competing);
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        assert_eq!(
            preview(&s, "race").live.state.as_deref(),
            Some("P4 of 20 - Lap 12/26")
        );
        let off = Settings::new(&MANIFEST, serde_json::json!({"show_position":false}));
        assert_ne!(
            preview(&off, "race").live.state,
            preview(&s, "race").live.state
        );
        assert_eq!(track_name(39), Some("Silverstone reverse"));
        assert_eq!(track_name(-1), None);
    }
}
