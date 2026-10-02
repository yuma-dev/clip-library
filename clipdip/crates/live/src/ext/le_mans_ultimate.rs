//! Session, track and car from LMU_Data. Ported from pyLMUSharedMemory by Xiang
//! and Tony Whitley (MIT), https://github.com/TinyPedal/pyLMUSharedMemory: lmu_data.py

use crate::util::shm::{self, cstr_at, i32_at};
use crate::util::{art, clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use std::time::Duration;
pub static MANIFEST: Manifest = Manifest {
    id: "le_mans_ultimate",
    name: "Le Mans Ultimate",
    blurb: "Shows the session, track and position.",
    setup: None,
    credits: &[Credit {
        project: "pyLMUSharedMemory",
        author: "Xiang and Tony Whitley",
        url: "https://github.com/TinyPedal/pyLMUSharedMemory",
        license: "MIT",
    }],
    options: &[
        Opt::toggle(
            "show_position",
            "Show position",
            "Your position and lap in races.",
            true,
        ),
        Opt::toggle("show_car", "Show car", "The car you drive.", true),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &["1209590320493494353"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/2399420/header.jpg"),
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

const APP: &str = "2399420";
const MAP: &str = "LMU_Data";
const SCORING: usize = 1632;
const VEHICLES: usize = SCORING + 560;
const STRIDE: usize = 584;
const READ_LEN: usize = VEHICLES + 104 * STRIDE;
const EXTRA_OPTION: &str = "show_car";
fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || t.steam_appid.as_deref() == Some(APP)
        || exe_name(t) == "le mans ultimate.exe"
}
fn parse(b: &[u8]) -> Option<State> {
    if b.len() < READ_LEN {
        return None;
    }
    let location = *b.get(96)?;
    if location == 0 {
        return Some(State {
            menu: true,
            ..State::default()
        });
    }
    if location == 1 || location > 3 {
        return None;
    }
    let cars = i32_at(b, SCORING + 104)?;
    if !(1..=104).contains(&cars) {
        return None;
    }
    let player = (0..cars as usize)
        .map(|i| VEHICLES + i * STRIDE)
        .find(|&at| b.get(at + 196) == Some(&1))?;
    let completed = i16::from_le_bytes(b.get(player + 100..player + 102)?.try_into().ok()?);
    let session = match i32_at(b, SCORING + 64)? {
        0..=4 => 0,
        5..=8 => 1,
        9 => 3,
        10..=13 => 2,
        _ => return None,
    };
    Some(State {
        session,
        track: cstr_at(b, SCORING, 64)?,
        extra: cstr_at(b, player + 36, 64)?,
        cars: cars as u32,
        position: *b.get(player + 199)? as u32,
        lap: completed.max(0) as u32 + 1,
        laps: i32_at(b, SCORING + 84)?.max(0) as u32,
        garage: location != 3 || b.get(player + 507) == Some(&1),
        ..State::default()
    })
}
fn sample() -> State {
    State {
        session: 2,
        track: "Le Mans".into(),
        extra: "Ferrari 499P".into(),
        position: 4,
        cars: 32,
        lap: 12,
        laps: 0,
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
    fn scoring_layout() {
        let mut b = vec![0; READ_LEN];
        b[96] = 3;
        put(&mut b, SCORING + 104, 2);
        put(&mut b, SCORING + 64, 10);
        b[SCORING..SCORING + 7].copy_from_slice(b"Le Mans");
        let p = VEHICLES + STRIDE;
        b[p + 196] = 1;
        b[p + 199] = 3;
        b[p + 36..p + 48].copy_from_slice(b"Ferrari 499P");
        b[p + 100..p + 102].copy_from_slice(&11i16.to_le_bytes());
        b[p + 4..p + 11].copy_from_slice(b"Private");
        let s = parse(&b).unwrap();
        assert_eq!(s.lap, 12);
        assert_eq!(s.position, 3);
        let live = build(&s, &settings()).unwrap();
        assert!(!live.competing);
        assert!(!format!("{live:?}").contains("Private"));
        put(&mut b, SCORING + 104, 105);
        assert!(parse(&b).is_none());
        b[96] = 0;
        assert!(parse(&b).unwrap().menu);
    }
}
