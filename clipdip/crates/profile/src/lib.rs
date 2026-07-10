//! Lightweight runtime profiler for the clipdip pipeline.
//!
//! Goals
//! - **Off by default, near-zero overhead when disabled.** Fast-path is a
//!   single relaxed-atomic load. Instrumented code stays in place in
//!   release builds; flipping the toggle starts collecting samples.
//! - **Per-stage timings** with p50 / p95 / p99 / mean / max over a
//!   reporting window, so we can answer "where do the milliseconds go?"
//!   instead of guessing.
//! - **Process CPU%** sampled via `GetProcessTimes`, walltime-normalized.
//! - **Process GPU%** sampled via PDH `\GPU Engine(pid_*)\Utilization
//!   Percentage`, summed across all engine types for this PID.
//! - **One log line per window.** The pipeline owns the reporter cadence
//!   (default 5 s); this crate just collects.
//!
//! Usage
//! ```ignore
//! // Once, from the CLI binary:
//! clipdip_profile::enable();
//!
//! // Anywhere in a hot path:
//! let _t = clipdip_profile::start("encode");
//! // ... work ...
//! // drop(_t) records the elapsed time under the "encode" stage.
//!
//! // Periodically, from the pipeline reporter thread:
//! let report = clipdip_profile::report();
//! tracing::info!(?report, "profile window");
//! ```

#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

use parking_lot::Mutex;

/// Global toggle. The fast path is a single relaxed load; instrumentation
/// macros and `ScopedTimer::drop` check this before touching the mutex.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Lazily-initialized state. Mutex contention is OK — we only lock on
/// stage record (typically <300 samples/sec total) and on the reporter
/// thread once per window.
static STATE: OnceLock<Mutex<State>> = OnceLock::new();

struct State {
    /// Sample buffers per stage. Microseconds as u32 — 71 minutes max,
    /// plenty for any realistic stage.
    samples: BTreeMap<&'static str, Vec<u32>>,
    /// Wall-clock start of the current reporting window.
    window_start: Instant,
    /// Last CPU sampling state. `None` until the first call to
    /// [`report`].
    last_cpu: Option<CpuSample>,
    /// PDH GPU sampler. Lazily initialized on first `report()`.
    #[cfg(target_os = "windows")]
    gpu: GpuInit,
}

#[derive(Clone, Copy)]
struct CpuSample {
    /// Sum of user+kernel CPU time across all threads, in 100ns units.
    cpu_100ns: u64,
    /// Wall clock when this sample was taken.
    at: Instant,
}

fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| {
        Mutex::new(State {
            samples: BTreeMap::new(),
            window_start: Instant::now(),
            last_cpu: None,
            #[cfg(target_os = "windows")]
            gpu: GpuInit::Uninit,
        })
    })
}

/// Turn profiling on. Fast path everywhere else becomes one atomic load
/// returning `true`.
pub fn enable() {
    ENABLED.store(true, Ordering::Relaxed);
    // Force-init the state so the first sample doesn't pay the OnceLock
    // race.
    state();
}

/// Turn profiling off. In-flight `ScopedTimer`s already in progress will
/// silently skip their record on drop.
pub fn disable() {
    ENABLED.store(false, Ordering::Relaxed);
}

#[inline(always)]
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Start a scope. The returned guard records its lifetime under
/// `stage` when dropped, *if* profiling is enabled at drop time. When
/// disabled, drop is a single relaxed load.
#[inline]
pub fn start(stage: &'static str) -> ScopedTimer {
    ScopedTimer {
        stage,
        start: if enabled() { Some(Instant::now()) } else { None },
    }
}

/// Record a pre-measured duration without a scope guard. Use this when
/// you already have an `Instant` from earlier (e.g. across an await
/// or thread boundary).
#[inline]
pub fn record(stage: &'static str, micros: u32) {
    if !enabled() {
        return;
    }
    state()
        .lock()
        .samples
        .entry(stage)
        .or_default()
        .push(micros);
}

pub struct ScopedTimer {
    stage: &'static str,
    /// `None` if profiling was disabled at construction. We re-check
    /// `enabled()` at drop, so toggling on mid-scope still records
    /// (and toggling off mid-scope still skips).
    start: Option<Instant>,
}

impl Drop for ScopedTimer {
    #[inline]
    fn drop(&mut self) {
        // Re-check the flag so a late `enable()` doesn't capture a
        // partially-elapsed scope (it has no valid start), and so a late
        // `disable()` doesn't waste a lock.
        let Some(start) = self.start else { return };
        if !enabled() {
            return;
        }
        let us = start.elapsed().as_micros().min(u32::MAX as u128) as u32;
        state()
            .lock()
            .samples
            .entry(self.stage)
            .or_default()
            .push(us);
    }
}

#[derive(Debug, Clone)]
pub struct StageStats {
    pub name: &'static str,
    pub count: u64,
    pub mean_us: u64,
    pub p50_us: u32,
    pub p95_us: u32,
    pub p99_us: u32,
    pub max_us: u32,
}

#[derive(Debug, Clone)]
pub struct ProfileReport {
    pub stages: Vec<StageStats>,
    /// Window length in milliseconds. Resets on each `report()` call.
    pub window_ms: u64,
    /// Process CPU usage over the window, 0.0..=1.0 per logical core
    /// (so 1.0 = one core fully pinned). `None` on the first call (no
    /// baseline to compare against yet) or if `GetProcessTimes` fails.
    pub cpu_cores_busy: Option<f64>,
    /// Sum of `\GPU Engine(pid_*)\Utilization Percentage` across all engine
    /// types for this process. Each engine contributes 0–100%, so the sum
    /// can exceed 100% when multiple engines (3D, VideoEncode, Copy, …) are
    /// active simultaneously. `None` on the first call or if PDH init fails.
    pub gpu_percent: Option<f64>,
}

/// Drain current samples and return a window report. The window starts
/// over at the moment of the call.
pub fn report() -> ProfileReport {
    let now = Instant::now();
    let mut st = state().lock();
    let window_ms = now.duration_since(st.window_start).as_millis() as u64;
    st.window_start = now;

    let stages = std::mem::take(&mut st.samples)
        .into_iter()
        .map(|(name, mut v)| {
            v.sort_unstable();
            let count = v.len() as u64;
            let mean_us = if count == 0 {
                0
            } else {
                (v.iter().map(|&x| x as u64).sum::<u64>()) / count
            };
            let pct = |p: f64| -> u32 {
                if v.is_empty() {
                    0
                } else {
                    // Nearest-rank percentile; clamp to last index.
                    let idx = ((p * v.len() as f64).ceil() as usize)
                        .saturating_sub(1)
                        .min(v.len() - 1);
                    v[idx]
                }
            };
            StageStats {
                name,
                count,
                mean_us,
                p50_us: pct(0.50),
                p95_us: pct(0.95),
                p99_us: pct(0.99),
                max_us: *v.last().unwrap_or(&0),
            }
        })
        .collect();

    let cpu_cores_busy = sample_cpu(&mut st, now);
    let gpu_percent = sample_gpu(&mut st);

    ProfileReport {
        stages,
        window_ms,
        cpu_cores_busy,
        gpu_percent,
    }
}

/// Sample process CPU time and return cores-busy since the previous sample.
/// `None` on first call (no delta yet) or on Windows API failure.
#[cfg(target_os = "windows")]
fn sample_cpu(st: &mut State, now: Instant) -> Option<f64> {
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    let mut creation = Default::default();
    let mut exit = Default::default();
    let mut kernel = Default::default();
    let mut user = Default::default();
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if ok.is_err() {
        return None;
    }
    // FILETIMEs are 100ns ticks.
    let to_u64 = |ft: windows::Win32::Foundation::FILETIME| -> u64 {
        ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
    };
    let total = to_u64(kernel).wrapping_add(to_u64(user));
    let now_sample = CpuSample {
        cpu_100ns: total,
        at: now,
    };
    let prev = st.last_cpu.replace(now_sample)?;
    let dt_100ns = now.duration_since(prev.at).as_nanos() / 100;
    if dt_100ns == 0 {
        return None;
    }
    let dcpu = total.saturating_sub(prev.cpu_100ns);
    Some(dcpu as f64 / dt_100ns as f64)
}

#[cfg(not(target_os = "windows"))]
fn sample_cpu(_st: &mut State, _now: Instant) -> Option<f64> {
    None
}

// ---- GPU% via PDH ----------------------------------------------------------

#[cfg(target_os = "windows")]
enum GpuInit {
    /// PDH not yet opened — happens on first `report()`.
    Uninit,
    /// PDH query open and running.
    Active(GpuSampler),
    /// Open failed (no GPU Engine counter on this system, or PDH error).
    Failed,
}

/// Owns a PDH query that watches `\GPU Engine(pid_<PID>_*)\Utilization
/// Percentage` for this process. Handles are plain `isize` in windows 0.58.
#[cfg(target_os = "windows")]
struct GpuSampler {
    query: isize,
    counter: isize,
    /// False until we've done two collects (PDH needs two samples to compute
    /// a rate). The first collect in `new()` primes t0; `primed` flips to
    /// true after the first collect inside `sample()`.
    primed: bool,
}

// Safety: both handles are accessed only while holding Mutex<State>.
#[cfg(target_os = "windows")]
unsafe impl Send for GpuSampler {}

#[cfg(target_os = "windows")]
impl GpuSampler {
    fn new() -> Option<Self> {
        use windows::Win32::System::Performance::{PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhOpenQueryW};
        use windows::core::PCWSTR;

        let pid = std::process::id();
        // Wildcard matches all luid / phys / eng / engtype combos for this PID.
        let path = format!("\\GPU Engine(pid_{pid}_*)\\Utilization Percentage");
        let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

        let mut query: isize = 0;
        // Null data source = real-time collection.
        let status = unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) };
        if status != 0 {
            return None;
        }

        let mut counter: isize = 0;
        let status = unsafe {
            PdhAddEnglishCounterW(
                query,
                PCWSTR::from_raw(path_wide.as_ptr()),
                0,
                &mut counter,
            )
        };
        if status != 0 {
            unsafe { PdhCloseQuery(query) };
            return None;
        }

        // First collect establishes t0 for rate counters; we can't read
        // values yet (need a second collect to compute the delta).
        unsafe { PdhCollectQueryData(query) };

        Some(Self {
            query,
            counter,
            primed: false,
        })
    }

    fn sample(&mut self) -> Option<f64> {
        use windows::Win32::System::Performance::{
            PdhCollectQueryData, PdhGetFormattedCounterArrayW, PDH_FMT_COUNTERVALUE_ITEM_W,
            PDH_FMT_DOUBLE, PDH_MORE_DATA,
        };

        let status = unsafe { PdhCollectQueryData(self.query) };
        if status != 0 {
            return None;
        }

        // First sample after init: this collect was t1, but we treat it as
        // the new t0 and wait for the next report() to read values.
        if !self.primed {
            self.primed = true;
            return None;
        }

        // Two-pass: call with no buffer to get required byte count, then
        // allocate and call again.
        let mut buf_bytes: u32 = 0;
        let mut item_count: u32 = 0;
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut buf_bytes,
                &mut item_count,
                None,
            )
        };
        // PDH_MORE_DATA is the expected return when buffer is null/too small.
        if status != PDH_MORE_DATA {
            return None;
        }
        if buf_bytes == 0 || item_count == 0 {
            return None;
        }

        let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        // Round up to avoid being one short due to padding.
        let n = (buf_bytes as usize + item_size - 1) / item_size;
        let n = n.max(item_count as usize);
        let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> =
            (0..n).map(|_| PDH_FMT_COUNTERVALUE_ITEM_W::default()).collect();

        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                self.counter,
                PDH_FMT_DOUBLE,
                &mut buf_bytes,
                &mut item_count,
                Some(buf.as_mut_ptr()),
            )
        };
        if status != 0 {
            return None;
        }

        let sum: f64 = buf[..item_count as usize]
            .iter()
            // SAFETY: we requested PDH_FMT_DOUBLE so the union holds doubleValue.
            .map(|item| unsafe { item.FmtValue.Anonymous.doubleValue })
            .sum();

        Some(sum)
    }
}

#[cfg(target_os = "windows")]
impl Drop for GpuSampler {
    fn drop(&mut self) {
        use windows::Win32::System::Performance::PdhCloseQuery;
        unsafe { PdhCloseQuery(self.query) };
    }
}

#[cfg(target_os = "windows")]
fn sample_gpu(st: &mut State) -> Option<f64> {
    match &mut st.gpu {
        GpuInit::Uninit => {
            match GpuSampler::new() {
                Some(sampler) => {
                    st.gpu = GpuInit::Active(sampler);
                    // Primed with t0 in new(); need one more report() cycle.
                    None
                }
                None => {
                    st.gpu = GpuInit::Failed;
                    None
                }
            }
        }
        GpuInit::Active(sampler) => sampler.sample(),
        GpuInit::Failed => None,
    }
}

#[cfg(not(target_os = "windows"))]
fn sample_gpu(_st: &mut State) -> Option<f64> {
    None
}

/// Format a `ProfileReport` as a single human-readable line suitable for
/// `info!`. Lines look like:
///   `profile cpu=0.42cores gpu=12.3% window=5012ms acquire(n=300 p50=1.2
///    p95=3.4 p99=4.5 max=7.0 ms) encode(n=300 p50=2.1 ...)`
pub fn format_report(rep: &ProfileReport) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(256);
    let _ = write!(s, "profile window={}ms", rep.window_ms);
    if let Some(cpu) = rep.cpu_cores_busy {
        let _ = write!(s, " cpu={:.2}cores", cpu);
    }
    if let Some(gpu) = rep.gpu_percent {
        let _ = write!(s, " gpu={:.1}%", gpu);
    }
    for st in &rep.stages {
        let _ = write!(
            s,
            " {}(n={} p50={:.2} p95={:.2} p99={:.2} max={:.2}ms)",
            st.name,
            st.count,
            st.p50_us as f64 / 1000.0,
            st.p95_us as f64 / 1000.0,
            st.p99_us as f64 / 1000.0,
            st.max_us as f64 / 1000.0,
        );
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    // Profile state is process-global. Serialize tests so enable()/disable()
    // calls in one test don't race with record() calls in another.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn disabled_is_noop() {
        let _g = TEST_LOCK.lock().unwrap();
        disable();
        let _t = start("noop");
        record("noop", 123);
        // No samples should have been recorded when disabled; the BTree
        // might still exist from earlier tests, so just check the count.
        let rep = report();
        assert!(rep.stages.iter().all(|s| s.name != "noop" || s.count == 0));
    }

    #[test]
    fn records_when_enabled() {
        let _g = TEST_LOCK.lock().unwrap();
        enable();
        record("test_stage", 100);
        record("test_stage", 200);
        record("test_stage", 300);
        let rep = report();
        let st = rep.stages.iter().find(|s| s.name == "test_stage").unwrap();
        assert_eq!(st.count, 3);
        assert_eq!(st.mean_us, 200);
        assert_eq!(st.p50_us, 200);
        assert_eq!(st.max_us, 300);
        disable();
    }

    #[test]
    fn percentiles_handle_small_n() {
        let _g = TEST_LOCK.lock().unwrap();
        enable();
        // Single sample — all percentiles should equal it.
        record("single", 42);
        let rep = report();
        let st = rep.stages.iter().find(|s| s.name == "single").unwrap();
        assert_eq!(st.p50_us, 42);
        assert_eq!(st.p95_us, 42);
        assert_eq!(st.p99_us, 42);
        disable();
    }

    #[test]
    fn report_resets_window() {
        let _g = TEST_LOCK.lock().unwrap();
        enable();
        record("w", 10);
        let _ = report();
        let rep2 = report();
        assert!(rep2.stages.iter().all(|s| s.name != "w" || s.count == 0));
        disable();
    }
}
