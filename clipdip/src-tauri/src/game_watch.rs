//! Live game detection. A WinEvent hook wakes this thread on foreground
//! changes only (~25us of work per switch, nothing in between). A detected
//! game stays the session until its process exits, alt-tabbing out keeps it,
//! the same way Discord's own "Playing" works. Weaker matches (a Steam folder,
//! a title) lapse after a while out of focus instead, so a Steam-installed
//! tray tool like Wallpaper Engine can't read as "playing" for days.

use std::cell::Cell;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clipdip_gamedb::{Game, GameDb};
use tracing::{debug, info, warn};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, HWND, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, INFINITE, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetForegroundWindow, GetWindowThreadProcessId, MsgWaitForMultipleObjects,
    PeekMessageW, TranslateMessage, EVENT_SYSTEM_FOREGROUND, MSG, PM_REMOVE, QS_ALLINPUT,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
};

use crate::metadata::{exe_path_for_pid, window_title};

/// unix ms between 1601-01-01 (FILETIME epoch) and 1970-01-01
const FILETIME_UNIX_OFFSET_MS: i64 = 11_644_473_600_000;
/// exit polling when the process can't be waited on (no SYNCHRONIZE right)
const POLL_EXIT: Duration = Duration::from_secs(15);
/// a weak match out of focus this long ends; focusing it again starts a new session
/// with the same process start time, so elapsed time carries on
const WEAK_LAPSE: Duration = Duration::from_secs(10 * 60);

#[derive(Clone, Debug)]
pub struct GameSession {
    pub pid: u32,
    pub game: Game,
    /// process start, so elapsed time is right even when clipdip came up mid-game
    pub started_at_ms: i64,
}

pub type SessionSlot = Arc<Mutex<Option<GameSession>>>;

thread_local! {
    // the hook callback can't carry state, it parks the hwnd here for the loop
    static PENDING: Cell<isize> = const { Cell::new(0) };
}

unsafe extern "system" fn on_foreground(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    PENDING.with(|p| p.set(hwnd.0 as isize));
}

/// Starts the watcher thread. `on_change` runs on that thread whenever the
/// session starts, switches or ends.
pub fn spawn<F>(db: Arc<GameDb>, slot: SessionSlot, on_change: F)
where
    F: Fn(Option<&GameSession>) + Send + 'static,
{
    let _ = std::thread::Builder::new()
        .name("clipdip-gamewatch".into())
        .spawn(move || {
            let mut w = Watcher {
                db,
                slot,
                on_change: Box::new(on_change),
                proc: None,
                away_since: None,
                own_pid: std::process::id(),
            };
            w.run();
        });
}

struct Proc {
    handle: HANDLE,
    can_wait: bool,
    weak: bool,
}

struct Watcher {
    db: Arc<GameDb>,
    slot: SessionSlot,
    on_change: Box<dyn Fn(Option<&GameSession>) + Send>,
    proc: Option<Proc>,
    /// when focus left the session's process, None while it's in front
    away_since: Option<Instant>,
    own_pid: u32,
}

impl Watcher {
    fn run(&mut self) {
        // out-of-context hooks are delivered through this thread's message queue
        let hook = unsafe {
            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            )
        };
        if hook.is_invalid() {
            warn!("gamewatch: SetWinEventHook failed, live game detection off");
            return;
        }
        info!("gamewatch: started");
        self.consider(unsafe { GetForegroundWindow() });

        loop {
            let handles: Vec<HANDLE> = self
                .proc
                .as_ref()
                .filter(|p| p.can_wait)
                .map(|p| vec![p.handle])
                .unwrap_or_default();
            let timeout = self.next_deadline().map(|d| d.as_millis() as u32).unwrap_or(INFINITE);
            let r = unsafe {
                MsgWaitForMultipleObjects(
                    (!handles.is_empty()).then_some(handles.as_slice()),
                    false,
                    timeout,
                    QS_ALLINPUT,
                )
            };

            if !handles.is_empty() && r == WAIT_OBJECT_0 {
                self.end("exited");
                self.consider(unsafe { GetForegroundWindow() });
                continue;
            }
            if r == WAIT_TIMEOUT {
                self.check_timers();
                continue;
            }

            let mut msg = MSG::default();
            unsafe {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            let hwnd = PENDING.with(|p| p.replace(0));
            if hwnd != 0 {
                self.consider(HWND(hwnd as *mut _));
            }
        }
    }

    /// How long until the exit poll or the weak-match lapse is due.
    fn next_deadline(&self) -> Option<Duration> {
        let p = self.proc.as_ref()?;
        let mut next: Option<Duration> = None;
        if !p.can_wait {
            next = Some(POLL_EXIT);
        }
        if p.weak {
            if let Some(since) = self.away_since {
                let left = WEAK_LAPSE.saturating_sub(since.elapsed()).max(Duration::from_millis(10));
                next = Some(next.map_or(left, |n| n.min(left)));
            }
        }
        next
    }

    fn check_timers(&mut self) {
        let Some(p) = &self.proc else { return };
        if !p.can_wait && !still_running(p.handle) {
            self.end("exited");
            self.consider(unsafe { GetForegroundWindow() });
            return;
        }
        if p.weak && self.away_since.map(|t| t.elapsed() >= WEAK_LAPSE).unwrap_or(false) {
            // focus can come back without a foreground event (a popup closing hands it back), so
            // look at what's in front before ending a session someone is still playing
            self.consider(unsafe { GetForegroundWindow() });
            if self.away_since.is_some() {
                self.end("out of focus");
            }
        }
    }

    fn consider(&mut self, hwnd: HWND) {
        if hwnd.0.is_null() {
            return;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 || pid == self.own_pid {
            return;
        }
        let current = self.slot.lock().unwrap().clone();
        if current.as_ref().map(|s| s.pid) == Some(pid) {
            self.back();
            return;
        }
        let path = exe_path_for_pid(pid);
        if current.is_some() && self.away_since.is_none() {
            self.away_since = Some(Instant::now());
            let exe = path.as_ref().and_then(|p| p.file_name()).map(|f| f.to_string_lossy().to_string());
            debug!(exe = exe.as_deref().unwrap_or("?"), pid, "gamewatch: focus left the game");
        }
        let Some(path) = path else { return };
        let Some(game) = self.db.resolve(Some(&path), None, &mut || window_title(hwnd)) else {
            return;
        };
        // launcher and game resolving to the same app (LeagueClientUx and League of Legends)
        // keep the session and its start time
        if current.as_ref().map(|s| s.game.id == game.id).unwrap_or(false) {
            self.back();
            return;
        }
        self.start(pid, game, &path);
    }

    fn back(&mut self) {
        if let Some(t) = self.away_since.take() {
            debug!(away_secs = t.elapsed().as_secs(), "gamewatch: focus back on the game");
        }
    }

    fn start(&mut self, pid: u32, game: Game, path: &Path) {
        self.close_proc();
        let (handle, can_wait) = unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) {
                Ok(h) => (Some(h), true),
                Err(_) => (OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok(), false),
            }
        };
        let started_at_ms = handle.and_then(process_start_ms).unwrap_or_else(now_ms);
        let weak = !game.source.is_strong();
        self.proc = handle.map(|handle| Proc { handle, can_wait, weak });
        self.away_since = None;
        let session = GameSession {
            pid,
            game,
            started_at_ms,
        };
        info!(
            game = %session.game.name,
            id = %session.game.id,
            source = ?session.game.source,
            exe = %path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
            "gamewatch: session start"
        );
        *self.slot.lock().unwrap() = Some(session.clone());
        (self.on_change)(Some(&session));
    }

    fn end(&mut self, why: &str) {
        self.close_proc();
        self.away_since = None;
        let ended = self.slot.lock().unwrap().take();
        if let Some(s) = ended {
            info!(game = %s.game.name, why, "gamewatch: session end");
            (self.on_change)(None);
        }
    }

    fn close_proc(&mut self) {
        if let Some(p) = self.proc.take() {
            unsafe {
                let _ = CloseHandle(p.handle);
            }
        }
    }
}

fn still_running(h: HANDLE) -> bool {
    let mut code = 0u32;
    // STILL_ACTIVE (259) while running; a failed query counts as gone
    unsafe { GetExitCodeProcess(h, &mut code).is_ok() && code == 259 }
}

fn process_start_ms(h: HANDLE) -> Option<i64> {
    let (mut created, mut exited, mut kernel, mut user) =
        (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe { GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user).ok()? };
    let ticks = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
    if ticks == 0 {
        return None;
    }
    Some(ticks as i64 / 10_000 - FILETIME_UNIX_OFFSET_MS)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// file next to config.toml listing every game a session started for, newest
/// first; ClipLib's "Games that show" list reads it so games without a clip still appear
pub const PLAYED_FILE: &str = "played_games.json";
const PLAYED_MAX: usize = 500;

#[derive(serde::Serialize, serde::Deserialize)]
struct Played {
    id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon_url: Option<String>,
    /// unix ms
    last_seen: i64,
}

/// Best effort; a failed write only means the game is missing from that list.
pub fn remember_played(config_dir: &Path, game: &Game) {
    let file = config_dir.join(PLAYED_FILE);
    let mut list: Vec<Played> = std::fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    list.retain(|p| p.id != game.id);
    list.insert(
        0,
        Played {
            id: game.id.clone(),
            name: game.name.clone(),
            icon_url: game.icon_url.clone(),
            last_seen: now_ms(),
        },
    );
    list.truncate(PLAYED_MAX);
    let Ok(body) = serde_json::to_vec_pretty(&list) else { return };
    let tmp = file.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, &file);
    }
}
