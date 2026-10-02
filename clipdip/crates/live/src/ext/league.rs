//! League of Legends and TFT: queue, lobby, champ select pick, champion skin
//! art, KDA/CS or level, game clock, rank, TFT little legend. Ported from
//! league-rpc by Its-Haze (MIT), https://github.com/Its-Haze/league-rpc:
//! internal/livegame, internal/lcu, internal/discord, internal/championdata,
//! internal/presence/template, pkg/types. Client discovery and Live Client
//! Data types from Irelia by AlsoSylv (MIT), https://github.com/AlsoSylv/Irelia:
//! utils/process_info.rs, in_game/types.rs.

mod champs;
mod lcu;
mod live;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::util::{self, clamp, now_ms};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

use champs::{Champs, Resolved};
use lcu::{Lcu, Lobby, QueueInfo, Ranks};

pub static MANIFEST: Manifest = Manifest {
    id: "league",
    name: "League of Legends and TFT",
    blurb: "Queue, champion and skin art, KDA and CS, game clock and rank. TFT shows your little legend and level.",
    setup: None,
    credits: &[
        Credit {
            project: "league-rpc",
            author: "Its-Haze",
            url: "https://github.com/Its-Haze/league-rpc",
            license: "MIT",
        },
        Credit { project: "Irelia", author: "AlsoSylv", url: "https://github.com/AlsoSylv/Irelia", license: "MIT" },
    ],
    options: &[
        Opt::toggle("show_rank", "Show rank", "Solo/Duo, Flex, TFT or Arena rank for the queue you're in.", true),
        Opt::toggle("show_stats", "Show KDA and CS", "Kills, deaths, assists and creep score in game.", true),
        Opt::toggle(
            "show_in_client",
            "Show while idle in the client",
            "Also fill the card on the home screen and after a game, not just in lobby, queue, champ select and games.",
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
/// gameTime drifts by a few hundred ms between polls, don't move the clock for that
const CLOCK_SLACK_MS: i64 = 2000;
/// tft-eog-stats can lag behind the EndOfGame phase
const EOG_TRIES: u8 = 3;

#[derive(Clone, Copy, Default)]
struct Opts {
    rank: bool,
    stats: bool,
    in_client: bool,
}

impl Opts {
    fn from(s: &Settings) -> Opts {
        Opts {
            rank: s.flag("show_rank"),
            stats: s.flag("show_stats"),
            in_client: s.flag("show_in_client"),
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
    ("arena", "Arena"),
    ("post", "Post game"),
    ("tft", "TFT"),
    ("spectate", "Spectating"),
];

fn sample_champ(alias: &str, name: &str, skin_num: i64, skin_name: &str) -> Resolved {
    Resolved {
        alias: alias.into(),
        name: name.into(),
        skin_num,
        skin_name: skin_name.into(),
    }
}

/// One sample per card `run` can show, pushed through the same `build`.
/// Unknown keys get the first scenario.
fn preview(s: &Settings, scenario: &str) -> Preview {
    let o = Opts::from(s);
    let now = now_ms();
    let ahri = sample_champ("Ahri", "Ahri", 86, "Immortalized Legend Ahri");
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
    let ranks = Ranks {
        solo: Some("Gold II: 64 LP".into()),
        tft: Some("Platinum IV: 12 LP".into()),
        arena: Some("Gold · Rating: 1480".into()),
        ..Ranks::default()
    };
    let card = |queue: &str, lobby: Lobby, since_s: i64| {
        let rank = if o.rank {
            ranks.for_queue(lobby.queue_id).map(str::to_string)
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
        }
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
                champ: Some(sample_champ("Ahri", "Ahri", 0, "Ahri")),
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
        "arena" => {
            let g = Game {
                mode: "CHERRY".into(),
                map: 30,
                champ: Some(sample_champ("Samira", "Samira", 30, "Soul Fighter Samira")),
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
                ..Game::default()
            };
            let l = Lobby {
                queue_id: 1700,
                game_mode: "CHERRY".into(),
                map_id: 30,
                players: 2,
                max_players: 2,
                ..Lobby::default()
            };
            (Scene::Game(g), card("Arena", l, 0))
        }
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
                    placement: None,
                },
                card("Ranked Solo/Duo", lobby, 15),
            )
        }
        "tft" => {
            let g = Game {
                mode: "TFT".into(),
                map: 22,
                level: 7,
                start_ms: Some(now - (18 * 60 + 40) * 1000),
                ..Game::default()
            };
            let l = Lobby {
                queue_id: 1100,
                game_mode: "TFT".into(),
                map_id: 22,
                players: 1,
                max_players: 1,
                ..Lobby::default()
            };
            (Scene::Game(g), card("Ranked Teamfight Tactics", l, 0))
        }
        "spectate" => {
            let g = Game {
                mode: "ARAM".into(),
                map: 12,
                champ: Some(sample_champ("Lux", "Lux", 7, "Elementalist Lux")),
                start_ms: Some(now - (6 * 60 + 12) * 1000),
                spectating: true,
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
        placement: Option<u32>,
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
}

/// 420 Solo/Duo, 440 Flex, 1100 Ranked TFT. Arena's rating isn't a ranked queue.
fn is_ranked_queue(queue_id: i64) -> bool {
    matches!(queue_id, 420 | 440 | 1100)
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
    phase: String,
    since_ms: i64,
    lobby: Option<Lobby>,
    refresh_lobby: bool,
    queues: HashMap<i64, QueueInfo>,
    ranks: Ranks,
    ranks_at: Option<Instant>,
    icon: Option<i64>,
    companion: Option<(String, String)>,
    companion_at: Option<Instant>,
    /// champ select: (champion key, full skin id, locked)
    pick: Option<(i64, i64, bool)>,
    pick_champ: Option<Resolved>,
    riot_id: String,
    game: Option<Game>,
    game_up: bool,
    last_game: Option<Game>,
    placement: Option<u32>,
    eog_tries: u8,
}

impl State {
    fn new(ctx: &Ctx) -> State {
        State {
            lcu: None,
            game_api: util::http::loopback_agent(),
            champs: Champs::new(ctx.cache_dir()),
            phase: String::new(),
            since_ms: now_ms(),
            lobby: None,
            refresh_lobby: true,
            queues: HashMap::new(),
            ranks: Ranks::default(),
            ranks_at: None,
            icon: None,
            companion: None,
            companion_at: None,
            pick: None,
            pick_champ: None,
            riot_id: String::new(),
            game: None,
            game_up: false,
            last_game: None,
            placement: None,
            eog_tries: 0,
        }
    }

    /// One poll of the client and, in a game, the game. True when either answered.
    fn tick(&mut self, target: &Target, o: Opts) -> bool {
        if self.lcu.is_none() {
            self.lcu = lcu::discover(target);
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
        // without a client the game api answering is the only signal
        if in_game || self.lcu.is_none() {
            self.game_up = self.game_tick(o);
            answered |= self.game_up;
        } else {
            self.game_up = false;
        }
        answered
    }

    fn set_phase(&mut self, p: String) {
        if p == self.phase {
            return;
        }
        match p.as_str() {
            "None" | "Lobby" | "Matchmaking" | "CheckedIntoTournament" => {
                self.game = None;
                self.last_game = None;
                self.pick = None;
                self.pick_champ = None;
                self.placement = None;
                self.eog_tries = 0;
                self.riot_id.clear();
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
            if let Some(mut lobby) = lobby {
                if lobby.fixed_name.is_none()
                    && lobby.queue_id > 0
                    && !self.queues.contains_key(&lobby.queue_id)
                {
                    if let Some(q) = l.get::<QueueInfo>(&lcu::queue_path(lobby.queue_id))? {
                        self.queues.insert(lobby.queue_id, q);
                    }
                }
                // the metadata path has no mode or map, the queue does
                if let Some(q) = self.queues.get(&lobby.queue_id) {
                    if lobby.game_mode.is_empty() {
                        lobby.game_mode = q.game_mode.clone();
                    }
                    if lobby.map_id == 0 {
                        lobby.map_id = q.map_id;
                    }
                }
                self.lobby = Some(lobby);
            }
        }

        if o.rank && !in_game && self.ranks_at.is_none_or(|t| t.elapsed() > RANK_EVERY) {
            if let Some(r) = l.get::<lcu::RankedResp>(lcu::RANKED)? {
                self.ranks = Ranks::from_resp(&r);
                self.ranks_at = Some(Instant::now());
            }
        }

        if self.icon.is_none() && !in_game {
            self.icon = l
                .get::<lcu::Summoner>(lcu::SUMMONER)?
                .map(|s| s.profile_icon_id)
                .filter(|id| *id > 0);
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

        let post_game = matches!(
            phase.as_str(),
            "WaitingForStats" | "PreEndOfGame" | "EndOfGame"
        );
        let tft_ended = self.last_game.as_ref().is_some_and(|g| g.mode == "TFT");
        if post_game && tft_ended && self.placement.is_none() && self.eog_tries < EOG_TRIES {
            self.eog_tries += 1;
            self.placement = l
                .get::<lcu::TftEog>(lcu::TFT_EOG)?
                .map(|e| e.local_player.ffa_standing)
                .filter(|p| (1..=8).contains(p));
        }
        Ok(())
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
    fn game_tick(&mut self, o: Opts) -> bool {
        let Some(gs) = live::get::<live::GameStats>(&self.game_api, "gamestats") else {
            return false;
        };
        let watching = self.phase == "Watching";
        let no_client = self.lcu.is_none();
        let g = self.game.get_or_insert_with(Game::default);
        g.mode = gs.game_mode;
        g.map = gs.map_number;
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

        if self.riot_id.is_empty() && !watching {
            if let Some(ap) = live::get::<live::ActivePlayer>(&self.game_api, "activeplayer") {
                self.riot_id = ap.id().to_string();
                // spectator mode answers with an error object instead of a player
                g.spectating = no_client && self.riot_id.is_empty();
            }
        }
        if watching {
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
        true
    }

    fn scene(&self) -> Option<Scene> {
        let s = match self.phase.as_str() {
            // no client: only the game api
            "" => Scene::Game(self.game.clone().filter(|_| self.game_up)?),
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
                placement: self.placement,
            },
            _ => Scene::Client,
        };
        Some(s)
    }

    fn card(&self, o: Opts) -> Card {
        let lobby = self.lobby.as_ref();
        let mode = self
            .game
            .as_ref()
            .or(self.last_game.as_ref())
            .map(|g| g.mode.clone())
            .filter(|m| !m.is_empty())
            .or_else(|| lobby.map(|l| l.game_mode.clone()))
            .unwrap_or_default();
        let queue = queue_name(
            lobby,
            lobby.and_then(|l| self.queues.get(&l.queue_id)),
            &mode,
        );
        let rank = if o.rank {
            lobby
                .and_then(|l| self.ranks.for_queue(l.queue_id))
                .map(str::to_string)
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
            ranked: lobby.is_some_and(|l| !custom && is_ranked_queue(l.queue_id)),
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

fn build(scene: &Scene, c: &Card, o: Opts) -> Option<Live> {
    let mut live = Live::default();
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
            live.details = clamp(mode_name(&g.mode)).or_else(|| clamp(&c.queue));
            live.state = clamp("Spectating");
            live.start_ms = g.start_ms;
            live.large_image = Some(match &g.champ {
                Some(ch) => champs::tile_url(&ch.alias, ch.skin_num),
                None => champs::map_icon_url(g.map),
            });
            live.large_text = clamp("Spectating");
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
            if o.stats {
                live.state = g.stats.as_ref().and_then(|s| clamp(stats_line(s)));
            }
            live.start_ms = g.start_ms;
            match &g.champ {
                Some(ch) => {
                    live.large_image = Some(champs::tile_url(&ch.alias, ch.skin_num));
                    live.large_text = clamp(with_rank(&ch.skin_name, c.rank.as_deref()));
                }
                None => live.large_text = c.rank.as_deref().and_then(clamp),
            }
        }
        Scene::PostGame { game, placement } => {
            if !o.in_client {
                return None;
            }
            match game {
                Some(g) if g.mode == "TFT" => {
                    live.details = clamp(&c.queue);
                    live.state = clamp(match placement {
                        Some(p) => format!("Game over · Placed {}", ordinal(*p)),
                        None => "Game over".to_string(),
                    });
                    if let Some((url, name)) = &c.companion {
                        live.large_image = Some(url.clone());
                        live.large_text = clamp(name);
                    }
                }
                Some(g) if !g.spectating => {
                    live.details = champ_details(&c.queue, g.champ.as_ref());
                    let stats = g.stats.as_ref().filter(|_| o.stats).map(stats_line);
                    live.state = clamp(match stats {
                        Some(s) => format!("Game over · {s}"),
                        None => "Game over".to_string(),
                    });
                    if let Some(ch) = &g.champ {
                        live.large_image = Some(champs::tile_url(&ch.alias, ch.skin_num));
                        live.large_text = clamp(&ch.skin_name);
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
        stats: true,
        in_client: true,
    };

    fn chogath() -> Resolved {
        Resolved {
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
            ..Card::default()
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
            Some("Battlecast Prime Cho'Gath · Gold IV: 57 LP")
        );
        assert_eq!(l.start_ms, Some(42));

        let l = build(
            &Scene::Game(g),
            &card(),
            Opts {
                rank: false,
                stats: false,
                in_client: true,
            },
        )
        .unwrap();
        assert_eq!(l.state, None);
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
                placement: Some(3),
            },
            &c,
            ON,
        )
        .unwrap();
        assert_eq!(l.state.as_deref(), Some("Game over · Placed 3rd"));
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
                placement: None
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
            Some("Immortalized Legend Ahri · Gold II: 64 LP")
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
            &Settings::new(&MANIFEST, serde_json::json!({ "show_rank": false })),
            "game",
        )
        .live;
        assert_eq!(
            no_rank.large_text.as_deref(),
            Some("Immortalized Legend Ahri")
        );
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
    }

    #[test]
    fn only_ranked_matches_compete() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        for key in ["pick", "locked", "loading", "game", "tft"] {
            assert!(preview(&s, key).live.competing, "{key}");
        }
        for key in ["client", "lobby", "queue", "arena", "post", "spectate"] {
            assert!(!preview(&s, key).live.competing, "{key}");
        }
        let mut c = card();
        c.ranked = false;
        let g = Game {
            mode: "ARAM".into(),
            ..Game::default()
        };
        assert!(!build(&Scene::Game(g), &c, ON).unwrap().competing);
        assert!(!is_ranked_queue(450) && !is_ranked_queue(1700) && is_ranked_queue(440));
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
        let l = build(&Scene::Game(g), &card(), ON).unwrap();
        assert_eq!(l.details.as_deref(), Some("Howling Abyss (ARAM)"));
        assert_eq!(l.state.as_deref(), Some("Spectating"));
        assert!(l.large_image.unwrap().contains("/aram/"));
    }
}
