//! Stage time and distance from EA SPORTS WRC's standard UDP packet.
//! Layout from EA's UDP Telemetry Guide and generated readme/udp/wrc.json,
//! readme/channels.json (docs), https://forums.ea.com/discussions/wrc-general-discussion-en/13178407

use crate::util::shm::{f32_at, f64_at};
use crate::util::{art, clamp, exe_name};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};
use serde_json::{json, Value};
use std::io::Write;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const PORT: u16 = 20888;
pub static MANIFEST: Manifest = Manifest {
    id: "ea_wrc", name: "EA SPORTS WRC", blurb: "Shows your stage time and distance covered.",
    setup: Some("ClipLib adds a local telemetry endpoint. It works from the next start of WRC."),
    credits: &[Credit { project: "EA SPORTS WRC UDP Telemetry Guide", author: "Electronic Arts", url: "https://forums.ea.com/t5/s/tghpe58374/attachments/tghpe58374/wrc-general-discussion-en/2667/1/EA%20SPORTS%20WRC%20-%20UDP%20Telemetry%20Guide%20(v1.3).pdf", license: "docs" }],
    options: &[Opt::toggle("show_time", "Show stage time", "Elapsed time on the stage.", true),
        Opt::toggle("show_distance", "Show distance", "Distance covered and total stage length.", true)],
    matches, run, priority: 10, game_ids: &["1169017999999643790", "1445225039455850548"],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/1849250/header.jpg"),
    preview, scenarios: &[("menu", "In the menus"), ("ready", "At the start"), ("stage", "On a stage"), ("finish", "Stage complete")],
    steam_game: true, listed: true,
};
fn matches(t: &Target) -> bool {
    MANIFEST.game_ids.contains(&t.game_id.as_str())
        || t.steam_appid.as_deref() == Some("1849250")
        || matches!(exe_name(t).as_str(), "wrc.exe" | "wrc-win64-shipping.exe")
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Packet {
    seconds: f32,
    distance: f64,
    length: f64,
}
fn parse(b: &[u8]) -> Option<Packet> {
    if b.len() != 237 {
        return None;
    }
    let p = Packet {
        seconds: f32_at(b, 217)?,
        distance: f64_at(b, 221)?,
        length: f64_at(b, 229)?,
    };
    if !p.seconds.is_finite()
        || !p.distance.is_finite()
        || !p.length.is_finite()
        || !(0.0..=86400.0).contains(&p.seconds)
        || !(1.0..=1_000_000.0).contains(&p.length)
        || !(-100.0..=p.length + 1000.0).contains(&p.distance)
    {
        return None;
    }
    Some(p)
}
fn build(p: Option<&Packet>, s: &Settings) -> Live {
    let Some(p) = p else {
        return Live {
            details: clamp("In the menus"),
            large_image: Some(art::steam_header("1849250")),
            ..Live::default()
        };
    };
    let label = if p.distance >= p.length {
        "Stage complete"
    } else if p.seconds == 0.0 {
        "At the start"
    } else {
        "On a stage"
    };
    let mut parts = Vec::new();
    if s.flag("show_time") {
        let tenths = (p.seconds * 10.0).floor() as u32;
        parts.push(format!(
            "{}:{:02}.{}",
            tenths / 600,
            (tenths / 10) % 60,
            tenths % 10
        ));
    }
    if s.flag("show_distance") {
        parts.push(format!(
            "{:.1}/{:.1} km",
            p.distance.max(0.0).min(p.length) / 1000.0,
            p.length / 1000.0
        ));
    }
    Live {
        details: clamp(label),
        state: clamp(parts.join(" - ")),
        large_image: Some(art::steam_header("1849250")),
        ..Live::default()
    }
}
fn preview(s: &Settings, scenario: &str) -> Preview {
    let p = match scenario {
        "ready" => Some(Packet {
            seconds: 0.0,
            distance: 0.0,
            length: 12400.0,
        }),
        "stage" => Some(Packet {
            seconds: 143.2,
            distance: 5700.0,
            length: 12400.0,
        }),
        "finish" => Some(Packet {
            seconds: 321.4,
            distance: 12400.0,
            length: 12400.0,
        }),
        _ => None,
    };
    Preview {
        game: "EA Sports WRC",
        icon: None,
        live: build(p.as_ref(), s),
    }
}
fn merge_config(value: &mut Value) -> Option<bool> {
    if value.get("schema").and_then(Value::as_u64) != Some(2) {
        return None;
    }
    let packets = value.get_mut("udp")?.get_mut("packets")?.as_array_mut()?;
    let same_destination = |p: &Value| {
        p.get("ip").and_then(Value::as_str) == Some("127.0.0.1")
            && p.get("port").and_then(Value::as_u64) == Some(u64::from(PORT))
    };
    if packets.iter().any(|p| {
        same_destination(p)
            && p.get("structure").and_then(Value::as_str) == Some("wrc")
            && p.get("packet").and_then(Value::as_str) == Some("session_update")
            && p.get("bEnabled").and_then(Value::as_bool) == Some(true)
    }) {
        return Some(false);
    }
    // a different active structure on our port cannot be decoded as the standard packet
    if packets
        .iter()
        .any(|p| same_destination(p) && p.get("bEnabled").and_then(Value::as_bool) == Some(true))
    {
        return None;
    }
    packets.push(json!({"structure":"wrc","packet":"session_update","ip":"127.0.0.1","port":PORT,"frequencyHz":10,"bEnabled":true}));
    Some(true)
}
fn documents_dir() -> Option<PathBuf> {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let mut buf = [0u16; 2048];
    let mut len = std::mem::size_of_val(&buf) as u32;
    // Shell Folders contains the resolved path, including redirected Documents
    let err = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders"),
            w!("Personal"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if err.is_ok() {
        let chars = (len as usize / 2).min(buf.len());
        let path = String::from_utf16_lossy(buf.get(..chars)?)
            .trim_end_matches('\0')
            .to_string();
        if !path.is_empty() {
            return Some(PathBuf::from(path));
        }
    }
    std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("Documents"))
}
fn configure(path: &Path) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    let original = match std::fs::metadata(path) {
        Ok(m) if m.len() <= 2 * 1024 * 1024 => Some(std::fs::read(path)?),
        Ok(_) => {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "WRC config exceeds size limit",
            ))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let mut value = match original.as_deref() {
        Some(b) => serde_json::from_slice(b).map_err(|e| Error::new(ErrorKind::InvalidData, e))?,
        None => json!({"schema":2,"udp":{"packets":[]}}),
    };
    match merge_config(&mut value) {
        Some(false) => return Ok(()),
        Some(true) => {}
        None => {
            return Err(Error::new(
                ErrorKind::InvalidData,
                "Unsupported WRC config or conflicting endpoint",
            ))
        }
    }
    let Some(parent) = path.parent() else {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "Missing WRC config directory",
        ));
    };
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join("config.clipdip.tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    let result = (|| {
        let bytes =
            serde_json::to_vec_pretty(&value).map_err(|e| Error::new(ErrorKind::InvalidData, e))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        // preserve an edit made by the game or another telemetry tool during the merge
        let current = match std::fs::read(path) {
            Ok(b) => Some(b),
            Err(e) if e.kind() == ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        if current != original {
            return Err(Error::new(
                ErrorKind::WouldBlock,
                "WRC config changed during merge",
            ));
        }
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}
fn run(ctx: &Ctx) {
    if let Some(dir) = documents_dir() {
        if let Err(e) = configure(&dir.join("My Games/WRC/telemetry/config.json")) {
            tracing::warn!("WRC telemetry setup: {e}");
        }
    }
    while ctx.running() {
        let Ok(socket) = UdpSocket::bind(("127.0.0.1", PORT)) else {
            ctx.emit(None);
            if !ctx.sleep(Duration::from_secs(10)) {
                return;
            }
            continue;
        };
        if socket
            .set_read_timeout(Some(Duration::from_secs(1)))
            .is_err()
        {
            return;
        }
        let mut buf = [0u8; 2048];
        let mut pending = None;
        let mut last_valid = Instant::now();
        let mut emitted = Instant::now() - Duration::from_secs(1);
        while ctx.running() {
            match socket.recv_from(&mut buf) {
                Ok((n, _)) => {
                    if let Some(p) = parse(buf.get(..n).unwrap_or_default()) {
                        pending = Some(p);
                        last_valid = Instant::now();
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => {
                    ctx.emit(None);
                    if !ctx.sleep(Duration::from_secs(10)) {
                        return;
                    }
                    break;
                }
            }
            if last_valid.elapsed() > Duration::from_secs(5) {
                pending = None;
            }
            if emitted.elapsed() >= Duration::from_secs(1) {
                ctx.emit(pending.as_ref().map(|p| build(Some(p), ctx.settings())));
                emitted = Instant::now();
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn standard_packet_and_bad_floats() {
        let mut b = vec![0; 237];
        b[217..221].copy_from_slice(&143.2f32.to_le_bytes());
        b[221..229].copy_from_slice(&5700f64.to_le_bytes());
        b[229..237].copy_from_slice(&12400f64.to_le_bytes());
        let p = parse(&b).unwrap();
        assert_eq!(p.distance, 5700.0);
        assert!(parse(&b[..236]).is_none());
        b[217..221].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(parse(&b).is_none());
    }
    #[test]
    fn config_preserves_endpoints_and_is_idempotent() {
        let old = json!({"structure":"custom1","ip":"127.0.0.1","port":20777,"frequencyHz":-1,"bEnabled":true});
        let mut v = json!({"schema":2,"udp":{"packets":[old.clone()]},"lcd":{"bDisplayGears":true},"unknown":42});
        assert_eq!(merge_config(&mut v), Some(true));
        assert_eq!(v["udp"]["packets"][0], old);
        assert_eq!(v["unknown"], 42);
        let saved = v.clone();
        assert_eq!(merge_config(&mut v), Some(false));
        assert_eq!(v, saved);
        assert_eq!(merge_config(&mut json!({"schema":3})), None);
        let mut conflict = json!({"schema":2,"udp":{"packets":[{"ip":"127.0.0.1","port":PORT,"bEnabled":true,"structure":"custom1"}]}});
        let saved = conflict.clone();
        assert_eq!(merge_config(&mut conflict), None);
        assert_eq!(conflict, saved);
    }
    #[test]
    fn config_file_writes_once_and_keeps_invalid_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "clipdip-wrc-test-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(
            &path,
            b"{\"schema\":2,\"udp\":{\"packets\":[]},\"custom\":17}",
        )
        .unwrap();
        configure(&path).unwrap();
        let first = std::fs::read(&path).unwrap();
        configure(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), first);
        let value: Value = serde_json::from_slice(&first).unwrap();
        assert_eq!(value["custom"], 17);
        assert_eq!(value["udp"]["packets"].as_array().unwrap().len(), 1);
        std::fs::write(&path, b"invalid user config").unwrap();
        assert!(configure(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"invalid user config");
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }
    #[test]
    fn previews_and_options() {
        let s = Settings::new(&MANIFEST, json!({}));
        for (key, _) in MANIFEST.scenarios {
            let p = preview(&s, key);
            assert!(p.live.details.is_some());
            assert!(!p.live.competing);
        }
        assert_eq!(preview(&s, "unknown").live, preview(&s, "menu").live);
        assert_eq!(
            preview(&s, "stage").live.state.as_deref(),
            Some("2:23.2 - 5.7/12.4 km")
        );
        let off = Settings::new(&MANIFEST, json!({"show_time":false}));
        assert_ne!(
            preview(&off, "stage").live.state,
            preview(&s, "stage").live.state
        );
    }
}
