//! OAuth2 tokens for the RPC connection: privileged commands need `rpc` +
//! `rpc.voice.read`, obtained once via AUTHORIZE, refreshed silently.
//! Persists access token (~7d) and prev refresh token to survive a lost rotation.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

const TOKEN_ENDPOINT: &str = "https://discord.com/api/oauth2/token";

/// Real timeouts so a stalled call errors out (retryable) instead of
/// wedging the manager thread (and UI) on "Connecting..." forever.
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

/// Wall-clock unix seconds; instants don't survive restarts, so persisted state uses this.
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// access_token+expires_at let a reconnect AUTHENTICATE without hitting the
/// token endpoint. prev_refresh_token recovers a rotation lost before it saved.
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

/// Consent-popup timestamps + last hint-shown time. Separate file so UI
/// hint writes never race a token-store write.
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

    /// Prunes entries older than a week; collapses one within 60s of the last
    /// so an update's double-started process doesn't count as two popups.
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

/// Marks AUTHORIZE as pointless after Discord's invalid_scope (account not
/// on the App Testers allowlist). Cleared by manual Connect or an app update.
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

    /// Current block, if any; one from a different app version is stale and gets removed.
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

/// Distinguishes a dead refresh token (re-authorize) from a transient
/// network hiccup (just retry).
#[derive(Debug)]
pub enum TokenError {
    /// invalid_grant: refresh token revoked/reset, user must re-authorize.
    InvalidGrant,
    /// Anything else (network, 5xx, parse): retry as-is.
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
        // Only 400 + error=="invalid_grant" means the grant is dead. Anything else
        // (invalid_client, 429, 5xx) must not trigger re-auth or we'd toss a working grant.
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
