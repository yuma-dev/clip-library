//! "Playing <game>, clipping using ClipLib" rich presence. Its own pipe, but
//! the same Discord app as the voice roster: that one is named ClipLib and
//! owns the `logo` asset. SET_ACTIVITY needs no OAuth, so unlike the voice
//! roster this works for every account.
//!
//! Live game details (clipdip-live) only fill text, the big image and the
//! clock. ClipLib always keeps the logo badge, the one button and
//! "Clipping using ClipLib" in whichever line is free.

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
    /// what a live extension adds, empty without one
    pub extra: Extra,
}

/// Live game details. Unset fields keep the plain card's value.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Extra {
    pub details: Option<String>,
    pub state: Option<String>,
    pub large_image: Option<String>,
    pub large_text: Option<String>,
    /// unix ms, replaces the session start
    pub start_ms: Option<i64>,
    /// unix ms, counts down to it
    pub end_ms: Option<i64>,
    /// [current, max]
    pub party: Option<[u32; 2]>,
    /// "312 h played", joins the big image's hover text
    pub playtime: Option<String>,
    /// ranked match: Competing (5) instead of Playing (0)
    pub competing: bool,
}

impl GameActivity {
    /// the big image as sent: the extension's art over the game's icon
    fn image(&self) -> Option<&String> {
        self.extra.large_image.as_ref().or(self.image_url.as_ref())
    }
}

/// "Just clipped something" this long after a save
const JUST_CLIPPED_MS: i64 = 30_000;

enum Cmd {
    Set(Option<GameActivity>),
    Warm(bool),
}

pub struct PresenceHandle {
    tx: Sender<Cmd>,
}

impl PresenceHandle {
    /// Latest call wins. `None` clears the activity and drops the pipe.
    pub fn set(&self, activity: Option<GameActivity>) {
        let _ = self.tx.send(Cmd::Set(activity));
    }

    /// Hold the pipe open even with nothing to show. Discord keeps one Playing activity per user
    /// and breaks ties between rich ones by which RPC client connected first, so being connected
    /// before the game starts is what puts our card over a game's own presence.
    pub fn warm(&self, on: bool) {
        let _ = self.tx.send(Cmd::Warm(on));
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
    let mut warm = false;

    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Cmd::Set(a)) => want = a,
            Ok(Cmd::Warm(on)) => warm = on,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        while let Ok(cmd) = rx.try_recv() {
            match cmd {
                Cmd::Set(a) => want = a,
                Cmd::Warm(on) => warm = on,
            }
        }
        if !warm && want.is_none() && shown.is_none() && conn.is_some() {
            // presence turned off: no reason to hold a slot on Discord's RPC server
            conn = None;
            debug!("presence: pipe closed, presence off");
        }
        if warm && conn.is_none() && Instant::now() >= next_connect {
            match Connection::connect().and_then(|c| handshake(&c, CLIENT_ID).map(|_| c)) {
                Ok(c) => {
                    info!("presence: connected ahead of any game");
                    conn = Some(c);
                }
                Err(e) => {
                    debug!("presence: not connected: {e:#}");
                    let wait = if is_capacity_error(&e) { RECONNECT_EVERY * 4 } else { RECONNECT_EVERY };
                    next_connect = Instant::now() + wait;
                }
            }
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
                shown_game.as_ref() != Some(&(a.game.clone(), a.image().cloned()))
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
            if shape == Shape::NoImage && activity.image().is_none() {
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
            shown_game = Some((activity.game.clone(), activity.image().cloned()));
        } else {
            // dead pipe or every shape refused; reconnect later instead of spinning
            conn = None;
            shown = None;
            shown_game = None;
            next_connect = Instant::now() + RECONNECT_EVERY;
        }
    }
}

/// The activity exactly as it would go to Discord, for ClipLib's settings preview.
pub fn preview_activity(a: &GameActivity) -> Value {
    activity_json(a, Shape::Full, now_ms())
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

/// Discord rejects the whole activity over a text outside 2..=128 chars
fn fit(s: &str) -> Option<String> {
    let s = s.trim();
    match s.chars().count() {
        0..=1 => None,
        2..=128 => Some(s.to_string()),
        _ => Some(format!("{}...", s.chars().take(125).collect::<String>())),
    }
}

const CLIPPING: &str = "Clipping using ClipLib";
const JUST_CLIPPED: &str = "Just clipped something";

fn activity_json(a: &GameActivity, shape: Shape, now: i64) -> Value {
    let x = &a.extra;
    let x_details = x.details.as_deref().and_then(fit);
    let x_state = x.state.as_deref().and_then(fit);
    let mut hover = vec![x.large_text.as_deref().and_then(fit).unwrap_or_else(|| a.game.clone())];
    hover.extend(x.playtime.clone());
    if let Some(n) = a.game_clips.filter(|n| *n > 0) {
        hover.push(clips(n));
    }
    let large_text = hover.join(" · ");
    let large_text = fit(&large_text).unwrap_or_else(|| a.game.clone());
    let small_text = match a.total_clips {
        Some(n) if n > 0 => format!("{CLIPPING} · {}", clips(n)),
        _ => CLIPPING.to_string(),
    };
    let assets = match (a.image(), shape) {
        (Some(url), Shape::Full) => json!({
            "large_image": url,
            "large_text": large_text,
            "small_image": LOGO_ASSET,
            "small_text": small_text,
        }),
        _ => json!({ "large_image": LOGO_ASSET, "large_text": large_text }),
    };
    let line = live_line(a, now);
    let just = line.as_deref() == Some(JUST_CLIPPED);
    let mut timestamps = json!({ "start": x.start_ms.unwrap_or(a.started_at_ms) });
    if let Some(end) = x.end_ms.filter(|e| *e > now) {
        timestamps["end"] = json!(end);
    }
    let mut v = json!({
        // Discord sorts Competing above every Playing activity, a game's own presence included
        "type": if x.competing { 5 } else { 0 },
        "timestamps": timestamps,
        "assets": assets,
        // the only button, extensions can't add one; other people see it, you never do
        "buttons": [{ "label": "Get ClipLib", "url": SITE_URL }],
    });
    let (details, state) = if shape == Shape::Plain {
        (Some(a.game.clone()), x_details.or(line).or_else(|| Some(CLIPPING.into())))
    } else {
        // a local client may rename the activity: the card title and "Playing <game>" in the
        // member list both read the game instead of the app name
        v["name"] = json!(a.game);
        match x_details {
            // a fresh save beats the extension's second line for its 30 s
            Some(d) => (Some(d), if just { line } else { x_state.or(line).or_else(|| Some(CLIPPING.into())) }),
            None => (Some(CLIPPING.into()), if just { line } else { x_state.or(line) }),
        }
    };
    if let Some(d) = details {
        v["details"] = json!(d);
    }
    if let Some(s) = state {
        v["state"] = json!(s);
        // Discord shows the party as "(1 of 5)" after the state, and only with an id
        if let Some([cur, max]) = x.party.filter(|[c, m]| *c > 0 && m >= c) {
            v["party"] = json!({ "id": "cliplib", "size": [cur, max] });
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
            extra: Extra::default(),
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
        assert_eq!(v["assets"]["small_text"], "Clipping using ClipLib · 2,125 clips");
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

    #[test]
    fn extra_fills_lines_and_keeps_cliplib() {
        let mut a = act(Some("https://x/game.png"));
        a.extra = Extra {
            details: Some("Ranked Solo/Duo, Ahri".into()),
            large_image: Some("https://x/ahri.jpg".into()),
            large_text: Some("Ahri".into()),
            ..Extra::default()
        };
        a.game_clips = Some(3);
        let v = activity_json(&a, Shape::Full, NOW);
        assert_eq!(v["details"], "Ranked Solo/Duo, Ahri");
        assert_eq!(v["state"], "Clipping using ClipLib");
        assert_eq!(v["assets"]["large_image"], "https://x/ahri.jpg");
        assert_eq!(v["assets"]["large_text"], "Ahri · 3 clips");
        assert_eq!(v["assets"]["small_image"], LOGO_ASSET);
        assert_eq!(v["buttons"].as_array().unwrap().len(), 1);

        a.extra.state = Some("5/2/7, 182 CS".into());
        a.extra.party = Some([2, 5]);
        a.session_clips = 1;
        a.last_clip_ms = Some(NOW - 5_000);
        let v = activity_json(&a, Shape::Full, NOW);
        assert_eq!(v["state"], "Just clipped something");
        assert_eq!(v["party"]["size"], json!([2, 5]));
        a.last_clip_ms = Some(NOW - 60_000);
        assert_eq!(activity_json(&a, Shape::Full, NOW)["state"], "5/2/7, 182 CS");

        // no extension details: ClipLib keeps the first line, the extension's state the second
        a.extra.details = None;
        let v = activity_json(&a, Shape::Full, NOW);
        assert_eq!(v["details"], "Clipping using ClipLib");
        assert_eq!(v["state"], "5/2/7, 182 CS");
    }

    #[test]
    fn extra_text_is_clamped_and_clock_used() {
        let mut a = act(None);
        a.extra.details = Some("x".repeat(300));
        a.extra.state = Some("y".into());
        a.extra.start_ms = Some(NOW - 1000);
        a.extra.end_ms = Some(NOW + 60_000);
        let v = activity_json(&a, Shape::Full, NOW);
        assert_eq!(v["details"].as_str().unwrap().chars().count(), 128);
        // a 1 char state is invalid, ClipLib's line takes its place
        assert_eq!(v["state"], "Clipping using ClipLib");
        assert_eq!(v["timestamps"]["start"], NOW - 1000);
        assert_eq!(v["timestamps"]["end"], NOW + 60_000);
    }

    #[test]
    fn no_image_shape_drops_extension_art_too() {
        let mut a = act(None);
        a.extra.large_image = Some("https://x/map.png".into());
        assert_eq!(activity_json(&a, Shape::Full, NOW)["assets"]["large_image"], "https://x/map.png");
        assert_eq!(activity_json(&a, Shape::NoImage, NOW)["assets"]["large_image"], LOGO_ASSET);
    }

    #[test]
    fn ranked_matches_compete() {
        let mut a = act(None);
        assert_eq!(activity_json(&a, Shape::Full, NOW)["type"], 0);
        a.extra.competing = true;
        assert_eq!(activity_json(&a, Shape::Full, NOW)["type"], 5);
    }

    #[test]
    fn playtime_joins_the_hover() {
        let mut a = act(None);
        a.game_clips = Some(4);
        a.extra.playtime = Some("312 h played".into());
        assert_eq!(activity_json(&a, Shape::Full, NOW)["assets"]["large_text"], "VALORANT · 312 h played · 4 clips");
        a.extra.large_text = Some("Ascent".into());
        assert_eq!(activity_json(&a, Shape::Full, NOW)["assets"]["large_text"], "Ascent · 312 h played · 4 clips");
    }
}
