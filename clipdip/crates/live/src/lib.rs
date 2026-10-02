//! Live game details for the game presence: champion, map, score, modpack.
//! Each extension reads one game's own local data (Riot's local APIs, Valve
//! GSI, log files, UDP telemetry) and runs in its own helper process,
//! `clipdip.exe --live-ext <id>`, so a panic, hang or bad payload there costs
//! that card its extras and nothing else. ClipLib's parts of the card (logo
//! badge, "Clipping using ClipLib", the one button) are added by the presence
//! composer, extensions never see them.

pub mod ext;
mod host;
pub mod util;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub use host::{run_helper, Ctx};

/// The running game as clipdip's watcher saw it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Target {
    /// Discord application id (or `steam:<appid>` / `epic:<id>`), as in .gameinfo
    pub game_id: String,
    pub game_name: String,
    #[serde(default)]
    pub steam_appid: Option<String>,
    pub pid: u32,
    #[serde(default)]
    pub exe: Option<PathBuf>,
    /// unix ms
    pub started_at_ms: i64,
}

/// What an extension adds to the card. Every field is optional, unset ones
/// keep the default card's value.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Live {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// https url; Discord proxies it, GIF and WebP work too
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub large_image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub large_text: Option<String>,
    /// unix ms, replaces the session start (a game clock, a match start)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<i64>,
    /// unix ms, Discord counts down to it instead of up
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<i64>,
    /// [current, max], shown as "(2 of 5)" after the state
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub party: Option<[u32; 2]>,
    /// "312 h played", added to the big image's hover text next to whatever else is there
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playtime: Option<String>,
    /// a ranked match: the card reads "Competing in <game>", which Discord ranks above any
    /// Playing activity, the game's own included
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub competing: bool,
}

impl Live {
    pub fn is_empty(&self) -> bool {
        *self == Live::default()
    }

    /// Fields of `self`, holes filled from `other`.
    pub fn or(self, other: &Live) -> Live {
        Live {
            details: self.details.or_else(|| other.details.clone()),
            state: self.state.or_else(|| other.state.clone()),
            large_image: self.large_image.or_else(|| other.large_image.clone()),
            large_text: self.large_text.or_else(|| other.large_text.clone()),
            start_ms: self.start_ms.or(other.start_ms),
            end_ms: self.end_ms.or(other.end_ms),
            party: self.party.or(other.party),
            playtime: self.playtime.or_else(|| other.playtime.clone()),
            competing: self.competing || other.competing,
        }
    }
}

pub struct Credit {
    /// the project the code was ported from
    pub project: &'static str,
    pub author: &'static str,
    pub url: &'static str,
    pub license: &'static str,
}

pub enum OptKind {
    Toggle {
        default: bool,
    },
    /// (value, label) pairs, `default` is one of the values
    Choice {
        default: &'static str,
        choices: &'static [(&'static str, &'static str)],
    },
}

pub struct Opt {
    pub key: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub kind: OptKind,
}

impl Opt {
    pub const fn toggle(
        key: &'static str,
        label: &'static str,
        description: &'static str,
        default: bool,
    ) -> Self {
        Opt {
            key,
            label,
            description,
            kind: OptKind::Toggle { default },
        }
    }

    pub const fn choice(
        key: &'static str,
        label: &'static str,
        description: &'static str,
        default: &'static str,
        choices: &'static [(&'static str, &'static str)],
    ) -> Self {
        Opt {
            key,
            label,
            description,
            kind: OptKind::Choice { default, choices },
        }
    }
}

pub struct Manifest {
    /// settings key under `[discord.live]` and the `--live-ext` argument
    pub id: &'static str,
    pub name: &'static str,
    /// one line for settings: what the card gains
    pub blurb: &'static str,
    /// anything the user has to do once in the game, shown under the toggle
    pub setup: Option<&'static str>,
    pub credits: &'static [Credit],
    pub options: &'static [Opt],
    /// Cheap, runs in clipdip itself on every session start: no IO beyond a
    /// path check, no panics.
    pub matches: fn(&Target) -> bool,
    /// Runs in the helper. Loop until `ctx.sleep` says stop; returning ends the
    /// helper and clears what it showed.
    pub run: fn(&Ctx),
    /// lower wins when two running extensions fill the same field
    pub priority: u8,
    /// Discord application ids of the games it covers, for their icons in settings
    pub game_ids: &'static [&'static str],
    /// wide https art for its settings page (a Steam header, a splash), no auth
    pub art: Option<&'static str>,
    /// What the card would show in `scenario` (a key from `scenarios`, the
    /// first one for anything else) with these settings, from built-in sample
    /// data through the same text building `run` uses. No IO.
    pub preview: fn(&Settings, &str) -> Preview,
    /// (key, label) moments settings can preview: menus, lobby, in game...
    pub scenarios: &'static [(&'static str, &'static str)],
    /// a Steam game, so the card's hours played applies to it
    pub steam_game: bool,
    /// false for card data that belongs to every game (Steam hours), toggled
    /// with the game card instead of on a page of its own
    pub listed: bool,
}

/// A sample card for settings: the game it pretends to be and the extras.
pub struct Preview {
    pub game: &'static str,
    /// the game's own icon on the card when `live` has no image
    pub icon: Option<&'static str>,
    pub live: Live,
}

/// For extensions that have nothing to sample yet.
pub fn no_preview(_: &Settings, _: &str) -> Preview {
    Preview {
        game: "Your game",
        icon: None,
        live: Live::default(),
    }
}

/// An extension's settings table with the manifest's defaults behind it.
pub struct Settings {
    manifest: &'static Manifest,
    values: serde_json::Value,
}

impl Settings {
    pub fn new(manifest: &'static Manifest, values: serde_json::Value) -> Self {
        Settings { manifest, values }
    }

    /// A toggle's value, the manifest default when unset.
    pub fn flag(&self, key: &str) -> bool {
        if let Some(v) = self.values.get(key).and_then(|v| v.as_bool()) {
            return v;
        }
        self.manifest
            .options
            .iter()
            .find(|o| o.key == key)
            .and_then(|o| match o.kind {
                OptKind::Toggle { default } => Some(default),
                OptKind::Choice { .. } => None,
            })
            .unwrap_or(false)
    }

    /// A choice's value, the manifest default when unset or not one of the choices.
    pub fn choice(&self, key: &str) -> String {
        let Some(OptKind::Choice { default, choices }) = self
            .manifest
            .options
            .iter()
            .find(|o| o.key == key)
            .map(|o| &o.kind)
        else {
            return String::new();
        };
        match self.values.get(key).and_then(|v| v.as_str()) {
            Some(v) if choices.iter().any(|(c, _)| *c == v) => v.to_string(),
            _ => default.to_string(),
        }
    }
}

impl Manifest {
    /// Settings shape for ClipLib's settings page.
    pub fn describe(&self) -> serde_json::Value {
        use serde_json::json;
        let options: Vec<_> = self
            .options
            .iter()
            .map(|o| match &o.kind {
                OptKind::Toggle { default } => json!({
                    "key": o.key, "label": o.label, "description": o.description,
                    "type": "toggle", "default": default,
                }),
                OptKind::Choice { default, choices } => json!({
                    "key": o.key, "label": o.label, "description": o.description,
                    "type": "choice", "default": default,
                    "choices": choices.iter().map(|(v, l)| json!({ "value": v, "label": l })).collect::<Vec<_>>(),
                }),
            })
            .collect();
        json!({
            "id": self.id,
            "name": self.name,
            "game_ids": self.game_ids,
            "art": self.art,
            "listed": self.listed,
            "steam_game": self.steam_game,
            "scenarios": self.scenarios.iter().map(|(k, l)| json!({ "key": k, "label": l })).collect::<Vec<_>>(),
            "blurb": self.blurb,
            "setup": self.setup,
            "credits": self.credits.iter().map(|c| json!({
                "project": c.project, "author": c.author, "url": c.url, "license": c.license,
            })).collect::<Vec<_>>(),
            "options": options,
        })
    }

    /// `enabled` in the extension's settings table, on unless set false.
    pub fn enabled(&self, settings: Option<&serde_json::Value>) -> bool {
        settings
            .and_then(|s| s.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    }
}

pub fn find(id: &str) -> Option<&'static Manifest> {
    ext::ALL.iter().copied().find(|m| m.id == id)
}

/// Every extension, for `--live-extensions`.
pub fn describe_all() -> serde_json::Value {
    serde_json::Value::Array(ext::ALL.iter().map(|m| m.describe()).collect())
}
