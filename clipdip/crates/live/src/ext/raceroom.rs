//! Session and position from RaceRoom telemetry. Ported from r3e-api by KW Studios
//! (Unlicense), https://github.com/kwstudios/r3e-api: sample-c/src/r3e.h

use crate::util::shm::{self, cstr_at, i32_at};
use crate::util::{art, clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use std::time::Duration;
pub static MANIFEST: Manifest = Manifest {
    id: "raceroom",
    name: "RaceRoom Racing Experience",
    blurb: "Shows the session, track and position.",
    setup: None,
    credits: &[Credit {
        project: "r3e-api",
        author: "KW Studios",
        url: "https://github.com/kwstudios/r3e-api",
        license: "Unlicense",
    }],
    options: &[
        Opt::toggle(
            "show_position",
            "Show position",
            "Your position and lap in races.",
            true,
        ),
        Opt::toggle(
            "show_layout",
            "Show layout",
            "The current track layout.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &["474431535291039754"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/211500/header.jpg"),
    preview,
    scenarios: &[
        ("menu", "In the menus"),
        ("practice", "Practice"),
        ("qualifying", "Qualifying"),
        ("race", "Race"),
    ],
    steam_game: true,
    listed: true,
};

const APP: &str = "211500";
const MAP: &str = "$R3E";
const READ_LEN: usize = 2012;
const EXTRA_OPTION: &str = "show_layout";
fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || t.steam_appid.as_deref() == Some(APP)
        || matches!(exe_name(t).as_str(), "rrre.exe" | "rrre64.exe")
}
fn parse(b: &[u8]) -> Option<State> {
    if b.len() < READ_LEN || i32_at(b, 0)? != 3 || i32_at(b, 4)? != 5 || i32_at(b, 8)? != 2008 {
        return None;
    }
    if i32_at(b, 24)? != 0 {
        return Some(State {
            menu: true,
            ..State::default()
        });
    }
    let cars = i32_at(b, 2008)?;
    if !(0..=128).contains(&cars) {
        return None;
    }
    let completed = i32_at(b, 1028)?;
    Some(State {
        session: i32_at(b, 780)?,
        track: cstr_at(b, 600, 64)?,
        extra: cstr_at(b, 664, 64)?,
        cars: cars as u32,
        position: i32_at(b, 988)?.max(0) as u32,
        lap: if completed < 0 {
            0
        } else {
            completed as u32 + 1
        },
        laps: i32_at(b, 812)?.max(0) as u32,
        garage: i32_at(b, 36)? != 0,
        replay: i32_at(b, 28)? != 0,
        ranked: i32_at(b, 16)? == 6,
        ..State::default()
    })
}
fn sample() -> State {
    State {
        session: 2,
        track: "Hockenheimring".into(),
        extra: "Grand Prix".into(),
        position: 3,
        cars: 24,
        lap: 6,
        laps: 12,
        ranked: true,
        ..State::default()
    }
}

#[derive(Default, Debug, PartialEq)]
struct State {
    menu: bool,
    session: i32,
    track: String,
    extra: String,
    position: u32,
    cars: u32,
    lap: u32,
    laps: u32,
    garage: bool,
    replay: bool,
    ranked: bool,
}
fn build(s: &State, settings: &Settings) -> Option<Live> {
    if s.menu {
        return Some(Live {
            details: clamp("In the menus"),
            large_image: Some(art::steam_header(APP)),
            ..Live::default()
        });
    }
    if s.track.trim().is_empty() {
        return None;
    }
    let label = if s.replay {
        "Watching a replay"
    } else {
        match s.session {
            0 => "Practice",
            1 => "Qualifying",
            2 => "Race",
            3 => "Warmup",
            _ => "On track",
        }
    };
    let mut parts = Vec::new();
    if settings.flag(EXTRA_OPTION) && !s.extra.is_empty() {
        parts.push(s.extra.clone());
    }
    if s.garage {
        parts.push("In the garage".into());
    }
    if !s.replay && !s.garage && settings.flag("show_position") {
        if s.position > 0 {
            parts.push(if s.cars >= s.position {
                format!("P{} of {}", s.position, s.cars)
            } else {
                format!("P{}", s.position)
            });
        }
        if s.session == 2 && s.lap > 0 {
            parts.push(if s.laps > 0 {
                format!("Lap {}/{}", s.lap.min(s.laps), s.laps)
            } else {
                format!("Lap {}", s.lap)
            });
        }
    }
    Some(Live {
        details: clamp(format!("{label} - {}", s.track)),
        state: clamp(parts.join(" - ")),
        large_image: Some(art::steam_header(APP)),
        large_text: clamp(&s.track),
        competing: s.ranked && s.session == 2 && !s.garage && !s.replay,
        ..Live::default()
    })
}
fn preview(settings: &Settings, scenario: &str) -> Preview {
    let s = match scenario {
        "practice" => State {
            session: 0,
            ..sample()
        },
        "qualifying" => State {
            session: 1,
            ..sample()
        },
        "race" => sample(),
        _ => State {
            menu: true,
            ..State::default()
        },
    };
    Preview {
        game: MANIFEST.name,
        icon: None,
        live: build(&s, settings).unwrap_or_default(),
    }
}
fn run(ctx: &Ctx) {
    while ctx.running() {
        let live = shm::read(MAP, READ_LEN)
            .and_then(|b| parse(&b))
            .and_then(|s| build(&s, ctx.settings()));
        let idle = live.is_none();
        ctx.emit(live);
        if !ctx.sleep(Duration::from_secs(if idle { 10 } else { 3 })) {
            return;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> Settings {
        Settings::new(&MANIFEST, serde_json::json!({}))
    }
    fn put(b: &mut [u8], at: usize, v: i32) {
        b[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }
    #[test]
    fn scenarios_and_settings() {
        let s = settings();
        for (key, _) in MANIFEST.scenarios {
            assert!(preview(&s, key).live.details.is_some());
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        let off = Settings::new(&MANIFEST, serde_json::json!({"show_position": false}));
        assert_ne!(
            preview(&s, "race").live.state,
            preview(&off, "race").live.state
        );
        assert!(preview(&s, "race").live.playtime.is_none());
        assert!(!preview(&s, "menu").live.competing);
    }
    #[test]
    fn malformed_and_privacy() {
        for n in [0, 4, 64, READ_LEN / 2, READ_LEN - 1] {
            assert!(parse(&vec![0; n]).is_none());
        }
        let s = State {
            replay: true,
            ranked: true,
            ..sample()
        };
        assert!(!build(&s, &settings()).unwrap().competing);
        assert!(
            !build(
                &State {
                    garage: true,
                    ranked: true,
                    ..sample()
                },
                &settings()
            )
            .unwrap()
            .competing
        );
    }
    #[test]
    fn api_version_and_ranked_mode() {
        let mut b = vec![0; READ_LEN];
        put(&mut b, 0, 3);
        put(&mut b, 4, 5);
        put(&mut b, 8, 2008);
        put(&mut b, 780, 2);
        put(&mut b, 16, 6);
        put(&mut b, 988, 3);
        put(&mut b, 1028, 5);
        put(&mut b, 2008, 24);
        b[600..606].copy_from_slice(b"Suzuka");
        b[1196..1203].copy_from_slice(b"Private");
        let s = parse(&b).unwrap();
        assert_eq!(s.lap, 6);
        let live = build(&s, &settings()).unwrap();
        assert!(live.competing);
        assert!(!format!("{live:?}").contains("Private"));
        put(&mut b, 16, 5);
        assert!(!build(&parse(&b).unwrap(), &settings()).unwrap().competing);
        put(&mut b, 4, 6);
        assert!(parse(&b).is_none());
    }
}
