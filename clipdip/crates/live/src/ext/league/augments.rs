//! Arena and ARAM: Mayhem augments from CommunityDragon's cherry-augments.json:
//! one file for both modes, Mayhem ids carry an ARAM_ prefix. Names come in the
//! client's language because the live api reports them that way.
//!
//! The live api has no augment field. An augment that grants a summoner spell
//! shows up as a new name in a spell slot (MayhemStatsTracker by
//! MyNamesEMurray, src/shared/live-events.ts), the others only appear in match
//! history after the game.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;

use super::store::Store;

const PLUGIN: &str = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global";
const GAME: &str = "https://raw.communitydragon.org/latest/game";
/// new augments come with a patch every two weeks
const MAX_AGE: Duration = Duration::from_secs(3 * 24 * 3600);

#[derive(Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
struct Entry {
    id: i64,
    augment_name_id: String,
    #[serde(rename = "nameTRA")]
    name: String,
    augment_small_icon_path: String,
    rarity: String,
}

/// One augment as the card shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct Augment {
    pub name: String,
    pub icon: Option<String>,
    /// Silver, Gold, Prismatic
    pub rarity: &'static str,
    /// unix ms it showed up, 0 when read after the game
    pub at_ms: i64,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Mayhem,
    Arena,
}

pub fn mode_of(game_mode: &str) -> Option<Mode> {
    match game_mode {
        "KIWI" | "KIWI_JADE" => Some(Mode::Mayhem),
        "CHERRY" => Some(Mode::Arena),
        _ => None,
    }
}

pub struct Augments {
    store: Store,
    /// CommunityDragon's folder name: "default" for en_US, else "de_de"
    locale: String,
    list: Option<Vec<Entry>>,
    /// icon url per augment id, checked once since 51 of 554 have no large icon
    icons: HashMap<i64, Option<String>>,
}

impl Augments {
    pub fn new(dir: Option<PathBuf>) -> Augments {
        Augments {
            store: Store::new(dir),
            locale: "default".into(),
            list: None,
            icons: HashMap::new(),
        }
    }

    /// "de_DE" from /riotclient/region-locale
    pub fn set_locale(&mut self, locale: &str) {
        let l = folder(locale);
        if l != self.locale {
            self.locale = l;
            self.list = None;
        }
    }

    fn entries(&mut self) -> Option<&Vec<Entry>> {
        if self.list.is_none() {
            let cached = format!("cherry-augments-{}.json", self.locale);
            let url = format!("{PLUGIN}/{}/v1/cherry-augments.json", self.locale);
            self.list = self
                .store
                .cached(&cached, MAX_AGE)
                .or_else(|| self.store.fetch(&url, &cached));
        }
        self.list.as_ref()
    }

    /// A name from a summoner spell slot, when it is one of this mode's augments.
    pub fn by_spell_name(&mut self, name: &str, mode: Mode, at_ms: i64) -> Option<Augment> {
        let e = self
            .entries()?
            .iter()
            .find(|e| e.name == name && mode_matches(e, mode))?
            .clone();
        Some(self.augment(&e, at_ms))
    }

    /// playerAugment1..6 from match history
    pub fn by_id(&mut self, id: i64) -> Option<Augment> {
        let e = self.entries()?.iter().find(|e| e.id == id)?.clone();
        Some(self.augment(&e, 0))
    }

    fn augment(&mut self, e: &Entry, at_ms: i64) -> Augment {
        let icon = match self.icons.get(&e.id) {
            Some(i) => i.clone(),
            None => {
                let i = self.icon_url(e);
                self.icons.insert(e.id, i.clone());
                i
            }
        };
        Augment {
            name: e.name.clone(),
            icon,
            rarity: rarity_name(&e.rarity),
            at_ms,
        }
    }

    /// The 256 px icon from the game files when there is one, else the 64 px one.
    fn icon_url(&self, e: &Entry) -> Option<String> {
        let (large, small) = icon_urls(&e.augment_small_icon_path)?;
        let ok = self
            .store
            .agent
            .head(&large)
            .call()
            .is_ok();
        Some(if ok { large } else { small })
    }
}

fn mode_matches(e: &Entry, mode: Mode) -> bool {
    e.augment_name_id.starts_with("ARAM_") == (mode == Mode::Mayhem)
}

fn folder(locale: &str) -> String {
    let l = locale.trim().to_ascii_lowercase();
    if l.is_empty() || l == "en_us" {
        "default".into()
    } else {
        l
    }
}

fn rarity_name(r: &str) -> &'static str {
    match r {
        "kGold" => "Gold",
        "kPrismatic" => "Prismatic",
        _ => "Silver",
    }
}

/// "/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/Cruelty_small.png" is served lowercased,
/// the large one sits next to it in the game files
fn icon_urls(small_path: &str) -> Option<(String, String)> {
    let lower = small_path.to_ascii_lowercase();
    let rest = lower.strip_prefix("/lol-game-data/assets/")?;
    if rest.is_empty() {
        return None;
    }
    let large = match rest.strip_suffix("_small.png") {
        Some(stem) => format!("{GAME}/{stem}_large.png"),
        None => format!("{GAME}/{rest}"),
    };
    Some((large, format!("{PLUGIN}/default/{rest}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(list: &str) -> Augments {
        let mut a = Augments::new(None);
        a.list = serde_json::from_str(list).ok();
        a
    }

    const LIST: &str = r#"[
        {"id":1205,"augmentNameId":"ARAM_ADAPt","nameTRA":"ADAPt","augmentSmallIconPath":"","rarity":"kSilver"},
        {"id":93,"augmentNameId":"WarmupRoutine","nameTRA":"Warmup Routine","augmentSmallIconPath":"","rarity":"kPrismatic"}
    ]"#;

    #[test]
    fn spell_names_only_match_their_mode() {
        let mut a = with(LIST);
        assert_eq!(a.by_spell_name("ADAPt", Mode::Mayhem, 5).unwrap().at_ms, 5);
        assert!(a.by_spell_name("ADAPt", Mode::Arena, 5).is_none());
        let w = a.by_spell_name("Warmup Routine", Mode::Arena, 0).unwrap();
        assert_eq!(w.rarity, "Prismatic");
        assert!(a.by_spell_name("Flash", Mode::Mayhem, 0).is_none());
        assert_eq!(a.by_id(1205).unwrap().name, "ADAPt");
        assert!(a.by_id(1).is_none());
    }

    #[test]
    fn icon_paths() {
        let (large, small) =
            icon_urls("/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/Drop_Bear_Small.png").unwrap();
        assert_eq!(
            large,
            "https://raw.communitydragon.org/latest/game/assets/ux/kiwi/augments/icons/drop_bear_large.png"
        );
        assert_eq!(
            small,
            "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/ux/kiwi/augments/icons/drop_bear_small.png"
        );
        assert!(icon_urls("").is_none());
    }

    #[test]
    fn locales_and_modes() {
        assert_eq!(folder("en_US"), "default");
        assert_eq!(folder("de_DE"), "de_de");
        assert_eq!(mode_of("KIWI"), Some(Mode::Mayhem));
        assert_eq!(mode_of("CHERRY"), Some(Mode::Arena));
        assert_eq!(mode_of("ARAM"), None);
    }
}
