//! Capture pipeline orchestration.
//!
//! [`Pipeline`] owns the ring buffer, the video capture+encode thread, and
//! the per-source audio threads — i.e. everything that needs to be live
//! between "user pressed Start" and "user pressed Stop". The CLI binary
//! wires it up against a hotkey + Ctrl+C; the Tauri UI (when it lands)
//! will wire the same `start` / `save_clip` / `stop` against its own
//! event surface.
//!
//! What the pipeline does NOT do:
//! - **CLI flag handling / config editing.** Those are launch-time only.
//! - **Hotkey listening / Ctrl+C / event loop.** Those are event sources;
//!   the caller decides when to call `save_clip` and `stop`.
//! - **Tracing init.** Whoever owns the process owns logging setup.

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
    AudioSource, CaptureBackendCfg, CodecPreferenceCfg, Config, RateControlCfg,
    RecordingQualityCfg,
};
use crate::filename::FilenameVars;

/// Current QPC time in 100-ns ticks — the same clock and unit the ring
/// buffer's packet PTS values use (WASAPI positions and DXGI present
/// times are both QPC-derived). Callers stamp the hotkey moment with
/// this so the saved clip can be clamped to end exactly at the press,
/// excluding anything that happens during the save flow itself (e.g.
/// the notification chirp leaking into the clip's system audio).
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
    // Split to avoid overflow: counter * 1e7 can exceed i64 after ~10h
    // of uptime if multiplied naively.
    let secs = counter / freq;
    let rem = counter % freq;
    secs * 10_000_000 + rem * 10_000_000 / freq
}

/// Metadata about one running audio source, used at save time to size WAV
/// headers correctly.
pub struct AudioMeta {
    pub stream_id: u8,
    /// Short slug used for the WAV sidecar filename (e.g. `loopback`,
    /// `mic-3a8f12c0`). Stays stable regardless of the device's current
    /// friendly name.
    pub label: String,
    /// Human-readable name written as the track's `title` metadata in
    /// the muxed MP4 — the device's WASAPI friendly name when we could
    /// resolve it, otherwise a fallback derived from the source kind.
    pub friendly_name: String,
    pub fmt: WaveFormat,
}

pub struct Pipeline {
    cfg: Config,
    ring: Arc<PacketRing>,
    audio_meta: Vec<AudioMeta>,
    audio_handles: Vec<AudioCapture>,
    stop: Arc<AtomicBool>,
    video_thread: Option<JoinHandle<Result<()>>>,
    /// Spawned only when `clipdip_profile::enabled()` was true at `start`.
    /// Periodically drains the global profiler and logs the report.
    reporter_thread: Option<JoinHandle<()>>,
    /// Set once by the video thread after the NVENC session opens, so the
    /// muxer can tell ffmpeg the right input format (`-f h264` vs `-f av1`).
    /// `None` until the encoder is ready (saving before then is impossible
    /// anyway — the ring has no IDR yet).
    active_codec: Arc<Mutex<Option<ActiveCodec>>>,
    /// Codec sequence header bytes captured once at NVENC init. Prepended
    /// to the saved bitstream file so ffmpeg always sees a sequence
    /// header at byte 0, even when the rolling buffer's first keyframe
    /// didn't repeat one. Empty until the video thread populates it.
    codec_header: Arc<Mutex<Vec<u8>>>,
    /// PTS anchor of an in-progress manual recording. While `Some`, the
    /// ring holds everything from this point on (no eviction past it);
    /// `stop_recording_and_save_in` consumes it.
    recording_from: Mutex<Option<i64>>,
    /// Shared clock that folds capture stalls out of the PTS timeline. Held
    /// here so it lives as long as the pipeline; the video and audio threads
    /// hold their own clones.
    _media_clock: Arc<MediaClock>,
    /// Raw (uncompensated) QPC timestamp of the most recently captured video
    /// frame, in 100-ns ticks; 0 until the first frame. The video thread
    /// writes it every frame; a health monitor compares it against
    /// `qpc_now_100ns()` to detect a live capture stall.
    frame_liveness: Arc<AtomicI64>,
    /// Like [`frame_liveness`] but only updated on frames with *new
    /// content* (`was_repeat == false`). If this stops advancing while
    /// `frame_liveness` keeps ticking, the capturer is running but the
    /// captured image never changes — the signature of a capture backend
    /// that can't see a fullscreen game (frozen-frame / desktop-only
    /// clips). A health monitor alerts on that divergence.
    real_frame_liveness: Arc<AtomicI64>,
    /// Set (once) by the video thread if it exits with an error, so a
    /// supervisor can react immediately instead of waiting to join the
    /// thread at shutdown — before this existed, a dead capture thread
    /// looked identical to a wedged one for 15s and the error text was
    /// lost until process exit.
    video_error: Arc<Mutex<Option<String>>>,
    /// Which stage the video loop is currently in (see [`CapturePhase`]).
    /// If frame production wedges, this pins down *which* GPU call hung —
    /// the loop sets it before each call but can't clear it if the call
    /// never returns.
    capture_phase: Arc<AtomicU8>,
    /// QP the encoder should run at *right now* (H.264 scale), or
    /// [`QP_BOOST_OFF`] for the configured base quality. Written by
    /// `start_recording` / `stop_recording_and_save_in`; the video thread
    /// polls it once per frame and reconfigures NVENC on change, so manual
    /// recordings encode at `video.recording_quality` while replay-buffer
    /// footage stays at the cheaper clip quality.
    recording_qp_boost: Arc<AtomicU32>,
}

/// Sentinel in [`Pipeline::recording_qp_boost`]: no boost, run at the
/// configured base rate control.
const QP_BOOST_OFF: u32 = u32::MAX;

/// Stage values stored in [`Pipeline::capture_phase`]. A health watchdog
/// reads this when frames stop to report where the loop is stuck.
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
    /// Start capture: spawn one WASAPI thread per `cfg.audio.sources` entry,
    /// plus the video capture+encode thread. Returns once both are running
    /// (the video thread is up but may still be initializing the encoder).
    ///
    /// `ProcessLoopback` sources are logged + skipped (not implemented).
    /// Failed audio sources are logged + skipped (the rest of the pipeline
    /// continues). Failure to start the video thread aborts the whole
    /// pipeline.
    pub fn start(cfg: Config) -> Result<Self> {
        let ring = Arc::new(PacketRing::with_time_window(
            cfg.ring_byte_budget(),
            cfg.ring_time_window_100ns(),
        ));

        // One clock shared by every capture thread so audio and video stay
        // on a single, gap-free timebase across a stall.
        let media_clock = Arc::new(MediaClock::new());

        let (audio_meta, audio_handles) =
            start_audio(&cfg, Arc::clone(&ring), Arc::clone(&media_clock));

        let stop = Arc::new(AtomicBool::new(false));
        let active_codec: Arc<Mutex<Option<ActiveCodec>>> = Arc::new(Mutex::new(None));
        let codec_header: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let frame_liveness = Arc::new(AtomicI64::new(0));
        let real_frame_liveness = Arc::new(AtomicI64::new(0));
        let video_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let capture_phase = Arc::new(AtomicU8::new(capture_phase::SLEEP));
        let recording_qp_boost = Arc::new(AtomicU32::new(QP_BOOST_OFF));
        let video_thread = spawn_video_thread(
            cfg.clone(),
            Arc::clone(&ring),
            Arc::clone(&stop),
            Arc::clone(&active_codec),
            Arc::clone(&codec_header),
            Arc::clone(&media_clock),
            Arc::clone(&frame_liveness),
            Arc::clone(&real_frame_liveness),
            Arc::clone(&capture_phase),
            Arc::clone(&recording_qp_boost),
            Arc::clone(&video_error),
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
            stop,
            video_thread: Some(video_thread),
            reporter_thread,
            active_codec,
            codec_header,
            recording_from: Mutex::new(None),
            _media_clock: media_clock,
            frame_liveness,
            real_frame_liveness,
            video_error,
            capture_phase,
            recording_qp_boost,
        })
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    /// Shared handle to the packet ring, for live occupancy stats
    /// (the settings UI's file-size estimate).
    pub fn ring(&self) -> Arc<PacketRing> {
        Arc::clone(&self.ring)
    }

    /// Shared handle to the raw-QPC timestamp (100-ns ticks) of the most
    /// recently captured video frame; 0 until the first frame. A health
    /// monitor compares `qpc_now_100ns() - this` against a threshold to
    /// detect a capture stall while the app is running.
    pub fn frame_liveness(&self) -> Arc<AtomicI64> {
        Arc::clone(&self.frame_liveness)
    }

    /// Shared handle to the raw-QPC timestamp of the most recent frame
    /// with *new content* (not a CFR repeat). If [`frame_liveness`]
    /// advances while this doesn't, capture is running but blind — e.g. a
    /// fullscreen game presenting on a path the capture API can't see.
    pub fn real_frame_liveness(&self) -> Arc<AtomicI64> {
        Arc::clone(&self.real_frame_liveness)
    }

    /// The error the video thread died with, if it has died. A health
    /// monitor polls this to alert + restart the pipeline immediately
    /// (the thread's `JoinHandle` result is otherwise only observed at
    /// shutdown, so without this a capture failure is silent).
    pub fn video_error(&self) -> Arc<Mutex<Option<String>>> {
        Arc::clone(&self.video_error)
    }

    /// Shared handle to the video loop's current stage (see
    /// [`capture_phase`]). A watchdog reads this when frames have stopped to
    /// report which call wedged.
    pub fn capture_phase(&self) -> Arc<AtomicU8> {
        Arc::clone(&self.capture_phase)
    }

    /// Snapshot the ring, find the oldest video IDR, write temp `.h264` +
    /// per-source `.wav` sidecars trimmed to that IDR's PTS, then run
    /// ffmpeg to produce an MP4 with a "Mix" track + one stream per
    /// source. Returns the saved MP4 path.
    pub fn save_clip(&self) -> Result<PathBuf> {
        self.save_clip_in(None, &FilenameVars::default())
    }

    /// Like [`save_clip`] but writes to `directory_override` instead of
    /// the directory the pipeline was started with. Used so config edits
    /// to the output directory take effect on the next save without
    /// requiring a pipeline restart (which would tear down NVENC + the
    /// ring buffer for what is conceptually just a path change).
    ///
    /// The filename comes from expanding the `output.filename_stem`
    /// template against `vars` (focused app, etc.); a numeric suffix is
    /// added only if that name is already taken.
    ///
    /// The clip always covers the full configured replay window ending at
    /// the newest buffered frame. The notification chirp can't leak in: it
    /// only plays after the save completes, well after the ring snapshot is
    /// taken synchronously at the start of the save.
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

    /// Begin a manual recording: pin the ring against eviction from the
    /// newest buffered IDR onward. Returns an error if a recording is
    /// already in progress. Memory grows with recording length (raw
    /// encoded packets stay in RAM until the recording is saved).
    pub fn start_recording(&self) -> Result<()> {
        let mut rec = self.recording_from.lock().unwrap();
        if rec.is_some() {
            return Err(anyhow!("recording already in progress"));
        }
        // Anchor at the latest IDR (not "now") so the recording is
        // decodable from its very first frame instead of losing up to
        // one GOP at the start.
        let anchor = self
            .ring
            .latest_keyframe_pts()
            .ok_or_else(|| anyhow!("no video in buffer yet — wait ~1s after start and retry"))?;
        self.ring.set_hold(Some(anchor));
        *rec = Some(anchor);
        // Boost encode quality for the recording's duration. CQP only —
        // NVENC can't switch rate-control mode on a live session — and
        // never *worse* than the clip quality (a recording QP above the
        // clip QP is treated as "match clips"). The video thread picks the
        // new target up on its next frame and reconfigures NVENC; the
        // first ≤1 GOP of the recording (the pre-anchor footage) stays at
        // clip quality.
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

    /// End a manual recording and save everything since the start anchor
    /// as a clip (same mux path as `save_clip_in`). Releases the ring
    /// hold whether or not the save succeeds.
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

        // Drop the encoder back to clip quality right away. Reconfigure
        // only affects frames encoded from here on; everything already in
        // the ring keeps the boosted quality for the save below.
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
        // Release the hold only after the snapshot inside the save has
        // been taken (save_clip_with_stem snapshots synchronously before
        // returning control here on the error path too).
        self.ring.set_hold(None);
        result
    }

    /// Like [`save_clip`] but writes to a fixed `{stem}.mp4` (overwriting
    /// any previous file with the same name). Used by smoke-test flows
    /// that want a stable output path instead of a new timestamped clip
    /// every run.
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

    /// Signal the video thread to stop, join it, then drop audio handles
    /// (each `AudioCapture::Drop` signals + joins its own thread).
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
        // Dropping the Vec drops each AudioCapture, whose Drop joins.
        self.audio_handles.clear();
        Ok(())
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        // Best-effort cleanup if the caller forgot `stop()`. Calling
        // `stop()` is preferred because it propagates join errors.
        if self.video_thread.is_some() {
            let _ = self.stop_in_place();
        }
    }
}

fn start_audio(
    cfg: &Config,
    ring: Arc<PacketRing>,
    clock: Arc<MediaClock>,
) -> (Vec<AudioMeta>, Vec<AudioCapture>) {
    // One-shot enumeration so we can stamp each track with its device's
    // friendly name (used as the MP4 track title). Falls back to an empty
    // list on failure — capture still works, titles just lose the device
    // name.
    let devices = list_devices().unwrap_or_else(|e| {
        warn!("list_devices failed, audio track titles will use fallback: {e:#}");
        Vec::new()
    });

    let mut meta = Vec::new();
    let mut handles = Vec::new();
    for (idx, source) in cfg.audio.sources.iter().enumerate() {
        let stream_id = (idx + 1) as u8; // 0 reserved for video
        let label = source.label();
        let device_id = source.device_id().map(str::to_string);
        let kind = match source {
            AudioSource::SystemLoopback { .. } => AudioKind::SystemLoopback,
            AudioSource::Microphone { .. } => AudioKind::Microphone,
            AudioSource::ProcessLoopback { process_name } => {
                warn!(process = %process_name, "process loopback not implemented — skipping");
                continue;
            }
        };
        let friendly_name = resolve_friendly_name(kind, device_id.as_deref(), &devices)
            .unwrap_or_else(|| fallback_friendly_name(kind));
        match AudioCapture::start(kind, stream_id, device_id, Arc::clone(&ring), Arc::clone(&clock))
        {
            Ok(cap) => {
                let fmt = cap.format();
                info!(stream_id, %label, %friendly_name, ?fmt, "audio source started");
                meta.push(AudioMeta {
                    stream_id,
                    label,
                    friendly_name,
                    fmt,
                });
                handles.push(cap);
            }
            Err(e) => warn!(?kind, "failed to start audio source: {e:#}"),
        }
    }
    (meta, handles)
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
    // Drain the very first window (it covers from process start to now —
    // mostly init noise) so the first logged line reflects real steady
    // state.
    let _ = clipdip_profile::report();
    let interval = Duration::from_millis(interval_ms.max(500));
    std::thread::Builder::new()
        .name("clipdip-profile".into())
        .spawn(move || {
            // Sleep in small slices so a Ctrl+C exit doesn't have to wait
            // for a full window. 100ms slices are still imperceptible.
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
            // One last drain so partial-window data isn't silently lost.
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
    real_frame_liveness: Arc<AtomicI64>,
    capture_phase: Arc<AtomicU8>,
    recording_qp_boost: Arc<AtomicU32>,
    video_error: Arc<Mutex<Option<String>>>,
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
                real_frame_liveness,
                capture_phase,
                recording_qp_boost,
            );
            if let Err(e) = &result {
                // Surface the failure NOW — the JoinHandle result is only
                // read at shutdown, and a silently dead capture thread is
                // exactly how we recorded desktop wallpaper for two hours.
                error!("video capture thread exited with error: {e:#}");
                *video_error.lock().unwrap() = Some(format!("{e:#}"));
            }
            result
        })
        .context("spawn video capture thread")
}

/// Log a WARN if one video-loop stage blocked far longer than a frame should
/// take. The loop is otherwise a black box: we know it stalls (the health
/// monitor sees frames stop) but not *where*. With non-blocking logging this
/// WARN never blocks capture itself, so the next real stall pins the culprit:
/// `acquire_frame` slow ⇒ DXGI / GPU / capture-blocking software; `encode_frame`
/// slow ⇒ NVENC / GPU; neither slow but the stall detector still fires ⇒ the
/// thread was descheduled (OS scheduling / power), not any capture call.
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
    real_frame_liveness: Arc<AtomicI64>,
    capture_phase: Arc<AtomicU8>,
    recording_qp_boost: Arc<AtomicU32>,
) -> Result<()> {
    let backend = match cfg.video.capture_backend {
        CaptureBackendCfg::Auto => CaptureBackend::Auto,
        CaptureBackendCfg::Wgc => CaptureBackend::Wgc,
        CaptureBackendCfg::Dxgi => CaptureBackend::Dxgi,
    };
    let (mut dup, device, context) = Capturer::create(
        backend,
        cfg.video.output_index,
        cfg.video.include_cursor,
    )
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
        RateControlCfg::ConstantQp { qp } => RateControl::ConstantQp { qp },
        RateControlCfg::Vbr { avg_bps } => RateControl::Vbr { avg_bps },
    };

    let mut encoder = NvEncoderD3D11::new(
        device.clone(),
        EncoderConfig {
            width: w,
            height: h,
            fps_num: cfg.video.fps,
            fps_den: 1,
            gop_length: (cfg.video.fps as f32 * cfg.video.gop_seconds).round() as u32,
            codec_preference,
            rate_control,
        },
    )
    .context("init NVENC encoder")?;

    let codec_now = encoder.active_codec();
    *active_codec.lock().unwrap() = Some(codec_now);
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
    // A jump larger than this between two consecutive frames' raw QPC
    // readings means capture stalled (GPU/display power transition blocking
    // DXGI/NVENC) rather than just a busy-frame hiccup — DXGI acquire can
    // legitimately stall a couple hundred ms under load, so the threshold
    // sits well above that.
    let stall_threshold_100ns = (frame_interval_100ns * 8).max(5_000_000);
    let mut next_at = Instant::now();
    let mut frames: u32 = 0;
    // Last PTS handed to the encoder, used only to keep the stream
    // strictly monotonic. Every frame is timestamped with QPC at emit
    // time (see the loop below) — the same clock WASAPI audio positions
    // use — so video and audio share one timebase and can't drift.
    let mut last_emitted_pts: i64 = 0;
    // Last raw (uncompensated) QPC reading, for stall detection.
    let mut last_raw_pts: Option<i64> = None;
    // QP override currently applied to the encoder session (None = base
    // config). Tracks `recording_qp_boost` so we only pay the NVENC
    // reconfigure when the target actually changes — and don't retry
    // every frame if the driver rejects it.
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
        // Clamp so an idle stretch doesn't push `next_at` far into the
        // past. Without this, when activity resumes and DXGI delivers
        // fresh frames quickly, the loop would burst-encode at the
        // hardware ceiling until `next_at` catches up — visible as a
        // brief frame-rate spike after returning from idle.
        next_at = next_at.max(now) + frame_interval;

        let _t_frame = clipdip_profile::start("pipeline.video_frame");

        // Apply any pending recording-quality change before encoding this
        // frame. The reconfigure keeps the NVENC session (and bitstream
        // continuity) intact and forces an IDR, so the new quality starts
        // on a clean GOP boundary within one frame of the hotkey.
        let boost = recording_qp_boost.load(Ordering::Relaxed);
        let target = if boost == QP_BOOST_OFF { None } else { Some(boost) };
        if target != applied_qp_boost {
            if let RateControlCfg::ConstantQp { qp: base_qp } = cfg.video.rate_control {
                let qp = target.unwrap_or(base_qp);
                match encoder.reconfigure_rate_control(RateControl::ConstantQp { qp }) {
                    Ok(()) => info!(qp, boosted = target.is_some(), "encoder quality reconfigured"),
                    Err(e) => warn!(
                        qp,
                        "encoder quality reconfigure failed — recording continues at \
                         the previous quality: {e:#}"
                    ),
                }
            }
            // Mark handled even on failure so we don't hammer the driver
            // with a doomed reconfigure every frame.
            applied_qp_boost = target;
        }

        // Timeout=0: DXGI returns immediately, either with a fresh frame
        // (desktop changed since the last acquire) or with TIMEOUT, in
        // which case `acquire_frame` re-emits the last captured texture
        // so we stay at the configured CFR. A non-zero timeout would
        // block the loop here for up to that long whenever the desktop
        // is static — which on an idle screen meant the loop produced
        // only ~5 fps no matter the target. The outer `next_at` sleep
        // already handles pacing, so DXGI doesn't need to.
        let t_acq = Instant::now();
        capture_phase.store(capture_phase::ACQUIRE, Ordering::Relaxed);
        let acquired = match dup.acquire_frame(0) {
            Ok(a) => a,
            Err(e) => {
                // ACCESS_LOST (game switched display modes, HDR toggle,
                // monitor re-plug) or a WGC item close. Rebuild the
                // capturer on the SAME device — the NVENC session stays
                // open, so once capture is back the ring keeps filling and
                // the media clock folds the gap out of the timeline.
                // Before this existed the thread just died here, silently,
                // and the watchdog restarted the whole app 15s later.
                error!(
                    backend = dup.backend_name(),
                    "capture failed: {e:#} — rebuilding capturer"
                );
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

        // PTS: stamp every frame — real or repeat — with QPC at emit
        // time. This is the single clock the whole pipeline uses: audio
        // packets carry WASAPI's QPC position (same epoch, same 100ns
        // units), so video and audio never drift and the replay-window
        // math compares like with like. We deliberately ignore DXGI's
        // LastPresentTime: mixing it (real frames) with a synthetic CFR
        // counter (repeats) meant two different clocks, whose drift could
        // mis-bound the saved window. `.max(last + 1)` keeps PTS strictly
        // monotonic for NVENC even if two QPC reads land on the same tick.
        // Detect a capture stall: between two real iterations the raw QPC
        // delta should be ~one frame interval. A delta of many intervals
        // means the GPU/display powered down and DXGI/NVENC blocked while
        // QPC kept advancing. Fold the excess into the shared media clock so
        // the emitted timeline stays continuous — otherwise the first
        // resumed frame jumps the clock forward and the ring's time-window
        // eviction wipes the whole buffer, collapsing the next clip to ~1s.
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
        // Liveness beacon for the health monitor: raw QPC keeps advancing
        // during a stall, but this only updates when a frame is actually
        // produced, so `now - this` is the true time since last capture.
        frame_liveness.store(raw, Ordering::Relaxed);
        // Content beacon: only frames that carried a NEW image. Repeats
        // keep the CFR stream alive even when the capturer sees nothing,
        // so `frame_liveness` alone can look perfectly healthy while every
        // clip comes out frozen — the health monitor compares the two.
        if !frame.was_repeat {
            real_frame_liveness.store(raw, Ordering::Relaxed);
        }

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
    // Bound the saved clip by time. `t_min` is either the replay window
    // start (hotkey save) or the manual-recording anchor (override). The
    // ring's time-based eviction keeps a couple of seconds of slack beyond
    // the replay window, so cutting at the *latest IDR at-or-before*
    // `t_min` is normally possible — the clip then always covers the full
    // configured window (it may run up to one GOP longer, never shorter).
    let t_last = snapshot
        .iter()
        .rev()
        .find(|p| p.stream_id == STREAM_VIDEO)
        .map(|p| p.pts_100ns)
        .ok_or_else(|| anyhow!("no video packets in ring yet — wait ~1s after start and retry"))?;
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
    // No IDR at/before the window start means the buffer simply doesn't
    // reach back that far yet (app just started, or recording anchor was
    // the very first IDR) — fall back to the oldest IDR so we still emit
    // a playable clip rather than refusing to save.
    if t_min_override.is_none() && idr_at_or_before.is_none() {
        // This is the "short clip" symptom. With the media-clock stall
        // compensation in place it should only happen in the first seconds
        // after start; if it shows up otherwise, capture lost more time
        // than the clock could fold out (e.g. a stall longer than the whole
        // window) and the log below pins down how short the buffer was.
        let oldest_video_pts = snapshot
            .iter()
            .find(|p| p.stream_id == STREAM_VIDEO)
            .map(|p| p.pts_100ns)
            .unwrap_or(t_last);
        warn!(
            requested_window_secs = cfg.replay_seconds,
            buffered_secs = (t_last - oldest_video_pts) as f64 / 1e7,
            "replay buffer shorter than configured window — clip will be \
             truncated (capture stall or app just started)"
        );
    }
    let first_idr = idr_at_or_before
        .or(oldest_idr)
        .ok_or_else(|| anyhow!("no video IDR in ring yet — wait ~1s after start and retry"))?;

    let video_pkts: Vec<&EncodedPacket> = snapshot[first_idr..]
        .iter()
        .filter(|p| p.stream_id == STREAM_VIDEO)
        .collect();
    let t0 = video_pkts
        .first()
        .map(|p| p.pts_100ns)
        .ok_or_else(|| anyhow!("video IDR found but no packets after it"))?;

    // Real fps measured from the QPC span of the captured packets. The
    // capture loop drops frames under load (DXGI acquire can stall for
    // up to 200ms), so the target fps from config overstates the actual
    // rate — using it would shrink the video timeline relative to the
    // (real-time) audio and audio would drift later. `frames-1` because
    // a span of N frames covers N-1 inter-frame intervals.
    let span_secs = (t_last - t0) as f64 / 1e7;
    let actual_fps = if span_secs > 0.0 && video_pkts.len() > 1 {
        (video_pkts.len() - 1) as f64 / span_secs
    } else {
        cfg.video.fps as f64
    };

    // Bitstream sidecar uses an extension that matches the encoded codec —
    // ffmpeg auto-detects format from extension and would otherwise treat
    // an `.h264` file containing AV1 OBUs as broken H.264.
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

    let mut vf = File::create(&video_path)
        .with_context(|| format!("create {}", video_path.display()))?;
    // For AV1: ffmpeg's `obu` demuxer (low-overhead bitstream) requires
    // every Temporal Unit — including the one carrying the initial
    // sequence header — to start with an OBU_TEMPORAL_DELIMITER, else
    // it bails out with "Missing Temporal Delimiter" before the
    // sequence header is parsed. NVENC emits TDs in front of every
    // packet it gives us, but `nvEncGetSequenceParams` returns just the
    // bare SEQ_HDR OBU. Wrap it in its own TU: [TD][SEQ_HDR].
    // For H.264 the equivalent header (SPS+PPS) is already framed by
    // start codes, so this path doesn't apply.
    if matches!(codec, ActiveCodec::Av1) && !codec_header.is_empty() {
        // OBU_TEMPORAL_DELIMITER, obu_has_size_field=1, payload size=0
        const AV1_TD: [u8; 2] = [0x12, 0x00];
        vf.write_all(&AV1_TD)
            .with_context(|| format!("write TD to {}", video_path.display()))?;
        vf.write_all(codec_header)
            .with_context(|| format!("write SEQ_HDR to {}", video_path.display()))?;
    } else if !codec_header.is_empty() {
        vf.write_all(codec_header)
            .with_context(|| format!("write header to {}", video_path.display()))?;
    }
    for p in &video_pkts {
        vf.write_all(&p.bytes)
            .with_context(|| format!("write {}", video_path.display()))?;
    }
    vf.sync_all().ok();

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
        // Audio packets are written into the WAV starting at sample 0, but
        // their first packet's QPC may be a few ms after t0 (audio is
        // captured in ~10ms WASAPI chunks). Tell ffmpeg to shift this
        // track by that gap so what was originally at t0+δ doesn't end up
        // playing at video time 0.
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
            Err(e) => warn!(stream_id, %label, "WAV write failed: {e:#}"),
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

    // WASAPI loopback only delivers buffers while a render session is
    // active — if nothing is playing for a stretch, packets simply stop
    // arriving and resume later with a fresh QPC stamp. Writing those
    // packets back-to-back compresses real-time gaps out of the WAV and
    // the back half of the clip ends up out of sync with video. Detect
    // inter-packet gaps via QPC deltas and pad with silence frames so the
    // WAV stays wall-clock-accurate.
    let frame_bytes = fmt.frame_bytes() as u64;
    let sample_rate = fmt.sample_rate as i64;
    // Threshold of half a typical WASAPI period (~5 ms) — large enough to
    // ignore scheduling jitter, small enough to catch real dropouts.
    const GAP_THRESHOLD_100NS: i64 = 50_000;
    let mut data_bytes = 0u64;
    let mut prev_end_pts: Option<i64> = None;
    for p in pkts {
        if let Some(end) = prev_end_pts {
            let delta = p.pts_100ns - end;
            if delta > GAP_THRESHOLD_100NS {
                // Round to nearest whole frame; never negative.
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
    f.sync_all().ok();
    Ok(total)
}
