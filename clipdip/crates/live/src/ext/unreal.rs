//! Engine map travel and host peers from installed logs and Epic Games' Unreal
//! logging documentation (docs), https://dev.epicgames.com/documentation/en-us/unreal-engine/logging-in-unreal-engine

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::{Duration, UNIX_EPOCH};

use crate::util::tail::Tail;
use crate::{Credit, Ctx, Live, Settings};

pub struct MapDef {
    pub aliases: &'static [&'static str],
    pub label: &'static str,
    pub key: &'static str,
    pub menu: bool,
}

pub struct MapCard {
    pub slug: &'static str,
    pub appid: &'static str,
    pub maps: &'static [MapDef],
    pub playing: &'static str,
}

impl MapCard {
    pub fn build(
        &self,
        s: &Session,
        settings: &Settings,
        count: Option<u32>,
        max: Option<u32>,
    ) -> Option<Live> {
        let map = s.map()?;
        let known = self
            .maps
            .iter()
            .find(|m| m.aliases.iter().any(|a| a.eq_ignore_ascii_case(map)));
        let menu = known.is_some_and(|m| m.menu);
        let show_map = settings.flag("show_map");
        let label = known.map(|m| m.label).unwrap_or("In game");
        let details = if menu || show_map {
            label
        } else {
            self.playing
        };
        let mut parts = Vec::new();
        let party = if menu {
            None
        } else {
            people(
                &mut parts,
                s,
                count,
                max,
                settings.flag("show_session"),
                settings.flag("show_players"),
            )
        };
        let image = show_map.then(|| {
            known
                .map(|m| crate::util::art::url(self.slug, m.key))
                .unwrap_or_else(|| crate::util::art::steam_header(self.appid))
        });
        Some(Live {
            details: crate::util::clamp(details),
            state: crate::util::clamp(parts.join(" - ")),
            large_text: image.as_ref().and_then(|_| crate::util::clamp(label)),
            large_image: image,
            start_ms: (!menu && s.loaded).then_some(s.since_ms).flatten(),
            party,
            ..Live::default()
        })
    }
}

pub const CREDIT: Credit = Credit {
    project: "Unreal Engine logging",
    author: "Epic Games",
    url: "https://dev.epicgames.com/documentation/en-us/unreal-engine/logging-in-unreal-engine",
    license: "docs",
};

const TICK: Duration = Duration::from_secs(4);
const IDLE: Duration = Duration::from_secs(10);
/// a session's map line can sit far back in a long log; scanning is streamed, this only caps the time
const SCAN_MAX: u64 = 512 << 20;
const MAX_LINE: usize = 256 << 10;
/// a log older than the game process (minus this) is the previous launch's
const STALE_SLACK_MS: i64 = 60_000;

/// How the current map was reached.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Net {
    /// no host in the url and no `listen`: menu, solo or offline
    #[default]
    Local,
    /// `?listen`: a listen server, you're the host
    Hosting,
    /// a peer-to-peer host (`steam.<id>`, `EOS:...`): a friend's game
    Joined,
    /// an ip:port host: a dedicated server
    Server,
}

/// A travel url: `[host]/Path/To/Map?opt?key=value...`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Url {
    pub host: Option<String>,
    pub path: String,
    pub options: Vec<(String, String)>,
}

impl Url {
    pub fn parse(s: &str) -> Url {
        let s = s.trim().trim_matches('"');
        let (left, opts) = s.split_once('?').unwrap_or((s, ""));
        let (host, path) = if left.starts_with('/') || left.is_empty() {
            (None, left.to_string())
        } else {
            match left.split_once('/') {
                Some((host, path)) => (Some(host.to_string()), format!("/{path}")),
                None => (Some(left.to_string()), String::new()),
            }
        };
        let options = opts
            .split('?')
            .filter(|o| !o.is_empty())
            .map(|o| match o.split_once('=') {
                Some((k, v)) => (k.to_string(), v.to_string()),
                None => (o.to_string(), String::new()),
            })
            .collect();
        Url {
            host,
            path,
            options,
        }
    }

    /// An option's value, key compared case-insensitively.
    pub fn opt(&self, key: &str) -> Option<&str> {
        self.options
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }

    pub fn has(&self, key: &str) -> bool {
        self.opt(key).is_some()
    }

    /// `/Game/Maps/Main/L_Main` -> `L_Main`
    pub fn map(&self) -> &str {
        short_name(&self.path)
    }

    pub fn net(&self) -> Net {
        match &self.host {
            None if self.has("listen") => Net::Hosting,
            None => Net::Local,
            Some(h) if is_peer(h) => Net::Joined,
            Some(_) => Net::Server,
        }
    }
}

/// Last path segment without the `.Object` suffix.
pub fn short_name(path: &str) -> &str {
    let last = path.rsplit('/').next().unwrap_or(path);
    last.split('.').next().unwrap_or(last)
}

/// Steam and EOS peer addresses as UE writes them: `steam.<id>`, `EOS:<puid>:...`,
/// or a bare SteamID with a port (SteamSockets).
fn is_peer(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    if h.starts_with("steam") || h.starts_with("eos") || h.starts_with("epic") {
        return true;
    }
    let id = h.split(':').next().unwrap_or("");
    id.len() >= 15 && id.bytes().all(|b| b.is_ascii_digit())
}

/// `[2026.06.07-18.42.28:919][701]LogNet: ...` -> (unix ms, `LogNet: ...`). The
/// bracket time is UTC. Lines without the prefix (multi-line dumps) come back whole.
pub fn split_line(line: &str) -> (Option<i64>, &str) {
    let Some(rest) = line.strip_prefix('[') else {
        return (None, line);
    };
    let Some((stamp, rest)) = rest.split_once(']') else {
        return (None, line);
    };
    let body = match rest.strip_prefix('[').and_then(|r| r.split_once(']')) {
        Some((_frame, body)) => body,
        None => rest,
    };
    (parse_ts(stamp), body)
}

/// `2026.06.07-18.42.28:919` (UTC) -> unix ms
pub fn parse_ts(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse().ok() };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let ms = s
        .get(20..23)
        .and_then(|m| m.parse::<i64>().ok())
        .unwrap_or(0);
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days_in_month = match mo {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=12).contains(&mo)
        || !(1..=days_in_month).contains(&d)
        || !(0..=23).contains(&h)
        || !(0..=59).contains(&mi)
        || !(0..=59).contains(&se)
    {
        return None;
    }
    // days from civil, Howard Hinnant's algorithm
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi) * 60_000 + se * 1000 + ms)
}

/// What a line changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fed {
    Nothing,
    /// a new map (or a new log): per-map game state starts over
    Map,
    Changed,
}

/// The engine-level state of one game session.
#[derive(Clone, Debug, Default)]
pub struct Session {
    /// the current map's travel url, None until the first LoadMap
    pub url: Option<Url>,
    pub net: Net,
    /// game mode class, e.g. `Athena_GameMode_C`, empty when not logged
    pub game_class: String,
    /// unix ms of the LoadMap line
    pub since_ms: Option<i64>,
    /// "Bringing World ... up for play" seen for the current map
    pub loaded: bool,
    /// unique ids of clients on our listen server; only ever counted, never shown
    peers: HashSet<String>,
    pending_login: HashMap<String, String>,
    pending_class: Option<String>,
    pending_travel: Option<(Option<i64>, Url)>,
}

impl Session {
    pub fn map(&self) -> Option<&str> {
        self.url.as_ref().map(|u| u.map())
    }

    pub fn opt(&self, key: &str) -> Option<&str> {
        self.url.as_ref().and_then(|u| u.opt(key))
    }

    /// Players in the game when we can know it: the host counts its clients.
    pub fn players(&self) -> Option<u32> {
        (self.net == Net::Hosting).then(|| 1 + self.peers.len() as u32)
    }

    /// `transit`: loading maps that don't replace the current map.
    pub fn feed(&mut self, ts: Option<i64>, body: &str, transit: &[&str]) -> Fed {
        if body.starts_with("Log file open") {
            *self = Session::default();
            return Fed::Map;
        }
        if let Some(url) = body.strip_prefix("LogNet: Browse: ") {
            let url = Url::parse(url);
            if url.path.is_empty() || transit.iter().any(|t| t.eq_ignore_ascii_case(url.map())) {
                return Fed::Nothing;
            }
            self.pending_travel = Some((ts, url));
            return Fed::Nothing;
        }
        if let Some(url) = body.strip_prefix("LogLoad: LoadMap: ") {
            let url = Url::parse(url);
            if url.path.is_empty() || transit.iter().any(|t| t.eq_ignore_ascii_case(url.map())) {
                return Fed::Nothing;
            }
            return self.travel(ts, url);
        }
        if let Some(rest) = body.strip_prefix("LogNet: Welcomed by server (") {
            // arrives right before the client's LoadMap
            if let Some(g) = rest.split("Game: ").nth(1) {
                self.pending_class = Some(short_name_class(g.trim_end_matches(')')).to_string());
            }
            return Fed::Nothing;
        }
        if let Some(rest) = body.strip_prefix("LogLoad: Game class is '") {
            self.game_class = rest.trim_end_matches('\'').to_string();
            return Fed::Changed;
        }
        if let Some(rest) = body.strip_prefix("LogWorld: Bringing World ") {
            if let Some((path, _)) = rest.split_once(" up for play") {
                let url = Url::parse(path);
                if self
                    .pending_travel
                    .as_ref()
                    .is_some_and(|(_, pending)| pending.map() == url.map())
                {
                    if let Some((started, pending)) = self.pending_travel.take() {
                        self.travel(started.or(ts), pending);
                        self.loaded = true;
                        return Fed::Map;
                    }
                }
                if self.url.is_none() && !transit.iter().any(|t| t.eq_ignore_ascii_case(url.map()))
                {
                    self.url = Some(url);
                    self.since_ms = ts;
                    self.loaded = true;
                    return Fed::Map;
                }
                if self.map() == Some(url.map()) {
                    self.loaded = true;
                    return Fed::Changed;
                }
            }
        }
        if let Some(rest) = body.strip_prefix("LogNet: Login request: ") {
            if self.net == Net::Hosting && self.pending_login.len() < 1024 {
                if let Some((url, id)) = rest.split_once(" userId: ") {
                    if let Some(name) = Url::parse(url).opt("Name") {
                        self.pending_login.insert(name.to_string(), unique_id(id));
                    }
                }
            }
            return Fed::Nothing;
        }
        if let Some(name) = body.strip_prefix("LogNet: Join succeeded: ") {
            if let Some(id) = self.pending_login.remove(name.trim()) {
                if self.net == Net::Hosting
                    && self.peers.len() < 1024
                    && !id.is_empty()
                    && self.peers.insert(id)
                {
                    return Fed::Changed;
                }
            }
            return Fed::Nothing;
        }
        if body.starts_with("LogNet: UNetConnection::Close: ") && !body.contains("PC: NULL") {
            if let Some(id) = body.split("UniqueId: ").nth(1).map(unique_id) {
                if self.peers.remove(&id) {
                    return Fed::Changed;
                }
            }
        }
        Fed::Nothing
    }

    fn travel(&mut self, ts: Option<i64>, url: Url) -> Fed {
        let net = url.net();
        if net != Net::Hosting || self.net != Net::Hosting {
            self.peers.clear();
        }
        self.pending_login.clear();
        self.game_class = url
            .opt("game")
            .map(|g| short_name_class(g).to_string())
            .or_else(|| self.pending_class.take())
            .unwrap_or_default();
        self.pending_class = None;
        self.pending_travel = None;
        self.net = net;
        self.url = Some(url);
        self.since_ms = ts;
        self.loaded = false;
        Fed::Map
    }
}

/// `/Game/Athena/Athena_GameMode.Athena_GameMode_C` -> `Athena_GameMode_C`
fn short_name_class(path: &str) -> &str {
    path.rsplit(['.', '/']).next().unwrap_or(path)
}

/// `Steam:Kai [0x11...0094] platform: Steam` -> `Steam:Kai [0x11...0094]`
fn unique_id(s: &str) -> String {
    match s.split_once('[').and_then(|(_, rest)| rest.split_once(']')) {
        Some((id, _)) => id.to_string(),
        None => s
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_end_matches(',')
            .to_string(),
    }
}

/// One game's part: its own lines and its card.
pub trait Game {
    /// `%LOCALAPPDATA%\<PROJECT>\Saved\Logs\<PROJECT>.log`
    const PROJECT: &'static str;
    /// loading maps that keep the previous card
    const TRANSIT: &'static [&'static str] = &[];

    /// A new map or a new log: drop per-map state.
    fn reset(&mut self, _s: &Session) {}

    /// Game specific lines, after the engine ones. True when something shown changed.
    fn line(&mut self, _s: &Session, _ts: Option<i64>, _body: &str) -> bool {
        false
    }

    /// `online`: false for settings previews, no network then.
    fn build(&mut self, s: &Session, set: &Settings, online: bool) -> Option<Live>;
}

/// Feeds one raw log line to the session and the game.
pub fn feed<G: Game>(s: &mut Session, game: &mut G, line: &str) -> bool {
    let line = line.trim_start_matches('\u{feff}');
    let (ts, body) = split_line(line);
    let fed = s.feed(ts, body, G::TRANSIT);
    if fed == Fed::Map {
        game.reset(s);
    }
    let own = game.line(s, ts, body);
    fed != Fed::Nothing || own
}

/// Sample log text through the same code `run` uses, for previews and tests.
pub fn replay<G: Game>(game: &mut G, log: &str) -> Session {
    let mut s = Session::default();
    for line in log.lines() {
        let line = line.trim_start_matches([' ', '\n']);
        // fixtures indent with 8 spaces; real continuation lines keep their own tab or two spaces
        feed(&mut s, game, line);
    }
    s
}

pub fn log_path(project: &str) -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    Some(
        PathBuf::from(base)
            .join(project)
            .join("Saved")
            .join("Logs")
            .join(format!("{project}.log")),
    )
}

/// Follows the current launch's log: one streamed pass over what is already
/// there (the map line may be far back), then only new bytes.
pub struct Follower {
    path: Option<PathBuf>,
    tail: Option<Tail>,
    not_before_ms: i64,
}

impl Follower {
    pub fn new(project: &str, started_at_ms: i64) -> Self {
        Follower {
            path: log_path(project),
            tail: None,
            not_before_ms: started_at_ms.saturating_sub(STALE_SLACK_MS),
        }
    }

    /// False while there is no log of this launch yet.
    pub fn poll(&mut self, mut on: impl FnMut(&str)) -> bool {
        if let Some(t) = &mut self.tail {
            if self.path.as_ref().is_none_or(|p| !p.is_file()) {
                self.tail = None;
                return false;
            }
            t.poll(on);
            return true;
        }
        let Some(path) = self.path.clone() else {
            return false;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            return false;
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if self.not_before_ms > 0 && modified < self.not_before_ms {
            return false;
        }
        let last = scan(&path, meta.len(), &mut on);
        // overlap keeps bytes appended during the scan and any unfinished final line
        let mut t = Tail::new(&path, MAX_LINE as u64);
        let mut caught_up = last.is_none();
        t.poll(|line| {
            if caught_up {
                on(line);
            } else if last.as_deref() == Some(line.trim_start_matches('\u{feff}')) {
                caught_up = true;
            }
        });
        if !caught_up {
            return false;
        }
        self.tail = Some(t);
        true
    }
}

fn scan(path: &std::path::Path, len: u64, on: &mut impl FnMut(&str)) -> Option<String> {
    let Ok(mut f) = File::open(path) else {
        return None;
    };
    let from = len.saturating_sub(SCAN_MAX);
    if f.seek(SeekFrom::Start(from)).is_err() {
        return None;
    }
    let mut r = BufReader::with_capacity(64 << 10, f.take(len - from));
    let mut buf = Vec::with_capacity(1024);
    let mut first = from > 0;
    let mut oversized = false;
    let mut last = None;
    loop {
        buf.clear();
        match (&mut r)
            .take(MAX_LINE as u64 + 1)
            .read_until(b'\n', &mut buf)
        {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        // a cut first line and an unfinished last one are not lines
        if buf.last() != Some(&b'\n') {
            oversized = true;
            continue;
        }
        if std::mem::take(&mut first) || std::mem::take(&mut oversized) || buf.len() > MAX_LINE {
            continue;
        }
        let line = buf.strip_suffix(b"\n").unwrap_or(&buf);
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let line = line.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(line);
        if !line.is_empty() {
            let line = String::from_utf8_lossy(line).into_owned();
            on(&line);
            last = Some(line);
        }
    }
    last
}

/// The helper loop every UE game shares.
pub fn run<G: Game>(ctx: &Ctx, game: &mut G) {
    let mut follow = Follower::new(G::PROJECT, ctx.target().started_at_ms);
    let mut s = Session::default();
    loop {
        let fresh = follow.poll(|line| {
            feed(&mut s, game, line);
        });
        if fresh {
            ctx.emit(game.build(&s, ctx.settings(), true));
        } else {
            ctx.emit(None);
        }
        if !ctx.sleep(if fresh { TICK } else { IDLE }) {
            return;
        }
    }
}

/// "Hosting" / "In a friend's game" / "On a server" / "Solo".
pub fn net_text(net: Net) -> &'static str {
    match net {
        Net::Hosting => "Hosting",
        Net::Joined => "In a friend's game",
        Net::Server => "On a server",
        Net::Local => "Solo",
    }
}

/// Appends the session line parts and returns the party: `[players, max]` when
/// both are known, else "3 players" goes into the text.
pub fn people(
    parts: &mut Vec<String>,
    s: &Session,
    count: Option<u32>,
    max: Option<u32>,
    session: bool,
    players: bool,
) -> Option<[u32; 2]> {
    if session {
        parts.push(net_text(s.net).to_string());
    }
    if !players {
        return None;
    }
    let count = count.or_else(|| s.players())?;
    match max {
        Some(max) if max >= count && max > 1 => Some([count, max]),
        _ if count > 1 => {
            parts.push(format!("{count} players"));
            None
        }
        _ => None,
    }
}

/// `ElectricalStation` / `Electrical_Station` -> "Electrical Station"
pub fn words(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    let mut prev: Option<char> = None;
    for c in s.chars() {
        if c == '_' || c == '-' {
            if !out.ends_with(' ') && !out.is_empty() {
                out.push(' ');
            }
            prev = Some(' ');
            continue;
        }
        if let Some(p) = prev {
            let boundary = (c.is_uppercase() && (p.is_lowercase() || p.is_ascii_digit()))
                || (c.is_ascii_digit() && p.is_alphabetic());
            if boundary && !out.ends_with(' ') {
                out.push(' ');
            }
        }
        out.push(c);
        prev = Some(c);
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        let u = Url::parse("/Game/Maps/Facility??listen?MaxPlayers=2");
        assert_eq!(
            (u.host.as_deref(), u.map(), u.net()),
            (None, "Facility", Net::Hosting)
        );
        assert_eq!(u.opt("maxplayers"), Some("2"));

        let u = Url::parse("steam.76561190000000001/Game/Ride/Maps/RideMap?bIsFromInvite?game=/Game/Ride/Character/Blueprints/GM_FirstPerson.GM_FirstPerson_C");
        assert_eq!((u.map(), u.net()), ("RideMap", Net::Joined));
        assert!(u.has("bIsFromInvite"));

        let u = Url::parse("10.0.0.1:7777/BRMapCh6/Maps/Hermes_Terrain?EncryptionToken=AB:CD?game=/Game/Athena/Athena_GameMode.Athena_GameMode_C");
        assert_eq!((u.map(), u.net()), ("Hermes_Terrain", Net::Server));

        let u = Url::parse("76561190000000001:7777/Game/Maps/FirstLoadLevel");
        assert_eq!(u.net(), Net::Joined);
        let u = Url::parse("EOS:0002aa:GameNetDriver:26/Game/Maps/Facility");
        assert_eq!(u.net(), Net::Joined);

        let u = Url::parse("/Game/Maps/MainMenu");
        assert_eq!(
            (u.map(), u.net(), u.options.len()),
            ("MainMenu", Net::Local, 0)
        );
        assert_eq!(Url::parse("").map(), "");
    }

    #[test]
    fn timestamps() {
        let (ts, body) =
            split_line("[2026.06.07-18.42.28:919][701]LogNet: Browse: /Game/Maps/MainMenu");
        assert_eq!(body, "LogNet: Browse: /Game/Maps/MainMenu");
        assert_eq!(ts, Some(1_780_857_748_919));
        let (ts, body) = split_line(
            "[2026.06.07-18.40.53:899][  0]LogLoad: LoadMap: /Game/Maps/FirstLoadLevel?Name=Player",
        );
        assert!(ts.is_some());
        assert!(body.starts_with("LogLoad: LoadMap: "));
        assert_eq!(split_line("  Name: x"), (None, "  Name: x"));
        assert_eq!(split_line("[garbage"), (None, "[garbage"));
        assert_eq!(parse_ts("2026.13.07-18.42.28:919"), None);
        assert_eq!(parse_ts("1970.01.01-00.00.00:000"), Some(0));
        assert_eq!(parse_ts("2026.02.30-00.00.00:000"), None);
        assert_eq!(parse_ts("2026.01.01--1.00.00:000"), None);
    }

    struct Nop;
    impl Game for Nop {
        const PROJECT: &'static str = "Nop";
        const TRANSIT: &'static [&'static str] = &["TransitionMap"];
        fn build(&mut self, _: &Session, _: &Settings, _: bool) -> Option<Live> {
            None
        }
    }

    // trimmed from a real GolfIt.log and AbioticFactor.log, names and ids replaced
    const HOSTING: &str = "
        [2026.06.07-18.42.28:919][701]LogNet: Browse: /Game/Maps/Pirate_EditorPlay?listen?ServerName=Someone's Server?WorkshopMap=3716538442?Password=1234?FriendsOnly
        [2026.06.07-18.42.28:919][701]LogLoad: LoadMap: /Game/Maps/Pirate_EditorPlay?listen?ServerName=Someone's Server?WorkshopMap=3716538442?Password=1234?FriendsOnly
        [2026.06.07-18.42.29:344][701]LogLoad: Game class is 'LobbyMode_C'
        [2026.06.07-18.42.29:357][701]LogWorld: Bringing World /Game/Maps/Pirate_EditorPlay.Pirate_EditorPlay up for play (max tick rate 180) at 2026.06.07-20.42.29
        [2026.06.07-18.42.45:717][ 80]LogNet: Login request: ?Password=1234?Name=FriendA userId: Steam:FriendA [0x11...8675] platform: Steam
        [2026.06.07-18.42.46:293][146]LogNet: Join succeeded: FriendA
        [2026.06.07-18.43.03:854][408]LogNet: Login request: ?Password=1234?Name=FriendB userId: Steam:Fb [0x11...0094] platform: Steam
        [2026.06.07-18.43.12:307][467]LogNet: Join succeeded: FriendB
        [2026.06.07-18.59.16:724][734]LogNet: UNetConnection::Close: [UNetConnection] RemoteAddr: 76561190000000002:7777, Name: SteamSocketsNetConnection_2147462899, Driver: GameNetDriver SteamSocketsNetDriver_2147481708, IsServer: YES, PC: LobbyPlayerController_C_2147462895, Owner: LobbyPlayerController_C_2147462895, UniqueId: Steam:FriendA [0x11...8675], Channels: 10, Time: 2026.06.07-18.59.16
    ";

    #[test]
    fn session_counts_peers() {
        let s = replay(&mut Nop, HOSTING);
        assert_eq!(s.map(), Some("Pirate_EditorPlay"));
        assert_eq!(s.net, Net::Hosting);
        assert_eq!(s.game_class, "LobbyMode_C");
        assert!(s.loaded);
        assert_eq!(s.opt("WorkshopMap"), Some("3716538442"));
        assert_eq!(s.players(), Some(2));

        // a loading map keeps the card, the menu drops the peers
        let s = replay(
            &mut Nop,
            &format!(
                "{HOSTING}\n[2026.06.07-19.00.00:000][1]LogLoad: LoadMap: /Game/Maps/TransitionMap"
            ),
        );
        assert_eq!(s.map(), Some("Pirate_EditorPlay"));
        let s = replay(
            &mut Nop,
            &format!(
                "{HOSTING}\n[2026.06.07-19.00.00:000][1]LogLoad: LoadMap: /Game/Maps/MainMenu"
            ),
        );
        assert_eq!(
            (s.map(), s.net, s.players()),
            (Some("MainMenu"), Net::Local, None)
        );
    }

    #[test]
    fn joined_takes_class_from_welcome() {
        let log = "
            [2026.03.15-16.12.41:515][430]LogNet: Browse: steam.76561190000000001/Game/Ride/Maps/Frontend_Snow?bIsFromInvite
            [2026.03.15-16.12.42:662][ 21]LogNet: Welcomed by server (Level: /Game/Ride/Maps/RideMap, Game: /Game/Ride/Character/Blueprints/GM_FirstPerson.GM_FirstPerson_C)
            [2026.03.15-16.12.42:662][ 21]LogLoad: LoadMap: steam.76561190000000001/Game/Ride/Maps/RideMap?bIsFromInvite
        ";
        let s = replay(&mut Nop, log);
        assert_eq!((s.map(), s.net), (Some("RideMap"), Net::Joined));
        assert_eq!(s.game_class, "GM_FirstPerson_C");
        assert_eq!(s.players(), None);
        let s = replay(
            &mut Nop,
            &format!("{log}\nLog file open, 06/07/26 20:40:53"),
        );
        assert_eq!(s.map(), None);
    }

    #[test]
    fn people_and_words() {
        let s = replay(&mut Nop, HOSTING);
        let mut parts = Vec::new();
        assert_eq!(
            people(&mut parts, &s, None, Some(4), true, true),
            Some([2, 4])
        );
        assert_eq!(parts, vec!["Hosting"]);
        let mut parts = Vec::new();
        assert_eq!(people(&mut parts, &s, None, None, false, true), None);
        assert_eq!(parts, vec!["2 players"]);
        let mut parts = Vec::new();
        assert_eq!(people(&mut parts, &s, None, None, false, false), None);
        assert!(parts.is_empty());
        assert_eq!(words("ElectricalStation"), "Electrical Station");
        assert_eq!(words("Grassland_Night"), "Grassland Night");
        assert_eq!(words("Map_Menu_1_02"), "Map Menu 1 02");
    }

    #[test]
    fn follower_scans_then_tails() {
        let dir = std::env::temp_dir().join(format!("clipdip-unreal-{}", std::process::id()));
        let logs = dir.join("Proj").join("Saved").join("Logs");
        std::fs::create_dir_all(&logs).unwrap();
        let p = logs.join("Proj.log");
        std::fs::write(&p, "\u{feff}Log file open\r\n[2026.06.07-18.42.28:919][701]LogLoad: LoadMap: /Game/Maps/A\r\nhalf").unwrap();
        let mut f = Follower {
            path: Some(p.clone()),
            tail: None,
            not_before_ms: 0,
        };
        let mut got = Vec::new();
        assert!(f.poll(|l| got.push(l.to_string())));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], "Log file open");
        use std::io::Write;
        let mut w = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        write!(w, "\nnew line\n").unwrap();
        f.poll(|l| got.push(l.to_string()));
        assert_eq!(
            got,
            [
                "Log file open",
                "[2026.06.07-18.42.28:919][701]LogLoad: LoadMap: /Game/Maps/A",
                "half",
                "new line"
            ]
        );
        assert_eq!(got.last().map(String::as_str), Some("new line"));

        let mut stale = Follower {
            path: Some(p),
            tail: None,
            not_before_ms: crate::util::now_ms() + 3_600_000,
        };
        assert!(!stale.poll(|_| {}));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn world_only_mismatches_and_interleaved_logins() {
        let mut s = Session::default();
        assert_eq!(
            s.feed(
                Some(100),
                "LogWorld: Bringing World /Game/Maps/A.A up for play",
                &[]
            ),
            Fed::Map
        );
        assert_eq!(s.map(), Some("A"));
        assert!(s.loaded);
        s.feed(Some(200), "LogLoad: LoadMap: /Game/Maps/B?listen", &[]);
        s.feed(
            None,
            "LogWorld: Bringing World /Game/Maps/A.A up for play",
            &[],
        );
        assert!(!s.loaded);
        s.feed(
            None,
            "LogNet: Login request: ?Name=A userId: Steam:A [0001] platform: Steam",
            &[],
        );
        s.feed(
            None,
            "LogNet: Login request: ?Name=B userId: Steam:B [0002] platform: Steam",
            &[],
        );
        s.feed(None, "LogNet: Join succeeded: A", &[]);
        s.feed(None, "LogNet: Join succeeded: B", &[]);
        assert_eq!(s.players(), Some(3));
        s.feed(None, "LogNet: UNetConnection::Close: PC: Controller, UniqueId: Steam:Renamed [0001], Channels: 10", &[]);
        assert_eq!(s.players(), Some(2));
        s.feed(
            Some(300),
            "LogNet: Browse: steam.76561190000000001/Game/Maps/C",
            &[],
        );
        assert_eq!(s.map(), Some("B"));
        s.feed(
            Some(400),
            "LogWorld: Bringing World /Game/Maps/C.C up for play",
            &[],
        );
        assert_eq!(s.map(), Some("C"));
        assert_eq!(s.net, Net::Joined);
        assert_eq!(s.since_ms, Some(300));
        assert_eq!(s.players(), None);
    }

    #[test]
    fn startup_preserves_concurrent_appends_and_caps_lines() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("clipdip-unreal-race-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Game.log");
        std::fs::write(&path, "Log file open\nlast old line\n").unwrap();
        let mut follow = Follower {
            path: Some(path.clone()),
            tail: None,
            not_before_ms: 0,
        };
        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        let mut got = Vec::new();
        assert!(follow.poll(|line| {
            if line == "Log file open" {
                writeln!(writer, "appended during scan").unwrap();
            }
            got.push(line.to_string());
        }));
        assert_eq!(
            got,
            ["Log file open", "last old line", "appended during scan"]
        );
        follow.poll(|line| got.push(line.to_string()));
        assert_eq!(got.len(), 3);
        drop(writer);
        std::fs::write(&path, format!("{}\nshort\n", "x".repeat(MAX_LINE * 2))).unwrap();
        let mut lines = Vec::new();
        assert_eq!(
            scan(&path, std::fs::metadata(&path).unwrap().len(), &mut |l| {
                lines.push(l.to_string())
            }),
            Some("short".into())
        );
        assert_eq!(lines, ["short"]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
