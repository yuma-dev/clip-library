//! Show, round, player count and results. Ported from FallGuysStats by DevilSquirrel (MIT),
//! https://github.com/ShootMe/FallGuysStats: Entities/LogFileWatcher.cs, LevelStats.cs,
//! Multilingual.cs and Views/Stats.cs

use crate::util::{art, clamp, exe_name, now_ms, tail::Tail};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

pub static MANIFEST: Manifest = Manifest {
    id: "fall_guys",
    name: "Fall Guys",
    blurb: "Shows the show, round, player count and result.",
    setup: None,
    credits: &[Credit {
        project: "FallGuysStats",
        author: "DevilSquirrel (ShootMe)",
        url: "https://github.com/ShootMe/FallGuysStats",
        license: "MIT",
    }],
    options: &[
        Opt::toggle(
            "show_round",
            "Show round number",
            "The round within this show.",
            true,
        ),
        Opt::toggle(
            "show_players",
            "Show player count",
            "Players who spawned in this round.",
            true,
        ),
        Opt::toggle(
            "show_timer",
            "Show round clock",
            "Time since the countdown ended.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &["742897755160313986"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/1097150/library_hero.jpg"),
    preview,
    scenarios: &[
        ("menu", "Main menu"),
        ("matchmaking", "Finding a show"),
        ("loading", "Loading a round"),
        ("round", "Playing a round"),
        ("qualified", "Qualified"),
        ("eliminated", "Eliminated"),
        ("won", "Won the show"),
    ],
    steam_game: true,
    listed: true,
};

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || matches!(
            exe_name(t).as_str(),
            "fallguys_client_game.exe" | "fallguys.exe"
        )
}

// generated from the assigned recipe, names and ids checked against LevelStats.cs
const ROUNDS: &[(&str, &str, &str)] = &[
    ("round_door_dash", "door-dash", "Door Dash"),
    ("round_gauntlet_02", "dizzy-heights", "Dizzy Heights"),
    ("round_chompchomp", "gate-crash", "Gate Crash"),
    ("round_gauntlet_01", "hit-parade", "Hit Parade"),
    ("round_gauntlet_03", "whirlygig", "The Whirlygig"),
    ("round_see_saw", "see-saw", "See Saw"),
    ("round_lava", "slime-climb", "Slime Climb"),
    ("round_tip_toe", "tip-toe", "Tip Toe"),
    ("round_dodge_fall", "fruit-chute", "Fruit Chute"),
    ("round_gauntlet_04", "knight-fever", "Knight Fever"),
    ("round_wall_guys", "wall-guys", "Wall Guys"),
    ("round_biggestfan", "big-fans", "Big Fans"),
    ("round_iceclimb", "freezy-peak", "Freezy Peak"),
    ("round_gauntlet_05", "tundra-run", "Tundra Run"),
    ("round_gauntlet_06", "skyline-stumble", "Skyline Stumble"),
    ("round_shortcircuit", "short-circuit", "Short Circuit"),
    ("round_gauntlet_07", "treetop-tumble", "Treetop Tumble"),
    ("round_drumtop", "lily-leapers", "Lily Leapers"),
    ("round_gauntlet_08", "party-promenade", "Party Promenade"),
    ("round_pipedup_s6_launch", "pipe-dream", "Pipe Dream"),
    (
        "round_gauntlet_09_symphony_launch_show",
        "track-attack",
        "Track Attack",
    ),
    ("round_slimeclimb_2", "slimescraper", "The Slimescraper"),
    ("round_block_party", "block-party", "Block Party"),
    ("round_jump_club", "jump-club", "Jump Club"),
    ("round_tunnel", "roll-out", "Roll Out"),
    ("round_match_fall", "perfect-match", "Perfect Match"),
    ("round_tail_tag", "tail-tag", "Tail Tag"),
    ("round_conveyor_arena", "team-tail-tag", "Team Tail Tag"),
    ("round_fall_ball_60_players", "fall-ball", "Fall Ball"),
    ("round_hoops", "hoopsie-daisy", "Hoopsie Daisy"),
    ("round_egg_grab", "egg-scramble", "Egg Scramble"),
    ("round_jinxed", "jinxed", "Jinxed"),
    ("round_rocknroll", "rock-n-roll", "Rock 'n' Roll"),
    ("round_floor_fall", "hex-a-gone", "Hex-A-Gone"),
    ("round_jump_showdown", "jump-showdown", "Jump Showdown"),
    (
        "round_fall_mountain_hub_complete",
        "fall-mountain",
        "Fall Mountain",
    ),
    ("round_royal_rumble", "royal-fumble", "Royal Fumble"),
    ("round_thin_ice", "thin-ice", "Thin Ice"),
    (
        "round_blastball_arenasurvival_symphony_launch_show",
        "blast-ball",
        "Blast Ball",
    ),
    (
        "round_hexaring_symphony_launch_show",
        "hex-a-ring",
        "Hex-A-Ring",
    ),
    (
        "round_hexsnake_almond",
        "hex-a-terrestrial",
        "Hex-A-Terrestrial",
    ),
    ("round_tunnel_final", "roll-off", "Roll Off"),
    (
        "round_1v1_button_basher",
        "button-bashers",
        "Button Bashers",
    ),
    (
        "round_robotrampage_arena_2",
        "stompin-ground",
        "Stompin' Ground",
    ),
    ("round_fruitpunch_s4_show", "big-shots", "Big Shots"),
];

fn round(id: &str) -> Option<(&'static str, &'static str)> {
    ROUNDS
        .iter()
        .find(|(alias, _, _)| id.eq_ignore_ascii_case(alias))
        .map(|(_, key, label)| (*key, *label))
}

fn show(id: &str) -> &'static str {
    match id {
        "main_show" | "classic_solo_main_show" => "Solos",
        "squads_4" | "classic_squads_show" => "Squads",
        "squads_2" | "classic_duos_show" => "Duos",
        "casual_show" => "Explore",
        _ if id.starts_with("ugc-") => "Creative show",
        _ => "Show",
    }
}

#[derive(Clone, Copy, Default, Debug, PartialEq)]
enum Phase {
    #[default]
    Unknown,
    Menu,
    Matchmaking,
    Loading,
    Playing,
    Qualified,
    Eliminated,
    Finished,
    Results,
    Won,
}

#[derive(Default, Debug, PartialEq)]
struct State {
    phase: Phase,
    show: Option<&'static str>,
    map: Option<(&'static str, &'static str)>,
    number: u32,
    players: u32,
    counting: bool,
    local: Option<u32>,
    start: Option<i64>,
    summary: bool,
    summary_round: bool,
    summary_result: Option<bool>,
}

fn number_after(line: &str, marker: &str) -> Option<u32> {
    let rest = line.split_once(marker)?.1.trim_start();
    rest.split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}

impl State {
    fn feed(&mut self, line: &str, now: Option<i64>) {
        let line = line.trim();
        // the source reader closes the multiline episode at the next timestamped line
        if self.summary && stamped(line) {
            self.phase = match self.summary_result {
                Some(true) if self.show != Some("Explore") => Phase::Won,
                Some(false) => Phase::Eliminated,
                _ => Phase::Results,
            };
            self.summary = false;
        }
        if line.contains("[StateMainMenu] Loading scene MainMenu")
            || line.contains("with FGClient.StateMainMenu")
            || line.contains("[EOSPartyPlatformService.Base] Reset, reason: Shutdown")
        {
            *self = Self {
                phase: Phase::Menu,
                ..Self::default()
            };
        } else if line.contains("[Matchmaking] Begin")
            || line
                .contains("Replacing FGClient.StatePrivateLobby with FGClient.StateConnectToGame")
        {
            *self = Self {
                phase: Phase::Matchmaking,
                ..Self::default()
            };
        } else if let Some((_, value)) =
            line.split_once("[HandleSuccessfulLogin] Selected show is ")
        {
            let id = value.split_whitespace().next().unwrap_or("");
            if !id.is_empty() {
                self.show = Some(show(id));
            }
        } else if line.contains("[StateGameLoading] ShowLoadingGameScreenAndLoadLevel") {
            self.phase = Phase::Loading;
            self.map = None;
            self.players = 0;
            self.local = None;
            self.start = None;
            self.counting = false;
            self.summary = false;
        } else if let Some((_, value)) =
            line.split_once("[StateGameLoading] Finished loading game level")
        {
            if value.trim().is_empty() {
                return;
            }
            let id = value
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .find(|v| v.starts_with("round_") || v.starts_with("wle_"));
            self.map = id.and_then(round);
            self.phase = Phase::Loading;
            self.number = self.number.saturating_add(1);
            self.players = 0;
            self.local = None;
            self.counting = true;
            self.start = None;
            self.summary = false;
        } else if self.counting
            && (line.contains("[ClientGameManager] Finalising spawn")
                || line.contains("[ClientGameManager] Added player "))
        {
            self.players = self.players.saturating_add(1).min(100);
        } else if line.contains("[ClientGameManager] Handling bootstrap for local player FallGuy") {
            self.local = number_after(line, "playerID = ");
        } else if line.contains("[GameSession] Changing state from Countdown to Playing") {
            self.phase = Phase::Playing;
            self.counting = false;
            self.start = now;
        } else if let Some((_, value)) = line.split_once("HandleServerPlayerProgress PlayerId=") {
            let id = number_after(value, "");
            if self.local.is_some() && id == self.local {
                if value.contains("is succeeded=True") {
                    self.phase = Phase::Qualified;
                } else if value.contains("is succeeded=False") {
                    self.phase = Phase::Eliminated;
                } else {
                    return;
                }
                self.start = None;
            }
        } else if line.contains("[GameSession] Changing state from Playing to GameOver") {
            if self.phase == Phase::Playing {
                self.phase = Phase::Finished;
            }
            self.counting = false;
            self.start = None;
        } else if line.contains("== [CompletedEpisodeDto] ==") {
            self.summary = true;
            self.summary_round = false;
            self.summary_result = None;
            self.phase = Phase::Results;
            self.start = None;
            self.counting = false;
        } else if self.summary && line.starts_with("[Round ") {
            self.summary_round = number_after(line, "[Round ").is_some();
            self.summary_result = None;
            if let Some((_, id)) = line.split_once("] (") {
                self.map = round(id.trim_end_matches(')'));
            }
        } else if self.summary && self.summary_round && line.starts_with("> Qualified: ") {
            self.summary_result = match line.strip_prefix("> Qualified: ").map(str::trim) {
                Some("True") => Some(true),
                Some("False") => Some(false),
                _ => None,
            };
        } else if line.contains(
            "[StateDisconnectingFromServer] Shutting down game and resetting scene to reconnect",
        ) {
            *self = Self::default();
        }
    }
}

fn stamped(line: &str) -> bool {
    let Some(time) = line.as_bytes().get(..13) else {
        return false;
    };
    matches!(time.get(2), Some(b':' | b'.'))
        && time.get(5) == time.get(2)
        && time.get(8) == Some(&b'.')
        && time.get(12) == Some(&b':')
        && [0, 1, 3, 4, 6, 7, 9, 10, 11]
            .into_iter()
            .all(|i| time.get(i).is_some_and(u8::is_ascii_digit))
}

fn build(s: &State, settings: &Settings) -> Option<Live> {
    if s.phase == Phase::Unknown {
        return None;
    }
    let (key, label) = s.map.unwrap_or(("", "Round"));
    let mut details = match s.phase {
        Phase::Menu => "Main menu".to_string(),
        Phase::Matchmaking => "Finding a show".to_string(),
        Phase::Results => "Show results".to_string(),
        Phase::Won => "Won the show".to_string(),
        Phase::Loading => format!("Loading {label}"),
        _ => label.to_string(),
    };
    if s.number > 0
        && settings.flag("show_round")
        && matches!(
            s.phase,
            Phase::Loading
                | Phase::Playing
                | Phase::Qualified
                | Phase::Eliminated
                | Phase::Finished
        )
    {
        details = format!("Round {} - {details}", s.number);
    }
    let mut parts = Vec::new();
    if let Some(show) = s.show {
        parts.push(show.to_string());
    }
    match s.phase {
        Phase::Qualified => parts.push("Qualified".into()),
        Phase::Eliminated => parts.push("Eliminated".into()),
        Phase::Finished => parts.push("Round over".into()),
        _ => {}
    }
    if s.players > 0 && settings.flag("show_players") {
        parts.push(format!("{} players", s.players));
    }
    Some(Live {
        details: clamp(details),
        state: clamp(parts.join(", ")),
        large_image: Some(if key.is_empty() {
            art::steam_header("1097150")
        } else {
            art::url("fall-guys", key)
        }),
        large_text: if key.is_empty() { None } else { clamp(label) },
        start_ms: if settings.flag("show_timer") {
            s.start
        } else {
            None
        },
        ..Live::default()
    })
}

fn preview(settings: &Settings, scenario: &str) -> Preview {
    let mut s = State::default();
    s.feed("[StateMainMenu] Loading scene MainMenu", None);
    if matches!(
        scenario,
        "matchmaking" | "loading" | "round" | "qualified" | "eliminated" | "won"
    ) {
        s.feed("[Matchmaking] Begin - solo", None);
        s.feed("[HandleSuccessfulLogin] Selected show is classic_solo_main_show IsUltimatePartyEpisode: False", None);
        if scenario != "matchmaking" {
            s.feed("[StateGameLoading] ShowLoadingGameScreenAndLoadLevel", None);
            s.feed(
                "[StateGameLoading] Finished loading game level with level ID round_door_dash. ",
                None,
            );
            for _ in 0..40 {
                s.feed("[ClientGameManager] Finalising spawn", None);
            }
            s.feed(
                "[ClientGameManager] Handling bootstrap for local player FallGuy playerID = 7,",
                None,
            );
            if scenario != "loading" {
                s.feed(
                    "[GameSession] Changing state from Countdown to Playing",
                    Some(1_700_000_000_000),
                );
                if scenario == "qualified" {
                    s.feed(
                        "HandleServerPlayerProgress PlayerId=7 is succeeded=True",
                        None,
                    );
                }
                if scenario == "eliminated" {
                    s.feed(
                        "HandleServerPlayerProgress PlayerId=7 is succeeded=False",
                        None,
                    );
                }
                if scenario == "won" {
                    s.feed("== [CompletedEpisodeDto] ==", None);
                    s.feed("[Round 0] (round_floor_fall)", None);
                    s.feed("> Qualified: True", None);
                    s.feed("12:00:00.000: [Results] Complete", None);
                }
            }
        }
    }
    Preview {
        game: "Fall Guys",
        icon: None,
        live: build(&s, settings).unwrap_or_default(),
    }
}

fn player_log() -> Option<PathBuf> {
    Some(
        PathBuf::from(std::env::var_os("LOCALAPPDATA")?)
            .parent()?
            .join("LocalLow/Mediatonic/FallGuys_client/Player.log"),
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
    let mut tail = Tail::new(&path, if fresh { 4 << 20 } else { 0 });
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
    fn playing() -> State {
        let mut s = State::default();
        for line in [
            "12:00:00.000: [Matchmaking] Begin - solo",
            "[HandleSuccessfulLogin] Selected show is classic_squads_show IsUltimatePartyEpisode: False",
            "[StateGameLoading] ShowLoadingGameScreenAndLoadLevel",
            "[StateGameLoading] Finished loading game level with level ID round_floor_fall. ",
            "[ClientGameManager] Added player 1",
            "[ClientGameManager] Added player 2",
            "[ClientGameManager] Handling bootstrap for local player FallGuy playerID = 2,",
            "[GameSession] Changing state from Countdown to Playing",
        ] { s.feed(line, Some(1000)); }
        s
    }
    #[test]
    fn rounds_counts_results_and_privacy() {
        let mut s = playing();
        assert_eq!(s.map, Some(("hex-a-gone", "Hex-A-Gone")));
        assert_eq!(s.players, 2);
        s.feed("[ClientGameManager] Added player 3", None);
        assert_eq!(s.players, 2);
        s.feed(
            "HandleServerPlayerProgress PlayerId=1 is succeeded=False",
            None,
        );
        assert_eq!(s.phase, Phase::Playing);
        s.feed(
            "HandleServerPlayerProgress PlayerId=2 is succeeded=True",
            None,
        );
        assert_eq!(s.phase, Phase::Qualified);
        assert_eq!(s.start, None);
        s.feed(
            "[GameSession] Changing state from Playing to GameOver",
            None,
        );
        assert_eq!(s.phase, Phase::Qualified);
        s.feed("== [CompletedEpisodeDto] ==", None);
        s.feed("[Round 0] (round_door_dash)", None);
        s.feed("> Qualified: True", None);
        assert_eq!(s.phase, Phase::Results);
        s.feed("[Round 1] (round_floor_fall)", None);
        s.feed("> Qualified: False", None);
        s.feed("12:00:00.000: [Results] Complete", None);
        assert_eq!(s.phase, Phase::Eliminated);
        s.feed("[StateMainMenu] Loading scene MainMenu", None);
        assert_eq!(s.number, 0);
        assert_eq!(s.map, None);
        assert_eq!(s.players, 0);
        s.feed(
            "[HandleSuccessfulLogin] Selected show is private-name",
            None,
        );
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert!(!serde_json::to_string(&live)
            .unwrap()
            .contains("private-name"));
        assert!(!live.competing);
        assert_eq!(live.party, None);
    }
    #[test]
    fn malformed_and_unknown_rounds() {
        let mut s = State::default();
        for l in [
            "noise",
            "HandleServerPlayerProgress PlayerId=0 is succeeded=True",
            "[ClientGameManager] Handling bootstrap for local player FallGuy playerID = x,",
        ] {
            s.feed(l, None);
        }
        assert_eq!(s.phase, Phase::Unknown);
        s.feed(
            "[StateGameLoading] Finished loading game level with level ID round_new_map. ",
            None,
        );
        assert_eq!(s.map, None);
        s.feed(
            "[GameSession] Changing state from Countdown to Playing",
            None,
        );
        let live = build(&s, &settings(serde_json::json!({}))).unwrap();
        assert_eq!(live.start_ms, None);
        assert_eq!(live.large_image, Some(art::steam_header("1097150")));
        for (id, key, label) in ROUNDS {
            assert_eq!(round(id), Some((*key, *label)));
        }
        assert!(ROUNDS.len() >= 40);
        s.feed(
            "[StateDisconnectingFromServer] Shutting down game and resetting scene to reconnect",
            None,
        );
        assert_eq!(build(&s, &settings(serde_json::json!({}))), None);
    }
    #[test]
    fn previews_and_options() {
        let s = settings(serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&s, key).live.is_empty());
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        for key in ["show_round", "show_players", "show_timer"] {
            let off = settings(serde_json::json!({key:false}));
            assert_ne!(preview(&off, "round").live, preview(&s, "round").live);
        }
        assert_eq!(
            preview(&s, "won").live.details.as_deref(),
            Some("Won the show")
        );
        assert_eq!(preview(&s, "eliminated").live.start_ms, None);
        assert!(matches(&Target {
            game_id: MANIFEST.game_ids[0].into(),
            ..Target::default()
        }));
        assert!(matches(&Target {
            exe: Some("FallGuys_client_game.exe".into()),
            ..Target::default()
        }));
        assert!(!matches(&Target::default()));
    }
}
