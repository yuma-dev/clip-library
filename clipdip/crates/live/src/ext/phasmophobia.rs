//! Map, difficulty and lobby size. Ported from PhasmophobiaDiscordRPC by Zehs (MIT),
//! https://github.com/ZehsTeam/PhasmophobiaDiscordRPC: PlayerLogReader.cs, MapDatabase.cs;
//! phasmopresence by Manuel Cabral (MIT), https://github.com/manucabral/phasmopresence:
//! src/phasmoreader.py, src/phasmopresence.py

use crate::util::{art, clamp, exe_name, now_ms, tail::Tail};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

pub static MANIFEST: Manifest = Manifest {
    id: "phasmophobia",
    name: "Phasmophobia",
    blurb: "Shows the map, difficulty and player count.",
    setup: None,
    credits: &[
        Credit {
            project: "PhasmophobiaDiscordRPC",
            author: "Zehs",
            url: "https://github.com/ZehsTeam/PhasmophobiaDiscordRPC",
            license: "MIT",
        },
        Credit {
            project: "phasmopresence",
            author: "Manuel Cabral",
            url: "https://github.com/manucabral/phasmopresence",
            license: "MIT",
        },
    ],
    options: &[
        Opt::toggle(
            "show_difficulty",
            "Show difficulty",
            "The contract's difficulty.",
            true,
        ),
        Opt::toggle(
            "show_party",
            "Show player count",
            "Players in your lobby or contract.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &["1402418103702524046"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/739630/library_hero.jpg"),
    preview,
    scenarios: &[
        ("menu", "Main menu"),
        ("lobby", "Lobby"),
        ("contract", "In a contract"),
        ("solo", "Solo contract"),
        ("training", "Training"),
    ],
    steam_game: true,
    listed: true,
};

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str()) || exe_name(t) == "phasmophobia.exe"
}

// only known map labels reach the card, never arbitrary text from a log
const MAPS: &[(&str, &str, &[&str])] = &[
    ("lobby", "Main menu", &["mainmenu"]),
    (
        "tanglewood",
        "6 Tanglewood Drive",
        &["tanglewoodstreethouse", "tanglewood"],
    ),
    (
        "edgefield",
        "42 Edgefield Road",
        &["edgefieldstreethouse", "edgefield"],
    ),
    (
        "ridgeview",
        "10 Ridgeview Court",
        &["ridgeviewroadhouse", "ridgeview"],
    ),
    (
        "willow",
        "13 Willow Street",
        &["willowstreethouse", "willow"],
    ),
    ("grafton", "Grafton Farmhouse", &["graftonfarmhouse"]),
    ("bleasdale", "Bleasdale Farmhouse", &["bleasdalefarmhouse"]),
    (
        "brownstone",
        "Brownstone High School",
        &["brownstonehighschool"],
    ),
    (
        "sunny-meadows",
        "Sunny Meadows",
        &["asylum", "sunnymeadows"],
    ),
    (
        "sunny-meadows",
        "Sunny Meadows Restricted",
        &["sunnymeadowsrestricted", "asylumrestricted"],
    ),
    ("prison", "Prison", &["prison"]),
    (
        "maple-lodge",
        "Maple Lodge Campsite",
        &["maplelodgecampsite"],
    ),
    ("camp-woodwind", "Camp Woodwind", &["campwoodwind"]),
    ("point-hope", "Point Hope", &["pointhope"]),
    ("nells-diner", "Nell's Diner", &["nellsdiner"]),
    ("training", "Training", &["tutorialv2", "training"]),
];

fn map(name: &str) -> Option<(&'static str, &'static str)> {
    let n = art::norm(name);
    MAPS.iter()
        .find(|(_, label, aliases)| aliases.contains(&n.as_str()) || art::norm(label) == n)
        .map(|(key, label, _)| (*key, *label))
}

fn difficulty(value: &str) -> Option<&'static str> {
    [
        "Amateur",
        "Intermediate",
        "Professional",
        "Nightmare",
        "Insanity",
        "Training",
        "Challenge",
        "Custom",
    ]
    .into_iter()
    .find(|d| value.contains(d))
    .or_else(|| value.contains("(Difficulty)").then_some("Normal"))
}

#[derive(Default, Debug, PartialEq)]
struct State {
    known: bool,
    map: Option<(&'static str, &'static str)>,
    difficulty: Option<&'static str>,
    players: Option<u32>,
    online: bool,
    in_room: bool,
    start: Option<i64>,
    members: Vec<u64>,
}

fn member(line: &str) -> Option<u64> {
    use std::hash::{Hash, Hasher};
    let id = line.split_once(':')?.1.split('|').next()?.trim();
    if id.is_empty() {
        return None;
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    id.hash(&mut h);
    Some(h.finish())
}

impl State {
    fn feed(&mut self, line: &str, now: Option<i64>) {
        let line = line.trim();
        if let Some(value) = line
            .strip_prefix("Loaded Level:")
            .or_else(|| line.strip_prefix("Loaded Level :"))
        {
            let mut level = None;
            let mut count = None;
            let mut diff = None;
            for (i, field) in value.split('|').enumerate() {
                if i == 0 {
                    level = Some(field.trim());
                    continue;
                }
                let Some((key, value)) = field.split_once(':') else {
                    return;
                };
                match key.trim() {
                    "Players" => count = value.trim().parse::<u32>().ok().filter(|n| *n <= 4),
                    "Difficulty" => diff = difficulty(value),
                    _ => {}
                }
            }
            let (Some(level), Some(count)) = (level.filter(|l| !l.is_empty()), count) else {
                return;
            };
            let next = map(level);
            let in_room = count > 0;
            if count == 0 && next.is_none_or(|(key, _)| key != "lobby") {
                return;
            }
            if !self.known || next != self.map || in_room != self.in_room {
                self.start = now;
            }
            self.known = true;
            self.map = next;
            self.players = in_room.then_some(count);
            // newer logs omit the applied difficulty from the level line
            if !in_room {
                self.difficulty = None;
                self.members.clear();
            } else if diff.is_some() {
                self.difficulty = diff;
            }
            self.in_room = in_room;
        } else if line.starts_with("Connected to master server in offline mode") {
            *self = Self {
                known: true,
                map: map("MainMenu"),
                players: Some(1),
                start: now,
                ..Self::default()
            };
        } else if line.starts_with("Connected to master server successfully") {
            *self = Self {
                known: true,
                map: map("MainMenu"),
                online: true,
                start: now,
                ..Self::default()
            };
        } else if line.starts_with("Room Created") || line.starts_with("Joined room") {
            self.in_room = true;
            self.online = true;
            self.known = true;
            self.map = map("MainMenu");
            self.players = Some(1);
            self.members.clear();
            self.start = now;
        } else if line.starts_with("Left Room") {
            *self = Self {
                known: true,
                map: map("MainMenu"),
                online: self.online,
                start: now,
                ..Self::default()
            };
        } else if let Some(value) = line.strip_prefix("Applying difficulty") {
            if let Some(d) = difficulty(value) {
                self.difficulty = Some(d);
            }
        } else if self.in_room
            && (line.starts_with("Player Entered") || line.starts_with("Recieved Player Info"))
        {
            let Some(id) = member(line) else { return };
            if !self.members.contains(&id) && self.members.len() < 4 {
                self.members.push(id);
                let count = self.players.unwrap_or(1);
                self.players = Some(if line.starts_with("Player Entered") {
                    (count + 1).min(4)
                } else {
                    count.max(self.members.len() as u32)
                });
            }
        } else if self.in_room && line.starts_with("Player Left") {
            let Some(id) = member(line) else { return };
            self.members.retain(|m| *m != id);
            self.players = self.players.map(|n| n.saturating_sub(1).max(1));
        } else if line == "Stop" {
            *self = Self::default();
        }
    }
}

fn build(s: &State, settings: &Settings) -> Option<Live> {
    if !s.known {
        return None;
    }
    let (key, label) = s.map.unwrap_or(("", "Investigating"));
    let menu = key == "lobby";
    let details = if menu && s.in_room {
        "In the lobby"
    } else {
        label
    };
    let mut parts = Vec::new();
    if !menu {
        if settings.flag("show_difficulty") {
            if let Some(d) = s.difficulty {
                parts.push(d);
            }
        }
        parts.push(if s.players.is_some_and(|n| n > 1) {
            "Multiplayer"
        } else {
            "Solo"
        });
    } else if s.in_room {
        parts.push(if s.players.is_some_and(|n| n > 1) {
            "Multiplayer"
        } else {
            "Solo"
        });
    }
    Some(Live {
        details: clamp(details),
        state: clamp(parts.join(", ")),
        large_image: Some(if key.is_empty() {
            art::steam_header("739630")
        } else {
            art::url("phasmophobia", key)
        }),
        large_text: clamp(label),
        party: if settings.flag("show_party") && s.in_room {
            s.players.map(|n| [n, 4])
        } else {
            None
        },
        start_ms: s.start,
        ..Live::default()
    })
}

fn preview(settings: &Settings, scenario: &str) -> Preview {
    let lines: &[&str] = match scenario {
        "lobby" => &["Joined room", "Loaded Level: MainMenu | Players: 3 | Is Host: False | Difficulty: Amateur"],
        "contract" => &["Loaded Level: TanglewoodStreetHouse | Players: 4 | Is Host: True | Difficulty: Professional"],
        "solo" => &["Loaded Level: WillowStreetHouse | Players: 1 | Is Host: True | Difficulty: Nightmare"],
        "training" => &["Loaded Level: TutorialV2 | Players: 1 | Is Host: True | Difficulty: Training"],
        _ => &["Loaded Level: Main Menu | Players: 0 | Is Host: True | Difficulty: Amateur"],
    };
    let mut state = State::default();
    for line in lines {
        state.feed(line, Some(1_700_000_000_000));
    }
    Preview {
        game: "Phasmophobia",
        icon: None,
        live: build(&state, settings).unwrap_or_default(),
    }
}

fn player_log() -> Option<PathBuf> {
    Some(
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
            .parent()?
            .join("LocalLow/Kinetic Games/Phasmophobia/Player.log"),
    )
}

fn run(ctx: &Ctx) {
    let Some(path) = player_log() else { return };
    let mut identity: Option<(Option<SystemTime>, u64)> = None;
    let mut state = State::default();
    let fresh = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .is_some_and(|t| t.as_millis() as i64 + 60_000 >= ctx.target().started_at_ms);
    let mut tail = Tail::new(&path, if fresh { 2 << 20 } else { 0 });
    let mut caught_up = false;
    loop {
        if let Ok(meta) = std::fs::metadata(&path) {
            let next = (meta.created().ok(), meta.len());
            if identity.is_some_and(|old| old.0 != next.0 || old.1 > next.1) {
                state = State::default();
                caught_up = false;
            }
            identity = Some(next);
        } else {
            state = State::default();
        }
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
    fn settings(v: serde_json::Value) -> Settings {
        Settings::new(&MANIFEST, v)
    }
    #[test]
    fn reference_lines_and_privacy() {
        let mut s = State::default();
        s.feed("Connected to master server successfully: us /*", None);
        s.feed("Joined room", None);
        s.feed("Loaded Level: TanglewoodStreetHouse | Players: 3 | Is Host: False | Difficulty: Professional", None);
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.details.as_deref(), Some("6 Tanglewood Drive"));
        assert_eq!(live.party, Some([3, 4]));
        assert_eq!(live.start_ms, None);
        s.feed("Player Entered: 1 | Friend", None);
        s.feed("Player Entered: 1 | Friend", None);
        assert_eq!(s.players, Some(4));
        s.feed("Player Left: 1 | Friend", None);
        assert_eq!(s.players, Some(3));
        s.feed("Applying difficulty: Insanity", None);
        assert_eq!(s.difficulty, Some("Insanity"));
        s.feed(
            "Loaded Level: Main Menu | Players: 3 | Is Host: False | Difficulty: Amateur",
            Some(20),
        );
        assert_eq!(
            build(&s, &settings(serde_json::json!({})))
                .unwrap()
                .details
                .as_deref(),
            Some("In the lobby")
        );
        s.feed("Left Room", Some(30));
        assert_eq!(s.players, None);
        assert_eq!(s.start, Some(30));
        assert_eq!(
            build(&s, &settings(serde_json::json!({}))).unwrap().party,
            None
        );
        s.feed(
            "Loaded Level: MainMenu | Players: 0 | Is Host: True | Difficulty: (Difficulty)",
            Some(40),
        );
        assert_eq!(
            build(&s, &settings(serde_json::json!({})))
                .unwrap()
                .details
                .as_deref(),
            Some("Main menu")
        );
        assert_eq!(s.difficulty, None);
    }
    #[test]
    fn malformed_and_unknown_data() {
        let mut s = State::default();
        for line in [
            "noise",
            "Loaded Level:",
            "Loaded Level: Prison | Players: -2",
            "Loaded Level: Prison | Players: 0",
            "Loaded Level: Prison | Players: 99",
            "Loaded Level: Prison | Players: x",
            "Player Left:",
        ] {
            s.feed(line, None);
        }
        assert_eq!(build(&s, &settings(serde_json::json!({}))), None);
        s.feed(
            "Loaded Level: private-name | Players: 1 | Difficulty: (Difficulty)",
            None,
        );
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.details.as_deref(), Some("Investigating"));
        assert_eq!(live.state.as_deref(), Some("Normal, Solo"));
        assert!(!serde_json::to_string(&live)
            .unwrap()
            .contains("private-name"));
        for (_, label, aliases) in MAPS {
            for alias in *aliases {
                assert_eq!(map(alias).unwrap().1, *label);
            }
        }
        s.feed("Stop", None);
        assert_eq!(build(&s, &settings(serde_json::json!({}))), None);
    }
    #[test]
    fn previews_and_matches() {
        let s = settings(serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&s, key).live.is_empty());
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        let off = settings(serde_json::json!({"show_party":false,"show_difficulty":false}));
        assert_eq!(preview(&off, "contract").live.party, None);
        assert_ne!(
            preview(&off, "contract").live.state,
            preview(&s, "contract").live.state
        );
        assert!(matches(&Target {
            game_id: MANIFEST.game_ids[0].into(),
            ..Target::default()
        }));
        assert!(matches(&Target {
            exe: Some("Phasmophobia.exe".into()),
            ..Target::default()
        }));
        assert!(!matches(&Target::default()));
    }
}
