//! Live Client Data api on https://127.0.0.1:2999, no auth, game process only.
//! Field names from Irelia's in_game/types.rs, polling pattern from
//! league-rpc's internal/livegame/poller.go.

use serde::de::DeserializeOwned;
use serde::Deserialize;

const BASE: &str = "https://127.0.0.1:2999/liveclientdata";

pub fn get<T: DeserializeOwned>(agent: &ureq::Agent, path: &str) -> Option<T> {
    crate::util::http::get_json(agent, &format!("{BASE}/{path}"))
}

/// In spectator mode this is `{"error": ...}`, which parses as all defaults.
#[derive(Deserialize, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct ActivePlayer {
    pub riot_id: String,
    /// pre Riot ID clients
    pub summoner_name: String,
    pub level: u32,
}

impl ActivePlayer {
    pub fn id(&self) -> &str {
        if self.riot_id.is_empty() {
            &self.summoner_name
        } else {
            &self.riot_id
        }
    }
}

#[derive(Deserialize, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct AllGameData {
    pub active_player: ActivePlayer,
    pub all_players: Vec<Player>,
    pub game_data: GameStats,
}

#[derive(Deserialize, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Player {
    pub riot_id: String,
    pub summoner_name: String,
    pub champion_name: String,
    pub raw_champion_name: String,
    pub raw_skin_name: String,
    #[serde(rename = "skinID")]
    pub skin_id: i64,
}

impl AllGameData {
    pub fn find(&self, id: &str) -> Option<&Player> {
        if id.is_empty() {
            return None;
        }
        self.all_players
            .iter()
            .find(|p| p.riot_id == id || (p.riot_id.is_empty() && p.summoner_name == id))
    }
}

/// /gamestats, also `gameData` inside /allgamedata
#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct GameStats {
    pub game_mode: String,
    /// seconds since the game clock started
    pub game_time: f64,
    pub map_number: i64,
}

#[derive(Deserialize, Default, Debug, Clone, Copy, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Scores {
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub creep_score: u32,
}

pub fn scores_path(riot_id: &str) -> String {
    format!("playerscores?riotId={}", query_escape(riot_id))
}

/// Go's url.QueryEscape, which league-rpc uses on the "name#tag" riot id
pub fn query_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_allgamedata() {
        let d: AllGameData = serde_json::from_str(
            r#"{"activePlayer":{"riotId":"Haze#EUW","level":9,"currentGold":512.5,"abilities":{}},
                "allPlayers":[
                  {"riotId":"Other#1","championName":"Ahri","rawChampionName":"game_character_displayname_Ahri","skinID":0},
                  {"riotId":"Haze#EUW","championName":"Cho'Gath","rawChampionName":"game_character_displayname_Chogath",
                   "rawSkinName":"game_character_skin_displayname_Chogath_5","skinID":8,"scores":{"kills":3}}],
                "events":{"Events":[]},
                "gameData":{"gameMode":"CLASSIC","gameTime":613.4,"mapName":"Map11","mapNumber":11,"mapTerrain":"Default"}}"#,
        )
        .unwrap();
        let me = d.find(d.active_player.id()).unwrap();
        assert_eq!(me.champion_name, "Cho'Gath");
        assert_eq!(me.skin_id, 8);
        assert_eq!(d.game_data.map_number, 11);
        assert_eq!(d.active_player.level, 9);
    }

    #[test]
    fn spectator_active_player() {
        let d: AllGameData = serde_json::from_str(
            r#"{"activePlayer":{"error":"This feature is not supported in spectator mode"},"allPlayers":[],"gameData":{"gameMode":"ARAM","gameTime":5}}"#,
        )
        .unwrap();
        assert_eq!(d.active_player.id(), "");
        assert!(d.find("").is_none());
    }

    #[test]
    fn escapes_riot_id() {
        assert_eq!(
            scores_path("Haze Two#EUW"),
            "playerscores?riotId=Haze+Two%23EUW"
        );
        assert_eq!(query_escape("\u{c4}"), "%C3%84");
    }
}
