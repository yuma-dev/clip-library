//! Mode and last reported local location. Ported from all-slain by Dimma Don't
//! (MIT), https://github.com/DimmaDont/all-slain: handlers/loading.py, loaded.py,
//! cet.py, corpse.py, quantum.py, endsession.py and data/locations_respawn.py

use crate::util::{self, clamp, tail::Tail};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

mod locations;

pub static MANIFEST: Manifest = Manifest {
    id: "star_citizen",
    name: "Star Citizen",
    blurb: "Game mode and the last location reported for your character.",
    setup: None,
    credits: &[Credit {
        project: "all-slain",
        author: "Dimma Don't",
        url: "https://github.com/DimmaDont/all-slain",
        license: "MIT",
    }],
    options: &[Opt::toggle(
        "show_location",
        "Show location",
        "Last location or quantum destination reported by the local client.",
        true,
    )],
    matches,
    run,
    priority: 10,
    game_ids: &["452295596917784577"],
    art: Some("https://media.starcitizen.tools/9/9c/Microtech-new-babbage-cityscape-01.jpg"),
    preview,
    scenarios: &[
        ("menu", "Main menu"),
        ("loading", "Loading"),
        ("universe", "Persistent universe"),
        ("location", "Local location"),
        ("quantum", "Quantum destination"),
        ("pyro", "Pyro"),
    ],
    steam_game: false,
    listed: true,
};

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str()) || util::exe_name(t) == "starcitizen.exe"
}

const STANTON_ART: &str = "https://media.starcitizen.tools/b/b5/Stanton_2D.png";
const PYRO_ART: &str = "https://media.starcitizen.tools/5/58/Pyro_2D.png";

#[derive(Clone, Copy, Default, PartialEq)]
enum Phase {
    #[default]
    Unknown,
    Menu,
    Loading,
    Universe,
    Quantum,
}

#[derive(Default)]
struct State {
    phase: Phase,
    system: Option<&'static str>,
    location: Option<&'static str>,
}

fn quoted<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = line.split_once(prefix)?.1;
    rest.split_once('"').map(|(v, _)| v)
}

fn location(id: &str) -> Option<(&'static str, &'static str)> {
    let id = id.trim_start_matches('@');
    let (_, name) = locations::LOCATIONS.iter().find(|(key, _)| *key == id)?;
    let system = if id.starts_with("Stanton") {
        "Stanton"
    } else if id.starts_with("Pyro") {
        "Pyro"
    } else {
        return None;
    };
    Some((name, system))
}

impl State {
    fn line(&mut self, line: &str) {
        if line.contains("<SystemQuit>") {
            *self = Self::default();
            return;
        }
        if line.contains("<CDisciplineServiceExternal::EndSession>")
            || line.contains("Loading screen for Frontend_Main :")
        {
            *self = Self {
                phase: Phase::Menu,
                ..Self::default()
            };
            return;
        }
        if line.contains(
            "[CGlobalGameUI::OpenLoadingScreen] Request context transition to LoadingScreenView",
        ) {
            *self = Self {
                phase: Phase::Loading,
                ..Self::default()
            };
            return;
        }
        if line.contains("Loading screen for pu :") || line.contains("Loading screen for pyro :") {
            self.phase = Phase::Universe;
            self.location = None;
            self.system = if line.contains("Loading screen for pyro :") {
                Some("Pyro")
            } else {
                None
            };
            return;
        }
        if line.contains("ContextEstablisherTaskFinished>")
            && line.contains("taskname=\"InitView.ClientPlayer\"")
            && line.contains("state=eCVS_InGame(")
        {
            match quoted(line, "gamerules=\"") {
                Some("SC_Frontend") => {
                    *self = Self {
                        phase: Phase::Menu,
                        ..Self::default()
                    }
                }
                Some("SC_Default") => self.phase = Phase::Universe,
                _ => {}
            }
            return;
        }
        // remote client corpse lines describe other players, not this session
        if line.contains(
            "<local client>: DoesLocationContainHospital: Searching landing zone location \"",
        ) {
            if let Some((name, system)) =
                quoted(line, "Searching landing zone location \"").and_then(location)
            {
                self.phase = Phase::Universe;
                self.location = Some(name);
                self.system = Some(system);
            }
            return;
        }
        if line.contains("<Quantum Navtarget>") && line.contains(" : Local client user ") {
            let Some(rest) = line.split_once(" to Target ").map(|(_, rest)| rest) else {
                return;
            };
            if let Some((name, system)) = rest.split_whitespace().next().and_then(location) {
                self.phase = Phase::Quantum;
                self.location = Some(name);
                self.system = Some(system);
            }
        }
    }
}

fn build(st: &State, s: &Settings) -> Option<Live> {
    let details = match st.phase {
        Phase::Unknown => return None,
        Phase::Menu => "In the main menu",
        Phase::Loading => "Loading",
        Phase::Universe => "Persistent universe",
        Phase::Quantum => "Persistent universe",
    };
    let state = if s.flag("show_location") {
        st.location
            .map(|name| {
                format!(
                    "{}: {name}",
                    if st.phase == Phase::Quantum {
                        "Last quantum destination"
                    } else {
                        "Last reported"
                    }
                )
            })
            .or_else(|| st.system.map(str::to_string))
    } else {
        None
    };
    Some(Live {
        details: clamp(details),
        state: state.and_then(clamp),
        large_image: if s.flag("show_location") {
            match st.system {
                Some("Stanton") => Some(STANTON_ART.into()),
                Some("Pyro") => Some(PYRO_ART.into()),
                _ => None,
            }
        } else {
            None
        },
        large_text: if s.flag("show_location") {
            st.system.and_then(clamp)
        } else {
            None
        },
        ..Live::default()
    })
}

fn log_path(exe: &Path) -> Option<PathBuf> {
    exe.parent()?
        .ancestors()
        .take(3)
        .map(|dir| dir.join("Game.log"))
        .find(|p| p.is_file())
}

fn initial(path: &Path, state: &mut State) {
    // startup mode can fall outside the recent tail in a long session
    if let Ok(file) = std::fs::File::open(path) {
        for line in BufReader::new(file.take(512 * 1024))
            .lines()
            .map_while(Result::ok)
        {
            state.line(&line);
        }
    }
}

fn run(ctx: &Ctx) {
    let mut log: Option<Tail> = None;
    let mut stamp: Option<(SystemTime, u64)> = None;
    let mut state = State::default();
    loop {
        let path = ctx.target().exe.as_deref().and_then(log_path);
        if path.as_deref() != log.as_ref().map(Tail::path) {
            state = State::default();
            if let Some(path) = &path {
                initial(path, &mut state);
            }
            log = path.map(|p| Tail::new(p, 2 * 1024 * 1024));
            stamp = None;
        }
        let mut available = false;
        if let Some(log) = &mut log {
            if let Ok(meta) = std::fs::metadata(log.path()) {
                available = true;
                if let Ok(created) = meta.created() {
                    if stamp.is_some_and(|(old, size)| old != created || meta.len() < size) {
                        state = State::default();
                    }
                    stamp = Some((created, meta.len()));
                }
                log.poll(|line| state.line(line));
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
    let mut st = State::default();
    st.line("Loading screen for Frontend_Main : SC_Frontend closed after 1.0 seconds");
    match key {
        "loading" => st.line("[CGlobalGameUI::OpenLoadingScreen] Request context transition to LoadingScreenView"),
        "universe" => st.line("Loading screen for pu : SC_Default closed after 30.0 seconds"),
        "pyro" => st.line("Loading screen for pyro : SC_Default closed after 30.0 seconds"),
        "location" => st.line("[Notice] <Corpse> Player 'Pilot' <local client>: DoesLocationContainHospital: Searching landing zone location \"@Stanton1_Transfer\" for the closest hospital. [Team_ActorFeatures][Actor]"),
        "quantum" => st.line("[Notice] <Quantum Navtarget> CSCItemQuantumDrive::RmMulticastOnQTToPoint : Local client user Pilot[1234567890123] received QT data for Entity:Ship_1234567890123[1234567890123] to Target Stanton4"),
        _ => {}
    }
    Preview {
        game: MANIFEST.name,
        icon: None,
        live: build(&st, s).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn remote_players_and_unknown_ids_do_not_change_location() {
        let mut st = State::default();
        st.line("[Notice] <Corpse> Player 'Other' <remote client>: DoesLocationContainHospital: Searching landing zone location \"@Stanton1_Transfer\" for the closest hospital.");
        assert!(st.location.is_none() && st.phase == Phase::Unknown);
        st.line("[Notice] <[ActorState] Corpse> [ACTOR STATE][SSCActorStateCVars::LogCorpse] Player 'Pilot' <local client>: DoesLocationContainHospital: Searching landing zone location \"@Stanton1_Transfer\" for the closest hospital. [Team_ActorFeatures][Actor]");
        assert_eq!(st.location, Some("Everus Harbor"));
        assert!(location("private-path").is_none());
        st.line("[Notice] <CDisciplineServiceExternal::EndSession> Ending session");
        assert!(st.location.is_none() && st.system.is_none() && st.phase == Phase::Menu);
    }
    #[test]
    fn context_establisher() {
        let mut st = State::default();
        st.line("[Notice] <ContextEstablisherTaskFinished> establisher=\"Network\" message=\"CET completed\" taskname=\"InitView.ClientPlayer\" state=eCVS_InGame(14) status=\"Finished\" runningTime=0.000001 numRuns=1 map=\"megamap\" gamerules=\"SC_Default\"");
        assert!(st.phase == Phase::Universe);
        st.line("[Notice] <SystemQuit> CSystem::Quit invoked");
        assert!(build(&st, &Settings::new(&MANIFEST, json!({}))).is_none());
    }
    #[test]
    fn scenarios_and_location_option() {
        let s = Settings::new(&MANIFEST, json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(preview(&s, key).live.details.is_some());
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        assert_ne!(
            preview(&s, "location").live,
            preview(
                &Settings::new(&MANIFEST, json!({"show_location":false})),
                "location"
            )
            .live
        );
        assert_eq!(
            preview(&s, "quantum").live.state.as_deref(),
            Some("Last quantum destination: microTech")
        );
    }
}
