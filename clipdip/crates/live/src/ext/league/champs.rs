//! Champion and skin lookup, league-rpc's internal/championdata. Data comes
//! from CommunityDragon instead of Data Dragon + Meraki: its champion summary
//! maps numeric keys to Data Dragon ids, and one champion file carries skins
//! and chromas (chroma names like "Battlecast Prime Cho'Gath (Ruby)") at
//! ~35 KB instead of Meraki's multi-MB dump. Both cached on disk.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::store::Store;

const CDRAGON_DATA: &str =
    "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1";
const DDRAGON_TILES: &str = "https://ddragon.leagueoflegends.com/cdn/img/champion/tiles";
// raw host directly: the github.com blob link is two redirects before the file
const GITHUB_ASSETS: &str = "https://raw.githubusercontent.com/Its-Haze/league-assets/master";
const CDRAGON_ASSETS: &str =
    "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default";

/// a patch every two weeks, a new champion or skin shows up as a miss and refetches
const SUMMARY_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
const CHAMPION_MAX_AGE: Duration = Duration::from_secs(3 * 24 * 3600);

#[derive(Deserialize, Clone)]
#[serde(default)]
struct Summary {
    id: i64,
    name: String,
    alias: String,
}

impl Default for Summary {
    fn default() -> Self {
        Summary {
            id: -1,
            name: String::new(),
            alias: String::new(),
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Champion {
    skins: Vec<Skin>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Skin {
    id: i64,
    name: String,
    is_base: bool,
    chromas: Vec<Chroma>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Chroma {
    id: i64,
    name: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    /// numeric champion id, 31; 0 when CommunityDragon was out of reach
    pub key: i64,
    /// Data Dragon id, "Chogath"
    pub alias: String,
    /// "Cho'Gath"
    pub name: String,
    /// base skin num for the tile, a chroma maps to its skin
    pub skin_num: i64,
    /// skin or chroma name, the champion name for the default skin
    pub skin_name: String,
}

pub struct Champs {
    store: Store,
    summary: Option<Vec<Summary>>,
    summary_refetched: bool,
    champions: HashMap<i64, Champion>,
}

impl Champs {
    pub fn new(dir: Option<PathBuf>) -> Champs {
        Champs {
            store: Store::new(dir),
            summary: None,
            summary_refetched: false,
            champions: HashMap::new(),
        }
    }

    /// From Live Client Data's rawChampionName / rawSkinName / skinID.
    pub fn by_raw(
        &mut self,
        raw_champion: &str,
        raw_skin: &str,
        skin_id: i64,
        display: &str,
    ) -> Option<Resolved> {
        let candidates = candidate_names(raw_champion, raw_skin);
        if candidates.is_empty() {
            return None;
        }
        let found = self.find(|s| candidates.iter().any(|c| s.alias.eq_ignore_ascii_case(c)));
        let Some(s) = found else {
            if self.summary.is_some() {
                // loading screen placeholders, retried next tick like the original
                return None;
            }
            // no CommunityDragon: the raw name is the Data Dragon id already, base skin only
            let alias = candidates.into_iter().next()?;
            let name = if display.is_empty() {
                alias.clone()
            } else {
                display.to_string()
            };
            return Some(Resolved {
                key: 0,
                alias,
                skin_name: name.clone(),
                name,
                skin_num: 0,
            });
        };
        Some(self.resolve_skin(&s, skin_id))
    }

    /// From champ select's championId and selectedSkinId (full id, 103015).
    pub fn by_key(&mut self, key: i64, full_skin_id: i64) -> Option<Resolved> {
        let s = self.find(|s| s.id == key)?;
        let num = if full_skin_id / 1000 == key {
            full_skin_id % 1000
        } else {
            0
        };
        Some(self.resolve_skin(&s, num))
    }

    fn find(&mut self, pred: impl Fn(&Summary) -> bool) -> Option<Summary> {
        if self.summary.is_none() {
            self.summary = self.load("champion-summary.json", SUMMARY_MAX_AGE);
        }
        if let Some(s) = self
            .summary
            .as_ref()
            .and_then(|l| l.iter().find(|s| s.id > 0 && pred(s)))
        {
            return Some(s.clone());
        }
        // new champion on patch day: one forced refresh per session
        if self.summary.is_none() || self.summary_refetched {
            return None;
        }
        self.summary_refetched = true;
        let fresh: Vec<Summary> = self.fetch("champion-summary.json")?;
        self.summary = Some(fresh);
        self.summary
            .as_ref()?
            .iter()
            .find(|s| s.id > 0 && pred(s))
            .cloned()
    }

    fn resolve_skin(&mut self, s: &Summary, num: i64) -> Resolved {
        let file = format!("champions/{}.json", s.id);
        if !self.champions.contains_key(&s.id) {
            let cached = format!("champion-{}.json", s.id);
            let champ = self
                .load_cached::<Champion>(&cached, CHAMPION_MAX_AGE)
                .filter(|c| has_skin(c, s.id, num))
                .or_else(|| self.fetch_to(&file, &cached));
            if let Some(c) = champ {
                self.champions.insert(s.id, c);
            }
        }
        let (skin_num, skin_name) = match self.champions.get(&s.id) {
            Some(c) => pick_skin(c, s.id, num, &s.name),
            None => (0, s.name.clone()),
        };
        Resolved {
            key: s.id,
            alias: s.alias.clone(),
            name: s.name.clone(),
            skin_num,
            skin_name,
        }
    }

    fn load(&mut self, name: &str, max_age: Duration) -> Option<Vec<Summary>> {
        self.load_cached(name, max_age).or_else(|| self.fetch(name))
    }

    fn fetch<T: DeserializeOwned>(&mut self, name: &str) -> Option<T> {
        self.fetch_to(name, name)
    }

    fn fetch_to<T: DeserializeOwned>(&mut self, remote: &str, cached: &str) -> Option<T> {
        self.store.fetch(&format!("{CDRAGON_DATA}/{remote}"), cached)
    }

    fn load_cached<T: DeserializeOwned>(&self, name: &str, max_age: Duration) -> Option<T> {
        self.store.cached(name, max_age)
    }
}

fn has_skin(c: &Champion, key: i64, num: i64) -> bool {
    let full = key * 1000 + num;
    c.skins
        .iter()
        .any(|s| s.id == full || s.chromas.iter().any(|ch| ch.id == full))
}

/// league-rpc's resolveSkin: exact skin, else the chroma's parent skin, else
/// the closest base skin below the id, else the default skin.
fn pick_skin(c: &Champion, key: i64, num: i64, champ_name: &str) -> (i64, String) {
    let full = key * 1000 + num;
    let name_of = |s: &Skin| {
        if s.is_base || s.name.is_empty() {
            champ_name.to_string()
        } else {
            s.name.clone()
        }
    };
    if let Some(s) = c.skins.iter().find(|s| s.id == full) {
        return (num, name_of(s));
    }
    for s in &c.skins {
        if let Some(ch) = s.chromas.iter().find(|ch| ch.id == full) {
            let name = if ch.name.contains('(') || ch.name.is_empty() {
                if ch.name.is_empty() {
                    name_of(s)
                } else {
                    ch.name.clone()
                }
            } else {
                format!("{} ({})", name_of(s), ch.name)
            };
            return (s.id % 1000, name);
        }
    }
    let best = c
        .skins
        .iter()
        .filter(|s| s.id / 1000 == key && s.id % 1000 <= num)
        .max_by_key(|s| s.id);
    match best {
        Some(s) => (s.id % 1000, name_of(s)),
        None => (0, champ_name.to_string()),
    }
}

/// league-rpc's candidateNames: last part of rawChampionName, then the last
/// and second to last part of rawSkinName, minus loading screen placeholders.
pub fn candidate_names(raw_champion: &str, raw_skin: &str) -> Vec<String> {
    let seg = |s: &str, n: usize| -> Option<String> {
        if s.is_empty() {
            return None;
        }
        let parts: Vec<&str> = s.split('_').collect();
        parts
            .len()
            .checked_sub(n)
            .and_then(|i| parts.get(i))
            .map(|p| p.to_string())
    };
    [seg(raw_champion, 1), seg(raw_skin, 1), seg(raw_skin, 2)]
        .into_iter()
        .flatten()
        .filter(|c| !matches!(c.as_str(), "" | "Name" | "Unknown"))
        .collect()
}

/// Ultimate skins league-rpc shows animated, from its league-assets repo.
const ANIMATED: &[&str] = &[
    "Ahri_86",
    "Ezreal_5",
    "Jinx_60",
    "Kaisa_71",
    "Lux_7",
    "MissFortune_16",
    "Mordekaiser_54",
    "Morgana_80",
    "Samira_30",
    "Seraphine_1",
    "Seraphine_2",
    "Seraphine_3",
    "Sett_66",
    "Sona_6",
    "Udyr_3",
];

pub fn tile_url(alias: &str, skin_num: i64) -> String {
    let key = format!("{alias}_{skin_num}");
    if ANIMATED.contains(&key.as_str()) {
        return format!("{GITHUB_ASSETS}/animated_skins/{key}.gif");
    }
    format!("{DDRAGON_TILES}/{key}.jpg")
}

pub fn profile_icon_url(id: i64) -> String {
    format!("{CDRAGON_DATA}/profile-icons/{id}.jpg")
}

/// loadoutsIcon is "ASSETS/Loadouts/Companions/..."; CommunityDragon serves it lowercased
pub fn companion_url(loadouts_icon: &str) -> Option<String> {
    let (_, rest) = loadouts_icon.split_once("ASSETS/")?;
    if rest.is_empty() {
        return None;
    }
    Some(format!("{CDRAGON_ASSETS}/assets/{}", rest.to_lowercase()))
}

pub fn map_icon_url(map_id: i64) -> String {
    let name = match map_id {
        12 => "aram",
        22 => "tft",
        30 => "cherry",
        33 => "strawberry",
        35 => "brawl",
        _ => "classic_sru",
    };
    format!("{CDRAGON_ASSETS}/content/src/leagueclient/gamemodeassets/{name}/img/game-select-icon-hover.png")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chogath() -> Champion {
        serde_json::from_str(
            r#"{"skins":[
                {"id":31000,"name":"Cho'Gath","isBase":true,"chromas":[]},
                {"id":31001,"name":"Nightmare Cho'Gath","isBase":false},
                {"id":31005,"name":"Battlecast Prime Cho'Gath","isBase":false,"chromas":[
                    {"id":31008,"name":"Battlecast Prime Cho'Gath (Ruby)"}]},
                {"id":31014,"name":"Broken Covenant Cho'Gath","isBase":false}
            ]}"#,
        )
        .unwrap()
    }

    #[test]
    fn skins_and_chromas() {
        let c = chogath();
        assert_eq!(pick_skin(&c, 31, 0, "Cho'Gath"), (0, "Cho'Gath".into()));
        assert_eq!(
            pick_skin(&c, 31, 1, "Cho'Gath"),
            (1, "Nightmare Cho'Gath".into())
        );
        assert_eq!(
            pick_skin(&c, 31, 8, "Cho'Gath"),
            (5, "Battlecast Prime Cho'Gath (Ruby)".into())
        );
        // unknown id falls back to the closest skin below it
        assert_eq!(
            pick_skin(&c, 31, 12, "Cho'Gath"),
            (5, "Battlecast Prime Cho'Gath".into())
        );
        assert!(has_skin(&c, 31, 8));
        assert!(!has_skin(&c, 31, 40));
    }

    #[test]
    fn raw_names() {
        assert_eq!(
            candidate_names(
                "game_character_displayname_Chogath",
                "game_character_skin_displayname_Chogath_5"
            ),
            vec!["Chogath", "5", "Chogath"]
        );
        assert!(candidate_names("Name", "").is_empty());
        assert_eq!(candidate_names("", "MonkeyKing"), vec!["MonkeyKing"]);
    }

    #[test]
    fn urls() {
        assert_eq!(
            tile_url("Chogath", 5),
            "https://ddragon.leagueoflegends.com/cdn/img/champion/tiles/Chogath_5.jpg"
        );
        assert!(tile_url("Ahri", 86).ends_with("animated_skins/Ahri_86.gif"));
        assert_eq!(
            companion_url("ASSETS/Loadouts/Companions/Tooltip_Chibi_Ahri.png").unwrap(),
            "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/loadouts/companions/tooltip_chibi_ahri.png"
        );
        assert!(companion_url("broken").is_none());
        assert!(map_icon_url(12).contains("/aram/"));
    }
}
