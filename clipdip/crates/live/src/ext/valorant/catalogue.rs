//! Names and art from valorant-api.com, trimmed to what the card uses and
//! cached on disk. Agents and maps change on patch days, a day is plenty.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::util;

const BASE: &str = "https://valorant-api.com/v1";
const MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
/// after a failed fetch; a good one happens once per session at most
const RETRY_MS: i64 = 10 * 60 * 1000;
const FILE: &str = "catalogue.json";
/// "Unused1"/"Unused2" rows: no icon, nobody holds them
const INVALID_DIVISION: &str = "ECompetitiveDivision::INVALID";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Agent {
    /// developerName, the codename the game log uses
    pub dev: String,
    pub name: String,
    pub icon: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MapArt {
    /// Riot's map path, what the presence blob reports as matchMap
    pub url: String,
    pub name: String,
    pub splash: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Tier {
    pub tier: i64,
    pub name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Catalogue {
    pub fetched_ms: i64,
    pub agents: Vec<Agent>,
    pub maps: Vec<MapArt>,
    pub tiers: Vec<Tier>,
}

impl Catalogue {
    /// glz and valorant-api disagree on case, every join folds it
    pub fn agent(&self, codename: &str) -> Option<&Agent> {
        let k = codename.trim();
        self.agents
            .iter()
            .find(|a| !a.dev.is_empty() && a.dev.eq_ignore_ascii_case(k))
    }

    pub fn map(&self, url: &str) -> Option<&MapArt> {
        let k = url.trim();
        self.maps
            .iter()
            .find(|m| !m.url.is_empty() && m.url.eq_ignore_ascii_case(k))
    }

    pub fn tier(&self, tier: i64) -> Option<&Tier> {
        self.tiers.iter().find(|t| t.tier == tier)
    }

    fn is_empty(&self) -> bool {
        self.agents.is_empty() && self.maps.is_empty() && self.tiers.is_empty()
    }

    /// All three payloads have to parse, a half catalogue is never kept.
    pub fn parse(agents: &Value, maps: &Value, tiers: &Value, now: i64) -> Option<Catalogue> {
        let agents = agents.get("data")?.as_array()?;
        let maps = maps.get("data")?.as_array()?;
        let tables = tiers.get("data")?.as_array()?;
        let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        Some(Catalogue {
            fetched_ms: now,
            agents: agents
                .iter()
                .map(|a| Agent {
                    dev: s(a, "developerName"),
                    name: display_name(a.get("displayName")),
                    icon: s(a, "displayIcon"),
                })
                .filter(|a| !a.dev.is_empty() && !a.name.is_empty())
                .collect(),
            maps: maps
                .iter()
                .map(|m| MapArt {
                    url: s(m, "mapUrl"),
                    name: display_name(m.get("displayName")),
                    splash: s(m, "splash"),
                })
                .filter(|m| !m.url.is_empty())
                .collect(),
            // one table per episode, only the last is current
            tiers: tables
                .last()
                .and_then(|t| t.get("tiers"))
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter(|r| {
                            r.get("division").and_then(Value::as_str) != Some(INVALID_DIVISION)
                        })
                        .filter_map(|r| {
                            let tier = r.get("tier")?.as_i64()?;
                            let name = tier_display_name(&display_name(r.get("tierName")));
                            (!name.is_empty()).then_some(Tier { tier, name })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
}

/// a plain string under ?language=en-US, one per locale under ?language=all
fn display_name(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(m)) => m
            .get("en-US")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

/// "GOLD 2" into "Gold 2"; a name that already has lower case stays as is
pub fn tier_display_name(name: &str) -> String {
    if name != name.to_uppercase() {
        return name.to_string();
    }
    name.split_whitespace()
        .map(|w| {
            let lower = w.to_lowercase();
            let mut c = lower.chars();
            match c.next() {
                Some(f) => f.to_uppercase().chain(c).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The catalogue for this session: the disk copy, refreshed when stale.
pub struct Cache {
    dir: Option<PathBuf>,
    pub cat: Catalogue,
    tried_ms: i64,
}

impl Cache {
    pub fn open(dir: Option<PathBuf>) -> Self {
        let cat = dir.as_deref().and_then(load).unwrap_or_default();
        Cache {
            dir,
            cat,
            tried_ms: 0,
        }
    }

    /// Fetches only when the copy is missing or older than a day, and then at
    /// most every 10 min. A failed fetch keeps whatever is there.
    pub fn refresh(&mut self) {
        let now = util::now_ms();
        let fresh = !self.cat.is_empty() && now - self.cat.fetched_ms < MAX_AGE_MS;
        if fresh || now - self.tried_ms < RETRY_MS {
            return;
        }
        self.tried_ms = now;
        let http = util::http::agent();
        let get = |path: &str| util::http::get_json::<Value>(&http, &format!("{BASE}{path}"));
        let fetched = (|| {
            let agents = get("/agents?isPlayableCharacter=true&language=en-US")?;
            let maps = get("/maps?language=en-US")?;
            let tiers = get("/competitivetiers?language=en-US")?;
            Catalogue::parse(&agents, &maps, &tiers, now)
        })();
        match fetched {
            Some(cat) if !cat.is_empty() => {
                if let Some(dir) = &self.dir {
                    if let Ok(raw) = serde_json::to_vec(&cat) {
                        let _ = std::fs::write(dir.join(FILE), raw);
                    }
                }
                self.cat = cat;
            }
            _ => tracing::debug!(
                "valorant: valorant-api.com fetch failed, keeping the cached catalogue"
            ),
        }
    }
}

fn load(dir: &Path) -> Option<Catalogue> {
    serde_json::from_slice(&std::fs::read(dir.join(FILE)).ok()?).ok()
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use serde_json::json;

    // shapes from valorant-rpc's content/testdata, cut down
    fn fixture() -> Catalogue {
        let agents = json!({ "status": 200, "data": [
            { "uuid": "add6443a-41bd-e414-f6ad-e58d267f4e95", "displayName": { "en-US": "Jett", "ja-JP": "x" },
              "developerName": "Wushu", "displayIcon": "https://media.valorant-api.com/agents/add6443a-41bd-e414-f6ad-e58d267f4e95/displayicon.png" },
            { "uuid": "e370fa57-4757-3604-3648-499e1f642d3f", "displayName": "Gekko",
              "developerName": "Aggrobot", "displayIcon": "https://media.valorant-api.com/agents/e370fa57-4757-3604-3648-499e1f642d3f/displayicon.png" }
        ]});
        let maps = json!({ "status": 200, "data": [
            { "uuid": "7eaecc1b-4337-bbf6-6ab9-04b8f06b3319", "displayName": { "en-US": "Ascent" },
              "splash": "https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png",
              "mapUrl": "/Game/Maps/Ascent/Ascent" },
            { "uuid": "x", "displayName": "No url", "splash": "", "mapUrl": null }
        ]});
        let tiers = json!({ "status": 200, "data": [
            { "uuid": "old", "tiers": [ { "tier": 21, "tierName": "OLD 1", "division": "ECompetitiveDivision::ASCENDANT" } ] },
            { "uuid": "current", "tiers": [
                { "tier": 0, "tierName": { "en-US": "UNRANKED" }, "division": "ECompetitiveDivision::UNRANKED" },
                { "tier": 1, "tierName": { "en-US": "Unused1" }, "division": "ECompetitiveDivision::INVALID" },
                { "tier": 21, "tierName": { "en-US": "ASCENDANT 1" }, "division": "ECompetitiveDivision::ASCENDANT" },
                { "tier": 27, "tierName": { "en-US": "RADIANT" }, "division": "ECompetitiveDivision::RADIANT" }
            ]}
        ]});
        Catalogue::parse(&agents, &maps, &tiers, 1).unwrap()
    }

    pub(crate) fn catalogue() -> Catalogue {
        fixture()
    }

    #[test]
    fn parses_and_joins() {
        let c = fixture();
        assert_eq!(c.agent("wushu").map(|a| a.name.as_str()), Some("Jett"));
        assert_eq!(c.agent("Aggrobot").map(|a| a.name.as_str()), Some("Gekko"));
        assert!(c.agent("Career").is_none());
        let m = c.map("/game/maps/ascent/ascent").unwrap();
        assert_eq!(m.name, "Ascent");
        assert!(m.splash.ends_with("/splash.png"));
        assert_eq!(c.maps.len(), 1);
        assert_eq!(c.tier(21).map(|t| t.name.as_str()), Some("Ascendant 1"));
        assert_eq!(c.tier(0).map(|t| t.name.as_str()), Some("Unranked"));
        assert!(c.tier(1).is_none());
        assert_eq!(c.tier(27).map(|t| t.name.as_str()), Some("Radiant"));
    }

    #[test]
    fn rejects_half_payloads() {
        assert!(Catalogue::parse(
            &json!({}),
            &json!({ "data": [] }),
            &json!({ "data": [] }),
            1
        )
        .is_none());
    }

    #[test]
    fn tier_names() {
        assert_eq!(tier_display_name("GOLD 2"), "Gold 2");
        assert_eq!(tier_display_name("Gold 2"), "Gold 2");
        assert_eq!(tier_display_name("RADIANT"), "Radiant");
    }
}
