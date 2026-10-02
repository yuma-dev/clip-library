//! Where the player is, from logs/latest.log and the window title.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::SystemTime;

/// first read of a long running log only looks at its tail
const FIRST_READ_MAX: u64 = 4 << 20;
/// a line longer than this is a stack trace or a mod dumping json, not ours
const MAX_PARTIAL: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// already SRV resolved by the game, port included
    Server(String, u16),
    Single,
    /// singleplayer opened to LAN
    Lan,
    /// integrated server stopped, back to the menu
    Left,
}

/// One line of latest.log. Vanilla writes `[12:34:56] [Render thread/INFO]: msg`,
/// Forge adds a logger name `[...] [Render thread/INFO] [net.minecraft.../]: msg`.
pub fn parse_line(line: &str) -> Option<Event> {
    let msg = line.split_once("]: ")?.1.trim_end();
    if let Some(rest) = msg.strip_prefix("Connecting to ") {
        // ConnectScreen: "Connecting to {host}, {port}"
        let (host, port) = rest.rsplit_once(", ")?;
        let port = port.trim().parse().ok()?;
        let host = host.trim();
        if host.is_empty() {
            return None;
        }
        return Some(Event::Server(host.to_string(), port));
    }
    if msg.starts_with("Starting integrated minecraft server version") {
        return Some(Event::Single);
    }
    if msg.starts_with("Started serving on ") {
        return Some(Event::Lan);
    }
    if msg.starts_with("Stopping singleplayer server as player logged out") {
        return Some(Event::Left);
    }
    None
}

/// Reads only bytes appended since the last poll. A shrunk or recreated file
/// (log4j rolls latest.log over on game start) is read from the top again.
pub struct Tail {
    path: PathBuf,
    offset: u64,
    created: Option<SystemTime>,
    partial: Vec<u8>,
    started: bool,
}

impl Tail {
    pub fn new(path: PathBuf) -> Self {
        Tail {
            path,
            offset: 0,
            created: None,
            partial: Vec::new(),
            started: false,
        }
    }

    pub fn poll(&mut self, mut on: impl FnMut(Event)) {
        let Ok(mut f) = File::open(&self.path) else {
            return;
        };
        let Ok(meta) = f.metadata() else { return };
        let len = meta.len();
        let created = meta.created().ok();
        if len < self.offset || (self.started && created != self.created) {
            self.offset = 0;
            self.partial.clear();
        }
        if !self.started {
            self.offset = len.saturating_sub(FIRST_READ_MAX);
            self.started = true;
        }
        self.created = created;
        if len == self.offset {
            return;
        }
        if f.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let mut buf = Vec::with_capacity((len - self.offset).min(FIRST_READ_MAX) as usize);
        let Ok(n) = f.take(len - self.offset).read_to_end(&mut buf) else {
            return;
        };
        self.offset += n as u64;
        self.partial.extend_from_slice(&buf);
        let Some(last_nl) = self.partial.iter().rposition(|&b| b == b'\n') else {
            if self.partial.len() > MAX_PARTIAL {
                self.partial.clear();
            }
            return;
        };
        for line in self.partial[..last_nl].split(|&b| b == b'\n') {
            // cheap filter before decoding, every event has one of these words
            if !(contains(line, b"Connecting to ")
                || contains(line, b" server")
                || contains(line, b"Started serving"))
            {
                continue;
            }
            if let Some(e) = parse_line(&String::from_utf8_lossy(line)) {
                on(e);
            }
        }
        self.partial.drain(..=last_nl);
        if self.partial.len() > MAX_PARTIAL {
            self.partial.clear();
        }
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Single,
    Server,
    Lan,
    Realms,
    /// in a world, title text not in English
    World,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Title {
    pub version: Option<String>,
    /// None: no " - <mode>" suffix (main menu since 1.16, or any screen before)
    pub mode: Option<Mode>,
}

/// `Minecraft* 1.21.4 - Multiplayer (3rd-party Server)`. The star means
/// modded. The suffix comes from the game's language file, only English is
/// mapped and anything else counts as "in some world".
pub fn parse_title(t: &str) -> Option<Title> {
    let rest = t.trim().strip_prefix("Minecraft")?;
    let rest = rest.strip_prefix('*').unwrap_or(rest);
    if !rest.starts_with(' ') {
        return None;
    }
    let (left, mode) = match rest.split_once(" - ") {
        Some((l, m)) => (l, Some(m.trim())),
        None => (rest, None),
    };
    let version = left
        .split_whitespace()
        .last()
        .filter(|v| v.starts_with(|c: char| c.is_ascii_digit()))
        .map(str::to_string);
    let mode = mode.filter(|m| !m.is_empty()).map(|m| match m {
        "Singleplayer" => Mode::Single,
        "Multiplayer (3rd-party Server)" => Mode::Server,
        "Multiplayer (LAN)" => Mode::Lan,
        "Multiplayer (Realms)" => Mode::Realms,
        _ => Mode::World,
    });
    Some(Title { version, mode })
}

/// Title of the pid's visible top level window, the GLFW one when there are several.
pub fn window_title(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindow, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, GW_OWNER,
    };

    struct Search {
        pid: u32,
        best: Option<(bool, String)>,
    }

    unsafe extern "system" fn each(hwnd: HWND, lp: LPARAM) -> BOOL {
        // SAFETY: lp is the &mut Search passed to EnumWindows below, alive for the whole call
        let s = &mut *(lp.0 as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != s.pid || !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        if GetWindow(hwnd, GW_OWNER)
            .map(|h| !h.is_invalid())
            .unwrap_or(false)
        {
            return BOOL(1);
        }
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, &mut buf).clamp(0, 256) as usize;
        if n == 0 {
            return BOOL(1);
        }
        let mut class = [0u16; 64];
        let cn = GetClassNameW(hwnd, &mut class).clamp(0, 64) as usize;
        let glfw = String::from_utf16_lossy(&class[..cn]).starts_with("GLFW");
        let title = String::from_utf16_lossy(&buf[..n]);
        if s.best.as_ref().map(|(g, _)| !g).unwrap_or(true) {
            s.best = Some((glfw, title));
        }
        BOOL(1)
    }

    let mut s = Search { pid, best: None };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut s as *mut Search as isize));
    }
    s.best.map(|(_, t)| t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_lines() {
        assert_eq!(
            parse_line("[18:02:11] [Render thread/INFO]: Connecting to play.example.net, 25565"),
            Some(Event::Server("play.example.net".into(), 25565))
        );
        assert_eq!(
            parse_line("[01Oct2026 18:02:11.123] [Render thread/INFO] [net.minecraft.client.gui.screens.ConnectScreen/]: Connecting to mc.example.org, 25566\r"),
            Some(Event::Server("mc.example.org".into(), 25566))
        );
        assert_eq!(
            parse_line("[18:00:01] [Server thread/INFO]: Starting integrated minecraft server version 1.21.4"),
            Some(Event::Single)
        );
        assert_eq!(
            parse_line("[18:05:00] [Server thread/INFO]: Started serving on 51234"),
            Some(Event::Lan)
        );
        assert_eq!(
            parse_line("[18:09:00] [Server thread/INFO]: Stopping singleplayer server as player logged out"),
            Some(Event::Left)
        );
        // chat goes through [CHAT], never a bare "Connecting to"
        assert_eq!(
            parse_line("[18:02:11] [Render thread/INFO]: [CHAT] <bob> Connecting to x, 1"),
            None
        );
        assert_eq!(
            parse_line("[18:02:11] [Render thread/INFO]: Connecting to x, port"),
            None
        );
    }

    #[test]
    fn tail_reads_appends_and_restarts() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("mc-tail-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("latest.log");
        std::fs::write(
            &p,
            "[1] [Render thread/INFO]: Connecting to a.example, 25565\n[2] [x/INFO]: Conn",
        )
        .unwrap();
        let mut t = Tail::new(p.clone());
        let mut got = vec![];
        t.poll(|e| got.push(e));
        assert_eq!(got, vec![Event::Server("a.example".into(), 25565)]);
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(b"ecting to b.example, 1\n").unwrap();
        drop(f);
        t.poll(|e| got.push(e));
        assert_eq!(got.last(), Some(&Event::Server("b.example".into(), 1)));
        std::fs::write(
            &p,
            "[3] [Server thread/INFO]: Starting integrated minecraft server version 1.21\n",
        )
        .unwrap();
        t.poll(|e| got.push(e));
        assert_eq!(got.last(), Some(&Event::Single));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn titles() {
        let t = parse_title("Minecraft* 1.21.4 - Multiplayer (3rd-party Server)").unwrap();
        assert_eq!(t.version.as_deref(), Some("1.21.4"));
        assert_eq!(t.mode, Some(Mode::Server));
        assert_eq!(
            parse_title("Minecraft 1.20.1 - Singleplayer").unwrap().mode,
            Some(Mode::Single)
        );
        assert_eq!(
            parse_title("Minecraft* 1.21.1 - Multiplayer (Realms)")
                .unwrap()
                .mode,
            Some(Mode::Realms)
        );
        assert_eq!(
            parse_title("Minecraft* 1.21.1 - Mehrspieler (LAN)")
                .unwrap()
                .mode,
            Some(Mode::World)
        );
        let menu = parse_title("Minecraft* 1.21.4").unwrap();
        assert_eq!((menu.version.as_deref(), menu.mode), (Some("1.21.4"), None));
        assert_eq!(
            parse_title("Minecraft 1.12.2").unwrap().version.as_deref(),
            Some("1.12.2")
        );
        assert_eq!(parse_title("Fabulously Optimized 6.4"), None);
        assert_eq!(parse_title("MinecraftLauncher"), None);
    }
}
