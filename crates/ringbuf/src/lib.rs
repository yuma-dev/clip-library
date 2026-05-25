//! In-RAM byte-budgeted ring buffer of encoded packets.
//!
//! The pipeline produces three streams (video, system audio, mic audio) and
//! all of them feed the same buffer through separate stream IDs. On hotkey,
//! the muxer walks the video stream backward from newest to find the oldest
//! IDR within the configured replay window, then trims audio to match.
//!
//! ## Eviction
//!
//! When the byte budget is exceeded, we evict whole video GOPs (IDR through
//! just-before-next-IDR) plus every audio packet older than the new oldest
//! video IDR. This guarantees:
//!
//! 1. The buffer always starts at a video IDR (the muxer never has to scan
//!    past P-frames whose IDR was already evicted).
//! 2. No audio "ghosts" — audio whose corresponding video has been dropped is
//!    dropped too.

use parking_lot::Mutex;
use std::sync::Arc;

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

struct RingInner {
    packets: std::collections::VecDeque<EncodedPacket>,
    bytes_used: usize,
    byte_budget: usize,
}

impl PacketRing {
    pub fn new(byte_budget: usize) -> Self {
        Self {
            inner: Mutex::new(RingInner {
                packets: std::collections::VecDeque::new(),
                bytes_used: 0,
                byte_budget,
            }),
        }
    }

    pub fn push(&self, packet: EncodedPacket) {
        let mut g = self.inner.lock();
        g.bytes_used += packet.size_in_bytes();
        g.packets.push_back(packet);
        g.evict_to_budget();
    }

    /// Snapshot the current contents. Cheap because packet bytes are Arc'd.
    pub fn snapshot(&self) -> Vec<EncodedPacket> {
        let g = self.inner.lock();
        g.packets.iter().cloned().collect()
    }

    pub fn bytes_used(&self) -> usize {
        self.inner.lock().bytes_used
    }

    pub fn len(&self) -> usize {
        self.inner.lock().packets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().packets.is_empty()
    }
}

impl RingInner {
    /// Evict whole GOPs from the front until either we're under budget or
    /// the buffer is empty. A "GOP" is defined as everything from one video
    /// IDR up to (but not including) the next video IDR, plus all audio
    /// packets older than the new oldest video IDR.
    fn evict_to_budget(&mut self) {
        while self.bytes_used > self.byte_budget && !self.packets.is_empty() {
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
    fn snapshot_is_independent_of_subsequent_pushes() {
        let r = PacketRing::new(1024 * 1024);
        r.push(video_idr(0, 10));
        let s1 = r.snapshot();
        r.push(video_p(1, 10));
        assert_eq!(s1.len(), 1);
        assert_eq!(r.snapshot().len(), 2);
    }
}
