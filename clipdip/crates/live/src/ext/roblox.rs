//! Experience and server type. Ported from Bloxstrap by bloxstraplabs (MIT),
//! https://github.com/bloxstraplabs/bloxstrap: Integrations/ActivityWatcher.cs and DiscordRichPresence.cs

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf, time::Duration};
mod log;

pub static MANIFEST: Manifest = Manifest {
    id: "roblox",
    name: "Roblox",
    blurb: "Experience name, icon, and server type",
    setup: None,
    credits: &[Credit {
        project: "Bloxstrap",
        author: "bloxstraplabs",
        url: "https://github.com/bloxstraplabs/bloxstrap",
        license: "MIT",
    }],
    options: &[Opt::toggle(
        "show_server_type",
        "Show server type",
        "Public, private, or reserved. Addresses stay hidden.",
        true,
    )],
    matches,
    run,
    priority: 10,
    game_ids: &["363445589247131668"],
    art: Some("https://cdn.jsdelivr.net/gh/yuma-dev/cliplib-rpc-assets@v3/roblox/banner.webp"),
    preview,
    scenarios: &[
        ("menu", "Desktop app"),
        ("joining", "Joining an experience"),
        ("public", "Public server"),
        ("private", "Private server"),
        ("reserved", "Reserved server"),
    ],
    steam_game: false,
    listed: true,
};
fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str()) || util::exe_name(t) == "robloxplayerbeta.exe"
}
#[derive(Default)]
struct State {
    place: Option<u64>,
    phase: &'static str,
    server: &'static str,
    reserved_next: bool,
}
fn number_after(line: &str, marker: &str) -> Option<u64> {
    let rest = line.split(marker).nth(1)?;
    rest.chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}
impl State {
    fn parse(&mut self, line: &str) {
        if line.contains("[FLog::UgcExperienceController]")
            && line.contains("doTeleport: joinScriptUrl")
        {
            self.reserved_next = matches!(number_after(line, "JoinTypeId\"%3a"), Some(4 | 6));
        } else if line.contains("[FLog::Output] ! Joining game") {
            if let Some(place) = number_after(line, " place ").filter(|p| *p > 0) {
                self.place = Some(place);
                self.phase = "joining";
                self.server = if self.reserved_next {
                    "Reserved server"
                } else {
                    "Public server"
                };
                self.reserved_next = false;
            }
        } else if line.contains("[FLog::GameJoinLoadTime] Report game_join_loadtime:")
            && self.place.is_some()
        {
            let lower = line.to_ascii_lowercase();
            if let Some(referral) = lower
                .split("referral_page:")
                .nth(1)
                .and_then(|r| r.split(',').next())
            {
                if referral.contains("requestprivategame")
                    || referral.contains("gamedetailpagejshybridevent")
                {
                    self.server = "Private server";
                }
            }
        } else if line.contains("[FLog::Network] Replicator created:") && self.place.is_some() {
            self.phase = "playing";
        } else if line.contains("[FLog::Network] Time to disconnect replication data:") {
            self.place = None;
            self.phase = "menu";
            self.server = "";
        } else if line.contains("[FLog::SingleSurfaceApp] leaveUGCGameInternal") {
            *self = Self {
                phase: "menu",
                ..Self::default()
            };
        }
    }
}
#[derive(Clone)]
struct Experience {
    name: String,
    icon: String,
}
fn game_name(value: &Value, universe: u64) -> Option<String> {
    value
        .get("data")?
        .as_array()?
        .iter()
        .find(|v| v.get("id").and_then(Value::as_u64) == Some(universe))?
        .get("name")?
        .as_str()
        .and_then(util::clamp)
}
fn game_icon(value: &Value, universe: u64) -> Option<String> {
    let v = value
        .get("data")?
        .as_array()?
        .iter()
        .find(|v| v.get("targetId").and_then(Value::as_u64) == Some(universe))?;
    if v.get("state")?.as_str()? != "Completed" {
        return None;
    }
    let url = v.get("imageUrl")?.as_str()?;
    // this API serves public CDN urls; no developer-provided BloxstrapRPC image urls
    (url.starts_with("https://") && url.len() <= 2048).then(|| url.to_string())
}
#[derive(Default)]
struct Cache {
    places: HashMap<u64, u64>,
    experiences: HashMap<u64, Experience>,
}
impl Cache {
    fn fetch(&mut self, agent: &ureq::Agent, place: u64) -> Option<Experience> {
        let universe = if let Some(u) = self.places.get(&place) {
            *u
        } else {
            let v: Value = util::http::get_json(
                agent,
                &format!("https://apis.roblox.com/universes/v1/places/{place}/universe"),
            )?;
            let u = v.get("universeId")?.as_u64().filter(|u| *u > 0)?;
            if self.places.len() >= 64 {
                self.places.clear();
            }
            self.places.insert(place, u);
            u
        };
        if let Some(e) = self.experiences.get(&universe) {
            return Some(e.clone());
        }
        let game: Value = util::http::get_json(
            agent,
            &format!("https://games.roblox.com/v1/games?universeIds={universe}"),
        )?;
        let name = game_name(&game, universe)?;
        let icons: Value = util::http::get_json(agent, &format!("https://thumbnails.roblox.com/v1/games/icons?universeIds={universe}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false"))?;
        let e = Experience {
            name,
            icon: game_icon(&icons, universe)?,
        };
        if self.experiences.len() >= 64 {
            self.experiences.clear();
        }
        self.experiences.insert(universe, e.clone());
        Some(e)
    }
}
fn build(s: &State, e: Option<&Experience>, settings: &Settings) -> Live {
    if s.phase == "menu" {
        return Live {
            details: util::clamp("Browsing experiences"),
            ..Live::default()
        };
    }
    let Some(e) = e else {
        return Live::default();
    };
    if s.place.is_none() {
        return Live::default();
    }
    Live {
        details: util::clamp(if s.phase == "joining" {
            format!("Joining {}", e.name)
        } else {
            e.name.clone()
        }),
        state: settings
            .flag("show_server_type")
            .then(|| util::clamp(s.server))
            .flatten(),
        large_image: Some(e.icon.clone()),
        large_text: util::clamp(e.name.clone()),
        ..Live::default()
    }
}
fn preview(settings: &Settings, scenario: &str) -> Preview {
    let e = Experience { name: "Adopt Me!".into(), icon: "https://tr.rbxcdn.com/180DAY-f6cc8a94434eb8708aaab2f7732bac01/512/512/Image/Png/noFilter".into() };
    let (phase, server) = match scenario {
        "joining" => ("joining", "Public server"),
        "public" => ("playing", "Public server"),
        "private" => ("playing", "Private server"),
        "reserved" => ("playing", "Reserved server"),
        _ => ("menu", ""),
    };
    let s = State {
        place: Some(920587237),
        phase,
        server,
        reserved_next: false,
    };
    Preview {
        game: "ROBLOX",
        icon: None,
        live: build(&s, Some(&e), settings),
    }
}
fn run(ctx: &Ctx) {
    let dir = std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Roblox/logs"));
    let mut follower = log::Follower::default();
    let mut state = State::default();
    let mut cache = Cache::default();
    let agent = util::http::agent();
    loop {
        let path = dir.as_ref().and_then(|d| {
            util::tail::newest_file(d, |n| n.ends_with(".log") && n.contains("Player"))
        });
        follower.poll(path, ctx.target().started_at_ms, &mut state, State::parse);
        let e = state.place.and_then(|p| cache.fetch(&agent, p));
        let failed = state.place.is_some() && e.is_none();
        ctx.emit(Some(build(&state, e.as_ref(), ctx.settings())));
        if !ctx.sleep(Duration::from_secs(if failed { 15 } else { 5 })) {
            return;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn joins_referrals_teleports_and_leaves() {
        let mut s = State::default();
        s.parse("[FLog::Output] ! Joining game '00000000-0000-0000-0000-000000000000' place 920587237 at 192.0.2.1");
        assert_eq!(s.place, Some(920587237));
        assert_eq!(s.phase, "joining");
        s.parse("[FLog::GameJoinLoadTime] Report game_join_loadtime: universeid:383310974,userid:0,referral_page:RequestPrivateGame,");
        assert_eq!(s.server, "Private server");
        s.parse("[FLog::Network] Replicator created: serverId: 192.0.2.1|123");
        assert_eq!(s.phase, "playing");
        s.parse("[FLog::UgcExperienceController] UgcExperienceController: doTeleport: joinScriptUrl JoinTypeId\"%3a6%2c");
        s.parse("[FLog::Network] Time to disconnect replication data: 1");
        s.parse("[FLog::Output] ! Joining game '00000000-0000-0000-0000-000000000000' place 42 at 192.0.2.2");
        assert_eq!(s.server, "Reserved server");
        s.parse("[FLog::SingleSurfaceApp] leaveUGCGameInternal");
        assert!(s.place.is_none());
        s.parse("[FLog::Output] ! Joining game malformed place 184467440737095516160 at 192.0.2.2");
        assert!(s.place.is_none());
    }
    #[test]
    fn api_payloads_and_previews() {
        assert_eq!(
            game_name(&json!({"data":[{"id":1,"name":"Sample experience"}]}), 1).as_deref(),
            Some("Sample experience")
        );
        assert!(game_name(&json!({"data":[]}), 1).is_none());
        assert!(game_icon(&json!({"data":[{"targetId":1,"state":"Pending","imageUrl":"https://example.com/icon.png"}]}),1).is_none());
        assert!(game_icon(&json!({"data":[{"targetId":1,"state":"Completed","imageUrl":"http://example.com/icon.png"}]}),1).is_none());
        assert!(game_icon(&json!({"data":[{"targetId":1,"state":"Completed","imageUrl":"https://example.com/icon.png"}]}),1).is_some());
        let a = Settings::new(&MANIFEST, json!({}));
        let b = Settings::new(&MANIFEST, json!({"show_server_type":false}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&a, key).live.is_empty());
        }
        assert_eq!(preview(&a, "unknown").live, preview(&a, "menu").live);
        assert_ne!(preview(&a, "private").live, preview(&b, "private").live);
        assert!(build(&State::default(), None, &a).is_empty());
    }
}
