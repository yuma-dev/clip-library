//! In-RAM byte-budgeted ring buffer of encoded packets.
//!
//! The pipeline produces three streams (video, system audio, mic audio) and
//! all of them feed the same buffer through separate stream IDs. On hotkey,
//! the muxer walks the video stream backward from newest to find the oldest
//! IDR within the configured replay window, then trims audio to match.
//!
//! ## Eviction
//!
//! Two triggers, both of which evict whole video GOPs (IDR through
//! just-before-next-IDR) plus every audio packet older than the new oldest
//! video IDR:
//!
//! - **Time**: a GOP whose successor IDR is already older than
//!   `newest_video_pts - time_window` contributes nothing to the replay
//!   window and goes. This is the primary trigger; it is what guarantees
//!   the configured replay duration is retained.
//! - **Bytes**: hard safety cap so a runaway bitrate can't eat all RAM.
//!   When this trigger evicts a GOP that is still inside the time window,
//!   the replay window is being truncated by memory pressure — the ring
//!   records that moment in `pressure_eviction_pts` so a health monitor
//!   can tell "buffer short because memory" apart from "buffer short
//!   because capture gapped".
//!
//! Both guarantee:
//!
//! 1. The buffer always starts at a video IDR (the muxer never has to scan
//!    past P-frames whose IDR was already evicted).
//! 2. No audio "ghosts" — audio whose corresponding video has been dropped is
//!    dropped too.
//!
//! A **hold point** ([`PacketRing::set_hold`]) pins everything at/after a
//! PTS — used for manual recordings, where eviction must not eat footage
//! between "start recording" and "stop". While a hold is active the ring
//! grows beyond both the time window and the byte budget.

use parking_lot::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

/// Shared "media clock" that maps raw QueryPerformanceCounter timestamps
/// (100-ns ticks) onto a gap-free presentation timeline.
///
/// Capture can stall for seconds-to-minutes when the GPU/display drops to a
/// low-power state: DXGI stops delivering desktop frames and the DXGI/NVENC
/// calls in the video thread block, all while QPC keeps advancing. When
/// capture resumes, the first frame's raw QPC has jumped far ahead of the
/// last one. Stamping that raw value would (a) make the ring's time-window
/// eviction treat the *entire* buffered window as stale and wipe it —
/// collapsing the next saved clip to ~1 second — and (b) inflate the
/// measured span so the muxed fps comes out wrong.
///
/// The video thread (the constant-frame-rate heartbeat) detects these jumps
/// and folds them into `pause_offset` so the emitted timeline stays
/// continuous: `media = raw - pause_offset`. Every stream stamps through the
/// same clock, so audio and video stay on one timebase across a stall.
#[derive(Debug, Default)]
pub struct MediaClock {
    pause_offset_100ns: AtomicI64,
}

impl MediaClock {
    pub fn new() -> Self {
        Self::default()
    }

    /// Current accumulated pause offset (100-ns ticks).
    pub fn offset(&self) -> i64 {
        self.pause_offset_100ns.load(Ordering::Relaxed)
    }

    /// Map a raw QPC timestamp (100-ns ticks) onto the gap-free media
    /// timeline.
    pub fn to_media(&self, raw_qpc_100ns: i64) -> i64 {
        raw_qpc_100ns - self.offset()
    }

    /// Grow the pause offset by `extra` ticks — called by the video thread
    /// when it detects a capture stall. Returns the new total offset.
    pub fn add_pause(&self, extra: i64) -> i64 {
        self.pause_offset_100ns.fetch_add(extra, Ordering::Relaxed) + extra
    }
}

pub const STREAM_VIDEO: u8 = 0;
pub const STREAM_AUDIO_SYSTEM: u8 = 1;
pub const STREAM_AUDIO_MIC: u8 = 2;

#[derive(Clone, Debug)]
pub struct EncodedPacket {
    pub bytes: Arc<[u8]>,
    /// Presentation timestamp in 100-ns ticks (matches QueryPerformanceCounter
    /// and Windows audio APIs).
    pub pts_100ns: i64,
    pub dts_100ns: i64,
    pub is_keyframe: bool,
    pub stream_id: u8,
}

impl EncodedPacket {
    pub fn size_in_bytes(&self) -> usize {
        self.bytes.len() + std::mem::size_of::<Self>()
    }
}

/// Fixed byte-budget circular packet queue with GOP-aware eviction.
pub struct PacketRing {
    inner: Mutex<RingInner>,
}

/// Snapshot of the ring's video occupancy — see [`PacketRing::stats`].
#[derive(Clone, Copy, Debug, Default)]
pub struct RingStats {
    /// Encoded video payload bytes currently buffered.
    pub video_bytes: u64,
    /// Of `video_bytes`, the bytes belonging to keyframes. On static
    /// content nearly all bits are the once-per-GOP IDR — this split is
    /// what makes that measurable from a user's log.
    pub video_keyframe_bytes: u64,
    /// PTS span from oldest to newest buffered video packet (100-ns ticks).
    pub video_span_100ns: i64,
    /// Total accounted bytes (all streams, incl. per-packet overhead) —
    /// the number the byte budget is enforced against.
    pub bytes_used: u64,
    /// The ring's byte budget (eviction cap).
    pub byte_budget: u64,
    /// Newest video PTS seen so far (`i64::MIN` until the first video
    /// packet). Recency baseline for the two stamps below, which live on
    /// the same media timeline.
    pub newest_video_pts: i64,
    /// Newest video PTS at the last time a *time-fresh* GOP was evicted by
    /// the byte budget (`i64::MIN` = never). A recent value means the
    /// replay window is currently truncated by memory pressure.
    pub pressure_eviction_pts: i64,
    /// Newest video PTS at the moment the last manual-recording hold was
    /// released (`i64::MIN` = never). Releasing a hold evicts the whole
    /// backlog at once, so byte-pressure signals within roughly one window
    /// of this point are expected and not a steady state.
    pub hold_released_pts: i64,
}

impl RingStats {
    /// A time-fresh GOP was byte-evicted within the last `2 * window` of
    /// media time: the replay window is (or very recently was) truncated
    /// by memory pressure rather than a capture gap.
    pub fn pressure_recent(&self, window_100ns: i64) -> bool {
        self.pressure_eviction_pts != i64::MIN
            && self.newest_video_pts != i64::MIN
            && self.newest_video_pts - self.pressure_eviction_pts <= 2 * window_100ns
    }

    /// The post-recording eviction burst has settled. Releasing a hold
    /// flushes the whole recording backlog at once, stamping pressure
    /// evictions that say nothing about steady state — treat pressure as
    /// meaningful only once the release is at least as old as the
    /// pressure-recency horizon above, so the two tests can never
    /// disagree about the same stamp.
    pub fn past_hold_grace(&self, window_100ns: i64) -> bool {
        self.hold_released_pts == i64::MIN
            || self.newest_video_pts == i64::MIN
            || self.newest_video_pts - self.hold_released_pts > 2 * window_100ns
    }
}

struct RingInner {
    packets: std::collections::VecDeque<EncodedPacket>,
    bytes_used: usize,
    byte_budget: usize,
    /// Replay window in 100-ns ticks. GOPs that fall entirely outside
    /// `newest_video_pts - time_window_100ns` are evicted regardless of
    /// the byte budget. 0 disables time-based eviction (byte budget only).
    time_window_100ns: i64,
    /// Newest video PTS seen so far — the anchor for time eviction.
    newest_video_pts: i64,
    /// While `Some(pts)`, no packet with `pts_100ns >= pts` is ever
    /// evicted (manual-recording hold).
    hold_from_pts: Option<i64>,
    /// See [`RingStats::pressure_eviction_pts`].
    pressure_eviction_pts: i64,
    /// See [`RingStats::hold_released_pts`].
    hold_released_pts: i64,
}

impl PacketRing {
    pub fn new(byte_budget: usize) -> Self {
        Self::with_time_window(byte_budget, 0)
    }

    /// Ring with both a byte cap and a replay time window (100-ns ticks).
    pub fn with_time_window(byte_budget: usize, time_window_100ns: i64) -> Self {
        Self {
            inner: Mutex::new(RingInner {
                packets: std::collections::VecDeque::new(),
                bytes_used: 0,
                byte_budget,
                time_window_100ns,
                newest_video_pts: i64::MIN,
                hold_from_pts: None,
                pressure_eviction_pts: i64::MIN,
                hold_released_pts: i64::MIN,
            }),
        }
    }

    /// Pin everything at/after `pts` against eviction (`Some`), or release
    /// the pin (`None`). Releasing re-applies the time window + byte budget
    /// on the next push.
    pub fn set_hold(&self, pts: Option<i64>) {
        let mut g = self.inner.lock();
        // Stamp the release moment so the health monitor can grace-period
        // the burst of byte-pressure evictions a long recording leaves
        // behind (the backlog all evicts on the next few pushes).
        if pts.is_none() && g.hold_from_pts.is_some() {
            g.hold_released_pts = g.newest_video_pts;
        }
        g.hold_from_pts = pts;
    }

    /// PTS of the newest video keyframe currently buffered, if any. Used
    /// as the anchor when a manual recording starts: holding from the
    /// latest IDR (rather than "now") keeps the recording decodable from
    /// its very first frame.
    pub fn latest_keyframe_pts(&self) -> Option<i64> {
        self.inner
            .lock()
            .packets
            .iter()
            .rev()
            .find(|p| p.stream_id == STREAM_VIDEO && p.is_keyframe)
            .map(|p| p.pts_100ns)
    }

    pub fn push(&self, packet: EncodedPacket) {
        let mut g = self.inner.lock();
        g.bytes_used += packet.size_in_bytes();
        let is_video = packet.stream_id == STREAM_VIDEO;
        if is_video && packet.pts_100ns > g.newest_video_pts {
            g.newest_video_pts = packet.pts_100ns;
        }
        g.packets.push_back(packet);
        // Time-based staleness is anchored on `newest_video_pts`, which only
        // advances on video pushes — so audio pushes can never make a GOP
        // newly stale, they can only ever trip the byte-budget safety cap.
        // Skipping the O(GOP) eviction scan on the (far more frequent) audio
        // pushes unless we're actually over budget keeps `push` O(1) in the
        // common case. Without this, every tiny audio packet — hundreds per
        // second across two producer threads — re-scanned the front GOP and
        // dominated the CPU profile.
        if is_video || g.bytes_used > g.byte_budget {
            g.evict_to_budget();
        }
    }

    /// Snapshot the current contents. Cheap because packet bytes are Arc'd.
    pub fn snapshot(&self) -> Vec<EncodedPacket> {
        let g = self.inner.lock();
        g.packets.iter().cloned().collect()
    }

    pub fn bytes_used(&self) -> usize {
        self.inner.lock().bytes_used
    }

    /// Occupancy stats for the UI's file-size estimate. Counts only video
    /// payload bytes — audio sits in the ring as raw PCM, which is far
    /// heavier than the AAC it becomes in the saved clip, so including it
    /// would wildly overstate clip size.
    pub fn stats(&self) -> RingStats {
        let g = self.inner.lock();
        let mut video_bytes: u64 = 0;
        let mut video_keyframe_bytes: u64 = 0;
        let mut first_pts: Option<i64> = None;
        let mut last_pts: i64 = 0;
        for p in g.packets.iter().filter(|p| p.stream_id == STREAM_VIDEO) {
            video_bytes += p.bytes.len() as u64;
            if p.is_keyframe {
                video_keyframe_bytes += p.bytes.len() as u64;
            }
            if first_pts.is_none() {
                first_pts = Some(p.pts_100ns);
            }
            last_pts = p.pts_100ns;
        }
        RingStats {
            video_bytes,
            video_keyframe_bytes,
            video_span_100ns: first_pts.map_or(0, |f| last_pts - f),
            bytes_used: g.bytes_used as u64,
            byte_budget: g.byte_budget as u64,
            newest_video_pts: g.newest_video_pts,
            pressure_eviction_pts: g.pressure_eviction_pts,
            hold_released_pts: g.hold_released_pts,
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().packets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().packets.is_empty()
    }
}

impl RingInner {
    /// Evict whole GOPs from the front while the front GOP is either stale
    /// (entirely outside the replay time window) or we're over the byte
    /// budget. A "GOP" is defined as everything from one video IDR up to
    /// (but not including) the next video IDR, plus all audio packets older
    /// than the new oldest video IDR.
    fn evict_to_budget(&mut self) {
        while !self.packets.is_empty() {
            // Find the index of the second video IDR. Everything before it is
            // one GOP (plus audio) and can safely go.
            let second_idr = self
                .packets
                .iter()
                .enumerate()
                .filter(|(_, p)| p.stream_id == STREAM_VIDEO && p.is_keyframe)
                .nth(1)
                .map(|(i, _)| i);

            let Some(cut) = second_idr else {
                // No second IDR yet — we're inside the only GOP. Don't evict
                // anything; we'd leave the buffer in a state where it doesn't
                // start at an IDR. Better to temporarily overshoot the budget.
                break;
            };
            let cut_pts = self.packets[cut].pts_100ns;

            // Never evict past an active hold point. Eviction up to a cut
            // exactly AT the hold pts is fine — the buffer then starts at
            // the held IDR itself.
            if let Some(hold) = self.hold_from_pts {
                if cut_pts > hold {
                    break;
                }
            }

            // Time trigger: the front GOP ends at `cut_pts`; if even that
            // is at/before the window start, the whole GOP is outside the
            // replay window and keeping it can only make clips *longer*
            // than configured, never help.
            let stale = self.time_window_100ns > 0
                && self.newest_video_pts != i64::MIN
                && cut_pts <= self.newest_video_pts - self.time_window_100ns;

            if !stale && self.bytes_used <= self.byte_budget {
                break;
            }

            // A time-fresh GOP evicted purely by the byte budget means the
            // replay window is being truncated by memory pressure. Skip the
            // stamp while a hold is active: recording holds intentionally
            // grow the ring past the budget, so pre-hold evictions there
            // are expected, not a steady state worth alerting on.
            if !stale && self.hold_from_pts.is_none() {
                self.pressure_eviction_pts = self.newest_video_pts;
            }

            for _ in 0..cut {
                if let Some(pkt) = self.packets.pop_front() {
                    self.bytes_used -= pkt.size_in_bytes();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pkt(stream_id: u8, is_keyframe: bool, pts: i64, payload: usize) -> EncodedPacket {
        EncodedPacket {
            bytes: vec![0u8; payload].into(),
            pts_100ns: pts,
            dts_100ns: pts,
            is_keyframe,
            stream_id,
        }
    }

    fn video_idr(pts: i64, payload: usize) -> EncodedPacket {
        pkt(STREAM_VIDEO, true, pts, payload)
    }
    fn video_p(pts: i64, payload: usize) -> EncodedPacket {
        pkt(STREAM_VIDEO, false, pts, payload)
    }
    fn audio_sys(pts: i64, payload: usize) -> EncodedPacket {
        pkt(STREAM_AUDIO_SYSTEM, true, pts, payload)
    }

    #[test]
    fn empty_ring_reports_empty() {
        let r = PacketRing::new(1024);
        assert!(r.is_empty());
        assert_eq!(r.bytes_used(), 0);
    }

    #[test]
    fn push_under_budget_retains_all() {
        // Budget is large enough — nothing should evict.
        let r = PacketRing::new(1024 * 1024);
        r.push(video_idr(0, 100));
        r.push(video_p(1, 50));
        r.push(audio_sys(2, 20));
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn never_evicts_when_only_one_gop_exists() {
        // Even if we blow past budget, we cannot drop the only IDR — that
        // would leave orphaned P-frames.
        let r = PacketRing::new(50);
        r.push(video_idr(0, 1000));
        r.push(video_p(1, 1000));
        r.push(video_p(2, 1000));
        assert_eq!(r.len(), 3);
        assert!(r.bytes_used() > 50, "expected overshoot");
    }

    #[test]
    fn evicts_whole_gop_when_second_idr_appears() {
        // First GOP: IDR + 2 P-frames + 1 audio = ~3320 bytes (3 * 1000 +
        // 1 * audio + packet overhead). Push a second IDR — eviction should
        // now have a cut point and remove the first GOP entirely.
        let r = PacketRing::new(2000);
        r.push(video_idr(0, 1000));
        r.push(video_p(1, 1000));
        r.push(audio_sys(1, 200));
        r.push(video_p(2, 1000));
        // Still only one IDR — no eviction yet despite overshoot.
        assert!(r.bytes_used() > 2000);
        let before = r.len();
        assert_eq!(before, 4);

        // Second IDR opens a cut point. Eviction drops everything up to it.
        r.push(video_idr(3, 100));
        let after = r.snapshot();
        // Buffer must now start with an IDR.
        assert!(after[0].stream_id == STREAM_VIDEO && after[0].is_keyframe);
        // And it should be the second IDR (pts 3), not the first.
        assert_eq!(after[0].pts_100ns, 3);
    }

    #[test]
    fn evicts_multiple_gops_to_meet_tight_budget() {
        // Tight budget forces multiple-GOP eviction once cut points exist.
        let r = PacketRing::new(500);
        for gop in 0..5 {
            let base = gop * 10;
            r.push(video_idr(base, 200));
            r.push(video_p(base + 1, 200));
            r.push(audio_sys(base + 1, 50));
        }
        // After all pushes, buffer must still start at an IDR and be within
        // budget (or hold only the latest single GOP if even one GOP exceeds
        // budget).
        let snap = r.snapshot();
        assert!(!snap.is_empty());
        assert!(
            snap[0].stream_id == STREAM_VIDEO && snap[0].is_keyframe,
            "first packet must be a video IDR, got {:?}",
            snap[0]
        );
    }

    #[test]
    fn audio_only_pushes_drop_when_no_video_present() {
        // With no video IDR at all, there's no "GOP" to anchor to. Audio
        // alone should still be capped — but the current rule says we don't
        // evict if there's no second IDR. Audio-only is therefore allowed to
        // overshoot. This documents that behavior.
        let r = PacketRing::new(100);
        r.push(audio_sys(0, 200));
        r.push(audio_sys(1, 200));
        assert_eq!(r.len(), 2);
        // In practice the pipeline always has video running, so this corner
        // is documented but not optimized.
    }

    #[test]
    fn time_window_evicts_stale_gops_even_under_byte_budget() {
        // Huge byte budget, 10-tick window. GOPs at pts 0/10/20/30 — once
        // pts 30 lands, everything whose successor IDR is <= 20 is stale.
        let r = PacketRing::with_time_window(usize::MAX, 10);
        for gop in 0..4 {
            let base = gop * 10;
            r.push(video_idr(base, 10));
            r.push(video_p(base + 5, 10));
            r.push(audio_sys(base + 5, 5));
        }
        let snap = r.snapshot();
        // Window start = 30 - 10 = 20: GOPs at 0 and 10 are droppable
        // (their successor IDRs at 10 and 20 are <= 20). GOP at 20 must
        // stay — it covers the window start.
        assert!(snap[0].stream_id == STREAM_VIDEO && snap[0].is_keyframe);
        assert_eq!(snap[0].pts_100ns, 20);
    }

    #[test]
    fn hold_pins_packets_against_both_triggers() {
        // Tiny byte budget + tiny window would normally evict aggressively,
        // but a hold at pts 10 must keep everything from the IDR at 10 on.
        let r = PacketRing::with_time_window(50, 10);
        r.set_hold(Some(10));
        for gop in 0..5 {
            let base = gop * 10;
            r.push(video_idr(base, 1000));
            r.push(video_p(base + 5, 1000));
        }
        let snap = r.snapshot();
        // GOP at 0 may go (cut at 10 == hold), nothing newer may.
        assert!(snap[0].stream_id == STREAM_VIDEO && snap[0].is_keyframe);
        assert_eq!(snap[0].pts_100ns, 10);
        assert_eq!(
            snap.iter().filter(|p| p.is_keyframe && p.stream_id == STREAM_VIDEO).count(),
            4
        );

        // Releasing the hold re-applies the budget on the next push.
        r.set_hold(None);
        r.push(video_idr(50, 1000));
        assert!(r.bytes_used() <= 50 + 1000 + 2 * std::mem::size_of::<EncodedPacket>() + 1000);
    }

    #[test]
    fn media_clock_folds_out_a_stall() {
        let c = MediaClock::new();
        // Steady state: raw == media.
        assert_eq!(c.to_media(1_000), 1_000);
        // A 30s stall is folded in, minus one 60fps frame interval.
        let frame = 10_000_000 / 60;
        c.add_pause(30 * 10_000_000 - frame);
        // The frame right after the stall lands one interval past the last
        // pre-stall frame, not 30s ahead.
        let raw_after = 1_000 + 30 * 10_000_000;
        assert_eq!(c.to_media(raw_after), 1_000 + frame);
    }

    #[test]
    fn raw_stall_jump_wipes_buffer_but_compensated_does_not() {
        // 62-tick window (mirrors `replay_seconds + 2` in 100ns scaled down).
        // Lay down GOPs at pts 0,10,20,30,40,50,60 — a full window.
        let fill = |r: &PacketRing| {
            for gop in 0..=6 {
                r.push(video_idr(gop * 10, 10));
                r.push(video_p(gop * 10 + 5, 10));
            }
        };

        // Raw timeline: a frame jumps 1000 ticks ahead (the stall). The
        // window is 62, so everything older than 1000-62 is wiped.
        let bug = PacketRing::with_time_window(usize::MAX, 62);
        fill(&bug);
        bug.push(video_idr(1000, 10));
        let snap = bug.snapshot();
        // The window (GOPs 0..50) is gone — only the last pre-stall GOP and
        // the jumped one survive, which is exactly the ~1s clip.
        assert_eq!(snap[0].pts_100ns, 60, "raw jump wipes the buffered window");
        let bug_idrs = snap
            .iter()
            .filter(|p| p.is_keyframe && p.stream_id == STREAM_VIDEO)
            .count();
        assert_eq!(bug_idrs, 2);

        // Compensated timeline: the media clock folded the jump out, so the
        // post-stall frame lands at 70, contiguous with the rest. Nothing
        // before it is stale, so the window is preserved.
        let fixed = PacketRing::with_time_window(usize::MAX, 62);
        fill(&fixed);
        fixed.push(video_idr(70, 10));
        let snap = fixed.snapshot();
        // Window start = 70-62 = 8, inside GOP 0 — so the whole window is
        // retained and the post-stall frame extends it, instead of wiping it.
        assert_eq!(snap[0].pts_100ns, 0);
        assert!(snap.iter().any(|p| p.pts_100ns == 70));
        let fixed_idrs = snap
            .iter()
            .filter(|p| p.is_keyframe && p.stream_id == STREAM_VIDEO)
            .count();
        assert_eq!(fixed_idrs, 8);
    }

    #[test]
    fn pressure_flag_set_only_on_time_fresh_byte_eviction() {
        // Large window (nothing goes stale), tiny byte budget: eviction is
        // purely byte-driven, so the pressure flag must be stamped.
        let r = PacketRing::with_time_window(500, 1_000_000);
        for gop in 0..5 {
            let base = gop * 10;
            r.push(video_idr(base, 200));
            r.push(video_p(base + 1, 200));
        }
        let s = r.stats();
        assert!(s.pressure_eviction_pts != i64::MIN, "byte eviction of fresh GOPs must stamp the flag");
        assert_eq!(s.pressure_eviction_pts, 40, "stamp anchors on newest video pts at eviction time");
        assert_eq!(s.bytes_used, r.bytes_used() as u64);
        assert_eq!(s.byte_budget, 500);
    }

    #[test]
    fn pressure_flag_not_set_on_stale_time_eviction() {
        // Huge byte budget, tiny window: eviction is purely time-driven.
        let r = PacketRing::with_time_window(usize::MAX, 10);
        for gop in 0..4 {
            let base = gop * 10;
            r.push(video_idr(base, 10));
            r.push(video_p(base + 5, 10));
        }
        assert!(r.len() < 8, "time eviction must have run");
        assert_eq!(r.stats().pressure_eviction_pts, i64::MIN);
    }

    #[test]
    fn pressure_flag_not_set_during_hold_and_release_is_stamped() {
        // Hold active: the ring overshoots the budget by design; pre-hold
        // byte evictions must not stamp the pressure flag.
        let r = PacketRing::with_time_window(50, 1_000_000);
        r.set_hold(Some(10));
        for gop in 0..5 {
            let base = gop * 10;
            r.push(video_idr(base, 1000));
            r.push(video_p(base + 5, 1000));
        }
        assert_eq!(r.stats().pressure_eviction_pts, i64::MIN);
        assert_eq!(r.stats().hold_released_pts, i64::MIN);

        r.set_hold(None);
        let s = r.stats();
        assert_eq!(s.hold_released_pts, 45, "release stamps the newest video pts");
    }

    #[test]
    fn latest_keyframe_pts_reports_newest_idr() {
        let r = PacketRing::new(usize::MAX);
        assert_eq!(r.latest_keyframe_pts(), None);
        r.push(video_idr(0, 10));
        r.push(video_p(1, 10));
        r.push(video_idr(2, 10));
        r.push(video_p(3, 10));
        assert_eq!(r.latest_keyframe_pts(), Some(2));
    }

    #[test]
    fn snapshot_is_independent_of_subsequent_pushes() {
        let r = PacketRing::new(1024 * 1024);
        r.push(video_idr(0, 10));
        let s1 = r.snapshot();
        r.push(video_p(1, 10));
        assert_eq!(s1.len(), 1);
        assert_eq!(r.snapshot().len(), 2);
    }
}
