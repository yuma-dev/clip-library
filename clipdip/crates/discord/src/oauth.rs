//! OAuth2 token handling for the RPC connection.
//!
//! The RPC handshake proves *which app* is connecting; to call privileged
//! commands (reading the voice channel) we additionally need an access
//! token whose scopes include `rpc` + `rpc.voice.read`. That token is
//! obtained once via the `AUTHORIZE` popup (a `code` we exchange here for a
//! token), then refreshed silently forever. The whole token pair is
//! persisted: the access token (valid ~7 days) so reconnects can
//! AUTHENTICATE without touching the token endpoint at all, and the
//! refresh token plus its predecessor so a rotation lost mid-flight
//! (crash, dropped response) can be recovered instead of stranding the
//! install in re-authorization.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

const TOKEN_ENDPOINT: &str = "https://discord.com/api/oauth2/token";

/// A ureq agent with real timeouts, so a stalled network call surfaces as an
/// error (retryable) instead of wedging the manager thread — and the UI —
/// on "Connecting…" forever.
fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
}

/// Discord's token response (the fields we use).
#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: i64,
    #[serde(default)]
    pub scope: String,
}

/// Wall-clock now as unix seconds. Instants don't survive restarts, so
/// everything persisted uses this.
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Persisted between runs. The access token + expiry let a reconnect (or a
/// PC restart) AUTHENTICATE without hitting the token endpoint, so the
/// refresh token is only rotated near expiry. `prev_refresh_token` is the
/// last refresh token that was used successfully — Discord keeps it valid
/// until its successor is used, so it recovers a rotation whose response
/// never made it to disk.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TokenStore {
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub access_token: Option<String>,
    /// Unix-seconds expiry of `access_token`.
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub prev_refresh_token: Option<String>,
}

impl TokenStore {
    fn path(config_dir: &Path) -> PathBuf {
        config_dir.join("discord_tokens.json")
    }

    pub fn load(config_dir: &Path) -> Self {
        match std::fs::read_to_string(Self::path(config_dir)) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, config_dir: &Path) -> Result<()> {
        std::fs::create_dir_all(config_dir).ok();
        let body = serde_json::to_string_pretty(self)?;
        let path = Self::path(config_dir);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body).with_context(|| format!("write {}", tmp.display()))?;
        std::fs::rename(&tmp, &path).with_context(|| format!("rename into {}", path.display()))?;
        Ok(())
    }

    pub fn clear(config_dir: &Path) {
        let _ = std::fs::remove_file(Self::path(config_dir));
    }
}

/// Rolling log of consent-popup (AUTHORIZE) firings, plus when the "you
/// can turn this off" overlay hint was last shown. Kept in its own file so
/// hint bookkeeping (written from the app's UI side) can never race a
/// token-rotation write to the token store.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PromptLog {
    /// Unix-seconds timestamps of consent popups, pruned to the last week.
    #[serde(default)]
    pub prompt_times: Vec<i64>,
    #[serde(default)]
    pub hint_shown_at: Option<i64>,
}

impl PromptLog {
    fn path(config_dir: &Path) -> PathBuf {
        config_dir.join("discord_prompts.json")
    }

    pub fn load(config_dir: &Path) -> Self {
        match std::fs::read_to_string(Self::path(config_dir)) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, config_dir: &Path) -> Result<()> {
        std::fs::create_dir_all(config_dir).ok();
        let body = serde_json::to_string_pretty(self)?;
        let path = Self::path(config_dir);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body).with_context(|| format!("write {}", tmp.display()))?;
        std::fs::rename(&tmp, &path).with_context(|| format!("rename into {}", path.display()))?;
        Ok(())
    }

    /// Record one consent popup, pruning entries older than a week. A record
    /// within a minute of the previous one collapses into it: an update
    /// restart can double-start the process and both halves AUTHORIZE, which
    /// is one popup to the user, not two.
    pub fn record(config_dir: &Path) {
        let mut log = Self::load(config_dir);
        let now = now_unix();
        log.prompt_times.retain(|t| now - *t <= 7 * 24 * 3600);
        if log.prompt_times.iter().max().is_some_and(|t| now - *t < 60) {
            return;
        }
        log.prompt_times.push(now);
        let _ = log.save(config_dir);
    }
}

/// Persisted marker that AUTHORIZE is pointless right now: Discord rejected
/// the requested scopes (`invalid_scope`), which for this app means the
/// account isn't on the App Testers allowlist (the `rpc` scope is gated).
/// While present, auto-authorize stays quiet instead of popping a doomed
/// consent dialog on every launch. Cleared by a manual Connect, and ignored
/// once the app version changes — an update (or Discord-side approval)
/// deserves one fresh attempt.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AuthBlock {
    pub reason: String,
    #[serde(default)]
    pub at: i64,
    #[serde(default)]
    pub app_version: String,
}

impl AuthBlock {
    fn path(config_dir: &Path) -> PathBuf {
        config_dir.join("discord_auth_block.json")
    }

    /// The block currently in force, if any. A block written by a different
    /// app version is stale and reads as absent (and is removed).
    pub fn load(config_dir: &Path) -> Option<Self> {
        let s = std::fs::read_to_string(Self::path(config_dir)).ok()?;
        let block: Self = serde_json::from_str(&s).ok()?;
        if block.app_version != env!("CARGO_PKG_VERSION") {
            Self::clear(config_dir);
            return None;
        }
        Some(block)
    }

    pub fn save(config_dir: &Path, reason: &str) {
        let block = Self {
            reason: reason.to_string(),
            at: now_unix(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        };
        std::fs::create_dir_all(config_dir).ok();
        if let Ok(body) = serde_json::to_string_pretty(&block) {
            let _ = std::fs::write(Self::path(config_dir), body);
        }
    }

    pub fn clear(config_dir: &Path) {
        let _ = std::fs::remove_file(Self::path(config_dir));
    }
}

/// Distinguish "the refresh token is dead, must re-authorize" from a
/// transient network hiccup, so the manager knows whether to prompt the
/// user again or just retry later.
#[derive(Debug)]
pub enum TokenError {
    /// `invalid_grant` — the refresh token was revoked or reset. The user
    /// must authorize again.
    InvalidGrant,
    /// Anything else (network, 5xx, parse) — worth retrying as-is.
    Transient(anyhow::Error),
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TokenError::InvalidGrant => write!(f, "refresh token rejected (invalid_grant)"),
            TokenError::Transient(e) => write!(f, "{e:#}"),
        }
    }
}

/// Exchange an authorization `code` (from the RPC `AUTHORIZE` step) for a
/// token pair.
pub fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, TokenError> {
    post_token(&[
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
    ])
}

/// Silently mint a fresh access token (and rotated refresh token) from a
/// stored refresh token.
pub fn refresh(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<TokenResponse, TokenError> {
    post_token(&[
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ])
}

fn post_token(form: &[(&str, &str)]) -> Result<TokenResponse, TokenError> {
    let resp = agent().post(TOKEN_ENDPOINT).send_form(form);
    match resp {
        Ok(r) => r
            .into_json::<TokenResponse>()
            .map_err(|e| TokenError::Transient(anyhow!("parse token response: {e}"))),
        // Only a 400 whose JSON error field is exactly `invalid_grant`
        // means the grant is dead. Anything else — invalid_client (build
        // problem), 429 (rate limit), 5xx, or an error message that merely
        // mentions the string — must NOT be treated as "re-authorize":
        // clearing the store for those throws away a working grant.
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            let error_code = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string));
            if code == 400 && error_code.as_deref() == Some("invalid_grant") {
                Err(TokenError::InvalidGrant)
            } else {
                Err(TokenError::Transient(anyhow!(
                    "token endpoint returned {code}: {body}"
                )))
            }
        }
        Err(e) => Err(TokenError::Transient(anyhow!("token request failed: {e}"))),
    }
}
