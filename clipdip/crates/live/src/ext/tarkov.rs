//! Raid, queue and map. Ported from Tarkov-Rich-Presence by Ryan (MIT)
//! https://github.com/BetrixDev/Tarkov-Rich-Presence: watcher.ts, rpc.ts
//! TarkovMonitor by the-hideout (format only): GameWatcher.cs log markers

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use std::{path::Path, time::Duration};

pub static MANIFEST: Manifest = Manifest {
    id: "tarkov",
    name: "Escape from Tarkov",
    blurb: "Raid, map, queue and group status.",
    setup: None,
    credits: &[
        Credit {
            project: "Tarkov-Rich-Presence",
            author: "Ryan (BetrixDev)",
            url: "https://github.com/BetrixDev/Tarkov-Rich-Presence",
            license: "MIT",
        },
        Credit {
            project: "TarkovMonitor",
            author: "the-hideout",
            url: "https://github.com/the-hideout/TarkovMonitor",
            license: "format only",
        },
    ],
    options: &[
        Opt::toggle(
            "show_map",
            "Show map",
            "Show the raid map and its picture.",
            true,
        ),
        Opt::toggle(
            "show_group",
            "Show group status",
            "Show group membership when logs report it.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &["406637848297472017"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/3932890/library_hero.jpg"),
    preview,
    scenarios: &[
        ("menu", "Menus"),
        ("insurance", "Insurance"),
        ("confirmation", "Confirmation"),
        ("group", "Looking for group"),
        ("loading", "Loading map"),
        ("queue", "Queue"),
        ("raid", "Raid"),
        ("offline", "Offline raid"),
        ("end", "Raid ended"),
    ],
    steam_game: true,
    listed: true,
};

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str()) || util::exe_name(t) == "escapefromtarkov.exe"
}

#[derive(Clone, Copy, Default, PartialEq, Debug)]
enum Phase {
    #[default]
    Menu,
    Insurance,
    Confirmation,
    Group,
    Loading,
    Queue,
    Raid,
    End,
}

#[derive(Default)]
struct Raid {
    phase: Phase,
    map: Option<&'static str>,
    offline: bool,
    group: bool,
    start: Option<i64>,
}

fn map_key(raw: &str) -> Option<&'static str> {
    match util::art::norm(raw).as_str() {
        "bigmap" | "customs" => Some("customs"),
        "factory4day" | "factory4night" | "factoryday" | "factorynight" | "factory" => {
            Some("factory")
        }
        "interchange" => Some("interchange"),
        "laboratory" | "lab" | "thelab" => Some("lab"),
        "labyrinth" | "thelabyrinth" => Some("labyrinth"),
        "lighthouse" => Some("lighthouse"),
        "rezervbase" | "reserve" => Some("reserve"),
        "shoreline" => Some("shoreline"),
        "tarkovstreets" | "streetsoftarkov" | "streets" => Some("streets"),
        "woods" => Some("woods"),
        "sandbox" | "sandboxhigh" | "groundzero" => Some("ground-zero"),
        "terminal" => Some("terminal"),
        "icebreaker" => Some("icebreaker"),
        _ => None,
    }
}

fn map_name(key: &str) -> &'static str {
    match key {
        "customs" => "Customs",
        "factory" => "Factory",
        "interchange" => "Interchange",
        "lab" => "The Lab",
        "labyrinth" => "The Labyrinth",
        "lighthouse" => "Lighthouse",
        "reserve" => "Reserve",
        "shoreline" => "Shoreline",
        "streets" => "Streets of Tarkov",
        "woods" => "Woods",
        "ground-zero" => "Ground Zero",
        "terminal" => "Terminal",
        "icebreaker" => "Icebreaker",
        _ => "Unknown map",
    }
}

impl Raid {
    fn parse(&mut self, line: &str, now: Option<i64>) {
        if let Some(path) = line
            .split_once("scene preset path:maps/")
            .and_then(|(_, p)| p.split_once(".bundle").map(|(m, _)| m))
        {
            self.phase = Phase::Loading;
            self.map = map_key(path);
            self.offline = false;
            self.start = None;
        } else if line.contains("TRACE-NetworkGameCreate profileStatus") {
            if let Some(loc) = line
                .split_once("Location: ")
                .map(|(_, s)| s.split(',').next().unwrap_or_default())
            {
                self.map = map_key(loc);
            }
            self.offline = line.contains("RaidMode: Offline") || line.contains("RaidMode: Local");
            self.phase = Phase::Loading;
        } else if line.contains("application|GameStarted")
            || line.contains("TRACE-NetworkGameCreate 5")
        {
            if self.phase != Phase::Raid {
                self.start = now;
            }
            self.phase = Phase::Raid;
        } else if line.contains("TRACE-NetworkGameMatching")
            || line.contains("application|LocationLoaded")
        {
            if self.phase != Phase::Queue {
                self.start = now;
            }
            self.phase = Phase::Queue;
        } else if line.contains("Network game matching aborted")
            || line.contains("Network game matching cancelled")
            || line.contains("/client/items")
            || line.contains("application|Init: pstrGameVersion:")
        {
            self.phase = Phase::Menu;
            self.map = None;
            self.start = None;
            self.offline = false;
        } else if line.contains("UserMatchOver")
            || line.contains("/match/offline/end")
            || line.contains("/client/putMetrics")
        {
            self.phase = Phase::End;
            self.start = None;
        } else if line.contains("/insurance/items/list/cost") {
            self.phase = Phase::Insurance;
            self.map = None;
            self.start = None;
        } else if line.contains("/match/group/invite/cancel-all")
            || line.contains("/match/group/looking/stop")
        {
            self.phase = Phase::Confirmation;
            self.start = None;
        } else if line.contains("/match/group/status") {
            self.phase = Phase::Group;
            self.start = None;
        } else if line.contains("/bot/generate") && self.phase != Phase::Raid {
            self.offline = true;
            self.phase = Phase::Raid;
            self.start = now;
        }
        if line.contains("GroupMatchInviteAccept") {
            self.group = true;
        }
        if line.contains("GroupMatchWasRemoved") {
            self.group = false;
        }
    }
}

fn build(s: &Settings, r: &Raid) -> Live {
    let details = match r.phase {
        Phase::Menu => "Browsing menus",
        Phase::Insurance | Phase::Confirmation | Phase::Group => "Preparing to escape",
        Phase::Loading => "Loading map",
        Phase::Queue => "Searching for a raid",
        Phase::Raid if r.offline => "In an offline raid",
        Phase::Raid => "In a raid",
        Phase::End => "Raid ended",
    };
    let mut states = Vec::new();
    match r.phase {
        Phase::Insurance => states.push("Buying insurance"),
        Phase::Confirmation => states.push("Waiting to confirm"),
        Phase::Group => states.push("Looking for group"),
        _ => {}
    }
    let show_map = s.flag("show_map")
        && matches!(
            r.phase,
            Phase::Loading | Phase::Queue | Phase::Raid | Phase::End
        );
    if show_map {
        if let Some(key) = r.map {
            states.push(map_name(key));
        }
    }
    if s.flag("show_group") && r.group {
        states.push("In a group");
    }
    Live {
        details: util::clamp(details),
        state: util::clamp(states.join(", ")),
        large_image: if show_map {
            r.map.map(|key| util::art::url("tarkov", key))
        } else {
            None
        },
        large_text: if show_map {
            r.map.and_then(|key| util::clamp(map_name(key)))
        } else {
            None
        },
        start_ms: if matches!(r.phase, Phase::Queue | Phase::Raid) {
            r.start
        } else {
            None
        },
        ..Live::default()
    }
}

fn session_dir(logs: &Path, started: i64) -> Option<std::path::PathBuf> {
    let p = util::tail::newest_file(logs, |n| n.starts_with("log_"))?;
    let modified = p
        .metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    (modified >= started.saturating_sub(60_000)).then_some(p)
}

fn run(ctx: &Ctx) {
    let logs = ctx
        .target()
        .exe
        .as_ref()
        .and_then(|p| p.parent())
        .map(|p| p.join("Logs"));
    let mut tails: Vec<util::tail::Tail> = Vec::new();
    let mut current = None;
    let mut r = Raid::default();
    loop {
        let dir = logs
            .as_deref()
            .and_then(|p| session_dir(p, ctx.target().started_at_ms));
        let changed = dir != current;
        if changed {
            tails.clear();
            r = Raid::default();
            current = dir.clone();
        }
        if let Some(dir) = dir {
            if let Ok(files) = std::fs::read_dir(&dir) {
                for entry in files.flatten() {
                    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                    if name.ends_with(".log")
                        && ["application", "network", "traces", "notifications"]
                            .iter()
                            .any(|s| name.contains(s))
                        && !tails.iter().any(|t| t.path() == entry.path())
                    {
                        tails.push(util::tail::Tail::new(entry.path(), 256 * 1024));
                    }
                }
            }
            // event timestamps sort application and network events into one timeline
            let mut lines = Vec::new();
            for tail in &mut tails {
                tail.poll(|line| lines.push(line.to_string()));
            }
            lines.sort_by(|a, b| a.get(..23).unwrap_or(a).cmp(b.get(..23).unwrap_or(b)));
            for line in lines {
                r.parse(&line, if changed { None } else { Some(util::now_ms()) });
            }
            ctx.emit(if tails.is_empty() {
                None
            } else {
                Some(build(ctx.settings(), &r))
            });
        } else {
            ctx.emit(None);
        }
        if !ctx.sleep(Duration::from_secs(if tails.is_empty() { 15 } else { 5 })) {
            return;
        }
    }
}

fn preview(s: &Settings, key: &str) -> Preview {
    let phase = match key {
        "insurance" => Phase::Insurance,
        "confirmation" => Phase::Confirmation,
        "group" => Phase::Group,
        "loading" => Phase::Loading,
        "queue" => Phase::Queue,
        "raid" | "offline" => Phase::Raid,
        "end" => Phase::End,
        _ => Phase::Menu,
    };
    let r = Raid {
        phase,
        map: Some("customs"),
        offline: key == "offline",
        group: key == "group",
        start: Some(1_700_000_000_000),
    };
    Preview {
        game: "Escape from Tarkov",
        icon: None,
        live: build(s, &r),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn log_transitions_and_unknown_map() {
        let mut r = Raid::default();
        r.parse(
            "2026-01-01 12:00:00.000|application|scene preset path:maps/bigmap.bundle",
            Some(1),
        );
        assert_eq!(r.map, Some("customs"));
        assert_eq!(r.phase, Phase::Loading);
        r.parse("application|LocationLoaded:12.0 real:13.0", Some(2));
        assert_eq!(r.phase, Phase::Queue);
        r.parse("application|TRACE-NetworkGameCreate profileStatus 'Status: Ready, RaidMode: Online, Location: bigmap, GameMode: Regular'",Some(3));
        assert_eq!(r.phase, Phase::Loading);
        r.parse("application|GameStarted", Some(4));
        assert_eq!(r.start, Some(4));
        r.parse("application|GameStarted", Some(5));
        assert_eq!(r.start, Some(4));
        r.parse("Got notification | UserMatchOver", Some(6));
        assert_eq!(r.phase, Phase::End);
        assert!(r.start.is_none());
        r.parse(
            "application|scene preset path:maps/unreleased.bundle",
            Some(7),
        );
        assert!(r.map.is_none());
        r.parse("application|Network game matching cancelled", Some(8));
        assert_eq!(r.phase, Phase::Menu);
    }
    #[test]
    fn groups_and_offline() {
        let mut r = Raid::default();
        r.parse("Got notification | GroupMatchInviteAccept", None);
        assert!(r.group);
        r.parse("Got notification | GroupMatchWasRemoved", None);
        assert!(!r.group);
        r.parse("https://redacted.invalid/client/bot/generate", Some(20));
        assert!(r.offline);
        assert_eq!(r.phase, Phase::Raid);
        r.parse("/match/offline/end", None);
        assert_eq!(r.phase, Phase::End);
        assert_eq!(map_key("Sandbox_high"), Some("ground-zero"));
        assert_eq!(map_key("RezervBase"), Some("reserve"));
    }
    #[test]
    fn previews_and_settings() {
        let s = Settings::new(&MANIFEST, json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&s, key).live.is_empty());
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        for (key, scenario) in [("show_map", "raid"), ("show_group", "group")] {
            let hidden = Settings::new(&MANIFEST, json!({key:false}));
            assert_ne!(preview(&s, scenario).live, preview(&hidden, scenario).live);
        }
    }
}
