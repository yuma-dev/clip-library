//! Riot lockfiles: `name:pid:port:password:protocol`, written by the League
//! client (in its install folder) and the Riot Client
//! (`%LOCALAPPDATA%\Riot Games\Riot Client\Config\lockfile`).

use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub struct Lockfile {
    pub name: String,
    pub pid: u32,
    pub port: u16,
    pub password: String,
    pub protocol: String,
}

impl Lockfile {
    pub fn parse(raw: &str) -> Option<Lockfile> {
        let mut it = raw.trim().split(':');
        Some(Lockfile {
            name: it.next()?.to_string(),
            pid: it.next()?.parse().ok()?,
            port: it.next()?.parse().ok()?,
            password: it.next()?.to_string(),
            protocol: it.next()?.to_string(),
        })
    }

    /// The lockfile is held open by the client; a shared read works.
    pub fn read(path: &Path) -> Option<Lockfile> {
        Self::parse(&std::fs::read_to_string(path).ok()?)
    }

    pub fn base_url(&self) -> String {
        format!("{}://127.0.0.1:{}", self.protocol, self.port)
    }

    pub fn auth(&self) -> String {
        super::http::basic_auth("riot", &self.password)
    }
}

pub fn riot_client_lockfile() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(base)
            .join("Riot Games")
            .join("Riot Client")
            .join("Config")
            .join("lockfile"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lockfile() {
        let l = Lockfile::parse("LeagueClient:1234:56789:pw-x:https").unwrap();
        assert_eq!(l.port, 56789);
        assert_eq!(l.base_url(), "https://127.0.0.1:56789");
        assert!(Lockfile::parse("broken").is_none());
    }
}
