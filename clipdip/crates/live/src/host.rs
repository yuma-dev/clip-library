//! The helper side of `--live-ext`. stdin carries one start line and then
//! stays open; its EOF means clipdip is done with us (session over, clipdip
//! gone). stdout carries `{"live": {...}}` / `{"live": null}` lines.

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::{Live, Manifest, Settings, Target};

/// how long `run` gets to notice stdin closing before the helper exits anyway
const STOP_GRACE: Duration = Duration::from_secs(3);

#[derive(Serialize, Deserialize)]
pub struct Start {
    pub target: Target,
    #[serde(default)]
    pub settings: serde_json::Value,
}

pub struct Ctx {
    manifest: &'static Manifest,
    target: Target,
    settings: Settings,
    stop: Arc<AtomicBool>,
    last: Mutex<Option<Live>>,
}

impl Ctx {
    pub fn target(&self) -> &Target {
        &self.target
    }

    /// A toggle's value, the manifest default when unset.
    pub fn flag(&self, key: &str) -> bool {
        self.settings.flag(key)
    }

    /// A choice's value, the manifest default when unset or not one of the choices.
    pub fn choice(&self, key: &str) -> String {
        self.settings.choice(key)
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    /// False once clipdip is done with this session.
    pub fn running(&self) -> bool {
        !self.stop.load(Ordering::Relaxed)
    }

    /// Sleeps `d`, waking early when the session ends. Returns `running()`.
    pub fn sleep(&self, d: Duration) -> bool {
        let until = Instant::now() + d;
        while self.running() {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            std::thread::sleep(left.min(Duration::from_millis(250)));
        }
        self.running()
    }

    /// Hands the card's extras to clipdip. Same value twice is sent once, and
    /// an empty `Live` counts as none.
    pub fn emit(&self, live: Option<Live>) {
        let live = live.filter(|l| !l.is_empty());
        let Ok(mut last) = self.last.lock() else {
            return;
        };
        if *last == live {
            return;
        }
        let line = serde_json::json!({ "live": live });
        let mut out = std::io::stdout().lock();
        if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
            // clipdip stopped reading, nothing left to do for
            self.stop.store(true, Ordering::Relaxed);
        }
        *last = live;
    }

    /// `%LOCALAPPDATA%\clipdip\data\live\<id>`, created on demand, for caches.
    pub fn cache_dir(&self) -> Option<PathBuf> {
        let base = std::env::var_os("LOCALAPPDATA")?;
        let dir = PathBuf::from(base)
            .join("clipdip")
            .join("data")
            .join("live")
            .join(self.manifest.id);
        std::fs::create_dir_all(&dir).ok()?;
        Some(dir)
    }
}

/// `clipdip.exe --live-ext <id>`. Returns the exit code.
pub fn run_helper(id: &str) -> i32 {
    let Some(manifest) = crate::find(id) else {
        warn!(id, "live: no such extension");
        return 2;
    };
    lighten_process();

    let mut first = String::new();
    let stdin = std::io::stdin();
    if stdin.lock().read_line(&mut first).unwrap_or(0) == 0 {
        return 0;
    }
    let start: Start = match serde_json::from_str(&first) {
        Ok(s) => s,
        Err(e) => {
            warn!("live: bad start line: {e}");
            return 2;
        }
    };

    let stop = Arc::new(AtomicBool::new(false));
    {
        let stop = stop.clone();
        let _ = std::thread::Builder::new()
            .name("live-stdin".into())
            .spawn(move || {
                let mut sink = String::new();
                let mut input = std::io::stdin().lock();
                while input.read_line(&mut sink).map(|n| n > 0).unwrap_or(false) {
                    sink.clear();
                }
                stop.store(true, Ordering::Relaxed);
                // an extension stuck in a blocking call shouldn't keep the process around
                std::thread::sleep(STOP_GRACE);
                std::process::exit(0);
            });
    }

    info!(id, game = %start.target.game_name, "live: started");
    let ctx = Ctx {
        manifest,
        target: start.target,
        settings: Settings::new(manifest, start.settings),
        stop,
        last: Mutex::new(None),
    };
    (manifest.run)(&ctx);
    ctx.emit(None);
    info!(id, "live: done");
    0
}

/// Below-normal priority and EcoQoS: the helper sits next to a game and only
/// ever needs a few ms every few seconds.
fn lighten_process() {
    use windows::Win32::System::Threading::{
        GetCurrentProcess, ProcessPowerThrottling, SetPriorityClass, SetProcessInformation,
        BELOW_NORMAL_PRIORITY_CLASS, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_STATE,
    };
    unsafe {
        let me = GetCurrentProcess();
        let _ = SetPriorityClass(me, BELOW_NORMAL_PRIORITY_CLASS);
        let state = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            StateMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        };
        let _ = SetProcessInformation(
            me,
            ProcessPowerThrottling,
            &state as *const _ as *const _,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        );
    }
}
