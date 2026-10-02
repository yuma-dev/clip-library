//! Vehicle, battle mode and hangar / test drive / battle from War Thunder's localhost API on
//! port 8111. Ported from WarThunderRPC-Plus by Chawannua (MIT),
//! https://github.com/chawannua/WarThunderRPC-Plus: wtrpc/__main__.py (activity and its
//! confirmation), modes.py, contacts.py (battle markers), naming.py, presence_builder.py; and
//! WT-Discord by sirrobindoger (MIT), https://github.com/sirrobindoger/WT-Discord:
//! warthunder_rpc/vehicle_images.py (wiki names, encyclopedia images, name fallback).

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

use crate::util::{self, art, clamp};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "war_thunder",
    name: "War Thunder",
    blurb: "Vehicle picture, battle mode and hangar or battle state.",
    setup: None,
    credits: &[
        Credit {
            project: "WarThunderRPC-Plus",
            author: "Chawannua",
            url: "https://github.com/chawannua/WarThunderRPC-Plus",
            license: "MIT",
        },
        Credit {
            project: "WT-Discord",
            author: "sirrobindoger",
            url: "https://github.com/sirrobindoger/WT-Discord",
            license: "MIT",
        },
    ],
    options: &[
        Opt::toggle(
            "show_flight_data",
            "Show flight data",
            "Mach and airspeed for aircraft, remaining crew for tanks and ships.",
            true,
        ),
        Opt::toggle(
            "show_vehicle_image",
            "Show vehicle picture",
            "The vehicle from the encyclopedia as the big image.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[GAME_ID],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/236390/library_hero.jpg"),
    preview,
    scenarios: &[
        ("hangar", "In the hangar"),
        ("loading", "Loading"),
        ("test_drive", "Test drive"),
        ("ground_battle", "Ground battle"),
        ("air_battle", "Air battle"),
    ],
    steam_game: true,
    listed: true,
};

const GAME_ID: &str = "357607478105604096";
const STEAM_APPID: &str = "236390";
const BASE: &str = "http://127.0.0.1:8111";
const TICK: Duration = Duration::from_secs(5);
// the original's offline poll, longer here since nothing else needs us meanwhile
const OFFLINE: Duration = Duration::from_secs(12);

const IMAGE_BASE: &str = "https://static.encyclopedia.warthunder.com/images/";
const WIKI_UNIT: &str = "https://wiki.warthunder.com/unit/";
// the title sits in <head>, no need to pull the whole ~200 KB page
const WIKI_READ: u64 = 64 * 1024;
const NAMES_FILE: &str = "vehicles.tsv";
// names and pictures barely change, a month keeps renames from sticking forever
const NAMES_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);

// consecutive polls that must agree before an activity change is believed: the game's
// http server stalls under load and one dropped answer would reset the clock mid battle
const CONFIRMATIONS: u32 = 2;
// spawning into a battle looks like a test drive for ~6 s until mission.json has objectives
const LOADING_TO_TEST_DRIVE: u32 = 6;
// Mach says nothing below this (a parked jet reads 0.00, a helicopter ~0.05)
const MIN_MACH: f64 = 0.30;
const MIN_IAS_KPH: f64 = 20.0;

fn matches(t: &Target) -> bool {
    t.game_id == GAME_ID || t.game_id == "steam:236390" || util::exe_name(t) == "aces.exe"
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum Activity {
    #[default]
    Unknown,
    Hangar,
    Loading,
    TestDrive,
    InMatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
enum Army {
    Air,
    Tank,
    Ship,
    #[default]
    Unknown,
}

impl Army {
    fn parse(v: &str) -> Army {
        match v.trim().to_ascii_lowercase().as_str() {
            "air" => Army::Air,
            "tank" => Army::Tank,
            "ship" => Army::Ship,
            _ => Army::Unknown,
        }
    }

    fn word(self) -> &'static str {
        match self {
            Army::Air => "Air",
            Army::Tank => "Ground",
            Army::Ship => "Naval",
            Army::Unknown => "",
        }
    }
}

/// `/indicators` reports `tankModels/us_m1_abrams` style names, and `dummy_plane` while
/// respawning or at match start.
fn vehicle_id(raw: &str) -> Option<String> {
    let id = raw.trim().rsplit('/').next().unwrap_or("").trim();
    if id.is_empty() || id.to_ascii_lowercase().starts_with("dummy_") {
        return None;
    }
    Some(id.to_string())
}

fn primary_objective(mission: Option<&Value>) -> Option<String> {
    mission?
        .get("objectives")?
        .as_array()?
        .iter()
        .filter(|o| o.get("primary").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|o| o.get("text")?.as_str())
        .find(|t| !t.trim().is_empty())
        .map(str::to_string)
}

/// `(english prefix, label, needs the Air/Ground/Naval word)`. mission.json is in the
/// client's language, so anything else falls back to "<army> Battle".
const MODE_PREFIXES: &[(&str, &str, bool)] = &[
    (
        "capture and maintain superiority over the airfields",
        "Air Domination",
        false,
    ),
    ("capture and hold airfields.", "Air Domination", false),
    ("capture and hold the airfield", "Air Domination", false),
    (
        "capture and maintain superiority over the air zone",
        "Air Domination",
        false,
    ),
    (
        "capture and maintain superiority over the points",
        "Domination",
        true,
    ),
    ("capture the enemy point", "Battle", true),
    ("prevent capture of allied point", "Battle", true),
    ("prevent the capture of the allied point", "Battle", true),
    ("capture and keep hold of the point", "Conquest", true),
    (
        "destroy the enemy ground vehicles",
        "Air Ground Strike",
        false,
    ),
    ("destroy the highlighted targets", "Air Frontline", false),
    ("assist the ground forces", "Air Ground Strike", false),
];

fn classify_mode(objective: &str, army: Army) -> String {
    let text = objective.trim().to_lowercase();
    for (prefix, label, needs_word) in MODE_PREFIXES {
        if text.starts_with(prefix) {
            if !needs_word || army.word().is_empty() {
                return label.to_string();
            }
            return format!("{} {label}", army.word());
        }
    }
    if army.word().is_empty() {
        return String::new();
    }
    format!("{} Battle", army.word())
}

// a test flight has ground targets and airfields but nothing to respawn at or capture
const MATCH_ONLY_MARKERS: &[&str] = &[
    "respawn_base_tank",
    "respawn_base_bomber",
    "respawn_base_fighter",
    "capture_zone",
    "defending_point",
];
const AIR_RESPAWNS: &[&str] = &[
    "respawn_base_fighter",
    "respawn_base_bomber",
    "respawn_base_ucav",
];

fn marker_names(markers: &[Value]) -> impl Iterator<Item = String> + '_ {
    markers.iter().flat_map(|m| {
        ["type", "icon"].into_iter().filter_map(move |f| {
            m.get(f)
                .and_then(Value::as_str)
                .map(|s| s.trim().to_ascii_lowercase())
        })
    })
}

fn looks_like_a_match(markers: &[Value]) -> bool {
    marker_names(markers).any(|n| MATCH_ONLY_MARKERS.contains(&n.as_str()))
}

/// Ground battles have tank respawns on the minimap, air battles never do. None = can't tell.
fn battle_is_ground(markers: &[Value]) -> Option<bool> {
    let (mut ground, mut air) = (false, false);
    for n in marker_names(markers) {
        if n == "respawn_base_tank" {
            ground = true;
        } else if AIR_RESPAWNS.contains(&n.as_str()) {
            air = true;
        }
    }
    if ground {
        Some(true)
    } else if air {
        Some(false)
    } else {
        None
    }
}

fn number(v: &Value, key: &str) -> Option<f64> {
    let v = v.get(key)?;
    if v.is_boolean() {
        return None;
    }
    v.as_f64().filter(|n| n.is_finite())
}

/// One poll of the game's API, `None` fields where a request failed.
#[derive(Debug, Default)]
struct Sample {
    indicators: Value,
    /// map_info.json `valid`
    in_map: Option<bool>,
    /// mission.json answered (it serves an empty body in the hangar)
    mission_ok: bool,
    objective: Option<String>,
    markers: Vec<Value>,
    state: Value,
}

/// What the card shows, latched across polls.
#[derive(Clone, Debug, Default, PartialEq)]
struct Shown {
    activity: Activity,
    army: Army,
    vehicle: Option<String>,
    mode: String,
    mach: Option<f64>,
    ias_kph: Option<f64>,
    crew: Option<(u32, u32)>,
    /// unix ms the activity began
    since_ms: i64,
}

#[derive(Default)]
struct Tracker {
    shown: Shown,
    candidate: Option<Activity>,
    candidate_count: u32,
    last_in_map: bool,
    last_in_match: bool,
    latched_mode: String,
}

impl Tracker {
    fn set_activity(&mut self, activity: Activity, now_ms: i64) {
        if activity == self.shown.activity {
            self.candidate = None;
            self.candidate_count = 0;
            return;
        }
        if self.candidate == Some(activity) {
            self.candidate_count += 1;
        } else {
            self.candidate = Some(activity);
            self.candidate_count = 1;
        }
        let needed = if (self.shown.activity, activity) == (Activity::Loading, Activity::TestDrive)
        {
            LOADING_TO_TEST_DRIVE
        } else {
            CONFIRMATIONS
        };
        if self.candidate_count < needed {
            return;
        }
        self.shown.activity = activity;
        self.shown.since_ms = now_ms;
        self.candidate = None;
        self.candidate_count = 0;
    }

    // the mode is latched once the battle itself says what it is, the player's vehicle can
    // change mid match (a helicopter in Ground RB) and says nothing during the load screen
    fn match_mode(&mut self, objective: &str, army: Army, markers: &[Value]) -> String {
        if matches!(self.shown.activity, Activity::Hangar | Activity::Unknown) {
            self.latched_mode.clear();
            return String::new();
        }
        if !self.latched_mode.is_empty() {
            return self.latched_mode.clone();
        }
        let is_ground = battle_is_ground(markers);
        let battle_army = match is_ground {
            Some(true) => Army::Tank,
            Some(false) => Army::Air,
            None => army,
        };
        let candidate = classify_mode(objective, battle_army);
        if is_ground.is_some() {
            self.latched_mode = candidate.clone();
        }
        candidate
    }

    fn update(&mut self, s: &Sample, now_ms: i64) {
        // a failed request is not evidence that the player left the map or the match
        let in_map = s.in_map.unwrap_or(self.last_in_map);
        self.last_in_map = in_map;
        let in_match = if s.mission_ok {
            s.objective.is_some()
        } else {
            self.last_in_match
        };
        self.last_in_match = in_match;

        let raw_type = s
            .indicators
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("");
        let vehicle = vehicle_id(raw_type);
        let vehicle_valid = s
            .indicators
            .get("valid")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let army = Army::parse(
            s.indicators
                .get("army")
                .and_then(Value::as_str)
                .unwrap_or(""),
        );

        let activity = if !in_map {
            Activity::Hangar
        } else if !vehicle_valid || vehicle.is_none() {
            Activity::Loading
        } else if in_match || looks_like_a_match(&s.markers) {
            Activity::InMatch
        } else {
            Activity::TestDrive
        };
        self.set_activity(activity, now_ms);

        let flying = matches!(self.shown.activity, Activity::InMatch | Activity::TestDrive);
        let mode = self.match_mode(s.objective.as_deref().unwrap_or(""), army, &s.markers);
        self.shown.mode = mode;
        if flying && vehicle.is_some() {
            self.shown.vehicle = vehicle;
            self.shown.army = army;
        } else if !flying {
            self.shown.vehicle = None;
        }
        self.shown.mach = None;
        self.shown.ias_kph = None;
        self.shown.crew = None;
        if flying {
            match army {
                Army::Air => {
                    self.shown.mach = number(&s.state, "M");
                    // tens of km/h is plenty and keeps the card from changing every poll
                    self.shown.ias_kph =
                        number(&s.state, "IAS, km/h").map(|v| (v / 10.0).round() * 10.0);
                }
                Army::Tank | Army::Ship => {
                    let cur = number(&s.indicators, "crew_current");
                    let total = number(&s.indicators, "crew_total");
                    if let (Some(c), Some(t)) = (cur, total) {
                        if t >= 1.0 && c >= 0.0 {
                            self.shown.crew = Some((c as u32, t as u32));
                        }
                    }
                }
                Army::Unknown => {}
            }
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
struct VehicleInfo {
    name: String,
    has_image: bool,
}

const COUNTRY_PREFIXES: &[&str] = &[
    "us", "usa", "germ", "ger", "ussr", "uk", "sw", "jp", "cn", "it", "fr", "il",
];
const TRAILING_FAMILY_NAMES: &[&str] = &[
    "abrams",
    "sherman",
    "patton",
    "leclerc",
    "merkava",
    "challenger",
    "centurion",
    "crusader",
    "churchill",
    "comet",
    "matilda",
    "stuart",
    "grant",
    "lee",
];

// WT-Discord's fallback when the wiki has no page
fn humanize(id: &str) -> String {
    let mut tokens: Vec<&str> = id.split('_').filter(|t| !t.is_empty()).collect();
    if tokens
        .first()
        .is_some_and(|t| COUNTRY_PREFIXES.contains(&t.to_ascii_lowercase().as_str()))
    {
        tokens.remove(0);
    }
    while tokens.len() > 1 {
        let (Some(first), Some(last)) = (tokens.first(), tokens.last()) else {
            break;
        };
        if last.chars().all(char::is_alphabetic) && last.eq_ignore_ascii_case(first) {
            tokens.pop();
        } else {
            break;
        }
    }
    if tokens.len() > 1
        && tokens
            .last()
            .is_some_and(|t| TRAILING_FAMILY_NAMES.contains(&t.to_ascii_lowercase().as_str()))
    {
        tokens.pop();
    }
    let words: Vec<String> = tokens
        .iter()
        .map(|t| {
            if t.chars().any(|c| c.is_ascii_digit()) || t.chars().count() <= 3 {
                t.to_uppercase()
            } else {
                let mut c = t.chars();
                match c.next() {
                    Some(f) => f
                        .to_uppercase()
                        .chain(c.flat_map(char::to_lowercase))
                        .collect(),
                    None => String::new(),
                }
            }
        })
        .collect();
    let out = words.join(" ");
    if out.is_empty() {
        id.to_string()
    } else {
        out
    }
}

/// `<title>Pz.IV F2 | War Thunder Wiki</title>` -> "Pz.IV F2".
fn wiki_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title>")? + "<title>".len();
    let end = start + lower.get(start..)?.find("</title>")?;
    let raw = html.get(start..end)?;
    let title = raw
        .replace("&nbsp;", " ")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace('\u{a0}', " ");
    let title = title.trim();
    let title = match title.rfind('|') {
        Some(i)
            if title
                .get(i..)
                .is_some_and(|s| s.to_ascii_lowercase().contains("war thunder wiki")) =>
        {
            title.get(..i).unwrap_or("").trim()
        }
        _ => title,
    };
    if title.is_empty() || title.eq_ignore_ascii_case("page not found") {
        return None;
    }
    Some(title.to_string())
}

fn image_url(id: &str) -> String {
    format!("{IMAGE_BASE}{id}.png")
}

struct Vehicles {
    known: HashMap<String, VehicleInfo>,
    file: Option<PathBuf>,
    agent: ureq::Agent,
}

impl Vehicles {
    fn open(cache_dir: Option<PathBuf>) -> Vehicles {
        let file = cache_dir.map(|d| d.join(NAMES_FILE));
        let mut known = HashMap::new();
        if let Some(f) = &file {
            let fresh = std::fs::metadata(f)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age < NAMES_MAX_AGE);
            if fresh {
                if let Ok(text) = std::fs::read_to_string(f) {
                    known = parse_names(&text);
                }
            }
        }
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(1))
            .timeout(Duration::from_secs(2))
            .user_agent(util::http::USER_AGENT)
            .build();
        Vehicles { known, file, agent }
    }

    fn get(&mut self, id: &str) -> VehicleInfo {
        if let Some(v) = self.known.get(id) {
            return v.clone();
        }
        let name = self.fetch_name(id).unwrap_or_else(|| humanize(id));
        let has_image = self.image_exists(id);
        let info = VehicleInfo { name, has_image };
        self.known.insert(id.to_string(), info.clone());
        self.save();
        info
    }

    fn fetch_name(&self, id: &str) -> Option<String> {
        let res = self.agent.get(&format!("{WIKI_UNIT}{id}")).call().ok()?;
        let mut buf = Vec::new();
        res.into_reader()
            .take(WIKI_READ)
            .read_to_end(&mut buf)
            .ok()?;
        wiki_title(&String::from_utf8_lossy(&buf))
    }

    fn image_exists(&self, id: &str) -> bool {
        match self.agent.head(&image_url(id)).call() {
            Ok(r) => r.content_type().starts_with("image/"),
            Err(_) => false,
        }
    }

    fn save(&self) {
        let Some(f) = &self.file else { return };
        let mut out = String::new();
        for (id, v) in &self.known {
            out.push_str(&format!(
                "{id}\t{}\t{}\n",
                v.name.replace(['\t', '\n'], " "),
                u8::from(v.has_image)
            ));
        }
        let _ = std::fs::write(f, out);
    }
}

fn parse_names(text: &str) -> HashMap<String, VehicleInfo> {
    text.lines()
        .filter_map(|l| {
            let mut parts = l.split('\t');
            let id = parts.next()?.trim();
            let name = parts.next()?.trim();
            let has_image = parts.next()?.trim() == "1";
            if id.is_empty() || name.is_empty() {
                return None;
            }
            Some((
                id.to_string(),
                VehicleInfo {
                    name: name.to_string(),
                    has_image,
                },
            ))
        })
        .collect()
}

fn vehicle_bits(s: &Shown, name: &str, show_data: bool) -> String {
    let mut bits = vec![name.to_string()];
    if show_data {
        match s.army {
            Army::Air => {
                if let Some(m) = s.mach.filter(|m| *m >= MIN_MACH) {
                    bits.push(format!("Mach {m:.2}"));
                }
                if let Some(ias) = s.ias_kph.filter(|v| *v >= MIN_IAS_KPH) {
                    bits.push(format!("{} km/h IAS", ias.round() as i64));
                }
            }
            // only once some of the crew is gone, a full crew is the boring default
            Army::Tank | Army::Ship => {
                if let Some((cur, total)) = s.crew.filter(|(c, t)| c < t) {
                    bits.push(format!("{cur}/{total} crew"));
                }
            }
            Army::Unknown => {}
        }
    }
    bits.join(" · ")
}

fn build(s: &Shown, info: Option<&VehicleInfo>, settings: &Settings) -> Option<Live> {
    let show_data = settings.flag("show_flight_data");
    let show_image = settings.flag("show_vehicle_image");
    let mut live = Live::default();
    match s.activity {
        Activity::Unknown => return None,
        Activity::Hangar => {
            live.details = clamp("In the hangar");
        }
        Activity::Loading => {
            live.details = clamp("Loading into a battle");
            live.state = clamp(s.mode.clone());
        }
        Activity::TestDrive | Activity::InMatch => {
            live.details = if s.activity == Activity::TestDrive {
                clamp(if s.army == Army::Air {
                    "Test flight"
                } else {
                    "Test drive"
                })
            } else if s.mode.is_empty() {
                clamp("In battle")
            } else {
                clamp(s.mode.clone())
            };
            if let (Some(id), Some(info)) = (&s.vehicle, info) {
                live.state = clamp(vehicle_bits(s, &info.name, show_data));
                if show_image {
                    live.large_image = Some(if info.has_image {
                        image_url(id)
                    } else {
                        art::steam_header(STEAM_APPID)
                    });
                    live.large_text = clamp(info.name.clone());
                }
            }
            if s.since_ms > 0 {
                live.start_ms = Some(s.since_ms);
            }
        }
    }
    Some(live)
}

fn preview(settings: &Settings, scenario: &str) -> Preview {
    let tank = VehicleInfo {
        name: "Pz.IV F2".into(),
        has_image: true,
    };
    let jet = VehicleInfo {
        name: "F-4E Phantom II".into(),
        has_image: true,
    };
    let start = 1_700_000_000_000;
    let (shown, info) = match scenario {
        "loading" => (
            Shown {
                activity: Activity::Loading,
                mode: "Ground Battle".into(),
                ..Shown::default()
            },
            None,
        ),
        "test_drive" => (
            Shown {
                activity: Activity::TestDrive,
                army: Army::Tank,
                vehicle: Some("germ_pzkpfw_iv_ausf_f2".into()),
                since_ms: start,
                ..Shown::default()
            },
            Some(tank),
        ),
        "ground_battle" => (
            Shown {
                activity: Activity::InMatch,
                army: Army::Tank,
                vehicle: Some("germ_pzkpfw_iv_ausf_f2".into()),
                mode: "Ground Domination".into(),
                crew: Some((3, 5)),
                since_ms: start,
                ..Shown::default()
            },
            Some(tank),
        ),
        "air_battle" => (
            Shown {
                activity: Activity::InMatch,
                army: Army::Air,
                vehicle: Some("f-4e".into()),
                mode: "Air Domination".into(),
                mach: Some(0.94),
                ias_kph: Some(1120.0),
                since_ms: start,
                ..Shown::default()
            },
            Some(jet),
        ),
        _ => (
            Shown {
                activity: Activity::Hangar,
                ..Shown::default()
            },
            None,
        ),
    };
    Preview {
        game: "War Thunder",
        icon: None,
        live: build(&shown, info.as_ref(), settings).unwrap_or_default(),
    }
}

/// Err when the game isn't answering at all, Ok(None) for an empty or odd body (mission.json
/// in the hangar).
fn get(agent: &ureq::Agent, path: &str) -> Result<Option<Value>, ()> {
    let res = agent.get(&format!("{BASE}{path}")).call().map_err(|_| ())?;
    let text = res.into_string().map_err(|_| ())?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(serde_json::from_str(&text).ok())
}

fn poll(agent: &ureq::Agent) -> Option<Sample> {
    let indicators = get(agent, "/indicators").ok()??;
    let map_info = get(agent, "/map_info.json");
    let in_map = match &map_info {
        Ok(Some(v)) => Some(v.get("valid").and_then(Value::as_bool).unwrap_or(false)),
        Ok(None) => Some(false),
        Err(_) => None,
    };
    let mission = get(agent, "/mission.json");
    let mut s = Sample {
        indicators,
        in_map,
        mission_ok: mission.is_ok(),
        objective: primary_objective(mission.ok().flatten().as_ref()),
        ..Sample::default()
    };
    if in_map == Some(true) {
        if let Ok(Some(Value::Array(markers))) = get(agent, "/map_obj.json") {
            s.markers = markers;
        }
        if s.indicators.get("army").and_then(Value::as_str) == Some("air") {
            s.state = get(agent, "/state").ok().flatten().unwrap_or(Value::Null);
        }
    }
    Some(s)
}

fn run(ctx: &Ctx) {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(500))
        .timeout(Duration::from_secs(2))
        .build();
    let mut vehicles = Vehicles::open(ctx.cache_dir());
    let mut tracker = Tracker::default();
    loop {
        let Some(sample) = poll(&agent) else {
            tracker = Tracker::default();
            ctx.emit(None);
            if !ctx.sleep(OFFLINE) {
                return;
            }
            continue;
        };
        tracker.update(&sample, util::now_ms());
        let info = tracker.shown.vehicle.clone().map(|id| vehicles.get(&id));
        ctx.emit(build(&tracker.shown, info.as_ref(), ctx.settings()));
        if !ctx.sleep(TICK) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(values: Value) -> Settings {
        Settings::new(&MANIFEST, values)
    }

    #[test]
    fn every_scenario_has_text_and_unknown_falls_back() {
        let s = settings(json!({}));
        for (key, _) in MANIFEST.scenarios {
            let p = preview(&s, key);
            assert!(p.live.details.is_some(), "{key}");
        }
        assert_eq!(preview(&s, "nope").live, preview(&s, "hangar").live);
    }

    #[test]
    fn options_change_the_card() {
        let on = preview(&settings(json!({})), "air_battle").live;
        assert_eq!(
            on.state.as_deref(),
            Some("F-4E Phantom II · Mach 0.94 · 1120 km/h IAS")
        );
        assert_eq!(
            on.large_image.as_deref(),
            Some("https://static.encyclopedia.warthunder.com/images/f-4e.png")
        );
        let off = preview(
            &settings(json!({"show_flight_data": false, "show_vehicle_image": false})),
            "air_battle",
        )
        .live;
        assert_eq!(off.state.as_deref(), Some("F-4E Phantom II"));
        assert!(off.large_image.is_none());
        let ground = preview(&settings(json!({})), "ground_battle").live;
        assert_eq!(ground.details.as_deref(), Some("Ground Domination"));
        assert_eq!(ground.state.as_deref(), Some("Pz.IV F2 · 3/5 crew"));
    }

    #[test]
    fn vehicle_ids_and_names() {
        assert_eq!(
            vehicle_id("tankModels/cn_al_khalid_i").as_deref(),
            Some("cn_al_khalid_i")
        );
        assert_eq!(vehicle_id("DUMMY_PLANE"), None);
        assert_eq!(vehicle_id("dummy_tank"), None);
        assert_eq!(humanize("germ_pzkpfw_iv_ausf_f2"), "Pzkpfw IV Ausf F2");
        assert_eq!(humanize("us_m1_abrams"), "M1");
        assert_eq!(humanize("ussr_t_34_1941"), "T 34 1941");
        let page = "<html><head><title>Pz.IV F2 | War Thunder Wiki</title></head>";
        assert_eq!(wiki_title(page).as_deref(), Some("Pz.IV F2"));
        assert_eq!(
            wiki_title("<title>Page not found | War Thunder Wiki</title>"),
            None
        );
        assert_eq!(
            wiki_title("<title>M4A3E2 &quot;Jumbo&quot; | War Thunder Wiki</title>").as_deref(),
            Some("M4A3E2 \"Jumbo\"")
        );
        let names = parse_names("f-4e\tF-4E Phantom II\t1\nbad\n");
        assert_eq!(
            names.get("f-4e"),
            Some(&VehicleInfo {
                name: "F-4E Phantom II".into(),
                has_image: true
            })
        );
        assert_eq!(names.len(), 1);
    }

    #[test]
    fn modes() {
        assert_eq!(
            classify_mode(
                "Capture and maintain superiority over the points",
                Army::Tank
            ),
            "Ground Domination"
        );
        assert_eq!(
            classify_mode("Assist the ground forces", Army::Air),
            "Air Ground Strike"
        );
        assert_eq!(classify_mode("Захватите точку", Army::Ship), "Naval Battle");
        let markers = vec![
            json!({"type": "respawn_base_tank"}),
            json!({"icon": "Fighter"}),
        ];
        assert!(looks_like_a_match(&markers));
        assert_eq!(battle_is_ground(&markers), Some(true));
        assert_eq!(
            battle_is_ground(&[json!({"type": "respawn_base_fighter"})]),
            Some(false)
        );
        assert_eq!(battle_is_ground(&[json!({"type": "airfield"})]), None);
    }

    fn sample(in_map: bool, valid: bool, typ: &str, objective: Option<&str>) -> Sample {
        Sample {
            indicators: json!({"valid": valid, "army": "tank", "type": typ, "crew_total": 5, "crew_current": 4}),
            in_map: Some(in_map),
            mission_ok: true,
            objective: objective.map(str::to_string),
            markers: vec![],
            state: Value::Null,
        }
    }

    #[test]
    fn activity_needs_agreeing_polls() {
        let mut t = Tracker::default();
        t.update(&sample(false, false, "", None), 1);
        assert_eq!(t.shown.activity, Activity::Unknown);
        t.update(&sample(false, false, "", None), 2);
        assert_eq!(t.shown.activity, Activity::Hangar);
        // one stalled answer doesn't leave the hangar
        t.update(&sample(true, false, "dummy_plane", None), 3);
        assert_eq!(t.shown.activity, Activity::Hangar);
        t.update(&sample(true, false, "dummy_plane", None), 4);
        assert_eq!(t.shown.activity, Activity::Loading);
        let battle = sample(
            true,
            true,
            "tankModels/germ_pzkpfw_iv_ausf_f2",
            Some("Capture the enemy point"),
        );
        t.update(&battle, 5);
        t.update(&battle, 6);
        assert_eq!(t.shown.activity, Activity::InMatch);
        assert_eq!(t.shown.since_ms, 6);
        assert_eq!(t.shown.vehicle.as_deref(), Some("germ_pzkpfw_iv_ausf_f2"));
        assert_eq!(t.shown.crew, Some((4, 5)));
        assert_eq!(t.shown.mode, "Ground Battle");
    }

    #[test]
    fn loading_to_test_drive_waits_longer() {
        let mut t = Tracker::default();
        let loading = sample(true, false, "dummy_plane", None);
        t.update(&loading, 1);
        t.update(&loading, 2);
        assert_eq!(t.shown.activity, Activity::Loading);
        let drive = sample(true, true, "germ_pzkpfw_iv_ausf_f2", None);
        for i in 0..5 {
            t.update(&drive, 3 + i);
            assert_eq!(t.shown.activity, Activity::Loading);
        }
        t.update(&drive, 9);
        assert_eq!(t.shown.activity, Activity::TestDrive);
    }

    #[test]
    fn primary_objective_from_mission_json() {
        let m = json!({"objectives": [{"primary": false, "text": "x"}, {"primary": true, "status": "in_progress", "text": "Capture the enemy point"}], "status": "running"});
        assert_eq!(
            primary_objective(Some(&m)).as_deref(),
            Some("Capture the enemy point")
        );
        assert_eq!(primary_objective(Some(&json!({}))), None);
        assert_eq!(primary_objective(None), None);
    }
}
