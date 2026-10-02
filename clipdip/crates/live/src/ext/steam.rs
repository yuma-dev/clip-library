//! Hours played for any Steam game, read from Steam's own files (no API key).
//! Not a page of its own: it adds `playtime` to the plain game card, whatever
//! else runs for the game.
//! Parses localconfig.vdf and appmanifest_*.acf with keyvalues-parser by
//! CosmicHarper (MIT OR Apache-2.0), https://codeberg.org/CosmicHarper/vdf-rs.

use std::path::{Path, PathBuf};
use std::time::Duration;

use keyvalues_parser::{Obj, Parser, Value};

use crate::{util, Credit, Ctx, Live, Manifest, Opt, Preview, Settings, Target};

pub static MANIFEST: Manifest = Manifest {
    id: "steam",
    name: "Hours played",
    blurb: "Steam games show your hours played when you hover their picture.",
    setup: None,
    credits: &[Credit {
        project: "keyvalues-parser (vdf-rs)",
        author: "CosmicHarper",
        url: "https://codeberg.org/CosmicHarper/vdf-rs",
        license: "MIT OR Apache-2.0",
    }],
    options: &[Opt::toggle(
        "count_session",
        "Count the current session",
        "Add the time since the game started.",
        true,
    )],
    matches,
    run,
    // only ever fills `playtime`, nothing to compete for
    priority: 50,
    game_ids: &[],
    // Steam's own store share image, not tied to one game
    art: Some("https://cdn.cloudflare.steamstatic.com/store/home/store_home_share.jpg"),
    preview,
    scenarios: &[],
    steam_game: false,
    listed: false,
};

// Steam only writes playtime when a game closes, so one read per session is enough
const TICK: Duration = Duration::from_secs(180);

fn matches(t: &Target) -> bool {
    t.steam_appid.is_some() || t.exe.as_deref().and_then(steamapps_split).is_some()
}

fn run(ctx: &Ctx) {
    let t = ctx.target();
    let Some(playtime) = read_playtime(t) else {
        ctx.emit(None);
        return;
    };
    loop {
        let session = ((util::now_ms() - t.started_at_ms) / 60_000).max(0) as u64;
        ctx.emit(live_for(ctx.settings(), playtime.total, session));
        if !ctx.sleep(TICK) {
            return;
        }
    }
}

fn read_playtime(t: &Target) -> Option<Playtime> {
    let appid = match &t.steam_appid {
        Some(id) => id.trim_start_matches("steam:").to_string(),
        None => appid_from_exe(t.exe.as_deref()?)?,
    };
    let steam = steam_dir()?;
    let cfg = newest_localconfig(&steam)?;
    let text = std::fs::read_to_string(cfg).ok()?;
    playtime_in(&text, &appid)
}

#[derive(Debug, PartialEq)]
struct Playtime {
    /// minutes
    total: u64,
    /// minutes, Playtime2wks; parsed for completeness, the card only shows the total
    #[allow(dead_code)]
    two_weeks: u64,
}

fn preview(s: &Settings, _scenario: &str) -> Preview {
    // a long Hades II save, 95 min into tonight's session
    let live = live_for(s, 7_315, 95).unwrap_or_default();
    Preview {
        game: "Hades II",
        icon: None,
        live,
    }
}

/// `total` from localconfig.vdf and `session` since the game started, both minutes
fn live_for(s: &Settings, total: u64, session: u64) -> Option<Live> {
    let minutes = if s.flag("count_session") {
        total + session
    } else {
        total
    };
    if minutes == 0 {
        return None;
    }
    let played = if minutes < 120 {
        format!("{minutes} min played")
    } else {
        format!("{} h played", thousands(minutes / 60))
    };
    Some(Live {
        playtime: Some(played),
        ..Default::default()
    })
}

fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// (`...\steamapps`, folder name under common) from an exe path
fn steamapps_split(exe: &Path) -> Option<(PathBuf, String)> {
    let s = exe.to_string_lossy();
    let lower = s.to_ascii_lowercase().replace('/', "\\");
    let needle = "\\steamapps\\common\\";
    let at = lower.find(needle)?;
    let steamapps = PathBuf::from(s.get(..at + "\\steamapps".len())?);
    let rest = lower.get(at + needle.len()..)?;
    // keep the original case of the folder, the match against installdir is case-insensitive anyway
    let name_len = rest.find('\\').unwrap_or(rest.len());
    let start = at + needle.len();
    let folder = s.get(start..start + name_len)?.to_string();
    (!folder.is_empty()).then_some((steamapps, folder))
}

fn appid_from_exe(exe: &Path) -> Option<String> {
    let (steamapps, folder) = steamapps_split(exe)?;
    for entry in std::fs::read_dir(steamapps).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if !(name.starts_with("appmanifest_") && name.ends_with(".acf")) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        if let Some(id) = manifest_appid(&text, &folder) {
            return Some(id);
        }
    }
    None
}

/// appid from an appmanifest if its installdir is `folder`
fn manifest_appid(text: &str, folder: &str) -> Option<String> {
    let vdf = parse(text)?;
    let state = vdf.get_obj()?;
    let dir = child(state, "installdir").next()?.get_str()?;
    if !dir.eq_ignore_ascii_case(folder) {
        return None;
    }
    let id = child(state, "appid").next()?.get_str()?.to_string();
    Some(id)
}

fn playtime_in(text: &str, appid: &str) -> Option<Playtime> {
    let root = parse(text)?;
    let mut level: Vec<&Obj> = root.get_obj().into_iter().collect();
    for key in ["Software", "Valve", "Steam", "apps", appid] {
        level = level
            .iter()
            .flat_map(|o| child(o, key))
            .filter_map(|v| v.get_obj())
            .collect();
    }
    let app = level.first()?;
    let minutes = |key| {
        child(app, key)
            .next()
            .and_then(|v| v.get_str())
            .and_then(|s| s.trim().parse().ok())
    };
    Some(Playtime {
        total: minutes("Playtime")?,
        two_weeks: minutes("Playtime2wks").unwrap_or(0),
    })
}

/// root value; localconfig escapes its backslashes, a few hand edited files don't
fn parse(text: &str) -> Option<Value<'_>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    Parser::new()
        .parse(text)
        .ok()
        .or_else(|| Parser::new().literal_special_chars(true).parse(text).ok())
        .map(|v| v.value)
}

/// key casing differs between Steam versions ("Software"/"software", "apps"/"Apps")
fn child<'a, 'b>(obj: &'a Obj<'b>, key: &'a str) -> impl Iterator<Item = &'a Value<'b>> + 'a {
    obj.iter()
        .filter(move |(k, _)| k.eq_ignore_ascii_case(key))
        .flat_map(|(_, v)| v.iter())
}

fn newest_localconfig(steam: &Path) -> Option<PathBuf> {
    std::fs::read_dir(steam.join("userdata"))
        .ok()?
        .flatten()
        .map(|e| e.path().join("config").join("localconfig.vdf"))
        .filter_map(|p| Some((std::fs::metadata(&p).ok()?.modified().ok()?, p)))
        .max_by_key(|(m, _)| *m)
        .map(|(_, p)| p)
}

fn steam_dir() -> Option<PathBuf> {
    registry_steam_path()
        .map(PathBuf::from)
        .filter(|p| p.join("userdata").is_dir())
        .or_else(|| Some(PathBuf::from(r"C:\Program Files (x86)\Steam")))
}

fn registry_steam_path() -> Option<String> {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let mut buf = [0u16; 512];
    let mut len = std::mem::size_of_val(&buf) as u32;
    // SAFETY: buf outlives the call and len is its size in bytes
    let err = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Valve\\Steam"),
            w!("SteamPath"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    if err.is_err() {
        return None;
    }
    let chars = (len as usize / 2).min(buf.len());
    let s = String::from_utf16_lossy(buf.get(..chars)?);
    let s = s.trim_end_matches('\0').trim();
    (!s.is_empty()).then(|| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCALCONFIG: &str = r#""UserLocalConfigStore"
{
	"Broadcast"
	{
		"Permissions"		"1"
	}
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"apps"
				{
					"480"
					{
						"LastPlayed"		"1789753728"
						"Playtime"		"2747"
						"Playtime2wks"		"95"
						"LaunchOptions"		"cmd /c \"F:\\mods\\launch.bat\" %command%"
					}
					"730"
					{
						"Playtime"		"72240"
					}
				}
			}
		}
	}
	"apps"
	{
		"480"
		{
			"Playtime"		"1"
		}
	}
}
"#;

    const ACF: &str = r#""AppState"
{
	"appid"		"1245620"
	"name"		"ELDEN RING"
	"installdir"		"ELDEN RING"
	"StateFlags"		"4"
}
"#;

    #[test]
    fn reads_playtime_under_software_valve_steam() {
        assert_eq!(
            playtime_in(LOCALCONFIG, "480"),
            Some(Playtime {
                total: 2747,
                two_weeks: 95
            })
        );
        assert_eq!(
            playtime_in(LOCALCONFIG, "730"),
            Some(Playtime {
                total: 72240,
                two_weeks: 0
            })
        );
        assert_eq!(playtime_in(LOCALCONFIG, "999"), None);
        assert_eq!(playtime_in("not vdf {", "480"), None);
    }

    #[test]
    fn key_case_does_not_matter() {
        let lower = LOCALCONFIG
            .replace("\"Software\"", "\"software\"")
            .replace("\"Valve\"", "\"valve\"");
        assert_eq!(playtime_in(&lower, "480").map(|p| p.total), Some(2747));
    }

    #[test]
    fn manifest_matches_installdir() {
        assert_eq!(
            manifest_appid(ACF, "elden ring").as_deref(),
            Some("1245620")
        );
        assert_eq!(manifest_appid(ACF, "Hades"), None);
    }

    #[test]
    fn splits_exe_path() {
        let p = Path::new(r"D:\SteamLibrary\SteamApps\common\ELDEN RING\Game\eldenring.exe");
        assert_eq!(
            steamapps_split(p),
            Some((
                PathBuf::from(r"D:\SteamLibrary\SteamApps"),
                "ELDEN RING".into()
            ))
        );
        assert_eq!(steamapps_split(Path::new(r"C:\Games\foo\foo.exe")), None);
    }

    #[test]
    fn matches_steam_targets() {
        let mut t = Target::default();
        assert!(!matches(&t));
        t.exe = Some(r"C:\Program Files (x86)\Steam\steamapps\common\Hades\x64\Hades.exe".into());
        assert!(matches(&t));
        t.exe = None;
        t.steam_appid = Some("1145360".into());
        assert!(matches(&t));
    }

    #[test]
    fn played_text() {
        let s = Settings::new(&MANIFEST, serde_json::json!({}));
        let text = |m| live_for(&s, m, 0).and_then(|l| l.playtime);
        assert_eq!(text(45).as_deref(), Some("45 min played"));
        assert_eq!(text(119).as_deref(), Some("119 min played"));
        assert_eq!(text(72_240).as_deref(), Some("1,204 h played"));
        assert_eq!(text(0), None);
        assert_eq!(thousands(1_234_567), "1,234,567");
    }

    #[test]
    fn preview_follows_toggles() {
        let text = |v| preview(&Settings::new(&MANIFEST, v), "").live.playtime;
        assert_eq!(text(serde_json::json!({})).as_deref(), Some("123 h played"));
        assert_eq!(
            text(serde_json::json!({ "count_session": false })).as_deref(),
            Some("121 h played")
        );
    }

    // reads this machine's real Steam files: cargo test steam -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_localconfig() {
        let steam = steam_dir().expect("steam dir");
        let cfg = newest_localconfig(&steam).expect("localconfig");
        let text = std::fs::read_to_string(&cfg).expect("read");
        let start = std::time::Instant::now();
        let p = playtime_in(&text, "480");
        println!("{} bytes, {:?}, {:?}", text.len(), start.elapsed(), p);
        let exe = steam.join(r"steamapps\common\Spacewar\SteamworksExample.exe");
        println!("{:?}", appid_from_exe(&exe));
    }
}
