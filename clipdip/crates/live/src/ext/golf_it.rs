//! Golf It! course, hole and lobby from the game's log, workshop course art from
//! the Steam Web API. Built on the shared Unreal reader (ext/unreal.rs) from the
//! game's own log lines and Valve's ISteamRemoteStorage docs.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::unreal::{self, Game, Session};
use crate::util::{self, art};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "golf_it",
    name: "Golf It!",
    blurb: "Course, hole, lobby and who is hosting.",
    setup: None,
    credits: &[
        unreal::CREDIT,
        Credit {
            project: "Steam Web API, ISteamRemoteStorage",
            author: "Valve",
            url: "https://partner.steamgames.com/doc/webapi/ISteamRemoteStorage",
            license: "docs",
        },
    ],
    options: &[
        Opt::toggle(
            "show_map",
            "Show course",
            "Course name and picture, workshop courses included.",
            true,
        ),
        Opt::toggle("show_hole", "Show hole", "Which hole you're on.", true),
        Opt::toggle(
            "show_session",
            "Show hosting or joined",
            "Whether it's your lobby or a friend's.",
            true,
        ),
        Opt::toggle(
            "show_players",
            "Show player count",
            "Only known while you host.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[GAME_ID],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/571740/library_hero.jpg"),
    preview,
    scenarios: SCENARIOS,
    steam_game: true,
    listed: true,
};

const GAME_ID: &str = "363409575321403402";
const SLUG: &str = "golf-it";
const DETAILS_URL: &str =
    "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
/// Steam's image resizer; the bare ugc url is served as octet-stream
const UGC_SQUARE: &str =
    "?imw=512&imh=512&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=true";
const RETRY: Duration = Duration::from_secs(600);

fn matches(t: &Target) -> bool {
    t.game_id == GAME_ID
        || t.steam_appid.as_deref() == Some("571740")
        || matches!(
            util::exe_name(t).as_str(),
            "golfit-win64-shipping.exe" | "golfit.exe"
        )
}

fn run(ctx: &Ctx) {
    let mut g = GolfIt {
        workshop: Workshop::load(ctx.cache_dir()),
        ..GolfIt::default()
    };
    unreal::run(ctx, &mut g);
}

#[derive(Clone, Copy)]
struct Opts {
    map: bool,
    hole: bool,
    session: bool,
    players: bool,
}

impl Opts {
    fn from(s: &Settings) -> Self {
        Opts {
            map: s.flag("show_map"),
            hole: s.flag("show_hole"),
            session: s.flag("show_session"),
            players: s.flag("show_players"),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Lobby,
    Playing,
    Over,
}

#[derive(Default)]
struct GolfIt {
    phase: Phase,
    hole: u32,
    last_hole: u32,
    /// the host logs the hole number; clients only count "Hole started"
    hole_known: bool,
    /// course name from the host's session settings dump
    session_map: Option<String>,
    /// workshop id of a course loaded after the map (clients)
    loaded_ws: Option<String>,
    /// workshop names from the "Name:" / "ID:" blocks, by id
    names: HashMap<String, String>,
    pending_name: Option<String>,
    workshop_block: bool,
    loading_workshop: bool,
    workshop: Workshop,
}

impl Game for GolfIt {
    const PROJECT: &'static str = "GolfIt";
    const TRANSIT: &'static [&'static str] = &["TransitionMap"];

    fn reset(&mut self, _s: &Session) {
        self.phase = Phase::Lobby;
        self.hole = 0;
        self.last_hole = 0;
        self.hole_known = false;
        self.session_map = None;
        self.loaded_ws = None;
        self.pending_name = None;
        self.workshop_block = false;
        self.loading_workshop = false;
    }

    fn line(&mut self, _s: &Session, _ts: Option<i64>, body: &str) -> bool {
        // multi-line dumps: "  Name: <course>" then "  ID: <id>" / "  WorkshopID: <id>"
        let t = body.trim_start();
        if t.starts_with("Log") {
            self.loading_workshop = t
                .starts_with("LogGolfItMaps: Display: Starting async load of workshop custom map:");
            self.workshop_block = self.loading_workshop
                || (t.starts_with("LogGolfItMaps:") && t.ends_with("workshop map:"))
                || (t.starts_with("LogGolfItGame:") && t.ends_with("Workshop Map:"));
            self.pending_name = None;
        }
        if let Some(name) = t.strip_prefix("Name: ").filter(|_| self.workshop_block) {
            self.pending_name = util::clamp(name);
            return false;
        }
        if let Some(id) = t
            .strip_prefix("WorkshopID: ")
            .or_else(|| t.strip_prefix("ID: "))
            .filter(|_| self.workshop_block)
        {
            let id = id.trim();
            if is_id(id) {
                if let Some(n) = self.pending_name.take() {
                    if self.names.len() >= 512 {
                        self.names.clear();
                    }
                    self.names.insert(id.to_string(), n);
                }
                if self.loading_workshop {
                    self.loaded_ws = Some(id.to_string());
                }
                return true;
            }
            return false;
        }
        if let Some(rest) = body.split("OSS: ").nth(1) {
            let rest = rest.trim();
            if let Some(v) = rest.strip_prefix("Map=") {
                let v = v.strip_suffix(" : OnlineService").unwrap_or(v).trim();
                let changed = self.session_map.as_deref() != Some(v);
                self.session_map = (!v.is_empty()).then(|| v.to_string());
                return changed;
            }
            if let Some(n) = num_setting(rest, "CurrentHole=") {
                if n > 0 && (n != self.hole || !self.hole_known) {
                    self.hole = n;
                    self.hole_known = true;
                    return true;
                }
            } else if let Some(n) = num_setting(rest, "LastHole=") {
                let changed = n != self.last_hole;
                self.last_hole = n;
                return changed;
            }
            return false;
        }
        if let Some(n) = body.strip_prefix("LogGolfItGameMode: Display: Next hole is ") {
            if let Ok(n) = n.trim().parse() {
                self.hole = n;
                self.hole_known = true;
                self.phase = Phase::Playing;
                return true;
            }
        }
        if body.starts_with("LogPlayerController: ") {
            if body.ends_with(": Match started") {
                self.hole = 0;
                self.hole_known = false;
                self.phase = Phase::Playing;
                return true;
            }
            if body.ends_with(": Hole started") {
                self.phase = Phase::Playing;
                if !self.hole_known {
                    self.hole = self.hole.saturating_add(1);
                }
                return true;
            }
            if body.ends_with(": Match finished") {
                self.phase = Phase::Over;
                return true;
            }
        }
        false
    }

    fn build(&mut self, s: &Session, set: &Settings, online: bool) -> Option<Live> {
        let map = s.map()?;
        let o = Opts::from(set);
        if is_menu(map) {
            return Some(Live {
                details: util::clamp("In the main menu"),
                large_image: o.map.then(|| art::url(SLUG, "menu")),
                ..Live::default()
            });
        }
        if map.ends_with("_Editor") || map == "MinesEditor" {
            return Some(Live {
                details: util::clamp("In the course editor"),
                large_image: o.map.then(|| {
                    course(map.strip_suffix("_Editor").unwrap_or(map))
                        .and_then(|(_, key)| key)
                        .map(|k| art::url(SLUG, k))
                        .unwrap_or_else(|| art::steam_header("571740"))
                }),
                ..Live::default()
            });
        }

        let ws = s
            .opt("WorkshopMap")
            .filter(|id| is_id(id))
            .map(str::to_string)
            .or_else(|| self.loaded_ws.clone());
        let item = match &ws {
            Some(id) if o.map => self.workshop.get(id, online),
            _ => None,
        };
        let theme = course(map);
        let label = self
            .session_map
            .clone()
            .or_else(|| ws.as_ref().and_then(|id| self.names.get(id).cloned()))
            .or_else(|| {
                item.as_ref()
                    .filter(|i| !i.title.is_empty())
                    .map(|i| i.title.clone())
            })
            .or_else(|| {
                theme.map(|(l, _)| {
                    if ws.is_some() || map.ends_with("_EditorPlay") {
                        format!("Custom course, {l}")
                    } else {
                        l.to_string()
                    }
                })
            })
            .unwrap_or_else(|| "On the course".to_string());

        let mut parts = Vec::new();
        match self.phase {
            Phase::Lobby => parts.push("In the lobby".to_string()),
            Phase::Playing if o.hole && self.hole > 0 => parts.push(match self.last_hole {
                n if n >= self.hole => format!("Hole {} of {n}", self.hole),
                _ => format!("Hole {}", self.hole),
            }),
            Phase::Playing => {}
            Phase::Over => parts.push("Round over".to_string()),
        }
        let party = unreal::people(&mut parts, s, None, None, o.session, o.players);

        let image = o.map.then(|| {
            item.as_ref()
                .and_then(|i| i.image.clone())
                .or_else(|| theme.and_then(|(_, k)| k).map(|k| art::url(SLUG, k)))
                .unwrap_or_else(|| art::steam_header("571740"))
        });
        Some(Live {
            details: util::clamp(if o.map {
                label.clone()
            } else {
                "On the course".to_string()
            }),
            state: util::clamp(parts.join(" · ")),
            large_text: image.is_some().then(|| util::clamp(label)).flatten(),
            large_image: image,
            party,
            ..Live::default()
        })
    }
}

fn is_id(s: &str) -> bool {
    (1..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

fn num_setting(s: &str, key: &str) -> Option<u32> {
    s.strip_prefix(key)?.split_whitespace().next()?.parse().ok()
}

fn is_menu(map: &str) -> bool {
    matches!(
        map,
        "MainMenu" | "FirstLoadLevel" | "Entry" | "VR_Menu" | "ImporterMap"
    )
}

/// Official course (or the theme a custom course is built on) -> (name, art key).
fn course(map: &str) -> Option<(&'static str, Option<&'static str>)> {
    let base = map.strip_suffix("_EditorPlay").unwrap_or(map);
    Some(match base {
        "Grassland" | "Grassland_Night" => ("Grassland", Some("grassland")),
        "Graveyard" => ("Graveyard", Some("graveyard")),
        "DeepBlue" | "Underwater" => ("Deep Blue", Some("deep-blue")),
        "JadeTemple" | "Asia" | "Jade" | "Temple" => ("Jade Temple", Some("jade-temple")),
        "MinesNew" | "Mines" | "Mine" => ("Mines", Some("mines")),
        "PiratesCove" | "Pirate" => ("Pirates Cove", Some("pirates-cove")),
        "Winterland" | "Winterland_Storm" | "Winter" => ("Winterland", Some("winterland")),
        "GolfingUp" => ("Golfing Up", None),
        "VR_Training" | "VRClassic" | "Classic" => ("VR training", Some("vr-classic")),
        _ => return None,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Item {
    title: String,
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    fetched_ms: i64,
}

/// Workshop titles and preview pictures, on disk so each course is asked for once.
#[derive(Default)]
struct Workshop {
    items: HashMap<String, Item>,
    file: Option<PathBuf>,
    failed: HashMap<String, Instant>,
}

impl Workshop {
    fn load(dir: Option<PathBuf>) -> Self {
        let file = dir.map(|d| d.join("workshop.json"));
        let mut items: HashMap<String, Item> = file
            .as_ref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let now = util::now_ms();
        items.retain(|_, item| {
            item.fetched_ms > 0
                && item.fetched_ms <= now
                && now.saturating_sub(item.fetched_ms) < 7 * 86_400_000
        });
        Workshop {
            items,
            file,
            failed: HashMap::new(),
        }
    }

    fn get(&mut self, id: &str, online: bool) -> Option<Item> {
        if let Some(i) = self.items.get(id) {
            return Some(i.clone());
        }
        if !online || self.failed.get(id).is_some_and(|t| t.elapsed() < RETRY) {
            return None;
        }
        match fetch(id) {
            Some(item) => {
                self.items.insert(id.to_string(), item.clone());
                if let Some(f) = &self.file {
                    if let Ok(json) = serde_json::to_vec(&self.items) {
                        let _ = std::fs::write(f, json);
                    }
                }
                Some(item)
            }
            None => {
                self.failed.insert(id.to_string(), Instant::now());
                None
            }
        }
    }
}

/// POST itemcount=1&publishedfileids[0]=<id>, no key needed
fn fetch(id: &str) -> Option<Item> {
    let resp: DetailsResponse = util::http::agent()
        .post(DETAILS_URL)
        .send_form(&[("itemcount", "1"), ("publishedfileids[0]", id)])
        .ok()?
        .into_json()
        .ok()?;
    parse_details(resp)
}

fn parse_details(resp: DetailsResponse) -> Option<Item> {
    let d = resp.response.publishedfiledetails.into_iter().next()?;
    // result 1 is OK; 9 is a hidden or removed item
    if d.result != 1 {
        return None;
    }
    let image = d
        .preview_url
        .filter(|u| {
            u.starts_with("https://images.steamusercontent.com/ugc/")
                || u.starts_with("https://steamuserimages-a.akamaihd.net/ugc/")
        })
        .map(|u| {
            let base = u.split('?').next().unwrap_or(&u).to_string();
            format!("{base}{UGC_SQUARE}")
        });
    Some(Item {
        title: d.title.unwrap_or_default().trim().to_string(),
        image,
        fetched_ms: util::now_ms(),
    })
    .filter(|i| !i.title.is_empty() || i.image.is_some())
}

#[derive(Deserialize, Default)]
struct DetailsResponse {
    #[serde(default)]
    response: Details,
}

#[derive(Deserialize, Default)]
struct Details {
    #[serde(default)]
    publishedfiledetails: Vec<Detail>,
}

#[derive(Deserialize, Default)]
struct Detail {
    #[serde(default)]
    result: i64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    preview_url: Option<String>,
}

const SCENARIOS: &[(&str, &str)] = &[
    ("menu", "Main menu"),
    ("editor", "Course editor"),
    ("lobby", "Hosting a workshop course"),
    ("hole", "Mid round, friend's game"),
    ("over", "Round over"),
];

const SAMPLE_WS: &str = "1082374684";

// lines in the game's own format, from a real GolfIt.log with names and ids replaced
fn sample(scenario: &str) -> String {
    let menu = "
        [2026.06.07-18.40.53:899][  0]LogLoad: LoadMap: /Game/Maps/FirstLoadLevel?Name=Player
        [2026.06.07-18.40.54:005][  0]LogLoad: LoadMap: /Game/Maps/MainMenu
    ";
    let host = format!(
        "{menu}
        [2026.06.07-18.42.28:425][681]LogGolfItGame: Display: [WB_MapSelection_C_2147482202]: Workshop Map:
          Name: Hole In One
          WorkshopID: {SAMPLE_WS}
        [2026.06.07-18.42.28:919][701]LogLoad: LoadMap: /Game/Maps/Pirate_EditorPlay?listen?ServerName=Host's Server?WorkshopMap={SAMPLE_WS}?Password=1234?FriendsOnly
        [2026.06.07-18.42.29:344][701]LogLoad: Game class is 'LobbyMode_C'
        [2026.06.07-18.42.29:773][728]LogOnlineSession: Verbose: OSS: \t\tLastHole=18 : OnlineService
        [2026.06.07-18.42.45:717][ 80]LogNet: Login request: ?Password=1234?Name=FriendA userId: Steam:FriendA [0x11...8675] platform: Steam
        [2026.06.07-18.42.46:293][146]LogNet: Join succeeded: FriendA
        [2026.06.07-18.43.03:854][408]LogNet: Login request: ?Password=1234?Name=FriendB userId: Steam:FriendB [0x11...0094] platform: Steam
        [2026.06.07-18.43.12:307][467]LogNet: Join succeeded: FriendB
    "
    );
    match scenario {
        "editor" => format!("{menu}\nLogLoad: LoadMap: /Game/Maps/Grassland_Editor"),
        "lobby" => host,
        "hole" => format!(
            "{menu}
            [2026.06.07-18.43.10:000][  1]LogNet: Welcomed by server (Level: /Game/Maps/Grassland, Game: /Game/Blueprints/GameModes/GolfGameMode.GolfGameMode_C)
            [2026.06.07-18.43.10:100][  1]LogLoad: LoadMap: steam.76561190000000001/Game/Maps/Grassland
            [2026.06.07-18.43.55:036][ 72]LogPlayerController: Display: Player: Match started
            [2026.06.07-18.43.55:373][106]LogPlayerController: Display: Player: Hole started
            [2026.06.07-18.44.32:686][422]LogPlayerController: Display: Player: Hole started
            [2026.06.07-18.45.03:245][480]LogPlayerController: Display: Player: Hole started
            [2026.06.07-18.45.26:020][ 55]LogPlayerController: Display: Player: Hole started
            [2026.06.07-18.46.20:458][209]LogPlayerController: Display: Player: Hole started
            "
        ),
        "over" => format!(
            "{host}
            [2026.06.07-18.43.55:036][ 72]LogPlayerController: Display: Player: Match started
            [2026.06.07-18.58.14:282][751]LogOnlineSession: Verbose: OSS: \t\tCurrentHole=18 : OnlineService
            [2026.06.07-18.59.12:684][ 61]LogPlayerController: Display: Player: Match finished
            "
        ),
        _ => menu.to_string(),
    }
}

fn preview(s: &Settings, scenario: &str) -> Preview {
    let key = SCENARIOS
        .iter()
        .find(|(k, _)| *k == scenario)
        .or(SCENARIOS.first())
        .map(|(k, _)| *k)
        .unwrap_or("menu");
    let mut g = GolfIt::default();
    g.workshop.items.insert(
        SAMPLE_WS.to_string(),
        Item {
            fetched_ms: 0,
            title: "Hole In One".to_string(),
            image: Some(format!("https://images.steamusercontent.com/ugc/781856287316306668/D63187013A4CE2838C5D814496DB08376FB6F93F/{UGC_SQUARE}")),
        },
    );
    let sess = unreal::replay(&mut g, &sample(key));
    Preview {
        game: "Golf It!",
        icon: None,
        live: g.build(&sess, s, false).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(v: serde_json::Value) -> Settings {
        Settings::new(&MANIFEST, v)
    }

    #[test]
    fn every_scenario_has_a_card() {
        let s = st(serde_json::json!({}));
        for (k, _) in SCENARIOS {
            assert!(!preview(&s, k).live.is_empty(), "{k}");
        }
        assert_eq!(preview(&s, "nope").live, preview(&s, "menu").live);
        assert_eq!(
            preview(&s, "menu").live.details.as_deref(),
            Some("In the main menu")
        );
    }

    #[test]
    fn lobby_and_rounds() {
        let s = st(serde_json::json!({}));
        let l = preview(&s, "lobby").live;
        assert_eq!(l.details.as_deref(), Some("Hole In One"));
        assert_eq!(
            l.state.as_deref(),
            Some("In the lobby · Hosting · 3 players")
        );
        assert!(l
            .large_image
            .unwrap()
            .starts_with("https://images.steamusercontent.com/ugc/"));

        let l = preview(&s, "hole").live;
        assert_eq!(l.details.as_deref(), Some("Grassland"));
        assert_eq!(l.state.as_deref(), Some("Hole 5 · In a friend's game"));
        assert_eq!(l.large_image, Some(art::url(SLUG, "grassland")));

        let l = preview(&s, "over").live;
        assert_eq!(l.state.as_deref(), Some("Round over · Hosting · 3 players"));
    }

    #[test]
    fn options_change_the_card() {
        let off = st(
            serde_json::json!({ "show_map": false, "show_hole": false, "show_session": false, "show_players": false }),
        );
        let l = preview(&off, "hole").live;
        assert_eq!(l.details.as_deref(), Some("On the course"));
        assert_eq!(l.state, None);
        assert_eq!(l.large_image, None);
        let l = preview(&off, "lobby").live;
        assert_eq!(l.state.as_deref(), Some("In the lobby"));
    }

    #[test]
    fn host_hole_numbers_win_over_counting() {
        let mut g = GolfIt::default();
        let log = format!(
            "{}
            [2026.06.07-18.43.55:036][ 72]LogPlayerController: Display: Player: Match started
            [2026.06.07-18.43.55:373][106]LogGolfItGameMode: Display: Starting new hole
            [2026.06.07-18.43.55:400][106]LogPlayerController: Display: Player: Hole started
            [2026.06.07-18.43.55:662][117]LogOnlineSession: Verbose: OSS: \t\tCurrentHole=1 : OnlineService
            [2026.06.07-18.44.32:682][422]LogGolfItGameMode: Display: Next hole is 2
            [2026.06.07-18.44.32:690][422]LogPlayerController: Display: Player: Hole started
            [2026.06.07-18.44.32:977][451]LogOnlineSession: Verbose: OSS: \t\tMap=Someone's - Summer Collection 3/6: Seychelles Beach : OnlineService
            ",
            sample("lobby")
        );
        let s = unreal::replay(&mut g, &log);
        let l = g.build(&s, &st(serde_json::json!({})), false).unwrap();
        assert_eq!(
            l.details.as_deref(),
            Some("Someone's - Summer Collection 3/6: Seychelles Beach")
        );
        assert_eq!(
            l.state.as_deref(),
            Some("Hole 2 of 18 · Hosting · 3 players")
        );
        // workshop course not in the cache and no network: theme art instead
        assert_eq!(l.large_image, Some(art::url(SLUG, "pirates-cove")));
    }

    #[test]
    fn steam_details() {
        let ok: DetailsResponse = serde_json::from_str(r#"{"response":{"result":1,"resultcount":1,"publishedfiledetails":[
            {"publishedfileid":"1082374684","result":1,"title":"YuNO _ Hole In One ","consumer_app_id":571740,
             "preview_url":"https://images.steamusercontent.com/ugc/781856287316306668/D63187013A4CE2838C5D814496DB08376FB6F93F/"}]}}"#).unwrap();
        let i = parse_details(ok).unwrap();
        assert_eq!(i.title, "YuNO _ Hole In One");
        assert!(i.image.unwrap().ends_with(
            "6FB6F93F/?imw=512&imh=512&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=true"
        ));
        let gone: DetailsResponse = serde_json::from_str(r#"{"response":{"result":1,"resultcount":1,"publishedfiledetails":[{"publishedfileid":"3716538442","result":9}]}}"#).unwrap();
        assert_eq!(parse_details(gone), None);
        assert_eq!(parse_details(DetailsResponse::default()), None);
    }

    #[test]
    fn editor_and_courses() {
        assert_eq!(
            course("Pirate_EditorPlay"),
            Some(("Pirates Cove", Some("pirates-cove")))
        );
        assert_eq!(course("Winterland_Storm").map(|c| c.0), Some("Winterland"));
        assert_eq!(course("Nope"), None);
        let mut g = GolfIt::default();
        let s = unreal::replay(
            &mut g,
            "[2026.06.07-18.40.53:899][  0]LogLoad: LoadMap: /Game/Maps/Grassland_Editor",
        );
        assert_eq!(
            g.build(&s, &st(serde_json::json!({})), false)
                .unwrap()
                .details
                .as_deref(),
            Some("In the course editor")
        );
    }

    #[test]
    fn matching() {
        assert!(matches(&Target {
            game_id: GAME_ID.into(),
            ..Target::default()
        }));
        let t = Target {
            exe: Some(PathBuf::from(
                r"C:\S\GolfIt\Binaries\Win64\GolfIt-Win64-Shipping.exe",
            )),
            ..Target::default()
        };
        assert!(matches(&t));
        assert!(!matches(&Target::default()));
    }

    #[test]
    fn unrelated_names_are_ignored_and_loaded_workshops_are_scoped() {
        let mut game = GolfIt::default();
        let log = "LogLoad: LoadMap: /Game/Maps/Pirate_EditorPlay\nName: PrivateAccount\nID: 76561190000000001\nLogGolfItMaps: Display: Starting async load of workshop custom map:\n  Name: Public course\n  Path ignored\n  ID: 1082374684";
        let s = unreal::replay(&mut game, log);
        assert_eq!(game.names.len(), 1);
        assert_eq!(game.loaded_ws.as_deref(), Some(SAMPLE_WS));
        let live = game.build(&s, &st(serde_json::json!({})), false).unwrap();
        assert_eq!(live.details.as_deref(), Some("Public course"));
    }

    #[test]
    fn new_round_resets_the_client_hole_count() {
        let mut game = GolfIt::default();
        let mut s = unreal::replay(&mut game, &sample("hole"));
        assert_eq!(game.hole, 5);
        unreal::feed(
            &mut s,
            &mut game,
            "LogPlayerController: Display: Player: Match finished",
        );
        unreal::feed(
            &mut s,
            &mut game,
            "LogPlayerController: Display: Player: Match started",
        );
        unreal::feed(
            &mut s,
            &mut game,
            "LogPlayerController: Display: Player: Hole started",
        );
        assert_eq!(game.hole, 1);
        for (key, scenario) in [
            ("show_map", "hole"),
            ("show_hole", "hole"),
            ("show_session", "hole"),
            ("show_players", "lobby"),
        ] {
            assert_ne!(
                preview(&st(serde_json::json!({key: false})), scenario).live,
                preview(&st(serde_json::json!({})), scenario).live
            );
        }
    }
}
