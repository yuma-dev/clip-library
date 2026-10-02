//! Session, track, car and position from the Kunos shared memory of Assetto Corsa, Assetto Corsa
//! Competizione and Assetto Corsa EVO. Layouts from simetry by Adnan Ademovic (MIT),
//! https://github.com/adnanademovic/simetry: src/assetto_corsa*/shared_memory_data.rs, and
//! acevo-shared-memory by Domenico Mancini (MIT), https://github.com/dSyncro/acevo-shared-memory:
//! src/bindings/source/wrapper.hpp. Card logic and the ACC car names from acc-discord-rpc by
//! Manuel Cabral (MIT), https://github.com/manucabral/acc-discord-rpc: accrpc/core.py, constants.py.

use std::time::Duration;

use crate::util::shm::{self, cstr_at, i32_at, u32_at, utf16_at};
use crate::util::{clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "assetto_corsa",
    name: "Assetto Corsa, Competizione and EVO",
    blurb: "Shows the session and track, your car and your position.",
    setup: None,
    credits: &[
        Credit {
            project: "simetry",
            author: "Adnan Ademovic",
            url: "https://github.com/adnanademovic/simetry",
            license: "MIT",
        },
        Credit {
            project: "acevo-shared-memory",
            author: "Domenico Mancini",
            url: "https://github.com/dSyncro/acevo-shared-memory",
            license: "MIT",
        },
        Credit {
            project: "acc-discord-rpc",
            author: "Manuel Cabral",
            url: "https://github.com/manucabral/acc-discord-rpc",
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
    game_ids: &[
        "1124351838666375228",
        "425778010222886912",
        "1440141955794206954",
        "1329495435047600219",
    ],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/805550/library_hero.jpg"),
    preview,
    scenarios: &[
        ("menu", "In the menus"),
        ("practice", "Practice, ACC"),
        ("qualifying", "Qualifying, ACC"),
        ("race", "Race, ACC"),
        ("hotlap", "Hotlap, Assetto Corsa"),
        ("evo", "Race, EVO"),
    ],
    steam_game: true,
    listed: true,
};

#[derive(Clone, Copy, Debug, PartialEq)]
enum Game {
    Ac,
    Acc,
    Evo,
}

impl Game {
    fn of(t: &Target) -> Option<Game> {
        match t.game_id.as_str() {
            "425778010222886912" | "1440141955794206954" => return Some(Game::Ac),
            "1124351838666375228" => return Some(Game::Acc),
            "1329495435047600219" => return Some(Game::Evo),
            _ => {}
        }
        match t.steam_appid.as_deref() {
            Some("244210") => return Some(Game::Ac),
            Some("805550") => return Some(Game::Acc),
            Some("3058630") => return Some(Game::Evo),
            _ => {}
        }
        match exe_name(t).as_str() {
            "acs.exe" | "acs_x86.exe" => Some(Game::Ac),
            "ac2-win64-shipping.exe" => Some(Game::Acc),
            "assettocorsaevo.exe" => Some(Game::Evo),
            _ => None,
        }
    }

    fn app(self) -> &'static str {
        match self {
            Game::Ac => "244210",
            Game::Acc => "805550",
            Game::Evo => "3058630",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Game::Ac => "Assetto Corsa",
            Game::Acc => "Assetto Corsa Competizione",
            Game::Evo => "Assetto Corsa EVO",
        }
    }
}

fn matches(t: &Target) -> bool {
    Game::of(t).is_some()
}

// AC and ACC: SPageFileStatic / SPageFileGraphic, pack(4), wchar_t strings
const AC_STATIC: &str = "Local\\acpmf_static";
const AC_GRAPHICS: &str = "Local\\acpmf_graphics";
const AC_STATIC_LEN: usize = 590;
const AC_GRAPHICS_LEN: usize = 176;
// AC EVO: SPageFileStaticEvo / SPageFileGraphicEvo, pack(4), char strings
const EVO_STATIC: &str = "Local\\acevo_pmf_static";
const EVO_GRAPHICS: &str = "Local\\acevo_pmf_graphics";
const EVO_STATIC_LEN: usize = 208;
const EVO_GRAPHICS_LEN: usize = 3119;

/// AC_STATUS: 0 off (menus), 1 replay, 2 live, 3 pause
#[derive(Clone, Debug, Default, PartialEq)]
struct State {
    status: i32,
    /// AC_SESSION_TYPE, or ACEVO_SESSION_TYPE for EVO
    session: i32,
    /// EVO only, e.g. "Race 1"
    session_name: String,
    track: String,
    config: String,
    car: String,
    position: u32,
    cars: u32,
    /// the lap being driven, 1-based
    lap: u32,
    /// 0 for timed races and open sessions
    laps: u32,
}

fn parse_kunos(stat: &[u8], gfx: &[u8]) -> Option<State> {
    let status = i32_at(gfx, 4)?;
    if !(0..=3).contains(&status) {
        return None;
    }
    let completed = i32_at(gfx, 132)?.max(0) as u32;
    Some(State {
        status: i32_at(gfx, 4)?,
        session: i32_at(gfx, 8)?,
        session_name: String::new(),
        track: utf16_at(stat, 134, 33)?,
        config: utf16_at(stat, 524, 33)?,
        car: utf16_at(stat, 68, 33)?,
        position: i32_at(gfx, 136)?.max(0) as u32,
        cars: i32_at(stat, 64)?.max(0) as u32,
        lap: completed + 1,
        laps: i32_at(gfx, 172)?.max(0) as u32,
    })
}

fn parse_evo(stat: &[u8], gfx: &[u8]) -> Option<State> {
    if !(0..=3).contains(&i32_at(gfx, 4)?) {
        return None;
    }
    Some(State {
        status: i32_at(gfx, 4)?,
        session: i32_at(stat, 32)?,
        session_name: cstr_at(stat, 36, 33)?,
        track: cstr_at(stat, 136, 33)?,
        config: cstr_at(stat, 169, 33)?,
        car: cstr_at(gfx, 3086, 33)?,
        position: u32_at(gfx, 2388)?,
        cars: u32_at(gfx, 2392)?,
        // session_state.current_lap / total_lap
        lap: i32_at(gfx, 2548)?.max(0) as u32,
        laps: i32_at(gfx, 2544)?.max(0) as u32,
    })
}

fn read(game: Game) -> Option<State> {
    match game {
        Game::Evo => parse_evo(
            &shm::read(EVO_STATIC, EVO_STATIC_LEN)?,
            &shm::read(EVO_GRAPHICS, EVO_GRAPHICS_LEN)?,
        ),
        _ => parse_kunos(
            &shm::read(AC_STATIC, AC_STATIC_LEN)?,
            &shm::read(AC_GRAPHICS, AC_GRAPHICS_LEN)?,
        ),
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Practice,
    Qualifying,
    Race,
    Solo(&'static str),
    Unknown,
}

fn kind(game: Game, session: i32) -> Kind {
    match (game, session) {
        // ACEVO_SESSION_TYPE: 0 time attack, 1 race, 2 hot stint, 3 cruise
        (Game::Evo, 0) => Kind::Solo("Time attack"),
        (Game::Evo, 1) => Kind::Race,
        (Game::Evo, 2) => Kind::Solo("Hot stint"),
        (Game::Evo, 3) => Kind::Solo("Cruise"),
        (Game::Evo, _) => Kind::Unknown,
        // AC_SESSION_TYPE, 7 and 8 are ACC only
        (_, 0) => Kind::Practice,
        (_, 1) => Kind::Qualifying,
        (_, 2) => Kind::Race,
        (_, 3) => Kind::Solo("Hotlap"),
        (_, 4) => Kind::Solo("Time attack"),
        (_, 5) => Kind::Solo("Drift"),
        (_, 6) => Kind::Solo("Drag"),
        (_, 7) => Kind::Solo("Hotstint"),
        (_, 8) => Kind::Solo("Superpole"),
        _ => Kind::Unknown,
    }
}

// ACC ids from acc-discord-rpc's CAR_MODEL, a few names tidied
const ACC_CARS: &[(&str, &str)] = &[
    ("amr_v12_vantage_gt3", "Aston Martin V12 Vantage GT3"),
    ("audi_r8_lms", "Audi R8 LMS"),
    (
        "bentley_continental_gt3_2016",
        "Bentley Continental GT3 2015",
    ),
    (
        "bentley_continental_gt3_2018",
        "Bentley Continental GT3 2018",
    ),
    ("bmw_m6_gt3", "BMW M6 GT3"),
    ("jaguar_g3", "Emil Frey Jaguar G3"),
    ("ferrari_488_gt3", "Ferrari 488 GT3"),
    ("ferrari_296_gt3", "Ferrari 296 GT3"),
    ("honda_nsx_gt3", "Honda NSX GT3"),
    ("lamborghini_gallardo_rex", "Reiter Lamborghini Gallardo G3"),
    ("lamborghini_huracan_gt3", "Lamborghini Huracan GT3"),
    (
        "lamborghini_huracan_gt3_evo2",
        "Lamborghini Huracan GT3 EVO2",
    ),
    ("lexus_rc_f_gt3", "Lexus RC F GT3"),
    ("mclaren_650s_gt3", "McLaren 650S GT3"),
    ("mclaren_720s_gt3_evo", "McLaren 720S GT3 Evo"),
    ("mercedes_amg_gt3", "Mercedes-AMG GT3"),
    ("nissan_gt_r_gt3_2017", "Nissan GT-R Nismo GT3 2015"),
    ("nissan_gt_r_gt3_2018", "Nissan GT-R Nismo GT3 2018"),
    ("porsche_991_gt3_r", "Porsche 991 GT3 R"),
    ("porsche_992_gt3_r", "Porsche 992 GT3 R"),
    ("amr_v8_vantage_gt3", "Aston Martin V8 Vantage GT3"),
    ("audi_r8_lms_evo", "Audi R8 LMS Evo"),
    ("audi_r8_lms_evo_ii", "Audi R8 LMS Evo II"),
    ("honda_nsx_gt3_evo", "Honda NSX GT3 Evo"),
    ("lamborghini_huracan_gt3_evo", "Lamborghini Huracan GT3 Evo"),
    ("mclaren_720s_gt3", "McLaren 720S GT3"),
    ("porsche_991ii_gt3_r", "Porsche 991 II GT3 R"),
    ("ferrari_488_gt3_evo", "Ferrari 488 GT3 Evo"),
    ("ferrari_488_challenge_evo", "Ferrari 488 Challenge Evo"),
    ("mercedes_amg_gt3_evo", "Mercedes-AMG GT3 Evo"),
    ("alpine_a110_gt4", "Alpine A110 GT4"),
    ("amr_v8_vantage_gt4", "Aston Martin Vantage AMR GT4"),
    ("audi_r8_gt4", "Audi R8 LMS GT4"),
    ("bmw_m2_cs_racing", "BMW M2 CS Racing"),
    ("bmw_m4_gt4", "BMW M4 GT4"),
    ("bmw_m4_gt3", "BMW M4 GT3"),
    ("chevrolet_camaro_gt4r", "Chevrolet Camaro GT4.R"),
    ("ginetta_g55_gt4", "Ginetta G55 GT4"),
    ("ktm_xbow_gt4", "KTM X-Bow GT4"),
    ("maserati_mc_gt4", "Maserati GranTurismo MC GT4"),
    ("mclaren_570s_gt4", "McLaren 570S GT4"),
    ("mercedes_amg_gt4", "Mercedes-AMG GT4"),
    ("porsche_718_cayman_gt4_mr", "Porsche 718 Cayman GT4 MR"),
    ("porsche_991ii_gt3_cup", "Porsche 991 II GT3 Cup"),
    ("porsche_992_gt3_cup", "Porsche 992 GT3 Cup"),
    ("lamborghini_huracan_st", "Lamborghini Huracan ST"),
    ("lamborghini_huracan_st_evo2", "Lamborghini Huracan ST EVO2"),
];

// ACC track ids as the static page reports them
const ACC_TRACKS: &[(&str, &str)] = &[
    ("barcelona", "Barcelona"),
    ("brands_hatch", "Brands Hatch"),
    ("cota", "Circuit of the Americas"),
    ("donington", "Donington Park"),
    ("hungaroring", "Hungaroring"),
    ("imola", "Imola"),
    ("indianapolis", "Indianapolis"),
    ("kyalami", "Kyalami"),
    ("laguna_seca", "Laguna Seca"),
    ("misano", "Misano"),
    ("monza", "Monza"),
    ("mount_panorama", "Mount Panorama"),
    ("nurburgring", "Nürburgring"),
    ("nurburgring_24h", "Nürburgring 24h"),
    ("oulton_park", "Oulton Park"),
    ("paul_ricard", "Paul Ricard"),
    ("red_bull_ring", "Red Bull Ring"),
    ("silverstone", "Silverstone"),
    ("snetterton", "Snetterton"),
    ("spa", "Spa-Francorchamps"),
    ("suzuka", "Suzuka"),
    ("valencia", "Valencia"),
    ("watkins_glen", "Watkins Glen"),
    ("zandvoort", "Zandvoort"),
    ("zolder", "Zolder"),
];

const UPPER: &[&str] = &[
    "amg", "bmw", "gt", "gtr", "gte", "gtb", "gp", "ktm", "lms", "nsx", "rs", "rsr", "srt", "amr",
    "ss", "st", "f1", "evo",
];

/// "ks_ferrari_488_gt3" reads "Ferrari 488 GT3". Content folder names, so mods come out readable too.
fn pretty(id: &str) -> String {
    let id = id.trim();
    // EVO and mods often hand over display names already
    if !id.contains('_') && id.chars().any(|c| c.is_uppercase()) {
        return id.to_string();
    }
    let id = id.strip_prefix("ks_").unwrap_or(id);
    id.split(['_', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let lower = w.to_ascii_lowercase();
            if UPPER.contains(&lower.as_str())
                || (w.len() <= 4
                    && w.chars().any(|c| c.is_ascii_digit())
                    && w.chars().any(|c| c.is_alphabetic()))
            {
                w.to_uppercase()
            } else {
                let mut c = w.chars();
                c.next()
                    .map(|f| f.to_uppercase().chain(c).collect())
                    .unwrap_or_default()
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}

fn lookup(table: &[(&str, &'static str)], id: &str) -> String {
    table
        .iter()
        .find(|(k, _)| *k == id)
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| pretty(id))
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

fn build(game: Game, s: &State, o: Opts) -> Option<Live> {
    if s.status == 0 {
        return Some(Live {
            details: clamp("In the menus"),
            large_image: Some(crate::util::art::steam_header(game.app())),
            ..Live::default()
        });
    }
    let (track, car) = match game {
        Game::Acc => (lookup(ACC_TRACKS, &s.track), lookup(ACC_CARS, &s.car)),
        _ => (pretty(&s.track), pretty(&s.car)),
    };
    if track.is_empty() {
        return None;
    }
    let config = pretty(&s.config);
    let full_track = if config.is_empty() || track.contains(&config) {
        track.clone()
    } else {
        format!("{track} - {config}")
    };
    if s.status == 1 {
        return Some(Live {
            details: clamp("Watching a replay"),
            state: clamp(track),
            large_image: Some(crate::util::art::steam_header(game.app())),
            large_text: clamp(full_track),
            ..Live::default()
        });
    }
    let k = kind(game, s.session);
    let label = match k {
        Kind::Practice => "Practice".to_string(),
        Kind::Qualifying => "Qualifying".to_string(),
        Kind::Race if game == Game::Evo && s.session_name.trim().len() > 1 => {
            pretty(&s.session_name)
        }
        Kind::Race => "Race".to_string(),
        Kind::Solo(l) => l.to_string(),
        Kind::Unknown => "On track".to_string(),
    };
    let mut parts: Vec<String> = Vec::new();
    if o.car && !car.is_empty() {
        parts.push(car);
    }
    let field = !matches!(k, Kind::Solo(_)) && s.cars > 1;
    if o.position && field && s.position > 0 {
        parts.push(format!("P{} of {}", s.position.min(s.cars), s.cars));
    }
    if o.position && k == Kind::Race && s.lap > 0 {
        parts.push(if s.laps > 0 {
            format!("Lap {}/{}", s.lap.min(s.laps), s.laps)
        } else {
            format!("Lap {}", s.lap)
        });
    }
    Some(Live {
        details: clamp(format!("{label} · {track}")),
        state: clamp(parts.join(" · ")),
        large_image: Some(crate::util::art::steam_header(game.app())),
        large_text: clamp(full_track),
        ..Live::default()
    })
}

fn sample(
    status: i32,
    session: i32,
    track: &str,
    car: &str,
    position: u32,
    lap: u32,
    laps: u32,
) -> State {
    State {
        status,
        session,
        session_name: String::new(),
        track: track.into(),
        config: String::new(),
        car: car.into(),
        position,
        cars: 24,
        lap,
        laps,
    }
}

fn preview(settings: &Settings, scenario: &str) -> Preview {
    let (game, state) = match scenario {
        "qualifying" => (Game::Acc, sample(2, 1, "monza", "ferrari_296_gt3", 3, 4, 0)),
        "race" => (
            Game::Acc,
            sample(2, 2, "spa", "porsche_992_gt3_r", 5, 12, 0),
        ),
        "hotlap" => {
            let mut s = sample(2, 3, "ks_nordschleife", "ks_porsche_911_gt3_rs", 1, 2, 0);
            s.config = "endurance".into();
            s.cars = 1;
            (Game::Ac, s)
        }
        "evo" => {
            let mut s = sample(2, 1, "Imola", "BMW M4 GT3", 2, 3, 8);
            s.session_name = "Race".into();
            (Game::Evo, s)
        }
        "menu" => (Game::Acc, sample(0, 0, "", "", 0, 0, 0)),
        "practice" => (
            Game::Acc,
            sample(2, 0, "silverstone", "mclaren_720s_gt3_evo", 7, 6, 0),
        ),
        _ => (Game::Acc, sample(0, 0, "", "", 0, 0, 0)),
    };
    let live = build(game, &state, Opts::from(settings)).unwrap_or_default();
    Preview {
        game: game.title(),
        icon: None,
        live,
    }
}

fn run(ctx: &Ctx) {
    let Some(game) = Game::of(ctx.target()) else {
        return;
    };
    while ctx.running() {
        let live = read(game).and_then(|s| build(game, &s, Opts::from(ctx.settings())));
        let idle = live.is_none();
        ctx.emit(live);
        // AC creates the pages only once a session loads (Content Manager is the menu)
        if !ctx.sleep(Duration::from_secs(if idle { 10 } else { 3 })) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(b: &mut [u8], at: usize, s: &str) {
        for (i, u) in s.encode_utf16().enumerate() {
            b[at + i * 2..at + i * 2 + 2].copy_from_slice(&u.to_le_bytes());
        }
    }

    fn put(b: &mut [u8], at: usize, v: i32) {
        b[at..at + 4].copy_from_slice(&v.to_le_bytes());
    }

    #[test]
    fn parses_kunos_pages() {
        let mut stat = vec![0u8; AC_STATIC_LEN];
        let mut gfx = vec![0u8; AC_GRAPHICS_LEN];
        put(&mut stat, 64, 30);
        wide(&mut stat, 68, "ferrari_296_gt3");
        wide(&mut stat, 134, "spa");
        // player name fields sit between track and config, never read
        wide(&mut stat, 200, "Private");
        put(&mut gfx, 4, 2);
        put(&mut gfx, 8, 2);
        put(&mut gfx, 132, 9);
        put(&mut gfx, 136, 4);
        put(&mut gfx, 172, 0);
        let s = parse_kunos(&stat, &gfx).unwrap();
        assert_eq!(
            s,
            State {
                status: 2,
                session: 2,
                session_name: String::new(),
                track: "spa".into(),
                config: String::new(),
                car: "ferrari_296_gt3".into(),
                position: 4,
                cars: 30,
                lap: 10,
                laps: 0,
            }
        );
        assert!(parse_kunos(&stat[..100], &gfx).is_none());
        let live = build(
            Game::Acc,
            &s,
            Opts {
                car: true,
                position: true,
            },
        )
        .unwrap();
        assert_eq!(live.details.as_deref(), Some("Race · Spa-Francorchamps"));
        assert_eq!(
            live.state.as_deref(),
            Some("Ferrari 296 GT3 · P4 of 30 · Lap 10")
        );
        assert!(!live.competing);
    }

    #[test]
    fn parses_evo_pages() {
        let mut stat = vec![0u8; EVO_STATIC_LEN];
        let mut gfx = vec![0u8; EVO_GRAPHICS_LEN];
        put(&mut stat, 32, 1);
        stat[36..42].copy_from_slice(b"Race 1");
        stat[136..141].copy_from_slice(b"Imola");
        put(&mut gfx, 4, 2);
        put(&mut gfx, 2388, 2);
        put(&mut gfx, 2392, 16);
        put(&mut gfx, 2544, 8);
        put(&mut gfx, 2548, 3);
        gfx[3086..3096].copy_from_slice(b"BMW M4 GT3");
        let s = parse_evo(&stat, &gfx).unwrap();
        let live = build(
            Game::Evo,
            &s,
            Opts {
                car: true,
                position: true,
            },
        )
        .unwrap();
        assert_eq!(live.details.as_deref(), Some("Race 1 · Imola"));
        assert_eq!(
            live.state.as_deref(),
            Some("BMW M4 GT3 · P2 of 16 · Lap 3/8")
        );
    }

    #[test]
    fn names() {
        assert_eq!(pretty("ks_porsche_911_gt3_rs"), "Porsche 911 GT3 RS");
        assert_eq!(pretty("ks_nordschleife"), "Nordschleife");
        assert_eq!(pretty("BMW M4 GT3"), "BMW M4 GT3");
        assert_eq!(pretty("ford_mustang_gt3"), "Ford Mustang GT3");
        assert_eq!(lookup(ACC_TRACKS, "mount_panorama"), "Mount Panorama");
        assert_eq!(
            lookup(ACC_CARS, "porsche_991ii_gt3_r"),
            "Porsche 991 II GT3 R"
        );
        assert_eq!(pretty(""), "");
    }

    #[test]
    fn menus_replays_and_solo() {
        let o = Opts {
            car: true,
            position: true,
        };
        let menu = build(Game::Acc, &sample(0, 2, "spa", "x", 1, 1, 1), o).unwrap();
        assert_eq!(menu.details.as_deref(), Some("In the menus"));
        assert_eq!(menu.state, None);
        let replay = build(Game::Acc, &sample(1, 2, "monza", "x", 1, 1, 1), o).unwrap();
        assert_eq!(replay.details.as_deref(), Some("Watching a replay"));
        // hotlaps have no field, so no position even when the page says P1
        let hot = build(
            Game::Ac,
            &sample(2, 3, "ks_vallelunga", "abarth500", 1, 3, 0),
            o,
        )
        .unwrap();
        assert_eq!(hot.details.as_deref(), Some("Hotlap · Vallelunga"));
        assert_eq!(hot.state.as_deref(), Some("Abarth500"));
        // nothing loaded yet
        assert_eq!(build(Game::Ac, &sample(2, 0, "", "", 0, 0, 0), o), None);
    }

    #[test]
    fn matches_games() {
        let t = |id: &str, exe: Option<&str>| Target {
            game_id: id.into(),
            exe: exe.map(Into::into),
            ..Target::default()
        };
        assert_eq!(Game::of(&t("425778010222886912", None)), Some(Game::Ac));
        assert_eq!(Game::of(&t("1124351838666375228", None)), Some(Game::Acc));
        assert_eq!(Game::of(&t("1329495435047600219", None)), Some(Game::Evo));
        assert_eq!(
            Game::of(&t(
                "x",
                Some(r"D:\ACC\AC2\Binaries\Win64\AC2-Win64-Shipping.exe")
            )),
            Some(Game::Acc)
        );
        assert_eq!(Game::of(&t("x", Some(r"D:\ac\acs.exe"))), Some(Game::Ac));
        assert!(!matches(&t("x", Some(r"D:\ac\content manager.exe"))));
    }

    #[test]
    fn previews() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(preview(&s, key).live.details.is_some(), "{key}");
        }
        assert_eq!(preview(&s, "nope").live, preview(&s, "menu").live);
        assert_eq!(
            preview(&s, "race").live.state.as_deref(),
            Some("Porsche 992 GT3 R · P5 of 24 · Lap 12")
        );
        assert_eq!(
            preview(&s, "hotlap").live.large_text.as_deref(),
            Some("Nordschleife - Endurance")
        );
        assert_eq!(preview(&s, "evo").game, "Assetto Corsa EVO");
        let off = Settings::new(&MANIFEST, serde_json::json!({ "show_car": false }));
        assert_eq!(
            preview(&off, "race").live.state.as_deref(),
            Some("P5 of 24 · Lap 12")
        );
    }
}
