//! Client-side coalescing for high-frequency event codes.
//!
//! The server rate-limits events (burst 120, refill 1/s) and the dashboard
//! drowns in per-occurrence spam, so call sites for codes that can fire in
//! bursts gate through here: the first occurrence in a window sends, repeats
//! inside the window are counted, and the next send carries the suppressed
//! count as `context: {"occurrences": n}` (the pattern the server brief asks
//! for). A tail count lost at process exit is acceptable — high-frequency
//! codes by definition re-fire.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub enum Gate {
    /// Send now. `suppressed` is how many occurrences were swallowed since the
    /// last send of this code (0 on the first ever).
    Send { suppressed: u64 },
    Suppress,
}

static STATE: Mutex<Option<HashMap<String, (Instant, u64)>>> = Mutex::new(None);

/// Rate-gate an event code. Returns [`Gate::Send`] at most once per
/// `min_interval` per `code`.
pub fn gate(code: &str, min_interval: Duration) -> Gate {
    let mut guard = STATE.lock();
    let map = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    match map.get_mut(code) {
        Some((last, suppressed)) => {
            if now.duration_since(*last) >= min_interval {
                let n = *suppressed;
                *last = now;
                *suppressed = 0;
                Gate::Send { suppressed: n }
            } else {
                *suppressed += 1;
                Gate::Suppress
            }
        }
        None => {
            map.insert(code.to_string(), (now, 0));
            Gate::Send { suppressed: 0 }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_sends_then_suppresses_then_reports_count() {
        let win = Duration::from_millis(50);
        assert!(matches!(
            gate("test_code_a", win),
            Gate::Send { suppressed: 0 }
        ));
        assert!(matches!(gate("test_code_a", win), Gate::Suppress));
        assert!(matches!(gate("test_code_a", win), Gate::Suppress));
        std::thread::sleep(Duration::from_millis(60));
        assert!(matches!(
            gate("test_code_a", win),
            Gate::Send { suppressed: 2 }
        ));
    }

    #[test]
    fn codes_are_independent() {
        let win = Duration::from_secs(60);
        assert!(matches!(
            gate("test_code_b", win),
            Gate::Send { suppressed: 0 }
        ));
        assert!(matches!(
            gate("test_code_c", win),
            Gate::Send { suppressed: 0 }
        ));
    }
}
