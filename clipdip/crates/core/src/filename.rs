//! Filename templating for saved clips.
//!
//! The user's `output.filename_stem` is a template with `[token]`
//! placeholders, e.g. the default `[app] [HH].[mm].[ss] - [dd].[MM].[yyyy]`
//! → `VALORANT 14.05.09 - 11.06.2026`.
//!
//! Tokens are short and case-sensitive, and repetition controls padding /
//! length (moment.js convention): `[s]` → `7`, `[ss]` → `07`, `[M]` → `6`,
//! `[MMM]` → `Jun`, `[MMMM]` → `June`. Unknown tokens are left in the
//! output verbatim so typos are visible instead of silently vanishing.
//!
//! Every substituted value is sanitized for use in a Windows filename,
//! and the final string gets a second pass (the template literal itself
//! may contain `:` etc.). Collisions are handled by [`unique_stem`],
//! which appends ` (2)`, ` (3)`, … only when a file with the same name
//! already exists.

use chrono::{DateTime, Datelike, Local, Timelike};
use std::path::Path;

/// Values that can't be derived from the clock — who was on screen and
/// what kind of save this is.
#[derive(Clone, Debug)]
pub struct FilenameVars {
    /// Focused application's name at hotkey time (exe stem, e.g.
    /// `VALORANT`). `None` falls back to `Desktop`.
    pub app_name: Option<String>,
    /// Focused window's title at hotkey time. `None` falls back to the
    /// app name.
    pub window_title: Option<String>,
    /// `"Clip"` or `"Recording"`.
    pub kind: &'static str,
}

impl Default for FilenameVars {
    fn default() -> Self {
        Self {
            app_name: None,
            window_title: None,
            kind: "Clip",
        }
    }
}

/// One entry of the user-facing variables reference.
pub struct VariableInfo {
    pub token: &'static str,
    pub description: &'static str,
    pub example: &'static str,
}

/// Everything [`expand`] understands, for display in the settings UI.
pub const VARIABLES: &[VariableInfo] = &[
    VariableInfo { token: "app",   description: "Focused application",            example: "VALORANT" },
    VariableInfo { token: "title", description: "Focused window's title",         example: "VALORANT" },
    VariableInfo { token: "type",  description: "Clip or Recording",              example: "Clip" },
    VariableInfo { token: "yyyy",  description: "Year",                           example: "2026" },
    VariableInfo { token: "yy",    description: "Year, 2-digit",                  example: "26" },
    VariableInfo { token: "MM",    description: "Month, zero-padded",             example: "06" },
    VariableInfo { token: "M",     description: "Month",                          example: "6" },
    VariableInfo { token: "MMM",   description: "Month name, short",              example: "Jun" },
    VariableInfo { token: "MMMM",  description: "Month name",                     example: "June" },
    VariableInfo { token: "dd",    description: "Day, zero-padded",               example: "07" },
    VariableInfo { token: "d",     description: "Day",                            example: "7" },
    VariableInfo { token: "ddd",   description: "Weekday, short",                 example: "Thu" },
    VariableInfo { token: "dddd",  description: "Weekday",                        example: "Thursday" },
    VariableInfo { token: "HH",    description: "Hour (24h), zero-padded",        example: "09" },
    VariableInfo { token: "H",     description: "Hour (24h)",                     example: "9" },
    VariableInfo { token: "hh",    description: "Hour (12h), zero-padded",        example: "02" },
    VariableInfo { token: "h",     description: "Hour (12h)",                     example: "2" },
    VariableInfo { token: "tt",    description: "AM or PM",                       example: "PM" },
    VariableInfo { token: "t",     description: "A or P",                         example: "P" },
    VariableInfo { token: "mm",    description: "Minute, zero-padded",            example: "05" },
    VariableInfo { token: "m",     description: "Minute",                         example: "5" },
    VariableInfo { token: "ss",    description: "Second, zero-padded",            example: "03" },
    VariableInfo { token: "s",     description: "Second",                         example: "3" },
    VariableInfo { token: "date",  description: "Shorthand for [dd].[MM].[yyyy]", example: "07.06.2026" },
    VariableInfo { token: "time",  description: "Shorthand for [HH].[mm].[ss]",   example: "14.05.03" },
    VariableInfo { token: "unix",  description: "Unix timestamp",                 example: "1781001903" },
];

const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS: [&str; 7] = [
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

/// Expand `template` against the local wall clock.
pub fn expand(template: &str, vars: &FilenameVars) -> String {
    expand_at(template, vars, Local::now())
}

/// [`expand`] with an explicit timestamp (testable).
pub fn expand_at(template: &str, vars: &FilenameVars, now: DateTime<Local>) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('[') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find(']') {
            Some(end) => {
                let token = &after[..end];
                match resolve_token(token, vars, &now) {
                    Some(v) => out.push_str(&sanitize_component(&v)),
                    None => {
                        // Unknown token: keep it visible so typos surface.
                        out.push('[');
                        out.push_str(token);
                        out.push(']');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                // Unmatched '[' — emit the remainder as-is.
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    finalize(&out)
}

fn resolve_token(token: &str, vars: &FilenameVars, now: &DateTime<Local>) -> Option<String> {
    let (is_pm, hour12) = now.hour12();
    Some(match token {
        "yyyy" => format!("{:04}", now.year()),
        "yy" => format!("{:02}", now.year() % 100),
        "M" => now.month().to_string(),
        "MM" => format!("{:02}", now.month()),
        "MMM" => MONTHS[now.month0() as usize][..3].to_string(),
        "MMMM" => MONTHS[now.month0() as usize].to_string(),
        "d" => now.day().to_string(),
        "dd" => format!("{:02}", now.day()),
        "ddd" => WEEKDAYS[now.weekday().num_days_from_monday() as usize][..3].to_string(),
        "dddd" => WEEKDAYS[now.weekday().num_days_from_monday() as usize].to_string(),
        "H" => now.hour().to_string(),
        "HH" => format!("{:02}", now.hour()),
        "h" => hour12.to_string(),
        "hh" => format!("{:02}", hour12),
        "t" => if is_pm { "P" } else { "A" }.to_string(),
        "tt" => if is_pm { "PM" } else { "AM" }.to_string(),
        "m" => now.minute().to_string(),
        "mm" => format!("{:02}", now.minute()),
        "s" => now.second().to_string(),
        "ss" => format!("{:02}", now.second()),
        "date" => format!("{:02}.{:02}.{:04}", now.day(), now.month(), now.year()),
        "time" => format!("{:02}.{:02}.{:02}", now.hour(), now.minute(), now.second()),
        "unix" => now.timestamp().to_string(),
        "app" => vars
            .app_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Desktop")
            .to_string(),
        "title" => {
            let title = vars
                .window_title
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            match title {
                Some(t) => truncate_chars(t, 60),
                None => vars
                    .app_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Desktop")
                    .to_string(),
            }
        }
        "type" => vars.kind.to_string(),
        _ => return None,
    })
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Sanitize one substituted value: keep word characters and a small set
/// of filename-safe punctuation, drop everything else (including `[`/`]`
/// so values can't fake template tokens).
fn sanitize_component(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric() || " _-.,()&'+!#=@".contains(*c))
        .collect()
}

/// Final pass over the whole stem: the template literal itself may carry
/// characters Windows forbids. `:` becomes `.` (people write [HH]:[mm]),
/// other forbidden characters become `-`. Whitespace is collapsed, edges
/// are trimmed of spaces/dots (Windows strips trailing dots itself, and
/// leading dots make hidden files), length is capped, and an empty
/// result falls back to `"Clip"`.
fn finalize(s: &str) -> String {
    let mapped: String = s
        .chars()
        .map(|c| match c {
            ':' => '.',
            '<' | '>' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if (c as u32) < 0x20 => '-',
            c => c,
        })
        .collect();
    let mut collapsed = String::with_capacity(mapped.len());
    let mut prev_space = false;
    for c in mapped.chars() {
        let is_space = c == ' ';
        if !(is_space && prev_space) {
            collapsed.push(c);
        }
        prev_space = is_space;
    }
    let trimmed: String = truncate_chars(collapsed.trim_matches(|c| c == ' ' || c == '.'), 150);
    if trimmed.is_empty() {
        "Clip".to_string()
    } else {
        trimmed
    }
}

/// Return `stem` if `{stem}.mp4` doesn't exist in `dir`, otherwise the
/// first free `{stem} (2)`, `{stem} (3)`, … — the numbered suffix only
/// appears on an actual collision.
pub fn unique_stem(dir: &Path, stem: &str) -> String {
    if !dir.join(format!("{stem}.mp4")).exists() {
        return stem.to_string();
    }
    for n in 2..10_000u32 {
        let candidate = format!("{stem} ({n})");
        if !dir.join(format!("{candidate}.mp4")).exists() {
            return candidate;
        }
    }
    // Pathological directory — fall back to something certain to be fresh.
    format!("{stem} {}", Local::now().timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at() -> DateTime<Local> {
        // 2026-06-07 (a Sunday) 14:05:03
        Local.with_ymd_and_hms(2026, 6, 7, 14, 5, 3).unwrap()
    }

    fn vars() -> FilenameVars {
        FilenameVars {
            app_name: Some("VALORANT".into()),
            window_title: Some("VALORANT — Ranked".into()),
            kind: "Clip",
        }
    }

    #[test]
    fn default_template_expands() {
        let s = expand_at("[app] [HH].[mm].[ss] - [dd].[MM].[yyyy]", &vars(), at());
        assert_eq!(s, "VALORANT 14.05.03 - 07.06.2026");
    }

    #[test]
    fn repetition_controls_padding() {
        assert_eq!(expand_at("[s]", &vars(), at()), "3");
        assert_eq!(expand_at("[ss]", &vars(), at()), "03");
        assert_eq!(expand_at("[M]", &vars(), at()), "6");
        assert_eq!(expand_at("[MMM]", &vars(), at()), "Jun");
        assert_eq!(expand_at("[MMMM]", &vars(), at()), "June");
        assert_eq!(expand_at("[dddd]", &vars(), at()), "Sunday");
        assert_eq!(expand_at("[h] [tt]", &vars(), at()), "2 PM");
    }

    #[test]
    fn unknown_tokens_stay_visible() {
        assert_eq!(expand_at("[nope]-[ss]", &vars(), at()), "[nope]-03");
    }

    #[test]
    fn missing_app_falls_back() {
        let v = FilenameVars { app_name: None, window_title: None, kind: "Clip" };
        assert_eq!(expand_at("[app]", &v, at()), "Desktop");
        assert_eq!(expand_at("[title]", &v, at()), "Desktop");
    }

    #[test]
    fn values_and_literals_are_sanitized() {
        let v = FilenameVars {
            app_name: Some("Weird/App:Name*?".into()),
            window_title: None,
            kind: "Clip",
        };
        // Forbidden chars are stripped from the value; the literal ':' in
        // the template maps to '.'.
        assert_eq!(expand_at("[app] at [HH]:[mm]", &v, at()), "WeirdAppName at 14.05");
    }

    #[test]
    fn empty_result_falls_back() {
        let v = FilenameVars { app_name: Some("///".into()), window_title: None, kind: "Clip" };
        assert_eq!(expand_at("", &v, at()), "Clip");
        assert_eq!(expand_at("[app]", &v, at()), "Clip");
    }

    #[test]
    fn unique_stem_appends_only_on_collision() {
        let dir = std::env::temp_dir().join(format!("clipdip-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_stem(&dir, "foo"), "foo");
        std::fs::write(dir.join("foo.mp4"), b"x").unwrap();
        assert_eq!(unique_stem(&dir, "foo"), "foo (2)");
        std::fs::write(dir.join("foo (2).mp4"), b"x").unwrap();
        assert_eq!(unique_stem(&dir, "foo"), "foo (3)");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
