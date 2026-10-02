//! Hero and match details, written independently from log formats described by
//! HeyTariq/deadlock-rpc and Jelloge/Deadlock-Rich-Presence (GPL-3.0, format only):
//! https://github.com/HeyTariq/deadlock-rpc src/log_watcher.rs, src/game_state.rs;
//! https://github.com/Jelloge/Deadlock-Rich-Presence src/config.json, src/console_log.py

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const HEADER: &str = "https://cdn.cloudflare.steamstatic.com/steam/apps/1422450/header.jpg";
const HERO_API: &str = "https://api.deadlock-api.com/v1/assets/heroes";

pub static MANIFEST: Manifest = Manifest {
    id: "deadlock",
    name: "Deadlock",
    blurb: "Hero, match phase, mode and party size.",
    setup: Some("Add -condebug to Deadlock's Steam launch options, then restart the game."),
    credits: &[
        Credit {
            project: "deadlock-rpc",
            author: "HeyTariq",
            url: "https://github.com/HeyTariq/deadlock-rpc",
            license: "format only",
        },
        Credit {
            project: "Deadlock-Rich-Presence",
            author: "Jelloge",
            url: "https://github.com/Jelloge/Deadlock-Rich-Presence",
            license: "format only",
        },
    ],
    options: &[
        Opt::toggle(
            "show_hero_image",
            "Show hero image",
            "Use the selected hero's portrait.",
            true,
        ),
        Opt::toggle(
            "show_match_timer",
            "Show match clock",
            "Show elapsed time from an observed match start.",
            true,
        ),
        Opt::choice(
            "hero_portrait_style",
            "Hero portrait",
            "Choose the hero portrait style.",
            "normal",
            &[
                ("normal", "Normal"),
                ("gloat", "Gloat"),
                ("critical", "Critical"),
            ],
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &["1276737795012165766"],
    art: Some(HEADER),
    preview,
    scenarios: &[
        ("menu", "Main menu"),
        ("queue", "In queue"),
        ("hero_select", "Hero select"),
        ("match", "In match"),
        ("ranked", "Ranked"),
        ("sandbox", "Sandbox"),
        ("post_game", "Post game"),
    ],
    steam_game: true,
    listed: true,
};

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || t.game_id == "steam:1422450"
        || t.steam_appid.as_deref() == Some("1422450")
        || matches!(util::exe_name(t).as_str(), "deadlock.exe" | "project8.exe")
}

fn log_path(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n.eq_ignore_ascii_case("game"))
        })
        .map(|p| p.join("citadel/console.log"))
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
enum Phase {
    #[default]
    Menu,
    Hideout,
    Queue,
    Select,
    Match,
    Post,
    Spectating,
}
#[derive(Clone, Copy, Default, PartialEq, Debug)]
enum Mode {
    #[default]
    Unknown,
    Normal,
    Ranked,
    Bots,
    Sandbox,
    StreetBrawl,
}
impl Mode {
    fn label(self) -> &'static str {
        match self {
            Self::Unknown => "Match",
            Self::Normal => "Normal",
            Self::Ranked => "Ranked",
            Self::Bots => "Bot match",
            Self::Sandbox => "Sandbox",
            Self::StreetBrawl => "Street Brawl",
        }
    }
}
#[derive(Default)]
struct State {
    phase: Phase,
    mode: Mode,
    map: String,
    hero: Option<String>,
    hero_locked: bool,
    start: Option<i64>,
    party: Option<u32>,
    members: HashSet<u64>,
    party_id: Option<u64>,
    players: u32,
}

fn token_after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    line.split_once(marker)?.1.split_whitespace().next()
}
fn hero_key(raw: &str) -> Option<String> {
    if raw.is_empty()
        || raw.len() > 80
        || !raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return None;
    }
    let mut key = raw.to_ascii_lowercase();
    if let Some((base, version)) = key.rsplit_once("_v") {
        if !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit()) {
            key = base.to_owned();
        }
    }
    Some(if key.starts_with("hero_") {
        key
    } else {
        format!("hero_{key}")
    })
}
impl State {
    fn transition(&mut self, phase: Phase, now: Option<i64>) {
        if self.phase != phase {
            self.start = if phase == Phase::Match { now } else { None };
            if matches!(phase, Phase::Menu | Phase::Select) {
                self.hero = None;
                self.hero_locked = false;
            }
        }
        self.phase = phase;
    }
    fn parse(&mut self, line: &str, now: Option<i64>) {
        if line.len() > 4096 || line.contains(" :  ") {
            return;
        }
        if line.contains("Source2Shutdown") || line.contains("Dispatching EventAppShutdown_t") {
            *self = Self::default();
            return;
        }
        let map = line
            .split_once("[Client] Map:")
            .and_then(|(_, s)| s.trim().strip_prefix('"'))
            .and_then(|s| s.split_once('"').map(|v| v.0))
            .or_else(|| token_after(line, "[Client] Created physics for "))
            .or_else(|| {
                if !line.contains("[HostStateManager] Host activate:") {
                    return None;
                }
                line.rsplit_once('(')
                    .and_then(|(_, s)| s.split_once(')').map(|v| v.0))
            });
        if let Some(map) = map {
            if map != "start" && map != self.map && map.len() < 80 {
                self.map = map.to_owned();
                self.hero = None;
                self.hero_locked = false;
                self.players = 0;
                self.mode = match map {
                    "new_player_basics" => Mode::Sandbox,
                    "street_test" | "street_test_bridge" => Mode::Normal,
                    _ => Mode::Unknown,
                };
                self.start = None;
                self.transition(
                    if map == "dl_hideout" {
                        Phase::Hideout
                    } else if self.mode == Mode::Sandbox {
                        Phase::Match
                    } else {
                        Phase::Select
                    },
                    now,
                );
                if self.mode == Mode::Sandbox {
                    self.start = now;
                }
            }
        }
        if line.contains("k_EMsgClientToGCStartMatchmaking") {
            self.transition(Phase::Queue, now);
        } else if line.contains("k_EMsgClientToGCStopMatchmaking") && self.phase == Phase::Queue {
            self.transition(
                if self.map == "dl_hideout" {
                    Phase::Hideout
                } else {
                    Phase::Menu
                },
                now,
            );
        } else if token_after(line, "Lobby ").is_some_and(|s| s.parse::<u64>().is_ok())
            && token_after(line, " for Match ").is_some_and(|s| s.parse::<u64>().is_ok())
        {
            if line.ends_with("created") {
                self.mode = Mode::Unknown;
                self.transition(Phase::Select, now);
            }
            if line.ends_with("destroyed") {
                self.transition(Phase::Post, now);
            }
        }
        if line.contains("Playing Broadcast") {
            self.transition(Phase::Spectating, now);
        }
        if self.map != "dl_hideout" && self.phase != Phase::Spectating {
            if let Some(name) = token_after(line, "ChangeGameState:") {
                match name.to_ascii_lowercase().as_str() {
                    "matchintro" => self.transition(Phase::Select, now),
                    "gameinprogress" | "inprogress" => self.transition(Phase::Match, now),
                    "postgame" => self.transition(Phase::Post, now),
                    _ => (),
                }
            }
        }
        if (line.contains("[Client] Disconnecting from server:")
            && !line.contains("LOOPDEACTIVATE")
            || line.contains("LoopMode: menu"))
            && matches!(self.phase, Phase::Match | Phase::Select | Phase::Spectating)
        {
            self.transition(Phase::Post, now);
        }
        if let Some(n) = token_after(line, "[Client] Players:").and_then(|n| n.parse::<u32>().ok())
        {
            if self.map == "dl_hideout" && (1..=6).contains(&n) {
                self.party = Some(n);
            } else {
                self.players = self.players.max(n);
            }
        }
        if self.mode == Mode::Unknown
            && self.map != "dl_hideout"
            && line.contains("Initializing bot for player slot ")
        {
            self.mode = Mode::Bots;
        }
        if self.map == "dl_midtown" && self.mode == Mode::Unknown {
            self.mode = if self.players >= 9 {
                Mode::Normal
            } else if self.players >= 4 {
                Mode::StreetBrawl
            } else {
                Mode::Unknown
            };
        }
        // server hero loads can describe opponents; accept only the first signal in a match
        let hero = line
            .split_once("[Server] Loaded hero ")
            .and_then(|(_, s)| s.split_once('/'))
            .and_then(|(_, s)| s.split_whitespace().next())
            .or_else(|| {
                if !line.contains("VMDL Camera Pose Success!") {
                    return None;
                }
                [
                    "models/heroes/",
                    "models/heroes_wip/",
                    "models/heroes_staging/",
                ]
                .iter()
                .find_map(|p| {
                    line.split_once(p)
                        .and_then(|(_, s)| s.split_once('/').map(|v| v.0))
                })
            });
        if matches!(self.phase, Phase::Select | Phase::Match | Phase::Hideout)
            && (!self.hero_locked || self.mode == Mode::Sandbox || self.phase == Phase::Hideout)
        {
            if let Some(key) = hero.and_then(hero_key) {
                self.hero = Some(key);
                self.hero_locked = self.phase == Phase::Match;
            }
        }
        if line.contains("CMsgGCToClientPartyEvent:") {
            let party_id = token_after(line, "party_id:").and_then(|s| s.parse::<u64>().ok());
            let member =
                token_after(line, "initiator_account_id:").and_then(|s| s.parse::<u64>().ok());
            if let (Some(id), Some(member), Some(event)) =
                (party_id, member, token_after(line, "event:"))
            {
                if self.party_id.is_some_and(|old| old != id) {
                    self.members.clear();
                    self.party = None;
                }
                self.party_id = Some(id);
                if event.contains("JoinedParty") && self.members.insert(member) {
                    self.party = self.party.map(|n| n.saturating_add(1).min(6));
                }
                if event.contains("LeftParty")
                    || event.contains("RemovedFromParty")
                    || event.contains("KickedFromParty")
                {
                    self.members.remove(&member);
                    self.party = self.party.map(|n| n.saturating_sub(1).max(1));
                }
                if event.to_ascii_lowercase().contains("disband") {
                    self.members.clear();
                    self.party_id = None;
                    self.party = Some(1);
                }
            }
        }
        if line.contains("[Hideout] Hideout Lobby Connection State:") && line.ends_with("(0)") {
            self.party = Some(1);
            self.members.clear();
            self.party_id = None;
        }
    }
}

#[derive(Deserialize)]
struct Hero {
    class_name: String,
    name: String,
    #[serde(default)]
    images: BTreeMap<String, String>,
}
type Heroes = BTreeMap<String, Hero>;
fn decode_heroes(bytes: &[u8]) -> Option<Heroes> {
    let heroes: Vec<Hero> = serde_json::from_slice(bytes).ok()?;
    Some(
        heroes
            .into_iter()
            .map(|h| (h.class_name.clone(), h))
            .collect(),
    )
}
fn heroes(ctx: &Ctx) -> Heroes {
    let path = ctx.cache_dir().map(|p| p.join("heroes.json"));
    let cached = path
        .as_ref()
        .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.len() <= 8 * 1024 * 1024))
        .and_then(|p| std::fs::read(p).ok());
    let fresh = path
        .as_ref()
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < Duration::from_secs(86400));
    if fresh {
        if let Some(h) = cached.as_deref().and_then(decode_heroes) {
            return h;
        }
    }
    let response = util::http::agent().get(HERO_API).call().ok().and_then(|r| {
        use std::io::Read;
        let mut b = Vec::new();
        r.into_reader()
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut b)
            .ok()?;
        (b.len() <= 8 * 1024 * 1024).then_some(b)
    });
    if let Some(b) = response {
        if let Some(h) = decode_heroes(&b) {
            if let Some(p) = path {
                let _ = std::fs::write(p, &b);
            }
            return h;
        }
    }
    cached
        .as_deref()
        .and_then(decode_heroes)
        .unwrap_or_default()
}
fn build(s: &State, settings: &Settings, heroes: &Heroes) -> Live {
    let phase = match s.phase {
        Phase::Menu => "Main menu",
        Phase::Hideout => "Hideout",
        Phase::Queue => "In queue",
        Phase::Select => "Hero select",
        Phase::Match => s.mode.label(),
        Phase::Post => "Post game",
        Phase::Spectating => "Spectating",
    };
    let hero = s.hero.as_ref().and_then(|key| heroes.get(key));
    let show_hero = matches!(s.phase, Phase::Hideout | Phase::Select | Phase::Match);
    let portrait = hero
        .and_then(|h| {
            let style = match settings.choice("hero_portrait_style").as_str() {
                "gloat" => "hero_card_gloat",
                "critical" => "hero_card_critical",
                _ => "icon_hero_card",
            };
            h.images
                .get(style)
                .or_else(|| h.images.get("icon_hero_card"))
                .or_else(|| h.images.get("icon_image_small"))
        })
        .filter(|u| u.starts_with("https://"));
    Live {
        details: util::clamp(if show_hero {
            hero.map(|h| format!("{phase}, {}", h.name))
                .unwrap_or_else(|| phase.to_owned())
        } else {
            phase.to_owned()
        }),
        large_image: Some(if show_hero && settings.flag("show_hero_image") {
            portrait.cloned().unwrap_or_else(|| HEADER.to_owned())
        } else {
            HEADER.to_owned()
        }),
        large_text: util::clamp(
            hero.filter(|_| show_hero)
                .map(|h| h.name.clone())
                .unwrap_or_else(|| "Deadlock".to_owned()),
        ),
        start_ms: if s.phase == Phase::Match && settings.flag("show_match_timer") {
            s.start
        } else {
            None
        },
        party: s.party.filter(|n| (1..=6).contains(n)).map(|n| [n, 6]),
        competing: s.phase == Phase::Match && s.mode == Mode::Ranked,
        ..Live::default()
    }
}
fn preview(settings: &Settings, scenario: &str) -> Preview {
    let mut s = State::default();
    match scenario {
        "queue" => s.phase = Phase::Queue,
        "hero_select" => s.phase = Phase::Select,
        "match" | "ranked" | "sandbox" => {
            s.phase = Phase::Match;
            s.mode = match scenario {
                "ranked" => Mode::Ranked,
                "sandbox" => Mode::Sandbox,
                _ => Mode::Normal,
            };
            s.start = Some(1_700_000_000_000);
        }
        "post_game" => s.phase = Phase::Post,
        _ => (),
    }
    if matches!(s.phase, Phase::Select | Phase::Match) {
        s.hero = Some("hero_inferno".to_owned());
    }
    if s.phase != Phase::Menu {
        s.party = Some(2);
    }
    let data = decode_heroes(include_bytes!("deadlock/preview-heroes.json")).unwrap_or_default();
    Preview {
        game: "Deadlock",
        icon: None,
        live: build(&s, settings, &data),
    }
}
fn run(ctx: &Ctx) {
    let Some(path) = ctx.target().exe.as_deref().and_then(log_path) else {
        return;
    };
    let data = heroes(ctx);
    let mut tail = util::tail::Tail::new(&path, 256 * 1024);
    let mut s = State::default();
    let mut previous: Option<(u64, Option<SystemTime>)> = None;
    let mut first = true;
    loop {
        let meta = std::fs::metadata(&path).ok();
        let valid = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .is_some_and(|t| t.as_millis() as i64 >= ctx.target().started_at_ms);
        if valid {
            if let Some(m) = meta {
                let current = (m.len(), m.created().ok());
                if previous.is_some_and(|p| current.0 < p.0 || current.1 != p.1) {
                    s = State::default();
                }
                previous = Some(current);
            }
            let now = (!first).then(util::now_ms);
            tail.poll(|line| s.parse(line.trim(), now));
            first = false;
            ctx.emit(Some(build(&s, ctx.settings(), &data)));
        } else {
            s = State::default();
            tail.poll(|_| {});
            ctx.emit(None);
        }
        if !ctx.sleep(Duration::from_secs(if valid { 5 } else { 15 })) {
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
    fn previews_and_options() {
        let a = settings(serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&a, key).live.is_empty());
        }
        assert_eq!(preview(&a, "unknown").live, preview(&a, "menu").live);
        let b = settings(serde_json::json!({"show_hero_image":false,"show_match_timer":false}));
        assert_ne!(preview(&a, "match").live, preview(&b, "match").live);
        assert_ne!(
            preview(&a, "match").live.large_image,
            preview(
                &settings(serde_json::json!({"hero_portrait_style":"gloat"})),
                "match"
            )
            .live
            .large_image
        );
        assert!(preview(&a, "ranked").live.competing);
        assert!(!preview(&a, "queue").live.competing);
    }
    #[test]
    fn lifecycle_and_hero_lock() {
        let mut s = State::default();
        s.parse(
            "[GCClient] Send msg 9010 (k_EMsgClientToGCStartMatchmaking)",
            Some(1000),
        );
        assert_eq!(s.phase, Phase::Queue);
        s.parse("Lobby 1 for Match 2 created", Some(1000));
        assert_eq!(s.phase, Phase::Select);
        s.parse("ChangeGameState: GameInProgress (7)", Some(2000));
        assert_eq!(s.start, Some(2000));
        s.parse("[Server] Loaded hero 1/hero_inferno", Some(3000));
        s.parse("[Server] Loaded hero 2/hero_abrams", Some(3000));
        assert_eq!(s.hero.as_deref(), Some("hero_inferno"));
        s.parse("ChangeGameState: PostGame (6)", Some(4000));
        assert_eq!(s.phase, Phase::Post);
        assert_eq!(s.start, None);
        s.parse("LoopMode: menu", None);
        assert_eq!(s.phase, Phase::Post);
    }
    #[test]
    fn modes_party_and_host_paths() {
        let mut s = State::default();
        s.parse("[Client] Map: \"dl_hideout\"", None);
        s.parse("[Client] Players: 3 (0 bots) / 3 humans", None);
        assert_eq!(s.party, Some(3));
        s.parse(
            "Initializing bot for player slot 1: k_ECitadelBotDifficulty_Easy",
            None,
        );
        assert_eq!(s.mode, Mode::Unknown);
        s.parse("[Client] Created physics for new_player_basics", None);
        assert_eq!(s.mode, Mode::Sandbox);
        s.parse("[Client] Created physics for dl_midtown", None);
        s.parse("[Client] Players: 6 (0 bots) / 6 humans", None);
        assert_eq!(s.mode, Mode::StreetBrawl);
        assert_eq!(hero_key("inferno_v2").as_deref(), Some("hero_inferno"));
        assert!(hero_key("../secret").is_none());
        assert_eq!(
            log_path(Path::new(
                r"C:\Steam\steamapps\common\Deadlock\game\bin\win64\deadlock.exe"
            )),
            Some(
                PathBuf::from(r"C:\Steam\steamapps\common\Deadlock\game")
                    .join("citadel/console.log")
            )
        );
    }
    #[test]
    fn party_snapshots_and_match_start() {
        let mut s = State::default();
        s.parse(
            "[HostStateManager] Host activate: Loading (dl_hideout)",
            None,
        );
        assert_eq!(s.phase, Phase::Hideout);
        s.parse("[Client] Players: 2 (0 bots) / 2 humans", None);
        s.parse("CMsgGCToClientPartyEvent: { party_id: 1 event: k_ePartyEvent_JoinedParty initiator_account_id: 2 }", None);
        assert_eq!(s.party, Some(3));
        s.parse("CMsgGCToClientPartyEvent: { party_id: 1 event: k_ePartyEvent_JoinedParty initiator_account_id: 2 }", None);
        assert_eq!(s.party, Some(3));
        s.parse("CMsgGCToClientPartyEvent: { party_id: 1 event: k_ePartyEvent_LeftParty initiator_account_id: 2 }", None);
        assert_eq!(s.party, Some(2));
        s.parse("[Client] Map: \"dl_midtown\"", Some(1000));
        assert_eq!(s.phase, Phase::Select);
        assert_eq!(s.start, None);
        s.parse("ChangeGameState: GameInProgress (7)", Some(2000));
        assert_eq!(s.start, Some(2000));
        s.parse("[Client] Map: \"new_player_basics\"", Some(3000));
        assert_eq!(s.start, Some(3000));
    }
    #[test]
    fn malformed_data_and_replay_clock() {
        assert!(decode_heroes(b"{}").is_none());
        let mut s = State::default();
        s.parse("ChangeGameState:", None);
        s.parse("[Client] Map: \"", None);
        s.parse("[Server] Loaded hero /", None);
        s.parse("ChangeGameState: InProgress (7)", None);
        assert_eq!(s.start, None);
        s.parse("player :  ChangeGameState: PostGame (6)", None);
        assert_eq!(s.phase, Phase::Match);
        let h = decode_heroes(include_bytes!("deadlock/preview-heroes.json")).unwrap();
        assert!(h.contains_key("hero_inferno"));
    }
}
