//! Capture pipeline orchestration: [`Pipeline`] owns the ring buffer, the
//! video capture+encode thread, and per-source audio threads, live between
//! start and stop. Not its job: CLI/config, hotkey/event loop, tracing init.

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use tracing::{error, info, warn};

use clipdip_audio::{list_devices, AudioCapture, AudioDeviceInfo, AudioKind, DeviceFlow, WaveFormat};
use clipdip_capture::{CaptureBackend, Capturer};
use clipdip_encoder::{ActiveCodec, CodecPreference, EncoderConfig, NvEncoderD3D11, RateControl};
use clipdip_muxer::{mux_with_ffmpeg_cli, resolve_ffmpeg_path, AudioTrack, VideoBitstream};
use clipdip_ringbuf::{EncodedPacket, MediaClock, PacketRing, STREAM_VIDEO};

use crate::config::{
    max_bps_for_quality, AudioSource, CaptureBackendCfg, CodecPreferenceCfg, Config, RateControlCfg,
    RecordingQualityCfg,
};
use crate::filename::FilenameVars;

/// QPC time in 100-ns ticks, same clock/unit as ring packet PTS (WASAPI and
/// DXGI are both QPC-derived). Lets a save clamp exactly to the hotkey press.
pub fn qpc_now_100ns() -> i64 {
    use windows::Win32::System::Performance::{
        QueryPerformanceCounter, QueryPerformanceFrequency,
    };
    let mut counter = 0i64;
    let mut freq = 0i64;
    unsafe {
        let _ = QueryPerformanceCounter(&mut counter);
        let _ = QueryPerformanceFrequency(&mut freq);
    }
    if freq <= 0 {
        return 0;
    }
    // split to avoid overflow: counter * 1e7 can exceed i64 after ~10h uptime
    let secs = counter / freq;
    let rem = counter % freq;
    secs * 10_000_000 + rem * 10_000_000 / freq
}

/// Metadata about one running audio source, used at save time to size WAV headers.
pub struct AudioMeta {
    pub stream_id: u8,
    /// WAV sidecar filename slug (e.g. `loopback`, `mic-3a8f12c0`); stable across device renames.
    pub label: String,
    /// Track `title` metadata in the muxed MP4: WASAPI friendly name, or a kind-derived fallback.
    pub friendly_name: String,
    pub fmt: WaveFormat,
}

/// Facts about the running session once the encoder is open. Feeds the
/// telemetry heartbeat's `app` block for the GPU x encoder health matrix.
#[derive(Clone, Copy, Debug)]
pub struct SessionInfo {
    pub codec: ActiveCodec,
    /// `"wgc"` or `"dxgi"`, whichever Auto resolved to.
    pub backend: &'static str,
    pub width: u32,
    pub height: u32,
}

impl SessionInfo {
    /// Encoder slug the capture-health matrix groups on.
    pub fn encoder_slug(&self) -> &'static str {
        match self.codec {
            ActiveCodec::H264 => "nvenc_h264",
            ActiveCodec::Av1 => "nvenc_av1",
        }
    }

    /// Capture-mode slug for the same matrix.
    pub fn capture_mode_slug(&self) -> &'static str {
        match self.backend {
            "wgc" => "wgc",
            _ => "desktop_duplication",
        }
    }
}

pub struct Pipeline {
    cfg: Config,
    ring: Arc<PacketRing>,
    audio_meta: Vec<AudioMeta>,
    audio_handles: Vec<AudioCapture>,
    /// Per-source outcome of `start_audio`, for toasts/status/device-watcher.
    audio_states: Vec<AudioSourceState>,
    stop: Arc<AtomicBool>,
    video_thread: Option<JoinHandle<Result<()>>>,
    /// Only spawned when `clipdip_profile::enabled()`; drains + logs the profiler periodically.
    reporter_thread: Option<JoinHandle<()>>,
    /// Set by the video thread once NVENC opens, so the muxer picks `-f
    /// h264`/`-f av1`. `None` until then (no IDR to save yet anyway).
    active_codec: Arc<Mutex<Option<ActiveCodec>>>,
    /// Sequence header from NVENC init, prepended to the saved bitstream so
    /// ffmpeg always sees one at byte 0 even if no keyframe repeats it.
    codec_header: Arc<Mutex<Vec<u8>>>,
    /// PTS anchor of an in-progress manual recording; `Some` pins the ring
    /// against eviction past it until `stop_recording_and_save_in` consumes it.
    recording_from: Mutex<Option<i64>>,
    /// Clock folding capture stalls out of the PTS timeline; video/audio threads clone it.
    _media_clock: Arc<MediaClock>,
    /// Raw QPC of the last captured video frame (100ns ticks), 0 until the
    /// first frame. A health monitor diffs it against `qpc_now_100ns()` for a stall.
    frame_liveness: Arc<AtomicI64>,
    /// Set once if the video thread dies, so a supervisor reacts immediately
    /// instead of waiting for shutdown join (used to be silent for 15s).
    video_error: Arc<Mutex<Option<String>>>,
    /// Current video-loop stage (see [`capture_phase`]); pins down which GPU
    /// call hung if frame production wedges.
    capture_phase: Arc<AtomicU8>,
    /// QP to run at now (H.264 scale), or [`QP_BOOST_OFF`] for base quality.
    /// Video thread polls once per frame and reconfigures NVENC on change.
    recording_qp_boost: Arc<AtomicU32>,
    /// Set once the encoder opens (see [`SessionInfo`]); `None` if init failed.
    session_info: Arc<Mutex<Option<SessionInfo>>>,
}

/// Sentinel: no QP boost, run at the configured base rate control.
const QP_BOOST_OFF: u32 = u32::MAX;

/// Stage values for [`Pipeline::capture_phase`]; a watchdog reads this to
/// report where the loop is stuck when frames stop.
pub mod capture_phase {
    pub const SLEEP: u8 = 0;
    pub const ACQUIRE: u8 = 1;
    pub const ENCODE: u8 = 2;
    pub const PUSH: u8 = 3;

    pub fn name(v: u8) -> &'static str {
        match v {
            SLEEP => "sleep",
            ACQUIRE => "acquire_frame",
            ENCODE => "encode_frame",
            PUSH => "ring_push",
            _ => "unknown",
        }
    }
}

impl Pipeline {
    /// Spawn one WASAPI thread per `cfg.audio.sources` entry plus the video
    /// thread. Failed audio sources are logged + skipped; a failed video thread aborts.
    pub fn start(cfg: Config) -> Result<Self> {
        let byte_budget = cfg.ring_byte_budget();
        info!(
            window_secs = cfg.replay_seconds,
            budget_mb = byte_budget / 1_000_000,
            sizing = if cfg.memory.max_ring_mb > 0 { "manual" } else { "auto" },
            "ring buffer sized"
        );
        let ring = Arc::new(PacketRing::with_time_window(
            byte_budget,
            cfg.ring_time_window_100ns(),
        ));

        // shared clock keeps audio/video on one gap-free timebase across a stall
        let media_clock = Arc::new(MediaClock::new());

        let (audio_meta, audio_handles, audio_states) =
            start_audio(&cfg, Arc::clone(&ring), Arc::clone(&media_clock));

        let stop = Arc::new(AtomicBool::new(false));
        let active_codec: Arc<Mutex<Option<ActiveCodec>>> = Arc::new(Mutex::new(None));
        let codec_header: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let frame_liveness = Arc::new(AtomicI64::new(0));
        let video_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let capture_phase = Arc::new(AtomicU8::new(capture_phase::SLEEP));
        let recording_qp_boost = Arc::new(AtomicU32::new(QP_BOOST_OFF));
        let session_info: Arc<Mutex<Option<SessionInfo>>> = Arc::new(Mutex::new(None));
        let video_thread = spawn_video_thread(
            cfg.clone(),
            Arc::clone(&ring),
            Arc::clone(&stop),
            Arc::clone(&active_codec),
            Arc::clone(&codec_header),
            Arc::clone(&media_clock),
            Arc::clone(&frame_liveness),
            Arc::clone(&capture_phase),
            Arc::clone(&recording_qp_boost),
            Arc::clone(&video_error),
            Arc::clone(&session_info),
        )?;

        let reporter_thread = if clipdip_profile::enabled() {
            Some(spawn_reporter(
                Arc::clone(&stop),
                cfg.profile.report_interval_ms,
            )?)
        } else {
            None
        };

        Ok(Self {
            cfg,
            ring,
            audio_meta,
            audio_handles,
            audio_states,
            stop,
            video_thread: Some(video_thread),
            reporter_thread,
            active_codec,
            codec_header,
            recording_from: Mutex::new(None),
            _media_clock: media_clock,
            frame_liveness,
            video_error,
            capture_phase,
            recording_qp_boost,
            session_info,
        })
    }

    /// Facts about the live capture session, once the encoder is open.
    pub fn session_info(&self) -> Option<SessionInfo> {
        *self.session_info.lock().unwrap()
    }

    /// Shared handle for a watcher thread to observe without borrowing the pipeline.
    pub fn session_info_handle(&self) -> Arc<Mutex<Option<SessionInfo>>> {
        Arc::clone(&self.session_info)
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    /// Per-source status: wanted vs actually-recording vs fallback rank.
    /// Liveness is checked at call time, so a vanished device reads as silent here.
    pub fn audio_states(&self) -> Vec<AudioSourceState> {
        self.audio_states
            .iter()
            .cloned()
            .map(|mut st| {
                let dead = st
                    .handle_idx
                    .map_or(true, |h| self.audio_handles.get(h).map_or(true, |c| c.is_finished()));
                if dead {
                    st.using_label = None;
                    st.using_id = None;
                    st.rank = None;
                }
                st
            })
            .collect()
    }

    /// Shared handle for the settings UI's file-size estimate.
    pub fn ring(&self) -> Arc<PacketRing> {
        Arc::clone(&self.ring)
    }

    /// Raw QPC (100ns ticks) of the last captured frame, 0 until the first.
    /// A health monitor diffs against `qpc_now_100ns()` to detect a stall.
    pub fn frame_liveness(&self) -> Arc<AtomicI64> {
        Arc::clone(&self.frame_liveness)
    }

    /// Error the video thread died with, if any; polled so a monitor can
    /// restart immediately instead of only at shutdown join.
    pub fn video_error(&self) -> Arc<Mutex<Option<String>>> {
        Arc::clone(&self.video_error)
    }

    /// Current video-loop stage, for a watchdog to report which call wedged.
    pub fn capture_phase(&self) -> Arc<AtomicU8> {
        Arc::clone(&self.capture_phase)
    }

    /// Snapshot the ring, trim to the oldest video IDR, write `.h264` +
    /// per-source `.wav` sidecars, mux to MP4. Returns the saved path.
    pub fn save_clip(&self) -> Result<PathBuf> {
        self.save_clip_in(None, &FilenameVars::default())
    }

    /// Like [`save_clip`] but to `directory_override`, so a directory config
    /// change applies without a restart. Filename from `output.filename_stem` expanded + deduped.
    pub fn save_clip_in(
        &self,
        directory_override: Option<&std::path::Path>,
        vars: &FilenameVars,
    ) -> Result<PathBuf> {
        let codec = *self.active_codec.lock().unwrap();
        let header = self.codec_header.lock().unwrap().clone();
        let mut cfg_ref = std::borrow::Cow::Borrowed(&self.cfg);
        if let Some(dir) = directory_override {
            if dir != self.cfg.output.directory.as_path() {
                let mut cloned = self.cfg.clone();
                cloned.output.directory = dir.to_path_buf();
                cfg_ref = std::borrow::Cow::Owned(cloned);
            }
        }
        let stem = crate::filename::unique_stem(
            &cfg_ref.output.directory,
            &crate::filename::expand(&cfg_ref.output.filename_stem, vars),
        );
        save_clip_with_stem(
            &self.ring,
            &cfg_ref,
            &self.audio_meta,
            &stem,
            codec,
            &header,
            None,
        )
    }

    /// Pin the ring against eviction from the newest buffered IDR onward.
    /// Errors if already recording. Memory grows with length until saved.
    pub fn start_recording(&self) -> Result<()> {
        let mut rec = self.recording_from.lock().unwrap();
        if rec.is_some() {
            return Err(anyhow!("recording already in progress"));
        }
        // anchor at the latest IDR, not "now", so it's decodable from frame 1
        let anchor = self
            .ring
            .latest_keyframe_pts()
            .ok_or_else(|| anyhow!("no video in buffer yet — wait ~1s after start and retry"))?;
        self.ring.set_hold(Some(anchor));
        *rec = Some(anchor);
        // boost quality for the recording; CQP modes only, never worse than
        // clip quality; the pre-anchor GOP stays at clip quality
        if let (
            RateControlCfg::ConstantQp { qp },
            RecordingQualityCfg::ConstantQp { qp: rec_qp },
        ) = (self.cfg.video.rate_control, self.cfg.video.recording_quality)
        {
            if rec_qp < qp {
                self.recording_qp_boost.store(rec_qp, Ordering::Relaxed);
                info!(clip_qp = qp, recording_qp = rec_qp, "recording quality boost requested");
            }
        }
        info!(anchor_pts_100ns = anchor, "manual recording started");
        Ok(())
    }

    pub fn is_recording(&self) -> bool {
        self.recording_from.lock().unwrap().is_some()
    }

    /// End a manual recording and save since the start anchor. Releases the
    /// ring hold whether or not the save succeeds.
    pub fn stop_recording_and_save_in(
        &self,
        directory_override: Option<&std::path::Path>,
        vars: &FilenameVars,
    ) -> Result<PathBuf> {
        let anchor = self
            .recording_from
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| anyhow!("no recording in progress"))?;

        // reconfigure only affects future frames; already-buffered stays boosted for this save
        self.recording_qp_boost
            .store(QP_BOOST_OFF, Ordering::Relaxed);

        let codec = *self.active_codec.lock().unwrap();
        let header = self.codec_header.lock().unwrap().clone();
        let mut cfg_ref = std::borrow::Cow::Borrowed(&self.cfg);
        if let Some(dir) = directory_override {
            if dir != self.cfg.output.directory.as_path() {
                let mut cloned = self.cfg.clone();
                cloned.output.directory = dir.to_path_buf();
                cfg_ref = std::borrow::Cow::Owned(cloned);
            }
        }
        let stem = crate::filename::unique_stem(
            &cfg_ref.output.directory,
            &crate::filename::expand(&cfg_ref.output.filename_stem, vars),
        );
        let result = save_clip_with_stem(
            &self.ring,
            &cfg_ref,
            &self.audio_meta,
            &stem,
            codec,
            &header,
            Some(anchor),
        );
        // hold released only after save_clip_with_stem's synchronous snapshot
        self.ring.set_hold(None);
        result
    }

    /// Like [`save_clip`] but to a fixed `{stem}.mp4`, overwriting; used by
    /// smoke tests that want a stable path instead of a new one every run.
    pub fn save_clip_as(&self, stem: &str) -> Result<PathBuf> {
        let codec = *self.active_codec.lock().unwrap();
        let header = self.codec_header.lock().unwrap().clone();
        save_clip_with_stem(
            &self.ring,
            &self.cfg,
            &self.audio_meta,
            stem,
            codec,
            &header,
            None,
        )
    }

    /// Stop the video thread, join it, then drop audio handles (each
    /// `AudioCapture::Drop` signals + joins its own thread).
    pub fn stop(mut self) -> Result<()> {
        self.stop_in_place()
    }

    fn stop_in_place(&mut self) -> Result<()> {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.video_thread.take() {
            match handle.join() {
                Ok(Ok(())) => {}
                Ok(Err(e)) => warn!("video thread error: {e:#}"),
                Err(_) => warn!("video thread panicked"),
            }
        }
        if let Some(handle) = self.reporter_thread.take() {
            let _ = handle.join();
        }
        // dropping the Vec drops each AudioCapture, whose Drop joins
        self.audio_handles.clear();
        Ok(())
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        // best-effort if the caller forgot stop(); stop() is preferred, it propagates join errors
        if self.video_thread.is_some() {
            let _ = self.stop_in_place();
        }
    }
}

/// One audio source's state after `start_audio`. The app layer diffs these
/// across restarts to decide what to tell the user; the device watcher uses them too.
#[derive(Clone, Debug)]
pub struct AudioSourceState {
    /// Position in `cfg.audio.sources`.
    pub index: usize,
    pub kind: AudioKind,
    /// Primary choice's display name, or "System default".
    pub wanted_label: String,
    /// The primary pin; `None` = system default.
    pub primary_id: Option<String>,
    /// Friendly name saved with the pin, so a re-enumerated endpoint can be found by name.
    pub primary_name: Option<String>,
    /// What the config should say about the pin after this start: the endpoint id
    /// actually opened plus its friendly name. Set when the id was remapped or the
    /// name was never saved; the app layer writes it back so the pin survives the next id churn.
    pub pin_repair: Option<PinRepair>,
    /// Configured fallback entries in priority order (may hold the `"default"` sentinel).
    pub fallback_ids: Vec<String>,
    /// Friendly name of what's actually recording; `None` = silent.
    pub using_label: Option<String>,
    /// WASAPI id of the endpoint actually opened.
    pub using_id: Option<String>,
    /// 0 = primary, 1.. = fallback position.
    pub rank: Option<usize>,
    /// Position in `Pipeline::audio_handles`, for the liveness overlay.
    handle_idx: Option<usize>,
}

impl AudioSourceState {
    /// Recording something, but not the primary choice.
    pub fn on_fallback(&self) -> bool {
        matches!(self.rank, Some(r) if r > 0)
    }

    /// Not recording at all.
    pub fn silent(&self) -> bool {
        self.rank.is_none()
    }
}

/// Pinned endpoint as it should be stored after a start (see `AudioSourceState::pin_repair`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinRepair {
    pub device_id: String,
    pub device_name: String,
}

/// Finds a pinned endpoint among the active devices: by id first, then by the
/// saved friendly name when the id is gone. Windows hands a usb mic a fresh
/// endpoint id after a port change or driver reinstall, and the name is the
/// only thing that survives that. A name shared by two endpoints of the same
/// flow is ambiguous and stays unresolved rather than picking the wrong one.
pub fn resolve_pinned_device<'a>(
    kind: AudioKind,
    device_id: &str,
    device_name: Option<&str>,
    devices: &'a [AudioDeviceInfo],
) -> Option<&'a AudioDeviceInfo> {
    if let Some(d) = devices.iter().find(|d| d.id == device_id) {
        return Some(d);
    }
    let name = device_name?;
    let flow = match kind {
        AudioKind::SystemLoopback => DeviceFlow::Render,
        AudioKind::Microphone => DeviceFlow::Capture,
    };
    let mut by_name = devices.iter().filter(|d| d.flow == flow && d.friendly_name == name);
    let first = by_name.next()?;
    if by_name.next().is_some() {
        return None;
    }
    Some(first)
}

/// Per-kind gate key so a missing mic doesn't suppress a missing-loopback report (or vice versa).
fn kind_gate_key(base: &'static str, kind: AudioKind) -> String {
    let k = match kind {
        AudioKind::SystemLoopback => "loopback",
        AudioKind::Microphone => "mic",
    };
    format!("{base}.{k}")
}

fn start_audio(
    cfg: &Config,
    ring: Arc<PacketRing>,
    clock: Arc<MediaClock>,
) -> (Vec<AudioMeta>, Vec<AudioCapture>, Vec<AudioSourceState>) {
    // enumerate once for friendly names (MP4 track titles); empty on failure, capture still works
    let devices = list_devices().unwrap_or_else(|e| {
        warn!("list_devices failed, audio track titles will use fallback: {e:#}");
        Vec::new()
    });

    let mut meta = Vec::new();
    let mut handles = Vec::new();
    let mut states = Vec::new();
    for (idx, source) in cfg.audio.sources.iter().enumerate() {
        let stream_id = (idx + 1) as u8; // stream 0 is video
        let label = source.label();
        let configured_id = source.device_id().map(str::to_string);
        let configured_name = source.device_name().map(str::to_string);
        let kind = match source {
            AudioSource::SystemLoopback { .. } => AudioKind::SystemLoopback,
            AudioSource::Microphone { .. } => AudioKind::Microphone,
            AudioSource::ProcessLoopback { process_name } => {
                warn!(process = %process_name, "process loopback not implemented — skipping");
                continue;
            }
        };
        // a pin whose id is gone but whose name is back gets opened under the new id
        let remapped = configured_id.as_deref().and_then(|id| {
            resolve_pinned_device(kind, id, configured_name.as_deref(), &devices)
                .filter(|d| d.id != id)
                .map(|d| d.id.clone())
        });
        let device_id = remapped.clone().or_else(|| configured_id.clone());
        if let Some(new_id) = &remapped {
            info!(?kind, %label, "pinned device found under a new endpoint id, using it");
            if let clipdip_diagnostics::Gate::Send { .. } = clipdip_diagnostics::gate(
                &kind_gate_key("audio_pinned_device_remapped", kind),
                Duration::from_secs(900),
            ) {
                clipdip_diagnostics::report_custom(
                    "audio_pinned_device_remapped",
                    clipdip_diagnostics::Severity::Info,
                    format!("pinned audio device re-enumerated under a new id ({kind:?})"),
                    Some(serde_json::json!({
                        "audio_kind": format!("{kind:?}"),
                        "new_id_is_default": devices.iter().any(|d| &d.id == new_id && d.is_default),
                    })),
                );
            }
        }
        let resolved_name = resolve_friendly_name(kind, device_id.as_deref(), &devices);
        // pinned device id no longer enumerates = "your saved mic is gone"
        let pinned_missing = device_id.is_some() && resolved_name.is_none() && !devices.is_empty();
        let want_flow = match kind {
            AudioKind::SystemLoopback => DeviceFlow::Render,
            AudioKind::Microphone => DeviceFlow::Capture,
        };
        if pinned_missing {
            if let clipdip_diagnostics::Gate::Send { .. } = clipdip_diagnostics::gate(
                &kind_gate_key("audio_pinned_device_missing", kind),
                Duration::from_secs(900),
            ) {
                // kind is in the message on purpose: server groups issues by message template
                clipdip_diagnostics::report_error_with(
                    "audio_pinned_device_missing",
                    clipdip_diagnostics::Severity::Warning,
                    format!("pinned audio device not found among enumerated endpoints ({kind:?})"),
                    Some(serde_json::json!({
                        "audio_kind": format!("{kind:?}"),
                        "is_default_available": devices
                            .iter()
                            .any(|d| d.flow == want_flow && d.is_default),
                        "fallbacks_configured": source.fallbacks().len(),
                        "name_saved": configured_name.is_some(),
                    })),
                );
            }
        }

        // primary first, then fallbacks ("default" sentinel = unpinned start); deduped
        let mut candidates: Vec<Option<String>> = vec![device_id.clone()];
        for fb in source.fallbacks() {
            let cand = if fb == crate::config::DEFAULT_DEVICE_SENTINEL {
                None
            } else {
                Some(fb.clone())
            };
            if !candidates.contains(&cand) {
                candidates.push(cand);
            }
        }

        let pinned = device_id.is_some();
        let wanted_label = resolved_name.clone().unwrap_or_else(|| match &device_id {
            Some(_) => "(disconnected device)".to_string(),
            None => "System default".to_string(),
        });

        let mut started: Option<(AudioCapture, usize)> = None;
        let mut primary_err: Option<String> = None;
        for (rank, cand) in candidates.iter().enumerate() {
            match AudioCapture::start(
                kind,
                stream_id,
                cand.clone(),
                Arc::clone(&ring),
                Arc::clone(&clock),
            ) {
                Ok(cap) => {
                    started = Some((cap, rank));
                    break;
                }
                Err(e) => {
                    warn!(?kind, rank, "failed to start audio source: {e:#}");
                    if rank == 0 {
                        primary_err = Some(format!("{e:#}"));
                    }
                }
            }
        }

        let mut state = AudioSourceState {
            index: idx,
            kind,
            wanted_label,
            primary_id: configured_id.clone(),
            primary_name: configured_name.clone(),
            pin_repair: None,
            fallback_ids: source.fallbacks().to_vec(),
            using_label: None,
            using_id: None,
            rank: None,
            handle_idx: None,
        };

        match started {
            Some((cap, rank)) => {
                let fmt = cap.format();
                let used_id = cap.device_id_in_use().to_string();
                // name of what actually opened, not the primary's name if this is a fallback
                let friendly_name = devices
                    .iter()
                    .find(|d| d.id == used_id)
                    .map(|d| d.friendly_name.clone())
                    .or_else(|| if rank == 0 { resolved_name.clone() } else { None })
                    .unwrap_or_else(|| fallback_friendly_name(kind));
                info!(stream_id, %label, %friendly_name, rank, ?fmt, "audio source started");
                if rank > 0 {
                    // message carries kind for grouping; ids left out, the chain can embed device-id strings
                    clipdip_diagnostics::report_error_with(
                        "audio_source_fallback_used",
                        clipdip_diagnostics::Severity::Warning,
                        format!("audio source started on fallback ({kind:?})"),
                        Some(serde_json::json!({
                            "audio_kind": format!("{kind:?}"),
                            "rank": rank,
                            "used_default": candidates[rank].is_none(),
                            "primary_hresult": primary_err
                                .as_deref()
                                .map(extract_hresult),
                        })),
                    );
                }
                // a pinned primary that opened teaches the config its current id + name; the
                // name only comes from enumeration, a made-up fallback name must not be saved
                if rank == 0 && pinned && devices.iter().any(|d| d.id == used_id) {
                    let repair = PinRepair {
                        device_id: used_id.clone(),
                        device_name: friendly_name.clone(),
                    };
                    let stored = configured_id.as_deref() == Some(repair.device_id.as_str())
                        && configured_name.as_deref() == Some(repair.device_name.as_str());
                    if !stored {
                        state.pin_repair = Some(repair);
                    }
                }
                state.using_label = Some(friendly_name.clone());
                state.using_id = Some(used_id);
                state.rank = Some(rank);
                state.handle_idx = Some(handles.len());
                meta.push(AudioMeta {
                    stream_id,
                    label,
                    friendly_name,
                    fmt,
                });
                handles.push(cap);
            }
            None => {
                // nothing in the chain started; message carries kind + hresult, no ids
                let hresult = primary_err.as_deref().map(extract_hresult).unwrap_or_else(|| "no_hresult".into());
                clipdip_diagnostics::report_error(
                    "audio_source_start_failed",
                    format!("audio source failed to start ({kind:?}, {hresult})"),
                    Some(serde_json::json!({
                        "audio_kind": format!("{kind:?}"),
                        "pinned": pinned,
                        "hresult": hresult,
                        "candidates_tried": candidates.len(),
                    })),
                );
            }
        }
        states.push(state);
    }
    (meta, handles, states)
}

/// Pull the first `0x8....` HRESULT-looking token from an error chain, so
/// events group by code without carrying free text (may embed device ids).
fn extract_hresult(chain: &str) -> String {
    let lower = chain.to_ascii_lowercase();
    if let Some(pos) = lower.find("0x8") {
        let token: String = lower[pos..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == 'x')
            .take(10)
            .collect();
        token
    } else {
        "no_hresult".to_string()
    }
}

fn resolve_friendly_name(
    kind: AudioKind,
    device_id: Option<&str>,
    devices: &[AudioDeviceInfo],
) -> Option<String> {
    let want_flow = match kind {
        AudioKind::SystemLoopback => DeviceFlow::Render,
        AudioKind::Microphone => DeviceFlow::Capture,
    };
    match device_id {
        Some(id) => devices
            .iter()
            .find(|d| d.id == id)
            .map(|d| d.friendly_name.clone()),
        None => devices
            .iter()
            .find(|d| d.flow == want_flow && d.is_default)
            .map(|d| d.friendly_name.clone()),
    }
}

fn fallback_friendly_name(kind: AudioKind) -> String {
    match kind {
        AudioKind::SystemLoopback => "System Audio".into(),
        AudioKind::Microphone => "Microphone".into(),
    }
}

fn spawn_reporter(stop: Arc<AtomicBool>, interval_ms: u64) -> Result<JoinHandle<()>> {
    // drain the first window (init noise) so the first logged line reflects steady state
    let _ = clipdip_profile::report();
    let interval = Duration::from_millis(interval_ms.max(500));
    std::thread::Builder::new()
        .name("clipdip-profile".into())
        .spawn(move || {
            // small slices so Ctrl+C doesn't wait for a full window
            let slice = Duration::from_millis(100);
            let mut elapsed = Duration::ZERO;
            while !stop.load(Ordering::Relaxed) {
                std::thread::sleep(slice);
                elapsed += slice;
                if elapsed >= interval {
                    elapsed = Duration::ZERO;
                    let rep = clipdip_profile::report();
                    if !rep.stages.is_empty() || rep.cpu_cores_busy.is_some() {
                        info!("{}", clipdip_profile::format_report(&rep));
                    }
                }
            }
            // last drain so partial-window data isn't lost
            let rep = clipdip_profile::report();
            if !rep.stages.is_empty() {
                info!("{}", clipdip_profile::format_report(&rep));
            }
        })
        .context("spawn profile reporter thread")
}

#[allow(clippy::too_many_arguments)]
fn spawn_video_thread(
    cfg: Config,
    ring: Arc<PacketRing>,
    stop: Arc<AtomicBool>,
    active_codec: Arc<Mutex<Option<ActiveCodec>>>,
    codec_header: Arc<Mutex<Vec<u8>>>,
    media_clock: Arc<MediaClock>,
    frame_liveness: Arc<AtomicI64>,
    capture_phase: Arc<AtomicU8>,
    recording_qp_boost: Arc<AtomicU32>,
    video_error: Arc<Mutex<Option<String>>>,
    session_info: Arc<Mutex<Option<SessionInfo>>>,
) -> Result<JoinHandle<Result<()>>> {
    std::thread::Builder::new()
        .name("clipdip-video".into())
        .spawn(move || {
            let result = video_loop(
                cfg,
                ring,
                stop,
                active_codec,
                codec_header,
                media_clock,
                frame_liveness,
                capture_phase,
                recording_qp_boost,
                session_info,
            );
            if let Err(e) = &result {
                // surface now: a silently dead capture thread once recorded desktop wallpaper for 2h
                error!("video capture thread exited with error: {e:#}");
                *video_error.lock().unwrap() = Some(format!("{e:#}"));
            }
            result
        })
        .context("spawn video capture thread")
}

/// Bucket an NVENC init failure into a stable cause slug for the dashboard.
/// String-matches our crates' error text; brittle, `other` is the safe default.
fn classify_encoder_error(chain: &str) -> &'static str {
    let c = chain.to_ascii_lowercase();
    if c.contains("nvencodeapi64") && (c.contains("load") || c.contains("not found") || c.contains("module")) {
        "nvenc_dll_load_failed"
    } else if c.contains("driver too old") || c.contains("driver does not support") {
        "nvenc_driver_too_old"
    } else if c.contains("open") && c.contains("session") && c.contains("10") {
        // NV_ENC_ERR_OUT_OF_MEMORY on open = concurrent-session limit (OBS/ShadowPlay/Discord)
        "nvenc_session_limit"
    } else if c.contains("openencodesession") || (c.contains("open") && c.contains("session")) {
        "nvenc_open_session_failed"
    } else if c.contains("status 8") || c.contains("status 12") || c.contains("unsupported_param") || c.contains("invalid_param") {
        "nvenc_unsupported_param"
    } else if c.contains("does not support") && (c.contains("h.264") || c.contains("av1") || c.contains("codec")) {
        "codec_forced_unavailable"
    } else {
        "other"
    }
}

/// Same idea, for capturer creation failures.
fn classify_capture_error(chain: &str) -> &'static str {
    let c = chain.to_ascii_lowercase();
    if c.contains("enumoutputs") || c.contains("output index") || c.contains("get output") {
        "dxgi_output_not_found"
    } else if c.contains("duplicateoutput") || c.contains("duplicate output") {
        "dxgi_duplicate_output_failed"
    } else if c.contains("not supported on this windows build") || c.contains("issupported") {
        "wgc_unsupported_os"
    } else if c.contains("d3d11createdevice") || c.contains("create d3d11") {
        "d3d11_device_create_failed"
    } else {
        "other"
    }
}

/// acquire_frame slow = DXGI/GPU; encode_frame slow = NVENC; neither but stalled = descheduled.
fn warn_if_slow(stage: &str, elapsed: Duration) {
    const SLOW_MS: u128 = 250;
    let ms = elapsed.as_millis();
    if ms >= SLOW_MS {
        warn!(stage, ms, "video loop stage blocked unusually long");
    }
}

#[allow(clippy::too_many_arguments)]
fn video_loop(
    cfg: Config,
    ring: Arc<PacketRing>,
    stop: Arc<AtomicBool>,
    active_codec: Arc<Mutex<Option<ActiveCodec>>>,
    codec_header: Arc<Mutex<Vec<u8>>>,
    media_clock: Arc<MediaClock>,
    frame_liveness: Arc<AtomicI64>,
    capture_phase: Arc<AtomicU8>,
    recording_qp_boost: Arc<AtomicU32>,
    session_info: Arc<Mutex<Option<SessionInfo>>>,
) -> Result<()> {
    let backend = match cfg.video.capture_backend {
        CaptureBackendCfg::Auto => CaptureBackend::Auto,
        CaptureBackendCfg::Wgc => CaptureBackend::Wgc,
        CaptureBackendCfg::Dxgi => CaptureBackend::Dxgi,
    };
    let backend_cfg_name = match cfg.video.capture_backend {
        CaptureBackendCfg::Auto => "auto",
        CaptureBackendCfg::Wgc => "wgc",
        CaptureBackendCfg::Dxgi => "dxgi",
    };

    /// Quality caps are referenced to 1440p60; scale to actual pixel rate.
    /// Clamped to [0.25, 4] against degenerate resolutions/framerates.
    fn scale_cap_to_pixel_rate(reference_bps: u32, w: u32, h: u32, fps: u32) -> u32 {
        const REF_PIXEL_RATE: f64 = 2560.0 * 1440.0 * 60.0;
        let rate = w as f64 * h as f64 * fps.max(1) as f64;
        (reference_bps as f64 * (rate / REF_PIXEL_RATE).clamp(0.25, 4.0)) as u32
    }
    let (mut dup, device, context) = Capturer::create(
        backend,
        cfg.video.output_index,
        cfg.video.include_cursor,
    )
    .inspect_err(|e| {
        let chain = format!("{e:#}");
        if let clipdip_diagnostics::Gate::Send { .. } =
            clipdip_diagnostics::gate("capturer_create_failed", Duration::from_secs(60))
        {
            clipdip_diagnostics::report_capture_failure(
                "capturer_create_failed",
                format!("capturer create failed ({}): {chain}", classify_capture_error(&chain)),
                serde_json::json!({
                    "backend_cfg": backend_cfg_name,
                    "output_index": cfg.video.output_index,
                    "cause": classify_capture_error(&chain),
                }),
            );
        }
    })
    .with_context(|| {
        format!(
            "create D3D11 device + capturer on output {} \
             (run `clipdip --list-outputs` to see valid indices)",
            cfg.video.output_index
        )
    })?;
    let (w, h) = (dup.width(), dup.height());

    let codec_preference = match cfg.video.codec {
        CodecPreferenceCfg::PreferAv1 => CodecPreference::PreferAv1,
        CodecPreferenceCfg::ForceH264 => CodecPreference::ForceH264,
        CodecPreferenceCfg::ForceAv1 => CodecPreference::ForceAv1,
    };
    let rate_control = match cfg.video.rate_control {
        // CQP capped by default against runaway scenes (issue #4: 98 Mbps at QP 26); 0 = uncapped
        RateControlCfg::ConstantQp { qp } => match cfg.video.quality_cap_bps {
            Some(0) => RateControl::ConstantQp { qp },
            cap => RateControl::CappedQuality {
                cq: qp,
                max_bps: scale_cap_to_pixel_rate(
                    cap.unwrap_or_else(|| max_bps_for_quality(qp)),
                    w,
                    h,
                    cfg.video.fps,
                ),
            },
        },
        RateControlCfg::Vbr { avg_bps } => RateControl::Vbr { avg_bps },
    };

    let gop_length = (cfg.video.fps as f32 * cfg.video.gop_seconds).round() as u32;
    let mut encoder = NvEncoderD3D11::new(
        device.clone(),
        EncoderConfig {
            width: w,
            height: h,
            fps_num: cfg.video.fps,
            fps_den: 1,
            gop_length,
            codec_preference,
            rate_control,
        },
    )
    .inspect_err(|e| {
        let chain = format!("{e:#}");
        let cause = classify_encoder_error(&chain);
        if let clipdip_diagnostics::Gate::Send { .. } = clipdip_diagnostics::gate(
            &format!("encoder_init_failed:{cause}"),
            Duration::from_secs(60),
        ) {
            clipdip_diagnostics::report_capture_failure(
                "encoder_init_failed",
                format!("NVENC init failed ({cause}): {chain}"),
                serde_json::json!({
                    "cause": cause,
                    "width": w,
                    "height": h,
                    "fps": cfg.video.fps,
                    "gop_length": gop_length,
                    "codec_pref": format!("{:?}", cfg.video.codec),
                }),
            );
        }
    })
    .context("init NVENC encoder")?;

    let codec_now = encoder.active_codec();
    *active_codec.lock().unwrap() = Some(codec_now);
    *session_info.lock().unwrap() = Some(SessionInfo {
        codec: codec_now,
        backend: dup.backend_name(),
        width: w,
        height: h,
    });
    let header_bytes = encoder.header().to_vec();
    let header_len = header_bytes.len();
    *codec_header.lock().unwrap() = header_bytes;
    info!(
        codec = ?codec_now,
        header_bytes = header_len,
        "NVENC session opened"
    );

    let frame_interval = Duration::from_secs_f64(1.0 / cfg.video.fps as f64);
    let frame_interval_100ns = (10_000_000 / cfg.video.fps.max(1) as i64).max(1);
    // above this = real capture stall, not a busy-frame hiccup; DXGI can legitimately stall ~200ms
    let stall_threshold_100ns = (frame_interval_100ns * 8).max(5_000_000);
    let mut next_at = Instant::now();
    let mut frames: u32 = 0;
    // last PTS handed to the encoder, kept strictly monotonic; QPC-stamped so video/audio share a timebase
    let mut last_emitted_pts: i64 = 0;
    // last raw (uncompensated) QPC reading, for stall detection
    let mut last_raw_pts: Option<i64> = None;
    // applied QP override (None = base); only reconfigures NVENC when the target actually changes
    let mut applied_qp_boost: Option<u32> = None;

    info!(
        width = w,
        height = h,
        fps = cfg.video.fps,
        gop_seconds = cfg.video.gop_seconds,
        bitrate_bps = cfg.video.bitrate_bps,
        include_cursor = cfg.video.include_cursor,
        "video capture running"
    );

    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now < next_at {
            std::thread::sleep(next_at - now);
        }
        // clamp so idle time doesn't leave next_at far in the past, else resuming activity
        // would burst-encode at the hardware ceiling until it catches up
        next_at = next_at.max(now) + frame_interval;

        let _t_frame = clipdip_profile::start("pipeline.video_frame");

        // reconfigure keeps the NVENC session intact and forces an IDR, so quality
        // changes start on a clean GOP boundary within one frame of the hotkey
        let boost = recording_qp_boost.load(Ordering::Relaxed);
        let target = if boost == QP_BOOST_OFF { None } else { Some(boost) };
        if target != applied_qp_boost {
            // rebuild from the same variant the session opened with; NVENC can't switch
            // rate-control mode live
            let new_rc = match rate_control {
                RateControl::ConstantQp { qp: base_qp } => {
                    Some(RateControl::ConstantQp { qp: target.unwrap_or(base_qp) })
                }
                RateControl::CappedQuality { cq: base_cq, max_bps } => {
                    // raise the ceiling 1.5x too while boosted, else the clip-tier cap pins recordings
                    Some(match target {
                        Some(cq) => RateControl::CappedQuality {
                            cq,
                            max_bps: max_bps.saturating_add(max_bps / 2),
                        },
                        None => RateControl::CappedQuality { cq: base_cq, max_bps },
                    })
                }
                RateControl::Vbr { .. } => None,
            };
            // rc is the pre-derate request; encoder logs the effective config itself on success
            if let Some(rc) = new_rc {
                match encoder.reconfigure_rate_control(rc) {
                    Ok(()) => {
                        info!(?rc, boosted = target.is_some(), "encoder quality reconfigure requested")
                    }
                    Err(e) => warn!(
                        ?rc,
                        "encoder quality reconfigure failed — recording continues at \
                         the previous quality: {e:#}"
                    ),
                }
            }
            // mark handled even on failure, else we hammer the driver every frame
            applied_qp_boost = target;
        }

        // timeout=0: DXGI returns immediately (fresh frame or TIMEOUT, re-emitting the last
        // texture for CFR); a nonzero timeout blocked static-desktop capture to ~5fps
        let t_acq = Instant::now();
        capture_phase.store(capture_phase::ACQUIRE, Ordering::Relaxed);
        let acquired = match dup.acquire_frame(0) {
            Ok(a) => a,
            Err(e) => {
                // ACCESS_LOST (mode switch/HDR toggle/monitor replug) or WGC item close;
                // rebuild on the same device, NVENC session stays open. Used to die silently here.
                error!(
                    backend = dup.backend_name(),
                    "capture failed: {e:#} — rebuilding capturer"
                );
                let rebuild_started = Instant::now();
                let mut rebuilt = None;
                for attempt in 1..=120u32 {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                    match Capturer::with_device(
                        device.clone(),
                        context.clone(),
                        backend,
                        cfg.video.output_index,
                        cfg.video.include_cursor,
                    ) {
                        Ok(c) => {
                            if (c.width(), c.height()) != (w, h) {
                                if let clipdip_diagnostics::Gate::Send { .. } = clipdip_diagnostics::gate(
                                    "capture_size_changed",
                                    Duration::from_secs(60),
                                ) {
                                    clipdip_diagnostics::report_capture_failure_with(
                                        "capture_size_changed",
                                        clipdip_diagnostics::Severity::Warning,
                                        format!(
                                            "display mode changed {}x{} -> {}x{} — pipeline restart required",
                                            w, h, c.width(), c.height()
                                        ),
                                        serde_json::json!({
                                            "old_w": w, "old_h": h,
                                            "new_w": c.width(), "new_h": c.height(),
                                            "backend": c.backend_name(),
                                            "output_index": cfg.video.output_index,
                                        }),
                                    );
                                }
                                return Err(anyhow!(
                                    "display mode changed to {}x{} while the encoder \
                                     runs at {}x{} — pipeline restart required",
                                    c.width(),
                                    c.height(),
                                    w,
                                    h
                                ));
                            }
                            info!(
                                attempt,
                                backend = c.backend_name(),
                                "capture rebuilt after error"
                            );
                            // one event per episode: attempt 1 is a benign blip, attempt 87 is a real problem
                            clipdip_diagnostics::report_capture_failure_with(
                                "capture_rebuild_recovered",
                                clipdip_diagnostics::Severity::Info,
                                format!(
                                    "capture rebuilt after {attempt} attempts (original error: {e:#})"
                                ),
                                serde_json::json!({
                                    "attempt": attempt,
                                    "downtime_ms": rebuild_started.elapsed().as_millis() as u64,
                                    "backend": c.backend_name(),
                                }),
                            );
                            rebuilt = Some(c);
                            break;
                        }
                        Err(e2) if attempt % 10 == 1 => {
                            warn!(attempt, "capture rebuild failed (retrying): {e2:#}");
                        }
                        Err(_) => {}
                    }
                }
                match rebuilt {
                    Some(c) => dup = c,
                    None => {
                        if stop.load(Ordering::Relaxed) {
                            break;
                        }
                        clipdip_diagnostics::report_capture_failure(
                            "capture_rebuild_exhausted",
                            format!("could not rebuild capture after 60s (last error: {e:#})"),
                            serde_json::json!({
                                "attempts": 120,
                                "backend": dup.backend_name(),
                                "output_index": cfg.video.output_index,
                            }),
                        );
                        return Err(anyhow!(
                            "could not rebuild capture after 60s of retries \
                             (last capture error: {e:#})"
                        ));
                    }
                }
                continue;
            }
        };
        warn_if_slow("acquire_frame", t_acq.elapsed());
        let frame = match acquired {
            Some(f) => f,
            None => {
                capture_phase.store(capture_phase::SLEEP, Ordering::Relaxed);
                continue;
            }
        };

        // QPC at emit time, not DXGI's LastPresentTime (would drift); a big jump here means
        // GPU/display powered down, fold it into the media clock or a resume wipes the ring.
        let raw = qpc_now_100ns();
        if let Some(prev) = last_raw_pts {
            let delta = raw - prev;
            if delta > stall_threshold_100ns {
                let paused = delta - frame_interval_100ns;
                let total = media_clock.add_pause(paused);
                warn!(
                    stall_secs = paused as f64 / 1e7,
                    total_pause_secs = total as f64 / 1e7,
                    "video capture stalled (GPU/display power transition?) — \
                     compensating media clock so the replay buffer isn't wiped"
                );
            }
        }
        last_raw_pts = Some(raw);
        // only updates when a frame is actually produced, so now - this is true time since last capture
        frame_liveness.store(raw, Ordering::Relaxed);

        let pts = media_clock.to_media(raw).max(last_emitted_pts + 1);
        last_emitted_pts = pts;

        let t_enc = Instant::now();
        capture_phase.store(capture_phase::ENCODE, Ordering::Relaxed);
        let packets = encoder
            .encode_frame(&frame.texture, pts)
            .context("encode frame")?;
        warn_if_slow("encode_frame", t_enc.elapsed());

        let _t_push = clipdip_profile::start("pipeline.ring_push");
        let t_push = Instant::now();
        capture_phase.store(capture_phase::PUSH, Ordering::Relaxed);
        for p in packets {
            ring.push(p);
        }
        warn_if_slow("ring_push", t_push.elapsed());
        drop(_t_push);
        capture_phase.store(capture_phase::SLEEP, Ordering::Relaxed);
        frames += 1;
    }

    info!(frames, "video capture stopping; flushing encoder");
    for p in encoder.flush().context("flush encoder")? {
        ring.push(p);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn save_clip_with_stem(
    ring: &PacketRing,
    cfg: &Config,
    audio_meta: &[AudioMeta],
    stem: &str,
    active_codec: Option<ActiveCodec>,
    codec_header: &[u8],
    t_min_override: Option<i64>,
) -> Result<PathBuf> {
    let codec = active_codec
        .ok_or_else(|| anyhow!("encoder not yet open — wait ~1s after start and retry"))?;
    let _t = clipdip_profile::start("pipeline.save_clip");
    let snapshot = ring.snapshot();
    // t_min is the replay window start (hotkey) or recording anchor (override); cut at the
    // latest IDR at-or-before it, so the clip covers the full window (may run up to one GOP longer)
    let t_last = snapshot
        .iter()
        .rev()
        .find(|p| p.stream_id == STREAM_VIDEO)
        .map(|p| p.pts_100ns)
        .ok_or_else(|| {
            if let clipdip_diagnostics::Gate::Send { suppressed } =
                clipdip_diagnostics::gate("save_no_video_packets", Duration::from_secs(60))
            {
                clipdip_diagnostics::report_capture_failure(
                    "save_no_video_packets",
                    "save requested but no video packets in ring",
                    serde_json::json!({
                        "snapshot_len": snapshot.len(),
                        "occurrences": suppressed + 1,
                    }),
                );
            }
            anyhow!("no video packets in ring yet — wait ~1s after start and retry")
        })?;
    let window_100ns = (cfg.replay_seconds as i64) * 10_000_000;
    let t_min = t_min_override.unwrap_or(t_last - window_100ns);
    let mut oldest_idr: Option<usize> = None;
    let mut idr_at_or_before: Option<usize> = None;
    for (i, p) in snapshot.iter().enumerate() {
        if p.stream_id != STREAM_VIDEO || !p.is_keyframe {
            continue;
        }
        if oldest_idr.is_none() {
            oldest_idr = Some(i);
        }
        if p.pts_100ns <= t_min {
            idr_at_or_before = Some(i);
        } else {
            break;
        }
    }
    // no IDR at/before the window start = buffer doesn't reach back that far yet;
    // fall back to the oldest IDR rather than refuse to save
    if t_min_override.is_none() && idr_at_or_before.is_none() {
        // "short clip" symptom: app just started, byte budget starved the window, or a
        // stall longer than the media clock could fold out
        let oldest_video_pts = snapshot
            .iter()
            .find(|p| p.stream_id == STREAM_VIDEO)
            .map(|p| p.pts_100ns)
            .unwrap_or(t_last);
        let stats = ring.stats();
        let buffered_secs = (t_last - oldest_video_pts) as f64 / 1e7;
        warn!(
            requested_window_secs = cfg.replay_seconds,
            buffered_secs,
            ring_bytes_used_mb = stats.bytes_used / 1_000_000,
            ring_byte_budget_mb = stats.byte_budget / 1_000_000,
            "replay buffer shorter than configured window — clip will be \
             truncated (app just started, byte-budget starvation, or a \
             capture stall)"
        );
        // "1-second clip" bug shape; carries ring state to distinguish app-just-started
        // from byte starvation from a long stall
        clipdip_diagnostics::report_capture_failure_with(
            "clip_truncated_short_window",
            clipdip_diagnostics::Severity::Warning,
            format!(
                "buffer holds only {buffered_secs:.0}s of the {}s replay window",
                cfg.replay_seconds
            ),
            serde_json::json!({
                "requested_window_secs": cfg.replay_seconds,
                "buffered_secs": buffered_secs,
                "ring_bytes_used_mb": stats.bytes_used / 1_000_000,
                "ring_byte_budget_mb": stats.byte_budget / 1_000_000,
            }),
        );
    }
    let first_idr = idr_at_or_before.or(oldest_idr).ok_or_else(|| {
        if let clipdip_diagnostics::Gate::Send { suppressed } =
            clipdip_diagnostics::gate("save_no_idr", Duration::from_secs(60))
        {
            clipdip_diagnostics::report_capture_failure(
                "save_no_idr",
                "save requested but no video IDR in ring",
                serde_json::json!({
                    "snapshot_len": snapshot.len(),
                    "occurrences": suppressed + 1,
                }),
            );
        }
        anyhow!("no video IDR in ring yet — wait ~1s after start and retry")
    })?;

    let video_pkts: Vec<&EncodedPacket> = snapshot[first_idr..]
        .iter()
        .filter(|p| p.stream_id == STREAM_VIDEO)
        .collect();
    let t0 = video_pkts.first().map(|p| p.pts_100ns).ok_or_else(|| {
        if let clipdip_diagnostics::Gate::Send { suppressed } =
            clipdip_diagnostics::gate("save_idr_no_packets", Duration::from_secs(60))
        {
            clipdip_diagnostics::report_capture_failure(
                "save_idr_no_packets",
                "video IDR found but no packets after it",
                serde_json::json!({ "occurrences": suppressed + 1 }),
            );
        }
        anyhow!("video IDR found but no packets after it")
    })?;

    // real fps from the QPC span: config fps overstates it under load (DXGI can stall
    // ~200ms), and using it would drift audio vs video. frames-1: N frames = N-1 intervals.
    let span_secs = (t_last - t0) as f64 / 1e7;
    let actual_fps = if span_secs > 0.0 && video_pkts.len() > 1 {
        (video_pkts.len() - 1) as f64 / span_secs
    } else {
        cfg.video.fps as f64
    };

    // ffmpeg auto-detects format from extension; a mismatched .h264 with AV1 OBUs looks broken
    let video_ext = match codec {
        ActiveCodec::H264 => "h264",
        ActiveCodec::Av1 => "av1",
    };
    let video_path = cfg.output.directory.join(format!("{stem}.{video_ext}"));
    let mp4_path = cfg.output.directory.join(format!("{stem}.mp4"));

    info!(
        video_packets = video_pkts.len(),
        t0_100ns = t0,
        output = %mp4_path.display(),
        "saving clip"
    );

    // paths never leave the machine, only io kind/volume/free space; StorageFull (or raw
    // Win32 disk-full codes) gets its own disk_full code
    let report_disk_error = |stage: &'static str, err: &std::io::Error| {
        let raw = err.raw_os_error();
        let is_full = matches!(err.kind(), std::io::ErrorKind::StorageFull)
            || matches!(raw, Some(112) | Some(39));
        let code = if is_full { "disk_full" } else { "bitstream_write_failed" };
        if let clipdip_diagnostics::Gate::Send { suppressed } =
            clipdip_diagnostics::gate(code, Duration::from_secs(60))
        {
            clipdip_diagnostics::report_error(
                code,
                format!("clip write failed at {stage}: {}", err.kind()),
                Some(serde_json::json!({
                    "stage": stage,
                    "io_kind": format!("{:?}", err.kind()),
                    "os_error": raw,
                    "volume": crate::diskinfo::volume_category(&cfg.output.directory),
                    "free_gb": crate::diskinfo::free_disk_gb(&cfg.output.directory),
                    "occurrences": suppressed + 1,
                })),
            );
        }
    };

    // directory may not exist yet (fresh config, or user deleted it); save must never fail on that
    std::fs::create_dir_all(&cfg.output.directory)
        .inspect_err(|e| {
            if let clipdip_diagnostics::Gate::Send { .. } =
                clipdip_diagnostics::gate("output_dir_create_failed", Duration::from_secs(60))
            {
                clipdip_diagnostics::report_error(
                    "output_dir_create_failed",
                    format!("could not create output directory: {}", e.kind()),
                    Some(serde_json::json!({
                        "io_kind": format!("{:?}", e.kind()),
                        "volume": crate::diskinfo::volume_category(&cfg.output.directory),
                        "free_gb": crate::diskinfo::free_disk_gb(&cfg.output.directory),
                    })),
                );
            }
        })
        .with_context(|| format!("create output dir {}", cfg.output.directory.display()))?;

    let save_started = Instant::now();
    let mut vf = File::create(&video_path)
        .inspect_err(|e| report_disk_error("create", e))
        .with_context(|| format!("create {}", video_path.display()))?;
    // ffmpeg's obu demuxer needs every TU (incl. sequence header) to start with a TD, else
    // "Missing Temporal Delimiter"; nvEncGetSequenceParams gives a bare SEQ_HDR, so wrap it.
    if matches!(codec, ActiveCodec::Av1) && !codec_header.is_empty() {
        // OBU_TEMPORAL_DELIMITER, obu_has_size_field=1, payload size=0
        const AV1_TD: [u8; 2] = [0x12, 0x00];
        vf.write_all(&AV1_TD)
            .inspect_err(|e| report_disk_error("header", e))
            .with_context(|| format!("write TD to {}", video_path.display()))?;
        vf.write_all(codec_header)
            .inspect_err(|e| report_disk_error("header", e))
            .with_context(|| format!("write SEQ_HDR to {}", video_path.display()))?;
    } else if !codec_header.is_empty() {
        vf.write_all(codec_header)
            .inspect_err(|e| report_disk_error("header", e))
            .with_context(|| format!("write header to {}", video_path.display()))?;
    }
    for p in &video_pkts {
        vf.write_all(&p.bytes)
            .inspect_err(|e| report_disk_error("packet", e))
            .with_context(|| format!("write {}", video_path.display()))?;
    }
    // no fsync: ffmpeg reads the sidecars back through the page cache and they are
    // deleted after the mux, flushing 200MB first only delayed the encode

    let mut audio_tracks: Vec<AudioTrack> = Vec::new();
    for AudioMeta {
        stream_id,
        label,
        friendly_name,
        fmt,
    } in audio_meta
    {
        let pkts: Vec<&EncodedPacket> = snapshot
            .iter()
            .filter(|p| p.stream_id == *stream_id && p.pts_100ns >= t0 && p.pts_100ns <= t_last)
            .collect();
        if pkts.is_empty() {
            warn!(stream_id, %label, "no audio packets in window — skipping");
            continue;
        }
        // WAV starts at sample 0, but the first packet's QPC may be a few ms after t0
        // (~10ms WASAPI chunks); shift the track by that gap so it doesn't play at time 0.
        let first_a_pts = pkts.first().map(|p| p.pts_100ns).unwrap_or(t0);
        let offset_secs = (first_a_pts - t0).max(0) as f64 / 1e7;
        let wav_path = cfg.output.directory.join(format!("{stem}.{label}.wav"));
        match write_wav(&wav_path, *fmt, &pkts) {
            Ok(_) => audio_tracks.push(AudioTrack {
                path: wav_path,
                title: friendly_name.clone(),
                bitrate_bps: cfg.output.audio_bitrate_bps,
                offset_secs,
            }),
            Err(e) => {
                warn!(stream_id, %label, "WAV write failed: {e:#}");
                if let clipdip_diagnostics::Gate::Send { suppressed } =
                    clipdip_diagnostics::gate("wav_write_failed", Duration::from_secs(60))
                {
                    // positional stream id only; labels can embed device names
                    clipdip_diagnostics::report_error_with(
                        "wav_write_failed",
                        clipdip_diagnostics::Severity::Warning,
                        "WAV sidecar write failed — clip will be missing an audio track",
                        Some(serde_json::json!({
                            "stream_id": stream_id,
                            "sample_rate": fmt.sample_rate,
                            "channels": fmt.channels,
                            "bits": fmt.bits_per_sample,
                            "volume": crate::diskinfo::volume_category(&cfg.output.directory),
                            "free_gb": crate::diskinfo::free_disk_gb(&cfg.output.directory),
                            "occurrences": suppressed + 1,
                        })),
                    );
                }
            }
        }
    }

    info!(
        actual_fps,
        target_fps = cfg.video.fps,
        frames = video_pkts.len(),
        span_secs,
        "muxing with measured fps",
    );
    let ffmpeg = resolve_ffmpeg_path(cfg.output.ffmpeg_path.as_deref());
    let bitstream = match codec {
        ActiveCodec::H264 => VideoBitstream::H264,
        ActiveCodec::Av1 => VideoBitstream::Av1,
    };
    mux_with_ffmpeg_cli(
        &ffmpeg,
        &video_path,
        bitstream,
        actual_fps,
        &audio_tracks,
        cfg.audio.include_mix,
        &mp4_path,
    )
    .context("ffmpeg mux")?;

    if !cfg.output.keep_sidecars {
        let _ = std::fs::remove_file(&video_path);
        for t in &audio_tracks {
            let _ = std::fs::remove_file(&t.path);
        }
    }
    info!(path = %mp4_path.display(), "clip saved");

    // denominator for save-failure rate + fps/size/latency distributions; numeric fields only
    let total = clipdip_diagnostics::increment_clips_saved();
    let mp4_bytes = std::fs::metadata(&mp4_path).map(|m| m.len()).unwrap_or(0);
    clipdip_diagnostics::report_custom(
        "clip_saved",
        clipdip_diagnostics::Severity::Info,
        format!("clip saved ({span_secs:.0}s, {actual_fps:.0}fps)"),
        Some(serde_json::json!({
            "duration_secs": span_secs,
            "actual_fps": actual_fps,
            "target_fps": cfg.video.fps,
            "video_packets": video_pkts.len(),
            "mp4_bytes": mp4_bytes,
            "save_ms": save_started.elapsed().as_millis() as u64,
            "codec": video_ext,
            "audio_tracks": audio_tracks.len(),
            "kind": if t_min_override.is_some() { "recording" } else { "clip" },
            "clips_saved_total": total,
        })),
    );
    Ok(mp4_path)
}

/// Write a minimal RIFF/WAVE file. Header sizes are patched after the
/// payload is written so the file is valid regardless of total length.
fn write_wav(path: &PathBuf, fmt: WaveFormat, pkts: &[&EncodedPacket]) -> Result<u64> {
    if pkts.is_empty() {
        return Ok(0);
    }
    let mut f = File::create(path).with_context(|| format!("create {}", path.display()))?;
    let byte_rate = fmt.sample_rate * fmt.frame_bytes();
    let block_align = fmt.frame_bytes() as u16;
    let format_tag: u16 = if fmt.is_float { 0x0003 } else { 0x0001 };

    f.write_all(b"RIFF")?;
    f.write_all(&0u32.to_le_bytes())?; // patched
    f.write_all(b"WAVE")?;
    f.write_all(b"fmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&format_tag.to_le_bytes())?;
    f.write_all(&fmt.channels.to_le_bytes())?;
    f.write_all(&fmt.sample_rate.to_le_bytes())?;
    f.write_all(&byte_rate.to_le_bytes())?;
    f.write_all(&block_align.to_le_bytes())?;
    f.write_all(&fmt.bits_per_sample.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&0u32.to_le_bytes())?; // patched

    // loopback stops delivering when nothing plays then resumes with a fresh QPC stamp;
    // pad gaps with silence so the WAV stays wall-clock-accurate instead of desyncing.
    let frame_bytes = fmt.frame_bytes() as u64;
    let sample_rate = fmt.sample_rate as i64;
    // half a WASAPI period (~5ms): ignores jitter, catches real dropouts
    const GAP_THRESHOLD_100NS: i64 = 50_000;
    let mut data_bytes = 0u64;
    let mut prev_end_pts: Option<i64> = None;
    for p in pkts {
        if let Some(end) = prev_end_pts {
            let delta = p.pts_100ns - end;
            if delta > GAP_THRESHOLD_100NS {
                // round to nearest whole frame, never negative
                let missing_frames = (delta * sample_rate + 5_000_000) / 10_000_000;
                if missing_frames > 0 {
                    let silence_bytes = (missing_frames as u64) * frame_bytes;
                    let chunk = vec![0u8; silence_bytes.min(64 * 1024) as usize];
                    let mut remaining = silence_bytes;
                    while remaining > 0 {
                        let n = remaining.min(chunk.len() as u64) as usize;
                        f.write_all(&chunk[..n])?;
                        remaining -= n as u64;
                    }
                    data_bytes += silence_bytes;
                }
            }
        }
        f.write_all(&p.bytes)?;
        data_bytes += p.bytes.len() as u64;
        let num_frames = (p.bytes.len() as u64 / frame_bytes) as i64;
        prev_end_pts = Some(p.pts_100ns + num_frames * 10_000_000 / sample_rate);
    }

    let total = f.metadata()?.len();
    f.seek(SeekFrom::Start(4))?;
    f.write_all(&(total as u32 - 8).to_le_bytes())?;
    f.seek(SeekFrom::Start(40))?;
    f.write_all(&(data_bytes as u32).to_le_bytes())?;
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(id: &str, name: &str, flow: DeviceFlow) -> AudioDeviceInfo {
        AudioDeviceInfo {
            id: id.into(),
            friendly_name: name.into(),
            flow,
            is_default: false,
        }
    }

    #[test]
    fn pinned_device_resolves_by_id_then_by_name() {
        let devices = vec![
            dev("cap-new", "Mikrofon (Auna Mic CM900)", DeviceFlow::Capture),
            dev("ren-1", "Mikrofon (Auna Mic CM900)", DeviceFlow::Render),
            dev("cap-2", "Mic (Elgato Virtual Audio)", DeviceFlow::Capture),
        ];
        let mic = AudioKind::Microphone;
        let name = Some("Mikrofon (Auna Mic CM900)");
        // exact id wins even when the name would point elsewhere
        assert_eq!(resolve_pinned_device(mic, "cap-2", name, &devices).map(|d| d.id.as_str()), Some("cap-2"));
        // gone id, saved name: same-flow match only, the render endpoint with that name is ignored
        assert_eq!(resolve_pinned_device(mic, "cap-old", name, &devices).map(|d| d.id.as_str()), Some("cap-new"));
        // no name saved: nothing to go on
        assert!(resolve_pinned_device(mic, "cap-old", None, &devices).is_none());
        // ambiguous name stays unresolved
        let mut twins = devices.clone();
        twins.push(dev("cap-3", "Mikrofon (Auna Mic CM900)", DeviceFlow::Capture));
        assert!(resolve_pinned_device(mic, "cap-old", name, &twins).is_none());
    }
}
