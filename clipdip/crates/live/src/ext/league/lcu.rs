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
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Summoner {
    pub profile_icon_id: i64,
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

#[derive(Clone, Default, Debug, PartialEq)]
pub struct Ranks {
    pub solo: Option<String>,
    pub flex: Option<String>,
    pub tft: Option<String>,
    pub arena: Option<String>,
}

impl Ranks {
    pub fn from_resp(r: &RankedResp) -> Ranks {
        let mut out = Ranks::default();
        for q in &r.queues {
            match q.queue_type.as_str() {
                "RANKED_SOLO_5x5" => out.solo = rank_text(&q.tier, &q.division, q.league_points),
                "RANKED_FLEX_SR" => out.flex = rank_text(&q.tier, &q.division, q.league_points),
                "RANKED_TFT" => out.tft = rank_text(&q.tier, &q.division, q.league_points),
                "CHERRY" => out.arena = arena_text(&q.rated_tier, q.rated_rating),
                _ => {}
            }
        }
        out
    }

    /// league-rpc's getRankForQueue; 1100 is ranked TFT, 1090 normal TFT as in the original
    pub fn for_queue(&self, queue_id: i64) -> Option<&str> {
        match queue_id {
            420 => self.solo.as_deref(),
            440 => self.flex.as_deref(),
            1090 | 1100 => self.tft.as_deref(),
            1700 => self.arena.as_deref(),
            _ => None,
        }
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
                {"queueType":"RANKED_SOLO_5x5","tier":"GOLD","division":"IV","leaguePoints":57},
                {"queueType":"RANKED_FLEX_SR","tier":"MASTER","division":"NA","leaguePoints":812},
                {"queueType":"RANKED_TFT","tier":"","division":"NA","leaguePoints":0},
                {"queueType":"CHERRY","ratedTier":"PURPLE","ratedRating":1234}
            ]}"#,
        )
        .unwrap();
        let r = Ranks::from_resp(&r);
        assert_eq!(r.for_queue(420), Some("Gold IV: 57 LP"));
        assert_eq!(r.for_queue(440), Some("Master: 812 LP"));
        assert_eq!(r.for_queue(1100), None);
        assert_eq!(r.for_queue(1700), Some("Gold · Rating: 1234"));
        assert_eq!(r.for_queue(450), None);
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
