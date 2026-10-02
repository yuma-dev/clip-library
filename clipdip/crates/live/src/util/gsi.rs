//! Valve Game State Integration, shared by CS2 and Dota 2: a cfg file in the
//! game's cfg folder makes the game POST its state as JSON to a localhost
//! url. The game reads the cfg at launch, so a freshly written one only
//! counts from the next start. Format per
//! https://developer.valvesoftware.com/wiki/Counter-Strike:_Global_Offensive_Game_State_Integration

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::Duration;

/// biggest body we read; full Dota payloads are ~20 KB
const MAX_BODY: usize = 512 * 1024;

/// Writes `gamestate_integration_cliplib.cfg` into `cfg_dir` unless it is
/// already there as is. `throttle` / `buffer` keep the game from posting more
/// than every few seconds; presence can't show faster anyway.
pub fn install_cfg(cfg_dir: &Path, port: u16, token: &str, data: &[&str]) -> std::io::Result<bool> {
    let mut body = String::new();
    body.push_str("\"ClipLib\"\n{\n");
    body.push_str(&format!("    \"uri\"       \"http://127.0.0.1:{port}/\"\n"));
    body.push_str("    \"timeout\"   \"5.0\"\n");
    body.push_str("    \"buffer\"    \"1.0\"\n");
    body.push_str("    \"throttle\"  \"5.0\"\n");
    body.push_str("    \"heartbeat\" \"60.0\"\n");
    body.push_str(&format!(
        "    \"auth\"\n    {{\n        \"token\" \"{token}\"\n    }}\n"
    ));
    body.push_str("    \"data\"\n    {\n");
    for d in data {
        body.push_str(&format!("        \"{d}\" \"1\"\n"));
    }
    body.push_str("    }\n}\n");

    let file = cfg_dir.join("gamestate_integration_cliplib.cfg");
    if std::fs::read_to_string(&file)
        .map(|s| s == body)
        .unwrap_or(false)
    {
        return Ok(false);
    }
    std::fs::create_dir_all(cfg_dir)?;
    std::fs::write(&file, body)?;
    Ok(true)
}

/// Listens on 127.0.0.1:`port`; each POST whose auth token matches lands on
/// the receiver as parsed JSON. Only the newest payload matters, so a full
/// queue drops instead of piling up. The accept thread dies with the helper.
pub fn listen(port: u16, token: &'static str) -> std::io::Result<Receiver<serde_json::Value>> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let (tx, rx) = mpsc::sync_channel(4);
    std::thread::Builder::new()
        .name("live-gsi".into())
        .spawn(move || {
            for conn in listener.incoming().flatten() {
                handle(conn, &tx, token);
            }
        })?;
    Ok(rx)
}

fn handle(mut conn: TcpStream, tx: &SyncSender<serde_json::Value>, token: &str) {
    let _ = conn.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = conn.set_write_timeout(Some(Duration::from_secs(3)));
    let Ok(clone) = conn.try_clone() else { return };
    let mut reader = BufReader::new(clone);
    let mut len = 0usize;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some((k, v)) = l.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
    }
    // the game waits for an answer before its next post
    let _ = conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    if len == 0 || len > MAX_BODY {
        return;
    }
    let mut body = vec![0u8; len];
    if reader.read_exact(&mut body).is_err() {
        return;
    }
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return;
    };
    if v.pointer("/auth/token").and_then(|t| t.as_str()) != Some(token) {
        return;
    }
    let _ = tx.try_send(v);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cfg_is_written_once() {
        let dir = std::env::temp_dir().join(format!("clipdip-gsi-{}", std::process::id()));
        assert!(install_cfg(&dir, 41871, "t", &["map", "player_id"]).unwrap());
        assert!(!install_cfg(&dir, 41871, "t", &["map", "player_id"]).unwrap());
        let s = std::fs::read_to_string(dir.join("gamestate_integration_cliplib.cfg")).unwrap();
        assert!(s.contains("http://127.0.0.1:41871/"));
        assert!(s.contains("\"map\" \"1\""));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn posts_reach_the_receiver() {
        let port = {
            let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            l.local_addr().unwrap().port()
        };
        let rx = listen(port, "t").unwrap();
        let body = r#"{"auth":{"token":"t"},"map":{"name":"de_dust2"}}"#;
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            s,
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
        let v = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(v["map"]["name"], "de_dust2");

        // a wrong token is dropped
        let body = r#"{"auth":{"token":"x"},"map":{"name":"de_inferno"}}"#;
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            s,
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
    }
}
