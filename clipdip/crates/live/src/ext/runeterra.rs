//! Match, deck size and result from Riot Games' documented client API (docs)
//! https://developer.riotgames.com/docs/lor: Game Client API

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

pub static MANIFEST: Manifest = Manifest {
    id: "runeterra",
    name: "Legends of Runeterra",
    blurb: "Match, deck size and result.",
    setup: Some("Keep the local API enabled on port 21337 in the game's settings."),
    credits: &[Credit {
        project: "Riot Developer Portal",
        author: "Riot Games",
        url: "https://developer.riotgames.com/docs/lor",
        license: "docs",
    }],
    options: &[Opt::toggle(
        "show_deck",
        "Show deck size",
        "Show the starting deck size during a match.",
        true,
    )],
    matches,
    run,
    priority: 10,
    game_ids: &["1402418693958275202"],
    art: Some("https://cdn.jsdelivr.net/gh/yuma-dev/cliplib-rpc-assets@v3/runeterra/banner.webp"),
    preview,
    scenarios: &[
        ("menu", "Menus"),
        ("match", "Match"),
        ("win", "Victory"),
        ("loss", "Defeat"),
    ],
    steam_game: false,
    listed: true,
};

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str()) || util::exe_name(t) == "lor.exe"
}

#[derive(Deserialize)]
struct Board {
    #[serde(rename = "GameState")]
    state: String,
}

#[derive(Clone, Copy, Deserialize)]
struct ResultData {
    #[serde(rename = "GameID")]
    id: i64,
    #[serde(rename = "LocalPlayerWon")]
    won: bool,
}

fn deck_size(v: &Value) -> Option<u32> {
    let cards = v.get("CardsInDeck")?.as_object()?;
    let count = cards
        .values()
        .try_fold(0u64, |n, v| n.checked_add(v.as_u64()?))?;
    (count > 0 && count <= 100).then_some(count as u32)
}

fn deck_art(v: &Value) -> Option<String> {
    let cards = v.get("CardsInDeck")?.as_object()?;
    cards
        .keys()
        .filter(|code| {
            let b = code.as_bytes();
            b.len() == 7
                && code
                    .get(..2)
                    .and_then(|s| s.parse::<u32>().ok())
                    .is_some_and(|set| (1..=5).contains(&set))
                && b.get(..2).is_some_and(|x| x.iter().all(u8::is_ascii_digit))
                && b.get(2..4)
                    .is_some_and(|x| x.iter().all(u8::is_ascii_uppercase))
                && b.get(4..).is_some_and(|x| x.iter().all(u8::is_ascii_digit))
        })
        .min()
        .map(|code| {
            format!(
                "https://dd.b.pvp.net/latest/set{}/en_us/img/cards/{code}-full.png",
                code.get(..2)
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(1)
            )
        })
}

fn build(
    s: &Settings,
    active: bool,
    result: Option<bool>,
    deck: Option<u32>,
    start: Option<i64>,
    art: Option<&str>,
) -> Live {
    Live {
        details: util::clamp(if active {
            "In a match"
        } else {
            "Browsing menus"
        }),
        state: if active && s.flag("show_deck") {
            deck.and_then(|n| util::clamp(format!("{n} cards in deck")))
        } else if !active {
            result.and_then(|won| util::clamp(if won { "Victory" } else { "Defeat" }))
        } else {
            None
        },
        start_ms: if active { start } else { None },
        large_image: if active {
            art.map(str::to_string)
        } else {
            None
        },
        large_text: if active && art.is_some() {
            util::clamp("Card in your deck")
        } else {
            None
        },
        ..Live::default()
    }
}

#[derive(Default)]
struct Tracker {
    active: bool,
    baseline: Option<i64>,
    start: Option<i64>,
    result: Option<(bool, i64)>,
    deck: Option<u32>,
    art: Option<String>,
}

impl Tracker {
    fn update(&mut self, active: bool, result: Option<ResultData>, now: i64) {
        if active && !self.active {
            self.start = Some(now);
            self.deck = None;
            self.art = None;
            self.result = None;
        }
        if let Some(r) = result.filter(|r| r.id >= 0) {
            if !active && self.baseline.is_some_and(|id| r.id > id) {
                self.result = Some((r.won, now));
            }
            self.baseline = Some(r.id);
        }
        self.active = active;
        if self
            .result
            .is_some_and(|(_, at)| now.saturating_sub(at) > 60_000)
        {
            self.result = None;
        }
    }
}

fn run(ctx: &Ctx) {
    let agent = util::http::loopback_agent();
    let mut tracker = Tracker::default();
    loop {
        let board: Option<Board> =
            util::http::get_json(&agent, "http://127.0.0.1:21337/positional-rectangles");
        let delay = if let Some(board) =
            board.filter(|b| matches!(b.state.as_str(), "Menus" | "InProgress"))
        {
            let active = board.state == "InProgress";
            let result = util::http::get_json(&agent, "http://127.0.0.1:21337/game-result");
            tracker.update(active, result, util::now_ms());
            if active && tracker.deck.is_none() {
                if let Some(deck) =
                    util::http::get_json::<Value>(&agent, "http://127.0.0.1:21337/static-decklist")
                {
                    tracker.deck = deck_size(&deck);
                    tracker.art = deck_art(&deck);
                }
            }
            ctx.emit(Some(build(
                ctx.settings(),
                active,
                tracker.result.map(|r| r.0),
                tracker.deck,
                tracker.start,
                tracker.art.as_deref(),
            )));
            5
        } else {
            tracker = Tracker::default();
            ctx.emit(None);
            15
        };
        if !ctx.sleep(Duration::from_secs(delay)) {
            return;
        }
    }
}

fn preview(s: &Settings, scenario: &str) -> Preview {
    let active = scenario == "match";
    let result = match scenario {
        "win" => Some(true),
        "loss" => Some(false),
        _ => None,
    };
    let art = deck_art(&serde_json::json!({"CardsInDeck":{"01DE001":2}}));
    Preview {
        game: "Legends of Runeterra",
        icon: None,
        live: build(
            s,
            active,
            result,
            Some(40),
            Some(1_700_000_000_000),
            art.as_deref(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn documented_payloads_and_bad_counts() {
        let b: Board = serde_json::from_value(json!({"GameState":"InProgress","PlayerName":"Private","OpponentName":"Private","Rectangles":[]})).unwrap();
        assert_eq!(b.state, "InProgress");
        assert_eq!(
            deck_size(&json!({"CardsInDeck":{"01DE001":2,"01FR009":3}})),
            Some(5)
        );
        assert_eq!(deck_size(&json!({"CardsInDeck":null})), None);
        assert_eq!(deck_size(&json!({"CardsInDeck":{"bad":-3}})), None);
        assert_eq!(
            deck_art(&json!({"CardsInDeck":{"01DE001":2}})).as_deref(),
            Some("https://dd.b.pvp.net/latest/set1/en_us/img/cards/01DE001-full.png")
        );
        assert!(deck_art(&json!({"CardsInDeck":{"../../../private":1}})).is_none());
    }

    #[test]
    fn stale_result_not_shown_and_completion_expires() {
        let mut t = Tracker::default();
        t.update(false, Some(ResultData { id: 4, won: true }), 0);
        assert!(t.result.is_none());
        t.update(true, Some(ResultData { id: 4, won: true }), 10);
        t.update(false, Some(ResultData { id: 5, won: false }), 20);
        assert_eq!(t.result, Some((false, 20)));
        t.update(false, Some(ResultData { id: 5, won: false }), 60_021);
        assert!(t.result.is_none());
        t.update(false, Some(ResultData { id: 0, won: true }), 60_030);
        assert!(t.result.is_none());
    }

    #[test]
    fn previews_and_settings() {
        let s = Settings::new(&MANIFEST, json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&s, key).live.is_empty());
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        let hidden = Settings::new(&MANIFEST, json!({"show_deck":false}));
        assert_ne!(preview(&s, "match").live, preview(&hidden, "match").live);
        assert!(!preview(&s, "match").live.competing);
    }
}
