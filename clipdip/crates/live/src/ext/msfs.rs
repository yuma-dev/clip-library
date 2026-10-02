//! Simulator window state via Microsoft's window API (docs),
//! https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getwindowtextw

use crate::util::{self, art, clamp};
use crate::{Credit, Ctx, Live, Manifest, Preview, Settings, Target};
use std::time::Duration;

pub static MANIFEST: Manifest = Manifest {
    id: "msfs",
    name: "Microsoft Flight Simulator 2020 / 2024",
    blurb: "Simulator and menu state from the game window.",
    setup: None,
    credits: &[Credit {
        project: "Windows window API",
        author: "Microsoft",
        url: "https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-getwindowtextw",
        license: "docs",
    }],
    options: &[],
    matches,
    run,
    priority: 10,
    game_ids: &[
        "750925046729670796",
        "1308492082369003631",
        "1501056655495008266",
    ],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/1250410/header.jpg"),
    preview,
    scenarios: &[
        ("simulator", "Simulator window"),
        ("menu", "Main menu"),
        ("loading", "Loading"),
    ],
    steam_game: true,
    listed: true,
};

fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || matches!(t.game_id.as_str(), "steam:1250410" | "steam:2537590")
        || matches!(
            util::exe_name(t).as_str(),
            "flightsimulator.exe" | "flightsimulator2024.exe"
        )
}

fn build(title: &str, is_2024: bool) -> Option<Live> {
    let lower = title.to_ascii_lowercase();
    if !lower.contains("flight simulator") {
        return None;
    }
    // only known labels survive, a custom title can contain a pilot name or path
    let phase = if lower.ends_with(" - main menu") {
        "In the main menu"
    } else if lower.ends_with(" - loading") {
        "Loading the simulator"
    } else {
        "In the simulator"
    };
    Some(Live {
        details: clamp(phase),
        large_image: Some(art::steam_header(if is_2024 {
            "2537590"
        } else {
            "1250410"
        })),
        large_text: clamp(if is_2024 {
            "Microsoft Flight Simulator 2024"
        } else {
            "Microsoft Flight Simulator 2020"
        }),
        ..Live::default()
    })
}

fn run(ctx: &Ctx) {
    let is_2024 = ctx.target().game_id == "1308492082369003631"
        || ctx.target().steam_appid.as_deref() == Some("2537590")
        || ctx.target().game_id == "steam:2537590"
        || util::exe_name(ctx.target()) == "flightsimulator2024.exe";
    loop {
        let live = util::window::titles(ctx.target().pid)
            .iter()
            .find_map(|title| build(title, is_2024));
        let wait = if live.is_some() { 5 } else { 12 };
        ctx.emit(live);
        if !ctx.sleep(Duration::from_secs(wait)) {
            return;
        }
    }
}

fn preview(_: &Settings, key: &str) -> Preview {
    let title = match key {
        "menu" => "Microsoft Flight Simulator - Main Menu",
        "loading" => "Microsoft Flight Simulator - Loading",
        _ => "Microsoft Flight Simulator",
    };
    Preview {
        game: "Microsoft Flight Simulator",
        icon: None,
        live: build(title, false).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn titles_are_not_echoed() {
        assert!(build("Private pilot", false).is_none());
        let l = build("Microsoft Flight Simulator - Private pilot", true).unwrap();
        assert_eq!(l.details.as_deref(), Some("In the simulator"));
        assert!(l.large_image.unwrap().contains("2537590"));
    }
    #[test]
    fn scenarios_and_fallback() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(!preview(&s, key).live.is_empty());
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "simulator").live);
    }
}
