//! Blocking HTTPS calls to the Clipdip diagnostics server.
//!
//! Only ever driven from the single manager thread, so no internal locking. The
//! contract (from the server's OpenAPI): every write carries `X-Clipdip-Key`;
//! heartbeat/events must be `application/json` (form-encoded is rejected 400);
//! 429 carries a retry hint; other 4xx are permanent (fix the payload, never
//! retry); 5xx / transport errors are retryable with backoff.

use crate::{bundle, ServerConfig};
use std::time::Duration;

/// What to do with a batch of events after a send attempt.
pub enum SendOutcome {
    /// Server accepted them — drop from the queue.
    Accepted,
    /// Permanent client error (e.g. 400). Drop them too; retrying can't help
    /// and would wedge the queue behind a poison payload.
    Drop,
    /// Transient failure — keep the events and retry after the given delay
    /// (from `Retry-After` when present, else the caller's backoff).
    Retry(Option<Duration>),
}

pub struct HttpClient {
    agent: ureq::Agent,
    base: String,
    key: String,
    install_id: String,
    app_version: String,
}

impl HttpClient {
    pub fn new(base: String, key: String, install_id: String, app_version: String) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .build();
        Self {
            agent,
            base: base.trim_end_matches('/').to_string(),
            key,
            install_id,
            app_version,
        }
    }

    /// POST /v1/heartbeat — records the beat and returns the current config
    /// (log-level override, min supported version). Errors are swallowed by the
    /// caller and simply retried on the next tick.
    pub fn heartbeat(&self) -> anyhow::Result<ServerConfig> {
        let body = serde_json::json!({
            "install_id": self.install_id,
            "app_version": self.app_version,
        });
        let resp = self
            .agent
            .post(&format!("{}/v1/heartbeat", self.base))
            .set("X-Clipdip-Key", &self.key)
            .set("Content-Type", "application/json")
            .send_string(&body.to_string())
            .map_err(|e| anyhow::anyhow!("heartbeat: {e}"))?;
        let cfg: ServerConfig = resp
            .into_json()
            .map_err(|e| anyhow::anyhow!("heartbeat decode: {e}"))?;
        Ok(cfg)
    }

    /// POST /v1/events — batch (already ≤100). Classifies the response into a
    /// [`SendOutcome`] so the manager knows whether to drop or retry.
    pub fn send_events(&self, batch: &[serde_json::Value]) -> SendOutcome {
        let body = match serde_json::to_string(batch) {
            Ok(b) => b,
            // Can't even serialize our own queue lines — drop them, they're
            // unrecoverable.
            Err(_) => return SendOutcome::Drop,
        };
        let result = self
            .agent
            .post(&format!("{}/v1/events", self.base))
            .set("X-Clipdip-Key", &self.key)
            .set("Content-Type", "application/json")
            .send_string(&body);

        match result {
            Ok(_) => SendOutcome::Accepted,
            Err(ureq::Error::Status(code, resp)) => {
                if code == 429 {
                    SendOutcome::Retry(retry_after(&resp))
                } else if (400..500).contains(&code) {
                    // Permanent (bad payload / bad key). Don't loop on it.
                    tracing::warn!("diagnostics: events rejected {code}, dropping batch");
                    SendOutcome::Drop
                } else {
                    SendOutcome::Retry(None)
                }
            }
            Err(_transport) => SendOutcome::Retry(None),
        }
    }

    /// POST /v1/bundles — multipart upload of the diagnostic zip. Returns the
    /// server-assigned bundle id on success.
    pub fn upload_bundle(&self, note: Option<String>, source: &str) -> Result<i64, String> {
        let zip = bundle::build_zip(&self.install_id, &self.app_version)
            .map_err(|e| format!("build bundle: {e}"))?;

        let boundary = format!("----clipdip{}", uuid::Uuid::new_v4().simple());
        let mut body: Vec<u8> = Vec::with_capacity(zip.len() + 512);

        text_field(&mut body, &boundary, "install_id", &self.install_id);
        text_field(&mut body, &boundary, "app_version", &self.app_version);
        text_field(&mut body, &boundary, "source", source);
        if let Some(n) = note.as_deref().filter(|n| !n.is_empty()) {
            text_field(&mut body, &boundary, "user_note", n);
        }
        file_field(&mut body, &boundary, "file", "clipdip-diagnostics.zip", &zip);
        // Closing boundary.
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

        let content_type = format!("multipart/form-data; boundary={boundary}");
        // Bundles can be several MB — give the upload a longer ceiling than the
        // shared agent's default.
        let resp = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .post(&format!("{}/v1/bundles", self.base))
            .set("X-Clipdip-Key", &self.key)
            .set("Content-Type", &content_type)
            .send_bytes(&body)
            .map_err(|e| format!("upload: {e}"))?;

        let v: serde_json::Value = resp.into_json().map_err(|e| format!("decode: {e}"))?;
        v.get("bundle_id")
            .and_then(|b| b.as_i64())
            .ok_or_else(|| "server did not return a bundle_id".to_string())
    }
}

/// Parse a `Retry-After` header (delta-seconds form) into a duration.
fn retry_after(resp: &ureq::Response) -> Option<Duration> {
    resp.header("Retry-After")
        .and_then(|h| h.trim().parse::<u64>().ok())
        .map(Duration::from_secs)
}

fn text_field(body: &mut Vec<u8>, boundary: &str, name: &str, value: &str) {
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        )
        .as_bytes(),
    );
}

fn file_field(body: &mut Vec<u8>, boundary: &str, name: &str, filename: &str, bytes: &[u8]) {
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; \
             filename=\"{filename}\"\r\nContent-Type: application/zip\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n");
}
