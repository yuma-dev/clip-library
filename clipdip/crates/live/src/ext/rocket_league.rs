//! Score, clock and arena from Rocket League's Stats API. Ported from rlstatsapi by xentrick (MIT),
//! https://github.com/xentrick/rlstatsapi: src/events.rs (message types), src/client.rs (stream
//! framing), src/config.rs (DefaultStatsAPI.ini handling).

use std::io::Read;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tracing::{debug, info};

use crate::util::{clamp, exe_name, now_ms};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "rocket_league",
    name: "Rocket League",
    blurb: "Shows the score, time left and arena of your match.",
    setup: Some("ClipLib turns on Rocket League's Stats API the first time you play. It works from the next game start."),
    credits: &[Credit {
        project: "rlstatsapi",
        author: "xentrick",
        url: "https://github.com/xentrick/rlstatsapi",
        license: "MIT",
    }],
    options: &[
        Opt::toggle("show_score", "Show score", "Team scores, and who won at the end.", true),
        Opt::toggle("show_time", "Show time left", "Match clock, or overtime.", true),
        Opt::toggle("show_arena", "Show arena", "The arena you're playing on.", true),
    ],
    matches,
    run,
    priority: 10,
    game_ids: &[DISCORD_APP_ID],
    art: Some("https://cdn.cloudflare.steamstatic.com/steam/apps/252950/header.jpg"),
    preview,
    scenarios: &[
        ("kickoff", "Kickoff"),
        ("in_game", "In game"),
        ("overtime", "Overtime"),
        ("post_game", "Post game"),
    ],
    steam_game: true,
    listed: true,
};

const DISCORD_APP_ID: &str = "356877880938070016";
const DEFAULT_PORT: u16 = 49123;
/// updates per second we ask for; the game caps it at 120, 0 turns the api off
const OUR_RATE: &str = "2";
const SECTION: &str = "[TAGame.MatchStatsExporter_TA]";
const RETRY: Duration = Duration::from_secs(10);
/// a half sent message never gets this big, the full UpdateState is a few KB
const MAX_BUF: usize = 1 << 20;
/// no UpdateState for this long and the match is treated as gone
const STALE_MS: i64 = 60_000;

fn matches(t: &Target) -> bool {
    t.game_id == DISCORD_APP_ID || exe_name(t) == "rocketleague.exe"
}

struct Opts {
    score: bool,
    time: bool,
    arena: bool,
}

impl Opts {
    fn new(s: &Settings) -> Self {
        Opts {
            score: s.flag("show_score"),
            time: s.flag("show_time"),
            arena: s.flag("show_arena"),
        }
    }
}

/// Sample matches through the same `Match::live` the stream uses.
/// The clock only counts as running when it moved in the last 2.5 s.
fn preview(s: &Settings, scenario: &str) -> Preview {
    let now = now_ms();
    let base = Match {
        names: ["Blue".into(), "Orange".into()],
        last_update_ms: now,
        ..Match::default()
    };
    let mut m = match scenario {
        // 2v2, Blue up 2 - 1 with 2:31 on a running clock
        "in_game" => Match {
            scores: [2, 1],
            players: [2, 2],
            arena: Some("Stadium_P".into()),
            secs: Some(151),
            clock_changed_ms: Some(now),
            ..base
        },
        // tied 3v3 in overtime, 0:34 into it
        "overtime" => Match {
            scores: [1, 1],
            players: [3, 3],
            arena: Some("UtopiaStadium_P".into()),
            secs: Some(34),
            overtime: true,
            clock_changed_ms: Some(now),
            ..base
        },
        "post_game" => Match {
            scores: [3, 1],
            players: [2, 2],
            arena: Some("NeoTokyo_Standard_P".into()),
            secs: Some(0),
            winner: Some(0),
            ..base
        },
        // 3v3 kickoff, clock stopped at 5:00
        _ => Match {
            players: [3, 3],
            arena: Some("EuroStadium_Night_P".into()),
            secs: Some(300),
            ..base
        },
    };
    Preview {
        game: "Rocket League",
        icon: None,
        live: m.live(&Opts::new(s), now),
    }
}

fn run(ctx: &Ctx) {
    let port = ctx
        .target()
        .exe
        .as_deref()
        .and_then(enable_stats_api)
        .unwrap_or(DEFAULT_PORT);
    let opts = Opts::new(ctx.settings());
    while ctx.running() {
        if let Some(sock) = connect(port) {
            info!(port, "rocket league: stats api connected");
            stream(ctx, sock, &opts);
            debug!("rocket league: stats api gone");
        }
        ctx.emit(None);
        if !ctx.sleep(RETRY) {
            return;
        }
    }
}

fn connect(port: u16) -> Option<TcpStream> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let sock = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    // short timeout so the loop still rebuilds the card and notices the session ending
    sock.set_read_timeout(Some(Duration::from_secs(1))).ok()?;
    Some(sock)
}

/// Reads until the game closes the socket or the session ends.
fn stream(ctx: &Ctx, mut sock: TcpStream, opts: &Opts) {
    let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024);
    let mut chunk = [0u8; 16 * 1024];
    let mut game = Game::default();
    let mut last_build = 0i64;
    while ctx.running() {
        match sock.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(chunk.get(..n).unwrap_or_default());
                let now = now_ms();
                drain_events(&mut buf, |ev| game.apply(ev, now));
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
        }
        let now = now_ms();
        if now - last_build >= 1000 {
            last_build = now;
            ctx.emit(game.live(opts, now));
        }
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Envelope {
    #[serde(rename = "Event", alias = "event")]
    event: String,
    #[serde(rename = "Data", alias = "data")]
    data: Value,
}

/// Messages come back to back with no delimiter, so the JSON parser finds the
/// ends (same as the crate's client).
fn drain_events(buf: &mut Vec<u8>, mut on_event: impl FnMut(Envelope)) {
    loop {
        let skip = buf
            .iter()
            .take_while(|b| b.is_ascii_whitespace() || **b == 0)
            .count();
        buf.drain(..skip);
        if buf.is_empty() {
            return;
        }
        let parsed = {
            let mut it = serde_json::Deserializer::from_slice(buf).into_iter::<Envelope>();
            match it.next() {
                Some(Ok(env)) => Ok((env, it.byte_offset())),
                Some(Err(e)) => Err(e.is_eof()),
                None => Err(true),
            }
        };
        match parsed {
            Ok((env, used)) => {
                buf.drain(..used.min(buf.len()));
                on_event(env);
            }
            Err(true) => {
                if buf.len() > MAX_BUF {
                    buf.clear();
                }
                return;
            }
            // garbage: skip to the next message start
            Err(false) => match find(buf.get(1..).unwrap_or_default(), b"{\"Event\"") {
                Some(i) => {
                    buf.drain(..i + 1);
                }
                None => {
                    buf.clear();
                    return;
                }
            },
        }
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Data is a JSON string holding the object in the real stream, an object in some captures.
fn event_data<T: for<'de> Deserialize<'de>>(data: Value) -> Option<T> {
    match data {
        Value::String(raw) => serde_json::from_str(&raw).ok(),
        other => serde_json::from_value(other).ok(),
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct UpdateState {
    #[serde(rename = "MatchGuid")]
    match_guid: Option<String>,
    #[serde(rename = "Players")]
    players: Vec<PlayerState>,
    #[serde(rename = "Game")]
    game: GameState,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PlayerState {
    #[serde(rename = "TeamNum")]
    team_num: Option<i64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct GameState {
    #[serde(rename = "Teams")]
    teams: Vec<TeamState>,
    #[serde(rename = "TimeSeconds")]
    time_seconds: Option<i64>,
    #[serde(rename = "bOvertime")]
    b_overtime: Option<bool>,
    #[serde(rename = "bHasWinner")]
    b_has_winner: Option<bool>,
    #[serde(rename = "Winner")]
    winner: Option<String>,
    #[serde(rename = "Arena")]
    arena: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TeamState {
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "TeamNum")]
    team_num: Option<i64>,
    #[serde(rename = "Score")]
    score: Option<i64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ClockUpdated {
    #[serde(rename = "TimeSeconds")]
    time_seconds: i64,
    #[serde(rename = "bOvertime")]
    b_overtime: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct MatchEnded {
    #[serde(rename = "WinnerTeamNum")]
    winner_team_num: i64,
}

#[derive(Default)]
struct Game {
    m: Option<Match>,
}

#[derive(Default)]
struct Match {
    guid: Option<String>,
    /// blue (0), orange (1)
    names: [String; 2],
    scores: [i64; 2],
    players: [u32; 2],
    arena: Option<String>,
    /// regulation counts down, overtime counts up from 0
    secs: Option<i64>,
    overtime: bool,
    clock_changed_ms: Option<i64>,
    /// (overtime, unix ms) the shown timer points at, kept while it's within 2 s
    anchor: Option<(bool, i64)>,
    winner: Option<usize>,
    last_update_ms: i64,
}

impl Game {
    fn apply(&mut self, ev: Envelope, now: i64) {
        match ev.event.as_str() {
            "UpdateState" => {
                if let Some(s) = event_data::<UpdateState>(ev.data) {
                    self.update(s, now);
                }
            }
            "ClockUpdatedSeconds" => {
                if let (Some(c), Some(m)) = (event_data::<ClockUpdated>(ev.data), self.m.as_mut()) {
                    m.set_clock(c.time_seconds, c.b_overtime, now);
                }
            }
            "MatchCreated" => {
                self.m = Some(Match {
                    last_update_ms: now,
                    ..Match::default()
                })
            }
            "MatchEnded" => {
                if let (Some(e), Some(m)) = (event_data::<MatchEnded>(ev.data), self.m.as_mut()) {
                    m.winner = usize::try_from(e.winner_team_num).ok().filter(|t| *t < 2);
                    m.clock_changed_ms = None;
                }
            }
            "MatchDestroyed" => self.m = None,
            _ => {}
        }
    }

    fn update(&mut self, s: UpdateState, now: i64) {
        let new_match = match (&self.m, &s.match_guid) {
            (None, _) => true,
            (Some(m), Some(g)) => m.guid.as_ref().is_some_and(|old| old != g),
            _ => false,
        };
        if new_match {
            self.m = Some(Match::default());
        }
        let Some(m) = self.m.as_mut() else { return };
        m.last_update_ms = now;
        if s.match_guid.is_some() {
            m.guid = s.match_guid;
        }
        let g = s.game;
        for t in g.teams {
            let Some(i) = t
                .team_num
                .and_then(|n| usize::try_from(n).ok())
                .filter(|i| *i < 2)
            else {
                continue;
            };
            if let Some(slot) = m.names.get_mut(i) {
                *slot = t.name.unwrap_or_default();
            }
            if let Some(slot) = m.scores.get_mut(i) {
                *slot = t.score.unwrap_or(0);
            }
        }
        let mut players = [0u32; 2];
        for p in &s.players {
            match p.team_num {
                Some(0) => players[0] += 1,
                Some(1) => players[1] += 1,
                _ => {}
            }
        }
        m.players = players;
        if let Some(a) = g.arena.filter(|a| !a.is_empty()) {
            m.arena = Some(a);
        }
        if let Some(secs) = g.time_seconds {
            m.set_clock(secs, g.b_overtime.unwrap_or(false), now);
        }
        if g.b_has_winner == Some(true) && m.winner.is_none() {
            let w = g.winner.unwrap_or_default();
            m.winner = (0..2).find(|i| team_name(&m.names, *i).eq_ignore_ascii_case(&w));
        }
    }

    fn live(&mut self, opts: &Opts, now: i64) -> Option<Live> {
        let m = self.m.as_mut()?;
        if now - m.last_update_ms > STALE_MS {
            self.m = None;
            return None;
        }
        Some(m.live(opts, now))
    }
}

impl Match {
    fn set_clock(&mut self, secs: i64, overtime: bool, now: i64) {
        let changed = self.secs.is_some_and(|old| old != secs)
            || (self.secs.is_some() && self.overtime != overtime);
        if changed {
            self.clock_changed_ms = Some(now);
        }
        self.secs = Some(secs);
        self.overtime = overtime;
    }

    /// The clock stops for kickoff countdowns, goal replays and pauses; a
    /// Discord timer only makes sense while it ticks.
    fn clock_running(&self, now: i64) -> bool {
        self.winner.is_none() && self.clock_changed_ms.is_some_and(|t| now - t < 2500)
    }

    fn live(&mut self, opts: &Opts, now: i64) -> Live {
        let mut live = Live::default();

        let mut details = Vec::new();
        let size = self.players[0].max(self.players[1]);
        if size > 0 {
            details.push(format!("{size}v{size}"));
        }
        if opts.arena {
            if let Some(a) = self.arena.as_deref().and_then(arena_name) {
                details.push(a.to_string());
            }
        }
        live.details = clamp(if details.is_empty() {
            "In a match".to_string()
        } else {
            details.join(" · ")
        });

        let mut state = Vec::new();
        if let Some(w) = self.winner {
            let name = team_name(&self.names, w);
            let (a, b) = (self.scores[w], self.scores[1 - w]);
            state.push(if opts.score {
                format!("{name} won {a} - {b}")
            } else {
                format!("{name} won")
            });
            self.anchor = None;
        } else {
            if opts.score {
                state.push(format!(
                    "{} {} - {} {}",
                    team_name(&self.names, 0),
                    self.scores[0],
                    self.scores[1],
                    team_name(&self.names, 1)
                ));
            }
            if opts.time {
                if let Some(secs) = self.secs {
                    if self.clock_running(now) {
                        let target = if self.overtime {
                            now - secs * 1000
                        } else {
                            now + secs * 1000
                        };
                        let keep = self.anchor.is_some_and(|(ot, at)| {
                            ot == self.overtime && (at - target).abs() <= 2000
                        });
                        if !keep {
                            self.anchor = Some((self.overtime, target));
                        }
                    } else {
                        self.anchor = None;
                    }
                    match self.anchor {
                        Some((true, at)) => live.start_ms = Some(at),
                        Some((false, at)) => live.end_ms = Some(at),
                        None => {}
                    }
                    if self.overtime {
                        state.push("Overtime".to_string());
                    } else if self.anchor.is_none() && secs > 0 {
                        state.push(format!("{}:{:02} left", secs / 60, secs % 60));
                    }
                }
            }
        }
        if !state.is_empty() {
            live.state = clamp(state.join(", "));
        }
        live
    }
}

fn team_name(names: &[String; 2], i: usize) -> &str {
    match names.get(i).map(|n| n.trim()) {
        Some(n) if !n.is_empty() => n,
        _ if i == 0 => "Blue",
        _ => "Orange",
    }
}

/// Map names for the Arena codes the Stats API sends (the level package names)
fn arena_name(code: &str) -> Option<&'static str> {
    let code = code.to_ascii_lowercase();
    let name = match code.as_str() {
        "stadium_p" => "DFH Stadium",
        "stadium_day_p" => "DFH Stadium (Day)",
        "stadium_foggy_p" => "DFH Stadium (Stormy)",
        "stadium_winter_p" => "DFH Stadium (Snowy)",
        "stadium_race_day_p" => "DFH Stadium (Circuit)",
        "stadium_10a_p" => "DFH Stadium (10th Anniversary)",
        "eurostadium_p" => "Mannfield",
        "eurostadium_night_p" => "Mannfield (Night)",
        "eurostadium_rainy_p" => "Mannfield (Stormy)",
        "eurostadium_snownight_p" => "Mannfield (Snowy)",
        "eurostadium_dusk_p" => "Mannfield (Dusk)",
        "cs_p" => "Champions Field",
        "cs_day_p" => "Champions Field (Day)",
        "cs_hw_p" => "Rivals Arena",
        "trainstation_p" => "Urban Central",
        "trainstation_night_p" => "Urban Central (Night)",
        "trainstation_dawn_p" => "Urban Central (Dawn)",
        "haunted_trainstation_p" => "Urban Central (Haunted)",
        "park_p" => "Beckwith Park",
        "park_night_p" => "Beckwith Park (Midnight)",
        "park_rainy_p" => "Beckwith Park (Stormy)",
        "park_snowy_p" => "Beckwith Park (Snowy)",
        "utopiastadium_p" => "Utopia Coliseum",
        "utopiastadium_dusk_p" => "Utopia Coliseum (Dusk)",
        "utopiastadium_snow_p" => "Utopia Coliseum (Snowy)",
        "utopiastadium_lux_p" => "Utopia Coliseum (Gilded)",
        "wasteland_s_p" => "Wasteland",
        "wasteland_night_s_p" => "Wasteland (Night)",
        "neotokyo_standard_p" => "Neo Tokyo",
        "neotokyo_arcade_p" => "Neo Tokyo (Arcade)",
        "neotokyo_hax_p" => "Neo Tokyo (Hacked)",
        "underwater_p" => "AquaDome",
        "underwater_grs_p" => "AquaDome (Salty Shallows)",
        "farm_p" => "Farmstead",
        "farm_night_p" => "Farmstead (Night)",
        "farm_upsidedown_p" => "Farmstead (The Upside Down)",
        "beach_p" => "Salty Shores",
        "beach_night_p" => "Salty Shores (Night)",
        "music_p" => "Forbidden Temple",
        "arc_standard_p" => "Starbase ARC",
        "arc_darc_p" => "Starbase ARC (Aftermath)",
        "outlaw_p" => "Deadeye Canyon",
        "woods_p" => "Drift Woods",
        "woods_night_p" => "Drift Woods (Night)",
        "street_p" => "Sovereign Heights",
        "ff_dusk_p" => "Estadio Vida",
        "fni_stadium_p" => "Futura Garden",
        "throwbackstadium_p" => "Throwback Stadium",
        "hoopsstadium_p" => "Dunk House",
        "hoopsstreet_p" => "The Block",
        "shattershot_p" => "Core 707",
        _ => return None,
    };
    Some(name)
}

/// The Stats API is off until DefaultStatsAPI.ini has PacketSendRate > 0, and
/// the game reads it at launch. Turns it on at a low rate, never lowers a
/// user's rate, keeps one .bak. Returns the port to connect to.
fn enable_stats_api(exe: &Path) -> Option<u16> {
    // <root>\Binaries\Win64\RocketLeague.exe
    let root = exe.parent()?.parent()?.parent()?;
    let dir = root.join("TAGame").join("Config");
    if !dir.is_dir() {
        return None;
    }
    let ini: PathBuf = dir.join("DefaultStatsAPI.ini");
    let text = match std::fs::read(&ini) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return None,
    };
    let (patched, port) = patch_ini(&text);
    if let Some(new) = patched {
        let bak = dir.join("DefaultStatsAPI.ini.bak");
        if ini.exists() && !bak.exists() {
            let _ = std::fs::copy(&ini, &bak);
        }
        match std::fs::write(&ini, new) {
            Ok(()) => info!("rocket league: stats api turned on, works from the next game start"),
            Err(e) => debug!("rocket league: can't write DefaultStatsAPI.ini: {e}"),
        }
    }
    Some(port)
}

/// Returns the new file text if anything had to change, and the port.
fn patch_ini(text: &str) -> (Option<String>, u16) {
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let header = lines
        .iter()
        .position(|l| trim_line(l).eq_ignore_ascii_case(SECTION));
    let mut changed = false;
    let (start, end) = match header {
        Some(h) => {
            let rest = lines.get(h + 1..).unwrap_or_default();
            let end = rest
                .iter()
                .position(|l| trim_line(l).starts_with('['))
                .map_or(lines.len(), |i| h + 1 + i);
            (h + 1, end)
        }
        None => {
            if lines.last().is_some_and(|l| !l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push(SECTION.to_string());
            changed = true;
            (lines.len(), lines.len())
        }
    };

    let mut inserts = Vec::new();
    let mut port = DEFAULT_PORT;
    match find_key(&lines, start, end, "Port") {
        Some((i, v)) => match v.parse::<u16>() {
            Ok(p) if p > 0 => port = p,
            _ => {
                lines[i] = format!("Port={DEFAULT_PORT}");
                changed = true;
            }
        },
        None => inserts.push(format!("Port={DEFAULT_PORT}")),
    }
    match find_key(&lines, start, end, "PacketSendRate") {
        Some((i, v)) => {
            if !v.parse::<f32>().is_ok_and(|r| r > 0.0) {
                lines[i] = format!("PacketSendRate={OUR_RATE}");
                changed = true;
            }
        }
        None => inserts.push(format!("PacketSendRate={OUR_RATE}")),
    }
    if !inserts.is_empty() {
        // after the section's last non blank line, so trailing blank lines stay a separator
        let mut at = end;
        while at > start && lines.get(at - 1).is_some_and(|l| l.trim().is_empty()) {
            at -= 1;
        }
        for (k, line) in inserts.into_iter().enumerate() {
            lines.insert(at + k, line);
        }
        changed = true;
    }
    if !changed {
        return (None, port);
    }
    let mut out = lines.join(nl);
    out.push_str(nl);
    (Some(out), port)
}

fn trim_line(l: &str) -> &str {
    l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// (line index, value) of `key` between `start` and `end`, comments skipped
fn find_key(lines: &[String], start: usize, end: usize, key: &str) -> Option<(usize, String)> {
    (start..end.min(lines.len())).find_map(|i| {
        let t = trim_line(lines.get(i)?);
        if t.starts_with(';') || t.starts_with('#') {
            return None;
        }
        let (k, v) = t.split_once('=')?;
        k.trim()
            .eq_ignore_ascii_case(key)
            .then(|| (i, v.trim().to_string()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPTS: Opts = Opts {
        score: true,
        time: true,
        arena: true,
    };

    fn update(time: i64, ot: bool, blue: i64, orange: i64) -> String {
        let inner = serde_json::json!({
            "MatchGuid": "1F7ED23011F1435166EBAB919DB5566D",
            "Players": [
                {"Name": "nickm", "Shortcut": 1, "TeamNum": 0, "Boost": 33},
                {"Name": "Zone Killa", "Shortcut": 5, "TeamNum": 1}
            ],
            "Game": {
                "Teams": [
                    {"Name": "Blue", "TeamNum": 0, "Score": blue, "ColorPrimary": "1873FF"},
                    {"Name": "Orange", "TeamNum": 1, "Score": orange, "ColorPrimary": "C26418"}
                ],
                "TimeSeconds": time, "bOvertime": ot, "bReplay": false,
                "bHasWinner": false, "Winner": "", "Arena": "cs_p",
                "bHasTarget": true, "Target": {"Name": "nickm", "Shortcut": 1, "TeamNum": 0}
            }
        });
        // Event first, like the game sends it (json! would sort the keys)
        format!(
            r#"{{"Event":"UpdateState","Data":{}}}"#,
            Value::String(inner.to_string())
        )
    }

    fn feed(game: &mut Game, raw: &str, now: i64) {
        let mut buf = raw.as_bytes().to_vec();
        drain_events(&mut buf, |ev| game.apply(ev, now));
    }

    #[test]
    fn framing_back_to_back_and_split() {
        let a = update(81, false, 0, 1);
        let b = r#"{"Event":"MatchEnded","Data":{"MatchGuid":"x","WinnerTeamNum":1}}"#;
        let all = format!("{a}{b}  ");
        let mut buf = Vec::new();
        let mut seen = Vec::new();
        let (first, second) = all.as_bytes().split_at(a.len() / 2);
        buf.extend_from_slice(first);
        drain_events(&mut buf, |ev| seen.push(ev.event));
        assert!(seen.is_empty());
        buf.extend_from_slice(second);
        drain_events(&mut buf, |ev| seen.push(ev.event));
        assert_eq!(seen, ["UpdateState", "MatchEnded"]);
        assert!(buf.is_empty());
    }

    #[test]
    fn framing_skips_garbage() {
        let mut buf = format!("xx]{}", update(10, false, 0, 0)).into_bytes();
        let mut n = 0;
        drain_events(&mut buf, |_| n += 1);
        assert_eq!(n, 1);
    }

    #[test]
    fn running_clock_counts_down() {
        let mut g = Game::default();
        feed(&mut g, &update(152, false, 2, 1), 1_000);
        // first packet: clock not seen moving yet, static text
        let l = g.live(&OPTS, 1_000).unwrap();
        assert_eq!(l.details.as_deref(), Some("1v1 · Champions Field"));
        assert_eq!(l.state.as_deref(), Some("Blue 2 - 1 Orange, 2:32 left"));
        assert_eq!(l.end_ms, None);

        feed(&mut g, &update(151, false, 2, 1), 2_000);
        let l = g.live(&OPTS, 2_000).unwrap();
        assert_eq!(l.state.as_deref(), Some("Blue 2 - 1 Orange"));
        assert_eq!(l.end_ms, Some(2_000 + 151_000));
        // jitter within 2 s keeps the same end
        feed(&mut g, &update(150, false, 2, 1), 3_400);
        assert_eq!(g.live(&OPTS, 3_400).unwrap().end_ms, Some(153_000));
        // clock stopped (goal replay)
        assert_eq!(
            g.live(&OPTS, 9_000).unwrap().state.as_deref(),
            Some("Blue 2 - 1 Orange, 2:30 left")
        );
    }

    #[test]
    fn overtime_counts_up() {
        let mut g = Game::default();
        feed(&mut g, &update(3, true, 1, 1), 10_000);
        feed(&mut g, &update(4, true, 1, 1), 11_000);
        let l = g.live(&OPTS, 11_000).unwrap();
        assert_eq!(l.state.as_deref(), Some("Blue 1 - 1 Orange, Overtime"));
        assert_eq!(l.start_ms, Some(7_000));
        assert_eq!(l.end_ms, None);
    }

    #[test]
    fn match_end_and_destroy() {
        let mut g = Game::default();
        feed(&mut g, &update(0, false, 1, 3), 0);
        feed(
            &mut g,
            r#"{"Event":"MatchEnded","Data":"{\"MatchGuid\":\"x\",\"WinnerTeamNum\":1}"}"#,
            0,
        );
        let l = g.live(&OPTS, 500).unwrap();
        assert_eq!(l.state.as_deref(), Some("Orange won 3 - 1"));
        let quiet = Opts {
            score: false,
            time: false,
            arena: false,
        };
        let l = g.live(&quiet, 500).unwrap();
        assert_eq!(l.details.as_deref(), Some("1v1"));
        assert_eq!(l.state.as_deref(), Some("Orange won"));
        feed(
            &mut g,
            r#"{"Event":"MatchDestroyed","Data":{"MatchGuid":"x"}}"#,
            600,
        );
        assert!(g.live(&OPTS, 700).is_none());
    }

    #[test]
    fn stale_match_clears() {
        let mut g = Game::default();
        feed(&mut g, &update(100, false, 0, 0), 0);
        assert!(g.live(&OPTS, STALE_MS + 1).is_none());
    }

    #[test]
    fn ini_default_file_gets_rate() {
        let shipped = "[TAGame.MatchStatsExporter_TA]\r\n\r\n; Port the client will listen for connections on\r\nPort=49123\r\n\r\n; How many times per second the game sends the update state (capped at 120, 0 disables this feature)\r\nPacketSendRate=0\r\n";
        let (new, port) = patch_ini(shipped);
        assert_eq!(port, 49123);
        let new = new.unwrap();
        assert!(new.contains("\r\nPacketSendRate=2\r\n"));
        assert!(new.contains("; Port the client"));
        // second run changes nothing
        assert_eq!(patch_ini(&new).0, None);
    }

    #[test]
    fn ini_keeps_user_values() {
        let (new, port) =
            patch_ini("[TAGame.MatchStatsExporter_TA]\nPort=50000\nPacketSendRate=60\n");
        assert_eq!(new, None);
        assert_eq!(port, 50000);
    }

    #[test]
    fn ini_missing_keys_and_section() {
        let (new, _) = patch_ini("[Other]\nFoo=1\n");
        assert_eq!(
            new.unwrap(),
            "[Other]\nFoo=1\n\n[TAGame.MatchStatsExporter_TA]\nPort=49123\nPacketSendRate=2\n"
        );
        let (new, _) =
            patch_ini("[TAGame.MatchStatsExporter_TA]\nPort=49123\n\n[Other]\nPacketSendRate=0\n");
        assert_eq!(
            new.unwrap(),
            "[TAGame.MatchStatsExporter_TA]\nPort=49123\nPacketSendRate=2\n\n[Other]\nPacketSendRate=0\n"
        );
        let (new, port) = patch_ini("");
        assert_eq!(port, 49123);
        assert_eq!(
            new.unwrap(),
            "[TAGame.MatchStatsExporter_TA]\nPort=49123\nPacketSendRate=2\n"
        );
    }

    #[test]
    fn preview_follows_toggles() {
        let on = preview(&Settings::new(&MANIFEST, serde_json::json!({})), "in_game");
        assert_eq!(on.live.details.as_deref(), Some("2v2 · DFH Stadium"));
        assert_eq!(on.live.state.as_deref(), Some("Blue 2 - 1 Orange"));
        assert!(on.live.end_ms.is_some());
        let off = preview(
            &Settings::new(
                &MANIFEST,
                serde_json::json!({ "show_score": false, "show_arena": false }),
            ),
            "in_game",
        );
        assert_eq!(off.live.details.as_deref(), Some("2v2"));
        assert_eq!(off.live.state, None);
        let no_time = preview(
            &Settings::new(&MANIFEST, serde_json::json!({ "show_time": false })),
            "in_game",
        );
        assert_eq!(no_time.live.end_ms, None);
    }

    #[test]
    fn every_scenario_has_a_card() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        let card = |k: &str| preview(&s, k).live;
        assert_eq!(
            card("kickoff").details.as_deref(),
            Some("3v3 · Mannfield (Night)")
        );
        assert_eq!(
            card("kickoff").state.as_deref(),
            Some("Blue 0 - 0 Orange, 5:00 left")
        );
        assert_eq!(
            card("overtime").state.as_deref(),
            Some("Blue 1 - 1 Orange, Overtime")
        );
        assert!(card("overtime").start_ms.is_some());
        assert_eq!(card("post_game").state.as_deref(), Some("Blue won 3 - 1"));
        for (k, _) in MANIFEST.scenarios {
            assert!(!card(k).is_empty(), "{k}");
        }
        assert_eq!(card("nope"), card(MANIFEST.scenarios[0].0));
        assert_eq!(card(""), card("kickoff"));
    }

    #[test]
    fn matching() {
        let t = Target {
            game_id: DISCORD_APP_ID.into(),
            ..Target::default()
        };
        assert!(matches(&t));
        let t = Target {
            game_id: "steam:252950".into(),
            exe: Some(PathBuf::from(
                r"C:\Games\rocketleague\Binaries\Win64\RocketLeague.exe",
            )),
            ..Target::default()
        };
        assert!(matches(&t));
        assert!(!matches(&Target::default()));
    }
}
