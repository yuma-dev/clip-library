//! Modrinth App instances from its app.db, and project title/icon from the
//! public API. Schema read from the app's migrations (no code taken, the app
//! is GPL): up to 2026-06 `profiles` + `processes.profile_path`, after
//! 20260611/20260619 `instances` + `instance_content_sets` + `instance_links`
//! + `processes.instance_id`.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

/// project titles and icons barely change
const PROJECT_MAX_AGE: Duration = Duration::from_secs(3 * 24 * 3600);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Found {
    pub name: String,
    pub project: Option<String>,
    pub version: Option<String>,
    pub loader: Option<String>,
}

/// app.db candidates: next to the profiles folder holding the game dir (custom
/// app dirs), then the default and the pre-rename locations.
pub fn db_paths(game_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(root) = game_dir.and_then(Path::parent).and_then(Path::parent) {
        out.push(root.join("app.db"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let appdata = PathBuf::from(appdata);
        out.push(appdata.join("ModrinthApp").join("app.db"));
        out.push(appdata.join("com.modrinth.theseus").join("app.db"));
    }
    out.dedup();
    out
}

/// The instance running as `pid`, else the one whose folder is `dir_name`.
/// Opens read only and closes again, the app keeps writing to the db.
pub fn lookup(db: &Path, pid: u32, dir_name: Option<&str>) -> Option<Found> {
    if !db.is_file() {
        return None;
    }
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(Duration::from_millis(300));
    // new schema first; mid-migration dbs fail it and fall through to the old one
    query_new(&conn, pid, dir_name).or_else(|| query_old(&conn, pid, dir_name))
}

fn query_new(conn: &Connection, pid: u32, dir: Option<&str>) -> Option<Found> {
    const SELECT: &str = "SELECT i.name, l.link_kind, l.modrinth_project_id, l.server_project_id, s.game_version, s.loader
        FROM instances i
        LEFT JOIN instance_content_sets s ON s.id = i.applied_content_set_id
        LEFT JOIN instance_links l ON l.instance_id = i.id";
    let map = |r: &rusqlite::Row| -> rusqlite::Result<Found> {
        let kind: Option<String> = r.get(1)?;
        let modpack: Option<String> = r.get(2)?;
        let server: Option<String> = r.get(3)?;
        let project = match kind.as_deref() {
            Some("modrinth_modpack") => modpack,
            Some("server_project") => server,
            _ => None,
        };
        Ok(Found {
            name: r.get(0)?,
            project,
            version: r.get(4)?,
            loader: r.get(5)?,
        })
    };
    let by_pid = conn
        .query_row(
            &format!("{SELECT} WHERE i.id = (SELECT instance_id FROM processes WHERE pid = ?1)"),
            [pid],
            map,
        )
        .optional();
    match by_pid {
        Ok(Some(f)) => return Some(f),
        Ok(None) => {}
        Err(_) => return None,
    }
    conn.query_row(&format!("{SELECT} WHERE i.path = ?1"), [dir?], map)
        .optional()
        .ok()?
}

fn query_old(conn: &Connection, pid: u32, dir: Option<&str>) -> Option<Found> {
    const SELECT: &str = "SELECT name, linked_project_id, game_version, mod_loader FROM profiles";
    let map = |r: &rusqlite::Row| -> rusqlite::Result<Found> {
        Ok(Found {
            name: r.get(0)?,
            project: r.get(1)?,
            version: r.get(2)?,
            loader: r.get(3)?,
        })
    };
    if let Ok(Some(f)) = conn
        .query_row(
            &format!("{SELECT} WHERE path = (SELECT profile_path FROM processes WHERE pid = ?1)"),
            [pid],
            map,
        )
        .optional()
    {
        return Some(f);
    }
    conn.query_row(&format!("{SELECT} WHERE path = ?1"), [dir?], map)
        .optional()
        .ok()?
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub title: String,
    #[serde(default)]
    pub icon_url: Option<String>,
}

/// Modrinth ids are base62, slugs add `-` and `_`; anything else never
/// reaches a url or a file name.
pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// GET https://api.modrinth.com/v2/project/{id}, cached on disk per id.
pub fn project(id: &str, cache_dir: Option<&Path>) -> Option<Project> {
    if !valid_id(id) {
        return None;
    }
    let file = cache_dir.map(|d| d.join(format!("modrinth-{id}.json")));
    let cached: Option<(Project, bool)> = file.as_ref().and_then(|f| {
        let fresh = std::fs::metadata(f)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age < PROJECT_MAX_AGE);
        let p = serde_json::from_slice(&std::fs::read(f).ok()?).ok()?;
        Some((p, fresh))
    });
    if let Some((p, true)) = &cached {
        return Some(p.clone());
    }
    let agent = crate::util::http::agent();
    let fetched = crate::util::http::get_json::<serde_json::Value>(
        &agent,
        &format!("https://api.modrinth.com/v2/project/{id}"),
    )
    .and_then(|v| parse_project(&v));
    match fetched {
        Some(p) => {
            if let (Some(f), Ok(bytes)) = (&file, serde_json::to_vec(&p)) {
                let _ = std::fs::write(f, bytes);
            }
            Some(p)
        }
        // offline: a stale entry beats nothing
        None => cached.map(|(p, _)| p),
    }
}

pub fn parse_project(v: &serde_json::Value) -> Option<Project> {
    let title = v.get("title")?.as_str()?.trim();
    if title.is_empty() {
        return None;
    }
    let icon_url = v
        .get("icon_url")
        .and_then(|u| u.as_str())
        .filter(|u| u.starts_with("https://") && u.len() < 512)
        .map(str::to_string);
    Some(Project {
        title: title.to_string(),
        icon_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str, sql: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mc-mr-{}-{name}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("app.db");
        let _ = std::fs::remove_file(&p);
        let c = Connection::open(&p).unwrap();
        c.execute_batch(sql).unwrap();
        p
    }

    #[test]
    fn new_schema() {
        let p = temp_db(
            "new",
            "CREATE TABLE instances (id TEXT, path TEXT, applied_content_set_id TEXT, name TEXT, icon_path TEXT);
             CREATE TABLE instance_content_sets (id TEXT, instance_id TEXT, name TEXT, game_version TEXT, loader TEXT, loader_version TEXT);
             CREATE TABLE instance_links (instance_id TEXT, link_kind TEXT, modrinth_project_id TEXT, server_project_id TEXT);
             CREATE TABLE processes (pid INTEGER, start_time INTEGER, name TEXT, executable TEXT, instance_id TEXT);
             INSERT INTO instances VALUES ('i1', 'Fabulously Optimized', 'c1', 'Fabulously Optimized', NULL);
             INSERT INTO instances VALUES ('i2', 'plain', 'c2', 'My world', NULL);
             INSERT INTO instance_content_sets VALUES ('c1', 'i1', 'x', '1.21.4', 'fabric', '0.16.9');
             INSERT INTO instance_content_sets VALUES ('c2', 'i2', 'x', '1.20.1', 'vanilla', NULL);
             INSERT INTO instance_links VALUES ('i1', 'modrinth_modpack', '1KVo5zza', NULL);
             INSERT INTO instance_links VALUES ('i2', 'unmanaged', NULL, NULL);
             INSERT INTO processes VALUES (4242, 0, 'x', 'java', 'i1');",
        );
        let f = lookup(&p, 4242, None).unwrap();
        assert_eq!(f.name, "Fabulously Optimized");
        assert_eq!(f.project.as_deref(), Some("1KVo5zza"));
        assert_eq!(
            (f.version.as_deref(), f.loader.as_deref()),
            (Some("1.21.4"), Some("fabric"))
        );
        let f = lookup(&p, 1, Some("plain")).unwrap();
        assert_eq!((f.name.as_str(), f.project), ("My world", None));
        assert_eq!(lookup(&p, 1, None), None);
    }

    #[test]
    fn old_schema() {
        let p = temp_db(
            "old",
            "CREATE TABLE profiles (path TEXT, name TEXT, icon_path TEXT, game_version TEXT, mod_loader TEXT, linked_project_id TEXT, linked_version_id TEXT);
             CREATE TABLE processes (pid INTEGER, start_time INTEGER, name TEXT, executable TEXT, profile_path TEXT);
             INSERT INTO profiles VALUES ('Cobblemon', 'Cobblemon', NULL, '1.21.1', 'fabric', 'MdwFAVRL', 'v1');
             INSERT INTO processes VALUES (77, 0, 'x', 'java', 'Cobblemon');",
        );
        let f = lookup(&p, 77, None).unwrap();
        assert_eq!(f.name, "Cobblemon");
        assert_eq!(f.project.as_deref(), Some("MdwFAVRL"));
        assert_eq!(
            lookup(&p, 5, Some("Cobblemon")).map(|f| f.name),
            Some("Cobblemon".into())
        );
    }

    #[test]
    fn project_json() {
        let v = serde_json::json!({"title": "Fabulously Optimized", "icon_url": "https://cdn.modrinth.com/data/1KVo5zza/icon.png", "slug": "fabulously-optimized"});
        let p = parse_project(&v).unwrap();
        assert_eq!(p.title, "Fabulously Optimized");
        assert_eq!(
            p.icon_url.as_deref(),
            Some("https://cdn.modrinth.com/data/1KVo5zza/icon.png")
        );
        assert_eq!(
            parse_project(&serde_json::json!({"title": "x", "icon_url": null}))
                .unwrap()
                .icon_url,
            None
        );
        assert!(valid_id("1KVo5zza") && valid_id("fabulously-optimized"));
        assert!(!valid_id("../x") && !valid_id(""));
    }
}
