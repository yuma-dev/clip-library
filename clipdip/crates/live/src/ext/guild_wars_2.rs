//! Map and profession. Ported from gw2-discordlink by Raphael Ludwig (MIT)
//! https://github.com/Raffy23/gw2-discordlink: Gw2MumbleLink.h, main.cpp
//! GW2RPC contributors (format only): gw2rpc/mumble.py

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub static MANIFEST: Manifest = Manifest {
    id: "guild_wars_2",
    name: "Guild Wars 2",
    blurb: "Map, profession, specialization and commander tag.",
    setup: None,
    credits: &[
        Credit {
            project: "gw2-discordlink",
            author: "Raphael Ludwig",
            url: "https://github.com/Raffy23/gw2-discordlink",
            license: "MIT",
        },
        Credit {
            project: "GW2RPC",
            author: "GW2RPC contributors",
            url: "https://github.com/Maselkov/GW2RPC",
            license: "format only",
        },
    ],
    options: &[
        Opt::toggle(
            "show_specialization",
            "Show specialization",
            "Show the elite specialization instead of the core profession.",
            true,
        ),
        Opt::toggle(
            "show_commander",
            "Show commander tag",
            "Show when the commander tag is active.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &["359511228445491200"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/1284210/library_hero.jpg"),
    preview,
    scenarios: &[
        ("loading", "Loading"),
        ("exploring", "Exploring"),
        ("commander", "Commander"),
        ("pvp", "PvP"),
        ("wvw", "World vs. World"),
    ],
    steam_game: true,
    listed: true,
};

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || matches!(util::exe_name(t).as_str(), "gw2-64.exe" | "gw2.exe")
}

#[derive(Default, Deserialize)]
struct Identity {
    profession: u32,
    #[serde(default)]
    spec: u32,
    map_id: u32,
    #[serde(default)]
    commander: bool,
}

struct Snapshot {
    tick: u32,
    identity: Identity,
    map_type: u32,
}

fn parse_block(b: &[u8], pid: u32) -> Option<Snapshot> {
    if util::shm::u32_at(b, 0)? != 2 || util::shm::utf16_at(b, 44, 256)? != "Guild Wars 2" {
        return None;
    }
    let tick = util::shm::u32_at(b, 4)?;
    if tick == 0 {
        return None;
    }
    let identity: Identity = serde_json::from_str(&util::shm::utf16_at(b, 592, 256)?).ok()?;
    let context_len = util::shm::u32_at(b, 1104)?;
    // GW2 publishes its PID at byte 80 of the context in current builds
    if context_len < 84 || util::shm::u32_at(b, 1188)? != pid || identity.map_id == 0 {
        return None;
    }
    Some(Snapshot {
        tick,
        identity,
        map_type: util::shm::u32_at(b, 1140)?,
    })
}

fn profession(id: u32) -> &'static str {
    match id {
        1 => "Guardian",
        2 => "Warrior",
        3 => "Engineer",
        4 => "Ranger",
        5 => "Thief",
        6 => "Elementalist",
        7 => "Mesmer",
        8 => "Necromancer",
        9 => "Revenant",
        _ => "Unknown profession",
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Info {
    name: String,
    #[serde(default)]
    icon: Option<String>,
}

fn build(
    s: &Settings,
    id: Option<&Identity>,
    map_type: u32,
    map: Option<&Info>,
    spec: Option<&Info>,
    core: Option<&Info>,
    start: Option<i64>,
) -> Live {
    // character selection and loading have no fresh identity to add to the base card
    let Some(id) = id else {
        return Live::default();
    };
    let class = if s.flag("show_specialization") {
        spec.map(|x| x.name.as_str())
            .unwrap_or(profession(id.profession))
    } else {
        profession(id.profession)
    };
    let activity = match map_type {
        2 => "PvP",
        9..=12 | 14..=15 => "World vs. World",
        _ => "Exploring",
    };
    let state = if id.commander && s.flag("show_commander") {
        format!("{class}, Commander")
    } else {
        class.to_string()
    };
    Live {
        details: util::clamp(format!(
            "{activity}, {}",
            map.map(|x| x.name.clone())
                .unwrap_or_else(|| format!("Map {}", id.map_id))
        )),
        state: util::clamp(state),
        large_text: util::clamp(class),
        large_image: if s.flag("show_specialization") {
            spec.and_then(|x| x.icon.clone())
        } else {
            None
        }
        .or_else(|| core.and_then(|x| x.icon.clone()))
        .filter(|u| u.starts_with("https://render.guildwars2.com/"))
        .or_else(|| Some(util::art::steam_header("1284210"))),
        start_ms: start,
        ..Live::default()
    }
}

fn cached(agent: &ureq::Agent, dir: Option<&Path>, key: &str, url: &str) -> Option<Value> {
    let path = dir.map(|d| d.join(format!("{key}.json")));
    if let Some(p) = path.as_ref() {
        if p.metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() < 7 * 86400)
        {
            if let Some(v) = std::fs::read(p)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
            {
                return Some(v);
            }
        }
    }
    let v = util::http::get_json(agent, url)?;
    if let Some(p) = path {
        if let Ok(b) = serde_json::to_vec(&v) {
            let _ = std::fs::write(p, b);
        }
    }
    Some(v)
}

fn metadata(v: &Value) -> Option<Info> {
    Some(Info {
        name: v.get("name")?.as_str()?.to_string(),
        icon: v
            .get("icon_big")
            .or_else(|| v.get("icon"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn run(ctx: &Ctx) {
    let agent = util::http::agent();
    let dir: Option<PathBuf> = ctx.cache_dir();
    let mut specs = HashMap::new();
    let mut cores = HashMap::new();
    let mut maps: HashMap<u32, Info> = HashMap::new();
    let mut map_attempts: HashMap<u32, Instant> = HashMap::new();
    let mut metadata_at: Option<Instant> = None;
    let mut last_tick = None;
    let mut tick_at = Instant::now();
    let mut last_map = None;
    let mut map_start = None;
    loop {
        let snapshot = util::shm::read("MumbleLink", 1364)
            .as_deref()
            .and_then(|b| parse_block(b, ctx.target().pid));
        let delay = if let Some(snap) = snapshot {
            if last_tick != Some(snap.tick) {
                last_tick = Some(snap.tick);
                tick_at = Instant::now();
            }
            if tick_at.elapsed() > Duration::from_secs(15) {
                ctx.emit(None);
            } else {
                if (specs.is_empty() || cores.is_empty())
                    && metadata_at.is_none_or(|at| at.elapsed() >= Duration::from_secs(15))
                {
                    metadata_at = Some(Instant::now());
                    if let Some(v) = specs
                        .is_empty()
                        .then(|| {
                            cached(
                                &agent,
                                dir.as_deref(),
                                "specializations",
                                "https://api.guildwars2.com/v2/specializations?ids=all",
                            )
                        })
                        .flatten()
                    {
                        for item in v
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|v| v.get("elite").and_then(Value::as_bool) == Some(true))
                        {
                            if let (Some(id), Some(info)) =
                                (item.get("id").and_then(Value::as_u64), metadata(item))
                            {
                                specs.insert(id as u32, info);
                            }
                        }
                    }
                    if let Some(v) = cores
                        .is_empty()
                        .then(|| {
                            cached(
                                &agent,
                                dir.as_deref(),
                                "professions",
                                "https://api.guildwars2.com/v2/professions?ids=all",
                            )
                        })
                        .flatten()
                    {
                        for item in v.as_array().into_iter().flatten() {
                            if let Some(info) = metadata(item) {
                                cores.insert(info.name.clone(), info);
                            }
                        }
                    }
                }
                let id = &snap.identity;
                if last_map != Some(id.map_id) {
                    last_map = Some(id.map_id);
                    map_start = Some(util::now_ms());
                }
                if !maps.contains_key(&id.map_id)
                    && map_attempts
                        .get(&id.map_id)
                        .is_none_or(|at| at.elapsed() >= Duration::from_secs(15))
                {
                    map_attempts.insert(id.map_id, Instant::now());
                    if let Some(info) = cached(
                        &agent,
                        dir.as_deref(),
                        &format!("map-{}", id.map_id),
                        &format!("https://api.guildwars2.com/v2/maps/{}", id.map_id),
                    )
                    .as_ref()
                    .and_then(metadata)
                    {
                        maps.insert(id.map_id, info);
                    }
                }
                ctx.emit(Some(build(
                    ctx.settings(),
                    Some(id),
                    snap.map_type,
                    maps.get(&id.map_id),
                    specs.get(&id.spec),
                    cores.get(profession(id.profession)),
                    map_start,
                )));
            }
            5
        } else {
            ctx.emit(None);
            last_tick = None;
            15
        };
        if !ctx.sleep(Duration::from_secs(delay)) {
            return;
        }
    }
}

fn preview(s: &Settings, scenario: &str) -> Preview {
    let loading = !matches!(scenario, "exploring" | "commander" | "pvp" | "wvw");
    let id = Identity {
        profession: 1,
        spec: 27,
        map_id: 15,
        commander: scenario == "commander",
    };
    let kind = match scenario {
        "pvp" => 2,
        "wvw" => 9,
        _ => 5,
    };
    let map = Info {
        name: match kind {
            2 => "Battle of Kyhlo",
            9 => "Eternal Battlegrounds",
            _ => "Queensdale",
        }
        .into(),
        icon: None,
    };
    let core = Info { name: "Guardian".into(), icon: Some("https://render.guildwars2.com/file/6E0D0AC6E0CE5C0C29B3D736ABEA070F4A58540E/156633.png".into()) };
    let spec = Info { name: "Dragonhunter".into(), icon: Some("https://render.guildwars2.com/file/736DB02E6DA2ACFAD3B9B0F4655113AD214FFA40/1011994.png".into()) };
    Preview {
        game: "Guild Wars 2",
        icon: None,
        live: build(
            s,
            if loading { None } else { Some(&id) },
            kind,
            Some(&map),
            Some(&spec),
            Some(&core),
            if loading {
                None
            } else {
                Some(1_700_000_000_000)
            },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn block(pid: u32) -> Vec<u8> {
        let mut b = vec![0; 1364];
        for (at, n) in [(0, 2u32), (4, 20), (1104, 85), (1188, pid), (1140, 5)] {
            b[at..at + 4].copy_from_slice(&n.to_le_bytes());
        }
        for (at, s) in [
            (44, "Guild Wars 2"),
            (
                592,
                r#"{"name":"Private character","profession":1,"spec":27,"map_id":15,"commander":true}"#,
            ),
        ] {
            for (i, n) in s.encode_utf16().enumerate() {
                b[at + i * 2..at + i * 2 + 2].copy_from_slice(&n.to_le_bytes());
            }
        }
        b
    }

    #[test]
    fn identity_offsets_pid_and_privacy() {
        let b = block(42);
        let snap = parse_block(&b, 42).unwrap();
        assert_eq!(snap.identity.spec, 27);
        assert_eq!(snap.map_type, 5);
        assert!(parse_block(&b, 43).is_none());
        assert!(parse_block(&b[..40], 42).is_none());
        let s = Settings::new(&MANIFEST, json!({}));
        let live = build(&s, Some(&snap.identity), 5, None, None, None, None);
        assert!(!serde_json::to_string(&live).unwrap().contains("Private"));
        assert!(!live.competing);
    }

    #[test]
    fn previews_and_settings() {
        let s = Settings::new(&MANIFEST, json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert_eq!(preview(&s, key).live.is_empty(), *key == "loading");
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "loading").live);
        for (key, scenario) in [
            ("show_specialization", "exploring"),
            ("show_commander", "commander"),
        ] {
            let hidden = Settings::new(&MANIFEST, json!({key:false}));
            assert_ne!(preview(&s, scenario).live, preview(&hidden, scenario).live);
        }
    }
}
