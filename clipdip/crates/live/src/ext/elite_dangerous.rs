//! System, ship and travel state. Ported from Elite-Dangerous-Rich-Presence
//! by VeeLume (MIT), https://github.com/VeeLume/Elite-Dangerous-Rich-Presence:
//! event_processor.py, settings_config.py, vessels.json; ed-journals by rster2002
//! (MIT), https://github.com/rster2002/ed-journals: journal events and status flags

use crate::util::{
    self, art, clamp,
    tail::{self, Tail},
};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

mod ships;

pub static MANIFEST: Manifest = Manifest {
    id: "elite_dangerous",
    name: "Elite Dangerous",
    blurb: "System, station or body, ship picture and travel state.",
    setup: None,
    credits: &[
        Credit {
            project: "Elite-Dangerous-Rich-Presence",
            author: "VeeLume",
            url: "https://github.com/VeeLume/Elite-Dangerous-Rich-Presence",
            license: "MIT",
        },
        Credit {
            project: "ed-journals",
            author: "rster2002",
            url: "https://github.com/rster2002/ed-journals",
            license: "MIT",
        },
    ],
    options: &[
        Opt::toggle(
            "location",
            "Show location",
            "System, station and body names.",
            true,
        ),
        Opt::toggle(
            "gamemode",
            "Show game mode",
            "Open, Solo or Private group, without group names.",
            true,
        ),
        Opt::toggle(
            "ship_icon",
            "Show ship picture",
            "Ship art as the big image.",
            true,
        ),
        Opt::toggle(
            "ship_text",
            "Show ship name",
            "Ship model in the card text.",
            true,
        ),
        Opt::toggle(
            "power",
            "Show pledged power",
            "Public Powerplay faction in the image hover text.",
            true,
        ),
        Opt::toggle(
            "multicrew_mode",
            "Show crew mode",
            "Wing or Multicrew.",
            true,
        ),
        Opt::toggle(
            "time_elapsed",
            "Show elapsed time",
            "Time since the game session started.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &["363413225578037248"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/359320/header.jpg"),
    preview,
    scenarios: &[
        ("menu", "Main menu"),
        ("docked", "Docked"),
        ("space", "Normal space"),
        ("supercruise", "Supercruise"),
        ("landed", "Landed"),
        ("srv", "In an SRV"),
        ("on_foot", "On foot"),
    ],
    steam_game: true,
    listed: true,
};

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || t.game_id == "steam:359320"
        || matches!(
            util::exe_name(t).as_str(),
            "elitedangerous64.exe" | "elitedangerous.exe"
        )
}

#[derive(Clone, Copy, Default, PartialEq)]
enum Phase {
    #[default]
    Unknown,
    Menu,
    Docked,
    Space,
    Supercruise,
    Landed,
    Srv,
    Foot,
}

impl Phase {
    fn label(self) -> &'static str {
        match self {
            Self::Unknown => "",
            Self::Menu => "In the main menu",
            Self::Docked => "Docked",
            Self::Space => "In space",
            Self::Supercruise => "Supercruise",
            Self::Landed => "Landed",
            Self::Srv => "In an SRV",
            Self::Foot => "On foot",
        }
    }
}

#[derive(Default)]
struct State {
    phase: Phase,
    system: Option<String>,
    body: Option<String>,
    ship: Option<String>,
    mode: Option<&'static str>,
    power: Option<String>,
    crew: Option<&'static str>,
    started: i64,
}

fn text(v: &Value, key: &str) -> Option<String> {
    let s = v.get(key)?.as_str()?.trim();
    if s.len() > 256 || s.chars().any(char::is_control) {
        return None;
    }
    clamp(s)
}

impl State {
    fn event(&mut self, v: &Value) {
        let Some(event) = v.get("event").and_then(Value::as_str) else {
            return;
        };
        match event {
            "Fileheader" | "Shutdown" => {
                *self = Self {
                    phase: Phase::Menu,
                    started: self.started,
                    ..Self::default()
                };
            }
            "Music" if v.get("MusicTrack").and_then(Value::as_str) == Some("MainMenu") => {
                *self = Self {
                    phase: Phase::Menu,
                    started: self.started,
                    ..Self::default()
                };
            }
            "LoadGame" => {
                self.ship = text(v, "Ship");
                self.mode = match v.get("GameMode").and_then(Value::as_str) {
                    Some("Open") => Some("Open"),
                    Some("Solo") => Some("Solo"),
                    Some("Group") => Some("Private group"),
                    _ => None,
                };
                self.phase = Phase::Space;
            }
            "Loadout" => self.ship = text(v, "Ship"),
            "Location" => {
                let Some(system) = text(v, "StarSystem") else {
                    return;
                };
                self.system = Some(system);
                let docked = v.get("Docked").and_then(Value::as_bool) == Some(true);
                self.body = if docked {
                    text(v, "StationName")
                } else {
                    text(v, "Body")
                };
                self.phase = if v.get("OnFoot").and_then(Value::as_bool) == Some(true) {
                    Phase::Foot
                } else if v.get("InSRV").and_then(Value::as_bool) == Some(true) {
                    Phase::Srv
                } else if docked {
                    Phase::Docked
                } else {
                    Phase::Space
                };
            }
            "FSDJump" | "CarrierJump" => {
                let Some(system) = text(v, "StarSystem") else {
                    return;
                };
                self.system = Some(system);
                self.body = None;
                self.phase = if event == "FSDJump" {
                    Phase::Supercruise
                } else {
                    Phase::Space
                };
            }
            "Docked" => {
                if let Some(station) = text(v, "StationName") {
                    self.body = Some(station);
                    self.phase = Phase::Docked;
                }
            }
            "Undocked" => {
                self.body = None;
                self.phase = Phase::Space;
            }
            "SupercruiseEntry" => {
                self.body = None;
                self.phase = Phase::Supercruise;
            }
            "SupercruiseExit" => {
                self.body = text(v, "Body");
                self.phase = Phase::Space;
            }
            "ApproachBody" => self.body = text(v, "Body"),
            "LeaveBody" => self.body = None,
            "Touchdown" if v.get("PlayerControlled").and_then(Value::as_bool) == Some(true) => {
                self.phase = Phase::Landed;
                if let Some(body) = text(v, "Body") {
                    self.body = Some(body);
                }
            }
            "Liftoff" if v.get("PlayerControlled").and_then(Value::as_bool) == Some(true) => {
                self.phase = Phase::Space
            }
            "LaunchSRV" if v.get("PlayerControlled").and_then(Value::as_bool) == Some(true) => {
                self.phase = Phase::Srv
            }
            "DockSRV" => self.phase = Phase::Landed,
            "Disembark" => self.phase = Phase::Foot,
            "Embark" => {
                self.phase = if v.get("SRV").and_then(Value::as_bool) == Some(true) {
                    Phase::Srv
                } else if v.get("OnStation").and_then(Value::as_bool) == Some(true) {
                    Phase::Docked
                } else {
                    Phase::Landed
                }
            }
            "Powerplay" | "PowerplayJoin" => self.power = text(v, "Power"),
            "PowerplayDefect" => self.power = text(v, "ToPower"),
            "PowerplayLeave" => self.power = None,
            "WingJoin" | "WingAdd" => self.crew = Some("Wing"),
            "JoinACrew" => self.crew = Some("Multicrew"),
            "WingLeave" | "EndCrewSession" | "QuitACrew" => self.crew = None,
            _ => {}
        }
    }

    fn status(&mut self, v: &Value) {
        if matches!(self.phase, Phase::Unknown | Phase::Menu) {
            return;
        }
        let Some(flags) = v.get("Flags").and_then(Value::as_u64) else {
            return;
        };
        let flags2 = v.get("Flags2").and_then(Value::as_u64).unwrap_or(0);
        self.phase = if flags2 & 1 != 0 {
            Phase::Foot
        } else if flags & (1 << 26) != 0 {
            Phase::Srv
        } else if flags & 1 != 0 {
            Phase::Docked
        } else if flags & 2 != 0 {
            Phase::Landed
        } else if flags & ((1 << 4) | (1 << 31)) != 0 {
            Phase::Supercruise
        } else {
            Phase::Space
        };
        if matches!(self.phase, Phase::Foot | Phase::Srv | Phase::Landed) {
            if let Some(body) = text(v, "BodyName") {
                self.body = Some(body);
            }
        }
    }
}

fn build(st: &State, s: &Settings) -> Option<Live> {
    if st.phase == Phase::Unknown {
        return None;
    }
    if st.phase == Phase::Menu {
        return Some(Live {
            details: clamp(st.phase.label()),
            large_image: Some(art::steam_header("359320")),
            ..Live::default()
        });
    }
    let mut location = vec![];
    if s.flag("location") {
        if let Some(system) = &st.system {
            location.push(system.clone());
        }
        if let Some(body) = &st.body {
            if st.system.as_ref() != Some(body) {
                location.push(body.clone());
            }
        }
    }
    location.push(st.phase.label().into());
    let ship = st.ship.as_ref().and_then(|id| {
        ships::SHIPS
            .iter()
            .find(|(key, _, _)| key.eq_ignore_ascii_case(id))
    });
    let mut state = vec![];
    if s.flag("ship_text") && !matches!(st.phase, Phase::Foot | Phase::Srv) {
        if let Some((_, name, _)) = ship {
            state.push(*name);
        }
    }
    if s.flag("gamemode") {
        if let Some(mode) = st.mode {
            state.push(mode);
        }
    }
    if s.flag("multicrew_mode") {
        if let Some(crew) = st.crew {
            state.push(crew);
        }
    }
    let mut hover = vec![];
    if s.flag("ship_text") && !matches!(st.phase, Phase::Foot | Phase::Srv) {
        if let Some((_, name, _)) = ship {
            hover.push(name.to_string());
        }
    }
    if s.flag("power") {
        if let Some(power) = &st.power {
            hover.push(power.clone());
        }
    }
    let large_image = if s.flag("ship_icon") {
        Some(if matches!(st.phase, Phase::Foot | Phase::Srv) {
            art::steam_header("359320")
        } else {
            ship.map(|(_, _, key)| art::url("elite-dangerous", key))
                .unwrap_or_else(|| art::steam_header("359320"))
        })
    } else {
        None
    };
    Some(Live {
        details: clamp(location.join(" - ")),
        state: clamp(state.join(", ")),
        large_image,
        large_text: clamp(hover.join(", ")),
        start_ms: if s.flag("time_elapsed") && st.started > 0 {
            Some(st.started)
        } else {
            None
        },
        ..Live::default()
    })
}

fn read_json(path: &Path) -> Option<Value> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(64 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn initial(path: &Path, state: &mut State) {
    // LoadGame holds the ship and mode, often hours before the recent tail
    if let Ok(file) = std::fs::File::open(path) {
        for line in BufReader::new(file.take(64 * 1024))
            .lines()
            .map_while(Result::ok)
        {
            if let Ok(v) = serde_json::from_str(&line) {
                state.event(&v);
            }
        }
    }
}

fn run(ctx: &Ctx) {
    let Some(home) = std::env::var_os("USERPROFILE") else {
        ctx.emit(None);
        return;
    };
    let dir = PathBuf::from(home).join("Saved Games/Frontier Developments/Elite Dangerous");
    let mut log: Option<Tail> = None;
    let mut stamp: Option<(SystemTime, u64)> = None;
    let mut state = State {
        started: ctx.target().started_at_ms,
        ..State::default()
    };
    loop {
        let newest = tail::newest_file(&dir, |n| n.starts_with("Journal.") && n.ends_with(".log"));
        if newest.as_deref() != log.as_ref().map(Tail::path) {
            state = State {
                started: ctx.target().started_at_ms,
                ..State::default()
            };
            if let Some(path) = &newest {
                initial(path, &mut state);
            }
            log = newest.map(|p| Tail::new(p, 2 * 1024 * 1024));
            stamp = None;
        }
        let mut available = false;
        if let Some(log) = &mut log {
            if let Ok(meta) = std::fs::metadata(log.path()) {
                available = true;
                if let Ok(created) = meta.created() {
                    if stamp.is_some_and(|(old, size)| old != created || meta.len() < size) {
                        state = State {
                            started: ctx.target().started_at_ms,
                            ..State::default()
                        };
                    }
                    stamp = Some((created, meta.len()));
                }
                log.poll(|line| {
                    if let Ok(v) = serde_json::from_str(line) {
                        state.event(&v);
                    }
                });
                if let Some(status) = read_json(&dir.join("Status.json")) {
                    state.status(&status);
                }
            }
        }
        ctx.emit(if available {
            build(&state, ctx.settings())
        } else {
            None
        });
        if !ctx.sleep(Duration::from_secs(if available { 5 } else { 12 })) {
            return;
        }
    }
}

fn preview(s: &Settings, key: &str) -> Preview {
    let mut state = State::default();
    state.event(&serde_json::json!({"event":"Fileheader"}));
    if matches!(
        key,
        "docked" | "space" | "supercruise" | "landed" | "srv" | "on_foot"
    ) {
        state.started = 1_700_000_000_000;
        state.event(&serde_json::json!({"event":"LoadGame", "Ship":"anaconda", "GameMode":"Solo"}));
        state.event(&serde_json::json!({"event":"Location", "StarSystem":"Sol", "Body":"Earth", "Docked":false}));
        state.phase = match key {
            "docked" => {
                state.body = Some("Abraham Lincoln".into());
                Phase::Docked
            }
            "supercruise" => Phase::Supercruise,
            "landed" => Phase::Landed,
            "srv" => Phase::Srv,
            "on_foot" => Phase::Foot,
            _ => Phase::Space,
        };
    }
    Preview {
        game: "Elite: Dangerous",
        icon: None,
        live: build(&state, s).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn settings(v: Value) -> Settings {
        Settings::new(&MANIFEST, v)
    }
    #[test]
    fn journal_transitions_and_privacy() {
        let mut st = State::default();
        st.event(&json!({"event":"LoadGame", "Commander":"PRIVATE", "Ship":"Krait_MkII", "GameMode":"Group", "Group":"PRIVATE"}));
        st.event(&json!({"event":"Location", "StarSystem":"Sol", "Docked":true, "StationName":"Galileo"}));
        let l = build(&st, &settings(json!({}))).unwrap();
        assert_eq!(l.details.as_deref(), Some("Sol - Galileo - Docked"));
        assert_eq!(l.state.as_deref(), Some("Krait Mk II, Private group"));
        assert!(!serde_json::to_string(&l).unwrap().contains("PRIVATE"));
        st.event(&json!({"event":"FSDJump", "StarSystem":"Achenar"}));
        assert!(st.body.is_none());
        assert!(st.phase == Phase::Supercruise);
        st.event(&json!({"event":"Touchdown", "PlayerControlled":false}));
        assert!(st.phase == Phase::Supercruise);
        st.event(&json!({"event":"Touchdown", "PlayerControlled":true, "Body":"Achenar 3"}));
        assert!(st.phase == Phase::Landed);
        st.event(&json!({"event":"Music", "MusicTrack":"MainMenu"}));
        assert!(st.ship.is_none() && st.system.is_none());
    }
    #[test]
    fn status_flags_and_bad_events() {
        let mut st = State {
            phase: Phase::Space,
            ..State::default()
        };
        st.status(&json!({"event":"Status", "Flags":150994968, "Flags2":0}));
        assert!(st.phase == Phase::Supercruise);
        st.status(&json!({"Flags":1}));
        assert!(st.phase == Phase::Docked);
        st.status(&json!({"Flags":2}));
        assert!(st.phase == Phase::Landed);
        st.status(&json!({"Flags":1 << 26}));
        assert!(st.phase == Phase::Srv);
        st.status(&json!({"Flags":0, "Flags2":1}));
        assert!(st.phase == Phase::Foot);
        st.event(&json!({"event":"FSDJump"}));
        assert!(st.phase == Phase::Foot);
        st.phase = Phase::Menu;
        st.status(&json!({"Flags":16}));
        assert!(st.phase == Phase::Menu);
    }
    #[test]
    fn previews_and_options() {
        let s = settings(json!({}));
        for (k, _) in MANIFEST.scenarios {
            assert!(preview(&s, k).live.details.is_some());
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        for key in [
            "location",
            "gamemode",
            "ship_text",
            "ship_icon",
            "time_elapsed",
        ] {
            assert_ne!(
                preview(&s, "docked").live,
                preview(&settings(json!({key:false})), "docked").live,
                "{key}"
            );
        }
    }
}
