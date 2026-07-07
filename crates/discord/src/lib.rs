//! Capture the Discord voice-call roster at clip time — no server bot.
//!
//! Connects to the Discord desktop client's **local RPC** over a named
//! pipe and keeps a background connection warm. After a one-time
//! `AUTHORIZE` consent (triggered from the UI, never on the clip hotkey),
//! the manager thread refreshes its OAuth token silently forever and polls
//! `GET_SELECTED_VOICE_CHANNEL` so the current call's participant IDs are
//! always a lock away. The clip save flow snapshots [`DiscordHandle::roster`]
//! at the hotkey moment and writes it into the clip's metadata sidecar.
//!
//! Credentials: the app's public client id is compiled in; the client
//! secret must be provided at build time via `CLIPDIP_DISCORD_CLIENT_SECRET`
//! (or the same env var at runtime for dev). With no secret the whole
//! feature reports [`DiscordStatus::Disabled`] and does nothing.
//!
//! Distribution note: the `rpc` scope is allowlist-gated by Discord. It
//! works for the app owner and anyone added under **App Testers**; shipping
//! to arbitrary users needs Discord to approve the app for RPC.

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

/// The app's OAuth2 client id (public — safe to compile in).
const CLIENT_ID: &str = "1523640943218000042";
/// Must match a redirect registered on the app; the value is never
/// actually navigated to, it only has to match at token-exchange time.
const REDIRECT_URI: &str = "http://localhost";
/// How often the warm connection re-queries the current voice channel.
/// The hotkey reads the last snapshot, so this bounds its staleness — 2s
/// is plenty for "who was in the call".
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Reconnect delay after the pipe drops or Discord is closed.
const RECONNECT_BACKOFF: Duration = Duration::from_secs(3);
/// Refresh the access token this long before it expires, so a poll never
/// races an expiry.
const REFRESH_SLACK: Duration = Duration::from_secs(6 * 3600);

// ---------- public types --------------------------------------------------

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
    /// Ready-to-use CDN URL for the member's avatar (animated `.gif` when
    /// applicable, else `.png`), or their default avatar when they have
    /// none set. `None` only if the id couldn't be parsed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

impl Participant {
    /// Best display label: server nick → global (display) name → username.
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
    /// No client secret compiled in — feature off.
    Disabled,
    /// Establishing the pipe / authenticating.
    Connecting,
    /// Discord isn't running (no IPC pipe).
    DiscordNotRunning,
    /// Connected but not yet authorized — the UI should offer "Connect".
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
}

/// Spawn the background manager. Always returns a usable handle; if no
/// client secret is available the handle simply reports `Disabled`.
pub fn spawn(config_dir: PathBuf) -> DiscordHandle {
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
        };
    };

    let mgr = Manager {
        config_dir,
        client_secret: secret,
        roster: Arc::clone(&roster),
        status: Arc::clone(&status),
        cmd_rx,
        nonce: AtomicU64::new(0),
        want_authorize: AtomicBool::new(false),
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

// ---------- manager -------------------------------------------------------

enum Command {
    Authorize,
    Disconnect,
    Shutdown,
}

/// Local result type for an RPC request/response round-trip.
enum ReqError {
    /// The pipe closed (Discord quit / connection dropped) — reconnect.
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
            // Discord stops servicing an idle, un-authenticated RPC connection
            // after ~15s. So with no token we must NOT hold a live pipe waiting
            // for the user — we idle here with NO connection until they click
            // Connect, then open a fresh pipe and AUTHORIZE within milliseconds
            // of the handshake (see `session`).
            if !has_token && !self.want_authorize.load(Ordering::Relaxed) {
                self.set_status(DiscordStatus::NeedsAuthorization);
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

    /// Wait — holding NO pipe — until the user requests authorization or the
    /// manager is shut down. Holding no connection is the whole point: an
    /// idle un-authenticated RPC connection gets frozen by Discord, which is
    /// what silently ate every AUTHORIZE before this restructure.
    fn idle_until_authorize(&self) {
        while !self.stopped() {
            self.drain_commands();
            if self.want_authorize.load(Ordering::Relaxed) {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    /// One connection lifetime: connect → handshake → authenticate → serve.
    /// Authentication happens *immediately* after the handshake (no idle
    /// gap), because Discord freezes an un-authenticated connection that sits
    /// idle. Returns `Err` on any disconnect/failure so `run` reconnects.
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

        // Authenticate now, within milliseconds of READY.
        let expires_at = if has_token {
            self.auth_with_token(&conn)?
        } else {
            // A Connect was requested — consume the flag and AUTHORIZE on this
            // fresh connection right away, before Discord can freeze it.
            self.want_authorize.store(false, Ordering::Relaxed);
            self.authorize_and_auth(&conn)?
        };
        info!("discord: session ready, tracking voice state");

        self.serve(&conn, expires_at)
    }

    /// Steady-state loop: poll the voice channel, refresh before expiry,
    /// answer pings, honor commands. Returns when the connection drops, a
    /// disconnect/reset is requested, or the manager shuts down.
    fn serve(&self, conn: &Connection, mut expires_at: Instant) -> anyhow::Result<()> {
        let mut next_poll = Instant::now();
        loop {
            self.drain_commands();
            if self.stopped() || self.reset.swap(false, Ordering::Relaxed) {
                return Ok(());
            }

            if Instant::now() + REFRESH_SLACK >= expires_at {
                match self.reauth(conn) {
                    Ok(exp) => expires_at = exp,
                    Err(TokenError::InvalidGrant) => {
                        // Token dead — drop to needs-auth by ending the
                        // session; the next loop finds no token and idles.
                        TokenStore::clear(&self.config_dir);
                        return Ok(());
                    }
                    Err(TokenError::Transient(e)) => return Err(e),
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

    /// Refresh the stored token and AUTHENTICATE. On invalid-grant, clears
    /// the token and errors so `run` falls back to needs-authorization.
    fn auth_with_token(&self, conn: &Connection) -> anyhow::Result<Instant> {
        let rt = TokenStore::load(&self.config_dir)
            .refresh_token
            .ok_or_else(|| anyhow::anyhow!("no refresh token"))?;
        info!("discord: refreshing stored token");
        match oauth::refresh(CLIENT_ID, &self.client_secret, &rt) {
            Ok(tok) => {
                self.persist_refresh(&tok);
                self.finish_auth(conn, &tok)
            }
            Err(TokenError::InvalidGrant) => {
                warn!("discord: stored token invalid — re-authorization needed");
                TokenStore::clear(&self.config_dir);
                anyhow::bail!("stored token invalid")
            }
            Err(TokenError::Transient(e)) => Err(e),
        }
    }

    /// Fresh authorization on a just-handshaked connection: AUTHORIZE (shows
    /// the consent popup), exchange the code, then AUTHENTICATE. Must run
    /// promptly after the handshake — that's the whole fix.
    fn authorize_and_auth(&self, conn: &Connection) -> anyhow::Result<Instant> {
        info!("discord: sending AUTHORIZE — approve the popup in Discord");
        let code = self.authorize(conn)?;
        info!("discord: authorization code received — exchanging for token");
        match oauth::exchange_code(CLIENT_ID, &self.client_secret, &code, REDIRECT_URI) {
            Ok(tok) => {
                self.persist_refresh(&tok);
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

    /// `AUTHENTICATE` with an access token, set Connected status, and return
    /// the token's expiry instant.
    fn finish_auth(&self, conn: &Connection, tok: &TokenResponse) -> anyhow::Result<Instant> {
        let data = match self.request(
            conn,
            "AUTHENTICATE",
            json!({ "access_token": tok.access_token }),
            Duration::from_secs(10),
        ) {
            Ok(d) => d,
            Err(ReqError::Closed) => anyhow::bail!("pipe closed during AUTHENTICATE"),
            Err(ReqError::Timeout) => anyhow::bail!("AUTHENTICATE timed out"),
            Err(ReqError::Rpc(d)) => anyhow::bail!("AUTHENTICATE rejected: {d}"),
        };
        let user = data
            .get("user")
            .map(user_tag)
            .unwrap_or_else(|| "unknown".to_string());
        info!(%user, scope = %tok.scope, "discord: authenticated");
        self.set_status(DiscordStatus::Connected { user });
        Ok(Instant::now() + Duration::from_secs(tok.expires_in.max(60) as u64))
    }

    /// Refresh + re-authenticate mid-session to extend the connection.
    fn reauth(&self, conn: &Connection) -> Result<Instant, TokenError> {
        let store = TokenStore::load(&self.config_dir);
        let rt = store.refresh_token.ok_or(TokenError::InvalidGrant)?;
        let tok = oauth::refresh(CLIENT_ID, &self.client_secret, &rt)?;
        self.persist_refresh(&tok);
        self.finish_auth(conn, &tok)
            .map_err(TokenError::Transient)
    }

    /// Send `AUTHORIZE` and return the resulting `code`. Long timeout — the
    /// user has to click the consent popup.
    fn authorize(&self, conn: &Connection) -> anyhow::Result<String> {
        let args = json!({
            "client_id": CLIENT_ID,
            "scopes": ["rpc", "rpc.voice.read"],
        });
        match self.request(conn, "AUTHORIZE", args, Duration::from_secs(130)) {
            Ok(data) => data
                .get("code")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| anyhow::anyhow!("AUTHORIZE returned no code")),
            Err(ReqError::Rpc(d)) => anyhow::bail!("AUTHORIZE rejected: {d}"),
            Err(ReqError::Closed) => anyhow::bail!("pipe closed during AUTHORIZE"),
            Err(ReqError::Timeout) => anyhow::bail!("AUTHORIZE timed out (no user response)"),
        }
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

    /// Send a `FRAME` command and wait for the matching-nonce response,
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
                    // Some other dispatch/response — ignore and keep waiting.
                }
                Err(RecvTimeoutError::Timeout) => return Err(ReqError::Timeout),
                Err(RecvTimeoutError::Disconnected) => return Err(ReqError::Closed),
            }
        }
    }

    // ----- small helpers --------------------------------------------------

    fn persist_refresh(&self, tok: &TokenResponse) {
        if let Some(rt) = &tok.refresh_token {
            let store = TokenStore {
                refresh_token: Some(rt.clone()),
            };
            if let Err(e) = store.save(&self.config_dir) {
                warn!("discord: failed to persist refresh token: {e:#}");
            }
        }
    }

    fn drain_commands(&self) {
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            match cmd {
                Command::Authorize => self.want_authorize.store(true, Ordering::Relaxed),
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

    /// Sleep before reconnecting, but wake early if the user acts.
    fn sleep_backoff(&self) {
        let mut waited = Duration::ZERO;
        while waited < RECONNECT_BACKOFF && !self.stopped() {
            std::thread::sleep(Duration::from_millis(200));
            waited += Duration::from_millis(200);
            self.drain_commands();
            if self.want_authorize.load(Ordering::Relaxed) {
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

// ---------- parsing -------------------------------------------------------

/// Build a `user#tag`-ish label from an AUTHENTICATE user object.
fn user_tag(user: &Value) -> String {
    user.get("username")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

/// Build the Discord CDN avatar URL for a user object. Uses the custom
/// avatar when set (animated `.gif` for `a_`-prefixed hashes, else `.png`),
/// otherwise the appropriate default avatar. `size=128` is a reasonable
/// default the caller can swap in the URL if it wants a different one.
fn avatar_url(user: &Value) -> Option<String> {
    let id = user.get("id")?.as_str()?;
    if let Some(hash) = user.get("avatar").and_then(Value::as_str) {
        let ext = if hash.starts_with("a_") { "gif" } else { "png" };
        return Some(format!(
            "https://cdn.discordapp.com/avatars/{id}/{hash}.{ext}?size=128"
        ));
    }
    // Default avatar. Post-username-migration accounts have discriminator
    // "0" and index by (id >> 22) % 6; legacy accounts use discriminator % 5.
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
