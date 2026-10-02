//! Session, track, car and position from iRacing's telemetry shared memory. Layout from the iRacing
//! SDK as read by iracing-telem by Simon Fell (BSD-3-Clause), https://github.com/superfell/iracing-telem:
//! src/lib.rs, and pyirsdk by Mihail Latyshov (MIT), https://github.com/kutu/pyirsdk: irsdk.py
//! (header and var layout, the UTF8 marker, session states).

use std::time::Duration;

use crate::util::shm::{self, cstr_at, f32_at, f64_at, i32_at};
use crate::util::{clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "iracing",
    name: "iRacing",
    blurb: "Shows the session and track, your car and your position.",
    setup: None,
    credits: &[
        Credit {
            project: "iracing-telem",
            author: "Simon Fell",
            url: "https://github.com/superfell/iracing-telem",
            license: "BSD-3-Clause",
        },
        Credit {
            project: "pyirsdk",
            author: "Mihail Latyshov",
            url: "https://github.com/kutu/pyirsdk",
            license: "MIT",
        },
    ],
    options: &[
        Opt::toggle(
            "show_car",
            "Show car",
            "The car you drive, on the second line.",
            true,
        ),
        Opt::toggle(
            "show_position",
            "Show position",
            "Your place in the session and the lap in races.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &["454810317705314334", "1164997420145459210"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/266410/library_hero.jpg"),
    preview,
    scenarios: &[
        ("menu", "In the menus"),
        ("practice", "Practice"),
        ("qualifying", "Qualifying"),
        ("race", "Official race"),
        ("garage", "In the garage"),
        ("replay", "Watching a replay"),
    ],
    steam_game: true,
    listed: true,
};

const MAP: &str = "Local\\IRSDKMemMapFileName";
const HEADER_LEN: usize = 112;
const VAR_HEADER_LEN: usize = 144;
// pyirsdk maps 1164 KiB; anything far past that is a bad header
const MAX_LEN: usize = 8 << 20;
const STATUS_CONNECTED: i32 = 1;

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || t.steam_appid.as_deref() == Some("266410")
        || matches!(
            exe_name(t).as_str(),
            "iracingsim64dx11.exe" | "iracingsim64.exe" | "iracingsim.exe"
        )
}

/// The parts of the session info YAML the card uses.
#[derive(Clone, Debug, Default, PartialEq)]
struct Info {
    track: String,
    track_config: String,
    official: bool,
    series: String,
    sessions: Vec<Session>,
    car: String,
    /// entries without the pace car and spectators
    cars: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Session {
    num: i32,
    kind: String,
    /// None for "unlimited"
    laps: Option<u32>,
}

/// Telemetry vars from the newest buffer.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Tel {
    session_num: i32,
    position: i32,
    lap: i32,
    on_track: bool,
    replay: bool,
    session_state: i32,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Practice,
    Qualifying,
    Race,
    Warmup,
    Testing,
    TimeTrial,
    Other,
}

impl Kind {
    // SessionType values seen: Practice, Open Qualify, Lone Qualify, Warmup, Race, Offline Testing, Time Trial
    fn of(s: &str) -> Kind {
        let s = s.to_ascii_lowercase();
        if s.contains("qualify") {
            Kind::Qualifying
        } else if s.contains("race") {
            Kind::Race
        } else if s.contains("practice") {
            Kind::Practice
        } else if s.contains("warmup") {
            Kind::Warmup
        } else if s.contains("testing") {
            Kind::Testing
        } else if s.contains("time trial") {
            Kind::TimeTrial
        } else {
            Kind::Other
        }
    }

    fn label(self) -> &'static str {
        match self {
            Kind::Practice => "Practice",
            Kind::Qualifying => "Qualifying",
            Kind::Race => "Race",
            Kind::Warmup => "Warmup",
            Kind::Testing => "Test drive",
            Kind::TimeTrial => "Time trial",
            Kind::Other => "On track",
        }
    }
}

/// Lines under a top level `Key:` up to the next top level key.
fn section<'a>(yaml: &'a str, key: &str) -> Vec<&'a str> {
    let head = format!("{key}:");
    let mut lines = yaml.lines();
    for l in lines.by_ref() {
        if l.trim_end() == head {
            break;
        }
    }
    lines
        .take_while(|l| l.is_empty() || l.starts_with(' '))
        .collect()
}

/// First `key: value` in these lines, list dashes and quotes stripped.
fn value<'a>(lines: &[&'a str], key: &str) -> Option<&'a str> {
    lines.iter().find_map(|l| {
        let t = l.trim_start();
        let t = t.strip_prefix("- ").unwrap_or(t);
        let rest = t.strip_prefix(key)?.strip_prefix(':')?;
        Some(rest.trim().trim_matches('"'))
    })
}

/// The items of the list under `key:`, each as its lines.
fn items<'a>(lines: &[&'a str], key: &str) -> Vec<Vec<&'a str>> {
    let head = format!("{key}:");
    let Some(start) = lines.iter().position(|l| l.trim() == head) else {
        return Vec::new();
    };
    let indent = |l: &str| l.len() - l.trim_start().len();
    let base = lines.get(start).map(|l| indent(l)).unwrap_or(0);
    let mut out: Vec<Vec<&str>> = Vec::new();
    for l in lines.iter().skip(start + 1) {
        if l.trim().is_empty() {
            continue;
        }
        let i = indent(l);
        let dash = l.trim_start().starts_with("- ");
        if i < base || (i == base && !dash) {
            break;
        }
        if i == base && dash {
            out.push(vec![l]);
        } else if let Some(cur) = out.last_mut() {
            cur.push(l);
        }
    }
    out
}

fn parse_info(yaml: &str) -> Info {
    let weekend = section(yaml, "WeekendInfo");
    let num = |v: Option<&str>| v.and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    let sessions = items(&section(yaml, "SessionInfo"), "Sessions")
        .iter()
        .map(|s| Session {
            num: num(value(s, "SessionNum")) as i32,
            kind: value(s, "SessionType").unwrap_or_default().to_string(),
            laps: value(s, "SessionLaps").and_then(|v| v.parse().ok()),
        })
        .collect();
    let drivers_section = section(yaml, "DriverInfo");
    let me = value(&drivers_section, "DriverCarIdx").map(str::to_string);
    let drivers = items(&drivers_section, "Drivers");
    let car = drivers
        .iter()
        .find(|d| value(d, "CarIdx").map(str::to_string) == me)
        .and_then(|d| value(d, "CarScreenName"))
        .unwrap_or_default()
        .to_string();
    let cars = drivers
        .iter()
        .filter(|d| num(value(d, "CarIsPaceCar")) == 0 && num(value(d, "IsSpectator")) == 0)
        .count() as u32;
    Info {
        track: value(&weekend, "TrackDisplayName")
            .unwrap_or_default()
            .to_string(),
        track_config: value(&weekend, "TrackConfigName")
            .unwrap_or_default()
            .to_string(),
        official: num(value(&weekend, "Official")) == 1,
        series: value(&weekend, "SeriesName")
            .map(str::to_string)
            .unwrap_or_else(|| {
                let id = num(value(&weekend, "SeriesID"));
                if id > 0 {
                    format!("Series {id}")
                } else {
                    String::new()
                }
            }),
        sessions,
        car,
        cars,
    }
}

/// The session info string; cp1252 unless the header says UTF8 (newer builds).
fn decode_yaml(raw: &[u8]) -> String {
    let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
    let raw = raw.get(..end).unwrap_or_default();
    if raw.starts_with(b"---\nWeekendInfo:\n Encoding: UTF8") {
        String::from_utf8_lossy(raw).into_owned()
    } else {
        // latin-1 is close enough to cp1252 for names
        raw.iter().map(|&c| c as char).collect()
    }
}

struct Header {
    info_update: i32,
    info_len: usize,
    info_offset: usize,
    num_vars: usize,
    var_offset: usize,
    num_buf: usize,
    buf_len: usize,
}

fn header(b: &[u8]) -> Option<Header> {
    let us = |at| i32_at(b, at).and_then(|v| usize::try_from(v).ok());
    let h = Header {
        info_update: i32_at(b, 12)?,
        info_len: us(16)?,
        info_offset: us(20)?,
        num_vars: us(24)?,
        var_offset: us(28)?,
        // IRSDK_MAX_BUFS is 4
        num_buf: us(32)?,
        buf_len: us(36)?,
    };
    (h.num_vars > 0
        && h.num_vars <= 4096
        && (1..=4).contains(&h.num_buf)
        && h.buf_len > 0
        && h.buf_len <= MAX_LEN
        && h.info_len <= MAX_LEN)
        .then_some(h)
}

impl Header {
    fn needed(&self, b: &[u8]) -> Option<usize> {
        let mut need = self.info_offset.checked_add(self.info_len)?.max(
            self.var_offset
                .checked_add(self.num_vars.checked_mul(VAR_HEADER_LEN)?)?,
        );
        for i in 0..self.num_buf {
            let off = usize::try_from(i32_at(b, 48 + i * 16 + 4)?).ok()?;
            need = need.max(off.checked_add(self.buf_len)?);
        }
        (need <= MAX_LEN).then_some(need)
    }
}

/// Reads the vars the card uses from the buffer with the highest tick count.
fn telemetry(b: &[u8], h: &Header) -> Option<Tel> {
    let buf = (0..h.num_buf)
        .filter_map(|i| Some((i32_at(b, 48 + i * 16)?, i32_at(b, 48 + i * 16 + 4)?)))
        .max_by_key(|(tick, _)| *tick)
        .and_then(|(_, off)| usize::try_from(off).ok())?;
    let mut tel = Tel::default();
    for i in 0..h.num_vars {
        let vh = h.var_offset + i * VAR_HEADER_LEN;
        let Some(name) = cstr_at(b, vh + 16, 32) else {
            continue;
        };
        let (Some(kind), Some(off)) = (i32_at(b, vh), i32_at(b, vh + 4)) else {
            continue;
        };
        let Ok(off) = usize::try_from(off) else {
            continue;
        };
        let size = match kind {
            0 | 1 => 1,
            2..=4 => 4,
            5 => 8,
            _ => continue,
        };
        if off.checked_add(size).is_none_or(|end| end > h.buf_len) {
            continue;
        }
        let Some(at) = buf.checked_add(off) else {
            continue;
        };
        // irsdk var types: 0 char, 1 bool, 2 int, 3 bitfield, 4 float, 5 double
        let int = || match kind {
            2 | 3 => i32_at(b, at),
            4 => f32_at(b, at).map(|f| f as i32),
            5 => f64_at(b, at).map(|f| f as i32),
            _ => b.get(at).map(|&c| c as i32),
        };
        match name.as_str() {
            "SessionState" => tel.session_state = int().unwrap_or(0),
            "SessionNum" => tel.session_num = int().unwrap_or(0),
            "PlayerCarPosition" => tel.position = int().unwrap_or(0),
            "Lap" => tel.lap = int().unwrap_or(0),
            "IsOnTrack" => tel.on_track = int().unwrap_or(0) != 0,
            "IsReplayPlaying" => tel.replay = int().unwrap_or(0) != 0,
            _ => {}
        }
    }
    Some(tel)
}

#[derive(Clone, Copy)]
struct Opts {
    car: bool,
    position: bool,
}

impl Opts {
    fn from(s: &Settings) -> Opts {
        Opts {
            car: s.flag("show_car"),
            position: s.flag("show_position"),
        }
    }
}

fn build(info: &Info, tel: &Tel, o: Opts) -> Option<Live> {
    if info.track.is_empty() {
        return Some(Live {
            details: clamp("In the menus"),
            large_image: Some(crate::util::art::steam_header("266410")),
            ..Live::default()
        });
    }
    let full_track = if info.track_config.is_empty() || info.track.contains(&info.track_config) {
        info.track.clone()
    } else {
        format!("{} - {}", info.track, info.track_config)
    };
    if tel.replay {
        return Some(Live {
            details: clamp("Watching a replay"),
            state: clamp(info.track.as_str()),
            large_image: Some(crate::util::art::steam_header("266410")),
            large_text: clamp(full_track),
            ..Live::default()
        });
    }
    let session = info.sessions.iter().find(|s| s.num == tel.session_num);
    let kind = session.map(|s| Kind::of(&s.kind)).unwrap_or(Kind::Other);
    let mut parts: Vec<String> = Vec::new();
    if !tel.on_track {
        parts.push("In the garage".into());
    } else {
        if o.car && !info.car.is_empty() {
            parts.push(info.car.clone());
        }
        if o.position && tel.position > 0 {
            parts.push(if info.cars > 1 && info.cars >= tel.position as u32 {
                format!("P{} of {}", tel.position, info.cars)
            } else {
                format!("P{}", tel.position)
            });
        }
        if o.position && kind == Kind::Race && tel.lap > 0 {
            parts.push(match session.and_then(|s| s.laps) {
                Some(total) => format!("Lap {}/{}", (tel.lap as u32).min(total), total),
                None => format!("Lap {}", tel.lap),
            });
        }
    }
    Some(Live {
        details: clamp(if info.series.is_empty() {
            format!("{} · {}", kind.label(), info.track)
        } else {
            format!("{} · {} · {}", kind.label(), info.series, info.track)
        }),
        state: clamp(parts.join(" · ")),
        large_image: Some(crate::util::art::steam_header("266410")),
        large_text: clamp(full_track),
        competing: tel.on_track
            && info.official
            && kind == Kind::Race
            && matches!(tel.session_state, 4 | 5),
        ..Live::default()
    })
}

fn sample_info() -> Info {
    Info {
        track: "Lime Rock Park".into(),
        track_config: "Full Course".into(),
        official: true,
        series: String::new(),
        sessions: vec![
            Session {
                num: 0,
                kind: "Practice".into(),
                laps: None,
            },
            Session {
                num: 1,
                kind: "Lone Qualify".into(),
                laps: Some(2),
            },
            Session {
                num: 2,
                kind: "Race".into(),
                laps: Some(15),
            },
        ],
        car: "Mazda MX-5 Cup".into(),
        cars: 20,
    }
}

fn preview(settings: &Settings, scenario: &str) -> Preview {
    let tel = |session_num, position, lap, on_track, replay| Tel {
        session_num,
        position,
        lap,
        on_track,
        replay,
        session_state: 4,
    };
    let t = match scenario {
        "qualifying" => tel(1, 6, 2, true, false),
        "race" => tel(2, 4, 7, true, false),
        "garage" => tel(0, 0, 0, false, false),
        "replay" => tel(2, 4, 15, false, true),
        "practice" => tel(0, 11, 5, true, false),
        _ => tel(0, 0, 0, false, false),
    };
    let info = if MANIFEST
        .scenarios
        .iter()
        .skip(1)
        .any(|(key, _)| *key == scenario)
    {
        sample_info()
    } else {
        Info::default()
    };
    let live = build(&info, &t, Opts::from(settings)).unwrap_or_default();
    Preview {
        game: "iRacing",
        icon: None,
        live,
    }
}

fn run(ctx: &Ctx) {
    let mut info: Option<(i32, Info)> = None;
    while ctx.running() {
        let live = poll(&mut info, Opts::from(ctx.settings()));
        let idle = live.is_none();
        if idle {
            info = None;
        }
        ctx.emit(live);
        // the mapping only exists while the sim runs a session
        if !ctx.sleep(Duration::from_secs(if idle { 10 } else { 3 })) {
            return;
        }
    }
}

fn poll(info: &mut Option<(i32, Info)>, o: Opts) -> Option<Live> {
    let head = shm::read(MAP, HEADER_LEN)?;
    if i32_at(&head, 4)? & STATUS_CONNECTED == 0 {
        return None;
    }
    let h = header(&head)?;
    let b = shm::read(MAP, h.needed(&head)?)?;
    // the header can move between the two reads, so trust the second copy
    let h = header(&b)?;
    if h.num_vars > 4096 || h.needed(&b)? > b.len() || i32_at(&b, 4)? & STATUS_CONNECTED == 0 {
        return None;
    }
    if info.as_ref().map(|(u, _)| *u) != Some(h.info_update) {
        let raw = b.get(h.info_offset..h.info_offset + h.info_len)?;
        *info = Some((h.info_update, parse_info(&decode_yaml(raw))));
    }
    let tel = telemetry(&b, &h)?;
    build(&info.as_ref()?.1, &tel, o)
}

#[cfg(test)]
mod tests {
    use super::*;

    // session fixture follows the SDK YAML layout; names are synthetic
    const YAML: &str = "---
WeekendInfo:
 TrackName: limerock full
 TrackID: 1
 TrackLength: 2.36 km
 TrackDisplayName: Lime Rock Park
 TrackDisplayShortName: Lime Rock
 TrackConfigName: Full Course
 SeriesID: 135
 LeagueID: 0
 Official: 1
 EventType: Race
 WeekendOptions:
  NumStarters: 20
 TelemetryOptions:
  TelemetryDiskFile: \"\"

SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionLaps: unlimited
   SessionTime: 180.0000 sec
   SessionType: Practice
   SessionName: PRACTICE
   ResultsPositions:
   - Position: 1
     CarIdx: 18
     Lap: 1
 - SessionNum: 1
   SessionLaps: 2
   SessionType: Lone Qualify
   SessionName: QUALIFY
   ResultsPositions:
 - SessionNum: 2
   SessionLaps: 15
   SessionType: Race
   SessionName: RACE
   ResultsPositions:

CameraInfo:
 Groups:
 - GroupNum: 1
   GroupName: Nose

DriverInfo:
 DriverCarIdx: 2
 DriverUserID: 1
 Drivers:
 - CarIdx: 0
   UserName: Pace Car
   CarIsPaceCar: 1
   CarScreenName: Porsche 911 GT3 Cup (991)
   IsSpectator: 0
 - CarIdx: 1
   UserName: Driver A
   CarIsPaceCar: 0
   CarScreenName: Mazda MX-5 Cup
   IsSpectator: 0
 - CarIdx: 2
   UserName: Driver B
   CarIsPaceCar: 0
   CarScreenName: Mazda MX-5 Cup
   IsSpectator: 0
 - CarIdx: 3
   UserName: Driver C
   CarIsPaceCar: 0
   CarScreenName: Mazda MX-5 Cup
   IsSpectator: 1

SplitTimeInfo:
 Sectors:
 - SectorNum: 0
";

    fn opts() -> Opts {
        Opts {
            car: true,
            position: true,
        }
    }

    #[test]
    fn parses_session_info() {
        let info = parse_info(YAML);
        assert_eq!(info.track, "Lime Rock Park");
        assert_eq!(info.track_config, "Full Course");
        assert!(info.official);
        assert_eq!(info.sessions.len(), 3);
        assert_eq!(
            info.sessions[1],
            Session {
                num: 1,
                kind: "Lone Qualify".into(),
                laps: Some(2)
            }
        );
        assert_eq!(info.sessions[0].laps, None);
        assert_eq!(info.car, "Mazda MX-5 Cup");
        assert_eq!(info.cars, 2);
    }

    #[test]
    fn yaml_encodings() {
        let mut raw = b"---\nWeekendInfo:\n TrackDisplayName: N\xfcrburgring\n".to_vec();
        raw.extend_from_slice(&[0, 0, 0]);
        assert!(decode_yaml(&raw).contains("Nürburgring"));
        let utf8 = "---\nWeekendInfo:\n Encoding: UTF8\n TrackDisplayName: Nürburgring\n\0";
        assert!(decode_yaml(utf8.as_bytes()).contains("Nürburgring"));
    }

    // a fake mapping: header, two var headers, one buffer
    fn mapping(position: i32, on_track: bool) -> Vec<u8> {
        let mut b = vec![0u8; 2048];
        let put =
            |b: &mut Vec<u8>, at: usize, v: i32| b[at..at + 4].copy_from_slice(&v.to_le_bytes());
        put(&mut b, 4, 1);
        put(&mut b, 12, 7);
        put(&mut b, 24, 3);
        put(&mut b, 28, 112);
        put(&mut b, 32, 2);
        put(&mut b, 36, 64);
        // buffer 0 is older than buffer 1
        put(&mut b, 48, 10);
        put(&mut b, 52, 600);
        put(&mut b, 64, 11);
        put(&mut b, 68, 700);
        for (i, (name, kind, off)) in [
            ("PlayerCarPosition", 2, 0),
            ("IsOnTrack", 1, 4),
            ("SessionNum", 2, 8),
        ]
        .iter()
        .enumerate()
        {
            let vh = 112 + i * VAR_HEADER_LEN;
            put(&mut b, vh, *kind);
            put(&mut b, vh + 4, *off);
            b[vh + 16..vh + 16 + name.len()].copy_from_slice(name.as_bytes());
        }
        put(&mut b, 600, 99);
        put(&mut b, 700, position);
        b[704] = on_track as u8;
        put(&mut b, 708, 2);
        b
    }

    #[test]
    fn reads_newest_buffer() {
        let b = mapping(4, true);
        let h = header(&b).unwrap();
        assert_eq!(h.needed(&b), Some(764));
        let tel = telemetry(&b, &h).unwrap();
        assert_eq!(
            tel,
            Tel {
                session_num: 2,
                position: 4,
                lap: 0,
                on_track: true,
                replay: false,
                session_state: 0
            }
        );
        assert!(header(&b[..20]).is_none());
    }

    #[test]
    fn rejects_bad_header_and_var_offsets() {
        let mut b = mapping(4, true);
        b[24..28].copy_from_slice(&i32::MAX.to_le_bytes());
        assert!(header(&b).is_none());
        b[24..28].copy_from_slice(&3i32.to_le_bytes());
        b[116..120].copy_from_slice(&i32::MAX.to_le_bytes());
        assert_eq!(telemetry(&b, &header(&b).unwrap()).unwrap().position, 0);
        let mut info = parse_info(YAML);
        info.official = false;
        assert!(
            !build(
                &info,
                &Tel {
                    session_num: 2,
                    on_track: true,
                    session_state: 4,
                    ..Tel::default()
                },
                opts()
            )
            .unwrap()
            .competing
        );
        info.official = true;
        assert!(
            !build(
                &info,
                &Tel {
                    session_num: 2,
                    on_track: true,
                    session_state: 3,
                    ..Tel::default()
                },
                opts()
            )
            .unwrap()
            .competing
        );
        assert!(
            build(
                &info,
                &Tel {
                    session_num: 2,
                    on_track: true,
                    session_state: 4,
                    ..Tel::default()
                },
                opts()
            )
            .unwrap()
            .competing
        );
    }
    #[test]
    fn card_text() {
        let info = parse_info(YAML);
        let race = build(
            &info,
            &Tel {
                session_num: 2,
                position: 4,
                lap: 7,
                on_track: true,
                replay: false,
                session_state: 4,
            },
            opts(),
        )
        .unwrap();
        assert_eq!(
            race.details.as_deref(),
            Some("Race · Series 135 · Lime Rock Park")
        );
        assert_eq!(
            race.state.as_deref(),
            Some("Mazda MX-5 Cup · P4 · Lap 7/15")
        );
        assert_eq!(
            race.large_text.as_deref(),
            Some("Lime Rock Park - Full Course")
        );
        assert!(race.competing);

        let practice = build(
            &info,
            &Tel {
                session_num: 0,
                position: 1,
                lap: 3,
                on_track: true,
                replay: false,
                session_state: 4,
            },
            opts(),
        )
        .unwrap();
        assert_eq!(
            practice.details.as_deref(),
            Some("Practice · Series 135 · Lime Rock Park")
        );
        assert_eq!(practice.state.as_deref(), Some("Mazda MX-5 Cup · P1 of 2"));
        assert!(!practice.competing);

        let garage = build(
            &info,
            &Tel {
                session_num: 2,
                ..Tel::default()
            },
            opts(),
        )
        .unwrap();
        assert_eq!(garage.state.as_deref(), Some("In the garage"));
        assert!(!garage.competing);

        let mut unofficial = info.clone();
        unofficial.official = false;
        assert!(
            !build(
                &unofficial,
                &Tel {
                    session_num: 2,
                    position: 1,
                    lap: 1,
                    on_track: true,
                    replay: false,
                    session_state: 4
                },
                opts()
            )
            .unwrap()
            .competing
        );

        assert_eq!(
            build(&Info::default(), &Tel::default(), opts())
                .unwrap()
                .details
                .as_deref(),
            Some("In the menus")
        );
    }

    #[test]
    fn session_kinds() {
        assert_eq!(Kind::of("Open Qualify"), Kind::Qualifying);
        assert_eq!(Kind::of("Offline Testing"), Kind::Testing);
        assert_eq!(Kind::of("Heat Race"), Kind::Race);
        assert_eq!(Kind::of("Time Trial"), Kind::TimeTrial);
    }

    #[test]
    fn matches_ids_and_exes() {
        let t = |id: &str, exe: Option<&str>| Target {
            game_id: id.into(),
            exe: exe.map(Into::into),
            ..Target::default()
        };
        assert!(matches(&t("454810317705314334", None)));
        assert!(matches(&t("1164997420145459210", None)));
        assert!(matches(&t(
            "x",
            Some(r"C:\Program Files (x86)\iRacing\iRacingSim64DX11.exe")
        )));
        assert!(!matches(&t("x", Some(r"C:\iRacing\iRacingUI.exe"))));
    }

    #[test]
    fn previews() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            let p = preview(&s, key);
            assert!(p.live.details.is_some(), "{key}");
        }
        assert_eq!(preview(&s, "nope").live, preview(&s, "menu").live);
        assert!(preview(&s, "race").live.competing);
        let off = Settings::new(
            &MANIFEST,
            serde_json::json!({ "show_car": false, "show_position": false }),
        );
        assert_eq!(
            preview(&s, "race").live.state.as_deref(),
            Some("Mazda MX-5 Cup · P4 of 20 · Lap 7/15")
        );
        assert_eq!(preview(&off, "race").live.state, None);
        let no_car = Settings::new(&MANIFEST, serde_json::json!({ "show_car": false }));
        assert_eq!(
            preview(&no_car, "race").live.state.as_deref(),
            Some("P4 of 20 · Lap 7/15")
        );
    }
}
