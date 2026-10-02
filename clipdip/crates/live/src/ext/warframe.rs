//! Mission node, planet, and hubs. Ported from warframe-deathlog by WFCD (Apache-2.0),
//! https://github.com/WFCD/warframe-deathlog: src/regex.js; mission format from wiki.warframe.com/w/EE.log

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf, sync::LazyLock, time::Duration};
mod log;

pub static MANIFEST: Manifest = Manifest {
    id: "warframe",
    name: "Warframe",
    blurb: "Mission node, planet, and mission type",
    setup: None,
    credits: &[
        Credit {
            project: "warframe-deathlog",
            author: "WFCD",
            url: "https://github.com/WFCD/warframe-deathlog",
            license: "Apache-2.0",
        },
        Credit {
            project: "Warframe Wiki EE.log",
            author: "Warframe Wiki",
            url: "https://wiki.warframe.com/w/EE.log",
            license: "docs",
        },
        Credit {
            project: "warframe-worldstate-data",
            author: "WFCD",
            url: "https://github.com/WFCD/warframe-worldstate-data",
            license: "MIT",
        },
    ],
    options: &[Opt::toggle(
        "show_mission_type",
        "Show mission type",
        "Display the mission objective beside the node.",
        true,
    )],
    matches,
    run,
    priority: 10,
    game_ids: &["1402418586244612216"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/230410/header.jpg"),
    preview,
    scenarios: &[
        ("orbiter", "Orbiter"),
        ("relay", "Relay"),
        ("dojo", "Dojo"),
        ("mission", "Mission"),
        ("complete", "Mission complete"),
    ],
    steam_game: true,
    listed: true,
};
fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || t.game_id == "steam:230410"
        || matches!(
            util::exe_name(t).as_str(),
            "warframe.x64.exe" | "warframe.exe"
        )
}
#[derive(Deserialize)]
struct Node {
    value: String,
    #[serde(default, rename = "type")]
    kind: String,
}
static NODES: LazyLock<BTreeMap<String, Node>> =
    LazyLock::new(|| serde_json::from_str(include_str!("warframe/nodes.json")).unwrap_or_default());
#[derive(Default)]
struct State {
    phase: &'static str,
    node: Option<String>,
    planet: Option<String>,
    kind: Option<String>,
    info_left: u16,
    kind_from_log: bool,
}
fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let (_, rest) = line.split_once(&format!("\"{key}\""))?;
    let rest = rest
        .trim_start()
        .strip_prefix(':')?
        .trim_start()
        .strip_prefix('"')?;
    rest.split('"').next()
}
fn mission_type(value: &str) -> Option<String> {
    let name = match value {
        "MT_EXTERMINATION" => "Extermination",
        "MT_DEFENSE" => "Defense",
        "MT_MOBILE_DEFENSE" => "Mobile defense",
        "MT_SURVIVAL" => "Survival",
        "MT_CAPTURE" => "Capture",
        "MT_RESCUE" => "Rescue",
        "MT_SABOTAGE" => "Sabotage",
        "MT_INTEL" => "Spy",
        "MT_TERRITORY" => "Interception",
        "MT_EXCAVATE" => "Excavation",
        "MT_ASSASSINATION" => "Assassination",
        "MT_ASSAULT" => "Assault",
        "MT_ARENA" => "Arena",
        "MT_DISRUPTION" => "Disruption",
        "MT_VOID_CASCADE" => "Void cascade",
        "MT_ALCHEMY" => "Alchemy",
        "MT_FREE_ROAM" => "Free roam",
        _ => return None,
    };
    Some(name.into())
}
impl State {
    fn set_node(&mut self, id: &str) {
        let id = id.split('_').next().unwrap_or(id);
        self.node = None;
        self.planet = None;
        self.kind = None;
        if let Some(node) = NODES.get(id) {
            if let Some((name, planet)) = node.value.rsplit_once(" (") {
                self.node = util::clamp(name);
                self.planet = planet.strip_suffix(')').and_then(util::clamp);
            }
            self.kind = util::clamp(node.kind.clone());
        }
    }
    fn parse(&mut self, line: &str) {
        if line.contains("Main Shutdown Complete.") {
            *self = Self::default();
            return;
        }
        if line.contains("Game successfully connected to:") {
            let phase = if line.contains("/PlayerShip/") {
                "orbiter"
            } else if line.contains("/Dojo/") || line.contains("/ClanHall/") {
                "dojo"
            } else if line.contains("/Relay/") || line.contains("/TennoHub/") {
                "relay"
            } else {
                ""
            };
            // unknown destinations clear a previous mission until MissionInfo identifies them
            *self = Self {
                phase,
                ..Self::default()
            };
            return;
        }
        if line.contains("Mission Complete Bonus:") {
            self.phase = "complete";
            self.info_left = 0;
            return;
        }
        if (line.contains("Client loaded {") || line.contains("Host loading {"))
            && line.contains("MissionInfo")
        {
            *self = Self {
                phase: "mission",
                info_left: 256,
                ..Self::default()
            };
            if let Some(name) = field(line, "name") {
                self.set_node(name);
            }
        }
        if self.info_left > 0 {
            self.info_left -= 1;
            if let Some(location) = field(line, "location") {
                let kind = self.kind_from_log.then(|| self.kind.clone()).flatten();
                self.set_node(location);
                if kind.is_some() {
                    self.kind = kind;
                }
            }
            if let Some(kind) = field(line, "missionType").and_then(mission_type) {
                self.kind = Some(kind);
                self.kind_from_log = true;
            }
        }
        // arbitration suitType is a random boost, not evidence of the equipped frame
    }
}
fn planet_art(planet: &str) -> Option<String> {
    let key = planet.to_ascii_lowercase();
    matches!(
        key.as_str(),
        "mercury"
            | "venus"
            | "earth"
            | "lua"
            | "mars"
            | "deimos"
            | "phobos"
            | "ceres"
            | "jupiter"
            | "europa"
            | "saturn"
            | "uranus"
            | "neptune"
            | "pluto"
            | "eris"
            | "sedna"
            | "void"
    )
    .then(|| util::art::url("warframe", &key))
}
fn build(s: &State, settings: &Settings) -> Live {
    let details = match s.phase {
        "orbiter" => "In the orbiter".into(),
        "relay" => "In a relay".into(),
        "dojo" => "In the dojo".into(),
        "complete" => "Mission complete".into(),
        "mission" => match (&s.node, &s.planet) {
            (Some(node), Some(planet)) => format!("{node}, {planet}"),
            _ => return Live::default(),
        },
        _ => return Live::default(),
    };
    let mut bits = Vec::new();
    if s.phase == "complete" {
        if let Some(node) = &s.node {
            bits.push(node.clone());
        }
        if let Some(planet) = &s.planet {
            bits.push(planet.clone());
        }
    }
    if settings.flag("show_mission_type") {
        if let Some(kind) = &s.kind {
            bits.push(kind.clone());
        }
    }
    Live {
        details: util::clamp(details),
        state: util::clamp(bits.join(", ")),
        large_image: Some(
            s.planet
                .as_deref()
                .and_then(planet_art)
                .unwrap_or_else(|| util::art::steam_header("230410")),
        ),
        large_text: s
            .planet
            .as_ref()
            .and_then(|p| util::clamp(p.clone()))
            .or_else(|| util::clamp("Warframe")),
        ..Live::default()
    }
}
fn preview(settings: &Settings, scenario: &str) -> Preview {
    let mut s = State::default();
    match scenario {
        "relay" => s.parse("Sys [Info]: ===[ Game successfully connected to: /Lotus/Levels/TennoHub/Relay/Relay.lp ]==="),
        "dojo" => s.parse("Sys [Info]: ===[ Game successfully connected to: /Lotus/Levels/ClanHall/ClanHall.level ]==="),
        "mission" | "complete" => {
            s.parse("282.067 Sys [Info]: Client loaded {\"name\":\"SolNode42_Alert\"} with MissionInfo:");
            s.parse("    \"missionType\" : \"MT_DEFENSE\",");
            s.parse("    \"location\" : \"SolNode42\",");
            if scenario == "complete" { s.parse("500.0 Script [Info]: Mission Complete Bonus: 10000"); }
        },
        _ => s.parse("112.501 Sys [Info]: ===[ Game successfully connected to: /Lotus/Levels/Proc/PlayerShip/DOA.lp ]==="),
    }
    Preview {
        game: "Warframe",
        icon: None,
        live: build(&s, settings),
    }
}
fn run(ctx: &Ctx) {
    let path = std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Warframe/EE.log"));
    let mut follower = log::Follower::default();
    let mut state = State::default();
    loop {
        follower.poll(
            path.clone(),
            ctx.target().started_at_ms,
            &mut state,
            State::parse,
        );
        ctx.emit(Some(build(&state, ctx.settings())));
        if !ctx.sleep(Duration::from_secs(5)) {
            return;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn documented_mission_hub_completion_and_unknown() {
        let mut s = State::default();
        s.parse(
            "282.067 Sys [Info]: Client loaded {\"name\":\"SolNode42_Alert\"} with MissionInfo:",
        );
        s.parse("    \"missionType\" : \"MT_DEFENSE\",");
        s.parse("    \"location\" : \"SolNode42\",");
        assert_eq!(s.node.as_deref(), Some("Helene"));
        assert_eq!(s.planet.as_deref(), Some("Saturn"));
        assert_eq!(s.kind.as_deref(), Some("Defense"));
        s.parse("300.0 Script [Info]: Background.lua: EliteAlert: generated boosts for Sample: suitType=/Lotus/Powersuits/Loki/Loki wepType=/Lotus/Weapons/Test");
        assert_eq!(s.node.as_deref(), Some("Helene"));
        s.parse("500.0 Script [Info]: Mission Complete Bonus: 10000");
        assert_eq!(s.phase, "complete");
        s.parse("112.501 Sys [Info]: ===[ Game successfully connected to: /Lotus/Levels/Proc/PlayerShip/DOA.lp ]===");
        assert_eq!(s.phase, "orbiter");
        assert!(s.node.is_none());
        s.parse("Sys [Info]: Client loaded {\"name\":\"Unknown\"} with MissionInfo:");
        assert!(s.node.is_none());
        assert!(build(&s, &Settings::new(&MANIFEST, json!({}))).is_empty());
        s.parse("Main Shutdown Complete.");
        assert_eq!(s.phase, "");
    }
    #[test]
    fn scenarios_fallback_and_option() {
        let a = Settings::new(&MANIFEST, json!({}));
        let b = Settings::new(&MANIFEST, json!({"show_mission_type":false}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&a, key).live.is_empty());
        }
        assert_eq!(preview(&a, "unknown").live, preview(&a, "orbiter").live);
        assert_ne!(preview(&a, "mission").live, preview(&b, "mission").live);
        assert!(planet_art("Private planet").is_none());
    }
}
