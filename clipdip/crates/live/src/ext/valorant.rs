//! VALORANT: mode, map, score, agent, party and queue timer, rank as text.
//! Ported from valorant-rpc by Its-Haze (MIT), https://github.com/Its-Haze/valorant-rpc:
//! internal/riotchat (decode.go, watcher.go), internal/state (PhaseContext),
//! internal/discord/presence.go, internal/content (catalogue.go, queue.go),
//! internal/gamelog (gamelog.go, menuscreen.go), internal/config.

mod catalogue;
mod gamelog;
mod presence;

use std::io::Read;
use std::time::Duration;

use crate::util::{self, riot::Lockfile};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

use catalogue::{Cache, Catalogue};
use gamelog::{LogTail, Screen};
use presence::Presence;

pub static MANIFEST: Manifest = Manifest {
    id: "valorant",
    name: "VALORANT",
    blurb: "Mode, map, score, agent and party size, with the map as the picture.",
    setup: None,
    credits: &[Credit {
        project: "valorant-rpc",
        author: "Its-Haze",
        url: "https://github.com/Its-Haze/valorant-rpc",
        license: "MIT",
    }],
    options: &[
        Opt::toggle(
            "show_rank",
            "Show rank",
            "Your competitive rank in competitive queues.",
            true,
        ),
        Opt::toggle(
            "show_stats",
            "Show score",
            "The round score during a match.",
            true,
        ),
        Opt::toggle(
            "show_kills",
            "Show deathmatch kills",
            "Riot updates this every minute or so, so it often lags the scoreboard.",
            false,
        ),
        Opt::choice(
            "match_image",
            "Match picture",
            "What the big picture shows in agent select and in a match.",
            "map",
            &[("map", "Map"), ("agent", "Agent")],
        ),
        Opt::toggle(
            "show_in_client",
            "Show in menus",
            "Details while you sit in the menus or a lobby.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[DISCORD_APP_ID],
    // ascent's splash, 1920x1080
    art: Some(SAMPLE_MAP_SPLASH),
    preview,
    scenarios: SCENARIOS,
    steam_game: false,
    listed: true,
};

const DISCORD_APP_ID: &str = "700136079562375258";
const POLL: Duration = Duration::from_secs(5);
const IDLE_POLL: Duration = Duration::from_secs(12);
/// the presence list carries every friend, way past a normal body
const MAX_BODY: u64 = 8 << 20;

const RANGE_LABEL: &str = "The Range";
/// riot sends an empty queueId in custom games
const CUSTOM_LABEL: &str = "Custom game";
const COMPETITIVE: &str = "competitive";
/// ranked too, it competes but carries no competitive tier of its own
const PREMIER: &str = "premier";
/// the only queue where the ally score is the player's own kills; team
/// deathmatch and escalation score in points too, but as a team
const DEATHMATCH: &str = "deathmatch";
const SEP: &str = " · ";

fn matches(t: &Target) -> bool {
    if t.game_id == DISCORD_APP_ID {
        return true;
    }
    matches!(
        util::exe_name(t).as_str(),
        "valorant-win64-shipping.exe" | "valorant.exe"
    )
}

const MEDIA: &str = "https://media.valorant-api.com";
const SAMPLE_MAP_SPLASH: &str =
    "https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png";

const SCENARIOS: &[(&str, &str)] = &[
    ("menu", "Main menu"),
    ("lobby", "In lobby"),
    ("queue", "In queue"),
    ("custom", "Custom game"),
    ("select", "Agent select"),
    ("match", "In game"),
    ("deathmatch", "Deathmatch"),
    ("range", "The Range"),
];

/// The preview can't read the disk cache, so the sample catalogue is inline.
/// Every url was checked against valorant-api.com.
fn sample_catalogue() -> Catalogue {
    let agent = |dev: &str, name: &str, uuid: &str| catalogue::Agent {
        dev: dev.into(),
        name: name.into(),
        icon: format!("{MEDIA}/agents/{uuid}/displayicon.png"),
    };
    let map = |url: &str, name: &str, uuid: &str| catalogue::MapArt {
        url: url.into(),
        name: name.into(),
        splash: format!("{MEDIA}/maps/{uuid}/splash.png"),
    };
    Catalogue {
        fetched_ms: 0,
        agents: vec![
            agent("Wushu", "Jett", "add6443a-41bd-e414-f6ad-e58d267f4e95"),
            agent("Aggrobot", "Gekko", "e370fa57-4757-3604-3648-499e1f642d3f"),
            agent("Thorne", "Sage", "569fdd95-4d10-43ab-ca70-79becc718b46"),
        ],
        maps: vec![
            map(
                "/Game/Maps/Ascent/Ascent",
                "Ascent",
                "7eaecc1b-4337-bbf6-6ab9-04b8f06b3319",
            ),
            map(
                "/Game/Maps/Triad/Triad",
                "Haven",
                "2bee0dc9-4ffe-519b-1cbd-7fbe763a6047",
            ),
            map(
                "/Game/Maps/Jam/Jam",
                "Lotus",
                "2fe4ed3a-450a-948b-6d6b-e89a78e680a9",
            ),
            map(
                "/Game/Maps/PovegliaV2/RangeV2",
                "The Range",
                "5914d1e0-40c4-cfdd-6b88-eba06347686c",
            ),
        ],
        tiers: vec![catalogue::Tier {
            tier: 19,
            name: "Diamond 2".into(),
        }],
    }
}

/// One sample per card run() can show, in session order: the presence, the
/// menu screen from the log, the agent codename, minutes since it began.
fn sample(scenario: &str) -> (Presence, Screen, Option<&'static str>, i64) {
    let now = util::now_ms();
    let base = Presence {
        session_loop_state: "MENUS".into(),
        party_state: "DEFAULT".into(),
        queue_id: COMPETITIVE.into(),
        provisioning_flow: "Matchmaking".into(),
        game_score_type: "Rounds".into(),
        party_size: 3,
        max_party_size: 5,
        competitive_tier: 19,
        ..Presence::default()
    };
    match scenario {
        "lobby" => (base, Screen::Lobby, None, 3),
        "queue" => (
            Presence {
                party_state: "MATCHMAKING".into(),
                queue_entry_ms: Some(now - 95_000),
                ..base
            },
            Screen::Lobby,
            None,
            1,
        ),
        "custom" => (
            Presence {
                party_state: "CUSTOM_GAME_SETUP".into(),
                queue_id: String::new(),
                provisioning_flow: "CustomGame".into(),
                party_size: 6,
                max_party_size: 10,
                ..base
            },
            Screen::Lobby,
            None,
            4,
        ),
        "select" => (
            Presence {
                session_loop_state: "PREGAME".into(),
                match_map: "/Game/Maps/Triad/Triad".into(),
                ..base
            },
            Screen::Unknown,
            None,
            1,
        ),
        "match" => (
            Presence {
                session_loop_state: "INGAME".into(),
                match_map: "/Game/Maps/Ascent/Ascent".into(),
                score_ally: 9,
                score_enemy: 4,
                ..base
            },
            Screen::Unknown,
            Some("Wushu"),
            14,
        ),
        "deathmatch" => (
            Presence {
                session_loop_state: "INGAME".into(),
                queue_id: DEATHMATCH.into(),
                match_map: "/Game/Maps/Jam/Jam".into(),
                game_score_type: "Points".into(),
                score_ally: 23,
                score_enemy: 31,
                party_size: 1,
                ..base
            },
            Screen::Unknown,
            Some("Aggrobot"),
            6,
        ),
        "range" => (
            Presence {
                session_loop_state: "INGAME".into(),
                queue_id: String::new(),
                provisioning_flow: "ShootingRange".into(),
                match_map: "/Game/Maps/PovegliaV2/RangeV2".into(),
                party_size: 1,
                ..base
            },
            Screen::Unknown,
            Some("Thorne"),
            5,
        ),
        // "menu" and any unknown key
        _ => (base, Screen::Client, None, 2),
    }
}

/// Unknown keys get the first scenario. Main menu is empty with "Show in
/// menus" off, the same as the real card.
fn preview(settings: &Settings, scenario: &str) -> Preview {
    let (p, screen, codename, minutes) = sample(scenario);
    let context = context_of(&p, screen);
    let started = util::now_ms() - minutes * 60 * 1000;
    let live = build(
        &p,
        context,
        codename,
        &sample_catalogue(),
        &Opts::from_settings(settings),
        started,
    );
    Preview {
        game: "VALORANT",
        icon: None,
        live: live.unwrap_or_default(),
    }
}

fn run(ctx: &Ctx) {
    let local = util::http::loopback_agent();
    let mut riot = Riot::default();
    let mut cache = Cache::open(ctx.cache_dir());
    let mut log = LogTail::new(LogTail::default_path());
    let mut phase = Phase::default();

    loop {
        log.poll();
        let wait = match riot.presence(&local) {
            Some(p) => {
                cache.refresh();
                let s = Opts::from_settings(ctx.settings());
                let context = context_of(&p, log.screen);
                phase.enter(context, util::now_ms());
                if phase.left_match {
                    // the possession line of the last match doesn't speak for the next one
                    log.character = None;
                }
                ctx.emit(build(
                    &p,
                    context,
                    log.character.as_deref(),
                    &cache.cat,
                    &s,
                    phase.entered_ms,
                ));
                POLL
            }
            None => {
                ctx.emit(None);
                IDLE_POLL
            }
        };
        if !ctx.sleep(wait) {
            return;
        }
    }
}

/// Riot Client local API. GET only, nothing is ever written to Riot.
#[derive(Default)]
struct Riot {
    lock: Option<Lockfile>,
    puuid: Option<String>,
}

impl Riot {
    fn presence(&mut self, http: &ureq::Agent) -> Option<Presence> {
        if self.lock.is_none() {
            self.lock = Lockfile::read(&util::riot::riot_client_lockfile()?);
            self.puuid = None;
        }
        let lock = self.lock.clone()?;
        if self.puuid.is_none() {
            let body = self.get(http, &lock, "/chat/v1/session")?;
            let session: serde_json::Value = serde_json::from_slice(&body).ok()?;
            let puuid = session.get("puuid").and_then(|v| v.as_str()).unwrap_or("");
            if puuid.is_empty() {
                // not logged in yet
                return None;
            }
            self.puuid = Some(puuid.to_string());
        }
        let body = self.get(http, &lock, "/chat/v4/presences")?;
        presence::decode(&body, self.puuid.as_deref()?)
    }

    /// A transport error means the client went away or restarted with a new
    /// port and password, so the lockfile is read again next time.
    fn get(&mut self, http: &ureq::Agent, lock: &Lockfile, path: &str) -> Option<Vec<u8>> {
        let res = http
            .get(&format!("{}{path}", lock.base_url()))
            .set("Authorization", &lock.auth())
            .set("Accept", "application/json")
            .call();
        let res = match res {
            Ok(r) => r,
            Err(ureq::Error::Status(..)) => return None,
            Err(_) => {
                self.lock = None;
                self.puuid = None;
                return None;
            }
        };
        let mut body = Vec::new();
        res.into_reader()
            .take(MAX_BODY + 1)
            .read_to_end(&mut body)
            .ok()?;
        (body.len() as u64 <= MAX_BODY).then_some(body)
    }
}

struct Opts {
    show_rank: bool,
    show_stats: bool,
    show_kills: bool,
    agent_image: bool,
    show_in_client: bool,
}

impl Opts {
    fn from_settings(s: &Settings) -> Self {
        Opts {
            show_rank: s.flag("show_rank"),
            show_stats: s.flag("show_stats"),
            show_kills: s.flag("show_kills"),
            agent_image: s.choice("match_image") == "agent",
            show_in_client: s.flag("show_in_client"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Context {
    InClient,
    InLobby,
    InQueue,
    CustomGame,
    AgentSelect,
    InMatch,
}

/// No Riot payload carries a match start, so each context is timed from
/// when it was first seen here.
#[derive(Default)]
struct Phase {
    current: Option<Context>,
    entered_ms: i64,
    left_match: bool,
}

impl Phase {
    fn enter(&mut self, c: Context, now: i64) {
        self.left_match = false;
        if self.current != Some(c) {
            self.left_match = self.current == Some(Context::InMatch);
            self.current = Some(c);
            self.entered_ms = now;
        }
    }
}

/// Only MENUS defers to the party state; an unknown loop state reads as the
/// client, since partyState says MATCHMAKING through a whole match.
fn context_of(p: &Presence, screen: Screen) -> Context {
    let lsl = p.session_loop_state.to_ascii_uppercase();
    match lsl.as_str() {
        "PREGAME" => return Context::AgentSelect,
        "INGAME" => return Context::InMatch,
        "MENUS" | "" => {}
        _ => return Context::InClient,
    }
    match p.party_state.to_ascii_uppercase().as_str() {
        // queueing carries on whatever page is open
        "MATCHMAKING" => Context::InQueue,
        // the custom lobby outlives its page, the home screen with one open is the client
        "CUSTOM_GAME_SETUP" if screen == Screen::Client => Context::InClient,
        "CUSTOM_GAME_SETUP" => Context::CustomGame,
        // riot reports DEFAULT for both the home screen and Play, only the log tells them apart
        _ if screen == Screen::Lobby => Context::InLobby,
        _ => Context::InClient,
    }
}

fn is_range(p: &Presence) -> bool {
    p.provisioning_flow.eq_ignore_ascii_case("ShootingRange")
}

fn is_custom(p: &Presence) -> bool {
    p.provisioning_flow.eq_ignore_ascii_case("CustomGame")
        || p.party_state.eq_ignore_ascii_case("CUSTOM_GAME_SETUP")
}

/// Riot's queue ids, some are internal codenames; valorant-api's game modes
/// all carry queueID null, so there is nothing to join on.
fn queue_name(id: &str) -> String {
    let id = id.trim();
    let known = match id.to_ascii_lowercase().as_str() {
        "competitive" => "Competitive",
        "unrated" => "Unrated",
        "swiftplay" => "Swiftplay",
        "spikerush" => "Spike Rush",
        "deathmatch" => "Deathmatch",
        "ggteam" => "Escalation",
        "hurm" => "Team Deathmatch",
        "onefa" => "Replication",
        "newmap" => "New Map",
        "snowball" => "Snowball Fight",
        "premier" => "Premier",
        "fortcollins" => "Retake",
        "skirmish2v2" => "Skirmish",
        _ => "",
    };
    if !known.is_empty() {
        return known.to_string();
    }
    // unknown ids title-case rather than read "Unknown"
    id.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect::<String>())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn join(parts: &[Option<&str>]) -> String {
    parts
        .iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(SEP)
}

fn build(
    p: &Presence,
    context: Context,
    codename: Option<&str>,
    cat: &Catalogue,
    s: &Opts,
    entered_ms: i64,
) -> Option<Live> {
    if !s.show_in_client && matches!(context, Context::InClient | Context::InLobby) {
        return None;
    }
    let range = is_range(p);
    let custom = is_custom(p);

    let mode = if range {
        RANGE_LABEL.to_string()
    } else if custom {
        CUSTOM_LABEL.to_string()
    } else {
        queue_name(&p.queue_id)
    };
    // a custom game hides its map, in the text and the art
    let map = if custom && !range {
        None
    } else {
        cat.map(&p.match_map)
    };
    let map_name = if range {
        None
    } else {
        map.map(|m| m.name.as_str())
    };

    // the tier follows the preselected queue, so only a queue the player picked counts
    let ranked = context != Context::InClient && p.queue_id == COMPETITIVE && !custom;
    let rank = if s.show_rank && ranked {
        cat.tier(p.competitive_tier).map(|t| t.name.as_str())
    } else {
        None
    };

    let party = (p.party_size > 0 && p.max_party_size > 0).then(|| {
        [
            p.party_size.min(u32::MAX as i64) as u32,
            p.max_party_size.min(u32::MAX as i64) as u32,
        ]
    });
    let idle = p.is_idle.then_some("Idle");

    // the log names the agent only once its pawn spawns, after agent select
    let agent = if context == Context::InMatch {
        codename.and_then(|c| cat.agent(c))
    } else {
        None
    };

    // riot keeps publishing the last score through the menus, the range has none
    let score = if s.show_stats && context == Context::InMatch && !range {
        if p.game_score_type == "Points" && p.queue_id == DEATHMATCH {
            s.show_kills.then(|| match p.score_ally {
                1 => "1 kill".to_string(),
                n => format!("{n} kills"),
            })
        } else {
            Some(format!("{}-{}", p.score_ally, p.score_enemy))
        }
    } else {
        None
    };

    let mut live = Live {
        start_ms: Some(entered_ms),
        ..Live::default()
    };
    let (details, state) = match context {
        Context::InClient => (
            "In client".to_string(),
            if p.is_idle {
                "Away".to_string()
            } else {
                String::new()
            },
        ),
        Context::InLobby => (join(&[Some(&mode), rank]), join(&[Some("In lobby"), idle])),
        Context::InQueue => {
            if let Some(t) = p.queue_entry_ms {
                live.start_ms = Some(t);
            }
            (join(&[Some(&mode), rank]), join(&[Some("In queue"), idle]))
        }
        Context::CustomGame => (mode.clone(), join(&[Some("In lobby"), idle])),
        Context::AgentSelect => (
            join(&[Some(&mode), map_name, rank]),
            "Agent select".to_string(),
        ),
        Context::InMatch => {
            let agent_pic = s.agent_image && agent.is_some();
            let who = if agent_pic {
                None
            } else {
                agent.map(|a| a.name.as_str())
            };
            let st = join(&[who, score.as_deref()]);
            let st = if st.is_empty() {
                "In a match".to_string()
            } else {
                st
            };
            (join(&[Some(&mode), map_name, rank]), st)
        }
    };
    live.details = util::clamp(details);
    live.state = util::clamp(state);
    if context != Context::InClient {
        live.party = party;
    }

    if matches!(context, Context::AgentSelect | Context::InMatch) {
        match (agent, map) {
            (Some(a), _) if s.agent_image && !a.icon.is_empty() => {
                live.large_image = Some(a.icon.clone());
                live.large_text = util::clamp(a.name.as_str());
            }
            (_, Some(m)) if !m.splash.is_empty() => {
                live.large_image = Some(m.splash.clone());
                live.large_text = util::clamp(if range { RANGE_LABEL } else { m.name.as_str() });
            }
            _ => {}
        }
    }
    // a ranked match from agent select on, never the lobby or queue before it
    live.competing = matches!(context, Context::AgentSelect | Context::InMatch)
        && !custom
        && !range
        && [COMPETITIVE, PREMIER]
            .iter()
            .any(|q| p.queue_id.eq_ignore_ascii_case(q));
    Some(live)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Opts {
        Opts {
            show_rank: true,
            show_stats: true,
            show_kills: false,
            agent_image: false,
            show_in_client: true,
        }
    }

    fn in_match() -> Presence {
        presence::decode_private(include_bytes!("valorant/testdata/private_nested.json")).unwrap()
    }

    fn cat() -> Catalogue {
        catalogue::tests::catalogue()
    }

    #[test]
    fn matches_by_app_id_or_exe() {
        let t = Target {
            game_id: DISCORD_APP_ID.into(),
            ..Target::default()
        };
        assert!(matches(&t));
        let t = Target {
            game_id: "steam:1".into(),
            exe: Some("C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe".into()),
            ..Target::default()
        };
        assert!(matches(&t));
        assert!(!matches(&Target {
            game_id: "1".into(),
            ..Target::default()
        }));
    }

    #[test]
    fn contexts() {
        let mut p = Presence {
            session_loop_state: "MENUS".into(),
            party_state: "DEFAULT".into(),
            ..Presence::default()
        };
        assert_eq!(context_of(&p, Screen::Unknown), Context::InClient);
        assert_eq!(context_of(&p, Screen::Lobby), Context::InLobby);
        p.party_state = "MATCHMAKING".into();
        assert_eq!(context_of(&p, Screen::Client), Context::InQueue);
        p.party_state = "CUSTOM_GAME_SETUP".into();
        assert_eq!(context_of(&p, Screen::Lobby), Context::CustomGame);
        assert_eq!(context_of(&p, Screen::Client), Context::InClient);
        p.session_loop_state = "pregame".into();
        assert_eq!(context_of(&p, Screen::Client), Context::AgentSelect);
        p.session_loop_state = "SOMETHING_NEW".into();
        assert_eq!(context_of(&p, Screen::Lobby), Context::InClient);
        assert_eq!(context_of(&in_match(), Screen::Unknown), Context::InMatch);
    }

    #[test]
    fn in_match_with_map_art() {
        let live = build(
            &in_match(),
            Context::InMatch,
            Some("Wushu"),
            &cat(),
            &settings(),
            42,
        )
        .unwrap();
        assert_eq!(
            live.details.as_deref(),
            Some("Competitive · Ascent · Ascendant 1")
        );
        assert_eq!(live.state.as_deref(), Some("Jett · 9-4"));
        assert!(live
            .large_image
            .as_deref()
            .unwrap()
            .ends_with("/splash.png"));
        assert_eq!(live.large_text.as_deref(), Some("Ascent"));
        assert_eq!(live.party, Some([2, 5]));
        assert_eq!(live.start_ms, Some(42));
    }

    #[test]
    fn in_match_with_agent_art_and_no_rank() {
        let s = Opts {
            agent_image: true,
            show_rank: false,
            ..settings()
        };
        let live = build(&in_match(), Context::InMatch, Some("wushu"), &cat(), &s, 0).unwrap();
        assert_eq!(live.details.as_deref(), Some("Competitive · Ascent"));
        assert_eq!(live.state.as_deref(), Some("9-4"));
        assert!(live.large_image.as_deref().unwrap().contains("/agents/"));
        assert_eq!(live.large_text.as_deref(), Some("Jett"));
        // a UI class from the menus is no agent
        let live = build(&in_match(), Context::InMatch, Some("Career"), &cat(), &s, 0).unwrap();
        assert!(live
            .large_image
            .as_deref()
            .unwrap()
            .ends_with("/splash.png"));
    }

    #[test]
    fn deathmatch_kills_only_when_asked() {
        let p = Presence {
            queue_id: "deathmatch".into(),
            game_score_type: "Points".into(),
            score_ally: 1,
            ..in_match()
        };
        let live = build(&p, Context::InMatch, None, &cat(), &settings(), 0).unwrap();
        assert_eq!(live.state.as_deref(), Some("In a match"));
        let s = Opts {
            show_kills: true,
            ..settings()
        };
        let live = build(&p, Context::InMatch, None, &cat(), &s, 0).unwrap();
        assert_eq!(live.state.as_deref(), Some("1 kill"));
        assert_eq!(live.details.as_deref(), Some("Deathmatch · Ascent"));
    }

    #[test]
    fn queue_uses_riots_entry_time() {
        let p = Presence {
            session_loop_state: "MENUS".into(),
            party_state: "MATCHMAKING".into(),
            queue_id: "competitive".into(),
            competitive_tier: 21,
            party_size: 1,
            max_party_size: 5,
            is_idle: true,
            queue_entry_ms: Some(1_789_828_327_000),
            ..Presence::default()
        };
        let live = build(&p, Context::InQueue, None, &cat(), &settings(), 7).unwrap();
        assert_eq!(live.details.as_deref(), Some("Competitive · Ascendant 1"));
        assert_eq!(live.state.as_deref(), Some("In queue · Idle"));
        assert_eq!(live.start_ms, Some(1_789_828_327_000));
        assert_eq!(live.party, Some([1, 5]));
        assert_eq!(live.large_image, None);
    }

    #[test]
    fn menus_and_lobby() {
        let p = Presence {
            session_loop_state: "MENUS".into(),
            queue_id: "unrated".into(),
            party_size: 2,
            max_party_size: 5,
            ..Presence::default()
        };
        let live = build(&p, Context::InLobby, None, &cat(), &settings(), 0).unwrap();
        assert_eq!(live.details.as_deref(), Some("Unrated"));
        assert_eq!(live.state.as_deref(), Some("In lobby"));
        assert_eq!(live.party, Some([2, 5]));
        let live = build(&p, Context::InClient, None, &cat(), &settings(), 0).unwrap();
        assert_eq!(live.details.as_deref(), Some("In client"));
        assert_eq!(live.state, None);
        assert_eq!(live.party, None);
        let hidden = Opts {
            show_in_client: false,
            ..settings()
        };
        assert_eq!(build(&p, Context::InLobby, None, &cat(), &hidden, 0), None);
    }

    #[test]
    fn custom_game_hides_the_map() {
        let p = Presence {
            session_loop_state: "PREGAME".into(),
            provisioning_flow: "CustomGame".into(),
            match_map: "/Game/Maps/Ascent/Ascent".into(),
            queue_id: "competitive".into(),
            competitive_tier: 21,
            ..Presence::default()
        };
        let live = build(&p, Context::AgentSelect, None, &cat(), &settings(), 0).unwrap();
        assert_eq!(live.details.as_deref(), Some("Custom game"));
        assert_eq!(live.state.as_deref(), Some("Agent select"));
        assert_eq!(live.large_image, None);
    }

    #[test]
    fn range() {
        let p = Presence {
            session_loop_state: "INGAME".into(),
            provisioning_flow: "ShootingRange".into(),
            ..Presence::default()
        };
        let live = build(&p, Context::InMatch, None, &cat(), &settings(), 0).unwrap();
        assert_eq!(live.details.as_deref(), Some("The Range"));
        assert_eq!(live.state.as_deref(), Some("In a match"));
    }

    #[test]
    fn queue_names() {
        assert_eq!(queue_name("hurm"), "Team Deathmatch");
        assert_eq!(queue_name("SpikeRush"), "Spike Rush");
        assert_eq!(queue_name("new_thing"), "New Thing");
        assert_eq!(queue_name(""), "");
    }

    #[test]
    fn preview_follows_the_options() {
        let def = preview(&Settings::new(&MANIFEST, serde_json::json!({})), "match").live;
        assert_eq!(
            def.details.as_deref(),
            Some("Competitive · Ascent · Diamond 2")
        );
        assert_eq!(def.state.as_deref(), Some("Jett · 9-4"));
        assert_eq!(def.large_image.as_deref(), Some(SAMPLE_MAP_SPLASH));
        assert_eq!(def.party, Some([3, 5]));
        let no_rank = preview(
            &Settings::new(&MANIFEST, serde_json::json!({ "show_rank": false })),
            "match",
        )
        .live;
        assert_eq!(no_rank.details.as_deref(), Some("Competitive · Ascent"));
        let no_score = preview(
            &Settings::new(&MANIFEST, serde_json::json!({ "show_stats": false })),
            "match",
        )
        .live;
        assert_eq!(no_score.state.as_deref(), Some("Jett"));
        let agent = preview(
            &Settings::new(&MANIFEST, serde_json::json!({ "match_image": "agent" })),
            "match",
        )
        .live;
        assert_eq!(agent.large_image.as_deref(), Some("https://media.valorant-api.com/agents/add6443a-41bd-e414-f6ad-e58d267f4e95/displayicon.png"));
        assert_eq!(agent.large_text.as_deref(), Some("Jett"));
        assert_eq!(agent.state.as_deref(), Some("9-4"));
    }

    #[test]
    fn every_scenario_shows_something() {
        let def = Settings::new(&MANIFEST, serde_json::json!({}));
        let card = |key: &str| preview(&def, key).live;
        let mut contexts = Vec::new();
        for (key, _) in SCENARIOS {
            assert!(!card(key).is_empty(), "{key}");
            let (p, screen, _, _) = sample(key);
            contexts.push(context_of(&p, screen));
        }
        assert_eq!(card("nope"), card(SCENARIOS[0].0));
        assert_eq!(card("menu").details.as_deref(), Some("In client"));
        assert_eq!(card("lobby").state.as_deref(), Some("In lobby"));
        assert_eq!(card("queue").state.as_deref(), Some("In queue"));
        assert_eq!(card("custom").details.as_deref(), Some("Custom game"));
        assert_eq!(
            card("select").details.as_deref(),
            Some("Competitive · Haven · Diamond 2")
        );
        assert_eq!(card("deathmatch").state.as_deref(), Some("Gekko"));
        assert_eq!(card("range").details.as_deref(), Some("The Range"));
        assert!(card("range").large_image.unwrap().contains("5914d1e0"));
        for c in [
            Context::InClient,
            Context::InLobby,
            Context::InQueue,
            Context::CustomGame,
            Context::AgentSelect,
            Context::InMatch,
        ] {
            assert!(contexts.contains(&c), "{c:?} has no scenario");
        }
    }

    #[test]
    fn scenario_options() {
        let with =
            |v: serde_json::Value, key: &str| preview(&Settings::new(&MANIFEST, v), key).live;
        assert!(with(serde_json::json!({ "show_in_client": false }), "menu").is_empty());
        assert!(with(serde_json::json!({ "show_in_client": false }), "lobby").is_empty());
        assert!(!with(serde_json::json!({ "show_in_client": false }), "queue").is_empty());
        assert_eq!(
            with(serde_json::json!({ "show_kills": true }), "deathmatch")
                .state
                .as_deref(),
            Some("Gekko · 23 kills")
        );
        let range = with(serde_json::json!({ "match_image": "agent" }), "range");
        assert_eq!(range.large_text.as_deref(), Some("Sage"));
    }

    #[test]
    fn only_ranked_matches_compete() {
        let def = Settings::new(&MANIFEST, serde_json::json!({}));
        let competes = |key: &str| preview(&def, key).live.competing;
        assert!(competes("match"));
        assert!(competes("select"));
        for key in ["menu", "lobby", "queue", "custom", "deathmatch", "range"] {
            assert!(!competes(key), "{key}");
        }
        let premier = Presence {
            queue_id: "premier".into(),
            ..in_match()
        };
        assert!(
            build(&premier, Context::InMatch, None, &cat(), &settings(), 0)
                .unwrap()
                .competing
        );
        let unrated = Presence {
            queue_id: "unrated".into(),
            ..in_match()
        };
        assert!(
            !build(&unrated, Context::InMatch, None, &cat(), &settings(), 0)
                .unwrap()
                .competing
        );
        let custom = Presence {
            provisioning_flow: "CustomGame".into(),
            ..in_match()
        };
        assert!(
            !build(&custom, Context::InMatch, None, &cat(), &settings(), 0)
                .unwrap()
                .competing
        );
    }

    #[test]
    fn phase_timer_and_left_match() {
        let mut ph = Phase::default();
        ph.enter(Context::InMatch, 10);
        ph.enter(Context::InMatch, 20);
        assert_eq!(ph.entered_ms, 10);
        assert!(!ph.left_match);
        ph.enter(Context::InClient, 30);
        assert!(ph.left_match);
        assert_eq!(ph.entered_ms, 30);
        ph.enter(Context::InClient, 40);
        assert!(!ph.left_match);
    }
}
