//! Fortnite map and active playlist from installed logs and Fortnite-API (docs),
//! https://fortnite-api.com; engine log format documented by Epic Games (docs)

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::unreal::{self, Game, Session};
use crate::util::{self, art};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "fortnite",
    name: "Fortnite",
    blurb: "Map, active playlist and ranked matches.",
    setup: None,
    credits: &[
        unreal::CREDIT,
        Credit {
            project: "Fortnite-API",
            author: "Fortnite-API",
            url: "https://fortnite-api.com",
            license: "docs",
        },
    ],
    options: &[
        Opt::toggle(
            "show_mode",
            "Show playlist",
            "The playlist in your current match.",
            true,
        ),
        Opt::toggle(
            "show_map",
            "Show map picture",
            "Playlist artwork or the current map.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[GAME_ID],
    art: Some("https://fortnite-api.com/images/playlists/playlist_defaultsolo/showcase.png"),
    preview,
    scenarios: SCENARIOS,
    steam_game: false,
    listed: true,
};

const GAME_ID: &str = "1402418703554842694";
const ENDPOINT: &str = "https://fortnite-api.com/v1/playlists";
const DAY_MS: i64 = 86_400_000;
const RETRY: Duration = Duration::from_secs(600);

fn matches(t: &Target) -> bool {
    t.game_id == GAME_ID
        || matches!(
            util::exe_name(t).as_str(),
            "fortniteclient-win64-shipping.exe"
                | "fortniteclient-win64-shipping_eac_eos.exe"
                | "fortniteclient-win64-shipping_be.exe"
        )
}

fn run(ctx: &Ctx) {
    unreal::run(
        ctx,
        &mut Fortnite {
            catalog: Catalog::load(ctx.cache_dir()),
            ..Fortnite::default()
        },
    );
}

#[derive(Default)]
struct Fortnite {
    playlist: Option<String>,
    catalog: Catalog,
}

impl Game for Fortnite {
    const PROJECT: &'static str = "FortniteGame";

    fn reset(&mut self, _: &Session) {
        self.playlist = None;
    }

    fn line(&mut self, _: &Session, _: Option<i64>, body: &str) -> bool {
        let Some(id) = active_playlist(body) else {
            return false;
        };
        let changed = self.playlist.as_deref() != Some(id);
        self.playlist = Some(id.to_string());
        changed
    }

    fn build(&mut self, s: &Session, settings: &Settings, online: bool) -> Option<Live> {
        let map = s.map()?;
        let menu = map.eq_ignore_ascii_case("Frontend");
        if online && !menu && self.playlist.is_some() {
            self.catalog.refresh();
        }
        let mode = self
            .playlist
            .as_ref()
            .and_then(|id| self.catalog.items.get(&id.to_ascii_lowercase()));
        let ranked = !menu
            && s.loaded
            && (mode.is_some_and(Playlist::ranked)
                || self.playlist.as_deref().is_some_and(ranked_id));
        let details = if menu {
            "In the lobby".to_string()
        } else if settings.flag("show_mode") {
            match mode {
                Some(p) if ranked && !p.name.to_ascii_lowercase().contains("ranked") => {
                    format!("Ranked - {}", p.name)
                }
                Some(p) if !p.name.trim().is_empty() => p.name.clone(),
                _ if ranked => "In a ranked match".to_string(),
                _ => "In a match".to_string(),
            }
        } else {
            "In a match".to_string()
        };
        let map_label = match map {
            "Frontend" => "Lobby",
            "Hermes_Terrain" => "Battle Royale island",
            _ => "In game",
        };
        let image = settings
            .flag("show_map")
            .then(|| {
                mode.filter(|_| !menu)
                    .and_then(|p| p.images.as_ref())
                    .and_then(|i| i.showcase.clone())
                    .filter(|u| safe_image(u))
                    .or_else(|| {
                        if menu {
                            Some(art::url("fortnite", "menu"))
                        } else if map == "Hermes_Terrain" {
                            Some(art::url("fortnite", "hermes"))
                        } else {
                            None
                        }
                    })
            })
            .flatten();
        Some(Live {
            details: util::clamp(details),
            state: (!menu && settings.flag("show_map") && map_label != "In game")
                .then(|| util::clamp(map_label))
                .flatten(),
            large_text: image.as_ref().and_then(|_| util::clamp(map_label)),
            large_image: image,
            start_ms: (!menu && s.loaded).then_some(s.since_ms).flatten(),
            competing: ranked,
            ..Live::default()
        })
    }
}

fn active_playlist(body: &str) -> Option<&str> {
    // catalog dumps mention hundreds of playlists without selecting any of them
    if !body.starts_with("LogFort: PLAYLIST: Playlist Object replicated to client in AFortGameStateAthena::OnRep_CurrentPlaylistInfo()") {
        return None;
    }
    let id = body
        .split_once("PlaylistName is ")?
        .1
        .split_whitespace()
        .next()?;
    (id.starts_with("Playlist_")
        && id.len() <= 160
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
    .then_some(id)
}

fn ranked_id(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    // Habanero is the BR ranked family; other ranked modes use an explicit token
    id.starts_with("playlist_habanero") || id.split('_').any(|part| part == "ranked")
}

fn safe_image(url: &str) -> bool {
    url.starts_with("https://fortnite-api.com/images/") && !url.contains(['?', '#', '\\'])
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Playlist {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "ratingType")]
    rating: String,
    #[serde(default)]
    images: Option<Images>,
}

impl Playlist {
    fn ranked(&self) -> bool {
        self.rating.starts_with("ranked-")
            || self.rating == "delmar-competitive"
            || ranked_id(&self.id)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Images {
    #[serde(default)]
    showcase: Option<String>,
}

#[derive(Deserialize)]
struct Response {
    status: u16,
    data: Vec<Playlist>,
}

#[derive(Default, Deserialize, Serialize)]
struct Cached {
    fetched_ms: i64,
    items: HashMap<String, Playlist>,
}

#[derive(Default)]
struct Catalog {
    items: HashMap<String, Playlist>,
    fetched_ms: i64,
    file: Option<PathBuf>,
    attempted: Option<Instant>,
}

impl Catalog {
    fn load(dir: Option<PathBuf>) -> Self {
        let file = dir.map(|d| d.join("playlists.json"));
        let cache: Cached = file
            .as_ref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            file,
            items: cache.items,
            fetched_ms: cache.fetched_ms,
            attempted: None,
        }
    }

    fn refresh(&mut self) {
        let now = util::now_ms();
        if fresh(self.fetched_ms, now) || self.attempted.is_some_and(|t| t.elapsed() < RETRY) {
            return;
        }
        self.attempted = Some(Instant::now());
        let Some(response) = util::http::get_json::<Response>(&util::http::agent(), ENDPOINT)
        else {
            return;
        };
        let Some(items) = parse_catalog(response) else {
            return;
        };
        self.items = items;
        self.fetched_ms = now;
        if let Some(file) = &self.file {
            if let Ok(bytes) = serde_json::to_vec(&Cached {
                fetched_ms: now,
                items: self.items.clone(),
            }) {
                let _ = std::fs::write(file, bytes);
            }
        }
    }
}

fn fresh(fetched: i64, now: i64) -> bool {
    fetched > 0 && fetched <= now && now.saturating_sub(fetched) < DAY_MS
}

fn parse_catalog(response: Response) -> Option<HashMap<String, Playlist>> {
    if response.status != 200 || response.data.is_empty() || response.data.len() > 10_000 {
        return None;
    }
    Some(
        response
            .data
            .into_iter()
            .filter(|p| p.id.len() <= 160)
            .map(|p| (p.id.to_ascii_lowercase(), p))
            .collect(),
    )
}

const SCENARIOS: &[(&str, &str)] = &[
    ("menu", "Lobby"),
    ("battle", "Battle Royale"),
    ("zero", "Zero Build duos"),
    ("ranked", "Ranked solo"),
    ("return", "Back in the lobby"),
];

fn preview(settings: &Settings, scenario: &str) -> Preview {
    let mut game = Fortnite::default();
    for (id, name, rating, image) in [
        (
            "Playlist_DefaultSolo",
            "Solo",
            "fun",
            Some("playlist_defaultsolo"),
        ),
        (
            "Playlist_NoBuildBR_Duo",
            "Zero Build - Duos",
            "nobuild",
            Some("playlist_nobuildbr_duo"),
        ),
        ("Playlist_HabaneroSolo", "Solo", "ranked-br-combined", None),
    ] {
        game.catalog.items.insert(
            id.to_ascii_lowercase(),
            Playlist {
                id: id.into(),
                name: name.into(),
                rating: rating.into(),
                images: image.map(|key| Images {
                    showcase: Some(format!(
                        "https://fortnite-api.com/images/playlists/{key}/showcase.png"
                    )),
                }),
            },
        );
    }
    let log = match scenario {
        "battle" => match_log("Playlist_DefaultSolo"),
        "zero" => match_log("Playlist_NoBuildBR_Duo"),
        "ranked" => match_log("Playlist_HabaneroSolo"),
        "return" => format!(
            "{}\nLogLoad: LoadMap: /Game/Maps/Frontend",
            match_log("Playlist_HabaneroSolo")
        ),
        _ => "LogLoad: LoadMap: /Game/Maps/Frontend".into(),
    };
    let s = unreal::replay(&mut game, &log);
    Preview {
        game: "Fortnite",
        icon: None,
        live: game.build(&s, settings, false).unwrap_or_default(),
    }
}

fn match_log(playlist: &str) -> String {
    format!("[2026.06.07-18.42.28:919][1]LogLoad: LoadMap: 192.0.2.1:7777/BRMapCh6/Maps/Hermes_Terrain\nLogWorld: Bringing World /BRMapCh6/Maps/Hermes_Terrain.Hermes_Terrain up for play\nLogFort: PLAYLIST: Playlist Object replicated to client in AFortGameStateAthena::OnRep_CurrentPlaylistInfo() PlaylistName is {playlist} (Client Only)")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings(v: serde_json::Value) -> Settings {
        Settings::new(&MANIFEST, v)
    }

    #[test]
    fn scenarios_options_and_fallback() {
        let set = settings(serde_json::json!({}));
        for (key, _) in SCENARIOS {
            let live = preview(&set, key).live;
            assert!(!live.is_empty(), "{key}");
            assert!(live.large_image.is_some());
            assert_eq!(live.competing, *key == "ranked");
        }
        assert_eq!(preview(&set, "unknown").live, preview(&set, "menu").live);
        assert_eq!(preview(&set, "return").live, preview(&set, "menu").live);
        assert_eq!(
            preview(&set, "zero").live.details.as_deref(),
            Some("Zero Build - Duos")
        );
        for option in MANIFEST.options {
            assert_ne!(
                preview(&settings(serde_json::json!({option.key: false})), "zero").live,
                preview(&set, "zero").live
            );
        }
        assert!(
            preview(&settings(serde_json::json!({"show_mode": false})), "ranked")
                .live
                .competing
        );
    }

    #[test]
    fn ignores_unselected_playlists_and_resets_on_travel() {
        let mut game = Fortnite::default();
        let mut s = unreal::replay(&mut game, &match_log("Playlist_NoBuildBR_Duo"));
        unreal::feed(&mut s, &mut game, "LogFort: Error: UFortPlaylistManager::GetPlaylist: Unable to find playlist Playlist_HabaneroSolo");
        unreal::feed(&mut s, &mut game, "PlaylistName [Playlist_HabaneroSolo]");
        assert_eq!(game.playlist.as_deref(), Some("Playlist_NoBuildBR_Duo"));
        unreal::feed(&mut s, &mut game, "LogLoad: LoadMap: /Game/Maps/Frontend");
        assert_eq!(game.playlist, None);
        assert!(
            !game
                .build(&s, &settings(serde_json::json!({})), false)
                .unwrap()
                .competing
        );
        assert_eq!(active_playlist("LogFort: PLAYLIST: Playlist Object replicated to client in AFortGameStateAthena::OnRep_CurrentPlaylistInfo() PlaylistName is Playlist_bad?token=secret"), None);
    }

    #[test]
    fn catalog_and_cache_age() {
        let response: Response = serde_json::from_str(r#"{"status":200,"data":[{"id":"Playlist_HabaneroSolo","name":"Solo","ratingType":"ranked-br-combined","images":null}]}"#).unwrap();
        let items = parse_catalog(response).unwrap();
        assert!(items.get("playlist_habanerosolo").unwrap().ranked());
        assert!(!ranked_id(
            "Playlist_ShowdownTournament_RC_DashBerryDuo_NoFill"
        ));
        assert!(ranked_id("Playlist_DelMar_Apollo_Ranked"));
        assert!(fresh(1_000, 2_000));
        assert!(!fresh(1_000, DAY_MS + 1_000));
        assert!(!fresh(2_000, 1_000));
        assert!(!safe_image(
            "https://fortnite-api.com.evil.example/images/a.png"
        ));
        assert!(!safe_image(
            "https://fortnite-api.com/images/a.png?token=private"
        ));
    }

    #[test]
    fn detection_and_missing_api() {
        assert!(matches(&Target {
            game_id: GAME_ID.into(),
            ..Target::default()
        }));
        assert!(matches(&Target {
            exe: Some(PathBuf::from("FortniteClient-Win64-Shipping.exe")),
            ..Target::default()
        }));
        assert!(!matches(&Target::default()));
        let mut game = Fortnite::default();
        let s = unreal::replay(&mut game, &match_log("Playlist_HabaneroSolo"));
        let l = game
            .build(&s, &settings(serde_json::json!({})), false)
            .unwrap();
        assert!(l.competing);
        assert_eq!(l.details.as_deref(), Some("In a ranked match"));
        assert_eq!(l.party, None);
    }
}
