//! Mode, map and player count. Ported from Battlefield-rich-presence by
//! Community Network (MIT), https://github.com/community-network/Battlefield-rich-presence
//! Api.cs, Game.cs, Jwt.cs, ChangePrensence/Frostbite3.cs

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use serde_json::Value;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
mod auth;

pub static MANIFEST: Manifest = Manifest {
    id: "battlefield",
    name: "Battlefield 1 / V / 4 / 2042 / 6",
    blurb: "Mode, map and server player count.",
    setup: None,
    credits: &[Credit {
        project: "Battlefield-rich-presence",
        author: "Community Network",
        url: "https://github.com/community-network/Battlefield-rich-presence",
        license: "MIT",
    }],
    options: &[
        Opt::toggle(
            "show_players",
            "Show player count",
            "Show the server's current player count.",
            true,
        ),
        // off by default: it sends the EA name from the EA app's log to bflist.io and gametools.network
        Opt::toggle(
            "server_lookup",
            "Look up my server online",
            "Sends your EA name to gametools.network to show the server's map and players.",
            false,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[
        "1425690433018925056",
        "1162076274622222346",
        "358417041981571082",
        "1501074411745185974",
        "512699108809637890",
        "359510680459673610",
    ],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/1517290/library_hero.jpg"),
    preview,
    scenarios: &[
        ("menu", "Menus"),
        ("match", "Match"),
        ("local", "Local map details"),
        ("campaign", "Campaign"),
    ],
    steam_game: true,
    listed: true,
};

#[derive(Clone, Copy)]
struct Game {
    key: &'static str,
    name: &'static str,
    steam: &'static str,
}

fn game(t: &Target, title: &str) -> Option<Game> {
    let exe = util::exe_name(t);
    let title = title.to_ascii_lowercase();
    let game = match t.game_id.as_str() {
        "358417041981571082" | "1501074411745185974" => Some("bf1"),
        "512699108809637890" => Some("bfv"),
        "359510680459673610" => Some("bf4"),
        "1162076274622222346" => Some("bf2042"),
        "1425690433018925056" => Some("bf6"),
        _ => match exe.as_str() {
            "bf1.exe" => Some("bf1"),
            "bfv.exe" => Some("bfv"),
            "bf4.exe" | "bf4_x86.exe" => Some("bf4"),
            "bf2042.exe" => Some("bf2042"),
            "bf6.exe" => Some("bf6"),
            _ => None,
        },
    }
    .or_else(|| {
        if title.contains("battlefield") {
            if title.contains("2042") {
                Some("bf2042")
            } else if title.contains(" 6") {
                Some("bf6")
            } else if title.contains(" 4") {
                Some("bf4")
            } else if title.contains(" v") {
                Some("bfv")
            } else if title.contains(" 1") {
                Some("bf1")
            } else {
                None
            }
        } else {
            None
        }
    })?;
    Some(match game {
        "bf1" => Game {
            key: "bf1",
            name: "Battlefield 1",
            steam: "1238840",
        },
        "bfv" => Game {
            key: "bfv",
            name: "Battlefield V",
            steam: "1238810",
        },
        "bf4" => Game {
            key: "bf4",
            name: "Battlefield 4",
            steam: "1238860",
        },
        "bf2042" => Game {
            key: "bf2042",
            name: "Battlefield 2042",
            steam: "1517290",
        },
        _ => Game {
            key: "bf6",
            name: "Battlefield 6",
            steam: "2807960",
        },
    })
}

fn matches(t: &Target) -> bool {
    game(t, "").is_some()
}

#[derive(Default, Debug)]
struct State {
    mode: Option<String>,
    map: Option<String>,
    players: Option<[u32; 2]>,
    menu: bool,
    campaign: bool,
    image: Option<String>,
}

fn xml_attr<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.split_once(&format!(" {key}=\""))?
        .1
        .split_once('"')
        .map(|(v, _)| v)
}

fn persona(line: &str) -> Option<String> {
    if !line.contains("<GetProfileResponse ") {
        return None;
    }
    let name = xml_attr(line, "Persona")?;
    (2..=64).contains(&name.len()).then(|| name.to_string())
}

fn local(raw: &str) -> Option<State> {
    let raw = raw
        .replace("Battlefield\u{2122}", "Battlefield")
        .replace("Battlefield\u{00ae}", "Battlefield");
    let raw = raw.trim();
    if !raw.to_ascii_lowercase().starts_with("battlefield") {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    let menu = lower.contains("main menu");
    let campaign = lower.contains("campaign");
    let mode = [
        "Conquest",
        "Breakthrough",
        "Rush",
        "Team Deathmatch",
        "Hazard Zone",
        "Portal",
        "Operations",
        "Frontlines",
        "Domination",
    ]
    .into_iter()
    .find(|m| lower.contains(&m.to_ascii_lowercase()))
    .map(str::to_string);
    let map = if !menu && !campaign {
        raw.split(" - ")
            .nth(1)
            .filter(|s| {
                s.len() >= 2 && !s.starts_with("Party") && !s.contains('@') && !s.contains("://")
            })
            .and_then(util::clamp)
    } else {
        None
    };
    (menu || campaign || mode.is_some() || map.is_some()).then_some(State {
        mode,
        map,
        menu,
        campaign,
        ..State::default()
    })
}

fn server(v: &Value) -> Option<State> {
    let map = v
        .get("mapLabel")
        .or_else(|| v.get("mapName"))
        .and_then(Value::as_str)
        .and_then(util::clamp)?;
    let mode = v
        .get("modeLabel")
        .or_else(|| v.get("gamemode"))
        .or_else(|| v.get("modeName"))
        .or_else(|| v.get("gameType"))
        .and_then(Value::as_str)
        .and_then(util::clamp);
    let current = v.get("numPlayers").and_then(Value::as_u64);
    let max = v.get("maxPlayers").and_then(Value::as_u64);
    let players = current
        .zip(max)
        .filter(|(n, max)| n <= max && *max <= 256 && *max > 0)
        .map(|(n, max)| [n as u32, max as u32]);
    let image = v
        .get("mapImage")
        .and_then(Value::as_str)
        .filter(|u| {
            u.starts_with("https://")
                && !u.contains("wikia.nocookie.net")
                && !u.contains('?')
                && !u.contains('@')
        })
        .map(str::to_string);
    Some(State {
        mode,
        map: Some(map),
        players,
        image,
        ..State::default()
    })
}

fn encode_segment(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn current_server(agent: &ureq::Agent, g: Game, name: &str) -> Option<State> {
    if g.key == "bf4" {
        let v: Value = util::http::get_json(
            agent,
            &format!(
                "https://api.bflist.io/v2/bf4/players/{}/server",
                encode_segment(name)
            ),
        )?;
        let server_name = v.get("name")?.as_str()?;
        let extra: Option<Value> = agent
            .post("https://api.gametools.network/seedergame/bf4")
            .send_json(serde_json::json!({"name":server_name}))
            .ok()
            .and_then(|r| r.into_json().ok());
        let mut state = extra.as_ref().and_then(server).or_else(|| server(&v))?;
        if let Some(n) = v.get("numPlayers").and_then(Value::as_u64) {
            if let Some([_, max]) = state.players {
                if n <= u64::from(max) {
                    state.players = Some([n as u32, max]);
                }
            }
        }
        return Some(state);
    }
    let route = if g.key == "bfv" { "bf5" } else { g.key };
    let token = auth::token(name)?;
    let v = agent
        .post(&format!(
            "https://api.gametools.network/currentserver/{route}"
        ))
        .send_json(serde_json::json!({"data":token}))
        .ok()?
        .into_json::<Value>()
        .ok()?;
    server(&v)
}

fn build(s: &Settings, g: Game, state: Option<&State>) -> Live {
    let Some(state) = state else {
        return Live::default();
    };
    let details = if state.menu {
        "Browsing menus".to_string()
    } else if state.campaign {
        "Campaign".to_string()
    } else {
        [state.mode.as_deref(), state.map.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ")
    };
    Live {
        details: util::clamp(details),
        state: if s.flag("show_players") {
            state
                .players
                .and_then(|[n, max]| util::clamp(format!("{n}/{max} players")))
        } else {
            None
        },
        large_image: Some(
            state
                .image
                .clone()
                .unwrap_or_else(|| util::art::steam_header(g.steam)),
        ),
        large_text: state
            .map
            .as_deref()
            .and_then(util::clamp)
            .or_else(|| util::clamp(g.name)),
        ..Live::default()
    }
}

fn run(ctx: &Ctx) {
    let Some(g) = game(ctx.target(), "") else {
        return;
    };
    let agent = util::http::agent();
    let path = std::env::var_os("LOCALAPPDATA")
        .map(|p| PathBuf::from(p).join("Electronic Arts/EA Desktop/Logs/EADesktopVerbose.log"));
    let lookup = ctx.flag("server_lookup");
    let mut name = None;
    if let Some(path) = &path.as_ref().filter(|_| lookup) {
        let mut history = util::tail::Tail::new(path, 1024 * 1024);
        history.poll(|l| {
            if let Some(p) = persona(l) {
                name = Some(p);
            }
        });
    }
    let mut tail = path.map(|p| util::tail::Tail::new(p, 0));
    let mut local_state = None;
    let mut remote = None;
    let mut last_lookup = None;
    loop {
        if let Some(tail) = &mut tail {
            tail.poll(|l| {
                if lookup {
                    if let Some(p) = persona(l) {
                        name = Some(p);
                    }
                }
                if l.contains("<CurrentUserPresenceEvent ") {
                    if let Some(raw) = xml_attr(l, "RichPresence") {
                        if game(&Target::default(), raw).is_some_and(|current| current.key == g.key)
                        {
                            local_state = local(raw);
                        }
                    }
                }
            });
        }
        let title = util::window::title(ctx.target().pid).and_then(|t| local(&t));
        // a third party api, so at most every 30 s
        if name.is_some()
            && last_lookup.is_none_or(|t: Instant| t.elapsed() >= Duration::from_secs(30))
        {
            remote = name
                .as_deref()
                .and_then(|name| current_server(&agent, g, name));
            last_lookup = Some(Instant::now());
        }
        // menu transitions supersede an API's delayed current-server response
        let state = local_state.as_ref().or(title.as_ref());
        let chosen = if state.is_some_and(|s| s.menu || s.campaign) {
            state
        } else {
            remote.as_ref().or(state)
        };
        ctx.emit(chosen.map(|s| build(ctx.settings(), g, Some(s))));
        if !ctx.sleep(Duration::from_secs(5)) {
            return;
        }
    }
}

fn preview(s: &Settings, key: &str) -> Preview {
    let g = Game {
        key: "bf6",
        name: "Battlefield 6",
        steam: "2807960",
    };
    let state = match key {
        "match" => server(
            &serde_json::json!({"mapLabel":"Siege of Cairo","modeLabel":"Conquest","numPlayers":58,"maxPlayers":64}),
        ),
        "local" => local("Battlefield 6 Conquest - Siege of Cairo - Party [1/4]"),
        "campaign" => local("Battlefield 6 Campaign"),
        _ => local("Battlefield 6 Main Menu"),
    };
    Preview {
        game: g.name,
        icon: None,
        live: build(s, g, state.as_ref()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn ea_self_profile_and_presence() {
        assert_eq!(
            persona(r#"<GetProfileResponse Persona="Example" UserIndex="0" UserId="0"/>"#),
            Some("Example".into())
        );
        assert!(persona(r#"<Friend Persona="Example"/>"#).is_none());
        let st = local("Battlefield\u{2122} 6 Conquest - Siege of Cairo - Party [1/4]").unwrap();
        assert_eq!(st.map.as_deref(), Some("Siege of Cairo"));
        assert_eq!(st.mode.as_deref(), Some("Conquest"));
        assert!(local("Arbitrary private window title").is_none());
        assert!(server(&json!({})).is_none());
        assert!(
            server(&json!({"mapLabel":"Cairo","numPlayers":500,"maxPlayers":64}))
                .unwrap()
                .players
                .is_none()
        );
        assert_eq!(encode_segment("Example /?#"), "Example%20%2F%3F%23");
    }
    #[test]
    fn games_and_previews() {
        let s = Settings::new(&MANIFEST, json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&s, key).live.is_empty());
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        let hidden = Settings::new(&MANIFEST, json!({"show_players":false}));
        assert_ne!(preview(&s, "match").live, preview(&hidden, "match").live);
        for exe in [
            "bf1.exe",
            "bfv.exe",
            "bf4.exe",
            "bf4_x86.exe",
            "bf2042.exe",
            "bf6.exe",
        ] {
            assert!(matches(&Target {
                exe: Some(exe.into()),
                ..Target::default()
            }));
        }
        assert!(!matches(&Target {
            exe: Some("bf3.exe".into()),
            ..Target::default()
        }));
        assert!(!serde_json::to_string(&preview(&s, "match").live)
            .unwrap()
            .contains("Example"));
    }
}
