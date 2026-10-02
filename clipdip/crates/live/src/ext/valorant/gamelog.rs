//! Agent and menu screen from Valorant's own ShooterGame.log, the only local
//! source for either. The game holds the file open, a shared read works.

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

/// the log passed 1.5 MB in a three hour session; this much tail covers a match
const TAIL: u64 = 1 << 20;

/// what the game logs between matches
const NO_CHARACTER: &str = "None";
const CHARACTER: &[u8] = b"Current character: ";
const HOME_OPEN: &[u8] = b"LogMenuStackManager: Opening HomeScreen_PC_C";
const HOME_CLOSE: &[u8] = b"LogMenuStackManager: Closing HomeScreen_PC_C";
const NAV_URL: &[u8] = b"LogUINavigationModel: Warning: Current Url: ";
/// the Play section; its mode and map pickers nest underneath
const LOBBY_ROUTE: &[u8] = b"main/lobby";
/// opens over whatever was behind it and logs no route on close, so skipped
const SETTINGS_ROUTE: &[u8] = b"main/settingsingame";

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Screen {
    /// nothing said yet, reads as the client and never the lobby
    #[default]
    Unknown,
    Client,
    Lobby,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Character {
    /// codename, valorant-api's developerName (Wushu is Jett); menus log UI
    /// classes like Career here too, the catalogue join drops those
    Codename(String),
    Cleared,
}

pub struct LogTail {
    path: Option<PathBuf>,
    offset: u64,
    pub character: Option<String>,
    pub screen: Screen,
}

impl LogTail {
    pub fn new(path: Option<PathBuf>) -> Self {
        LogTail {
            path,
            offset: 0,
            character: None,
            screen: Screen::Unknown,
        }
    }

    pub fn default_path() -> Option<PathBuf> {
        let base = std::env::var_os("LOCALAPPDATA")?;
        Some(
            PathBuf::from(base)
                .join("VALORANT")
                .join("Saved")
                .join("Logs")
                .join("ShooterGame.log"),
        )
    }

    /// Reads whatever was appended since the last call (at most the last
    /// 1 MB) and folds it in. Only whole lines are consumed.
    pub fn poll(&mut self) {
        let Some(path) = &self.path else { return };
        let Ok(mut file) = std::fs::File::open(path) else {
            return;
        };
        let Ok(len) = file.metadata().map(|m| m.len()) else {
            return;
        };
        if len < self.offset {
            // a new file after a game restart
            self.offset = 0;
        }
        let start = self.offset.max(len.saturating_sub(TAIL));
        if start >= len {
            return;
        }
        let mut chunk = Vec::with_capacity((len - start) as usize);
        if file.seek(SeekFrom::Start(start)).is_err()
            || file.take(len - start).read_to_end(&mut chunk).is_err()
        {
            return;
        }
        let Some(end) = chunk.iter().rposition(|&b| b == b'\n') else {
            if len - start >= TAIL {
                self.offset = len;
            }
            return;
        };
        self.offset = start + end as u64 + 1;
        let (character, screen) = scan(&chunk[..end]);
        match character {
            Some(Character::Codename(c)) => self.character = Some(c),
            Some(Character::Cleared) => self.character = None,
            None => {}
        }
        if let Some(s) = screen {
            self.screen = s;
        }
    }
}

/// The last character line and the last line that moved the menu UI. The
/// log is append-only for a whole session, so only the last one speaks.
pub fn scan(chunk: &[u8]) -> (Option<Character>, Option<Screen>) {
    let mut character = None;
    let mut screen = None;
    for line in chunk.rsplit(|&b| b == b'\n') {
        if character.is_none() {
            character = character_in(line);
        }
        if screen.is_none() {
            screen = screen_in(line);
        }
        if character.is_some() && screen.is_some() {
            break;
        }
    }
    (character, screen)
}

/// `Current character: (?:Default__)?([A-Za-z0-9]+)(?:_PC_C|\b)`, last match
/// in the line. Both the class default object and the spawned pawn appear.
fn character_in(line: &[u8]) -> Option<Character> {
    let mut found = None;
    let mut from = 0;
    while let Some(i) = find(&line[from..], CHARACTER) {
        let at = from + i + CHARACTER.len();
        if let Some(name) = codename(&line[at..]) {
            found = Some(name);
        }
        from = at;
    }
    let name = found?;
    if name.eq_ignore_ascii_case(NO_CHARACTER) {
        Some(Character::Cleared)
    } else {
        Some(Character::Codename(name))
    }
}

fn codename(rest: &[u8]) -> Option<String> {
    let rest = rest.strip_prefix(b"Default__").unwrap_or(rest);
    let n = rest
        .iter()
        .take_while(|b| b.is_ascii_alphanumeric())
        .count();
    if n == 0 {
        return None;
    }
    let tail = &rest[n..];
    let boundary = tail
        .first()
        .is_none_or(|b| !(b.is_ascii_alphanumeric() || *b == b'_'));
    if !(tail.starts_with(b"_PC_C") || boundary) {
        return None;
    }
    std::str::from_utf8(&rest[..n]).ok().map(str::to_string)
}

fn screen_in(line: &[u8]) -> Option<Screen> {
    if find(line, HOME_OPEN).is_some() {
        return Some(Screen::Client);
    }
    // the home screen closes on the way somewhere, the route is the next line
    if find(line, HOME_CLOSE).is_some() {
        return None;
    }
    let at = find(line, NAV_URL)? + NAV_URL.len();
    let rest = &line[at..];
    let route = &rest[..rest
        .iter()
        .position(|b| b.is_ascii_whitespace())
        .unwrap_or(rest.len())];
    if route.is_empty() || route.starts_with(SETTINGS_ROUTE) {
        return None;
    }
    if route == LOBBY_ROUTE
        || (route.starts_with(LOBBY_ROUTE) && route.get(LOBBY_ROUTE.len()) == Some(&b'/'))
    {
        return Some(Screen::Lobby);
    }
    Some(Screen::Client)
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    // lines from a real ShooterGame.log, 2026-09-19/20, via valorant-rpc's tests
    const CURRENT: &str = "[2026.09.19-21.11.19:610][123]LogShooterPlayerController: Warning: Shooter Player Controller received PlayerState. Current character: Default__Wushu_PC_C";
    const POSSESSED: &str = "[2026.09.19-21.11.36:355][786]LogPlayerController: Warning: [77476] AcknowledgePossession('Wushu_PC_C_2147273058')";
    const CLEARED: &str = "[2026.09.19-21.30.37:340][244]LogShooterPlayerController: Warning: Shooter Player Controller received PlayerState. Current character: None";
    const MENU: &str = "[2026.09.19-20.19.04:066][ 12]LogShooterPlayerController: Warning: Current character: Default__Career_PC_C";
    const HOME_OPEN_L: &str =
        "[2026.09.20-11.16.59:564][277]LogMenuStackManager: Opening HomeScreen_PC_C";
    const HOME_CLOSE_L: &str =
        "[2026.09.20-11.19.16:371][391]LogMenuStackManager: Closing HomeScreen_PC_C";
    const PROXY_OPEN: &str =
        "[2026.09.20-11.19.16:375][391]LogMenuStackManager: Opening WBP_Screen_ProxyShell_PC_C";
    const LOBBY: &str =
        "[2026.09.20-11.19.16:376][391]LogUINavigationModel: Warning: Current Url: main/lobby";
    const LOBBY_MODAL: &str = "[2026.09.20-11.19.17:709][551]LogUINavigationModel: Warning: Current Url: main/lobby/modal/lobbymodeselectmodal";
    const STORE: &str = "[2026.09.19-17.05.40:051][716]LogUINavigationModel: Warning: Current Url: main/store/accessorystore";
    const SETTINGS: &str = "[2026.09.20-11.24.20:093][354]LogUINavigationModel: Warning: Current Url: main/settingsingame";
    const EMPTY_URL: &str =
        "[2026.09.20-11.24.29:445][992]LogUINavigationModel: Warning: Current Url: ";
    const NOISE: &str = "[2026.09.20-11.17.01:318][277]LogGameFlowStateManager: Reconcile called with the current state: MainMenu.";

    fn run(lines: &[&str]) -> (Option<Character>, Option<Screen>) {
        scan(lines.join("\r\n").as_bytes())
    }

    fn agent(s: &str) -> Option<Character> {
        Some(Character::Codename(s.into()))
    }

    #[test]
    fn character() {
        assert_eq!(run(&[POSSESSED, CURRENT]).0, agent("Wushu"));
        assert_eq!(run(&[CURRENT, CLEARED]).0, Some(Character::Cleared));
        assert_eq!(run(&[MENU]).0, agent("Career"));
        assert_eq!(run(&[NOISE]).0, None);
        assert_eq!(run(&["Current character: Foo_Bar"]).0, None);
        assert_eq!(run(&["Current character: Wushu_PC_C"]).0, agent("Wushu"));
    }

    #[test]
    fn menu_screen() {
        assert_eq!(run(&[NOISE, HOME_OPEN_L, NOISE]).1, Some(Screen::Client));
        assert_eq!(
            run(&[HOME_OPEN_L, HOME_CLOSE_L, PROXY_OPEN, LOBBY]).1,
            Some(Screen::Lobby)
        );
        assert_eq!(
            run(&[HOME_CLOSE_L, LOBBY, LOBBY_MODAL]).1,
            Some(Screen::Lobby)
        );
        assert_eq!(run(&[LOBBY, HOME_OPEN_L]).1, Some(Screen::Client));
        assert_eq!(run(&[HOME_CLOSE_L, LOBBY, STORE]).1, Some(Screen::Client));
        assert_eq!(run(&[LOBBY, SETTINGS, EMPTY_URL]).1, Some(Screen::Lobby));
        assert_eq!(run(&[HOME_CLOSE_L, NOISE]).1, None);
        assert_eq!(
            run(&["LogUINavigationModel: Warning: Current Url: main/lobbyist"]).1,
            Some(Screen::Client)
        );
    }

    #[test]
    fn tail_reads_only_new_whole_lines() {
        let dir = std::env::temp_dir().join(format!("clipdip-valorant-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ShooterGame.log");
        std::fs::write(&path, format!("{HOME_OPEN_L}\n{CURRENT}\n{LOBBY}")).unwrap();
        let mut t = LogTail::new(Some(path.clone()));
        t.poll();
        assert_eq!(t.character.as_deref(), Some("Wushu"));
        // the lobby line has no newline yet
        assert_eq!(t.screen, Screen::Client);
        std::fs::write(
            &path,
            format!("{HOME_OPEN_L}\n{CURRENT}\n{LOBBY}\n{NOISE}\n"),
        )
        .unwrap();
        t.poll();
        assert_eq!(t.screen, Screen::Lobby);
        assert_eq!(t.character.as_deref(), Some("Wushu"));
        std::fs::write(&path, format!("{CLEARED}\n")).unwrap();
        t.poll();
        assert_eq!(t.character, None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
