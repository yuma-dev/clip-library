//! OAuth2 token handling for the RPC connection.
//!
//! The RPC handshake proves *which app* is connecting; to call privileged
//! commands (reading the voice channel) we additionally need an access
//! token whose scopes include `rpc` + `rpc.voice.read`. That token is
//! obtained once via the `AUTHORIZE` popup (a `code` we exchange here for a
//! token), then refreshed silently forever. Only the refresh token is
//! persisted — access tokens are short-lived (7 days) and always
//! re-minted at startup.

use std::path::{Path, PathBuf};
use std::time::Duration;

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

/// Persisted between runs. Only the refresh token needs to survive — it's
/// the one durable credential; everything else is derived from it at
/// startup.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TokenStore {
    pub refresh_token: Option<String>,
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
        // 4xx: read the body to classify. `invalid_grant` is the one we
        // must treat as "re-authorize"; other 400s are also unrecoverable
        // as-is but re-auth is the safe recovery for all of them.
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            if body.contains("invalid_grant") {
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
