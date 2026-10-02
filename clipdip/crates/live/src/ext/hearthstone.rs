//! Mode, heroes, turn and result. Ported from python-hslog by Jerome Leclanche
//! (MIT), https://github.com/HearthSim/python-hslog: tokens.py, parser.py

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

pub static MANIFEST: Manifest = Manifest {
    id: "hearthstone",
    name: "Hearthstone",
    blurb: "Mode, your class, opponent class, turn and result.",
    setup: Some("Logging is enabled automatically and works from the next start."),
    credits: &[Credit {
        project: "python-hslog",
        author: "Jerome Leclanche",
        url: "https://github.com/HearthSim/python-hslog",
        license: "MIT",
    }],
    options: &[
        Opt::toggle(
            "show_opponent",
            "Show opponent class",
            "Show the opposing hero's class.",
            true,
        ),
        Opt::toggle(
            "show_turn",
            "Show turn",
            "Show the current turn number.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &["356875890958925834"],
    art: Some("https://cdn.jsdelivr.net/gh/yuma-dev/cliplib-rpc-assets@v3/hearthstone/banner.webp"),
    preview,
    scenarios: &[
        ("menu", "Menus"),
        ("casual", "Casual"),
        ("ranked", "Ranked"),
        ("arena", "Arena"),
        ("win", "Victory"),
        ("loss", "Defeat"),
    ],
    steam_game: false,
    listed: true,
};

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str()) || util::exe_name(t) == "hearthstone.exe"
}

fn field<'a>(s: &'a str, key: &str) -> Option<&'a str> {
    let rest = s.split_once(key)?.1;
    Some(
        rest.split(|c: char| c.is_whitespace() || c == ']' || c == ',')
            .next()
            .unwrap_or_default(),
    )
}

#[derive(Clone, Default)]
struct Entity {
    card: String,
    controller: Option<u32>,
    zone: String,
    player: Option<u32>,
}

#[derive(Default)]
struct Game {
    active: bool,
    mode: &'static str,
    turn: Option<u32>,
    local: Option<u32>,
    result: Option<&'static str>,
    entities: HashMap<u32, Entity>,
    names: HashMap<String, u32>,
    pending: Option<u32>,
    start: Option<i64>,
    spectating: bool,
}

fn hero(card: &str) -> Option<(&'static str, &'static str)> {
    let code = card.strip_prefix("HERO_")?.get(..2)?;
    match code {
        "01" => Some(("Warrior", "HERO_01")),
        "02" => Some(("Shaman", "HERO_02")),
        "03" => Some(("Rogue", "HERO_03")),
        "04" => Some(("Paladin", "HERO_04")),
        "05" => Some(("Hunter", "HERO_05")),
        "06" => Some(("Druid", "HERO_06")),
        "07" => Some(("Warlock", "HERO_07")),
        "08" => Some(("Mage", "HERO_08")),
        "09" => Some(("Priest", "HERO_09")),
        "10" => Some(("Demon hunter", "HERO_10")),
        "11" => Some(("Death knight", "HERO_11")),
        _ => None,
    }
}

fn mode(raw: &str) -> Option<&'static str> {
    match raw {
        "GT_RANKED" | "7" => Some("Ranked"),
        "GT_CASUAL" | "8" => Some("Casual"),
        "GT_ARENA" | "5" => Some("Arena"),
        "GT_FRIENDS" | "4" => Some("Friendly"),
        "GT_VS_AI" | "3" => Some("Practice"),
        "GT_BATTLEGROUNDS" | "23" => Some("Battlegrounds"),
        "GT_TAVERNBRAWL" | "16" => Some("Tavern brawl"),
        _ => None,
    }
}

impl Game {
    fn parse(&mut self, line: &str, now: Option<i64>) {
        for key in [
            "GameType=",
            "gameType=",
            "m_gameType=",
            "tag=GAME_TYPE value=",
        ] {
            if let Some(raw) = field(line, key) {
                self.mode = mode(raw).unwrap_or("Match");
            }
        }
        if line.contains("Start Spectator Game") {
            self.spectating = true;
        }
        if line.contains("End Spectator Mode") {
            self.spectating = false;
            self.active = false;
        }
        if line.contains("currMode=HUB") || line.contains("currMode=MAIN_MENU") {
            self.active = false;
            self.start = None;
        }
        if line.trim_end().ends_with(" - CREATE_GAME") {
            let m = self.mode;
            let spectator = self.spectating;
            *self = Self {
                active: true,
                mode: m,
                start: now,
                spectating: spectator,
                ..Self::default()
            };
            return;
        }
        if line.contains("PlayerID=") && line.contains("PlayerName=") {
            if let (Some(id), Some((_, name))) = (
                field(line, "PlayerID=").and_then(|v| v.parse::<u32>().ok()),
                line.split_once("PlayerName="),
            ) {
                if self.names.len() < 2 {
                    self.names.insert(name.trim().into(), id);
                }
            }
        }
        if line.contains("Player EntityID=") {
            if let (Some(id), Some(player)) = (
                field(line, "EntityID=").and_then(|v| v.parse().ok()),
                field(line, "PlayerID=").and_then(|v| v.parse().ok()),
            ) {
                self.entities.insert(
                    id,
                    Entity {
                        player: Some(player),
                        ..Entity::default()
                    },
                );
                self.pending = Some(id);
            }
        } else if line.contains("GameEntity EntityID=") {
            self.pending = field(line, "EntityID=").and_then(|v| v.parse().ok());
        } else if line.contains("FULL_ENTITY")
            || line.contains("SHOW_ENTITY")
            || line.contains("CHANGE_ENTITY")
        {
            let id = field(line, "Creating ID=")
                .or_else(|| field(line, "id="))
                .or_else(|| field(line, "Updating Entity="))
                .and_then(|v| v.parse::<u32>().ok());
            if let Some(id) = id {
                self.pending = Some(id);
                if self.entities.len() < 4096 || self.entities.contains_key(&id) {
                    let e = self.entities.entry(id).or_default();
                    if let Some(card) = field(line, "CardID=") {
                        e.card = card.into();
                    }
                    if let Some(controller) = field(line, "player=").and_then(|v| v.parse().ok()) {
                        e.controller = Some(controller);
                    }
                    if let Some(zone) = field(line, "zone=") {
                        e.zone = zone.into();
                    }
                }
            }
        }
        let Some(tag) = field(line, "tag=") else {
            return;
        };
        let Some(value) = field(line, "value=") else {
            return;
        };
        if tag == "TURN" {
            self.turn = value.parse().ok();
        }
        let id = if line.contains("TAG_CHANGE") {
            line.split_once("Entity=")
                .and_then(|(_, x)| x.split_once(" tag="))
                .and_then(|(e, _)| {
                    field(e, "id=").unwrap_or(e).parse().ok().or_else(|| {
                        self.names.get(e).and_then(|p| {
                            self.entities
                                .iter()
                                .find_map(|(id, ent)| (ent.player == Some(*p)).then_some(*id))
                        })
                    })
                })
        } else {
            self.pending
        };
        if let Some(id) = id {
            if let Some(e) = self.entities.get_mut(&id) {
                match tag {
                    "CONTROLLER" => e.controller = value.parse().ok(),
                    "ZONE" => e.zone = value.into(),
                    _ => {}
                }
                // visible hand cards identify the local controller without assuming player 1
                if e.zone == "HAND"
                    && !e.card.is_empty()
                    && self.local.is_none()
                    && !self.spectating
                {
                    self.local = e.controller;
                }
                if tag == "PLAYSTATE" && e.player == self.local && self.local.is_some() {
                    self.result = match value {
                        "WON" | "4" => Some("Victory"),
                        "LOST" | "5" => Some("Defeat"),
                        "TIED" | "6" => Some("Draw"),
                        _ => self.result,
                    };
                    if self.result.is_some() {
                        self.active = false;
                        self.start = None;
                    }
                }
            }
        }
    }

    fn heroes(&self) -> (Option<(&'static str, &'static str)>, Option<&'static str>) {
        let mut own = None;
        let mut opponent = None;
        if let Some(local) = self.local {
            let mut entities: Vec<_> = self.entities.iter().collect();
            entities.sort_by_key(|(id, _)| **id);
            for (_, e) in entities {
                if e.zone != "PLAY" {
                    continue;
                }
                if let Some(h) = hero(&e.card) {
                    if e.controller == Some(local) {
                        own = Some(h);
                    } else if e.controller.is_some() {
                        opponent = Some(h.0);
                    }
                }
            }
        }
        (own, opponent)
    }
}

fn build(s: &Settings, g: &Game) -> Live {
    let (own, opp) = g.heroes();
    let mut details = if g.active || g.result.is_some() {
        if g.spectating {
            "Spectating".into()
        } else if g.mode.is_empty() {
            "In a match".into()
        } else {
            g.mode.to_string()
        }
    } else {
        "Browsing menus".into()
    };
    if (g.active || g.result.is_some()) && own.is_some() {
        if let Some((class, _)) = own {
            details.push_str(&format!(", {class}"));
        }
        if s.flag("show_opponent") {
            if let Some(class) = opp {
                details.push_str(&format!(" vs {class}"));
            }
        }
    }
    Live {
        details: util::clamp(details),
        state: if let Some(r) = g.result {
            util::clamp(r)
        } else if g.active && s.flag("show_turn") {
            g.turn.and_then(|n| util::clamp(format!("Turn {n}")))
        } else {
            None
        },
        large_image: own
            .map(|(_, code)| format!("https://art.hearthstonejson.com/v1/256x/{code}.jpg")),
        large_text: own.and_then(|(class, _)| util::clamp(class)),
        start_ms: if g.active { g.start } else { None },
        competing: g.active && g.mode == "Ranked" && !g.spectating,
        ..Live::default()
    }
}

fn merge_config(input: &str) -> String {
    let mut lines: Vec<String> = input.lines().map(str::to_string).collect();
    for section in ["Power", "LoadingScreen", "Net"] {
        let header = format!("[{section}]");
        let start = lines.iter().position(|l| {
            l.trim_start_matches('\u{feff}')
                .trim()
                .eq_ignore_ascii_case(&header)
        });
        let start = match start {
            Some(n) => n,
            None => {
                if !lines.is_empty() {
                    lines.push(String::new());
                }
                lines.push(header);
                lines.len() - 1
            }
        };
        let end = lines
            .iter()
            .enumerate()
            .skip(start + 1)
            .find(|(_, l)| l.trim().starts_with('['))
            .map(|(i, _)| i)
            .unwrap_or(lines.len());
        for (key, wanted) in [("LogLevel", "1"), ("FilePrinting", "true")] {
            let found = (start + 1..end).find(|&i| {
                lines
                    .get(i)
                    .and_then(|l| l.split_once('='))
                    .is_some_and(|(k, _)| k.trim().eq_ignore_ascii_case(key))
            });
            if let Some(i) = found {
                let value = lines
                    .get(i)
                    .and_then(|l| l.split_once('='))
                    .map(|(_, v)| v.split([';', '#']).next().unwrap_or_default().trim())
                    .unwrap_or_default();
                let valid = if key == "LogLevel" {
                    value.parse::<u32>().map(|n| n >= 1).unwrap_or(true)
                } else {
                    value.eq_ignore_ascii_case("true")
                };
                if !valid {
                    if let Some(line) = lines.get_mut(i) {
                        *line = format!("{key}={wanted}");
                    }
                }
            } else {
                lines.insert(end, format!("{key}={wanted}"));
            }
        }
    }
    format!("{}\n", lines.join("\n"))
}

fn enable_logging(base: &Path) {
    let path = base.join("log.config");
    let input = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return,
    };
    let merged = merge_config(&input);
    if merged != input && std::fs::create_dir_all(base).is_ok() {
        let _ = std::fs::write(path, merged);
    }
}

fn log_dir(base: &Path) -> Option<PathBuf> {
    let logs = base.join("Logs");
    let newest = util::tail::newest_file(&logs, |n| {
        n.starts_with("Hearthstone_") || n.chars().next().is_some_and(|c| c.is_ascii_digit())
    });
    newest
        .filter(|p| p.is_dir())
        .or_else(|| logs.is_dir().then_some(logs))
}

fn run(ctx: &Ctx) {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(|p| PathBuf::from(p).join("Blizzard").join("Hearthstone"));
    if let Some(base) = &base {
        enable_logging(base);
    }
    let mut current = None;
    let mut tails: Vec<util::tail::Tail> = Vec::new();
    let mut g = Game::default();
    loop {
        let dir = [
            base.as_deref().and_then(log_dir),
            ctx.target()
                .exe
                .as_ref()
                .and_then(|p| p.parent())
                .and_then(log_dir),
        ]
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let modified = ["Power.log", "Net.log", "LoadingScreen.log"]
                .iter()
                .filter_map(|name| p.join(name).metadata().ok()?.modified().ok())
                .max()?;
            let at = modified
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as i64;
            (at >= ctx.target().started_at_ms.saturating_sub(60_000)).then_some((modified, p))
        })
        .max_by_key(|(at, _)| *at)
        .map(|(_, p)| p);
        let fresh = dir != current;
        if fresh {
            current = dir.clone();
            tails.clear();
            g = Game::default();
        }
        if let Some(dir) = dir {
            for name in ["Net.log", "LoadingScreen.log", "Power.log"] {
                let p = dir.join(name);
                if p.is_file() && !tails.iter().any(|t| t.path() == p) {
                    tails.push(util::tail::Tail::new(p, 512 * 1024));
                }
            }
            let mut lines = Vec::new();
            for tail in &mut tails {
                tail.poll(|l| lines.push(l.to_string()));
            }
            lines.sort_by(|a, b| a.get(2..18).unwrap_or(a).cmp(b.get(2..18).unwrap_or(b)));
            for line in lines {
                g.parse(&line, if fresh { None } else { Some(util::now_ms()) });
            }
            ctx.emit(if tails.is_empty() {
                None
            } else {
                Some(build(ctx.settings(), &g))
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
    let mut g = Game::default();
    if matches!(key, "casual" | "ranked" | "arena" | "win" | "loss") {
        let game_type = match key {
            "casual" => "GT_CASUAL",
            "arena" => "GT_ARENA",
            _ => "GT_RANKED",
        };
        g.parse(&format!("GameType={game_type}"), None);
        for line in ["D 02:59:14.6088620 GameState.DebugPrintPower() - CREATE_GAME","D 02:59:14.6149420 GameState.DebugPrintPower() - Player EntityID=2 PlayerID=1",
            "D 02:59:14.6149430 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=4 CardID=HERO_08","tag=CONTROLLER value=1","tag=ZONE value=PLAY",
            "FULL_ENTITY - Creating ID=5 CardID=HERO_01","tag=CONTROLLER value=2","tag=ZONE value=PLAY",
            "FULL_ENTITY - Creating ID=6 CardID=CS2_029","tag=CONTROLLER value=1","tag=ZONE value=HAND","TAG_CHANGE Entity=GameEntity tag=TURN value=7"] {g.parse(line,Some(1_700_000_000_000));}
        if matches!(key, "win" | "loss") {
            g.parse(
                &format!(
                    "TAG_CHANGE Entity=2 tag=PLAYSTATE value={}",
                    if key == "win" { "WON" } else { "LOST" }
                ),
                None,
            );
        }
    }
    Preview {
        game: "Hearthstone",
        icon: None,
        live: build(s, &g),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn config_merge_preserves_values_and_is_idempotent() {
        let original =
            "[Power]\nLogLevel=3\nFilePrinting=false\nConsolePrinting=true\n[Other]\nCustom=yes\n";
        let merged = merge_config(original);
        assert!(merged.contains("LogLevel=3"));
        assert!(merged.contains("ConsolePrinting=true"));
        assert!(merged.contains("Custom=yes"));
        assert_eq!(merge_config(&merged), merged);
        assert_eq!(merged.matches("[Power]").count(), 1);
        assert!(merged.contains("[Net]"));
        assert!(merged.contains("FilePrinting=true"));
    }
    #[test]
    fn local_controller_is_not_assumed_and_result_requires_it() {
        let mut g = Game::default();
        for line in [
            "D 02:59:14.6088620 GameState.DebugPrintPower() - CREATE_GAME",
            "Player EntityID=3 PlayerID=2",
            "FULL_ENTITY - Creating ID=4 CardID=HERO_09a",
            "tag=CONTROLLER value=2",
            "tag=ZONE value=PLAY",
            "FULL_ENTITY - Creating ID=5 CardID=CS2_029",
            "tag=ZONE value=HAND",
            "tag=CONTROLLER value=2",
        ] {
            g.parse(line, None);
        }
        assert_eq!(g.local, Some(2));
        assert_eq!(g.heroes().0, Some(("Priest", "HERO_09")));
        g.parse("TAG_CHANGE Entity=3 tag=PLAYSTATE value=WON", None);
        assert_eq!(g.result, Some("Victory"));
        g.parse(
            "D 02:59:14.6088620 GameState.DebugPrintPower() - CREATE_GAME",
            None,
        );
        assert!(g.local.is_none());
        assert!(g.result.is_none());
        g.parse(
            "FULL_ENTITY - Creating ID=not-a-number CardID=HERO_99",
            None,
        );
        assert!(g.heroes().0.is_none());
    }
    #[test]
    fn previews_and_ranked_flag() {
        let s = Settings::new(&MANIFEST, json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&s, key).live.is_empty());
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        assert!(preview(&s, "ranked").live.competing);
        assert!(!preview(&s, "win").live.competing);
        assert!(!preview(&s, "casual").live.competing);
        for key in ["show_opponent", "show_turn"] {
            let hidden = Settings::new(&MANIFEST, json!({key:false}));
            assert_ne!(preview(&s, "ranked").live, preview(&hidden, "ranked").live);
        }
        assert!(!serde_json::to_string(&preview(&s, "ranked").live)
            .unwrap()
            .contains("PlayerID"));
    }
    #[test]
    fn named_results_spectator_and_unknown_mode() {
        let s = Settings::new(&MANIFEST, json!({}));
        let mut g = Game {
            active: true,
            mode: "Ranked",
            local: Some(2),
            ..Game::default()
        };
        g.parse("Player EntityID=3 PlayerID=2", None);
        g.parse(
            "GameState.DebugPrintGame() - PlayerID=2, PlayerName=Example",
            None,
        );
        g.parse("TAG_CHANGE Entity=Example tag=PLAYSTATE value=LOST", None);
        assert_eq!(build(&s, &g).state.as_deref(), Some("Defeat"));
        assert!(!serde_json::to_string(&build(&s, &g))
            .unwrap()
            .contains("Example"));
        g.active = true;
        g.result = None;
        g.parse("GameType=GT_NEW_MODE", None);
        assert!(!build(&s, &g).competing);
        g.parse("GameType=GT_RANKED", None);
        g.parse("Start Spectator Game", None);
        assert!(!build(&s, &g).competing);
        let c = merge_config("[Power]\nLogLevel=4 ; keep detail\nFilePrinting=true\n");
        assert!(c.contains("LogLevel=4 ; keep detail"));
        assert_eq!(merge_config(&c), c);
    }
}
