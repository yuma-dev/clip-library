//! What the game presence says beyond the game itself: clips saved this
//! session, when the last one was, and how many clips of this game and in
//! total the library holds (hover text). Counts come from one library scan
//! per new game, then saves keep them current.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use clipdip_discord::{Extra, GameActivity, PresenceHandle};
use tracing::debug;

use crate::game_watch::{self, GameSession, SessionSlot};
use crate::live_presence::LivePresence;

const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "mov", "avi", "webm"];

#[derive(Default)]
struct Stats {
    game_id: Option<String>,
    session_clips: u32,
    last_clip_ms: Option<i64>,
    game_clips: Option<u32>,
    total_clips: Option<u32>,
}

pub struct GamePresence {
    handle: Arc<PresenceHandle>,
    config_path: PathBuf,
    session: SessionSlot,
    stats: Mutex<Stats>,
    live: Arc<LivePresence>,
    /// the activity last handed to Discord, for ClipLib's settings preview
    card: Mutex<Option<serde_json::Value>>,
}

impl GamePresence {
    pub fn new(handle: Arc<PresenceHandle>, config_path: PathBuf, session: SessionSlot) -> Arc<Self> {
        let live = LivePresence::new(config_path.clone());
        let me = Arc::new(Self {
            handle,
            config_path,
            session,
            stats: Mutex::new(Stats::default()),
            live: live.clone(),
            card: Mutex::new(None),
        });
        let weak = Arc::downgrade(&me);
        live.set_on_change(move || {
            if let Some(me) = weak.upgrade() {
                me.apply();
            }
        });
        me
    }

    /// Settings changed: helpers follow the new toggles, the card the rest.
    pub fn refresh(&self) {
        self.warm();
        self.sync_live();
        self.apply();
    }

    /// Connects to Discord at startup, not when the first game shows, while game presence is on.
    pub fn warm(&self) {
        let on = clipdip_core::config::Config::load_or_default(&self.config_path)
            .map(|c| c.discord.presence)
            .unwrap_or(true);
        self.handle.warm(on);
    }

    /// Live extensions run only for a game that is actually shown.
    fn sync_live(&self) {
        let session = self.session.lock().unwrap().clone();
        self.live.sync(session.as_ref().filter(|s| self.allowed(&s.game.id)));
    }

    /// The watcher's session started, switched or ended.
    pub fn on_session(self: &Arc<Self>, session: Option<&GameSession>) {
        if let Some(s) = session {
            if let Some(dir) = self.config_path.parent() {
                game_watch::remember_played(dir, &s.game);
            }
            let fresh = {
                let mut st = self.stats.lock().unwrap();
                if st.game_id.as_deref() != Some(s.game.id.as_str()) {
                    *st = Stats {
                        game_id: Some(s.game.id.clone()),
                        ..Stats::default()
                    };
                    true
                } else {
                    false
                }
            };
            if fresh {
                let me = Arc::clone(self);
                let game_id = s.game.id.clone();
                let _ = std::thread::Builder::new()
                    .name("clipdip-clipcount".into())
                    .spawn(move || me.count_library(&game_id));
            }
        } else {
            // relaunching the same game later is a new session with its own count
            *self.stats.lock().unwrap() = Stats::default();
        }
        self.sync_live();
        self.apply();
    }

    /// A clip or recording was saved; `game_id` is what its .gameinfo got.
    pub fn on_clip_saved(&self, game_id: Option<&str>) {
        let session_game = self.session.lock().unwrap().as_ref().map(|s| s.game.id.clone());
        {
            let mut st = self.stats.lock().unwrap();
            if let Some(n) = st.total_clips.as_mut() {
                *n += 1;
            }
            if session_game.is_some() && session_game.as_deref() == st.game_id.as_deref() {
                st.session_clips += 1;
                st.last_clip_ms = Some(now_ms());
                if game_id.is_some() && game_id == session_game.as_deref() {
                    if let Some(n) = st.game_clips.as_mut() {
                        *n += 1;
                    }
                }
            }
        }
        self.apply();
    }

    /// Pushes the current session (or its absence) to Discord, honoring
    /// `discord.presence` and `presence_hidden`. Re-reads config so a settings
    /// toggle applies without a restart.
    pub fn apply(&self) {
        let session = self.session.lock().unwrap().clone();
        let l = self.live.merged();
        let competing = l.competing
            && clipdip_core::config::Config::load_or_default(&self.config_path)
                .map(|c| c.discord.competing)
                .unwrap_or(true);
        let extra = Extra {
            details: l.details,
            state: l.state,
            large_image: l.large_image,
            large_text: l.large_text,
            start_ms: l.start_ms,
            end_ms: l.end_ms,
            party: l.party,
            playtime: l.playtime,
            competing,
        };
        let activity = session.filter(|s| self.allowed(&s.game.id)).map(|s| {
            let st = self.stats.lock().unwrap();
            let own = st.game_id.as_deref() == Some(s.game.id.as_str());
            GameActivity {
                game: s.game.name.clone(),
                image_url: s.game.icon_url.clone(),
                started_at_ms: s.started_at_ms,
                session_clips: if own { st.session_clips } else { 0 },
                last_clip_ms: if own { st.last_clip_ms } else { None },
                game_clips: if own { st.game_clips } else { None },
                total_clips: st.total_clips,
                extra,
            }
        });
        *self.card.lock().unwrap() = activity.as_ref().map(clipdip_discord::preview_activity);
        self.handle.set(activity);
    }

    /// What the card says right now, None while nothing shows.
    pub fn card(&self) -> Option<serde_json::Value> {
        self.card.lock().unwrap().clone()
    }

    /// Whether Discord is being told about the game running now.
    pub fn showing(&self) -> bool {
        let id = self.session.lock().unwrap().as_ref().map(|s| s.game.id.clone());
        id.map(|id| self.allowed(&id)).unwrap_or(false)
    }

    fn allowed(&self, game_id: &str) -> bool {
        let discord = clipdip_core::config::Config::load_or_default(&self.config_path)
            .map(|c| c.discord)
            .unwrap_or_default();
        discord.presence && !discord.presence_hidden.iter().any(|id| id == game_id)
    }

    fn count_library(&self, game_id: &str) {
        let Ok(cfg) = clipdip_core::config::Config::load_or_default(&self.config_path) else { return };
        let dir = cfg.output.directory;
        let total = count_videos(&dir, 0);
        let games = count_game_clips(&dir, game_id);
        debug!(total, games, "presence: library counted");
        {
            let mut st = self.stats.lock().unwrap();
            // a newer session may have replaced this one while we counted
            if st.game_id.as_deref() != Some(game_id) {
                return;
            }
            // saves during the scan already landed in the files we just read
            st.total_clips = Some(total);
            st.game_clips = Some(games);
        }
        self.apply();
    }
}

/// Video files under the clip folder, skipping dot folders and `icons` like the library does.
fn count_videos(dir: &Path, depth: u32) -> u32 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut n = 0;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if depth < 4 && !name.starts_with('.') && name != "icons" {
                n += count_videos(&e.path(), depth + 1);
            }
        } else if Path::new(&name)
            .extension()
            .and_then(|x| x.to_str())
            .map(|x| VIDEO_EXTS.contains(&x.to_ascii_lowercase().as_str()))
            .unwrap_or(false)
        {
            n += 1;
        }
    }
    n
}

/// .gameinfo files naming this game whose clip still exists. ClipLib flattens
/// subfolder clips as `sub--clip.mp4`, hence the `--` mapping.
fn count_game_clips(dir: &Path, game_id: &str) -> u32 {
    let meta = dir.join(".clip_metadata");
    let Ok(entries) = std::fs::read_dir(&meta) else { return 0 };
    let mut n = 0;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(clip) = name.strip_suffix(".gameinfo") else { continue };
        let Ok(raw) = std::fs::read(e.path()) else { continue };
        let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) else { continue };
        if v.get("game").and_then(|g| g.get("id")).and_then(|id| id.as_str()) != Some(game_id) {
            continue;
        }
        if dir.join(clip.replace("--", "/")).exists() {
            n += 1;
        }
    }
    n
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_videos_and_this_games_clips() {
        let dir = std::env::temp_dir().join(format!("clipcount-{}", std::process::id()));
        let meta = dir.join(".clip_metadata");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::create_dir_all(dir.join("icons")).unwrap();
        for f in ["a.mp4", "b.mp4", "sub/c.mp4", "notes.txt", "icons/x.mp4"] {
            std::fs::write(dir.join(f), b"").unwrap();
        }
        let game = |id: &str| format!(r#"{{"game":{{"id":"{id}","name":"G","source":"exe"}}}}"#);
        std::fs::write(meta.join("a.mp4.gameinfo"), game("1")).unwrap();
        std::fs::write(meta.join("sub--c.mp4.gameinfo"), game("1")).unwrap();
        std::fs::write(meta.join("b.mp4.gameinfo"), game("2")).unwrap();
        // the clip is gone, its sidecar must not count
        std::fs::write(meta.join("deleted.mp4.gameinfo"), game("1")).unwrap();

        let total = count_videos(&dir, 0);
        let games = count_game_clips(&dir, "1");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((total, games), (3, 2));
    }
}
