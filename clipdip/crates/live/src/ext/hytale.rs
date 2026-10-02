//! World and server labels. Ported from hytale-rpc by bas3line (MIT),
//! https://github.com/bas3line/hytale-rpc: src/log_watcher_windows.py and src/rpc_windows.py

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use std::{path::PathBuf, time::Duration};
mod log;

// consts because the manifest is static, ext::tests keeps the tag on util::art::TAG
const ART: &str = "https://cdn.jsdelivr.net/gh/yuma-dev/cliplib-rpc-assets@v3/hytale/orbis.webp";
const BANNER: &str =
    "https://cdn.jsdelivr.net/gh/yuma-dev/cliplib-rpc-assets@v3/hytale/banner.webp";

pub static MANIFEST: Manifest = Manifest {
    id: "hytale",
    name: "Hytale",
    blurb: "World, server name, and loading state",
    setup: None,
    credits: &[Credit {
        project: "hytale-rpc",
        author: "bas3line",
        url: "https://github.com/bas3line/hytale-rpc",
        license: "MIT",
    }],
    options: &[Opt::toggle(
        "show_names",
        "Show world and server names",
        "Display labels from the game log. Server addresses stay hidden.",
        true,
    )],
    matches,
    run,
    priority: 10,
    game_ids: &["1458530944955973852"],
    art: Some(BANNER),
    preview,
    scenarios: &[
        ("menu", "Main menu"),
        ("loading", "Loading world"),
        ("singleplayer", "Singleplayer"),
        ("multiplayer", "Multiplayer"),
        ("disconnected", "Disconnected"),
    ],
    steam_game: false,
    listed: true,
};
fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || matches!(
            util::exe_name(t).as_str(),
            "hytaleclient.exe" | "hytale.exe"
        )
}
#[derive(Default)]
struct State {
    phase: &'static str,
    label: Option<String>,
    multiplayer: bool,
}
fn label(value: &str) -> Option<String> {
    // labels may themselves be addresses; never publish those or save paths
    if value.contains(['/', '\\', ':', '@'])
        || value.split('.').count() > 1
        || value.chars().any(char::is_control)
    {
        return None;
    }
    util::clamp(value)
}
impl State {
    fn parse(&mut self, line: &str) {
        if line.contains("Changing from Stage") {
            if line.contains(" to MainMenu") {
                *self = Self {
                    phase: "menu",
                    ..Self::default()
                };
            } else if line.contains(" to Disconnection") {
                *self = Self {
                    phase: "disconnected",
                    ..Self::default()
                };
            } else if line.contains(" to Exited") {
                *self = Self::default();
            } else if line.contains(" to InGame") {
                self.phase = "playing";
            } else if line.contains(" to GameLoading") {
                self.phase = "loading";
            }
        } else if let Some(rest) = line.split("Connecting to singleplayer world \"").nth(1) {
            *self = Self {
                phase: "loading",
                label: rest.split('"').next().and_then(label),
                multiplayer: false,
            };
        } else if let Some(rest) = line
            .split("Connecting to multiplayer server \"")
            .nth(1)
            .or_else(|| line.split("Connecting to dedicated server \"").nth(1))
        {
            *self = Self {
                phase: "loading",
                label: rest.split('"').next().and_then(label),
                multiplayer: true,
            };
        } else if line.contains("Creating new singleplayer world in \"") {
            // wait for the display-name line rather than publishing a save-folder name
            *self = Self {
                phase: "loading",
                ..Self::default()
            };
        } else if line.contains("GameInstance.StartJoiningWorld()") && self.phase == "loading" {
            self.phase = "playing";
        }
    }
}
fn build(s: &State, settings: &Settings) -> Live {
    let details = match s.phase {
        "menu" => "In the main menu",
        "disconnected" => "Disconnected",
        "loading" if s.multiplayer => "Joining a server",
        "loading" => "Loading a world",
        "playing" if s.multiplayer => "Playing multiplayer",
        "playing" => "Playing singleplayer",
        _ => return Live::default(),
    };
    Live {
        details: util::clamp(details),
        state: settings
            .flag("show_names")
            .then(|| s.label.clone())
            .flatten(),
        large_image: Some(ART.into()),
        large_text: util::clamp("Hytale - Orbis"),
        ..Live::default()
    }
}
fn preview(settings: &Settings, scenario: &str) -> Preview {
    let s = match scenario {
        "loading" => State {
            phase: "loading",
            label: Some("Emerald grove".into()),
            multiplayer: false,
        },
        "singleplayer" => State {
            phase: "playing",
            label: Some("Emerald grove".into()),
            multiplayer: false,
        },
        "multiplayer" => State {
            phase: "playing",
            label: Some("Orbis explorers".into()),
            multiplayer: true,
        },
        "disconnected" => State {
            phase: "disconnected",
            ..State::default()
        },
        _ => State {
            phase: "menu",
            ..State::default()
        },
    };
    Preview {
        game: "Hytale",
        icon: None,
        live: build(&s, settings),
    }
}
fn run(ctx: &Ctx) {
    let dir = std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("Hytale/UserData/Logs"));
    let mut follower = log::Follower::default();
    let mut state = State::default();
    loop {
        let path = dir
            .as_ref()
            .and_then(|d| util::tail::newest_file(d, |n| n.ends_with("_client.log")));
        follower.poll(path, ctx.target().started_at_ms, &mut state, State::parse);
        ctx.emit(Some(build(&state, ctx.settings())));
        if !ctx.sleep(Duration::from_secs(5)) {
            return;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn art_follows_the_pack_tag() {
        assert_eq!(ART, util::art::url("hytale", "orbis"));
    }
    #[test]
    fn real_log_transitions_and_privacy() {
        let mut s = State::default();
        s.parse("2026-01-13 16:04:14.0562|INFO|HytaleClient.Application.AppStartup|Connecting to singleplayer world \"Sample world\"...");
        assert_eq!(s.phase, "loading");
        s.parse("2026-01-13 16:04:30.3100|INFO|HytaleClient.Application.AppGameLoading|GameInstance.StartJoiningWorld()");
        assert_eq!(s.phase, "playing");
        assert_eq!(s.label.as_deref(), Some("Sample world"));
        s.parse("2026-01-15 02:20:53.8639|INFO|HytaleClient.Application.AppStartup|Connecting to multiplayer server \"Sample server\" at 192.0.2.1:25565");
        assert!(s.multiplayer);
        assert_eq!(s.label.as_deref(), Some("Sample server"));
        s.parse("INFO|HytaleClient.Application.Program|Changing from Stage GameLoading to Disconnection");
        assert_eq!(s.phase, "disconnected");
        assert!(s.label.is_none());
        s.parse("Connecting to multiplayer server \"192.0.2.1:25565\" at 192.0.2.1:25565");
        assert!(s.label.is_none());
        s.parse("INFO|HytaleClient.Application.Program|Changing from Stage InGame to MainMenu");
        assert_eq!(s.phase, "menu");
        s.parse("Creating new singleplayer world in \"C:/private/Saves/world\"...");
        assert!(s.label.is_none());
    }
    #[test]
    fn scenarios_fallback_and_option() {
        let a = Settings::new(&MANIFEST, json!({}));
        for (k, _) in MANIFEST.scenarios {
            assert!(!preview(&a, k).live.is_empty());
        }
        assert_eq!(preview(&a, "unknown").live, preview(&a, "menu").live);
        let b = Settings::new(&MANIFEST, json!({"show_names":false}));
        assert_ne!(
            preview(&a, "multiplayer").live,
            preview(&b, "multiplayer").live
        );
        assert!(build(&State::default(), &a).is_empty());
    }
}
