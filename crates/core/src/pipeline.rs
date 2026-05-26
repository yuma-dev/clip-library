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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use tracing::{info, warn};

use clipdip_audio::{AudioCapture, AudioKind, WaveFormat};
use clipdip_capture::DesktopDuplicator;
use clipdip_encoder::{EncoderConfig, NvEncoderD3D11};
use clipdip_muxer::{mux_with_ffmpeg_cli, resolve_ffmpeg_path, AudioTrack};
use clipdip_ringbuf::{EncodedPacket, PacketRing, STREAM_VIDEO};

use crate::config::{AudioSource, Config};

/// Metadata about one running audio source, used at save time to size WAV
/// headers correctly.
pub struct AudioMeta {
    pub stream_id: u8,
    pub label: String,
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
        let ring = Arc::new(PacketRing::new(cfg.ring_byte_budget()));

        let (audio_meta, audio_handles) = start_audio(&cfg, Arc::clone(&ring));

        let stop = Arc::new(AtomicBool::new(false));
        let video_thread = spawn_video_thread(cfg.clone(), Arc::clone(&ring), Arc::clone(&stop))?;

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
        })
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    /// Snapshot the ring, find the oldest video IDR, write temp `.h264` +
    /// per-source `.wav` sidecars trimmed to that IDR's PTS, then run
    /// ffmpeg to produce a timestamped MP4 with a "Mix" track + one
    /// stream per source. Returns the saved MP4 path.
    pub fn save_clip(&self) -> Result<PathBuf> {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let stem = format!("{}-{}", self.cfg.output.filename_stem, ts);
        save_clip_with_stem(&self.ring, &self.cfg, &self.audio_meta, &stem)
    }

    /// Like [`save_clip`] but writes to a fixed `{stem}.mp4` (overwriting
    /// any previous file with the same name). Used by smoke-test flows
    /// that want a stable output path instead of a new timestamped clip
    /// every run.
    pub fn save_clip_as(&self, stem: &str) -> Result<PathBuf> {
        save_clip_with_stem(&self.ring, &self.cfg, &self.audio_meta, stem)
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

fn start_audio(cfg: &Config, ring: Arc<PacketRing>) -> (Vec<AudioMeta>, Vec<AudioCapture>) {
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
        match AudioCapture::start(kind, stream_id, device_id, Arc::clone(&ring)) {
            Ok(cap) => {
                let fmt = cap.format();
                info!(stream_id, %label, ?fmt, "audio source started");
                meta.push(AudioMeta {
                    stream_id,
                    label,
                    fmt,
                });
                handles.push(cap);
            }
            Err(e) => warn!(?kind, "failed to start audio source: {e:#}"),
        }
    }
    (meta, handles)
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

fn spawn_video_thread(
    cfg: Config,
    ring: Arc<PacketRing>,
    stop: Arc<AtomicBool>,
) -> Result<JoinHandle<Result<()>>> {
    std::thread::Builder::new()
        .name("clipdip-video".into())
        .spawn(move || video_loop(cfg, ring, stop))
        .context("spawn video capture thread")
}

fn video_loop(cfg: Config, ring: Arc<PacketRing>, stop: Arc<AtomicBool>) -> Result<()> {
    let (mut dup, device, _ctx) = DesktopDuplicator::with_default_device(cfg.video.output_index)
        .with_context(|| {
            format!(
                "create D3D11 device + DXGI duplicator on output {} \
                 (run `clipdip --list-outputs` to see valid indices)",
                cfg.video.output_index
            )
        })?;
    dup.set_include_cursor(cfg.video.include_cursor);
    let (w, h) = (dup.width(), dup.height());

    let mut encoder = NvEncoderD3D11::new(
        device,
        EncoderConfig {
            width: w,
            height: h,
            fps_num: cfg.video.fps,
            fps_den: 1,
            bitrate_bps: cfg.video.bitrate_bps,
            gop_length: (cfg.video.fps as f32 * cfg.video.gop_seconds).round() as u32,
        },
    )
    .context("init NVENC encoder")?;

    let frame_interval = Duration::from_secs_f64(1.0 / cfg.video.fps as f64);
    let frame_interval_100ns: i64 = (1e7 / cfg.video.fps as f64).round() as i64;
    let mut next_at = Instant::now();
    let mut frames: u32 = 0;
    // Last PTS handed to the encoder. Real frames use DXGI's
    // LastPresentTime (QPC, same clock as audio). Repeats — emitted
    // when the desktop didn't change — carry the *same* LastPresentTime
    // from `emit_repeat`, so we synthesize a monotonically increasing
    // PTS for them instead. Audio still uses true QPC, but on an idle
    // screen real desktop activity is sparse so DXGI's clock would
    // otherwise stall and the two would drift apart.
    let mut last_emitted_pts: i64 = 0;

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

        // Timeout=0: DXGI returns immediately, either with a fresh frame
        // (desktop changed since the last acquire) or with TIMEOUT, in
        // which case `acquire_frame` re-emits the last captured texture
        // so we stay at the configured CFR. A non-zero timeout would
        // block the loop here for up to that long whenever the desktop
        // is static — which on an idle screen meant the loop produced
        // only ~5 fps no matter the target. The outer `next_at` sleep
        // already handles pacing, so DXGI doesn't need to.
        let frame = match dup.acquire_frame(0).context("acquire frame")? {
            Some(f) => f,
            None => continue,
        };

        // PTS rule:
        // - Real frame (DXGI returned new content): use its
        //   LastPresentTime — same QPC clock as audio.
        // - Repeat (desktop static): DXGI's LastPresentTime is stale,
        //   so advance synthetically by one frame_interval to keep
        //   PTS monotonic and CFR-shaped. Without this, many repeats
        //   share one PTS, the measured fps at save time collapses,
        //   and the muxer lays the clip out at the wrong rate.
        let pts = if frame.was_repeat {
            last_emitted_pts + frame_interval_100ns
        } else {
            // Guard against a real frame whose LastPresentTime hasn't
            // advanced past our synthetic clock (can happen the very
            // first time activity resumes after a long static stretch).
            frame.pts_100ns.max(last_emitted_pts + 1)
        };
        last_emitted_pts = pts;

        let packets = encoder
            .encode_frame(&frame.texture, pts)
            .context("encode frame")?;
        let _t_push = clipdip_profile::start("pipeline.ring_push");
        for p in packets {
            ring.push(p);
        }
        drop(_t_push);
        frames += 1;
    }

    info!(frames, "video capture stopping; flushing encoder");
    for p in encoder.flush().context("flush encoder")? {
        ring.push(p);
    }
    Ok(())
}

fn save_clip_with_stem(
    ring: &PacketRing,
    cfg: &Config,
    audio_meta: &[AudioMeta],
    stem: &str,
) -> Result<PathBuf> {
    let _t = clipdip_profile::start("pipeline.save_clip");
    let snapshot = ring.snapshot();
    let first_idr = snapshot
        .iter()
        .position(|p| p.stream_id == STREAM_VIDEO && p.is_keyframe)
        .ok_or_else(|| anyhow!("no video IDR in ring yet — wait ~1s after start and retry"))?;

    let video_pkts: Vec<&EncodedPacket> = snapshot[first_idr..]
        .iter()
        .filter(|p| p.stream_id == STREAM_VIDEO)
        .collect();
    let t0 = video_pkts
        .first()
        .map(|p| p.pts_100ns)
        .ok_or_else(|| anyhow!("video IDR found but no packets after it"))?;
    let t_last = video_pkts
        .last()
        .map(|p| p.pts_100ns)
        .unwrap_or(t0);

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

    let h264_path = cfg.output.directory.join(format!("{stem}.h264"));
    let mp4_path = cfg.output.directory.join(format!("{stem}.mp4"));

    info!(
        video_packets = video_pkts.len(),
        t0_100ns = t0,
        output = %mp4_path.display(),
        "saving clip"
    );

    let mut vf = File::create(&h264_path)
        .with_context(|| format!("create {}", h264_path.display()))?;
    for p in &video_pkts {
        vf.write_all(&p.bytes)
            .with_context(|| format!("write {}", h264_path.display()))?;
    }
    vf.sync_all().ok();

    let mut audio_tracks: Vec<AudioTrack> = Vec::new();
    for AudioMeta {
        stream_id,
        label,
        fmt,
    } in audio_meta
    {
        let pkts: Vec<&EncodedPacket> = snapshot
            .iter()
            .filter(|p| p.stream_id == *stream_id && p.pts_100ns >= t0)
            .collect();
        if pkts.is_empty() {
            warn!(stream_id, %label, "no audio packets in window — skipping");
            continue;
        }
        // Audio packets are written contiguously into the WAV starting
        // at sample 0, but their first packet's QPC may be a few ms
        // after t0 (audio is captured in ~10ms WASAPI chunks). Tell
        // ffmpeg to shift this track by that gap so what was originally
        // at t0+δ doesn't end up playing at video time 0.
        let first_a_pts = pkts.first().map(|p| p.pts_100ns).unwrap_or(t0);
        let offset_secs = (first_a_pts - t0).max(0) as f64 / 1e7;
        let wav_path = cfg.output.directory.join(format!("{stem}.{label}.wav"));
        match write_wav(&wav_path, *fmt, &pkts) {
            Ok(_) => audio_tracks.push(AudioTrack {
                path: wav_path,
                title: pretty_title(label),
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
    mux_with_ffmpeg_cli(&ffmpeg, &h264_path, actual_fps, &audio_tracks, &mp4_path)
        .context("ffmpeg mux")?;

    if !cfg.output.keep_sidecars {
        let _ = std::fs::remove_file(&h264_path);
        for t in &audio_tracks {
            let _ = std::fs::remove_file(&t.path);
        }
    }
    info!(path = %mp4_path.display(), "clip saved");
    Ok(mp4_path)
}

fn pretty_title(label: &str) -> String {
    match label {
        "loopback" => "System Audio".into(),
        "mic" => "Microphone".into(),
        other => other.to_string(),
    }
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

    let mut data_bytes = 0u64;
    for p in pkts {
        f.write_all(&p.bytes)?;
        data_bytes += p.bytes.len() as u64;
    }

    let total = f.metadata()?.len();
    f.seek(SeekFrom::Start(4))?;
    f.write_all(&(total as u32 - 8).to_le_bytes())?;
    f.seek(SeekFrom::Start(40))?;
    f.write_all(&(data_bytes as u32).to_le_bytes())?;
    f.sync_all().ok();
    Ok(total)
}
