//! ureq agents. Short timeouts everywhere: a slow answer is a skipped update,
//! never a stuck helper.

use std::sync::Arc;
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

pub const USER_AGENT: &str = concat!(
    "yuma-dev/clipdip/",
    env!("CARGO_PKG_VERSION"),
    " (cliplib.app)"
);

/// For public APIs (Data Dragon, valorant-api.com, Modrinth).
pub fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .user_agent(USER_AGENT)
        .build()
}

/// For Riot's local APIs on 127.0.0.1, which serve a cert from Riot's own
/// root. Any cert is accepted, so only ever point this at loopback.
pub fn loopback_agent() -> ureq::Agent {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map(|b| {
            b.dangerous()
                .with_custom_certificate_verifier(Arc::new(AnyCert(provider)))
                .with_no_client_auth()
        });
    let mut b = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout(Duration::from_secs(3))
        .user_agent(USER_AGENT);
    if let Ok(config) = config {
        b = b.tls_config(Arc::new(config));
    }
    b.build()
}

#[derive(Debug)]
struct AnyCert(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// GET as JSON, None on any failure.
pub fn get_json<T: serde::de::DeserializeOwned>(agent: &ureq::Agent, url: &str) -> Option<T> {
    agent.get(url).call().ok()?.into_json().ok()
}

/// Basic auth header value for `riot:<password>` style local APIs.
pub fn basic_auth(user: &str, password: &str) -> String {
    use base64::Engine;
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"))
    )
}
