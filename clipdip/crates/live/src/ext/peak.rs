//! Biome, ascent, run clock and party size for PEAK from the game's own Player.log. Built from the
//! log lines the game writes (`Set hero title`, `Going to segment`, `Ascent set to`), no reference
//! project.

use std::path::PathBuf;
use std::time::Duration;

use crate::util::tail::Tail;
use crate::util::{art, clamp, exe_name, now_ms};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "peak",
    name: "PEAK",
    blurb: "Shows the biome you're climbing with its picture, the ascent, your party and the run's time.",
    setup: None,
    credits: &[Credit {
        project: "PEAK Player.log",
        author: "Aggro Crab, Landfall",
        url: "https://store.steampowered.com/app/3527290",
        license: "docs",
    }],
    options: &[
        Opt::toggle("show_ascent", "Show ascent", "The difficulty you picked, like Ascent 3.", true),
        Opt::toggle("show_party", "Show party size", "How many scouts are in your lobby.", true),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &["1384276457596911676"],
    // the header sits under a hashed path, the hero doesn't
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/3527290/library_hero.jpg"),
    preview,
    scenarios: &[("climb", "Climbing"), ("airport", "Airport"), ("ascent", "Higher ascent"), ("solo", "Solo")],
    steam_game: true,
    listed: true,
};

const PACK: &str = "peak";
const MAX_PLAYERS: u32 = 4;
// one run logs a few MB of item and physics noise, the scene line can sit far back
const HISTORY: u64 = 4 << 20;

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str()) || exe_name(t) == "peak.exe"
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
enum Scene {
    #[default]
    Menu,
    Airport,
    /// on the island, `Level_<n>` rotates daily
    Run,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct State {
    scene: Scene,
    /// a pack key
    biome: Option<&'static str>,
    ascent: i32,
    /// the island's variant for slots 1 and 2, from "Disabling segment: n with parent: X_Segment"
    slot1: Option<&'static str>,
    slot2: Option<&'static str>,
    /// hashed names from "Registering Player object for", since the last scene load
    players: Vec<u64>,
    in_lobby: bool,
    run_start: Option<i64>,
}

fn hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// Hero titles ("SHORE"), segment names ("Beach", "Tropics") and segment parents ("Snow_Segment")
/// all to a pack key.
fn biome(name: &str) -> Option<&'static str> {
    let n = art::norm(name);
    let n = n.strip_suffix("segment").unwrap_or(&n);
    Some(match n {
        "shore" | "beach" => "shore",
        "tropics" | "jungle" => "tropics",
        "roots" | "redwood" => "roots",
        "alpine" | "snow" => "alpine",
        "mesa" | "desert" => "mesa",
        "caldera" => "caldera",
        "kiln" | "thekiln" | "volcano" => "kiln",
        "peak" | "thepeak" => "peak",
        _ => return None,
    })
}

fn label(key: &str) -> &'static str {
    match key {
        "shore" => "Shore",
        "tropics" => "Tropics",
        "roots" => "Roots",
        "alpine" => "Alpine",
        "mesa" => "Mesa",
        "caldera" => "Caldera",
        "kiln" => "The Kiln",
        "peak" => "The Peak",
        _ => "Airport",
    }
}

impl State {
    /// `now`: the time a live line was read, None while catching up on history
    fn feed(&mut self, line: &str, now: Option<i64>) {
        let line = line.trim();
        if let Some(scene) = line.strip_prefix("Network Connector is starting in scene: ") {
            let scene = scene.trim().trim_end_matches('.');
            self.players.clear();
            self.biome = None;
            if scene.eq_ignore_ascii_case("Airport") {
                self.scene = Scene::Airport;
                self.run_start = None;
                self.slot1 = None;
                self.slot2 = None;
            } else if scene.starts_with("Level_") {
                self.scene = Scene::Run;
                self.biome = Some("shore");
            } else {
                self.scene = Scene::Menu;
            }
        } else if line.starts_with("Begin scene load RPC: Level_")
            || line.starts_with("PHOTON: Loading Level: Level_")
        {
            if self.run_start.is_none() {
                self.run_start = now;
            }
        } else if let Some(t) = line.strip_prefix("Set hero title: ") {
            if let Some(b) = biome(t) {
                self.biome = Some(b);
            }
        } else if let Some(seg) = line.strip_prefix("Going to segment: ") {
            // the segment enum keeps the base names, the variant decides what the slot really is
            self.biome = match biome(seg) {
                Some("tropics") => self.slot1.or(Some("tropics")),
                Some("alpine") => self.slot2.or(Some("alpine")),
                other => other.or(self.biome),
            };
        } else if let Some(rest) = line.strip_prefix("Disabling segment: ") {
            let Some((slot, parent)) = rest.split_once(" with parent: ") else {
                return;
            };
            match slot.trim() {
                "1" => self.slot1 = biome(parent),
                "2" => self.slot2 = biome(parent),
                _ => {}
            }
        } else if let Some(a) = line.strip_prefix("Ascent set to ") {
            if let Ok(a) = a.trim().parse::<i32>() {
                self.ascent = a.clamp(-1, 99);
            }
        } else if let Some(rest) = line.strip_prefix("Registering Player object for ") {
            // "<name> : <actor>", only the name's hash is kept
            let name = rest.rsplit_once(" : ").map_or(rest, |(n, _)| n);
            let h = hash(name);
            if !self.players.contains(&h) && self.players.len() < 32 {
                self.players.push(h);
            }
        } else if line.starts_with("Lobby Created: ") || line.starts_with("Entered Steam Lobby: ") {
            self.in_lobby = true;
        } else if line.starts_with("Leaving current lobby: ") {
            self.in_lobby = false;
        } else if line.starts_with("Everyone has closed end screen") {
            self.run_start = None;
        }
    }
}

fn ascent_name(a: i32) -> Option<String> {
    match a {
        a if a < 0 => Some("Tenderfoot".into()),
        0 => None,
        a => Some(format!("Ascent {a}")),
    }
}

fn build(s: &State, settings: &Settings) -> Option<Live> {
    let mut live = Live::default();
    match s.scene {
        Scene::Menu => return None,
        Scene::Airport => {
            live.details = clamp("At the airport");
            live.large_image = Some(art::url(PACK, "airport"));
            live.large_text = clamp("Airport");
        }
        Scene::Run => {
            let key = s.biome.unwrap_or("shore");
            let mut details = label(key).to_string();
            if settings.flag("show_ascent") {
                if let Some(a) = ascent_name(s.ascent) {
                    details = format!("{details}, {a}");
                }
            }
            live.details = clamp(details);
            live.large_image = Some(art::url(PACK, key));
            live.large_text = clamp(label(key));
            live.start_ms = s.run_start;
        }
    }
    let n = s.players.len() as u32;
    live.state = clamp(if n > 1 { "In a party" } else { "Solo" });
    if n > 1 && settings.flag("show_party") {
        live.party = Some([n, MAX_PLAYERS.max(n)]);
    }
    Some(live)
}

fn preview(settings: &Settings, scenario: &str) -> Preview {
    let airport = [
        "Entered Steam Lobby: 1",
        "Network Connector is starting in scene: Airport. ",
        "Registering Player object for Friend : 1",
        "Registering Player object for You : 2",
    ];
    let run = [
        "Begin scene load RPC: Level_6",
        "Network Connector is starting in scene: Level_6. ",
        "Registering Player object for Friend : 1",
        "Registering Player object for You : 2",
        "Disabling segment: 1 with parent: Jungle_Segment",
        "Disabling segment: 2 with parent: Desert_Segment",
        "Set hero title: SHORE",
        "Going to segment: Tropics",
        "Set hero title: TROPICS",
    ];
    let lines: Vec<&str> = match scenario {
        "airport" => airport.to_vec(),
        "ascent" => [
            &airport[..],
            &["Ascent set to 4"],
            &run[..],
            &["Going to segment: Alpine", "Set hero title: MESA"],
        ]
        .concat(),
        "solo" => vec![
            "Network Connector is starting in scene: Level_6. ",
            "Registering Player object for You : 1",
            "Set hero title: SHORE",
        ],
        _ => [&airport[..], &run[..]].concat(),
    };
    let mut s = State::default();
    // a fixed run start so the preview shows a clock
    lines
        .iter()
        .for_each(|l| s.feed(l, Some(1_700_000_000_000)));
    Preview {
        game: "PEAK",
        icon: None,
        live: build(&s, settings).unwrap_or_default(),
    }
}

fn player_log() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(local)
            .parent()?
            .join("LocalLow")
            .join("LandCrab")
            .join("PEAK")
            .join("Player.log"),
    )
}

fn modified_ms(p: &std::path::Path) -> Option<i64> {
    let t = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as i64)
}

fn run(ctx: &Ctx) {
    let Some(path) = player_log() else { return };
    // the last launch's log stays until the game rewrites it on start, Tail notices that
    let fresh = modified_ms(&path).is_some_and(|m| m + 60_000 >= ctx.target().started_at_ms);
    let mut tail = Tail::new(path, if fresh { HISTORY } else { 0 });
    let mut state = State::default();
    let mut caught_up = false;
    loop {
        // history has no timestamps, so a run already going when we start gets no clock
        let now = caught_up.then(now_ms);
        tail.poll(|l| state.feed(l, now));
        caught_up = true;
        ctx.emit(build(&state, ctx.settings()));
        if !ctx.sleep(Duration::from_secs(4)) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // trimmed from a real Player.log (item, physics and voice noise left out), names replaced
    const LOG: &str = "Steam Lobby Handler initialized
On Lobby Join Requested: 100000000000000001 by 76500000000000001
Joining lobby: 100000000000000001
Entered Steam Lobby: 100000000000000001
Network Connector is starting in scene: Airport.
On Joined Photon Room. No Character
Registering Player object for Friend : 1
Ascent set to 0
Spawning myself (You [2]) at (-9.63, 1.87, 50.51)! (Flavor: Lobby)
Registering Player object for You : 2
Begin scene load RPC: Level_6
Ascent set to 0
PHOTON: Loading Level: Level_6
Network Connector is starting in scene: Level_6.
Registering Player object for Friend : 1
Registering Player object for You : 2
LastRevived: Beach, LastSegment: Beach
Disabling segment: 1 with parent: Jungle_Segment
Disabling segment: 2 with parent: Desert_Segment
Disabling segment: 3 with parent: Caldera_Segment
Disabling segment: 4 with parent: Volcano_Segment
Set hero title: SHORE
Going to segment: Tropics
Segment complete: 1
Set hero title: TROPICS";

    fn settings(v: serde_json::Value) -> Settings {
        Settings::new(&MANIFEST, v)
    }

    #[test]
    fn run_from_log() {
        let mut s = State::default();
        LOG.lines().for_each(|l| s.feed(l, None));
        assert_eq!(s.scene, Scene::Run);
        assert_eq!(s.biome, Some("tropics"));
        assert_eq!(s.slot2, Some("mesa"));
        assert_eq!(s.players.len(), 2);
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.details.as_deref(), Some("Tropics"));
        assert_eq!(live.state.as_deref(), Some("In a party"));
        assert_eq!(live.party, Some([2, 4]));
        assert_eq!(live.large_image, Some(art::url("peak", "tropics")));
        // history only, no clock
        assert_eq!(live.start_ms, None);

        // no hero title yet: the segment plus the island's variant
        s.feed("Going to segment: Alpine", Some(5));
        assert_eq!(s.biome, Some("mesa"));
        s.feed("Set hero title: CALDERA", Some(6));
        assert_eq!(
            build(&s, &settings(serde_json::json!({})))
                .unwrap()
                .details
                .as_deref(),
            Some("Caldera")
        );

        s.feed("Everyone has closed end screen.. Loading airport", Some(7));
        s.feed("PHOTON: Loading Level: Airport", Some(7));
        s.feed("Network Connector is starting in scene: Airport. ", Some(8));
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.details.as_deref(), Some("At the airport"));
        assert_eq!(live.party, None);
        assert_eq!(live.state.as_deref(), Some("Solo"));
    }

    #[test]
    fn live_run_gets_a_clock_and_ascent() {
        let mut s = State::default();
        s.feed("Ascent set to 3", Some(1));
        s.feed("Begin scene load RPC: Level_10", Some(1_000));
        s.feed(
            "Network Connector is starting in scene: Level_10. ",
            Some(2_000),
        );
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.start_ms, Some(1_000));
        assert_eq!(live.details.as_deref(), Some("Shore, Ascent 3"));
        let off = build(&s, &settings(serde_json::json!({ "show_ascent": false }))).unwrap();
        assert_eq!(off.details.as_deref(), Some("Shore"));
        s.feed("Ascent set to -1", Some(3_000));
        assert_eq!(
            build(&s, &settings(serde_json::json!({})))
                .unwrap()
                .details
                .as_deref(),
            Some("Shore, Tenderfoot")
        );
    }

    #[test]
    fn menu_shows_nothing() {
        let s = State::default();
        assert_eq!(build(&s, &settings(serde_json::json!({}))), None);
        assert_eq!(biome("The Kiln"), Some("kiln"));
        assert_eq!(biome("Snow_Segment"), Some("alpine"));
        assert_eq!(biome("Lobby"), None);
    }

    #[test]
    fn previews() {
        let s = settings(serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(preview(&s, key).live.details.is_some(), "{key}");
        }
        assert_eq!(
            preview(&s, "nope").live,
            preview(&s, MANIFEST.scenarios[0].0).live
        );
        assert_eq!(
            preview(&s, "ascent").live.details.as_deref(),
            Some("Mesa, Ascent 4")
        );
        let off = settings(serde_json::json!({ "show_party": false, "show_ascent": false }));
        assert_eq!(preview(&off, "climb").live.party, None);
        assert_eq!(
            preview(&off, "ascent").live.details.as_deref(),
            Some("Mesa")
        );
        assert_eq!(preview(&s, "climb").live.start_ms, Some(1_700_000_000_000));
    }
}
