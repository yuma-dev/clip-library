//! Capture the Discord voice-call roster at clip time, no server bot. Connects
//! to the desktop client's local RPC over a named pipe; after one-time
//! `AUTHORIZE` consent, polls `GET_SELECTED_VOICE_CHANNEL` so
//! [`DiscordHandle::roster`] is a lock away for the clip save flow.
//!
//! Client secret comes from `CLIPDIP_DISCORD_CLIENT_SECRET` at build (or
//! runtime env for dev); without it the feature reports [`DiscordStatus::Disabled`].
//! The `rpc` scope is allowlist-gated by Discord (owner + App Testers only
//! until Discord approves the app).

mod ipc;
mod oauth;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use tracing::{debug, info, warn};

use ipc::{Connection, OP_CLOSE, OP_HANDSHAKE, OP_PING};
use oauth::{TokenError, TokenResponse, TokenStore};

/// Public OAuth2 client id, safe to compile in.
const CLIENT_ID: &str = "1523640943218000042";
/// Must match a redirect registered on the app; never actually navigated to.
const REDIRECT_URI: &str = "http://localhost";
/// Hotkey reads the last snapshot, so this bounds staleness. 2s is plenty.
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Reconnect delay after the pipe drops or Discord closes.
const RECONNECT_BACKOFF: Duration = Duration::from_secs(3);
/// Refresh this long before expiry so a poll never races it.
const REFRESH_SLACK: Duration = Duration::from_secs(6 * 3600);
/// Backoff for a transient token-endpoint failure, without tearing down the RPC session.
const REFRESH_RETRY_MIN: Duration = Duration::from_secs(60);
const REFRESH_RETRY_MAX: Duration = Duration::from_secs(30 * 60);
/// This many AUTHORIZE prompts in the window signals a dying-token/decline
/// loop; above a normal couple-of-days launch count.
const PROMPT_STORM_THRESHOLD: usize = 5;
const PROMPT_STORM_WINDOW_SECS: i64 = 48 * 3600;
/// Don't repeat the popup-storm hint more often than this.
const PROMPT_HINT_COOLDOWN_SECS: i64 = 7 * 24 * 3600;

// public types

/// One member of a voice call.
#[derive(Clone, Debug, Serialize)]
pub struct Participant {
    pub id: String,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global_name: Option<String>,
    /// Per-guild nickname, when the call is in a server channel.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nick: Option<String>,
    pub bot: bool,
    /// CDN avatar URL (`.gif` if animated, else `.png`), or default avatar.
    /// `None` only if the id couldn't be parsed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

impl Participant {
    /// Best display label: server nick, then global (display) name, then username.
    pub fn display_name(&self) -> &str {
        self.nick
            .as_deref()
            .or(self.global_name.as_deref())
            .unwrap_or(&self.username)
    }
}

/// Snapshot of the voice channel the user is currently in.
#[derive(Clone, Debug, Serialize)]
pub struct CallRoster {
    pub channel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guild_id: Option<String>,
    pub participants: Vec<Participant>,
}

/// Connection state, surfaced to the settings UI.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DiscordStatus {
    /// No client secret compiled in, feature off.
    Disabled,
    /// Establishing the pipe / authenticating.
    Connecting,
    /// Discord isn't running (no IPC pipe).
    DiscordNotRunning,
    /// Connected but not yet authorized, the UI should offer "Connect".
    NeedsAuthorization,
    /// Fully connected and reading voice state.
    Connected { user: String },
    /// Last attempt errored; will retry.
    Error { message: String },
}

/// Handle held by the app. Cheap to clone the data it exposes; commands are
/// sent to the manager thread over a channel.
pub struct DiscordHandle {
    roster: Arc<Mutex<Option<CallRoster>>>,
    status: Arc<Mutex<DiscordStatus>>,
    cmd_tx: Sender<Command>,
    config_dir: PathBuf,
}

impl DiscordHandle {
    /// The current call roster, or `None` if not in a call / not connected.
    pub fn roster(&self) -> Option<CallRoster> {
        self.roster.lock().clone()
    }

    pub fn status(&self) -> DiscordStatus {
        self.status.lock().clone()
    }

    /// Begin the one-time authorization (shows the consent popup in Discord).
    pub fn connect(&self) {
        let _ = self.cmd_tx.send(Command::Authorize);
    }

    /// Forget the stored token and drop back to `NeedsAuthorization`.
    pub fn disconnect(&self) {
        let _ = self.cmd_tx.send(Command::Disconnect);
    }

    /// Stop the manager thread (called on app shutdown).
    pub fn shutdown(&self) {
        let _ = self.cmd_tx.send(Command::Shutdown);
    }

    /// True when consent popups fired abnormally often recently and the
    /// settings hint hasn't shown in a while. App polls this for the overlay.
    pub fn prompt_hint_due(&self) -> bool {
        let log = oauth::PromptLog::load(&self.config_dir);
        let now = oauth::now_unix();
        let recent = log
            .prompt_times
            .iter()
            .filter(|t| now - **t <= PROMPT_STORM_WINDOW_SECS)
            .count();
        if recent < PROMPT_STORM_THRESHOLD {
            return false;
        }
        match log.hint_shown_at {
            Some(t) if now - t < PROMPT_HINT_COOLDOWN_SECS => false,
            _ => true,
        }
    }

    /// Persist that the popup-storm hint was shown, starting its cooldown.
    pub fn mark_prompt_hint_shown(&self) {
        let mut log = oauth::PromptLog::load(&self.config_dir);
        log.hint_shown_at = Some(oauth::now_unix());
        let _ = log.save(&self.config_dir);
    }
}

/// Always returns a usable handle; reports `Disabled` if no client secret.
/// `auto_authorize` (callers pass `discord.enabled`) shows the consent popup
/// as soon as a pipe connects; a decline just parks in `NeedsAuthorization`
/// and the next launch asks again.
pub fn spawn(config_dir: PathBuf, auto_authorize: bool) -> DiscordHandle {
    let (cmd_tx, cmd_rx) = crossbeam_channel::unbounded();
    let roster = Arc::new(Mutex::new(None));
    let status = Arc::new(Mutex::new(DiscordStatus::Connecting));

    let Some(secret) = client_secret() else {
        *status.lock() = DiscordStatus::Disabled;
        info!("discord: no client secret compiled in — call-roster capture disabled");
        return DiscordHandle {
            roster,
            status,
            cmd_tx,
            config_dir,
        };
    };

    // persisted invalid_scope rejection: stay quiet until Connect or an update
    let auth_blocked = oauth::AuthBlock::load(&config_dir).is_some();
    let mgr = Manager {
        config_dir: config_dir.clone(),
        client_secret: secret,
        roster: Arc::clone(&roster),
        status: Arc::clone(&status),
        cmd_rx,
        nonce: AtomicU64::new(0),
        auto_authorize,
        want_authorize: AtomicBool::new(auto_authorize && !auth_blocked),
        reset: AtomicBool::new(false),
        shutdown: AtomicBool::new(false),
    };
    std::thread::Builder::new()
        .name("clipdip-discord".into())
        .spawn(move || mgr.run())
        .expect("spawn discord manager thread");

    DiscordHandle {
        roster,
        status,
        cmd_tx,
        config_dir,
    }
}

/// Resolve the client secret: baked in at build time, or from the runtime
/// env for local dev. Empty counts as absent.
fn client_secret() -> Option<String> {
    option_env!("CLIPDIP_DISCORD_CLIENT_SECRET")
        .map(str::to_string)
        .or_else(|| std::env::var("CLIPDIP_DISCORD_CLIENT_SECRET").ok())
        .filter(|s| !s.is_empty())
}

// manager

enum Command {
    Authorize,
    Disconnect,
    Shutdown,
}

/// Local result type for an RPC request/response round-trip.
enum ReqError {
    /// The pipe closed (Discord quit / connection dropped), reconnect.
    Closed,
    /// No response within the deadline.
    Timeout,
    /// Discord returned an `evt: "ERROR"` frame; carries its `data`.
    Rpc(Value),
}

struct Manager {
    config_dir: PathBuf,
    client_secret: String,
    roster: Arc<Mutex<Option<CallRoster>>>,
    status: Arc<Mutex<DiscordStatus>>,
    cmd_rx: Receiver<Command>,
    nonce: AtomicU64,
    /// Config's `discord.enabled` at spawn: may prompt unauthenticated (re-armed on token death).
    auto_authorize: bool,
    want_authorize: AtomicBool,
    reset: AtomicBool,
    shutdown: AtomicBool,
}

impl Manager {
    fn run(self) {
        info!("discord: manager thread started (client {CLIENT_ID})");
        while !self.stopped() {
            self.drain_commands();
            if self.stopped() {
                break;
            }

            let has_token = TokenStore::load(&self.config_dir).refresh_token.is_some();
            // Discord freezes an idle unauthenticated pipe after ~15s, so with no
            // token we hold NO connection until Connect, then AUTHORIZE right after handshake.
            if !has_token && !self.want_authorize.load(Ordering::Relaxed) {
                match oauth::AuthBlock::load(&self.config_dir) {
                    Some(block) => self.set_status(DiscordStatus::Error {
                        message: block.reason,
                    }),
                    None => self.set_status(DiscordStatus::NeedsAuthorization),
                }
                self.idle_until_authorize();
                continue;
            }

            if let Err(e) = self.session(has_token) {
                if !self.stopped() {
                    debug!("discord session ended: {e:#}");
                }
            }
            if self.stopped() {
                break;
            }
            self.sleep_backoff();
        }
        info!("discord manager stopped");
    }

    /// Holds NO pipe until authorize is requested or shutdown: an idle
    /// unauthenticated pipe gets frozen by Discord (used to eat every AUTHORIZE).
    fn idle_until_authorize(&self) {
        while !self.stopped() {
            self.drain_commands();
            if self.want_authorize.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    /// Connect, handshake, authenticate immediately (no idle gap, Discord
    /// freezes idle unauthenticated pipes), serve. `Err` triggers a reconnect.
    fn session(&self, has_token: bool) -> anyhow::Result<()> {
        self.reset.store(false, Ordering::Relaxed);
        self.set_status(DiscordStatus::Connecting);

        let conn = match Connection::connect() {
            Ok(c) => c,
            Err(e) => {
                self.set_status(DiscordStatus::DiscordNotRunning);
                return Err(e);
            }
        };
        debug!("discord: pipe connected, handshaking");
        self.handshake(&conn)?;
        debug!("discord: handshake complete");

        // authenticate now, within milliseconds of READY
        let expires_at = if has_token {
            self.auth_with_token(&conn)?
        } else {
            // consume the Connect flag, AUTHORIZE now before Discord can freeze it
            self.want_authorize.store(false, Ordering::Relaxed);
            self.authorize_and_auth(&conn)?
        };
        info!("discord: session ready, tracking voice state");

        self.serve(&conn, expires_at)
    }

    /// Poll voice, refresh before expiry, answer pings, honor commands until
    /// the connection drops or a disconnect/reset/shutdown is requested.
    fn serve(&self, conn: &Connection, mut expires_at: Instant) -> anyhow::Result<()> {
        let mut next_poll = Instant::now();
        // transient failures back off on their own schedule; token stays valid REFRESH_SLACK longer
        let mut next_refresh_attempt = Instant::now();
        let mut refresh_backoff = REFRESH_RETRY_MIN;
        loop {
            self.drain_commands();
            if self.stopped() || self.reset.swap(false, Ordering::Relaxed) {
                return Ok(());
            }

            if Instant::now() + REFRESH_SLACK >= expires_at && Instant::now() >= next_refresh_attempt {
                match self.reauth(conn) {
                    Ok(exp) => {
                        expires_at = exp;
                        refresh_backoff = REFRESH_RETRY_MIN;
                    }
                    Err(TokenError::InvalidGrant) => {
                        // token dead: re-arm the prompt so the next loop asks again
                        TokenStore::clear(&self.config_dir);
                        self.rearm_auto_authorize();
                        return Ok(());
                    }
                    Err(TokenError::Transient(e)) => {
                        if Instant::now() >= expires_at {
                            // expired and unrefreshable, session can't continue
                            return Err(e);
                        }
                        warn!("discord: token refresh failed ({e:#}) — retrying in {refresh_backoff:?}");
                        next_refresh_attempt = Instant::now() + refresh_backoff;
                        refresh_backoff = (refresh_backoff * 2).min(REFRESH_RETRY_MAX);
                    }
                }
            }

            if Instant::now() >= next_poll {
                self.poll_voice(conn)?;
                next_poll = Instant::now() + POLL_INTERVAL;
            }

            match conn.frames.recv_timeout(Duration::from_millis(200)) {
                Ok((op, val)) => self.handle_async_frame(conn, op, &val)?,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
    }

    /// Send the handshake and wait for the `READY` dispatch.
    fn handshake(&self, conn: &Connection) -> anyhow::Result<()> {
        conn.send(
            OP_HANDSHAKE,
            &json!({ "v": 1, "client_id": CLIENT_ID }),
        )?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let rem = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| anyhow::anyhow!("handshake timed out"))?;
            match conn.frames.recv_timeout(rem) {
                Ok((op, val)) => {
                    if op == OP_PING {
                        let _ = conn.pong(&val);
                    } else if op == OP_CLOSE {
                        anyhow::bail!("pipe closed during handshake");
                    } else if val.get("evt").and_then(Value::as_str) == Some("READY") {
                        return Ok(());
                    }
                }
                Err(RecvTimeoutError::Timeout) => anyhow::bail!("handshake timed out"),
                Err(RecvTimeoutError::Disconnected) => anyhow::bail!("pipe closed during handshake"),
            }
        }
    }

    /// Prefers the cached access token so a plain reconnect never rotates
    /// the refresh token. Falls back to refresh if missing/near-expiry/rejected;
    /// on invalid-grant clears the store and re-arms the auto prompt.
    fn auth_with_token(&self, conn: &Connection) -> anyhow::Result<Instant> {
        let store = TokenStore::load(&self.config_dir);
        if let (Some(at), Some(exp)) = (store.access_token.clone(), store.expires_at) {
            let remaining = exp - oauth::now_unix();
            if remaining > REFRESH_SLACK.as_secs() as i64 {
                match self.authenticate(conn, &at) {
                    Ok(data) => {
                        self.mark_connected(&data, "cached");
                        return Ok(Instant::now() + Duration::from_secs(remaining as u64));
                    }
                    // revoked server-side while still unexpired, fall through to a real refresh
                    Err(ReqError::Rpc(d)) => {
                        warn!("discord: cached access token rejected ({d}) — refreshing")
                    }
                    Err(ReqError::Closed) => anyhow::bail!("pipe closed during AUTHENTICATE"),
                    Err(ReqError::Timeout) => anyhow::bail!("AUTHENTICATE timed out"),
                }
            }
        }
        info!("discord: refreshing stored token");
        match self.refresh_tokens() {
            Ok(tok) => self.finish_auth(conn, &tok),
            Err(TokenError::InvalidGrant) => {
                warn!("discord: stored token invalid — re-authorization needed");
                TokenStore::clear(&self.config_dir);
                self.rearm_auto_authorize();
                anyhow::bail!("stored token invalid")
            }
            Err(TokenError::Transient(e)) => Err(e),
        }
    }

    /// On invalid-grant, retries the previous refresh token once (Discord
    /// keeps it valid until its successor is used, rescuing a lost rotation).
    fn refresh_tokens(&self) -> Result<TokenResponse, TokenError> {
        let store = TokenStore::load(&self.config_dir);
        let Some(rt) = store.refresh_token.clone() else {
            return Err(TokenError::InvalidGrant);
        };
        match oauth::refresh(CLIENT_ID, &self.client_secret, &rt) {
            Ok(tok) => {
                self.commit_tokens(Some(&rt), &tok);
                Ok(tok)
            }
            Err(TokenError::InvalidGrant) => {
                let Some(prev) = store.prev_refresh_token.clone() else {
                    return Err(TokenError::InvalidGrant);
                };
                warn!("discord: refresh token rejected — retrying with the previous one");
                match oauth::refresh(CLIENT_ID, &self.client_secret, &prev) {
                    Ok(tok) => {
                        self.commit_tokens(Some(&prev), &tok);
                        info!("discord: previous refresh token rescued the grant");
                        Ok(tok)
                    }
                    Err(e) => Err(e),
                }
            }
            Err(e) => Err(e),
        }
    }

    /// AUTHORIZE (consent popup), exchange the code, then AUTHENTICATE.
    /// Must run promptly after the handshake.
    fn authorize_and_auth(&self, conn: &Connection) -> anyhow::Result<Instant> {
        info!("discord: sending AUTHORIZE — approve the popup in Discord");
        // recorded on the outcome not the send: a closed pipe means the dialog
        // likely never rendered, so it must not count toward the prompt-storm rate
        let code = match self.authorize(conn) {
            Ok(code) => {
                oauth::PromptLog::record(&self.config_dir);
                code
            }
            Err(e) => {
                if !matches!(e, ReqError::Closed) {
                    oauth::PromptLog::record(&self.config_dir);
                }
                match e {
                    ReqError::Rpc(d) => {
                        // invalid_scope means the account isn't rpc-allowlisted, persist and stop
                        // auto-prompting
                        if d.to_string().contains("invalid_scope") {
                            let reason = "Discord only lets invited accounts connect right now, \
                                and this account isn't invited yet. Turn off voice capture in \
                                settings, or ask on our Discord for a whitelist invite. \
                                Automatic prompts are paused; use Connect to retry.";
                            warn!("discord: {reason}");
                            oauth::AuthBlock::save(&self.config_dir, reason);
                        }
                        anyhow::bail!("AUTHORIZE rejected: {d}")
                    }
                    ReqError::Closed => anyhow::bail!("pipe closed during AUTHORIZE"),
                    ReqError::Timeout => {
                        anyhow::bail!("AUTHORIZE timed out (no user response)")
                    }
                }
            }
        };
        info!("discord: authorization code received — exchanging for token");
        match oauth::exchange_code(CLIENT_ID, &self.client_secret, &code, REDIRECT_URI) {
            Ok(tok) => {
                self.commit_tokens(None, &tok);
                self.finish_auth(conn, &tok)
            }
            Err(e) => {
                warn!("discord: token exchange failed: {e}");
                self.set_status(DiscordStatus::Error {
                    message: format!("authorization failed: {e}"),
                });
                anyhow::bail!("token exchange failed")
            }
        }
    }

    /// Raw `AUTHENTICATE` round-trip with an access token.
    fn authenticate(&self, conn: &Connection, access_token: &str) -> Result<Value, ReqError> {
        self.request(
            conn,
            "AUTHENTICATE",
            json!({ "access_token": access_token }),
            Duration::from_secs(10),
        )
    }

    /// Set Connected status from an AUTHENTICATE response.
    fn mark_connected(&self, data: &Value, scope: &str) {
        let user = data
            .get("user")
            .map(user_tag)
            .unwrap_or_else(|| "unknown".to_string());
        info!(%user, %scope, "discord: authenticated");
        self.set_status(DiscordStatus::Connected { user });
    }

    /// `AUTHENTICATE` with a fresh token pair, set Connected status, and
    /// return the token's expiry instant.
    fn finish_auth(&self, conn: &Connection, tok: &TokenResponse) -> anyhow::Result<Instant> {
        let data = match self.authenticate(conn, &tok.access_token) {
            Ok(d) => d,
            Err(ReqError::Closed) => anyhow::bail!("pipe closed during AUTHENTICATE"),
            Err(ReqError::Timeout) => anyhow::bail!("AUTHENTICATE timed out"),
            Err(ReqError::Rpc(d)) => anyhow::bail!("AUTHENTICATE rejected: {d}"),
        };
        self.mark_connected(&data, &tok.scope);
        Ok(Instant::now() + Duration::from_secs(tok.expires_in.max(60) as u64))
    }

    /// Refresh + re-authenticate mid-session to extend the connection.
    fn reauth(&self, conn: &Connection) -> Result<Instant, TokenError> {
        let tok = self.refresh_tokens()?;
        self.finish_auth(conn, &tok)
            .map_err(TokenError::Transient)
    }

    /// Long timeout, the user has to click the popup. Raw [`ReqError`] so the
    /// caller can tell a closed pipe from a decline or timeout.
    fn authorize(&self, conn: &Connection) -> Result<String, ReqError> {
        let args = json!({
            "client_id": CLIENT_ID,
            "scopes": ["rpc", "rpc.voice.read"],
        });
        let data = self.request(conn, "AUTHORIZE", args, Duration::from_secs(130))?;
        data.get("code")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| ReqError::Rpc(json!("AUTHORIZE returned no code")))
    }

    /// Query the current voice channel and update the shared roster.
    fn poll_voice(&self, conn: &Connection) -> anyhow::Result<()> {
        match self.request(
            conn,
            "GET_SELECTED_VOICE_CHANNEL",
            json!({}),
            Duration::from_secs(5),
        ) {
            Ok(data) => {
                *self.roster.lock() = parse_roster(&data);
                Ok(())
            }
            Err(ReqError::Rpc(d)) => {
                warn!("discord: voice query error: {d}");
                Ok(())
            }
            Err(ReqError::Closed) => anyhow::bail!("pipe closed during voice poll"),
            Err(ReqError::Timeout) => anyhow::bail!("voice poll timed out"),
        }
    }

    /// Idle between polls: answer pings, notice a close.
    fn handle_async_frame(&self, conn: &Connection, op: u32, val: &Value) -> anyhow::Result<()> {
        if op == OP_PING {
            let _ = conn.pong(val);
        } else if op == OP_CLOSE {
            anyhow::bail!("pipe closed");
        }
        Ok(())
    }

    /// Send a `FRAME` command and wait for the matching-nonce response
    /// answering pings while it waits.
    fn request(
        &self,
        conn: &Connection,
        cmd: &str,
        args: Value,
        timeout: Duration,
    ) -> Result<Value, ReqError> {
        let nonce = self.next_nonce();
        if conn.send_command(cmd, args, &nonce).is_err() {
            return Err(ReqError::Closed);
        }
        debug!("discord: -> sent '{cmd}' (nonce {nonce}), awaiting response");
        let deadline = Instant::now() + timeout;
        loop {
            let Some(rem) = deadline.checked_duration_since(Instant::now()) else {
                return Err(ReqError::Timeout);
            };
            match conn.frames.recv_timeout(rem) {
                Ok((op, val)) => {
                    if op == OP_PING {
                        let _ = conn.pong(&val);
                        continue;
                    }
                    if op == OP_CLOSE {
                        return Err(ReqError::Closed);
                    }
                    if val.get("nonce").and_then(Value::as_str) == Some(nonce.as_str()) {
                        if val.get("evt").and_then(Value::as_str) == Some("ERROR") {
                            return Err(ReqError::Rpc(
                                val.get("data").cloned().unwrap_or(Value::Null),
                            ));
                        }
                        return Ok(val.get("data").cloned().unwrap_or(Value::Null));
                    }
                    // some other dispatch/response, ignore and keep waiting
                }
                Err(RecvTimeoutError::Timeout) => return Err(ReqError::Timeout),
                Err(RecvTimeoutError::Disconnected) => return Err(ReqError::Closed),
            }
        }
    }

    // small helpers

    /// Persists BEFORE the tokens are used. `used_refresh` (None for a fresh
    /// code exchange) is kept as the fallback slot Discord still honors.
    fn commit_tokens(&self, used_refresh: Option<&str>, tok: &TokenResponse) {
        let store = TokenStore {
            refresh_token: tok
                .refresh_token
                .clone()
                .or_else(|| used_refresh.map(str::to_string)),
            access_token: Some(tok.access_token.clone()),
            expires_at: Some(oauth::now_unix() + tok.expires_in.max(60)),
            prev_refresh_token: used_refresh.map(str::to_string),
        };
        if let Err(e) = store.save(&self.config_dir) {
            warn!("discord: failed to persist tokens: {e:#}");
        }
    }

    /// A working grant died: re-arm the prompt like an unauthenticated start.
    /// The prompt log surfaces a runaway loop via the settings-toggle hint.
    fn rearm_auto_authorize(&self) {
        if self.auto_authorize && oauth::AuthBlock::load(&self.config_dir).is_none() {
            self.want_authorize.store(true, Ordering::Relaxed);
        }
    }

    fn drain_commands(&self) {
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            match cmd {
                Command::Authorize => {
                    // explicit Connect always gets a fresh attempt, even past an invalid_scope block
                    oauth::AuthBlock::clear(&self.config_dir);
                    self.want_authorize.store(true, Ordering::Relaxed);
                }
                Command::Disconnect => {
                    TokenStore::clear(&self.config_dir);
                    *self.roster.lock() = None;
                    self.want_authorize.store(false, Ordering::Relaxed);
                    self.reset.store(true, Ordering::Relaxed);
                    self.set_status(DiscordStatus::NeedsAuthorization);
                }
                Command::Shutdown => self.shutdown.store(true, Ordering::Relaxed),
            }
        }
    }

    /// Only a Connect arriving DURING the wait cuts it short; a flag already
    /// armed on entry still serves the full backoff, else it spins at 200ms.
    fn sleep_backoff(&self) {
        let armed_on_entry = self.want_authorize.load(Ordering::Relaxed);
        let mut waited = Duration::ZERO;
        while waited < RECONNECT_BACKOFF && !self.stopped() {
            std::thread::sleep(Duration::from_millis(200));
            waited += Duration::from_millis(200);
            self.drain_commands();
            if !armed_on_entry && self.want_authorize.load(Ordering::Relaxed) {
                break;
            }
        }
    }

    fn next_nonce(&self) -> String {
        format!("n{}", self.nonce.fetch_add(1, Ordering::Relaxed))
    }

    fn set_status(&self, s: DiscordStatus) {
        *self.status.lock() = s;
    }

    fn stopped(&self) -> bool {
        self.shutdown.load(Ordering::Relaxed)
    }
}

// parsing

/// Build a `user#tag`-ish label from an AUTHENTICATE user object.
fn user_tag(user: &Value) -> String {
    user.get("username")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

/// Custom avatar when set (`.gif` for `a_`-prefixed hashes, else `.png`)
/// else the default avatar. `size=128`, caller can swap it in the URL.
fn avatar_url(user: &Value) -> Option<String> {
    let id = user.get("id")?.as_str()?;
    if let Some(hash) = user.get("avatar").and_then(Value::as_str) {
        let ext = if hash.starts_with("a_") { "gif" } else { "png" };
        return Some(format!(
            "https://cdn.discordapp.com/avatars/{id}/{hash}.{ext}?size=128"
        ));
    }
    // discriminator "0" (migrated) indexes by (id >> 22) % 6, legacy by disc % 5
    let disc = user
        .get("discriminator")
        .and_then(Value::as_str)
        .unwrap_or("0");
    let index = if disc == "0" {
        (id.parse::<u64>().ok()? >> 22) % 6
    } else {
        disc.parse::<u64>().ok()? % 5
    };
    Some(format!("https://cdn.discordapp.com/embed/avatars/{index}.png"))
}

/// Turn a `GET_SELECTED_VOICE_CHANNEL` `data` object into a roster. `null`
/// data (not in a channel) yields `None`.
fn parse_roster(data: &Value) -> Option<CallRoster> {
    let obj = data.as_object()?;
    let channel_id = obj.get("id")?.as_str()?.to_string();
    let channel_name = obj
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let guild_id = obj
        .get("guild_id")
        .and_then(Value::as_str)
        .map(str::to_string);

    let mut participants = Vec::new();
    if let Some(states) = obj.get("voice_states").and_then(Value::as_array) {
        for vs in states {
            let user = vs.get("user");
            let Some(id) = user
                .and_then(|u| u.get("id"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            participants.push(Participant {
                id: id.to_string(),
                username: user
                    .and_then(|u| u.get("username"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                global_name: user
                    .and_then(|u| u.get("global_name"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                nick: vs.get("nick").and_then(Value::as_str).map(str::to_string),
                bot: user
                    .and_then(|u| u.get("bot"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                avatar_url: user.and_then(avatar_url),
            });
        }
    }
    Some(CallRoster {
        channel_id,
        channel_name,
        guild_id,
        participants,
    })
}
