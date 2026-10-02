//! Runs the live extensions (clipdip-live) that match the game being shown,
//! each as its own `clipdip.exe --live-ext <id>` helper, and folds what they
//! send into the game presence. A helper that crashes or hangs only takes
//! its extras along: the card falls back to the plain one, the helper gets
//! two more tries a session, then stays off until the next game.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use clipdip_live::{Live, Manifest, Target};
use tracing::{debug, info, warn};

use crate::game_watch::GameSession;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
/// wait before restart n (1-based); past the list the helper stays off for the session
const RESTART_AFTER: &[Duration] = &[Duration::from_secs(30), Duration::from_secs(120)];
/// a helper gets this long after stdin closes before it's killed
const STOP_GRACE: Duration = Duration::from_secs(5);

pub struct LivePresence {
    config_path: PathBuf,
    inner: Mutex<Inner>,
    on_change: OnceLock<Box<dyn Fn() + Send + Sync>>,
}

#[derive(Default)]
struct Inner {
    /// bumped on every session or settings change; threads of an older one go quiet
    generation: u64,
    target: Option<Target>,
    /// the settings the helpers were started with, to notice edits
    settings: BTreeMap<String, serde_json::Value>,
    helpers: Vec<Helper>,
    live: BTreeMap<&'static str, (u8, Live)>,
    restarts: BTreeMap<&'static str, usize>,
}

struct Helper {
    id: &'static str,
    child: Child,
    /// dropping it is the stop signal
    stdin: Option<ChildStdin>,
}

impl LivePresence {
    pub fn new(config_path: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            config_path,
            inner: Mutex::new(Inner::default()),
            on_change: OnceLock::new(),
        })
    }

    /// Called (outside any lock) whenever the merged extras change.
    pub fn set_on_change(&self, f: impl Fn() + Send + Sync + 'static) {
        let _ = self.on_change.set(Box::new(f));
    }

    /// The extras of every running helper, lower priority filling the gaps.
    pub fn merged(&self) -> Live {
        let inner = self.inner.lock().unwrap();
        let mut by_prio: Vec<&(u8, Live)> = inner.live.values().collect();
        by_prio.sort_by_key(|(p, _)| *p);
        by_prio.into_iter().fold(Live::default(), |acc, (_, l)| acc.or(l))
    }

    /// The session to run extensions for, None when there's no game or it
    /// isn't shown. Restarts helpers only when the game or the settings changed.
    pub fn sync(self: &Arc<Self>, session: Option<&GameSession>) {
        let settings = clipdip_core::config::Config::load_or_default(&self.config_path)
            .map(|c| c.discord.live)
            .unwrap_or_default();
        let target = session.map(|s| Target {
            game_id: s.game.id.clone(),
            game_name: s.game.name.clone(),
            steam_appid: s.game.steam_appid.clone(),
            pid: s.pid,
            exe: crate::metadata::exe_path_for_pid(s.pid),
            started_at_ms: s.started_at_ms,
        });

        let had_live = {
            let mut inner = self.inner.lock().unwrap();
            let same_game = match (&inner.target, &target) {
                (Some(a), Some(b)) => a.game_id == b.game_id && a.pid == b.pid,
                (None, None) => true,
                _ => false,
            };
            if same_game && inner.settings == settings {
                return;
            }
            inner.generation += 1;
            stop_all(&mut inner);
            if !same_game {
                inner.restarts.clear();
            }
            inner.target = target.clone();
            inner.settings = settings.clone();
            let had = !inner.live.is_empty();
            inner.live.clear();

            if let Some(t) = &target {
                for m in clipdip_live::ext::ALL.iter().copied() {
                    let cfg = settings.get(m.id);
                    if m.enabled(cfg) && (m.matches)(t) {
                        let gen = inner.generation;
                        self.start(&mut inner, m, t, cfg.cloned(), gen);
                    }
                }
            }
            had
        };
        if had_live {
            self.changed();
        }
    }

    fn start(
        self: &Arc<Self>,
        inner: &mut Inner,
        m: &'static Manifest,
        target: &Target,
        settings: Option<serde_json::Value>,
        gen: u64,
    ) {
        let exe = match std::env::current_exe() {
            Ok(e) => e,
            Err(e) => {
                warn!("live: no own exe path: {e}");
                return;
            }
        };
        let spawned = Command::new(exe)
            .args(["--live-ext", m.id])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS)
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                warn!(ext = m.id, "live: spawn failed: {e}");
                return;
            }
        };
        kill_with_us(&child);

        let start = serde_json::json!({
            "target": target,
            "settings": settings.unwrap_or(serde_json::Value::Null),
        });
        let mut stdin = child.stdin.take();
        let wrote = stdin
            .as_mut()
            .map(|s| writeln!(s, "{start}").and_then(|_| s.flush()).is_ok())
            .unwrap_or(false);
        let (Some(stdout), Some(stderr), true) = (child.stdout.take(), child.stderr.take(), wrote) else {
            warn!(ext = m.id, "live: helper pipes unusable");
            let _ = child.kill();
            return;
        };
        info!(ext = m.id, pid = child.id(), "live: helper started");

        let _ = std::thread::Builder::new().name("live-log".into()).spawn({
            let id = m.id;
            move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    debug!(ext = id, "{line}");
                }
            }
        });
        let me = Arc::clone(self);
        let _ = std::thread::Builder::new()
            .name("live-read".into())
            .spawn(move || me.read(m, gen, stdout));

        inner.helpers.push(Helper { id: m.id, child, stdin });
    }

    fn read(self: Arc<Self>, m: &'static Manifest, gen: u64, stdout: std::process::ChildStdout) {
        #[derive(serde::Deserialize)]
        struct Line {
            live: Option<Live>,
        }
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(Line { live }) = serde_json::from_str::<Line>(&line) else {
                continue;
            };
            let changed = {
                let mut inner = self.inner.lock().unwrap();
                if inner.generation != gen {
                    return;
                }
                let before = inner.live.get(m.id).map(|(_, l)| l.clone());
                match live.clone() {
                    Some(l) => inner.live.insert(m.id, (m.priority, l)),
                    None => inner.live.remove(m.id),
                };
                before != live
            };
            if changed {
                self.changed();
            }
        }

        // pipe closed: the helper finished, crashed or was stopped
        let helper = {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != gen {
                return;
            }
            inner.live.remove(m.id);
            let pos = inner.helpers.iter().position(|h| h.id == m.id);
            pos.map(|p| inner.helpers.remove(p))
        };
        self.changed();
        // waited for outside the lock, a helper that closed stdout but lingers can't stall the card
        let code = helper.and_then(|mut h| {
            drop(h.stdin.take());
            let mut waited = Duration::ZERO;
            loop {
                match h.child.try_wait() {
                    Ok(Some(status)) => return status.code(),
                    Ok(None) if waited < STOP_GRACE => {
                        std::thread::sleep(Duration::from_millis(250));
                        waited += Duration::from_millis(250);
                    }
                    _ => {
                        let _ = h.child.kill();
                        let _ = h.child.wait();
                        return None;
                    }
                }
            }
        });
        let retry = {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != gen {
                return;
            }
            let n = inner.restarts.entry(m.id).or_insert(0);
            *n += 1;
            let wait = if code == Some(0) { None } else { RESTART_AFTER.get(*n - 1).copied() };
            warn!(ext = m.id, ?code, restart_in = ?wait, "live: helper ended");
            wait
        };

        if let Some(wait) = retry {
            std::thread::sleep(wait);
            let mut inner = self.inner.lock().unwrap();
            if inner.generation != gen || inner.helpers.iter().any(|h| h.id == m.id) {
                return;
            }
            let Some(target) = inner.target.clone() else { return };
            let cfg = inner.settings.get(m.id).cloned();
            self.start(&mut inner, m, &target, cfg, gen);
        }
    }

    fn changed(&self) {
        if let Some(f) = self.on_change.get() {
            f();
        }
    }
}

/// Closes every helper's stdin and kills whatever hasn't left after the grace.
fn stop_all(inner: &mut Inner) {
    for mut h in inner.helpers.drain(..) {
        drop(h.stdin.take());
        let id = h.id;
        let _ = std::thread::Builder::new().name("live-stop".into()).spawn(move || {
            let mut waited = Duration::ZERO;
            while waited < STOP_GRACE {
                if let Ok(Some(_)) = h.child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
                waited += Duration::from_millis(250);
            }
            warn!(ext = id, "live: helper ignored stop, killing");
            let _ = h.child.kill();
            let _ = h.child.wait();
        });
    }
}

/// Puts the helper in a kill-on-close job, so clipdip dying (even a hard
/// crash) takes every helper with it.
fn kill_with_us(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // the handle stays open for clipdip's lifetime on purpose: closing it is the kill
    static JOB: OnceLock<Option<isize>> = OnceLock::new();
    let job = JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(None, None).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .ok()?;
        Some(job.0 as isize)
    });
    if let Some(job) = job {
        unsafe {
            let _ = AssignProcessToJobObject(HANDLE(*job as *mut _), HANDLE(child.as_raw_handle()));
        }
    }
}
