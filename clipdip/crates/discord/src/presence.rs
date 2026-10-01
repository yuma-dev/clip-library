//! "Playing <game>, clipping using ClipLib" rich presence. Its own pipe, but
//! the same Discord app as the voice roster: that one is named ClipLib and
//! owns the `logo` asset. SET_ACTIVITY needs no OAuth, so unlike the voice
//! roster this works for every account.

use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use serde_json::{json, Value};
use tracing::{debug, info, warn};

use crate::ipc::{Connection, OP_CLOSE, OP_PING};
use crate::{handshake, is_capacity_error, request, ReqError, CLIENT_ID};

const LOGO_ASSET: &str = "logo";
const SITE_URL: &str = "https://cliplib.app";
/// Discord not running: try again this often while a game wants showing
const RECONNECT_EVERY: Duration = Duration::from_secs(15);
/// Discord takes ~5 activity updates per 20 s and silently drops the rest. A new game, a clear and
/// "Just clipped something" go out at once while the budget lasts; count and time-ago updates wait
/// SLOW after the last send. The loop retries every 500 ms, the newest text wins.
const BUDGET: usize = 5;
const WINDOW: Duration = Duration::from_secs(20);
const SLOW: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq)]
pub struct GameActivity {
    pub game: String,
    /// external image for the big icon; the logo stands in without one
    pub image_url: Option<String>,
    /// unix ms, Discord counts "elapsed" from here
    pub started_at_ms: i64,
    /// clips saved since this game session started
    pub session_clips: u32,
    /// unix ms of the last save this session
    pub last_clip_ms: Option<i64>,
    /// clips of this game in the library, for the big image's hover text
    pub game_clips: Option<u32>,
    /// clips in the whole library, for the logo's hover text
    pub total_clips: Option<u32>,
}

/// "Just clipped something" this long after a save
const JUST_CLIPPED_MS: i64 = 30_000;

enum Cmd {
    Set(Option<GameActivity>),
}

pub struct PresenceHandle {
    tx: Sender<Cmd>,
}

impl PresenceHandle {
    /// Latest call wins. `None` clears the activity and drops the pipe.
    pub fn set(&self, activity: Option<GameActivity>) {
        let _ = self.tx.send(Cmd::Set(activity));
    }
}

pub fn spawn_presence() -> PresenceHandle {
    let (tx, rx) = crossbeam_channel::unbounded();
    let _ = std::thread::Builder::new()
        .name("clipdip-presence".into())
        .spawn(move || run(rx));
    PresenceHandle { tx }
}

/// How much of the activity Discord accepted last time. An older client or a
/// rejected external image shouldn't cost the whole presence.
#[derive(Clone, Copy, PartialEq)]
enum Shape {
    Full,
    NoImage,
    Plain,
}

fn run(rx: Receiver<Cmd>) {
    let mut want: Option<GameActivity> = None;
    // what Discord has, as rendered text: the live line changes with time alone
    let mut shown: Option<String> = None;
    // which game that was, to tell a new game (urgent) from a text tweak (can wait)
    let mut shown_game: Option<(String, Option<String>)> = None;
    let mut sent_at: std::collections::VecDeque<Instant> = std::collections::VecDeque::new();
    let mut conn: Option<Connection> = None;
    let mut next_connect = Instant::now();
    let mut nonce: u64 = 0;

    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Cmd::Set(a)) => want = a,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        while let Ok(Cmd::Set(a)) = rx.try_recv() {
            want = a;
        }

        // keep an idle pipe alive and notice Discord quitting
        if let Some(c) = &conn {
            let mut dropped = false;
            loop {
                match c.frames.try_recv() {
                    Ok((OP_PING, val)) => {
                        let _ = c.pong(&val);
                    }
                    Ok((OP_CLOSE, _)) | Err(crossbeam_channel::TryRecvError::Disconnected) => {
                        dropped = true;
                        break;
                    }
                    Ok(_) => {}
                    Err(crossbeam_channel::TryRecvError::Empty) => break,
                }
            }
            if dropped {
                debug!("presence: pipe closed");
                conn = None;
                shown = None;
                shown_game = None;
                next_connect = Instant::now() + RECONNECT_EVERY;
            }
        }

        let now = now_ms();
        let want_key = want.as_ref().map(|a| activity_json(a, Shape::Full, now).to_string());
        if want_key == shown {
            continue;
        }

        let urgent = match &want {
            None => true,
            Some(a) => {
                shown_game.as_ref() != Some(&(a.game.clone(), a.image_url.clone()))
                    || live_line(a, now).as_deref() == Some("Just clipped something")
            }
        };
        let t = Instant::now();
        while sent_at.front().map(|s| t.duration_since(*s) >= WINDOW).unwrap_or(false) {
            sent_at.pop_front();
        }
        if sent_at.len() >= BUDGET {
            continue;
        }
        if !urgent && sent_at.back().map(|s| t.duration_since(*s) < SLOW).unwrap_or(false) {
            continue;
        }

        let Some(activity) = want.clone() else {
            // the pipe stays open: a reconnect costs ~30 s of Discord holding the handshake,
            // and the next game should show the moment it starts
            if let Some(c) = conn.as_ref() {
                nonce += 1;
                let cleared = request(
                    c,
                    &format!("p{nonce}"),
                    "SET_ACTIVITY",
                    json!({ "pid": std::process::id() }),
                    Duration::from_secs(5),
                );
                sent_at.push_back(Instant::now());
                if cleared.is_ok() {
                    info!("presence: cleared");
                } else {
                    // a stuck pipe: dropping it also clears, Discord ends a gone client's activity
                    conn = None;
                }
            }
            shown = None;
            shown_game = None;
            continue;
        };

        if conn.is_none() {
            if Instant::now() < next_connect {
                continue;
            }
            match Connection::connect().and_then(|c| handshake(&c, CLIENT_ID).map(|_| c)) {
                Ok(c) => conn = Some(c),
                Err(e) => {
                    debug!("presence: not connected: {e:#}");
                    // a full RPC server only fills further with every retry
                    let wait = if is_capacity_error(&e) { RECONNECT_EVERY * 4 } else { RECONNECT_EVERY };
                    next_connect = Instant::now() + wait;
                    continue;
                }
            }
        }
        let Some(c) = conn.as_ref() else { continue };

        let mut sent = false;
        for shape in [Shape::Full, Shape::NoImage, Shape::Plain] {
            if shape == Shape::NoImage && activity.image_url.is_none() {
                continue;
            }
            nonce += 1;
            let args = json!({
                "pid": std::process::id(),
                "activity": activity_json(&activity, shape, now),
            });
            match request(c, &format!("p{nonce}"), "SET_ACTIVITY", args, Duration::from_secs(5)) {
                Ok(_) => {
                    info!(game = %activity.game, "presence: set");
                    sent = true;
                    break;
                }
                Err(ReqError::Rpc(d)) => warn!("presence: SET_ACTIVITY rejected, trying a simpler one: {d}"),
                Err(ReqError::Closed) | Err(ReqError::Timeout) => break,
            }
        }
        if sent {
            sent_at.push_back(Instant::now());
            shown = want_key;
            shown_game = Some((activity.game.clone(), activity.image_url.clone()));
        } else {
            // dead pipe or every shape refused; reconnect later instead of spinning
            conn = None;
            shown = None;
            shown_game = None;
            next_connect = Instant::now() + RECONNECT_EVERY;
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// thousands separators, 2125 reads "2,125"
fn thousands(n: u32) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn clips(n: u32) -> String {
    format!("{} clip{}", thousands(n), if n == 1 { "" } else { "s" })
}

/// the line under "Clipping using ClipLib": a fresh save, then the session's count
fn live_line(a: &GameActivity, now: i64) -> Option<String> {
    let since = a.last_clip_ms.map(|t| (now - t).max(0));
    if since.map(|s| s < JUST_CLIPPED_MS).unwrap_or(false) {
        return Some("Just clipped something".into());
    }
    if a.session_clips == 0 {
        return None;
    }
    let count = format!("{} this session", clips(a.session_clips));
    let mins = since.unwrap_or(0) / 60_000;
    Some(match mins {
        0 => count,
        1..=59 => format!("{count}, last {mins} min ago"),
        _ => format!("{count}, last {} h ago", mins / 60),
    })
}

fn activity_json(a: &GameActivity, shape: Shape, now: i64) -> Value {
    let large_text = match a.game_clips {
        Some(n) if n > 0 => format!("{} · {}", a.game, clips(n)),
        _ => a.game.clone(),
    };
    let small_text = match a.total_clips {
        Some(n) if n > 0 => format!("ClipLib · {}", clips(n)),
        _ => "ClipLib".to_string(),
    };
    let assets = match (&a.image_url, shape) {
        (Some(url), Shape::Full) => json!({
            "large_image": url,
            "large_text": large_text,
            "small_image": LOGO_ASSET,
            "small_text": small_text,
        }),
        _ => json!({ "large_image": LOGO_ASSET, "large_text": large_text }),
    };
    let line = live_line(a, now);
    let mut v = json!({
        "type": 0,
        "timestamps": { "start": a.started_at_ms },
        "assets": assets,
        // only other people see buttons, Discord never shows them on your own card
        "buttons": [{ "label": "Get ClipLib", "url": SITE_URL }],
    });
    if shape == Shape::Plain {
        v["details"] = json!(a.game);
        v["state"] = json!(line.unwrap_or_else(|| "Clipping using ClipLib".into()));
    } else {
        // a local client may rename the activity: the card title and "Playing <game>" in the
        // member list both read the game instead of the app name
        v["name"] = json!(a.game);
        v["details"] = json!("Clipping using ClipLib");
        if let Some(line) = line {
            v["state"] = json!(line);
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_600_000;

    fn act(url: Option<&str>) -> GameActivity {
        GameActivity {
            game: "VALORANT".into(),
            image_url: url.map(str::to_string),
            started_at_ms: 1_700_000_000_000,
            session_clips: 0,
            last_clip_ms: None,
            game_clips: None,
            total_clips: None,
        }
    }

    #[test]
    fn full_shape_has_game_art_and_logo_badge() {
        let v = activity_json(&act(Some("https://cdn.discordapp.com/app-icons/1/2.png")), Shape::Full, NOW);
        assert_eq!(v["name"], "VALORANT");
        assert_eq!(v["details"], "Clipping using ClipLib");
        assert!(v.get("state").is_none());
        assert_eq!(v["assets"]["large_image"], "https://cdn.discordapp.com/app-icons/1/2.png");
        assert_eq!(v["assets"]["small_image"], LOGO_ASSET);
        assert_eq!(v["buttons"][0]["url"], SITE_URL);
    }

    #[test]
    fn live_line_follows_the_session() {
        let mut a = act(None);
        assert!(activity_json(&a, Shape::Full, NOW).get("state").is_none());
        a.session_clips = 3;
        a.last_clip_ms = Some(NOW - 10_000);
        assert_eq!(activity_json(&a, Shape::Full, NOW)["state"], "Just clipped something");
        a.last_clip_ms = Some(NOW - 45_000);
        assert_eq!(activity_json(&a, Shape::Full, NOW)["state"], "3 clips this session");
        a.last_clip_ms = Some(NOW - 5 * 60_000);
        assert_eq!(activity_json(&a, Shape::Full, NOW)["state"], "3 clips this session, last 5 min ago");
        a.last_clip_ms = Some(NOW - 130 * 60_000);
        assert_eq!(activity_json(&a, Shape::Full, NOW)["state"], "3 clips this session, last 2 h ago");
    }

    #[test]
    fn hover_text_carries_clip_counts() {
        let mut a = act(Some("https://x/y.png"));
        a.game_clips = Some(67);
        a.total_clips = Some(2125);
        let v = activity_json(&a, Shape::Full, NOW);
        assert_eq!(v["assets"]["large_text"], "VALORANT · 67 clips");
        assert_eq!(v["assets"]["small_text"], "ClipLib · 2,125 clips");
    }

    #[test]
    fn fallbacks_drop_the_image_then_the_rename() {
        let a = act(Some("https://example.com/x.png"));
        assert_eq!(activity_json(&a, Shape::NoImage, NOW)["assets"]["large_image"], LOGO_ASSET);
        let plain = activity_json(&a, Shape::Plain, NOW);
        assert!(plain.get("name").is_none());
        assert_eq!(plain["details"], "VALORANT");
        assert_eq!(activity_json(&act(None), Shape::Full, NOW)["assets"]["large_image"], LOGO_ASSET);
    }
}
