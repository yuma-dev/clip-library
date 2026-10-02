//! League client (LCU) api: finding it, the few GETs the card needs, and the
//! queue/rank rules from league-rpc's internal/lcu.

use std::path::{Path, PathBuf};

use serde::de::{DeserializeOwned, IgnoredAny};
use serde::Deserialize;

use crate::util::{self, riot::Lockfile};
use crate::Target;

pub struct Lcu {
    base: String,
    auth: String,
    agent: ureq::Agent,
}

/// The client stopped answering (closed, restarted on a new port).
pub struct Down;

impl Lcu {
    fn new(port: u16, password: &str) -> Lcu {
        Lcu {
            base: format!("https://127.0.0.1:{port}"),
            auth: util::http::basic_auth("riot", password),
            agent: util::http::loopback_agent(),
        }
    }

    /// Ok(None) on a 4xx/5xx or a body that doesn't parse (no lobby, no
    /// champ select), Err only when the client itself is gone.
    pub fn get<T: DeserializeOwned>(&self, path: &str) -> Result<Option<T>, Down> {
        match self
            .agent
            .get(&format!("{}{path}", self.base))
            .set("Authorization", &self.auth)
            .call()
        {
            Ok(r) => Ok(r.into_json().ok()),
            Err(ureq::Error::Status(..)) => Ok(None),
            Err(ureq::Error::Transport(_)) => Err(Down),
        }
    }
}

/// Lockfile next to LeagueClientUx.exe first, then the client's own command
/// line when the session's pid is the client (Irelia's pull_client_info).
pub fn discover(t: &Target) -> Option<Lcu> {
    for dir in install_dirs(t.exe.as_deref()) {
        if let Some(l) = Lockfile::read(&dir.join("lockfile")) {
            return Some(Lcu::new(l.port, &l.password));
        }
    }
    if util::exe_name(t) == "leagueclientux.exe" {
        let cmd = util::process::command_line(t.pid)?;
        let (port, token) = from_command_line(&cmd)?;
        return Some(Lcu::new(port, &token));
    }
    None
}

/// Where the lockfile can be: `<install>\Game\League of Legends.exe` walks up
/// twice, the client exes once (Irelia's read_lock_file), then the default.
pub fn install_dirs(exe: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(exe) = exe {
        let name = exe
            .file_name()
            .map(|f| f.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let dir = exe.parent();
        let dir = if name == "league of legends.exe" {
            dir.and_then(Path::parent)
        } else {
            dir
        };
        if let Some(d) = dir {
            out.push(d.to_path_buf());
        }
    }
    let default = PathBuf::from(r"C:\Riot Games\League of Legends");
    if !out.contains(&default) {
        out.push(default);
    }
    out
}

pub fn from_command_line(cmd: &str) -> Option<(u16, String)> {
    let args = util::process::split_args(cmd);
    let port = util::process::arg_value(&args, "--app-port")?
        .parse()
        .ok()?;
    let token = util::process::arg_value(&args, "--remoting-auth-token")?;
    if token.is_empty() {
        return None;
    }
    Some((port, token.to_string()))
}

pub const PHASE: &str = "/lol-gameflow/v1/gameflow-phase";
pub const LOBBY: &str = "/lol-lobby/v2/lobby";
pub const PLAYER_STATUS: &str = "/lol-gameflow/v1/gameflow-metadata/player-status";
pub const RANKED: &str = "/lol-ranked/v1/current-ranked-stats";
pub const SUMMONER: &str = "/lol-summoner/v1/current-summoner";
pub const TFT_COMPANION: &str = "/lol-cosmetics/v1/inventories/tft/companions";
pub const CHAMP_SELECT: &str = "/lol-champ-select/v1/session";
pub const TFT_EOG: &str = "/lol-end-of-game/v1/tft-eog-stats";
pub const SESSION: &str = "/lol-gameflow/v1/session";
pub const LOCALE: &str = "/riotclient/region-locale";
/// has the game id right away, the match list can lag minutes behind
pub const EOG: &str = "/lol-end-of-game/v1/eog-stats-block";
/// the game's own end-of-game block, also served during InProgress
pub const GAMECLIENT_EOG: &str = "/lol-end-of-game/v1/gameclient-eog-stats-block";
pub const MASTERY: &str = "/lol-champion-mastery/v1/local-player/champion-mastery";

pub fn match_path(game_id: i64) -> String {
    format!("/lol-match-history/v1/games/{game_id}")
}

pub fn queue_path(id: i64) -> String {
    format!("/lol-game-queues/v1/queues/{id}")
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LobbyResp {
    pub game_config: GameConfig,
    // only the count is used, the entries carry summoner names
    pub members: Vec<IgnoredAny>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GameConfig {
    pub queue_id: i64,
    pub game_mode: String,
    pub map_id: i64,
    pub is_custom: bool,
    pub max_lobby_size: u32,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PlayerStatus {
    pub current_lobby_status: Option<LobbyStatus>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LobbyStatus {
    pub queue_id: i64,
    pub is_custom: bool,
    pub is_practice_tool: bool,
    // element type changed across client versions, only the length matters
    pub member_summoner_ids: Vec<IgnoredAny>,
}

#[derive(Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct QueueInfo {
    pub name: String,
    pub detailed_description: String,
    pub game_mode: String,
    pub map_id: i64,
    pub is_ranked: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct RankedResp {
    pub queues: Vec<RankedQueue>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct RankedQueue {
    pub queue_type: String,
    pub tier: String,
    pub division: String,
    pub league_points: i64,
    pub rated_tier: String,
    pub rated_rating: i64,
    pub wins: u32,
    pub losses: u32,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Summoner {
    pub profile_icon_id: i64,
    pub puuid: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Session {
    pub game_data: SessionGame,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionGame {
    pub game_id: i64,
    pub queue: SessionQueue,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct SessionQueue {
    pub id: i64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct RegionLocale {
    pub locale: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct EogBlock {
    pub game_id: i64,
}

/// Field names from wnzzer/rank-analysis's models; the player's PUUID key is capitalized there.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GameclientEog {
    pub game_id: i64,
    pub stats_block: GameclientBlock,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GameclientBlock {
    pub game_id: i64,
    pub players: Vec<GameclientPlayer>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GameclientPlayer {
    #[serde(rename = "PUUID", alias = "puuid")]
    pub puuid: String,
    pub subteam_standing: u32,
}

impl GameclientEog {
    /// Arena standing of our duo, only when the block is about this game: the client keeps the
    /// last game's block around
    pub fn standing(&self, game_id: i64, puuid: &str) -> Option<u32> {
        let id = if self.game_id > 0 { self.game_id } else { self.stats_block.game_id };
        if game_id <= 0 || id != game_id || puuid.is_empty() {
            return None;
        }
        self.stats_block
            .players
            .iter()
            .find(|p| p.puuid == puuid)
            .map(|p| p.subteam_standing)
            .filter(|s| (1..=8).contains(s))
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Mastery {
    pub champion_id: i64,
    pub champion_level: u32,
}

/// /lol-match-history/v1/games/{id}, LCU shape (MayhemStatsTracker's extractParticipants reads
/// the same fields)
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Match {
    pub game_id: i64,
    pub participants: Vec<Participant>,
    pub participant_identities: Vec<Identity>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Participant {
    pub participant_id: i64,
    pub puuid: String,
    pub stats: MatchStats,
}

#[derive(Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct MatchStats {
    pub win: bool,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub total_minions_killed: u32,
    pub neutral_minions_killed: u32,
    pub champ_level: u32,
    /// Arena 1..=8, 0 elsewhere
    pub subteam_placement: u32,
    pub player_augment1: i64,
    pub player_augment2: i64,
    pub player_augment3: i64,
    pub player_augment4: i64,
    pub player_augment5: i64,
    pub player_augment6: i64,
}

impl MatchStats {
    pub fn augment_ids(&self) -> Vec<i64> {
        [
            self.player_augment1,
            self.player_augment2,
            self.player_augment3,
            self.player_augment4,
            self.player_augment5,
            self.player_augment6,
        ]
        .into_iter()
        .filter(|id| *id > 0)
        .collect()
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Identity {
    pub participant_id: i64,
    pub player: IdentityPlayer,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct IdentityPlayer {
    pub puuid: String,
}

impl Match {
    pub fn mine(&self, puuid: &str) -> Option<&MatchStats> {
        if puuid.is_empty() {
            return None;
        }
        let id = self
            .participant_identities
            .iter()
            .find(|i| i.player.puuid == puuid)
            .map(|i| i.participant_id);
        self.participants
            .iter()
            .find(|p| p.puuid == puuid || (id.is_some() && Some(p.participant_id) == id))
            .map(|p| &p.stats)
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CompanionResp {
    pub selected_loadout_item: Option<LoadoutItem>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LoadoutItem {
    pub loadouts_icon: String,
    pub name: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ChampSelect {
    pub local_player_cell_id: i64,
    pub my_team: Vec<CellPlayer>,
    pub actions: Vec<Vec<Action>>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CellPlayer {
    pub cell_id: i64,
    pub champion_id: i64,
    pub champion_pick_intent: i64,
    pub selected_skin_id: i64,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Action {
    pub actor_cell_id: i64,
    pub champion_id: i64,
    pub completed: bool,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TftEog {
    pub local_player: TftEogPlayer,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TftEogPlayer {
    pub ffa_standing: u32,
}

/// What champ select shows for us: champion id, full skin id, locked in.
pub fn my_pick(cs: &ChampSelect) -> Option<(i64, i64, bool)> {
    let me = cs
        .my_team
        .iter()
        .find(|p| p.cell_id == cs.local_player_cell_id)?;
    let locked = cs.actions.iter().flatten().any(|a| {
        a.actor_cell_id == cs.local_player_cell_id
            && a.kind == "pick"
            && a.completed
            && a.champion_id > 0
    });
    let champ = if me.champion_id > 0 {
        me.champion_id
    } else {
        me.champion_pick_intent
    };
    if champ <= 0 {
        return None;
    }
    Some((champ, me.selected_skin_id, locked && me.champion_id > 0))
}

/// Lobby as the card needs it.
#[derive(Clone, Default, Debug, PartialEq)]
pub struct Lobby {
    pub queue_id: i64,
    pub game_mode: String,
    pub map_id: i64,
    pub players: u32,
    pub max_players: u32,
    pub custom: bool,
    pub practice: bool,
    /// set for custom/practice lobbies, the rest come from /lol-game-queues
    pub fixed_name: Option<&'static str>,
}

const CUSTOM_QUEUES: &[i64] = &[3100, 3110, 3120, 3130, 3140, 3200, 3210, 3220, 3230, 3270];
const ARAM_CUSTOM_QUEUES: &[i64] = &[3200, 3210, 3220, 3230, 3270];
const PRACTICE_TOOL_QUEUE: i64 = 3140;

/// league-rpc's updateLobbyState / customLobbyDefaults
pub fn lobby_from_config(cfg: &GameConfig, players: u32) -> Lobby {
    let practice = cfg.game_mode == "PRACTICETOOL";
    let mut l = Lobby {
        queue_id: cfg.queue_id,
        game_mode: cfg.game_mode.clone(),
        map_id: cfg.map_id,
        players,
        max_players: if practice { 1 } else { cfg.max_lobby_size },
        custom: cfg.is_custom,
        practice,
        fixed_name: None,
    };
    apply_custom(&mut l);
    l
}

pub fn lobby_from_status(s: &LobbyStatus) -> Lobby {
    let mut l = Lobby {
        queue_id: s.queue_id,
        players: s.member_summoner_ids.len() as u32,
        custom: s.is_custom,
        practice: s.is_practice_tool,
        ..Lobby::default()
    };
    if apply_custom(&mut l) {
        if l.practice {
            l.game_mode = "PRACTICETOOL".into();
            l.map_id = 11;
            l.max_players = 1;
        } else if ARAM_CUSTOM_QUEUES.contains(&l.queue_id) {
            l.game_mode = "ARAM".into();
            l.map_id = 12;
        } else {
            l.game_mode = "PRACTICETOOL".into();
            l.map_id = 11;
        }
    }
    l
}

fn apply_custom(l: &mut Lobby) -> bool {
    if !(CUSTOM_QUEUES.contains(&l.queue_id) || l.custom || l.practice) {
        return false;
    }
    if l.queue_id == PRACTICE_TOOL_QUEUE || l.practice {
        l.fixed_name = Some("Practice Tool");
        l.practice = true;
    } else if ARAM_CUSTOM_QUEUES.contains(&l.queue_id) {
        l.fixed_name = Some("Custom ARAM");
        l.custom = true;
    } else {
        l.fixed_name = Some("Custom Game");
        l.custom = true;
    }
    true
}

/// One queue's standing as the client reports it.
#[derive(Clone, Default, Debug, PartialEq)]
pub struct Rank {
    pub tier: String,
    pub division: String,
    pub lp: i64,
    pub wins: u32,
    pub losses: u32,
    /// Arena's (ratedTier, ratedRating) instead of a tier
    pub rated: Option<(String, i64)>,
}

impl Rank {
    fn from_queue(q: &RankedQueue) -> Rank {
        Rank {
            tier: q.tier.clone(),
            division: q.division.clone(),
            lp: q.league_points,
            wins: q.wins,
            losses: q.losses,
            rated: (!q.rated_tier.is_empty()).then(|| (q.rated_tier.clone(), q.rated_rating)),
        }
    }

    fn ranked(&self) -> bool {
        !(self.tier.is_empty() || self.tier == "NONE" || self.tier == "UNRANKED")
    }

    /// "Gold IV: 57 LP", plus "41W 37L" when `record`
    pub fn text(&self, record: bool) -> Option<String> {
        let base = match &self.rated {
            Some((tier, rating)) => arena_text(tier, *rating),
            None => rank_text(&self.tier, &self.division, self.lp),
        }?;
        if record && self.wins + self.losses > 0 {
            return Some(format!("{base} · {}W {}L", self.wins, self.losses));
        }
        Some(base)
    }

    /// tier and division as one number, higher is better
    fn score(&self) -> i64 {
        const TIERS: &[&str] = &[
            "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER",
            "GRANDMASTER", "CHALLENGER",
        ];
        const DIVS: &[&str] = &["IV", "III", "II", "I"];
        let t = TIERS.iter().position(|t| *t == self.tier).unwrap_or(0) as i64;
        let d = DIVS.iter().position(|d| *d == self.division).unwrap_or(3) as i64;
        t * 4 + d
    }
}

/// What a game did to the rank: "+21 LP", "Promoted to Gold I", "Placed in Silver II".
/// Nothing until the client counted the game, it updates a few seconds after the end.
pub fn rank_change(before: &Rank, after: &Rank) -> Option<String> {
    if after.wins + after.losses <= before.wins + before.losses {
        return None;
    }
    if let (Some((_, b)), Some((_, a))) = (&before.rated, &after.rated) {
        return Some(format!("{:+} rating", a - b));
    }
    if !after.ranked() {
        return None;
    }
    let name = |r: &Rank| {
        let div = if r.division.is_empty() || r.division == "NA" {
            String::new()
        } else {
            format!(" {}", r.division)
        };
        format!("{}{div}", capitalize(&r.tier))
    };
    if !before.ranked() {
        return Some(format!("Placed in {}", name(after)));
    }
    Some(match after.score().cmp(&before.score()) {
        std::cmp::Ordering::Greater => format!("Promoted to {}", name(after)),
        std::cmp::Ordering::Less => format!("Demoted to {}", name(after)),
        std::cmp::Ordering::Equal => format!("{:+} LP", after.lp - before.lp),
    })
}

#[derive(Clone, Default, Debug, PartialEq)]
pub struct Ranks {
    pub solo: Option<Rank>,
    pub flex: Option<Rank>,
    pub tft: Option<Rank>,
    pub double_up: Option<Rank>,
    pub arena: Option<Rank>,
}

impl Ranks {
    pub fn from_resp(r: &RankedResp) -> Ranks {
        let mut out = Ranks::default();
        for q in &r.queues {
            let slot = match q.queue_type.as_str() {
                "RANKED_SOLO_5x5" => &mut out.solo,
                "RANKED_FLEX_SR" => &mut out.flex,
                "RANKED_TFT" => &mut out.tft,
                "RANKED_TFT_DOUBLE_UP" => &mut out.double_up,
                "CHERRY" => &mut out.arena,
                _ => continue,
            };
            *slot = Some(Rank::from_queue(q));
        }
        out
    }

    /// league-rpc's getRankForQueue; 1090 normal TFT shows the ranked TFT rank as in the original
    pub fn for_queue(&self, queue_id: i64) -> Option<&Rank> {
        match queue_id {
            420 => self.solo.as_ref(),
            440 => self.flex.as_ref(),
            1090 | 1100 => self.tft.as_ref(),
            1160 => self.double_up.as_ref(),
            1700 | 1710 => self.arena.as_ref(),
            _ => None,
        }
    }

    pub fn text_for(&self, queue_id: i64, record: bool) -> Option<String> {
        self.for_queue(queue_id)?.text(record)
    }
}

/// "Gold IV: 57 LP", "Master: 812 LP"; unranked and NONE give nothing
pub fn rank_text(tier: &str, division: &str, lp: i64) -> Option<String> {
    if tier.is_empty() || tier == "NONE" || tier == "UNRANKED" {
        return None;
    }
    let div = if division.is_empty() || division == "NA" {
        String::new()
    } else {
        format!(" {division}")
    };
    Some(format!("{}{div}: {lp} LP", capitalize(tier)))
}

fn arena_text(rated_tier: &str, rating: i64) -> Option<String> {
    let tier = match rated_tier {
        "GRAY" => "Wood",
        "GREEN" => "Bronze",
        "BLUE" => "Silver",
        "PURPLE" => "Gold",
        "ORANGE" => "Gladiator",
        _ => return None,
    };
    Some(format!("{tier} · Rating: {rating}"))
}

fn capitalize(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut c = lower.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockfile_dirs_from_exe() {
        let d = install_dirs(Some(Path::new(
            r"D:\Games\League of Legends\Game\League of Legends.exe",
        )));
        assert_eq!(d[0], PathBuf::from(r"D:\Games\League of Legends"));
        let d = install_dirs(Some(Path::new(
            r"D:\Games\League of Legends\LeagueClientUx.exe",
        )));
        assert_eq!(d[0], PathBuf::from(r"D:\Games\League of Legends"));
        let d = install_dirs(None);
        assert_eq!(d, vec![PathBuf::from(r"C:\Riot Games\League of Legends")]);
    }

    #[test]
    fn client_command_line() {
        let cmd = r#""D:\Riot Games\League of Legends\LeagueClientUx.exe" "--riotclient-auth-token=abc" "--app-port=51234" "--remoting-auth-token=Zx9_y" "--install-directory=D:\Riot Games\League of Legends\""#;
        assert_eq!(from_command_line(cmd), Some((51234, "Zx9_y".to_string())));
        assert_eq!(from_command_line("LeagueClientUx.exe --app-port=1"), None);
    }

    #[test]
    fn ranks() {
        let r: RankedResp = serde_json::from_str(
            r#"{"queues":[
                {"queueType":"RANKED_SOLO_5x5","tier":"GOLD","division":"IV","leaguePoints":57,"wins":41,"losses":37},
                {"queueType":"RANKED_FLEX_SR","tier":"MASTER","division":"NA","leaguePoints":812},
                {"queueType":"RANKED_TFT","tier":"","division":"NA","leaguePoints":0},
                {"queueType":"CHERRY","ratedTier":"PURPLE","ratedRating":1234}
            ]}"#,
        )
        .unwrap();
        let r = Ranks::from_resp(&r);
        assert_eq!(r.text_for(420, false).as_deref(), Some("Gold IV: 57 LP"));
        assert_eq!(r.text_for(420, true).as_deref(), Some("Gold IV: 57 LP · 41W 37L"));
        assert_eq!(r.text_for(440, true).as_deref(), Some("Master: 812 LP"));
        assert_eq!(r.text_for(1100, false), None);
        assert_eq!(r.text_for(1710, false).as_deref(), Some("Gold · Rating: 1234"));
        assert_eq!(r.text_for(450, false), None);
    }

    #[test]
    fn rank_changes() {
        let r = |tier: &str, div: &str, lp: i64, games: u32| Rank {
            tier: tier.into(),
            division: div.into(),
            lp,
            wins: games,
            ..Rank::default()
        };
        assert_eq!(rank_change(&r("GOLD", "II", 40, 10), &r("GOLD", "II", 40, 10)), None);
        assert_eq!(
            rank_change(&r("GOLD", "II", 40, 10), &r("GOLD", "II", 61, 11)).as_deref(),
            Some("+21 LP")
        );
        assert_eq!(
            rank_change(&r("GOLD", "II", 10, 10), &r("GOLD", "II", 0, 11)).as_deref(),
            Some("-10 LP")
        );
        assert_eq!(
            rank_change(&r("GOLD", "II", 90, 10), &r("GOLD", "I", 5, 11)).as_deref(),
            Some("Promoted to Gold I")
        );
        assert_eq!(
            rank_change(&r("PLATINUM", "IV", 0, 10), &r("GOLD", "I", 75, 11)).as_deref(),
            Some("Demoted to Gold I")
        );
        assert_eq!(
            rank_change(&r("DIAMOND", "I", 95, 10), &r("MASTER", "I", 12, 11)).as_deref(),
            Some("Promoted to Master I")
        );
        assert_eq!(
            rank_change(&Rank::default(), &r("SILVER", "II", 0, 5)).as_deref(),
            Some("Placed in Silver II")
        );
        let arena = |rating: i64, games: u32| Rank {
            rated: Some(("PURPLE".into(), rating)),
            wins: games,
            ..Rank::default()
        };
        assert_eq!(rank_change(&arena(1200, 3), &arena(1235, 4)).as_deref(), Some("+35 rating"));
    }

    #[test]
    fn match_history_finds_me() {
        let m: Match = serde_json::from_str(
            r#"{"gameId":7,"participantIdentities":[
                {"participantId":1,"player":{"puuid":"a"}},{"participantId":2,"player":{"puuid":"me"}}],
              "participants":[
                {"participantId":1,"stats":{"win":false}},
                {"participantId":2,"stats":{"win":true,"kills":9,"subteamPlacement":2,
                  "playerAugment1":1205,"playerAugment2":0,"playerAugment3":93}}]}"#,
        )
        .unwrap();
        let me = m.mine("me").unwrap();
        assert!(me.win);
        assert_eq!(me.subteam_placement, 2);
        assert_eq!(me.augment_ids(), vec![1205, 93]);
        assert!(m.mine("").is_none());
        assert!(m.mine("nobody").is_none());
    }

    #[test]
    fn arena_standing_needs_this_game() {
        let e: GameclientEog = serde_json::from_str(
            r#"{"gameId":5,"statsBlock":{"players":[{"PUUID":"me","subteamStanding":3},{"PUUID":"x","subteamStanding":1}]}}"#,
        )
        .unwrap();
        assert_eq!(e.standing(5, "me"), Some(3));
        assert_eq!(e.standing(4, "me"), None);
        assert_eq!(e.standing(5, ""), None);
        let e: GameclientEog =
            serde_json::from_str(r#"{"statsBlock":{"players":[{"PUUID":"me","subteamStanding":3}]}}"#).unwrap();
        assert_eq!(e.standing(5, "me"), None);
    }

    #[test]
    fn custom_lobbies() {
        let cfg = GameConfig {
            queue_id: 3140,
            game_mode: "PRACTICETOOL".into(),
            map_id: 11,
            is_custom: true,
            max_lobby_size: 10,
        };
        let l = lobby_from_config(&cfg, 1);
        assert_eq!(l.fixed_name, Some("Practice Tool"));
        assert_eq!(l.max_players, 1);
        let s: PlayerStatus = serde_json::from_str(
            r#"{"currentLobbyStatus":{"queueId":3220,"isCustom":true,"memberSummonerIds":[1,2]}}"#,
        )
        .unwrap();
        let l = lobby_from_status(&s.current_lobby_status.unwrap());
        assert_eq!(l.fixed_name, Some("Custom ARAM"));
        assert_eq!(l.game_mode, "ARAM");
        assert_eq!(l.players, 2);
        let cfg = GameConfig {
            queue_id: 420,
            game_mode: "CLASSIC".into(),
            map_id: 11,
            is_custom: false,
            max_lobby_size: 2,
        };
        assert_eq!(lobby_from_config(&cfg, 1).fixed_name, None);
    }

    #[test]
    fn champ_select_pick() {
        let cs: ChampSelect = serde_json::from_str(
            r#"{"localPlayerCellId":2,"myTeam":[
                {"cellId":1,"championId":0,"championPickIntent":0,"selectedSkinId":0},
                {"cellId":2,"championId":0,"championPickIntent":103,"selectedSkinId":0}],
              "actions":[[{"actorCellId":2,"championId":0,"completed":false,"type":"pick"}]]}"#,
        )
        .unwrap();
        assert_eq!(my_pick(&cs), Some((103, 0, false)));
        let cs: ChampSelect = serde_json::from_str(
            r#"{"localPlayerCellId":2,"myTeam":[{"cellId":2,"championId":103,"selectedSkinId":103015}],
              "actions":[[{"actorCellId":2,"championId":103,"completed":true,"type":"pick"}]]}"#,
        )
        .unwrap();
        assert_eq!(my_pick(&cs), Some((103, 103015, true)));
        assert_eq!(my_pick(&ChampSelect::default()), None);
    }
}
