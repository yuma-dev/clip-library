//! Find The Needle (demo and full game): hay dug, best income, the needle and
//! all-time totals from the stats file the game keeps next to its save.
//!
//! The project is called "Haystack Incremental" inside, so the file sits at
//! %APPDATA%\Godot\app_userdata\Haystack Incremental\profile.cfg. Godot
//! ConfigFile text: `[career]` holds plain key=value totals, `[days]` one
//! dictionary per local date. It's rewritten with every autosave (120 s by
//! default), so the card moves in steps. The save itself is encrypted and stays
//! untouched; only `[career]` and `[days]` are read, the same file carries the
//! game's login tokens under `[identity]`.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Deserialize;

use crate::util::{self, clamp};
use crate::{Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "find_the_needle",
    name: "Find The Needle",
    blurb: "Hay dug today or in total, your best income, when you found the needle, and all-time totals.",
    setup: None,
    credits: &[Credit {
        project: "Godot ConfigFile format",
        author: "Godot Engine",
        url: "https://docs.godotengine.org/en/stable/classes/class_configfile.html",
        license: "docs",
    }],
    options: &[
        Opt::choice(
            "headline",
            "Hay count",
            "What the first line counts. Today starts with the first autosave of the session.",
            "today",
            &[("today", "Today"), ("total", "All time")],
        ),
        Opt::toggle(
            "show_income",
            "Show best income",
            "Your best money per second, until you find the needle.",
            true,
        ),
        Opt::toggle("show_needle", "Show the needle", "How long it took you to find it.", true),
        Opt::toggle(
            "show_totals",
            "Show all-time totals",
            "Money earned, structures built and hours played on the picture's hover.",
            true,
        ),
    ],
    matches,
    run,
    priority: 10,
    game_ids: GAME_IDS,
    art: Some(
        "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/5160800/9ad39ef753543a194a7546ee8a17dc4b821cd021/header.jpg",
    ),
    preview,
    scenarios: &[
        ("today", "Digging today"),
        ("total", "All time"),
        ("found", "Found the needle"),
    ],
    steam_game: true,
    listed: true,
};

const GAME_IDS: &[&str] = &["1549993920287612960"];
/// the full game, then the demo
const STEAM_APPS: &[&str] = &["steam:5160800", "steam:5165210"];
const PROJECT: &str = "Haystack Incremental";
const TICK: Duration = Duration::from_secs(10);

fn matches(t: &Target) -> bool {
    GAME_IDS.contains(&t.game_id.as_str())
        || STEAM_APPS.contains(&t.game_id.as_str())
        || t.steam_appid.as_deref().is_some_and(|a| STEAM_APPS.iter().any(|s| s[6..] == *a))
        || util::exe_name(t) == "findtheneedle.exe"
}

#[derive(Clone, Copy)]
struct Opts {
    today: bool,
    income: bool,
    needle: bool,
    totals: bool,
}

impl Opts {
    fn from(s: &Settings) -> Opts {
        Opts {
            today: s.choice("headline") != "total",
            income: s.flag("show_income"),
            needle: s.flag("show_needle"),
            totals: s.flag("show_totals"),
        }
    }
}

/// One stats block, `[career]` or a day. Godot writes every number as a float.
#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(default)]
struct Stats {
    hay_dug: f64,
    money_earned: f64,
    best_income: f64,
    structures_built: f64,
    needles_found: f64,
    first_needle_secs: f64,
    play_secs: f64,
    /// empty dictionaries so far; anything in them means the demo was finished
    demo_complete: serde_json::Value,
}

impl Stats {
    fn demo_done(&self) -> bool {
        match &self.demo_complete {
            serde_json::Value::Object(m) => !m.is_empty(),
            serde_json::Value::Bool(b) => *b,
            _ => false,
        }
    }
}

#[derive(Default, Debug, PartialEq)]
struct Profile {
    career: Stats,
    /// the newest `[days]` entry
    latest_day: Option<Stats>,
    any_demo_done: bool,
}

/// `[career]` and `[days]` out of profile.cfg, nothing else.
fn parse(text: &str) -> Option<Profile> {
    let mut section = "";
    let mut career = serde_json::Map::new();
    let mut days: Vec<(String, String)> = Vec::new();
    let mut open: Option<(String, String)> = None;
    for line in text.lines() {
        if let Some((_, body)) = open.as_mut() {
            body.push_str(line);
            body.push('\n');
            if line.trim_end() == "}" {
                days.extend(open.take());
            }
            continue;
        }
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            section = match t {
                "[career]" => "career",
                "[days]" => "days",
                _ => "",
            };
            continue;
        }
        let Some((k, v)) = t.split_once('=') else { continue };
        match section {
            "career" => {
                if let Ok(n) = v.trim().parse::<f64>() {
                    career.insert(k.trim().to_string(), serde_json::json!(n));
                }
            }
            "days" if v.trim() == "{" => open = Some((k.trim().to_string(), "{\n".into())),
            _ => {}
        }
    }
    if !career.contains_key("hay_dug") {
        return None;
    }
    let career: Stats = serde_json::from_value(serde_json::Value::Object(career)).ok()?;
    let mut parsed: Vec<(String, Stats)> = days
        .into_iter()
        .filter_map(|(k, body)| serde_json::from_str::<Stats>(&body).ok().map(|s| (k, s)))
        .collect();
    // ISO dates sort as text
    parsed.sort_by(|a, b| a.0.cmp(&b.0));
    let any_demo_done = career.demo_done() || parsed.iter().any(|(_, s)| s.demo_done());
    Some(Profile {
        career,
        latest_day: parsed.pop().map(|(_, s)| s),
        any_demo_done,
    })
}

/// 1366901 -> "1.37M", 441586 -> "442K", 50809 -> "50,809"
fn compact(n: f64) -> String {
    let n = n.max(0.0);
    if n < 1e5 {
        return thousands(n.round() as u64);
    }
    let (v, unit) = if n >= 1e12 {
        (n / 1e12, "T")
    } else if n >= 1e9 {
        (n / 1e9, "B")
    } else if n >= 1e6 {
        (n / 1e6, "M")
    } else {
        (n / 1e3, "K")
    };
    let s = if v >= 100.0 {
        format!("{v:.0}")
    } else if v >= 10.0 {
        format!("{v:.1}")
    } else {
        format!("{v:.2}")
    };
    let s = if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    };
    format!("{s}{unit}")
}

fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// 11520 -> "3 h 12 min", 2700 -> "45 min"
fn duration(secs: f64) -> String {
    let m = (secs.max(0.0) / 60.0).round() as u64;
    match (m / 60, m % 60) {
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

/// `today` holds the newest day only once the file was written this session, before that the
/// newest day can be yesterday
fn build(p: &Profile, today: Option<&Stats>, o: Opts) -> Live {
    let c = &p.career;
    let day = today.filter(|_| o.today);
    let details = match day {
        Some(d) => format!("{} hay dug today", compact(d.hay_dug)),
        None => format!("{} hay dug", compact(c.hay_dug)),
    };
    let found = c.needles_found >= 1.0;
    let state = if o.needle && found {
        Some(match (c.needles_found as u64, c.first_needle_secs > 0.0) {
            (1, true) => format!("Found the needle after {}", duration(c.first_needle_secs)),
            (1, false) => "Found the needle".to_string(),
            (n, _) => format!("Found {n} needles"),
        })
    } else if o.income {
        let best = day.map(|d| d.best_income).unwrap_or(c.best_income);
        (best > 0.0).then(|| format!("Earning up to ${}/s", compact(best)))
    } else {
        None
    };
    let large_text = o.totals.then(|| {
        let mut parts = Vec::new();
        if p.any_demo_done {
            parts.push("Demo finished".to_string());
        }
        parts.push(format!("${} earned", compact(c.money_earned)));
        parts.push(format!("{} built", c.structures_built.max(0.0) as u64));
        parts.push(format!("{} played", duration(c.play_secs)));
        parts.join(" · ")
    });
    Live {
        details: clamp(details),
        state: state.and_then(clamp),
        large_text: large_text.and_then(clamp),
        ..Live::default()
    }
}

fn profile_path() -> Option<PathBuf> {
    let appdata = PathBuf::from(std::env::var_os("APPDATA")?);
    let known = appdata.join("Godot").join("app_userdata").join(PROJECT).join("profile.cfg");
    if known.is_file() {
        return Some(known);
    }
    // a renamed project or a custom user dir at release: the newest profile.cfg that has the stats
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for root in [appdata.join("Godot").join("app_userdata"), appdata] {
        let Ok(dirs) = std::fs::read_dir(&root) else { continue };
        for d in dirs.flatten() {
            let p = d.path().join("profile.cfg");
            let Ok(meta) = std::fs::metadata(&p) else { continue };
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            if !(text.contains("[career]") && text.contains("needles_found=")) {
                continue;
            }
            let t = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            if best.as_ref().is_none_or(|(bt, _)| t > *bt) {
                best = Some((t, p));
            }
        }
    }
    best.map(|(_, p)| p)
}

fn modified(p: &Path) -> Option<SystemTime> {
    std::fs::metadata(p).ok()?.modified().ok()
}

fn run(ctx: &Ctx) {
    let started = SystemTime::now();
    let mut path: Option<PathBuf> = None;
    let mut seen: Option<SystemTime> = None;
    let mut profile: Option<Profile> = None;
    loop {
        if path.as_ref().is_none_or(|p| !p.is_file()) {
            path = profile_path();
            seen = None;
        }
        if let Some(p) = &path {
            let m = modified(p);
            if m != seen {
                seen = m;
                profile = std::fs::read_to_string(p).ok().as_deref().and_then(parse);
            }
        }
        let fresh = seen.is_some_and(|m| m >= started);
        let live = profile.as_ref().map(|p| {
            let today = p.latest_day.as_ref().filter(|_| fresh);
            build(p, today, Opts::from(ctx.settings()))
        });
        ctx.emit(live);
        if !ctx.sleep(TICK) {
            return;
        }
    }
}

fn sample(found: bool) -> Profile {
    let career = Stats {
        hay_dug: 1_808_488.0,
        money_earned: 60_115.5,
        best_income: 1_142.5,
        structures_built: 143.0,
        needles_found: if found { 1.0 } else { 0.0 },
        first_needle_secs: if found { 11_520.0 } else { 0.0 },
        play_secs: 14_364.0,
        ..Stats::default()
    };
    let day = Stats {
        hay_dug: 1_366_901.7,
        money_earned: 50_809.2,
        best_income: 1_142.5,
        structures_built: 143.0,
        play_secs: 6_749.0,
        ..Stats::default()
    };
    Profile {
        career,
        latest_day: Some(day),
        any_demo_done: false,
    }
}

fn preview(s: &Settings, scenario: &str) -> Preview {
    let mut o = Opts::from(s);
    let p = sample(scenario == "found");
    if scenario == "total" {
        o.today = false;
    }
    Preview {
        game: "Find The Needle",
        icon: None,
        live: build(&p, p.latest_day.as_ref(), o),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: Opts = Opts {
        today: true,
        income: true,
        needle: true,
        totals: true,
    };

    // trimmed copy of a real profile.cfg, tokens replaced
    const PROFILE: &str = r#"[career]

money_peak=23458.609293852744
play_secs=14364
hay_dug=1808488.0841256885
needles_found=0
money_earned=60115.50869062626
structures_built=143
best_income=1142.531301498413
first_needle_secs=0.0
epoch=2
debug_tainted=false

[days]

2026-09-28={
"belt_peak": 177.0,
"best_income": 349.27703952789307,
"complete": {},
"demo_complete": {},
"hay_dug": 441586.381842198,
"money_earned": 9306.261089999958,
"needles_found": 0,
"pile_clear": {},
"play_secs": 7615,
"structures_built": 32
}
2026-10-01={
"belt_peak": 370.0,
"best_income": 1142.531301498413,
"complete": {},
"demo_complete": {},
"hay_dug": 1366901.7022834907,
"money_earned": 50809.247600626295,
"needles_found": 0,
"pile_clear": {},
"play_secs": 6749,
"structures_built": 143
}

[identity]

refresh_token="xxxx"
access_token="eyJ.not.real"
"#;

    #[test]
    fn reads_career_and_the_newest_day() {
        let p = parse(PROFILE).unwrap();
        assert_eq!(p.career.structures_built, 143.0);
        assert_eq!(p.career.play_secs, 14364.0);
        let day = p.latest_day.as_ref().unwrap();
        assert_eq!(day.play_secs, 6749.0);
        assert!(!p.any_demo_done);
        assert!(parse("[identity]\naccess_token=\"x\"\n").is_none());
    }

    #[test]
    fn card_lines() {
        let p = parse(PROFILE).unwrap();
        let l = build(&p, p.latest_day.as_ref(), ON);
        assert_eq!(l.details.as_deref(), Some("1.37M hay dug today"));
        assert_eq!(l.state.as_deref(), Some("Earning up to $1,143/s"));
        assert_eq!(l.large_text.as_deref(), Some("$60,116 earned · 143 built · 3 h 59 min played"));

        // no save this session yet: the newest day may be yesterday
        let l = build(&p, None, ON);
        assert_eq!(l.details.as_deref(), Some("1.81M hay dug"));

        let quiet = Opts {
            income: false,
            totals: false,
            ..ON
        };
        let l = build(&p, None, quiet);
        assert_eq!(l.state, None);
        assert_eq!(l.large_text, None);
    }

    #[test]
    fn the_needle_wins_the_second_line() {
        let mut p = parse(PROFILE).unwrap();
        p.career.needles_found = 1.0;
        p.career.first_needle_secs = 11_520.0;
        assert_eq!(build(&p, None, ON).state.as_deref(), Some("Found the needle after 3 h 12 min"));
        p.career.needles_found = 3.0;
        assert_eq!(build(&p, None, ON).state.as_deref(), Some("Found 3 needles"));
        let hide = Opts { needle: false, ..ON };
        assert!(build(&p, None, hide).state.unwrap().starts_with("Earning"));
    }

    #[test]
    fn demo_finished_shows_on_hover() {
        let text = PROFILE.replacen("\"demo_complete\": {},", "\"demo_complete\": {\"pile\": 5000.0},", 1);
        let p = parse(&text).unwrap();
        assert!(p.any_demo_done);
        assert!(build(&p, None, ON).large_text.unwrap().starts_with("Demo finished · "));
    }

    #[test]
    fn numbers() {
        assert_eq!(compact(943.4), "943");
        assert_eq!(compact(1_142.5), "1,143");
        assert_eq!(compact(50_809.0), "50,809");
        assert_eq!(compact(100_000.0), "100K");
        assert_eq!(compact(441_586.0), "442K");
        assert_eq!(compact(1_000_000.0), "1M");
        assert_eq!(compact(2_500_000_000.0), "2.5B");
        assert_eq!(duration(2_700.0), "45 min");
        assert_eq!(duration(7_200.0), "2 h");
        assert_eq!(duration(11_520.0), "3 h 12 min");
    }

    #[test]
    fn matching() {
        let t = |id: &str, appid: Option<&str>, exe: Option<&str>| Target {
            game_id: id.into(),
            steam_appid: appid.map(Into::into),
            exe: exe.map(Into::into),
            ..Target::default()
        };
        assert!(matches(&t("1549993920287612960", None, None)));
        assert!(matches(&t("steam:5165210", None, None)));
        assert!(matches(&t("x", Some("5160800"), None)));
        assert!(matches(&t(
            "x",
            None,
            Some(r"C:\Program Files (x86)\Steam\steamapps\common\Find The Needle Demo\FindTheNeedle.exe")
        )));
        assert!(!matches(&t("1552168681977421824", None, None)));
    }

    #[test]
    fn scenarios() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        for (key, _) in MANIFEST.scenarios {
            assert!(preview(&s, key).live.details.is_some(), "{key}");
        }
        assert_eq!(preview(&s, "total").live.details.as_deref(), Some("1.81M hay dug"));
        assert!(preview(&s, "found").live.state.unwrap().starts_with("Found the needle"));
    }
}
