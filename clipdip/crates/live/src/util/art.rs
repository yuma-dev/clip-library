//! Pictures from ClipLib's own art pack (github.com/yuma-dev/cliplib-rpc-assets),
//! served by jsDelivr. Built from wiki and Steam art by that repo's recipes;
//! each extension knows its own keys. The tag is pinned so a live card never
//! changes under someone, a new pack means a new tag here.

pub const TAG: &str = "v3";
const BASE: &str = "https://cdn.jsdelivr.net/gh/yuma-dev/cliplib-rpc-assets";

/// `<game>/<key>.webp` in the pinned pack, 512 px square.
pub fn url(game: &str, key: &str) -> String {
    format!("{BASE}@{TAG}/{game}/{key}.webp")
}

/// A Steam game's own art, the fallback when nothing better fits. library_hero because apps from
/// 2025 on (PEAK, Battlefield 6, F1 25) serve a grey placeholder at header.jpg and library_600x900.jpg
pub fn steam_header(appid: &str) -> String {
    format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}/library_hero.jpg")
}

/// Lowercase alphanumerics only, so "Level - Shop Forest", "level_shop_forest"
/// and "LevelShopForest" all compare equal.
pub fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_norm() {
        assert_eq!(
            url("repo", "manor"),
            format!(
                "https://cdn.jsdelivr.net/gh/yuma-dev/cliplib-rpc-assets@{TAG}/repo/manor.webp"
            )
        );
        assert_eq!(norm("Level - Shop Forest"), norm("level_shop_forest"));
    }
}
