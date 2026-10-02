//! League of Legends and TFT: queue, lobby, champ select pick, champion skin
//! art, KDA/CS or level, game clock, rank, TFT little legend. Ported from
//! league-rpc by Its-Haze (MIT), https://github.com/Its-Haze/league-rpc:
//! internal/livegame, internal/lcu, internal/discord, internal/championdata,
//! internal/presence/template, pkg/types. Client discovery and Live Client
//! Data types from Irelia by AlsoSylv (MIT), https://github.com/AlsoSylv/Irelia:
//! utils/process_info.rs, in_game/types.rs.
//!
//! Beyond the original: augments in Arena and ARAM: Mayhem (see augments.rs),
//! the result after a game from match history (MayhemStatsTracker by
//! MyNamesEMurray, MIT, src/main/lcu.ts and db.ts extractParticipants), Arena
//! standing from the game's end-of-game block (field names from rank-analysis
//! by wnzzer, MIT), LP won or lost, mastery and replays.

mod augments;
mod champs;
mod lcu;
mod live;
mod store;

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::util::{self, clamp, now_ms};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

use augments::{Augment, Augments};
use champs::{Champs, Resolved};
use lcu::{Lcu, Lobby, QueueInfo, Rank, Ranks};

pub static MANIFEST: Manifest = Manifest {
    id: "league",
    name: "League of Legends and TFT",
    blurb: "Queue, champion and skin art, KDA and CS, rank and LP, augments in Arena and ARAM: Mayhem, and how each game ended. TFT shows your little legend and level.",
    setup: None,
    credits: &[
        Credit {
            project: "league-rpc",
            author: "Its-Haze",
            url: "https://github.com/Its-Haze/league-rpc",
            license: "MIT",
        },
        Credit { project: "Irelia", author: "AlsoSylv", url: "https://github.com/AlsoSylv/Irelia", license: "MIT" },
        Credit {
            project: "MayhemStatsTracker",
            author: "MyNamesEMurray",
            url: "https://github.com/MyNamesEMurray/MayhemStatsTracker",
            license: "MIT",
        },
        Credit {
            project: "rank-analysis",
            author: "wnzzer",
            url: "https://github.com/wnzzer/rank-analysis",
            license: "MIT",
        },
    ],
    options: &[
        Opt::toggle("show_rank", "Show rank", "Solo/Duo, Flex, TFT or Arena rank for the queue you're in.", true),
        Opt::toggle("show_record", "Show wins and losses", "This split's record next to the rank.", false),
        Opt::toggle("show_stats", "Show KDA and CS", "Kills, deaths, assists and creep score in game.", true),
        Opt::toggle(
            "show_augments",
            "Show augments",
            "Arena and ARAM: Mayhem. Ones that give a summoner spell show during the game, all of them after it.",
            true,
        ),
        Opt::choice(
            "picture",
            "Big picture",
            "Champion art, or the icon of an augment you picked.",
            "flash",
            &[
                ("flash", "New augments"),
                ("champion", "Champion"),
                ("augment", "Last augment"),
            ],
        ),
        Opt::toggle(
            "show_result",
            "Show the result",
            "Victory or defeat, Arena and TFT placement, and the LP it cost or won.",
            true,
        ),
        Opt::toggle("show_mastery", "Show champion mastery", "Mastery level on the picture's hover.", true),
        Opt::toggle(
            "show_in_client",
            "Show while idle in the client",
            "Also fill the card on the home screen and after a game, not just in lobby, queue, champ select and games.",
            true,
        ),
        Opt::toggle(
            "hold",
            "Stay above League's own status",
            "League sets its own Discord status too. This resends your card every few seconds so it stays on top.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: GAME_IDS,
    art: Some("https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Ahri_86.jpg"),
    preview,
    scenarios: SCENARIOS,
    steam_game: false,
    listed: true,
};

/// League of Legends, Teamfight Tactics, the older League id
const GAME_IDS: &[&str] = &[
    "1402418696126992445",
    "1544195652903247973",
    "401518684763586560",
];
const EXES: &[&str] = &[
    "league of legends.exe",
    "leagueclientux.exe",
    "leagueclient.exe",
];

fn matches(t: &Target) -> bool {
    GAME_IDS.contains(&t.game_id.as_str()) || EXES.contains(&util::exe_name(t).as_str())
}

const TICK: Duration = Duration::from_secs(5);
const IDLE_TICK: Duration = Duration::from_secs(12);
const RANK_EVERY: Duration = Duration::from_secs(600);
const COMPANION_EVERY: Duration = Duration::from_secs(600);
/// an Arena round is about a minute
const STANDING_EVERY: Duration = Duration::from_secs(15);
/// gameTime drifts by a few hundred ms between polls, don't move the clock for that
const CLOCK_SLACK_MS: i64 = 2000;
/// match history and LP can take a while after the game, two minutes of ticks
const OUTCOME_TRIES: u8 = 24;
/// "New augments" shows a fresh pick this long
const AUGMENT_FLASH_MS: i64 = 60_000;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
enum Picture {
    #[default]
    Flash,
    Champion,
    Augment,
}

#[derive(Clone, Copy, Default)]
struct Opts {
    rank: bool,
    record: bool,
    stats: bool,
    augments: bool,
    picture: Picture,
    result: bool,
    mastery: bool,
    in_client: bool,
    hold: bool,
}

impl Opts {
    fn from(s: &Settings) -> Opts {
        Opts {
            rank: s.flag("show_rank"),
            record: s.flag("show_record"),
            stats: s.flag("show_stats"),
            augments: s.flag("show_augments"),
            picture: match s.choice("picture").as_str() {
                "champion" => Picture::Champion,
                "augment" => Picture::Augment,
                _ => Picture::Flash,
            },
            result: s.flag("show_result"),
            mastery: s.flag("show_mastery"),
            in_client: s.flag("show_in_client"),
            hold: s.flag("hold"),
        }
    }
}

const SCENARIOS: &[(&str, &str)] = &[
    ("client", "In client"),
    ("lobby", "In lobby"),
    ("queue", "In queue"),
    ("pick", "Champ select"),
    ("locked", "Locked in"),
    ("loading", "Loading"),
    ("game", "In game"),
    ("mayhem", "ARAM: Mayhem"),
    ("augment", "New augment"),
    ("arena", "Arena"),
    ("post", "Victory"),
    ("arena_post", "Arena result"),
    ("tft", "TFT"),
    ("tft_post", "TFT result"),
    ("spectate", "Spectating"),
    ("replay", "Replay"),
];

fn sample_champ(key: i64, alias: &str, name: &str, skin_num: i64, skin_name: &str) -> Resolved {
    Resolved {
        key,
        alias: alias.into(),
        name: name.into(),
        skin_num,
        skin_name: skin_name.into(),
    }
}

const ICONS: &str = "https://raw.communitydragon.org/latest/game/assets/ux/cherry/augments/icons";

fn sample_augment(name: &str, file: &str, rarity: &'static str, at_ms: i64) -> Augment {
    Augment {
        name: name.into(),
        icon: Some(format!("{ICONS}/{file}_large.png")),
        rarity,
        at_ms,
    }
}

/// One sample per card `run` can show, pushed through the same `build`.
/// Unknown keys get the first scenario.
fn preview(s: &Settings, scenario: &str) -> Preview {
    let o = Opts::from(s);
    let now = now_ms();
    let ahri = sample_champ(103, "Ahri", "Ahri", 86, "Immortalized Legend Ahri");
    let ranked_game = Game {
        mode: "CLASSIC".into(),
        map: 11,
        champ: Some(ahri.clone()),
        stats: Some(Stats::Kda(live::Scores {
            kills: 5,
            deaths: 2,
            assists: 7,
            creep_score: 112,
        })),
        start_ms: Some(now - (14 * 60 + 32) * 1000),
        mastery: Some(12),
        ..Game::default()
    };
    let lobby = Lobby {
        queue_id: 420,
        game_mode: "CLASSIC".into(),
        map_id: 11,
        players: 2,
        max_players: 5,
        ..Lobby::default()
    };
    let rank = |tier: &str, division: &str, lp: i64, wins: u32, losses: u32| Rank {
        tier: tier.into(),
        division: division.into(),
        lp,
        wins,
        losses,
        rated: None,
    };
    let ranks = Ranks {
        solo: Some(rank("GOLD", "II", 64, 41, 37)),
        tft: Some(rank("PLATINUM", "IV", 12, 18, 15)),
        arena: Some(Rank {
            rated: Some(("PURPLE".into(), 1480)),
            ..Rank::default()
        }),
        ..Ranks::default()
    };
    let card = |queue: &str, lobby: Lobby, since_s: i64| {
        let rank = if o.rank {
            ranks.text_for(lobby.queue_id, o.record)
        } else {
            None
        };
        let custom = lobby.custom || lobby.practice;
        Card {
            queue: queue.into(),
            mode: lobby.game_mode.clone(),
            rank,
            custom,
            party: Some([lobby.players, lobby.max_players]).filter(|p| !custom && p[1] > 1),
            icon: Some(champs::profile_icon_url(588)),
            companion: champs::companion_url("/lol-game-data/assets/ASSETS/Loadouts/Companions/Tooltip_Choncc_Dragon_Mythic_Tier1.png")
                .map(|u| (u, "Choncc the Wise".to_string())),
            since_ms: now - since_s * 1000,
            ranked: !custom && is_ranked_queue(lobby.queue_id),
            now_ms: now,
        }
    };
    let mayhem_lobby = Lobby {
        queue_id: 2400,
        game_mode: "KIWI".into(),
        map_id: 12,
        players: 3,
        max_players: 5,
        ..Lobby::default()
    };
    let mayhem = |fresh: bool| Game {
        mode: "KIWI".into(),
        map: 12,
        champ: Some(sample_champ(222, "Jinx", "Jinx", 1, "Crime City Jinx")),
        stats: Some(Stats::Kda(live::Scores {
            kills: 11,
            deaths: 6,
            assists: 23,
            creep_score: 41,
        })),
        start_ms: Some(now - (9 * 60 + 48) * 1000),
        augments: vec![
            sample_augment("ADAPt", "adapt", "Silver", now - 300_000),
            sample_augment("Apex Inventor", "apexinventor", "Gold", if fresh { now - 8_000 } else { now - 200_000 }),
        ],
        mastery: Some(7),
        ..Game::default()
    };
    let arena_lobby = Lobby {
        queue_id: 1700,
        game_mode: "CHERRY".into(),
        map_id: 30,
        players: 2,
        max_players: 2,
        ..Lobby::default()
    };
    let arena = Game {
        mode: "CHERRY".into(),
        map: 30,
        champ: Some(sample_champ(360, "Samira", "Samira", 30, "Soul Fighter Samira")),
        stats: Some(Stats::Arena(
            live::Scores {
                kills: 6,
                deaths: 2,
                assists: 5,
                creep_score: 0,
            },
            14,
        )),
        start_ms: Some(now - (11 * 60 + 5) * 1000),
        augments: vec![sample_augment("Warmup Routine", "warmuproutine", "Prismatic", now - 400_000)],
        standing: Some(2),
        ..Game::default()
    };
    let tft_lobby = Lobby {
        queue_id: 1100,
        game_mode: "TFT".into(),
        map_id: 22,
        players: 1,
        max_players: 1,
        ..Lobby::default()
    };
    let tft = Game {
        mode: "TFT".into(),
        map: 22,
        level: 7,
        start_ms: Some(now - (18 * 60 + 40) * 1000),
        ..Game::default()
    };

    let key = SCENARIOS
        .iter()
        .map(|(k, _)| *k)
        .find(|k| *k == scenario)
        .unwrap_or("client");
    let (scene, c) = match key {
        "lobby" => (Scene::Lobby, card("Ranked Solo/Duo", lobby, 40)),
        "queue" => (Scene::Queue, card("Ranked Solo/Duo", lobby, 107)),
        "pick" => (
            Scene::ChampSelect {
                champ: Some(sample_champ(103, "Ahri", "Ahri", 0, "Ahri")),
                locked: false,
            },
            card("Ranked Solo/Duo", lobby, 38),
        ),
        "locked" => (
            Scene::ChampSelect {
                champ: Some(ahri.clone()),
                locked: true,
            },
            card("Ranked Solo/Duo", lobby, 71),
        ),
        "loading" => (
            Scene::Loading {
                champ: Some(ahri.clone()),
            },
            card("Ranked Solo/Duo", lobby, 24),
        ),
        "game" => (
            Scene::Game(ranked_game.clone()),
            card("Ranked Solo/Duo", lobby, 0),
        ),
        "mayhem" => (Scene::Game(mayhem(false)), card("ARAM: Mayhem", mayhem_lobby, 0)),
        "augment" => (Scene::Game(mayhem(true)), card("ARAM: Mayhem", mayhem_lobby, 0)),
        "arena" => (Scene::Game(arena.clone()), card("Arena", arena_lobby.clone(), 0)),
        "post" => {
            let g = Game {
                stats: Some(Stats::Kda(live::Scores {
                    kills: 9,
                    deaths: 3,
                    assists: 11,
                    creep_score: 214,
                })),
                ..ranked_game.clone()
            };
            (
                Scene::PostGame {
                    game: Some(g),
                    outcome: Outcome {
                        win: Some(true),
                        rank: Some("+21 LP".into()),
                        ..Outcome::default()
                    },
                },
                card("Ranked Solo/Duo", lobby, 15),
            )
        }
        "arena_post" => {
            let g = Game {
                augments: vec![],
                standing: None,
                ..arena.clone()
            };
            (
                Scene::PostGame {
                    game: Some(g),
                    outcome: Outcome {
                        win: Some(true),
                        placement: Some(2),
                        rank: Some("+35 rating".into()),
                        augments: vec![
                            sample_augment("Warmup Routine", "warmuproutine", "Prismatic", 0),
                            sample_augment("Apex Inventor", "apexinventor", "Gold", 0),
                            sample_augment("ADAPt", "adapt", "Silver", 0),
                        ],
                    },
                },
                card("Arena", arena_lobby, 20),
            )
        }
        "tft" => (Scene::Game(tft.clone()), card("Ranked Teamfight Tactics", tft_lobby.clone(), 0)),
        "tft_post" => (
            Scene::PostGame {
                game: Some(tft.clone()),
                outcome: Outcome {
                    placement: Some(3),
                    rank: Some("+35 LP".into()),
                    ..Outcome::default()
                },
            },
            card("Ranked Teamfight Tactics", tft_lobby, 12),
        ),
        "spectate" | "replay" => {
            let g = Game {
                mode: "ARAM".into(),
                map: 12,
                champ: Some(sample_champ(99, "Lux", "Lux", 7, "Elementalist Lux")),
                start_ms: Some(now - (6 * 60 + 12) * 1000),
                spectating: true,
                replay: key == "replay",
                ..Game::default()
            };
            (Scene::Game(g), card("ARAM", Lobby::default(), 0))
        }
        _ => (Scene::Client, card("Ranked Solo/Duo", Lobby::default(), 0)),
    };
    Preview {
        game: "League of Legends",
        icon: Some("https://raw.githubusercontent.com/Its-Haze/league-rpc/master/assets/leagueoflegends.png"),
        live: build(&scene, &c, o).unwrap_or_default(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Stats {
    Kda(live::Scores),
    /// Arena: KDA and level
    Arena(live::Scores, u32),
    /// Swarm: CS and level
    Swarm(u32, u32),
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Game {
    /// raw gameMode: CLASSIC, ARAM, TFT, CHERRY...
    mode: String,
    map: i64,
    champ: Option<Resolved>,
    stats: Option<Stats>,
    /// TFT level
    level: u32,
    start_ms: Option<i64>,
    spectating: bool,
    /// a replay from the client, shown like spectating
    replay: bool,
    /// in pick order, the ones the live api reveals
    augments: Vec<Augment>,
    /// Arena: where our duo stands, 1..=8
    standing: Option<u32>,
    mastery: Option<u32>,
}

/// How a game ended, read after it.
#[derive(Clone, Debug, Default, PartialEq)]
struct Outcome {
    win: Option<bool>,
    /// Arena and TFT
    placement: Option<u32>,
    /// "+21 LP", "Promoted to Gold I"
    rank: Option<String>,
    /// every augment, from match history
    augments: Vec<Augment>,
}

#[derive(Clone, Debug, PartialEq)]
enum Scene {
    Client,
    Lobby,
    Queue,
    ChampSelect {
        champ: Option<Resolved>,
        locked: bool,
    },
    Loading {
        champ: Option<Resolved>,
    },
    Game(Game),
    PostGame {
        game: Option<Game>,
        outcome: Outcome,
    },
}

/// What the card text needs around the scene.
#[derive(Clone, Debug, Default)]
struct Card {
    queue: String,
    mode: String,
    rank: Option<String>,
    custom: bool,
    party: Option<[u32; 2]>,
    icon: Option<String>,
    /// TFT little legend: (icon url, name)
    companion: Option<(String, String)>,
    since_ms: i64,
    /// Ranked Solo/Duo, Flex or TFT: champ select and the game itself compete
    ranked: bool,
    /// for how long a new augment stays the picture
    now_ms: i64,
}

/// 420 Solo/Duo, 440 Flex, 1100 Ranked TFT, 1160 Double Up. Arena's rating isn't a ranked queue.
fn is_ranked_queue(queue_id: i64) -> bool {
    matches!(queue_id, 420 | 440 | 1100 | 1160)
}

fn run(ctx: &Ctx) {
    let mut s = State::new(ctx);
    loop {
        let opts = Opts::from(ctx.settings());
        let answered = s.tick(ctx.target(), opts);
        let live = s
            .scene()
            .and_then(|scene| build(&scene, &s.card(opts), opts));
        ctx.emit(live);
        if !ctx.sleep(if answered { TICK } else { IDLE_TICK }) {
            return;
        }
    }
}

struct State {
    lcu: Option<Lcu>,
    game_api: ureq::Agent,
    champs: Champs,
    augments: Augments,
    locale_known: bool,
    phase: String,
    since_ms: i64,
    lobby: Option<Lobby>,
    refresh_lobby: bool,
    queues: HashMap<i64, QueueInfo>,
    /// the running game's queue and id from the gameflow session, 0 until known
    queue_id: i64,
    game_id: i64,
    ranks: Ranks,
    ranks_at: Option<Instant>,
    /// the game's queue before it started, to tell what it did to the rank
    rank_before: Option<Rank>,
    icon: Option<i64>,
    puuid: String,
    companion: Option<(String, String)>,
    companion_at: Option<Instant>,
    /// champ select: (champion key, full skin id, locked)
    pick: Option<(i64, i64, bool)>,
    pick_champ: Option<Resolved>,
    riot_id: String,
    game: Option<Game>,
    game_up: bool,
    last_game: Option<Game>,
    /// summoner spell names seen this game, the first ones are the real spells
    spells: HashSet<String>,
    spells_known: bool,
    mastery_tried: bool,
    standing_at: Option<Instant>,
    outcome: Outcome,
    outcome_tries: u8,
    outcome_done: bool,
}

impl State {
    fn new(ctx: &Ctx) -> State {
        State {
            lcu: None,
            game_api: util::http::loopback_agent(),
            champs: Champs::new(ctx.cache_dir()),
            augments: Augments::new(ctx.cache_dir()),
            locale_known: false,
            phase: String::new(),
            since_ms: now_ms(),
            lobby: None,
            refresh_lobby: true,
            queues: HashMap::new(),
            queue_id: 0,
            game_id: 0,
            ranks: Ranks::default(),
            ranks_at: None,
            rank_before: None,
            icon: None,
            puuid: String::new(),
            companion: None,
            companion_at: None,
            pick: None,
            pick_champ: None,
            riot_id: String::new(),
            game: None,
            game_up: false,
            last_game: None,
            spells: HashSet::new(),
            spells_known: false,
            mastery_tried: false,
            standing_at: None,
            outcome: Outcome::default(),
            outcome_tries: 0,
            outcome_done: false,
        }
    }

    /// One poll of the client and, in a game, the game. True when either answered.
    fn tick(&mut self, target: &Target, o: Opts) -> bool {
        if self.lcu.is_none() {
            self.lcu = lcu::discover(target);
            self.locale_known = false;
        }
        let mut answered = false;
        if self.lcu.is_some() {
            match self.client_tick(o) {
                Ok(()) => answered = true,
                Err(lcu::Down) => {
                    self.lcu = None;
                    self.phase.clear();
                    self.lobby = None;
                }
            }
        }

        let in_game = matches!(self.phase.as_str(), "InProgress" | "Reconnect" | "Watching");
        // a replay runs the game with the client idle
        let replay = self.lcu.is_some() && self.phase == "None";
        // without a client the game api answering is the only signal
        if in_game || replay || self.lcu.is_none() {
            self.game_up = self.game_tick(o, replay);
            answered |= self.game_up;
            if replay && !self.game_up && self.game.is_some() {
                self.game = None;
                self.riot_id.clear();
            }
        } else {
            self.game_up = false;
        }
        answered
    }

    fn new_game(&mut self) {
        self.game = None;
        self.last_game = None;
        self.pick = None;
        self.pick_champ = None;
        self.riot_id.clear();
        self.queue_id = 0;
        self.game_id = 0;
        self.rank_before = None;
        self.spells.clear();
        self.spells_known = false;
        self.mastery_tried = false;
        self.standing_at = None;
        self.outcome = Outcome::default();
        self.outcome_tries = 0;
        self.outcome_done = false;
    }

    fn set_phase(&mut self, p: String) {
        if p == self.phase {
            return;
        }
        match p.as_str() {
            "None" | "Lobby" | "Matchmaking" | "CheckedIntoTournament" => {
                self.new_game();
                if p == "None" {
                    self.lobby = None;
                }
            }
            "WaitingForStats" | "PreEndOfGame" | "EndOfGame" => {
                if let Some(g) = self.game.take() {
                    self.last_game = Some(g);
                }
                // LP moved
                self.ranks_at = None;
            }
            _ => {}
        }
        // the first phase seen keeps the session clock
        if !self.phase.is_empty() {
            self.since_ms = now_ms();
        }
        self.refresh_lobby = p != "None";
        self.phase = p;
    }

    /// the session's queue in a game, the lobby's before it
    fn queue(&self) -> i64 {
        if self.queue_id > 0 {
            self.queue_id
        } else {
            self.lobby.as_ref().map(|l| l.queue_id).unwrap_or(0)
        }
    }

    fn client_tick(&mut self, o: Opts) -> Result<(), lcu::Down> {
        let Some(l) = self.lcu.take() else {
            return Ok(());
        };
        let res = self.client_tick_with(&l, o);
        self.lcu = Some(l);
        res
    }

    fn client_tick_with(&mut self, l: &Lcu, o: Opts) -> Result<(), lcu::Down> {
        if let Some(p) = l.get::<String>(lcu::PHASE)? {
            self.set_phase(p);
        }
        let phase = self.phase.clone();
        let in_game = matches!(phase.as_str(), "InProgress" | "Reconnect" | "Watching");
        let post_game = matches!(
            phase.as_str(),
            "WaitingForStats" | "PreEndOfGame" | "EndOfGame"
        );

        if !self.locale_known {
            self.locale_known = true;
            if let Some(r) = l.get::<lcu::RegionLocale>(lcu::LOCALE)? {
                self.augments.set_locale(&r.locale);
            }
        }

        // member count changes while in the lobby, otherwise once per phase
        if phase == "Lobby" || self.refresh_lobby {
            self.refresh_lobby = false;
            let lobby = match l.get::<lcu::LobbyResp>(lcu::LOBBY)? {
                Some(r) => Some(lcu::lobby_from_config(
                    &r.game_config,
                    r.members.len() as u32,
                )),
                None => l
                    .get::<lcu::PlayerStatus>(lcu::PLAYER_STATUS)?
                    .and_then(|m| m.current_lobby_status)
                    .map(|s| lcu::lobby_from_status(&s)),
            };
            if let Some(lobby) = lobby {
                self.lobby = Some(lobby);
            }
        }

        // the session knows the queue and game id even when the lobby is gone (reconnects)
        if (in_game || post_game || phase == "ChampSelect") && (self.queue_id == 0 || self.game_id == 0) {
            if let Some(s) = l.get::<lcu::Session>(lcu::SESSION)? {
                if s.game_data.queue.id > 0 {
                    self.queue_id = s.game_data.queue.id;
                }
                if s.game_data.game_id > 0 {
                    self.game_id = s.game_data.game_id;
                }
            }
        }

        let qid = self.queue();
        if qid > 0 && !self.queues.contains_key(&qid) && self.lobby.as_ref().is_none_or(|l| l.fixed_name.is_none()) {
            if let Some(q) = l.get::<QueueInfo>(&lcu::queue_path(qid))? {
                self.queues.insert(qid, q);
            }
        }
        // the metadata path has no mode or map, the queue does
        if let (Some(lobby), Some(q)) = (self.lobby.as_mut(), self.queues.get(&qid)) {
            if lobby.game_mode.is_empty() {
                lobby.game_mode = q.game_mode.clone();
            }
            if lobby.map_id == 0 {
                lobby.map_id = q.map_id;
            }
        }

        let want_ranks = o.rank || o.result;
        if want_ranks && !in_game && self.ranks_at.is_none_or(|t| t.elapsed() > RANK_EVERY) {
            if let Some(r) = l.get::<lcu::RankedResp>(lcu::RANKED)? {
                self.ranks = Ranks::from_resp(&r);
                self.ranks_at = Some(Instant::now());
            }
        }
        // the standing going in, for what the game did to it
        if self.rank_before.is_none() && self.ranks_at.is_some() && matches!(phase.as_str(), "ChampSelect" | "GameStart" | "InProgress") {
            self.rank_before = self.ranks.for_queue(qid).cloned();
        }

        if (self.icon.is_none() || self.puuid.is_empty()) && !in_game {
            if let Some(s) = l.get::<lcu::Summoner>(lcu::SUMMONER)? {
                self.icon = Some(s.profile_icon_id).filter(|id| *id > 0);
                self.puuid = s.puuid;
            }
        }

        if self.is_tft()
            && self
                .companion_at
                .is_none_or(|t| t.elapsed() > COMPANION_EVERY)
        {
            self.companion_at = Some(Instant::now());
            if let Some(item) = l
                .get::<lcu::CompanionResp>(lcu::TFT_COMPANION)?
                .and_then(|c| c.selected_loadout_item)
            {
                self.companion = champs::companion_url(&item.loadouts_icon).map(|u| (u, item.name));
            }
        }

        if matches!(phase.as_str(), "ChampSelect" | "GameStart") {
            if let Some(cs) = l.get::<lcu::ChampSelect>(lcu::CHAMP_SELECT)? {
                let pick = lcu::my_pick(&cs);
                let key = |p: Option<(i64, i64, bool)>| p.map(|(c, s, _)| (c, s));
                if key(pick) != key(self.pick) {
                    self.pick_champ = pick.and_then(|(c, s, _)| self.champs.by_key(c, s));
                }
                self.pick = pick;
            }
        }

        if in_game && phase != "Watching" {
            self.in_game_extras(l, o)?;
        }
        if post_game && !self.outcome_done && self.outcome_tries < OUTCOME_TRIES {
            self.outcome_tries += 1;
            self.read_outcome(l, o)?;
        }
        Ok(())
    }

    /// mastery once per game, Arena standing every round or so
    fn in_game_extras(&mut self, l: &Lcu, o: Opts) -> Result<(), lcu::Down> {
        let key = self
            .game
            .as_ref()
            .and_then(|g| g.champ.as_ref())
            .map(|c| c.key)
            .unwrap_or(0);
        if o.mastery && !self.mastery_tried && key > 0 {
            self.mastery_tried = true;
            let level = l
                .get::<Vec<lcu::Mastery>>(lcu::MASTERY)?
                .and_then(|list| list.into_iter().find(|m| m.champion_id == key))
                .map(|m| m.champion_level)
                .filter(|lv| *lv > 0);
            if let Some(g) = self.game.as_mut() {
                g.mastery = level;
            }
        }

        let arena = self.game.as_ref().is_some_and(|g| g.mode == "CHERRY");
        if arena && self.standing_at.is_none_or(|t| t.elapsed() > STANDING_EVERY) {
            self.standing_at = Some(Instant::now());
            let standing = l
                .get::<lcu::GameclientEog>(lcu::GAMECLIENT_EOG)?
                .and_then(|e| e.standing(self.game_id, &self.puuid));
            if let (Some(g), Some(s)) = (self.game.as_mut(), standing) {
                g.standing = Some(s);
            }
        }
        Ok(())
    }

    /// Result, placement, every augment and the rank change, as they become available.
    fn read_outcome(&mut self, l: &Lcu, o: Opts) -> Result<(), lcu::Down> {
        let tft = self.last_game.as_ref().is_some_and(|g| g.mode == "TFT");
        let mut found = false;
        if tft {
            if self.outcome.placement.is_none() {
                self.outcome.placement = l
                    .get::<lcu::TftEog>(lcu::TFT_EOG)?
                    .map(|e| e.local_player.ffa_standing)
                    .filter(|p| (1..=8).contains(p));
            }
            found = self.outcome.placement.is_some();
        } else if self.outcome.win.is_none() {
            if self.game_id == 0 {
                self.game_id = l
                    .get::<lcu::EogBlock>(lcu::EOG)?
                    .map(|e| e.game_id)
                    .unwrap_or(0);
            }
            if self.game_id > 0 && !self.puuid.is_empty() {
                if let Some(m) = l.get::<lcu::Match>(&lcu::match_path(self.game_id))? {
                    if let Some(me) = m.mine(&self.puuid).cloned() {
                        found = true;
                        self.apply_match(&me, o);
                    }
                }
            }
        } else {
            found = true;
        }

        let mut rank_done = self.outcome.rank.is_some() || self.rank_before.is_none();
        if !rank_done {
            if let Some(r) = l.get::<lcu::RankedResp>(lcu::RANKED)? {
                self.ranks = Ranks::from_resp(&r);
                self.ranks_at = Some(Instant::now());
                let after = self.ranks.for_queue(self.queue());
                self.outcome.rank = self
                    .rank_before
                    .as_ref()
                    .zip(after)
                    .and_then(|(b, a)| lcu::rank_change(b, a));
                rank_done = self.outcome.rank.is_some();
            }
        }
        self.outcome_done = found && rank_done;
        Ok(())
    }

    fn apply_match(&mut self, me: &lcu::MatchStats, o: Opts) {
        self.outcome.win = Some(me.win);
        self.outcome.placement = Some(me.subteam_placement).filter(|p| (1..=8).contains(p));
        if o.augments {
            self.outcome.augments = me
                .augment_ids()
                .into_iter()
                .filter_map(|id| self.augments.by_id(id))
                .collect();
        }
        // the final line beats the last poll from a few seconds before the end
        if let Some(g) = self.last_game.as_mut() {
            let s = live::Scores {
                kills: me.kills,
                deaths: me.deaths,
                assists: me.assists,
                creep_score: me.total_minions_killed + me.neutral_minions_killed,
            };
            g.stats = match g.stats {
                Some(Stats::Arena(_, lv)) => Some(Stats::Arena(s, me.champ_level.max(lv))),
                Some(Stats::Swarm(..)) => g.stats,
                _ => Some(Stats::Kda(s)),
            };
        }
    }

    fn is_tft(&self) -> bool {
        let lobby = self.lobby.as_ref().is_some_and(|l| l.game_mode == "TFT");
        let game = self
            .game
            .as_ref()
            .or(self.last_game.as_ref())
            .is_some_and(|g| g.mode == "TFT");
        lobby || game
    }

    /// league-rpc's poller: champion once, scores and clock every tick.
    fn game_tick(&mut self, o: Opts, replay: bool) -> bool {
        let Some(gs) = live::get::<live::GameStats>(&self.game_api, "gamestats") else {
            return false;
        };
        let watching = self.phase == "Watching";
        let no_client = self.lcu.is_none();
        let g = self.game.get_or_insert_with(Game::default);
        g.mode = gs.game_mode;
        g.map = gs.map_number;
        g.replay = replay;
        let start = now_ms() - (gs.game_time.max(0.0) * 1000.0) as i64;
        if g.start_ms
            .is_none_or(|s| (s - start).abs() > CLOCK_SLACK_MS)
        {
            g.start_ms = Some(start);
        }

        if g.mode == "TFT" {
            if let Some(ap) = live::get::<live::ActivePlayer>(&self.game_api, "activeplayer") {
                g.level = ap.level;
            }
            return true;
        }

        if self.riot_id.is_empty() && !watching && !replay {
            if let Some(ap) = live::get::<live::ActivePlayer>(&self.game_api, "activeplayer") {
                self.riot_id = ap.id().to_string();
                // spectator mode answers with an error object instead of a player
                g.spectating = no_client && self.riot_id.is_empty();
            }
        }
        if watching || replay {
            g.spectating = true;
        }

        if g.champ.is_none() {
            if let Some(all) = live::get::<live::AllGameData>(&self.game_api, "allgamedata") {
                // spectating shows the first player's champion, like the original
                let p = if g.spectating {
                    all.all_players.first()
                } else {
                    all.find(&self.riot_id)
                };
                if let Some(p) = p {
                    g.champ = self.champs.by_raw(
                        &p.raw_champion_name,
                        &p.raw_skin_name,
                        p.skin_id,
                        &p.champion_name,
                    );
                }
            }
        }

        if o.stats && !g.spectating && !self.riot_id.is_empty() {
            let scores =
                live::get::<live::Scores>(&self.game_api, &live::scores_path(&self.riot_id));
            let level =
                || live::get::<live::ActivePlayer>(&self.game_api, "activeplayer").map(|a| a.level);
            g.stats = match (g.mode.as_str(), scores) {
                (_, None) => g.stats,
                ("CHERRY", Some(s)) => level().map(|lv| Stats::Arena(s, lv)).or(g.stats),
                ("STRAWBERRY", Some(s)) => level()
                    .map(|lv| Stats::Swarm(s.creep_score, lv))
                    .or(g.stats),
                (_, Some(s)) => Some(Stats::Kda(s)),
            };
        }

        let mode = augments::mode_of(&g.mode);
        if let (true, Some(mode), false, false) = (o.augments, mode, g.spectating, self.riot_id.is_empty()) {
            if let Some(sp) =
                live::get::<live::SummonerSpells>(&self.game_api, &live::spells_path(&self.riot_id))
            {
                let now = now_ms();
                let names: Vec<String> = sp.names().map(str::to_string).collect();
                for name in names {
                    if !self.spells.insert(name.clone()) || !self.spells_known {
                        continue;
                    }
                    let Some(a) = self.augments.by_spell_name(&name, mode, now) else {
                        continue;
                    };
                    let g = self.game.get_or_insert_with(Game::default);
                    if !g.augments.iter().any(|x| x.name == a.name) {
                        g.augments.push(a);
                    }
                }
                // the first answer is the summoners picked in champ select
                self.spells_known = true;
            }
        }
        true
    }

    fn scene(&self) -> Option<Scene> {
        let s = match self.phase.as_str() {
            // no client: only the game api
            "" => Scene::Game(self.game.clone().filter(|_| self.game_up)?),
            "None" if self.game_up => Scene::Game(self.game.clone()?),
            "InProgress" | "Reconnect" | "Watching" => match (&self.game, self.game_up) {
                (Some(g), true) => Scene::Game(g.clone()),
                _ => Scene::Loading {
                    champ: self.pick_champ.clone(),
                },
            },
            "ChampSelect" | "GameStart" => Scene::ChampSelect {
                champ: self.pick_champ.clone(),
                locked: self.pick.is_some_and(|p| p.2),
            },
            "Matchmaking" | "ReadyCheck" | "CheckedIntoTournament" => Scene::Queue,
            "Lobby" => Scene::Lobby,
            "WaitingForStats" | "PreEndOfGame" | "EndOfGame" => Scene::PostGame {
                game: self.last_game.clone(),
                outcome: self.outcome.clone(),
            },
            _ => Scene::Client,
        };
        Some(s)
    }

    fn card(&self, o: Opts) -> Card {
        let lobby = self.lobby.as_ref();
        let qid = self.queue();
        let mode = self
            .game
            .as_ref()
            .or(self.last_game.as_ref())
            .map(|g| g.mode.clone())
            .filter(|m| !m.is_empty())
            .or_else(|| lobby.map(|l| l.game_mode.clone()))
            .unwrap_or_default();
        let queue = queue_name(lobby, self.queues.get(&qid), &mode);
        let rank = if o.rank {
            self.ranks.text_for(qid, o.record)
        } else {
            None
        };
        let custom = lobby.is_some_and(|l| l.custom || l.practice);
        let party = lobby
            .filter(|l| !custom && l.max_players > 1)
            .map(|l| [l.players.max(1), l.max_players]);
        Card {
            queue,
            mode,
            rank,
            custom,
            party,
            icon: self.icon.map(champs::profile_icon_url),
            companion: self.companion.clone(),
            since_ms: self.since_ms,
            ranked: !custom && is_ranked_queue(qid),
            now_ms: now_ms(),
        }
    }
}

/// league-rpc's queueDisplayName: custom name, detailed description, queue
/// name, the mode's display name, then the game's name.
fn queue_name(lobby: Option<&Lobby>, q: Option<&QueueInfo>, mode: &str) -> String {
    if let Some(n) = lobby.and_then(|l| l.fixed_name) {
        return n.to_string();
    }
    if let Some(q) = q {
        if !q.detailed_description.is_empty() {
            return q.detailed_description.clone();
        }
        if !q.name.is_empty() {
            return q.name.clone();
        }
    }
    let m = mode_name(mode);
    if m.is_empty() {
        "League of Legends".to_string()
    } else {
        m
    }
}

/// league-rpc's gameModeDisplayNames, unknown modes as they come
fn mode_name(mode: &str) -> String {
    let name = match mode {
        "PRACTICETOOL" => "Summoner's Rift (Custom)",
        "ARAM" => "Howling Abyss (ARAM)",
        "CLASSIC" => "Summoner's Rift",
        "TUTORIAL" | "TUTORIAL_MODULE_1" | "TUTORIAL_MODULE_2" | "TUTORIAL_MODULE_3" => {
            "Summoner's Rift (Tutorial)"
        }
        "URF" => "Summoner's Rift (URF)",
        "ARURF" => "ARURF",
        "ONEFORALL" => "One for All",
        "NEXUSBLITZ" => "Nexus Blitz",
        "CHERRY" => "Arena",
        "STRAWBERRY" => "Swarm",
        "BRAWL" => "Brawl",
        "KIWI" => "ARAM: Mayhem",
        "KIWI_JADE" => "ARAM: Mayhem Classic-ish",
        "JADE" => "League Classic",
        "ULTBOOK" => "Ultimate Spellbook",
        "SWIFTPLAY" => "Swiftplay",
        "RUBY" => "Doom Bots",
        "RUBY_TRIAL_1" => "Doom Bots - Veigar's Evil!",
        "RUBY_TRIAL_3" => "Doom Bots - Veigar's Doom!",
        "TFT" => "Teamfight Tactics",
        other => other,
    };
    name.to_string()
}

fn with_rank(text: &str, rank: Option<&str>) -> String {
    match rank {
        Some(r) => format!("{text} · {r}"),
        None => text.to_string(),
    }
}

/// league-rpc's FormatKDA / FormatArenaStats / FormatSwarmStats, minus the
/// gold that would change the card on every poll
fn stats_line(s: &Stats) -> String {
    match s {
        Stats::Kda(s) => format!(
            "{}/{}/{} · {} CS",
            s.kills, s.deaths, s.assists, s.creep_score
        ),
        Stats::Arena(s, lv) => format!("{}/{}/{} · Level {lv}", s.kills, s.deaths, s.assists),
        Stats::Swarm(cs, lv) => format!("{cs} CS · Level {lv}"),
    }
}

fn ordinal(n: u32) -> String {
    let suffix = match (n % 10, n % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

/// Profile icon, or the little legend in TFT, as in league-rpc's lobby card.
fn client_art(c: &Card) -> (Option<String>, Option<String>) {
    if c.mode == "TFT" {
        if let Some((url, name)) = &c.companion {
            return (Some(url.clone()), Some(name.clone()));
        }
    }
    (c.icon.clone(), clamp(mode_name(&c.mode)))
}

fn champ_details(queue: &str, champ: Option<&Resolved>) -> Option<String> {
    match champ {
        Some(ch) => clamp(format!("{queue}, {}", ch.name)),
        None => clamp(queue),
    }
}

/// skin, rank, "Mastery 12" and the augment names, whichever are on, joined by middle dots
fn hover(skin: Option<&str>, rank: Option<&str>, mastery: Option<u32>, augments: &[Augment]) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    parts.extend(skin.map(str::to_string));
    parts.extend(rank.map(str::to_string));
    parts.extend(mastery.map(|m| format!("Mastery {m}")));
    if !augments.is_empty() {
        parts.push(augments.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", "));
    }
    clamp(parts.join(" · "))
}

/// The augment that takes the big picture, when the setting and timing call for one.
fn featured<'a>(augments: &'a [Augment], c: &Card, o: Opts) -> Option<&'a Augment> {
    if !o.augments {
        return None;
    }
    let last = augments.last().filter(|a| a.icon.is_some())?;
    match o.picture {
        Picture::Augment => Some(last),
        Picture::Flash => (last.at_ms > 0 && c.now_ms - last.at_ms < AUGMENT_FLASH_MS).then_some(last),
        Picture::Champion => None,
    }
}

fn augment_art(a: &Augment) -> (Option<String>, Option<String>) {
    (a.icon.clone(), clamp(format!("{} · {} augment", a.name, a.rarity)))
}

/// "Victory", "2nd place" or "Game over", then the rank change
fn result_line(out: &Outcome, o: Opts) -> String {
    if !o.result {
        return "Game over".to_string();
    }
    let head = match (out.placement, out.win) {
        (Some(p), _) => format!("{} place", ordinal(p)),
        (None, Some(true)) => "Victory".to_string(),
        (None, Some(false)) => "Defeat".to_string(),
        (None, None) => "Game over".to_string(),
    };
    match &out.rank {
        Some(r) => format!("{head} · {r}"),
        None => head,
    }
}

fn build(scene: &Scene, c: &Card, o: Opts) -> Option<Live> {
    let mut live = Live {
        hold: o.hold,
        ..Live::default()
    };
    match scene {
        Scene::Client => {
            if !o.in_client {
                return None;
            }
            live.details = clamp("In the client");
            live.large_image = c.icon.clone();
        }
        Scene::Lobby => {
            live.details = clamp(&c.queue);
            // custom lobbies skip rank and the player count, as in the original
            if c.custom {
                live.state = clamp("In lobby");
            } else {
                live.state = clamp(with_rank("In lobby", c.rank.as_deref()));
                live.party = c.party;
            }
            (live.large_image, live.large_text) = client_art(c);
        }
        Scene::Queue => {
            live.details = clamp(&c.queue);
            live.state = clamp(with_rank("In queue", c.rank.as_deref()));
            live.start_ms = Some(c.since_ms);
            (live.large_image, live.large_text) = client_art(c);
        }
        Scene::ChampSelect { champ, locked } => {
            live.competing = c.ranked;
            live.details = clamp(&c.queue);
            let what = match champ {
                Some(ch) if *locked => format!("Locked in {}", ch.name),
                Some(ch) => format!("Picking {}", ch.name),
                None => "In champ select".to_string(),
            };
            live.state = clamp(with_rank(&what, c.rank.as_deref()));
            live.start_ms = Some(c.since_ms);
            match champ {
                Some(ch) => {
                    live.large_image = Some(champs::tile_url(&ch.alias, ch.skin_num));
                    live.large_text = clamp(&ch.skin_name);
                }
                None => (live.large_image, live.large_text) = client_art(c),
            }
        }
        Scene::Loading { champ } => {
            live.competing = c.ranked;
            live.details = champ_details(&c.queue, champ.as_ref());
            live.state = clamp("Loading in");
            live.start_ms = Some(c.since_ms);
            if let Some(ch) = champ {
                live.large_image = Some(champs::tile_url(&ch.alias, ch.skin_num));
                live.large_text = clamp(&ch.skin_name);
            }
        }
        Scene::Game(g) if g.spectating => {
            let what = if g.replay { "Watching a replay" } else { "Spectating" };
            live.details = clamp(mode_name(&g.mode)).or_else(|| clamp(&c.queue));
            live.state = clamp(what);
            live.start_ms = g.start_ms;
            live.large_image = Some(match &g.champ {
                Some(ch) => champs::tile_url(&ch.alias, ch.skin_num),
                None => champs::map_icon_url(g.map),
            });
            live.large_text = clamp(what);
        }
        Scene::Game(g) if g.mode == "TFT" => {
            live.competing = c.ranked;
            live.details = clamp(&c.queue);
            if g.level > 0 {
                live.state = clamp(format!("Level {}", g.level));
            }
            live.start_ms = g.start_ms;
            if let Some((url, name)) = &c.companion {
                live.large_image = Some(url.clone());
                live.large_text = clamp(with_rank(name, c.rank.as_deref()));
            } else {
                live.large_text = c.rank.as_deref().and_then(clamp);
            }
        }
        Scene::Game(g) => {
            live.competing = c.ranked;
            live.details = champ_details(&c.queue, g.champ.as_ref());
            let standing = g.standing.map(|s| format!("{} place", ordinal(s)));
            let stats = g.stats.as_ref().filter(|_| o.stats).map(stats_line);
            live.state = match (standing, stats) {
                (Some(p), Some(s)) => clamp(format!("{p} · {s}")),
                (p, s) => p.or(s).and_then(clamp),
            };
            live.start_ms = g.start_ms;
            let augs: &[Augment] = if o.augments { &g.augments } else { &[] };
            if let Some(a) = featured(augs, c, o) {
                (live.large_image, live.large_text) = augment_art(a);
            } else {
                live.large_image = g.champ.as_ref().map(|ch| champs::tile_url(&ch.alias, ch.skin_num));
                live.large_text = hover(
                    g.champ.as_ref().map(|ch| ch.skin_name.as_str()),
                    c.rank.as_deref(),
                    g.mastery.filter(|_| o.mastery),
                    augs,
                );
            }
        }
        Scene::PostGame { game, outcome } => {
            if !o.in_client {
                return None;
            }
            match game {
                Some(g) if g.mode == "TFT" => {
                    live.details = clamp(&c.queue);
                    live.state = clamp(result_line(outcome, o));
                    if let Some((url, name)) = &c.companion {
                        live.large_image = Some(url.clone());
                        live.large_text = clamp(name);
                    }
                }
                Some(g) if !g.spectating => {
                    live.details = champ_details(&c.queue, g.champ.as_ref());
                    let head = result_line(outcome, o);
                    live.state = clamp(match g.stats.as_ref().filter(|_| o.stats).map(stats_line) {
                        Some(s) => format!("{head} · {s}"),
                        None => head,
                    });
                    // match history has all of them, the live api only some
                    let augs: &[Augment] = match (o.augments, outcome.augments.is_empty()) {
                        (false, _) => &[],
                        (true, false) => &outcome.augments,
                        (true, true) => &g.augments,
                    };
                    match augs.last().filter(|a| o.picture == Picture::Augment && a.icon.is_some()) {
                        Some(a) => (live.large_image, live.large_text) = augment_art(a),
                        None => {
                            live.large_image =
                                g.champ.as_ref().map(|ch| champs::tile_url(&ch.alias, ch.skin_num));
                            live.large_text =
                                hover(g.champ.as_ref().map(|ch| ch.skin_name.as_str()), None, None, augs);
                        }
                    }
                }
                _ => {
                    live.details = clamp(&c.queue);
                    live.state = clamp("Game over");
                    live.large_image = c.icon.clone();
                }
            }
        }
    }
    Some(live)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: Opts = Opts {
        rank: true,
        record: false,
        stats: true,
        augments: true,
        picture: Picture::Flash,
        result: true,
        mastery: true,
        in_client: true,
        hold: true,
    };

    fn chogath() -> Resolved {
        Resolved {
            key: 31,
            alias: "Chogath".into(),
            name: "Cho'Gath".into(),
            skin_num: 5,
            skin_name: "Battlecast Prime Cho'Gath".into(),
        }
    }

    fn card() -> Card {
        Card {
            queue: "Ranked Solo/Duo".into(),
            mode: "CLASSIC".into(),
            rank: Some("Gold IV: 57 LP".into()),
            party: Some([2, 5]),
            icon: Some(champs::profile_icon_url(29)),
            since_ms: 1_000,
            now_ms: 1_000_000,
            ..Card::default()
        }
    }

    fn aug(name: &str, at_ms: i64) -> Augment {
        Augment {
            name: name.into(),
            icon: Some(format!("https://x/{name}.png")),
            rarity: "Gold",
            at_ms,
        }
    }

    #[test]
    fn matches_ids_and_exes() {
        let t = |id: &str, exe: Option<&str>| Target {
            game_id: id.into(),
            exe: exe.map(Into::into),
            ..Target::default()
        };
        assert!(matches(&t("1544195652903247973", None)));
        assert!(matches(&t(
            "x",
            Some(r"C:\Riot Games\League of Legends\LeagueClientUx.exe")
        )));
        assert!(matches(&t(
            "x",
            Some(r"C:\Riot Games\League of Legends\Game\League of Legends.exe")
        )));
        assert!(!matches(&t(
            "x",
            Some(r"C:\Riot Games\VALORANT\live\VALORANT.exe")
        )));
    }

    #[test]
    fn in_game_card() {
        let g = Game {
            mode: "CLASSIC".into(),
            map: 11,
            champ: Some(chogath()),
            stats: Some(Stats::Kda(live::Scores {
                kills: 5,
                deaths: 2,
                assists: 7,
                creep_score: 182,
            })),
            start_ms: Some(42),
            mastery: Some(9),
            ..Game::default()
        };
        let l = build(&Scene::Game(g.clone()), &card(), ON).unwrap();
        assert_eq!(l.details.as_deref(), Some("Ranked Solo/Duo, Cho'Gath"));
        assert_eq!(l.state.as_deref(), Some("5/2/7 · 182 CS"));
        assert_eq!(
            l.large_image.as_deref(),
            Some("https://ddragon.leagueoflegends.com/cdn/img/champion/tiles/Chogath_5.jpg")
        );
        assert_eq!(
            l.large_text.as_deref(),
            Some("Battlecast Prime Cho'Gath · Gold IV: 57 LP · Mastery 9")
        );
        assert_eq!(l.start_ms, Some(42));
        assert!(l.hold);

        let l = build(
            &Scene::Game(g),
            &card(),
            Opts {
                rank: false,
                stats: false,
                mastery: false,
                hold: false,
                ..ON
            },
        )
        .unwrap();
        assert_eq!(l.state, None);
        // the rank comes with the card, `card()` leaves it out when show_rank is off
        assert_eq!(l.large_text.as_deref(), Some("Battlecast Prime Cho'Gath · Gold IV: 57 LP"));
        assert!(!l.hold);
    }

    #[test]
    fn augments_take_the_picture_for_a_minute() {
        let c = card();
        let g = Game {
            mode: "KIWI".into(),
            champ: Some(chogath()),
            augments: vec![aug("ADAPt", 1), aug("Tank Engine", c.now_ms - 10_000)],
            ..Game::default()
        };
        let l = build(&Scene::Game(g.clone()), &c, ON).unwrap();
        assert_eq!(l.large_image.as_deref(), Some("https://x/Tank Engine.png"));
        assert_eq!(l.large_text.as_deref(), Some("Tank Engine · Gold augment"));

        let later = Card {
            now_ms: c.now_ms + AUGMENT_FLASH_MS,
            ..c.clone()
        };
        let l = build(&Scene::Game(g.clone()), &later, ON).unwrap();
        assert!(l.large_image.unwrap().ends_with("Chogath_5.jpg"));
        assert_eq!(
            l.large_text.as_deref(),
            Some("Battlecast Prime Cho'Gath · Gold IV: 57 LP · ADAPt, Tank Engine")
        );

        let keep = Opts {
            picture: Picture::Augment,
            ..ON
        };
        let l = build(&Scene::Game(g.clone()), &later, keep).unwrap();
        assert_eq!(l.large_image.as_deref(), Some("https://x/Tank Engine.png"));

        let champ = Opts {
            picture: Picture::Champion,
            ..ON
        };
        assert!(build(&Scene::Game(g.clone()), &c, champ).unwrap().large_image.unwrap().ends_with("Chogath_5.jpg"));

        let off = Opts {
            augments: false,
            ..ON
        };
        let l = build(&Scene::Game(g), &c, off).unwrap();
        assert_eq!(l.large_text.as_deref(), Some("Battlecast Prime Cho'Gath · Gold IV: 57 LP"));
    }

    #[test]
    fn arena_standing_leads_the_line() {
        let g = Game {
            mode: "CHERRY".into(),
            champ: Some(chogath()),
            stats: Some(Stats::Arena(
                live::Scores {
                    kills: 3,
                    deaths: 1,
                    assists: 4,
                    creep_score: 0,
                },
                12,
            )),
            standing: Some(2),
            ..Game::default()
        };
        let l = build(&Scene::Game(g), &card(), ON).unwrap();
        assert_eq!(l.state.as_deref(), Some("2nd place · 3/1/4 · Level 12"));
    }

    #[test]
    fn post_game_result() {
        let g = Game {
            mode: "CLASSIC".into(),
            champ: Some(chogath()),
            stats: Some(Stats::Kda(live::Scores {
                kills: 9,
                deaths: 3,
                assists: 11,
                creep_score: 214,
            })),
            ..Game::default()
        };
        let won = Outcome {
            win: Some(true),
            rank: Some("+21 LP".into()),
            ..Outcome::default()
        };
        let scene = |outcome: Outcome| Scene::PostGame {
            game: Some(g.clone()),
            outcome,
        };
        let l = build(&scene(won.clone()), &card(), ON).unwrap();
        assert_eq!(l.state.as_deref(), Some("Victory · +21 LP · 9/3/11 · 214 CS"));
        assert_eq!(l.large_text.as_deref(), Some("Battlecast Prime Cho'Gath"));

        let lost = Outcome {
            win: Some(false),
            ..Outcome::default()
        };
        assert_eq!(build(&scene(lost), &card(), ON).unwrap().state.as_deref(), Some("Defeat · 9/3/11 · 214 CS"));
        let pending = build(&scene(Outcome::default()), &card(), ON).unwrap();
        assert_eq!(pending.state.as_deref(), Some("Game over · 9/3/11 · 214 CS"));
        let quiet = Opts {
            result: false,
            ..ON
        };
        assert_eq!(build(&scene(won), &card(), quiet).unwrap().state.as_deref(), Some("Game over · 9/3/11 · 214 CS"));

        let arena = Outcome {
            win: Some(true),
            placement: Some(2),
            augments: vec![aug("Warmup Routine", 0), aug("ADAPt", 0)],
            ..Outcome::default()
        };
        let l = build(&scene(arena.clone()), &card(), ON).unwrap();
        assert!(l.state.unwrap().starts_with("2nd place · "));
        assert_eq!(l.large_text.as_deref(), Some("Battlecast Prime Cho'Gath · Warmup Routine, ADAPt"));
        let pic = Opts {
            picture: Picture::Augment,
            ..ON
        };
        assert_eq!(build(&scene(arena), &card(), pic).unwrap().large_image.as_deref(), Some("https://x/ADAPt.png"));
    }

    #[test]
    fn arena_and_swarm_lines() {
        let s = live::Scores {
            kills: 3,
            deaths: 1,
            assists: 4,
            creep_score: 90,
        };
        assert_eq!(stats_line(&Stats::Arena(s, 12)), "3/1/4 · Level 12");
        assert_eq!(stats_line(&Stats::Swarm(90, 9)), "90 CS · Level 9");
    }

    #[test]
    fn tft_card() {
        let mut c = card();
        c.queue = "Ranked Teamfight Tactics".into();
        c.mode = "TFT".into();
        c.companion = Some(("https://x/legend.png".into(), "Featherknight".into()));
        let g = Game {
            mode: "TFT".into(),
            level: 7,
            start_ms: Some(9),
            ..Game::default()
        };
        let l = build(&Scene::Game(g.clone()), &c, ON).unwrap();
        assert_eq!(l.state.as_deref(), Some("Level 7"));
        assert_eq!(l.large_image.as_deref(), Some("https://x/legend.png"));
        let l = build(
            &Scene::PostGame {
                game: Some(g),
                outcome: Outcome {
                    placement: Some(3),
                    rank: Some("+35 LP".into()),
                    ..Outcome::default()
                },
            },
            &c,
            ON,
        )
        .unwrap();
        assert_eq!(l.state.as_deref(), Some("3rd place · +35 LP"));
    }

    #[test]
    fn client_side_cards() {
        let c = card();
        let l = build(&Scene::Lobby, &c, ON).unwrap();
        assert_eq!(l.state.as_deref(), Some("In lobby · Gold IV: 57 LP"));
        assert_eq!(l.party, Some([2, 5]));
        let l = build(&Scene::Queue, &c, ON).unwrap();
        assert_eq!(l.state.as_deref(), Some("In queue · Gold IV: 57 LP"));
        assert_eq!(l.start_ms, Some(1_000));
        let l = build(
            &Scene::ChampSelect {
                champ: Some(chogath()),
                locked: true,
            },
            &c,
            ON,
        )
        .unwrap();
        assert_eq!(
            l.state.as_deref(),
            Some("Locked in Cho'Gath · Gold IV: 57 LP")
        );
        assert!(l.large_image.unwrap().ends_with("Chogath_5.jpg"));
        let l = build(
            &Scene::ChampSelect {
                champ: None,
                locked: false,
            },
            &c,
            ON,
        )
        .unwrap();
        assert_eq!(l.state.as_deref(), Some("In champ select · Gold IV: 57 LP"));

        let off = Opts {
            in_client: false,
            ..ON
        };
        assert!(build(&Scene::Client, &c, off).is_none());
        assert!(build(
            &Scene::PostGame {
                game: None,
                outcome: Outcome::default(),
            },
            &c,
            off
        )
        .is_none());
        assert!(build(&Scene::Lobby, &c, off).is_some());
    }

    #[test]
    fn custom_lobby_has_no_party() {
        let mut c = card();
        c.custom = true;
        c.queue = "Practice Tool".into();
        let l = build(&Scene::Lobby, &c, ON).unwrap();
        assert_eq!(l.state.as_deref(), Some("In lobby"));
        assert_eq!(l.party, None);
    }

    #[test]
    fn queue_names() {
        let q = QueueInfo {
            name: "Ranked Solo/Duo".into(),
            ..QueueInfo::default()
        };
        assert_eq!(queue_name(None, Some(&q), "CLASSIC"), "Ranked Solo/Duo");
        assert_eq!(queue_name(None, None, "ARAM"), "Howling Abyss (ARAM)");
        assert_eq!(queue_name(None, None, "KIWI"), "ARAM: Mayhem");
        assert_eq!(queue_name(None, None, ""), "League of Legends");
        let l = Lobby {
            fixed_name: Some("Custom Game"),
            ..Lobby::default()
        };
        assert_eq!(queue_name(Some(&l), Some(&q), "CLASSIC"), "Custom Game");
    }

    #[test]
    fn preview_follows_settings() {
        let on = preview(&Settings::new(&MANIFEST, serde_json::json!({})), "game").live;
        assert_eq!(on.details.as_deref(), Some("Ranked Solo/Duo, Ahri"));
        assert_eq!(on.state.as_deref(), Some("5/2/7 · 112 CS"));
        assert_eq!(
            on.large_text.as_deref(),
            Some("Immortalized Legend Ahri · Gold II: 64 LP · Mastery 12")
        );
        assert!(on
            .large_image
            .as_deref()
            .is_some_and(|u| u.ends_with("Ahri_86.gif")));
        let no_stats = preview(
            &Settings::new(&MANIFEST, serde_json::json!({ "show_stats": false })),
            "game",
        )
        .live;
        assert_eq!(no_stats.state, None);
        let no_rank = preview(
            &Settings::new(&MANIFEST, serde_json::json!({ "show_rank": false, "show_mastery": false })),
            "game",
        )
        .live;
        assert_eq!(
            no_rank.large_text.as_deref(),
            Some("Immortalized Legend Ahri")
        );
        let record = preview(&Settings::new(&MANIFEST, serde_json::json!({ "show_record": true })), "lobby").live;
        assert_eq!(record.state.as_deref(), Some("In lobby · Gold II: 64 LP · 41W 37L"));
    }

    #[test]
    fn every_scenario_has_a_card() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        for (key, _) in SCENARIOS {
            let p = preview(&s, key);
            assert!(!p.live.is_empty(), "{key}");
            assert!(p.live.details.is_some(), "{key}");
        }
        assert_eq!(preview(&s, "nope").live, preview(&s, SCENARIOS[0].0).live);
        assert_eq!(preview(&s, "").live, preview(&s, "client").live);

        let off = Settings::new(&MANIFEST, serde_json::json!({ "show_in_client": false }));
        assert!(preview(&off, "client").live.is_empty());
        assert!(preview(&off, "post").live.is_empty());
        assert!(!preview(&off, "lobby").live.is_empty());

        let p = preview(&s, "tft").live;
        assert_eq!(
            p.large_text.as_deref(),
            Some("Choncc the Wise · Platinum IV: 12 LP")
        );
        let p = preview(&s, "locked").live;
        assert_eq!(p.state.as_deref(), Some("Locked in Ahri · Gold II: 64 LP"));
        assert!(preview(&s, "augment").live.large_image.unwrap().ends_with("apexinventor_large.png"));
        assert!(preview(&s, "mayhem").live.large_image.unwrap().ends_with(".jpg"));
        assert_eq!(preview(&s, "replay").live.state.as_deref(), Some("Watching a replay"));
        assert_eq!(preview(&s, "post").live.state.as_deref(), Some("Victory · +21 LP · 9/3/11 · 214 CS"));
    }

    #[test]
    fn only_ranked_matches_compete() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        for key in ["pick", "locked", "loading", "game", "tft"] {
            assert!(preview(&s, key).live.competing, "{key}");
        }
        for key in ["client", "lobby", "queue", "mayhem", "augment", "arena", "post", "arena_post", "tft_post", "spectate", "replay"] {
            assert!(!preview(&s, key).live.competing, "{key}");
        }
        let mut c = card();
        c.ranked = false;
        let g = Game {
            mode: "ARAM".into(),
            ..Game::default()
        };
        assert!(!build(&Scene::Game(g), &c, ON).unwrap().competing);
        assert!(!is_ranked_queue(450) && !is_ranked_queue(1700) && is_ranked_queue(440) && is_ranked_queue(1160));
    }

    #[test]
    fn ordinals() {
        assert_eq!(ordinal(1), "1st");
        assert_eq!(ordinal(2), "2nd");
        assert_eq!(ordinal(3), "3rd");
        assert_eq!(ordinal(8), "8th");
    }

    #[test]
    fn spectating_card() {
        let g = Game {
            mode: "ARAM".into(),
            map: 12,
            spectating: true,
            start_ms: Some(1),
            ..Game::default()
        };
        let l = build(&Scene::Game(g.clone()), &card(), ON).unwrap();
        assert_eq!(l.details.as_deref(), Some("Howling Abyss (ARAM)"));
        assert_eq!(l.state.as_deref(), Some("Spectating"));
        assert!(l.large_image.unwrap().contains("/aram/"));
        let replay = Game { replay: true, ..g };
        assert_eq!(build(&Scene::Game(replay), &card(), ON).unwrap().state.as_deref(), Some("Watching a replay"));
    }
}
