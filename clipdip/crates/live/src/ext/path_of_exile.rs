//! Zone, act, class, and level without character names. Ported from Path-Of-Exile-2-RPC
//! by ezbooz (MIT), https://github.com/ezbooz/Path-Of-Exile-2-RPC: main.py, locations.json;
//! PathOfExileRPC by xKynn (MIT), https://github.com/xKynn/PathOfExileRPC: poeRPC.py, areas.json

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf, sync::LazyLock, time::Duration};
mod log;

pub static MANIFEST: Manifest = Manifest {
    id: "path_of_exile",
    name: "Path of Exile 1 and 2",
    blurb: "Zone, act, class, and level",
    setup: None,
    credits: &[
        Credit {
            project: "Path-Of-Exile-2-RPC",
            author: "ezbooz",
            url: "https://github.com/ezbooz/Path-Of-Exile-2-RPC",
            license: "MIT",
        },
        Credit {
            project: "PathOfExileRPC",
            author: "xKynn",
            url: "https://github.com/xKynn/PathOfExileRPC",
            license: "MIT",
        },
    ],
    options: &[Opt::toggle(
        "show_character",
        "Show class and level",
        "Character names stay hidden.",
        true,
    )],
    matches,
    run,
    priority: 10,
    game_ids: &["1328876348361412619", "356888453796986880"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/2694490/header.jpg"),
    preview,
    scenarios: &[
        ("menu", "Character selection"),
        ("poe1-town", "PoE 1 town"),
        ("poe1-map", "PoE 1 map"),
        ("poe2-campaign", "PoE 2 campaign"),
        ("poe2-hideout", "PoE 2 hideout"),
        ("poe2-map", "PoE 2 map"),
    ],
    steam_game: true,
    listed: true,
};
fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || matches!(t.game_id.as_str(), "steam:238960" | "steam:2694490")
        || matches!(
            util::exe_name(t).as_str(),
            "pathofexile.exe"
                | "pathofexile_x64.exe"
                | "pathofexilesteam.exe"
                | "pathofexile_x64steam.exe"
                | "pathofexile2.exe"
                | "pathofexile2steam.exe"
        )
}
fn is_two(t: &Target) -> bool {
    t.game_id == "1328876348361412619"
        || t.game_id == "steam:2694490"
        || t.steam_appid.as_deref() == Some("2694490")
        || t.game_name.contains('2')
        || t.exe
            .as_ref()
            .is_some_and(|p| p.to_string_lossy().to_ascii_lowercase().contains("exile 2"))
}
#[derive(Default, Deserialize)]
struct Areas {
    areas: BTreeMap<String, String>,
}
static AREAS: LazyLock<Areas> = LazyLock::new(|| {
    serde_json::from_str(include_str!("path_of_exile/locations.json")).unwrap_or_default()
});
#[derive(Deserialize)]
struct Town {
    name: String,
    act: String,
}
static TOWNS: LazyLock<Vec<Town>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("path_of_exile/towns.json")).unwrap_or_default()
});
#[derive(Default)]
struct State {
    seen: bool,
    area_pending: bool,
    zone: Option<String>,
    act: Option<u8>,
    area_level: Option<u16>,
    class: Option<String>,
    base: Option<&'static str>,
    level: Option<u16>,
}
fn class_base(name: &str) -> Option<&'static str> {
    Some(match name {
        "Marauder" | "Juggernaut" | "Berserker" | "Chieftain" => "Marauder",
        "Duelist" | "Slayer" | "Gladiator" | "Champion" => "Duelist",
        "Templar" | "Inquisitor" | "Hierophant" | "Guardian" => "Templar",
        "Shadow" | "Assassin" | "Saboteur" | "Trickster" => "Shadow",
        "Scion" | "Ascendant" => "Scion",
        "Witch" | "Necromancer" | "Occultist" | "Elementalist" | "Blood Mage" | "Infernalist"
        | "Lich" => "Witch",
        "Ranger" | "Deadeye" | "Raider" | "Pathfinder" | "Warden" => "Ranger",
        "Warrior" | "Titan" | "Warbringer" | "Smith of Kitava" => "Warrior",
        "Mercenary" | "Witchhunter" | "Gemling Legionnaire" | "Tactician" => "Mercenary",
        "Monk" | "Invoker" | "Acolyte of Chayula" => "Monk",
        "Sorceress" | "Stormweaver" | "Chronomancer" => "Sorceress",
        "Huntress" | "Amazon" | "Ritualist" => "Huntress",
        "Druid" | "Shaman" | "Oracle" => "Druid",
        _ => return None,
    })
}
fn display_zone(name: &str) -> Option<String> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.chars().any(char::is_control) {
        return None;
    }
    util::clamp(name)
}
fn area_act(code: &str, two: bool) -> Option<u8> {
    let act = if two {
        code.strip_prefix('G')?.split('_').next()?.parse().ok()?
    } else {
        code.split('_').nth(1)?.parse().ok()?
    };
    (1..=if two { 6 } else { 10 }).contains(&act).then_some(act)
}
fn resolve_area(code: &str) -> Option<String> {
    if let Some(name) = AREAS.areas.get(code) {
        return display_zone(name);
    }
    // map seeds and encounter suffixes are not zone names
    if let Some(rest) = code.strip_prefix("Map") {
        let key = rest.split('_').next()?;
        return display_zone(AREAS.areas.get(key).map(String::as_str).unwrap_or(key));
    }
    let mut prefix = code;
    while let Some((p, _)) = prefix.rsplit_once('_') {
        if let Some(name) = AREAS.areas.get(p) {
            return display_zone(name);
        }
        prefix = p;
    }
    None
}
impl State {
    fn parse(&mut self, line: &str, two: bool) {
        if line.contains("Async connecting") || line.contains("Abnormal disconnect") {
            *self = Self {
                seen: true,
                ..Self::default()
            };
            return;
        }
        if let Some(rest) = line.split("Generating level ").nth(1) {
            if let Some((level, rest)) = rest.split_once(" area \"") {
                if let (Ok(level), Some(code)) = (level.parse::<u16>(), rest.split('"').next()) {
                    self.seen = true;
                    self.area_level = Some(level);
                    self.area_pending = true;
                    self.act = area_act(code, two);
                    self.zone = if two { resolve_area(code) } else { None };
                }
            }
        } else if let Some(rest) = line.split("[SCENE] Set Source [").nth(1) {
            if let Some((name, _)) = rest.split_once(']') {
                self.seen = true;
                if name == "(null)" {
                    self.seen = false;
                    self.zone = None;
                    if !self.area_pending {
                        self.act = None;
                        self.area_level = None;
                    }
                } else {
                    let zone = resolve_area(name).or_else(|| display_zone(name));
                    if !self.area_pending && self.zone != zone {
                        self.area_level = None;
                        let mut acts = AREAS
                            .areas
                            .iter()
                            .filter(|(_, n)| Some(*n) == zone.as_ref())
                            .filter_map(|(c, _)| area_act(c, true));
                        self.act = acts.next().filter(|first| acts.all(|a| a == *first));
                    }
                    self.zone = zone;
                    self.area_pending = false;
                    if self.zone.as_ref().is_some_and(|n| n.ends_with("Hideout")) {
                        self.act = None;
                        self.area_level = None;
                    }
                }
            }
        } else if let Some(rest) = line.split("You have entered ").nth(1) {
            self.seen = true;
            let zone = display_zone(rest.trim().trim_end_matches('.'));
            if !self.area_pending && self.zone != zone {
                self.act = None;
                self.area_level = None;
            }
            self.area_pending = false;
            self.zone = zone;
            if !two && self.act.is_none() {
                let mut acts = TOWNS
                    .iter()
                    .filter(|t| Some(&t.name) == self.zone.as_ref())
                    .filter_map(|t| t.act.parse().ok());
                if let Some(first) = acts.next() {
                    if acts.all(|a| a == first) {
                        self.act = Some(first);
                    }
                }
            }
            if self.zone.as_ref().is_some_and(|n| n.ends_with("Hideout")) {
                self.act = None;
                self.area_level = None;
            }
        } else if let Some((before, after)) = line.split_once(") is now level ") {
            if let Some((_, class)) = before.rsplit_once('(') {
                let class = class.trim();
                if let Some(base) = class_base(class) {
                    if let Some(level) = after
                        .split_whitespace()
                        .next()
                        .and_then(|n| n.trim_end_matches('.').parse::<u16>().ok())
                        .filter(|n| (1..=100).contains(n))
                    {
                        self.seen = true;
                        self.base = Some(base);
                        self.class = Some(class.into());
                        self.level = Some(level);
                    }
                }
            }
        }
    }
}
fn build(s: &State, settings: &Settings, two: bool) -> Live {
    if !s.seen {
        return Live::default();
    }
    let mut details = s.zone.clone().unwrap_or_else(|| {
        if s.class.is_some() || s.area_level.is_some() {
            "Exploring Wraeclast".into()
        } else {
            "At character selection".into()
        }
    });
    if let Some(act) = s.act {
        details.push_str(&format!(", Act {act}"));
    }
    let mut bits = Vec::new();
    if settings.flag("show_character") {
        if let Some(class) = &s.class {
            bits.push(match s.base {
                Some(base) if base != class => format!("{base} - {class}"),
                _ => class.clone(),
            });
        }
        if let Some(level) = s.level {
            bits.push(format!("Level {level}"));
        }
    }
    if let Some(level) = s.area_level {
        bits.push(format!("Area level {level}"));
    }
    let app = if two { "2694490" } else { "238960" };
    let art = if settings.flag("show_character") {
        s.base
            .filter(|b| {
                if two {
                    matches!(
                        *b,
                        "Warrior"
                            | "Mercenary"
                            | "Ranger"
                            | "Monk"
                            | "Sorceress"
                            | "Witch"
                            | "Huntress"
                            | "Druid"
                    )
                } else {
                    matches!(
                        *b,
                        "Marauder"
                            | "Ranger"
                            | "Witch"
                            | "Duelist"
                            | "Templar"
                            | "Shadow"
                            | "Scion"
                    )
                }
            })
            .map(|b| {
                util::art::url(
                    "path-of-exile",
                    &format!("poe{}-{}", if two { 2 } else { 1 }, b.to_ascii_lowercase()),
                )
            })
    } else {
        None
    };
    Live {
        details: util::clamp(details.clone()),
        state: util::clamp(bits.join(", ")),
        large_image: Some(art.unwrap_or_else(|| util::art::steam_header(app))),
        large_text: util::clamp(details),
        ..Live::default()
    }
}
fn preview(settings: &Settings, scenario: &str) -> Preview {
    let (two, lines): (bool, &[&str]) = match scenario {
        "poe1-town" => (
            false,
            &[
                "Generating level 15 area \"1_2_town\" with seed 1",
                "You have entered The Forest Encampment.",
                "Sample (Witch) is now level 18",
            ],
        ),
        "poe1-map" => (
            false,
            &[
                "Generating level 83 area \"MapWorldsBeach\" with seed 1",
                "You have entered Beach.",
                "Sample (Necromancer) is now level 92",
            ],
        ),
        "poe2-campaign" => (
            true,
            &[
                "Generating level 1 area \"G1_1\" with seed 1",
                "Sample (Warrior) is now level 2",
            ],
        ),
        "poe2-hideout" => (
            true,
            &[
                "[SCENE] Set Source [Beacon of Salvation Hideout]",
                "Sample (Invoker) is now level 82",
            ],
        ),
        "poe2-map" => (
            true,
            &[
                "Generating level 79 area \"MapSavannah_01\" with seed 1",
                "Sample (Gemling Legionnaire) is now level 88",
            ],
        ),
        _ => (true, &["Async connecting"]),
    };
    let mut s = State::default();
    for l in lines {
        s.parse(l, two);
    }
    Preview {
        game: if two {
            "Path of Exile 2"
        } else {
            "Path of Exile"
        },
        icon: None,
        live: build(&s, settings, two),
    }
}
fn log_path(t: &Target) -> Option<PathBuf> {
    let dir = t.exe.as_ref()?.parent()?;
    [Some(dir), dir.parent()]
        .into_iter()
        .flatten()
        .map(|p| p.join("logs/Client.txt"))
        .find(|p| p.is_file())
}
fn run(ctx: &Ctx) {
    let two = is_two(ctx.target());
    let mut follower = log::Follower::default();
    let mut state = State::default();
    loop {
        follower.poll(
            log_path(ctx.target()),
            ctx.target().started_at_ms,
            &mut state,
            |s, l| s.parse(l, two),
        );
        ctx.emit(Some(build(&state, ctx.settings(), two)));
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
    fn generating_scene_level_and_privacy() {
        let mut s = State::default();
        s.parse("Generating level 1 area \"G1_1\" with seed 123", true);
        assert_eq!(s.zone.as_deref(), Some("The Riverbank"));
        assert_eq!(s.act, Some(1));
        s.parse("INFO Client 1: Sample (Titan) is now level 42", true);
        assert_eq!(s.base, Some("Warrior"));
        assert_eq!(s.level, Some(42));
        let settings = Settings::new(&MANIFEST, json!({}));
        assert!(!serde_json::to_string(&build(&s, &settings, true))
            .unwrap()
            .contains("Sample"));
        s.parse("[SCENE] Set Source [Beacon of Salvation Hideout]", true);
        assert!(s.act.is_none());
        assert!(s.area_level.is_none());
        s.parse("[SCENE] Set Source [(null)]", true);
        assert!(s.zone.is_none());
        s.parse("Async connecting to example.invalid:1234", true);
        assert!(s.class.is_none());
        s.parse("Sample (Invalid) is now level 1000", true);
        assert!(s.class.is_none());
        s.parse("You have entered The Forest Encampment.", false);
        assert_eq!(s.act, Some(2));
        s.parse("Abnormal disconnect", false);
        assert!(s.zone.is_none());
        s.parse("You have entered Lioneye's Watch.", false);
        assert!(s.act.is_none(), "two acts share this town");
    }
    #[test]
    fn scene_fixture_from_public_bug_report() {
        let mut s = State::default();
        s.parse("2025/04/19 20:46:05 17155281 775aec31 [INFO Client 20392] [SCENE] Set Source [Hunting Grounds]",true);
        assert_eq!(s.zone.as_deref(), Some("Hunting Grounds"));
        assert_eq!(area_act("2_6_1", false), Some(6));
        assert_eq!(area_act("MapSavannah", true), None);
    }
    #[test]
    fn entry_without_generation_clears_old_act_and_scene_keeps_new_level() {
        let mut s = State::default();
        s.parse("Generating level 15 area \"1_2_town\" with seed 1", false);
        s.parse("You have entered The Forest Encampment.", false);
        assert_eq!(s.act, Some(2));
        s.parse("You have entered Beach.", false);
        assert!(s.act.is_none());
        assert!(s.area_level.is_none());
        s.parse("Generating level 25 area \"G2_Unmapped\" with seed 1", true);
        s.parse("[SCENE] Set Source [(null)]", true);
        assert!(!s.seen);
        s.parse("[SCENE] Set Source [Sample zone]", true);
        assert_eq!(s.area_level, Some(25));
        assert_eq!(s.act, Some(2));
    }
    #[test]
    fn scenarios_fallback_and_option() {
        let a = Settings::new(&MANIFEST, json!({}));
        let b = Settings::new(&MANIFEST, json!({"show_character":false}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&a, key).live.is_empty());
        }
        assert_eq!(preview(&a, "unknown").live, preview(&a, "menu").live);
        assert_ne!(
            preview(&a, "poe2-campaign").live,
            preview(&b, "poe2-campaign").live
        );
        assert!(build(&State::default(), &a, true).is_empty());
    }
}
