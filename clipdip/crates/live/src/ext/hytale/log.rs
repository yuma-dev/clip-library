use crate::util::tail::Tail;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default)]
pub(super) struct Follower {
    tail: Option<Tail>,
    length: u64,
    created: Option<SystemTime>,
}

impl Follower {
    pub(super) fn poll<S: Default>(
        &mut self,
        path: Option<PathBuf>,
        start: i64,
        state: &mut S,
        mut parse: impl FnMut(&mut S, &str),
    ) {
        let Some(path) = path else {
            *state = S::default();
            self.tail = None;
            return;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            *state = S::default();
            self.tail = None;
            return;
        };
        let fresh = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .is_some_and(|d| d.as_millis() as i64 >= start.saturating_sub(30_000));
        if !fresh {
            *state = S::default();
            self.tail = None;
            return;
        }
        if self.tail.as_ref().is_none_or(|t| t.path() != path)
            || meta.len() < self.length
            || meta.created().ok() != self.created
        {
            *state = S::default();
            self.tail = Some(Tail::new(path, 512 * 1024));
        }
        self.length = meta.len();
        self.created = meta.created().ok();
        if let Some(tail) = &mut self.tail {
            tail.poll(|line| parse(state, line));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn rotation_truncation_missing_and_stale_clear_state() {
        let dir = std::env::temp_dir().join(format!(
            "live-{}-{}",
            module_path!().replace(':', "_"),
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.log");
        let b = dir.join("b.log");
        std::fs::write(&a, "first\n").unwrap();
        std::fs::write(&b, "second\n").unwrap();
        let mut f = Follower::default();
        let mut state = Vec::<String>::new();
        let parse = |s: &mut Vec<String>, l: &str| s.push(l.into());
        f.poll(Some(a.clone()), 0, &mut state, parse);
        f.poll(Some(a.clone()), 0, &mut state, parse);
        assert_eq!(state, ["first"]);
        writeln!(
            std::fs::OpenOptions::new().append(true).open(&a).unwrap(),
            "more"
        )
        .unwrap();
        f.poll(Some(a.clone()), 0, &mut state, parse);
        assert_eq!(state, ["first", "more"]);
        std::fs::write(&a, "new\n").unwrap();
        f.poll(Some(a), 0, &mut state, parse);
        assert_eq!(state, ["new"]);
        f.poll(Some(b.clone()), 0, &mut state, parse);
        assert_eq!(state, ["second"]);
        f.poll(Some(b), i64::MAX, &mut state, parse);
        assert!(state.is_empty());
        f.poll(None, 0, &mut state, parse);
        assert!(state.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
