//! Character, act, floor and ascension from Slay the Spire 2 saves and godot.log. Format
//! documented from Mega Crit game files (docs), https://store.steampowered.com/app/2868840:
//! current_run.save, current_run_mp.save and lobby/location log lines. Original code.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::Value;

use crate::util::tail::Tail;
use crate::util::{art, clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "slay_the_spire_2",
    name: "Slay the Spire 2",
    blurb: "Shows your character, act, floor and ascension, and your party in co-op.",
    setup: None,
    credits: &[Credit {
        project: "Slay the Spire 2 save files and godot.log",
        author: "Mega Crit",
        url: "https://store.steampowered.com/app/2868840",
        license: "docs",
    }],
    options: &[
        Opt::choice(
            "picture",
            "Picture",
            "What the big picture shows.",
            "character",
            &[("character", "Your character"), ("act", "The act")],
        ),
        Opt::toggle(
            "ascension",
            "Show ascension",
            "The ascension level next to your character.",
            true,
        ),
        Opt::toggle(
            "run_time",
            "Show run time",
            "The card's timer counts the run's play time instead of the session.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[DISCORD_ID],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/2868840/library_hero.jpg"),
    preview,
    scenarios: &[
        ("menu", "Main menu"),
        ("act1", "Act 1, Silent"),
        ("ironclad", "Act 1, Ironclad"),
        ("defect", "Act 1, Defect"),
        ("act2", "Act 2"),
        ("act3", "Act 3"),
        ("coop", "Co-op run"),
        ("coop_guest", "Co-op, joined"),
    ],
    steam_game: true,
    listed: true,
};

const DISCORD_ID: &str = "1479192099734945802";
const SLUG: &str = "slay-the-spire-2";
// co-op lobbies take up to 4
const MAX_PARTY: u32 = 4;
// the game saves on every room, so a few seconds behind is fine
const POLL: Duration = Duration::from_secs(5);
// a late act 3 save is ~200 KB
const MAX_SAVE: u64 = 16 << 20;
// godot.log is per launch (older ones get a timestamp), a whole session is a few MB
const LOG_FIRST_READ: u64 = 8 << 20;

fn matches(t: &Target) -> bool {
    t.game_id == DISCORD_ID || exe_name(t) == "slaythespire2.exe"
}

/// What the card shows during a run, from the save or, for guests, the log.
#[derive(Clone, Debug, Default, PartialEq)]
struct RunCard {
    /// `CHARACTER.X` ids, save or lobby order
    chars: Vec<String>,
    /// index into `chars` of this player
    local: Option<usize>,
    /// party size when `chars` can't tell (a guest loading a co-op save only sees ids)
    players: u32,
    ascension: Option<u32>,
    /// 0-based
    act_index: Option<u32>,
    /// `ACT.X`, only the save knows it
    act_id: Option<String>,
    floor: Option<u32>,
    /// "standard", "daily", "custom"
    mode: Option<String>,
    /// unix ms the run's play time started at
    start_ms: Option<i64>,
}

fn id_suffix(id: &str) -> &str {
    id.rsplit('.').next().unwrap_or(id)
}

fn char_name(id: &str) -> String {
    match id_suffix(id) {
        "IRONCLAD" => "Ironclad".into(),
        "SILENT" => "Silent".into(),
        "DEFECT" => "Defect".into(),
        "NECROBINDER" => "Necrobinder".into(),
        "REGENT" => "Regent".into(),
        other => title(other),
    }
}

fn act_name(id: &str) -> String {
    match id_suffix(id) {
        "OVERGROWTH" => "Overgrowth".into(),
        "UNDERDOCKS" => "Underdocks".into(),
        "HIVE" => "Hive".into(),
        "GLORY" => "Glory".into(),
        other => title(other),
    }
}

// pack keys in cliplib-rpc-assets/build/recipes/slay-the-spire-2.json
fn char_art(id: &str) -> Option<String> {
    let key = match id_suffix(id) {
        "IRONCLAD" => "ironclad",
        "SILENT" => "silent",
        "DEFECT" => "defect",
        "NECROBINDER" => "necrobinder",
        "REGENT" => "regent",
        _ => return None,
    };
    Some(art::url(SLUG, key))
}

fn act_art(id: &str) -> Option<String> {
    let key = match id_suffix(id) {
        "OVERGROWTH" => "overgrowth",
        "UNDERDOCKS" => "underdocks",
        "HIVE" => "hive",
        "GLORY" => "glory",
        _ => return None,
    };
    Some(art::url(SLUG, key))
}

// SOME_NEW_THING -> Some New Thing, for ids added after this was written
fn title(id: &str) -> String {
    id.split('_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f
                    .to_uppercase()
                    .chain(c.flat_map(char::to_lowercase))
                    .collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// current_run.save / current_run_mp.save (plain JSON, schema 14-16 seen). `local_id` is the
/// steamid64 of the folder the save sits in, it matches the player's `net_id` in co-op.
fn from_save(v: &Value, local_id: Option<&str>) -> Option<RunCard> {
    let players = v.get("players")?.as_array()?;
    let chars: Vec<String> = players
        .iter()
        .map(|p| Some(p.get("character_id")?.as_str()?.to_string()))
        .collect::<Option<_>>()?;
    if chars.is_empty() {
        return None;
    }
    let local = if players.len() == 1 {
        Some(0)
    } else {
        local_id.and_then(|id| {
            players.iter().position(|p| {
                p.get("net_id")
                    .map(|n| {
                        n.as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| n.to_string())
                    })
                    .as_deref()
                    == Some(id)
            })
        })
    };
    let act_index = v
        .get("current_act_index")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n < 100);
    let act_id = act_index
        .and_then(|i| v.get("acts")?.as_array()?.get(i as usize))
        .and_then(|a| a.get("id").and_then(Value::as_str).or_else(|| a.as_str()))
        .map(str::to_string);
    let start_ms = match (
        v.get("save_time").and_then(Value::as_i64),
        v.get("run_time").and_then(Value::as_i64),
    ) {
        (Some(saved), Some(played)) if saved > 0 && played >= 0 => {
            saved.checked_sub(played).and_then(|n| n.checked_mul(1000))
        }
        _ => None,
    };
    Some(RunCard {
        players: chars.len() as u32,
        chars,
        local,
        ascension: v
            .get("ascension")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok()),
        act_index,
        act_id,
        floor: act_index.and_then(|i| floor(v, i)),
        mode: v
            .get("game_mode")
            .and_then(Value::as_str)
            .map(str::to_string),
        start_ms,
    })
}

// floors so far = rooms finished in earlier acts (map_point_history, one list per act) plus the
// rooms entered in this one; visited_map_coords includes the room being played, so a fresh run
// is floor 1 and the save written on entering floor 34 says 16 + 15 + 3
fn floor(v: &Value, act_index: u32) -> Option<u32> {
    let visited = v.get("visited_map_coords")?.as_array()?.len();
    let earlier = if act_index == 0 {
        0
    } else {
        let history = v.get("map_point_history")?.as_array()?;
        if history.len() < act_index as usize {
            return None;
        }
        history
            .iter()
            .take(act_index as usize)
            .map(|a| a.as_array().map_or(0, Vec::len))
            .sum()
    };
    u32::try_from(earlier + visited).ok().filter(|f| *f > 0)
}

/// What godot.log says, per launch.
#[derive(Debug, Default)]
struct LogState {
    in_run: bool,
    /// joined someone else's lobby: no save of ours describes the run
    guest: bool,
    /// picked Continue or loaded a co-op save: the existing save file is this run
    resumed: bool,
    /// set when the run started, saves older than that belong to an earlier run
    since: Option<SystemTime>,
    local_id: Option<String>,
    card: RunCard,
}

impl LogState {
    fn line(&mut self, l: &str, now: SystemTime) {
        if l.contains("Time to main menu") {
            *self = LogState {
                local_id: self.local_id.take(),
                ..LogState::default()
            };
        } else if l.contains("[JoinFlow]") {
            self.guest = true;
        } else if let Some(rest) = l.split_once("Local player ").map(|(_, r)| r) {
            // "[StartRunLobby] Local player 7656... is ready", kept in memory only to find our character
            if let Some(id) = rest
                .split_whitespace()
                .next()
                .filter(|id| id.bytes().all(|b| b.is_ascii_digit()))
            {
                self.local_id = Some(id.to_string());
            }
        } else if l.contains("Embarking on a ")
            || l.contains("Loading a ")
            || l.contains("Continuing run with character: ")
        {
            self.start(l, now);
        } else if let Some((ch, _)) = l
            .split_once(" has won against ")
            .or_else(|| l.split_once(" has lost to "))
        {
            // "CHARACTER.NECROBINDER has won against encounter ...": the local player's stats, the
            // only place a guest who loaded a co-op save learns its character
            if self.in_run && self.card.local.is_none() {
                if let Some(id) = ch
                    .trim()
                    .rsplit(' ')
                    .next()
                    .filter(|id| id.starts_with("CHARACTER."))
                {
                    if self.card.chars.is_empty() {
                        self.card.chars.push(id.to_string());
                        self.card.local = Some(0);
                    } else if let Some(i) = self.card.chars.iter().position(|c| c == id) {
                        self.card.local = Some(i);
                    }
                }
            }
        } else if let Some(rest) = l.split_once("Run location changed to act ").map(|(_, r)| r) {
            self.in_run = true;
            self.since.get_or_insert(now);
            if let Some(n) = rest.split_whitespace().next().and_then(|n| n.parse().ok()) {
                self.card.act_index = (n < 100).then_some(n);
            }
        }
    }

    // "Embarking on a multiplayer run. Players: Player <id>, IRONCLAD,Player <id>, NECROBINDER.
    // Ascension: 6 Seed: H5PAPNQW0D", "Embarking on a DAILY ...", "Loading a multiplayer run. ...",
    // "Continuing run with character: <id>"
    fn start(&mut self, l: &str, now: SystemTime) {
        self.in_run = true;
        self.since = Some(now);
        self.resumed = l.contains("Loading a ") || l.contains("Continuing run");
        let mut card = RunCard::default();
        if l.contains(" DAILY ") {
            card.mode = Some("daily".into());
        } else if l.contains(" CUSTOM ") {
            card.mode = Some("custom".into());
        }
        if let Some(n) = l
            .split_once("Ascension: ")
            .and_then(|(_, r)| r.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok())
        {
            card.ascension = Some(n);
        }
        if let Some((_, players)) = l.split_once("Players: ") {
            let players = players.split(". Ascension:").next().unwrap_or(players);
            // "Loading a multiplayer run. Players: <id>,<id>." has ids only
            card.players = players
                .split(',')
                .filter(|p| {
                    p.trim()
                        .trim_end_matches('.')
                        .bytes()
                        .any(|b| b.is_ascii_digit())
                })
                .count() as u32;
            for p in players.split("Player ").skip(1) {
                let mut parts = p.split(',').map(str::trim);
                let (Some(id), Some(ch)) = (parts.next(), parts.next()) else {
                    continue;
                };
                if ch.is_empty() {
                    continue;
                }
                if self.local_id.as_deref() == Some(id) {
                    card.local = Some(card.chars.len());
                }
                card.chars
                    .push(format!("CHARACTER.{}", id_suffix(ch.trim_end_matches('.'))));
            }
        } else if let Some((_, ch)) = l.split_once("Continuing run with character: ") {
            let ch = ch.trim();
            if !ch.is_empty() {
                card.chars
                    .push(format!("CHARACTER.{}", id_suffix(ch.trim_end_matches('.'))));
                card.local = Some(0);
            }
        } else {
            // singleplayer embark lines name the character somewhere in the text
            for word in l.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.')) {
                let id = id_suffix(word);
                if matches!(
                    id,
                    "IRONCLAD" | "SILENT" | "DEFECT" | "NECROBINDER" | "REGENT"
                ) {
                    card.chars.push(format!("CHARACTER.{id}"));
                    card.local = Some(0);
                    break;
                }
            }
        }
        card.players = card.players.max(card.chars.len() as u32);
        self.card = card;
    }
}

/// `None` = main menu.
fn build(run: Option<&RunCard>, s: &Settings) -> Live {
    let Some(r) = run else {
        return Live {
            details: clamp("Main menu"),
            ..Live::default()
        };
    };
    let n = r.players.max(r.chars.len() as u32);
    let mut details = r
        .chars
        .iter()
        .map(|c| char_name(c))
        .collect::<Vec<_>>()
        .join(" + ");
    if details.is_empty() {
        details = if n > 1 {
            "Co-op run".into()
        } else {
            "In a run".into()
        };
    }
    match r.mode.as_deref() {
        Some("daily") => details = format!("Daily: {details}"),
        Some("custom") => details = format!("Custom: {details}"),
        _ => {}
    }
    if let Some(a) = r.ascension.filter(|a| *a > 0 && s.flag("ascension")) {
        details = format!("{details} · Ascension {a}");
    }

    let act = r.act_index.map(|i| match &r.act_id {
        Some(id) => format!("Act {}: {}", i + 1, act_name(id)),
        None => format!("Act {}", i + 1),
    });
    let state = match (act, r.floor) {
        (Some(a), Some(f)) => Some(format!("{a} · Floor {f}")),
        (Some(a), None) => Some(a),
        (None, Some(f)) => Some(format!("Floor {f}")),
        (None, None) => None,
    };

    let me = r
        .local
        .and_then(|i| r.chars.get(i))
        .or(if r.chars.len() == 1 {
            r.chars.first()
        } else {
            None
        });
    let by_char = me.and_then(|c| char_art(c).map(|u| (u, char_name(c))));
    let by_act = r
        .act_id
        .as_deref()
        .and_then(|a| act_art(a).map(|u| (u, act_name(a))));
    let (large_image, large_text) = match s.choice("picture").as_str() {
        "act" => by_act.or(by_char),
        _ => by_char.or(by_act),
    }
    .unzip();

    Live {
        details: clamp(details),
        state: state.and_then(clamp),
        large_image,
        large_text: large_text.and_then(clamp),
        start_ms: r.start_ms.filter(|_| s.flag("run_time")),
        party: (n > 1).then_some([n, MAX_PARTY.max(n)]),
        ..Live::default()
    }
}

fn preview(s: &Settings, scenario: &str) -> Preview {
    let now = crate::util::now_ms();
    let card =
        |chars: &[&str], asc, act: u32, act_id: Option<&str>, floor, played_min: i64| RunCard {
            chars: chars.iter().map(|c| format!("CHARACTER.{c}")).collect(),
            local: Some(0),
            players: chars.len() as u32,
            ascension: Some(asc),
            act_index: Some(act),
            act_id: act_id.map(|a| format!("ACT.{a}")),
            floor,
            mode: Some("standard".into()),
            start_ms: (played_min > 0).then(|| now - played_min * 60_000),
        };
    let run = match scenario {
        "act1" => Some(card(&["SILENT"], 0, 0, Some("OVERGROWTH"), Some(4), 6)),
        "ironclad" => Some(card(&["IRONCLAD"], 2, 0, Some("UNDERDOCKS"), Some(6), 8)),
        "defect" => Some(card(&["DEFECT"], 1, 0, Some("OVERGROWTH"), Some(8), 12)),
        "act2" => Some(card(&["NECROBINDER"], 5, 1, Some("HIVE"), Some(24), 31)),
        "act3" => Some(card(&["REGENT"], 10, 2, Some("GLORY"), Some(41), 52)),
        "coop" => Some(card(
            &["IRONCLAD", "DEFECT"],
            3,
            0,
            Some("UNDERDOCKS"),
            Some(9),
            14,
        )),
        // a guest only has the lobby and location lines of the log
        "coop_guest" => Some(RunCard {
            local: Some(1),
            act_id: None,
            floor: None,
            start_ms: None,
            ..card(&["SILENT", "NECROBINDER"], 6, 1, None, None, 0)
        }),
        _ => None,
    };
    Preview {
        game: "Slay the Spire II",
        icon: None,
        live: build(run.as_ref(), s),
    }
}

fn root() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("APPDATA")?).join("SlayTheSpire2"))
}

/// The newest current_run*.save under `<root>/steam/<steamid64>/profileN/saves` (or `default/`
/// for non-Steam builds), with its mtime and the steamid64 it belongs to.
fn newest_save(
    root: &Path,
    local_id: Option<&str>,
    multiplayer: Option<bool>,
) -> Option<(PathBuf, SystemTime, Option<String>)> {
    let mut best: Option<(PathBuf, SystemTime, Option<String>)> = None;
    for store in ["steam", "default"] {
        let accounts: Vec<PathBuf> = if store == "default" {
            vec![root.join(store)]
        } else {
            let Ok(accounts) = std::fs::read_dir(root.join(store)) else {
                continue;
            };
            accounts.flatten().map(|a| a.path()).collect()
        };
        for account in accounts {
            let id = account.file_name()?.to_string_lossy().into_owned();
            if store == "steam"
                && (!id.bytes().all(|b| b.is_ascii_digit())
                    || local_id.is_some_and(|local| local != id))
            {
                continue;
            }
            let Ok(profiles) = std::fs::read_dir(&account) else {
                continue;
            };
            for profile in profiles.flatten() {
                if !profile
                    .file_name()
                    .to_string_lossy()
                    .strip_prefix("profile")
                    .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
                {
                    continue;
                }
                for name in ["current_run.save", "current_run_mp.save"] {
                    if multiplayer.is_some_and(|mp| mp != name.contains("_mp")) {
                        continue;
                    }
                    let p = profile.path().join("saves").join(name);
                    let Ok(t) = std::fs::metadata(&p).and_then(|m| m.modified()) else {
                        continue;
                    };
                    if best.as_ref().is_none_or(|(_, bt, _)| t > *bt) {
                        let steam = (store == "steam").then(|| id.clone());
                        best = Some((p, t, steam));
                    }
                }
            }
        }
    }
    best
}

fn read_save(p: &Path) -> Option<Value> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(p)
        .ok()?
        .take(MAX_SAVE + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_SAVE {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn run(ctx: &Ctx) {
    let Some(root) = root() else { return };
    let log_path = root.join("logs").join("godot.log");
    let mut tail = Tail::new(&log_path, LOG_FIRST_READ);
    let session_start =
        SystemTime::UNIX_EPOCH + Duration::from_millis(ctx.target().started_at_ms.max(0) as u64);
    let mut log = LogState::default();
    let mut cached: Option<(PathBuf, SystemTime, Option<RunCard>)> = None;
    let mut first = true;
    loop {
        // lines carry no time: history counts from the launch, new lines from just before this poll
        let now = if first {
            session_start
        } else {
            SystemTime::now() - POLL - Duration::from_secs(1)
        };
        first = false;
        let have_log = std::fs::metadata(&log_path)
            .and_then(|m| m.modified())
            .is_ok_and(|t| t >= session_start);
        if have_log {
            tail.poll(|l| log.line(l, now));
        }

        let multiplayer = (have_log && log.in_run).then_some(log.card.players > 1);
        let save = newest_save(&root, log.local_id.as_deref(), multiplayer);
        let save_card = save.and_then(|(p, t, id)| {
            // without a log, a save written this session is the only sign of a run
            let usable = if have_log {
                log.in_run && !log.guest && (log.resumed || t >= log.since.unwrap_or(session_start))
            } else {
                t >= session_start
            };
            if !usable {
                cached = None;
                return None;
            }
            if cached
                .as_ref()
                .is_none_or(|(cp, ct, _)| *cp != p || *ct != t)
            {
                let value = read_save(&p);
                let mut card = value.as_ref().and_then(|v| from_save(v, id.as_deref()));
                // retry a partial write rather than keeping it in the cache
                if card.is_none() {
                    cached = None;
                    return None;
                }
                if t < session_start {
                    if let Some(c) = card.as_mut() {
                        let saved_ms = value
                            .as_ref()
                            .and_then(|v| v.get("save_time")?.as_i64()?.checked_mul(1000));
                        c.start_ms = c.start_ms.zip(saved_ms).and_then(|(start, saved)| {
                            start.checked_add(ctx.target().started_at_ms.checked_sub(saved)?)
                        });
                    }
                }
                cached = Some((p, t, card));
            }
            cached.as_ref().and_then(|(_, _, c)| c.clone())
        });

        let card = match save_card {
            Some(c) => Some(c),
            None if log.in_run => Some(log.card.clone()),
            None => None,
        };
        ctx.emit(Some(build(card.as_ref(), ctx.settings())));
        if !ctx.sleep(POLL) {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(v: Value) -> Settings {
        Settings::new(&MANIFEST, v)
    }

    // trimmed from a real schema 16 current_run.save, the run's first room
    fn fresh_save() -> Value {
        json!({
            "acts": [{"id": "ACT.OVERGROWTH", "rooms": {}}, {"id": "ACT.HIVE"}, {"id": "ACT.GLORY"}],
            "ascension": 0, "current_act_index": 0, "game_mode": "standard", "modifiers": [],
            "players": [{"character_id": "CHARACTER.DEFECT", "current_hp": 75, "gold": 99, "net_id": 1}],
            "run_time": 1, "save_time": 1779299480, "schema_version": 16, "start_time": 1779299479,
            "visited_map_coords": [{"col": 3, "row": 0}], "win_time": 0
        })
    }

    // trimmed from a real schema 14 current_run_mp.save, entering act 3's third room
    fn coop_save() -> Value {
        let hist = |n: usize| Value::Array(vec![json!({"map_point_type": "monster"}); n]);
        json!({
            "acts": [{"id": "ACT.OVERGROWTH"}, {"id": "ACT.HIVE"}, {"id": "ACT.GLORY"}],
            "ascension": 4, "current_act_index": 2,
            "map_point_history": [hist(16), hist(15), hist(2)],
            "players": [
                {"character_id": "CHARACTER.IRONCLAD", "net_id": 76561190000000001u64},
                {"character_id": "CHARACTER.DEFECT", "net_id": 76561190000000002u64}
            ],
            "run_time": 3181, "save_time": 1776434611, "schema_version": 14, "start_time": 1776431430,
            "visited_map_coords": [{"col": 3, "row": 0}, {"col": 2, "row": 1}, {"col": 2, "row": 2}]
        })
    }

    #[test]
    fn incomplete_players_and_bad_optional_fields() {
        let mut v = coop_save();
        v["players"][0]["character_id"] = Value::Null;
        assert!(from_save(&v, None).is_none());
        let mut v = fresh_save();
        v["save_time"] = json!(i64::MAX);
        assert_eq!(from_save(&v, None).unwrap().start_ms, None);
        let mut v = coop_save();
        v["players"][1]["net_id"] = json!("76561190000000002");
        assert_eq!(
            from_save(&v, Some("76561190000000002")).unwrap().local,
            Some(1)
        );
        v["current_act_index"] = json!(u32::MAX);
        let r = from_save(&v, None).unwrap();
        assert_eq!(r.act_index, None);
        assert!(build(Some(&r), &settings(json!({}))).details.is_some());
    }

    #[test]
    fn save_selection_skips_backups_and_other_accounts() {
        let root =
            std::env::temp_dir().join(format!("clipdip-sts2-selection-{}", std::process::id()));
        let main = root.join("steam/10000000000000001/profile1/saves/current_run.save");
        let mp = root.join("steam/10000000000000001/profile1/saves/current_run_mp.save");
        let backup = root.join("steam/backup/profile1/saves/current_run.save");
        for path in [&main, &mp, &backup] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"{}").unwrap();
        }
        assert_eq!(newest_save(&root, None, Some(false)).unwrap().0, main);
        assert_eq!(
            newest_save(&root, Some("10000000000000001"), Some(true))
                .unwrap()
                .0,
            mp
        );
        assert!(newest_save(&root, Some("10000000000000002"), None).is_none());
        let default = root.join("default/profile2/saves/current_run.save");
        std::fs::create_dir_all(default.parent().unwrap()).unwrap();
        std::fs::write(&default, b"{}").unwrap();
        assert_eq!(
            newest_save(&root, Some("10000000000000002"), Some(false))
                .unwrap()
                .0,
            default
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn matches_id_and_exe() {
        assert!(matches(&Target {
            game_id: DISCORD_ID.into(),
            ..Target::default()
        }));
        let exe = Some(r"C:\Steam\steamapps\common\Slay the Spire 2\SlayTheSpire2.exe".into());
        assert!(matches(&Target {
            game_id: "steam:2868840".into(),
            exe,
            ..Target::default()
        }));
        assert!(!matches(&Target {
            game_id: "1402418606364688549".into(),
            ..Target::default()
        }));
    }

    #[test]
    fn reads_saves() {
        let c = from_save(&fresh_save(), Some("76561190000000009")).unwrap();
        assert_eq!(c.chars, vec!["CHARACTER.DEFECT"]);
        assert_eq!(
            (c.local, c.act_index, c.floor, c.ascension),
            (Some(0), Some(0), Some(1), Some(0))
        );
        assert_eq!(c.act_id.as_deref(), Some("ACT.OVERGROWTH"));
        assert_eq!(c.start_ms, Some(1779299479000));

        let c = from_save(&coop_save(), Some("76561190000000002")).unwrap();
        assert_eq!(c.local, Some(1));
        assert_eq!(c.floor, Some(34));
        assert_eq!(c.act_id.as_deref(), Some("ACT.GLORY"));
        assert_eq!(c.mode, None);
        assert_eq!(from_save(&coop_save(), None).unwrap().local, None);

        assert!(from_save(&json!({"players": []}), None).is_none());
        assert!(from_save(&json!([1, 2]), None).is_none());
        // act 2 without the history to count act 1 by
        let mut v = coop_save();
        v["map_point_history"] = json!([]);
        assert_eq!(from_save(&v, None).unwrap().floor, None);
    }

    #[test]
    fn card_from_saves() {
        let s = settings(json!({}));
        let live = build(
            from_save(&coop_save(), Some("76561190000000002")).as_ref(),
            &s,
        );
        assert_eq!(
            live.details.as_deref(),
            Some("Ironclad + Defect · Ascension 4")
        );
        assert_eq!(live.state.as_deref(), Some("Act 3: Glory · Floor 34"));
        assert_eq!(live.party, Some([2, 4]));
        assert_eq!(live.large_image, Some(art::url(SLUG, "defect")));
        assert_eq!(live.large_text.as_deref(), Some("Defect"));
        assert_eq!(live.start_ms, Some((1776434611 - 3181) * 1000));

        let live = build(from_save(&coop_save(), None).as_ref(), &s);
        // which one is us is unknown: the act instead
        assert_eq!(live.large_image, Some(art::url(SLUG, "glory")));

        let live = build(
            from_save(&fresh_save(), None).as_ref(),
            &settings(json!({"picture": "act", "ascension": false, "run_time": false})),
        );
        assert_eq!(live.details.as_deref(), Some("Defect"));
        assert_eq!(live.state.as_deref(), Some("Act 1: Overgrowth · Floor 1"));
        assert_eq!(live.large_image, Some(art::url(SLUG, "overgrowth")));
        assert_eq!(live.start_ms, None);
        assert_eq!(live.party, None);
    }

    #[test]
    fn log_lines() {
        let now = SystemTime::now();
        let mut l = LogState::default();
        // real lines from a guest session, ids replaced
        for line in [
            "[INFO] [Startup] Time to main menu (Godot ticks): 11449ms",
            "[INFO] [JoinFlow] Received ClientLobbyJoinResponseMessage: ClientLobbyJoinResponseMessage Players: 2 Ascension: 6",
            "[INFO] [StartRunLobby] Local player 76561190000000002 is ready",
            "[INFO] Embarking on a multiplayer run. Players: Player 76561190000000001, IRONCLAD,Player 76561190000000002, NECROBINDER. Ascension: 6 Seed: H5PAPNQW0D",
            "[DEBUG] [RunLocationTargetedMessageBuffer] Run location changed to act 0 coord (null) room  (previously at: act 0 coord (null) room ), checking if we have enqueued messages",
            "[DEBUG] [RunLocationTargetedMessageBuffer] Run location changed to act 1 coord (null) room 0 (previously at: act 1 coord (null) room ), checking if we have enqueued messages",
        ] {
            l.line(line, now);
        }
        assert!(l.in_run && l.guest && !l.resumed);
        assert_eq!(
            l.card.chars,
            vec!["CHARACTER.IRONCLAD", "CHARACTER.NECROBINDER"]
        );
        assert_eq!(
            (l.card.local, l.card.ascension, l.card.act_index),
            (Some(1), Some(6), Some(1))
        );
        let live = build(Some(&l.card), &settings(json!({})));
        assert_eq!(
            live.details.as_deref(),
            Some("Ironclad + Necrobinder · Ascension 6")
        );
        assert_eq!(live.state.as_deref(), Some("Act 2"));
        assert_eq!(live.large_image, Some(art::url(SLUG, "necrobinder")));

        l.line(
            "[INFO] [Startup] Time to main menu (Godot ticks): 2302827ms",
            now,
        );
        assert!(!l.in_run && !l.guest);
        assert_eq!(l.local_id.as_deref(), Some("76561190000000002"));

        l.line(
            "[INFO] Continuing run with character: CHARACTER.REGENT",
            now,
        );
        assert!(l.in_run && l.resumed);
        assert_eq!(l.card.chars, vec!["CHARACTER.REGENT"]);

        l.line(
            "[INFO] Embarking on a DAILY singleplayer run with 1 players. Ascension: 0",
            now,
        );
        assert_eq!(l.card.mode.as_deref(), Some("daily"));
        assert!(!l.resumed);
    }

    #[test]
    fn guest_loading_a_save() {
        let now = SystemTime::now();
        let mut l = LogState::default();
        for line in [
            "[INFO] [LoadRunLobby] Local player 76561190000000002 is ready",
            "[INFO] Loading a multiplayer run. Players: 76561190000000001,76561190000000002.",
            "[DEBUG] [RunLocationTargetedMessageBuffer] Run location changed to act 2 coord (3, 0) room  (previously at: act 0 coord (null) room ), checking if we have enqueued messages",
        ] {
            l.line(line, now);
        }
        assert!(l.resumed && l.in_run);
        let live = build(Some(&l.card), &settings(json!({})));
        assert_eq!(live.details.as_deref(), Some("Co-op run"));
        assert!(!serde_json::to_string(&live).unwrap().contains("7656119"));
        assert_eq!(live.state.as_deref(), Some("Act 3"));
        assert_eq!(live.party, Some([2, 4]));
        l.line("[INFO] CHARACTER.NECROBINDER has won against encounter ENCOUNTER.TOADPOLES_WEAK. That's 3 wins", now);
        let live = build(Some(&l.card), &settings(json!({})));
        assert_eq!(live.details.as_deref(), Some("Necrobinder"));
        assert_eq!(live.party, Some([2, 4]));
        assert_eq!(live.large_image, Some(art::url(SLUG, "necrobinder")));
    }

    #[test]
    fn names_for_new_ids() {
        assert_eq!(char_name("CHARACTER.THE_WATCHER"), "The Watcher");
        assert_eq!(act_name("ACT.UNDERDOCKS"), "Underdocks");
        assert_eq!(char_art("CHARACTER.THE_WATCHER"), None);
    }

    #[test]
    fn every_scenario_has_a_card() {
        let s = settings(json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(preview(&s, key).live.details.is_some(), "{key}");
        }
        assert_eq!(
            preview(&s, "nope").live,
            preview(&s, MANIFEST.scenarios[0].0).live
        );
        assert_eq!(
            preview(&s, "menu").live.details.as_deref(),
            Some("Main menu")
        );
        let a2 = preview(&s, "act2").live;
        assert_eq!(a2.details.as_deref(), Some("Necrobinder · Ascension 5"));
        assert_eq!(a2.state.as_deref(), Some("Act 2: Hive · Floor 24"));
        let guest = preview(&s, "coop_guest").live;
        assert_eq!(guest.state.as_deref(), Some("Act 2"));
        assert_eq!(guest.party, Some([2, 4]));
        assert_eq!(guest.large_image, Some(art::url(SLUG, "necrobinder")));
        let act = preview(&settings(json!({"picture": "act"})), "act2").live;
        assert_eq!(act.large_image, Some(art::url(SLUG, "hive")));
    }
}
