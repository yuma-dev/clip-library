//! Clip muxing. Two paths: `mux_with_ffmpeg_cli` (used today, shells out to
//! ffmpeg to combine raw h264 + WAV sidecars into an MP4 with N audio streams)
//! and `ClipWriter` (future libavformat fragmented MP4, stubbed, see HANDOFF.md).
//!
//! timing: `cargo run --release -p clipdip-muxer --example bench_mux -- --clip <mp4>`

use anyhow::{anyhow, bail, Context, Result};
use clipdip_ringbuf::EncodedPacket;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tracing::{debug, info, warn};

// ffmpeg CLI path

/// Raw bitstream format of the video sidecar, passed to ffmpeg as `-f h264`/`-f av1`.
/// AV1 OBUs misdetect as broken H.264 if ffmpeg guesses from the extension.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoBitstream {
    H264,
    Av1,
}

impl VideoBitstream {
    fn ffmpeg_format(self) -> &'static str {
        match self {
            VideoBitstream::H264 => "h264",
            // ffmpeg's "av1" demuxer expects Annex B and rejects NVENC output;
            // use "obu" (low overhead OBU), what NVENC actually produces.
            VideoBitstream::Av1 => "obu",
        }
    }
}

/// One audio source to mux into the output MP4 as its own stream.
#[derive(Clone, Debug)]
pub struct AudioTrack {
    /// WAV (or any ffmpeg-readable) input file.
    pub path: PathBuf,
    /// Human-readable label, e.g. `"System"` or `"Mic"`. Written as the
    /// `title` metadata on the output audio stream so players can show it.
    pub title: String,
    /// AAC bitrate for this track in bits/sec. 192 kbps stereo is fine.
    pub bitrate_bps: u32,
    /// Delay for this track relative to video start, in seconds. Positive
    /// pushes audio later (first audio packet's QPC after video IDR PTS).
    pub offset_secs: f64,
}

/// Which AAC encoder the sidecars go through. `aac_mf` (MediaFoundation, Windows
/// only) is 2-3x faster than ffmpeg's native `aac` at the same bitrate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AacEncoder {
    /// `aac_mf` on windows unless it already failed once this process, else `aac`
    Auto,
    Native,
    MediaFoundation,
}

impl AacEncoder {
    fn resolve(self) -> AacEncoder {
        match self {
            AacEncoder::Auto if cfg!(windows) && !MF_BROKEN.load(Ordering::Relaxed) => {
                AacEncoder::MediaFoundation
            }
            AacEncoder::Auto => AacEncoder::Native,
            other => other,
        }
    }

    fn ffmpeg_name(self) -> &'static str {
        match self {
            AacEncoder::MediaFoundation => "aac_mf",
            _ => "aac",
        }
    }
}

/// set once `aac_mf` fails and native `aac` then succeeds on the same job (no MF
/// codec on this box, N-edition windows, broken MF stack); later saves skip the retry
static MF_BROKEN: AtomicBool = AtomicBool::new(false);

/// How the ffmpeg work is split. Kept as an option so the bench can A/B them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MuxStrategy {
    /// SinglePass on ffmpeg >= 7 with aac_mf (its own encoder threads already
    /// overlap the streams and the extra remux only costs), ParallelTracks otherwise
    Auto,
    /// one ffmpeg does everything. ffmpeg < 7 encodes the N audio streams one
    /// after another on a single thread, so a 60s clip with 5 tracks costs ~12s
    SinglePass,
    /// one ffmpeg per track (plus one for the mix) in parallel writing .m4a
    /// intermediates, then a stream-copy remux with the video
    ParallelTracks,
}

impl MuxStrategy {
    fn resolve(self, ffmpeg: &Path, encoder: AacEncoder) -> MuxStrategy {
        match self {
            MuxStrategy::Auto => {
                if encoder == AacEncoder::MediaFoundation && ffmpeg_major(ffmpeg) >= 7 {
                    MuxStrategy::SinglePass
                } else {
                    MuxStrategy::ParallelTracks
                }
            }
            other => other,
        }
    }
}

/// major version from `ffmpeg -version`, cached per binary path (ClipLib can swap
/// the path at runtime). 0 when it cannot be read, which lands on ParallelTracks.
pub fn ffmpeg_major(ffmpeg: &Path) -> u32 {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, u32>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = cache.lock().ok().and_then(|c| c.get(ffmpeg).copied()) {
        return v;
    }
    let mut cmd = Command::new(ffmpeg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let major = cmd
        .arg("-version")
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|o| parse_ffmpeg_major(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(0);
    if let Ok(mut c) = cache.lock() {
        c.insert(ffmpeg.to_path_buf(), major);
    }
    major
}

/// "ffmpeg version 6.0-essentials_build..." or "ffmpeg version n8.1.2-34-g..." (BtbN)
fn parse_ffmpeg_major(banner: &str) -> Option<u32> {
    let first = banner.lines().next()?;
    let ver = first.strip_prefix("ffmpeg version ")?.trim_start_matches('n');
    let digits: String = ver.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

#[derive(Clone, Copy, Debug)]
pub struct MuxOptions {
    pub strategy: MuxStrategy,
    pub encoder: AacEncoder,
}

impl Default for MuxOptions {
    fn default() -> Self {
        Self {
            strategy: MuxStrategy::Auto,
            encoder: AacEncoder::Auto,
        }
    }
}

/// Muxes `video_h264` (stream-copied) plus `audio_tracks` (encoded to AAC) into `output_mp4`.
/// With >= 2 tracks, track 0 is a combined `amix`; tracks 1..N are per-source.
pub fn mux_with_ffmpeg_cli(
    ffmpeg: &Path,
    video_h264: &Path,
    video_bitstream: VideoBitstream,
    video_fps: f64,
    audio_tracks: &[AudioTrack],
    include_mix: bool,
    output_mp4: &Path,
) -> Result<()> {
    mux_with_options(
        ffmpeg,
        video_h264,
        video_bitstream,
        video_fps,
        audio_tracks,
        include_mix,
        output_mp4,
        MuxOptions::default(),
    )
}

#[allow(clippy::too_many_arguments)]
pub fn mux_with_options(
    ffmpeg: &Path,
    video_h264: &Path,
    video_bitstream: VideoBitstream,
    video_fps: f64,
    audio_tracks: &[AudioTrack],
    include_mix: bool,
    output_mp4: &Path,
    opts: MuxOptions,
) -> Result<()> {
    if !video_h264.exists() {
        // should be unreachable (caller just wrote it); AV quarantine or a cleanup race if it fires
        clipdip_diagnostics::report_error(
            "mux_input_missing",
            "video sidecar vanished before mux",
            Some(serde_json::json!({ "input": "video" })),
        );
        bail!("video input does not exist: {}", video_h264.display());
    }
    for (idx, t) in audio_tracks.iter().enumerate() {
        if !t.path.exists() {
            clipdip_diagnostics::report_error(
                "mux_input_missing",
                "audio sidecar vanished before mux",
                Some(serde_json::json!({ "input": "audio", "track_index": idx })),
            );
            bail!("audio input does not exist: {}", t.path.display());
        }
    }

    let do_mix = include_mix && audio_tracks.len() >= 2;
    let job = MuxJob {
        ffmpeg,
        video: video_h264,
        bitstream: video_bitstream,
        fps: video_fps,
        tracks: audio_tracks,
        do_mix,
        output: output_mp4,
    };

    let encoder = if audio_tracks.is_empty() {
        AacEncoder::Native
    } else {
        opts.encoder.resolve()
    };
    let strategy = if audio_tracks.is_empty() {
        MuxStrategy::SinglePass
    } else {
        opts.strategy.resolve(ffmpeg, encoder)
    };
    let started = Instant::now();
    let used = match strategy {
        MuxStrategy::ParallelTracks => job.parallel_tracks(encoder)?,
        MuxStrategy::SinglePass | MuxStrategy::Auto => job.single_pass(encoder)?,
    };

    info!(
        output = %output_mp4.display(),
        video = %video_h264.display(),
        audio_sources = audio_tracks.len(),
        output_audio_streams = if do_mix { audio_tracks.len() + 1 } else { audio_tracks.len() },
        mix_track = do_mix,
        ?strategy,
        encoder = used.ffmpeg_name(),
        mux_ms = started.elapsed().as_millis() as u64,
        "muxed clip"
    );
    Ok(())
}

struct MuxJob<'a> {
    ffmpeg: &'a Path,
    video: &'a Path,
    bitstream: VideoBitstream,
    fps: f64,
    tracks: &'a [AudioTrack],
    do_mix: bool,
    output: &'a Path,
}

impl MuxJob<'_> {
    fn base_cmd(&self) -> Command {
        let mut cmd = Command::new(self.ffmpeg);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.arg("-y").arg("-hide_banner").arg("-loglevel").arg("warning");
        cmd
    }

    fn video_input(&self, cmd: &mut Command) {
        // pin demuxer format explicitly, raw h264/av1 sidecars fool ffmpeg's probing.
        // fps is measured from pts (not config target): dropped frames under load
        // would otherwise compress the timeline and drift audio.
        cmd.arg("-f")
            .arg(self.bitstream.ffmpeg_format())
            .arg("-framerate")
            .arg(format!("{:.6}", self.fps))
            .arg("-i")
            .arg(self.video);
    }

    // no -itsoffset: it writes an elst edit-list atom that Chrome's <audio> clamps
    // desyncing downstream tools. offset is materialized as real silence via adelay.
    fn delay_filter(t: &AudioTrack) -> String {
        let delay_ms = (t.offset_secs.max(0.0) * 1000.0).round() as u64;
        if delay_ms > 0 {
            format!("adelay={delay_ms}:all=1")
        } else {
            "anull".into()
        }
    }

    /// adelay pads each input, amix (normalize=0, full gain) combines into [mix].
    /// `first_input` is the ffmpeg input index of track 0.
    fn mix_filter(&self, first_input: usize) -> String {
        let mut fc = String::new();
        for (i, t) in self.tracks.iter().enumerate() {
            fc.push_str(&format!(
                "[{}:a]{}[m{i}];",
                first_input + i,
                Self::delay_filter(t)
            ));
        }
        for i in 0..self.tracks.len() {
            fc.push_str(&format!("[m{i}]"));
        }
        fc.push_str(&format!(
            "amix=inputs={}:duration=longest:normalize=0[mix]",
            self.tracks.len()
        ));
        fc
    }

    /// set both title and handler_name: players (vlc/mpv/wmp) read handler_name from
    /// the trak handler box, title alone leaves it as literal "SoundHandler".
    fn audio_title(cmd: &mut Command, out_idx: usize, title: &str) {
        cmd.arg(format!("-metadata:s:a:{out_idx}"))
            .arg(format!("title={title}"));
        cmd.arg(format!("-metadata:s:a:{out_idx}"))
            .arg(format!("handler_name={title}"));
    }

    fn output_flags(cmd: &mut Command) {
        // +faststart moves the moov atom to the front so the file is streamable
        cmd.arg("-movflags").arg("+faststart");
        // suppress elst: aac's priming-sample delay would otherwise become an edit list
        // that chrome's <audio> clamps, misaligning stream-time vs media-time downstream.
        cmd.arg("-use_editlist").arg("0");
    }

    /// mix bitrate = first track's bitrate (heuristic; could expose per-track config later)
    fn mix_bitrate(&self) -> u32 {
        self.tracks[0].bitrate_bps
    }

    fn single_pass(&self, encoder: AacEncoder) -> Result<AacEncoder> {
        let build = |enc: AacEncoder| {
            let mut cmd = self.base_cmd();
            self.video_input(&mut cmd);
            for t in self.tracks {
                cmd.arg("-i").arg(&t.path);
            }
            if !self.tracks.is_empty() {
                // pads are single-use so asplit into [aN]/[aNm], else ffmpeg errors "label already used".
                let mut fc = String::new();
                for (i, t) in self.tracks.iter().enumerate() {
                    let idx = i + 1;
                    let head = format!("[{idx}:a]{}", Self::delay_filter(t));
                    if self.do_mix {
                        fc.push_str(&format!("{head},asplit=2[a{idx}][a{idx}m];"));
                    } else {
                        fc.push_str(&format!("{head}[a{idx}];"));
                    }
                }
                if self.do_mix {
                    for i in 0..self.tracks.len() {
                        fc.push_str(&format!("[a{}m]", i + 1));
                    }
                    fc.push_str(&format!(
                        "amix=inputs={}:duration=longest:normalize=0[mix]",
                        self.tracks.len()
                    ));
                } else if fc.ends_with(';') {
                    fc.pop();
                }
                cmd.arg("-filter_complex").arg(&fc);
            }
            cmd.arg("-map").arg("0:v:0");
            let mut out_a_idx = 0usize;
            if self.do_mix {
                cmd.arg("-map").arg("[mix]");
                Self::audio_title(&mut cmd, out_a_idx, "Mix");
                out_a_idx += 1;
            }
            for (idx, t) in self.tracks.iter().enumerate() {
                // map the delayed pad, not raw input, so adelay silence bakes into AAC
                // instead of becoming an edit list.
                cmd.arg("-map").arg(format!("[a{}]", idx + 1));
                Self::audio_title(&mut cmd, out_a_idx, &t.title);
                out_a_idx += 1;
            }
            cmd.arg("-c:v").arg("copy");
            if !self.tracks.is_empty() {
                cmd.arg("-c:a").arg(enc.ffmpeg_name());
                let mut a_idx = 0usize;
                if self.do_mix {
                    cmd.arg(format!("-b:a:{a_idx}")).arg(self.mix_bitrate().to_string());
                    a_idx += 1;
                }
                for t in self.tracks {
                    cmd.arg(format!("-b:a:{a_idx}")).arg(t.bitrate_bps.to_string());
                    a_idx += 1;
                }
            }
            Self::output_flags(&mut cmd);
            cmd.arg(self.output);
            cmd
        };
        self.run_with_fallback("mux", encoder, build)
    }

    fn parallel_tracks(&self, encoder: AacEncoder) -> Result<AacEncoder> {
        let dir = self.output.parent().unwrap_or_else(|| Path::new("."));
        let stem = self
            .output
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "clip".into());
        // intermediates sit next to the output so the final copy remux stays on one volume
        let mut temps = TempFiles::default();
        let track_outs: Vec<PathBuf> = (0..self.tracks.len())
            .map(|i| temps.add(dir.join(format!("{stem}.track{i}.m4a"))))
            .collect();
        let mix_out = self
            .do_mix
            .then(|| temps.add(dir.join(format!("{stem}.mix.m4a"))));

        // phase 1: every track (and the mix) is its own ffmpeg. -use_editlist 0 here too so
        // the .m4a timeline already carries the priming silence and phase 2 is a plain copy.
        let encode_track = |i: usize, enc: AacEncoder| {
            let t = &self.tracks[i];
            let mut cmd = self.base_cmd();
            cmd.arg("-i").arg(&t.path);
            cmd.arg("-af").arg(Self::delay_filter(t));
            cmd.arg("-c:a").arg(enc.ffmpeg_name());
            cmd.arg("-b:a").arg(t.bitrate_bps.to_string());
            cmd.arg("-use_editlist").arg("0");
            cmd.arg("-f").arg("mp4").arg(&track_outs[i]);
            cmd
        };
        let encode_mix = |enc: AacEncoder| {
            let mut cmd = self.base_cmd();
            for t in self.tracks {
                cmd.arg("-i").arg(&t.path);
            }
            cmd.arg("-filter_complex").arg(self.mix_filter(0));
            cmd.arg("-map").arg("[mix]");
            cmd.arg("-c:a").arg(enc.ffmpeg_name());
            cmd.arg("-b:a").arg(self.mix_bitrate().to_string());
            cmd.arg("-use_editlist").arg("0");
            cmd.arg("-f").arg("mp4");
            cmd.arg(mix_out.as_ref().expect("mix output path"));
            cmd
        };

        let used = std::thread::scope(|s| -> Result<AacEncoder> {
            let mut handles = Vec::with_capacity(self.tracks.len() + 1);
            for i in 0..self.tracks.len() {
                let encode_track = &encode_track;
                handles.push(s.spawn(move || {
                    self.run_with_fallback("track", encoder, |enc| encode_track(i, enc))
                }));
            }
            if self.do_mix {
                let encode_mix = &encode_mix;
                handles.push(s.spawn(move || self.run_with_fallback("mix", encoder, encode_mix)));
            }
            // report the first failure, but let every child finish first so none is
            // left writing into a file we are about to delete
            let mut used = encoder;
            let mut first_err = None;
            for h in handles {
                match h.join() {
                    Ok(Ok(enc)) => {
                        // any track that had to fall back means the whole clip is on native aac
                        if enc == AacEncoder::Native {
                            used = AacEncoder::Native;
                        }
                    }
                    Ok(Err(e)) => {
                        first_err.get_or_insert(e);
                    }
                    Err(_) => {
                        first_err.get_or_insert(anyhow!("audio encode thread panicked"));
                    }
                }
            }
            match first_err {
                Some(e) => Err(e),
                None => Ok(used),
            }
        })?;

        // phase 2: stream-copy everything into the mp4
        let mut cmd = self.base_cmd();
        self.video_input(&mut cmd);
        let mut inputs: Vec<&Path> = Vec::new();
        if let Some(m) = &mix_out {
            inputs.push(m);
        }
        inputs.extend(track_outs.iter().map(|p| p.as_path()));
        for p in &inputs {
            cmd.arg("-i").arg(p);
        }
        cmd.arg("-map").arg("0:v:0");
        let mut out_a_idx = 0usize;
        if mix_out.is_some() {
            cmd.arg("-map").arg(format!("{}:a:0", out_a_idx + 1));
            Self::audio_title(&mut cmd, out_a_idx, "Mix");
            out_a_idx += 1;
        }
        for t in self.tracks {
            cmd.arg("-map").arg(format!("{}:a:0", out_a_idx + 1));
            Self::audio_title(&mut cmd, out_a_idx, &t.title);
            out_a_idx += 1;
        }
        // every .m4a carries its own default flag and copy keeps it; only the first
        // audio stream is default, same as the single pass
        for i in 0..out_a_idx {
            cmd.arg(format!("-disposition:a:{i}"))
                .arg(if i == 0 { "default" } else { "0" });
        }
        cmd.arg("-c").arg("copy");
        Self::output_flags(&mut cmd);
        cmd.arg(self.output);
        self.run(&mut cmd, "remux", used)?;
        drop(temps);
        Ok(used)
    }

    /// runs `build(encoder)`; when `aac_mf` fails, the same job is retried on native
    /// `aac` and, if that passes, MF is marked broken for the rest of the process
    fn run_with_fallback(
        &self,
        what: &str,
        encoder: AacEncoder,
        build: impl Fn(AacEncoder) -> Command,
    ) -> Result<AacEncoder> {
        match self.run(&mut build(encoder), what, encoder) {
            Ok(()) => Ok(encoder),
            Err(e) if encoder == AacEncoder::MediaFoundation => {
                warn!("{what} on aac_mf failed, retrying on native aac: {e:#}");
                self.run(&mut build(AacEncoder::Native), what, AacEncoder::Native)?;
                if !MF_BROKEN.swap(true, Ordering::Relaxed) {
                    clipdip_diagnostics::report_error_with(
                        "aac_mf_unavailable",
                        clipdip_diagnostics::Severity::Warning,
                        "aac_mf encoder failed, using native aac from now on",
                        Some(serde_json::json!({ "stage": what })),
                    );
                }
                Ok(AacEncoder::Native)
            }
            Err(e) => Err(e),
        }
    }

    fn run(&self, cmd: &mut Command, what: &str, encoder: AacEncoder) -> Result<()> {
        debug!(?cmd, "running ffmpeg {what}");

        // capture stderr: CREATE_NO_WINDOW builds have nowhere to inherit it to, so a
        // failure used to leave only an exit code. forwarded to tracing below.
        cmd.stdout(Stdio::null()).stderr(Stdio::piped());

        let output = cmd.output().inspect_err(|e| {
            // NotFound = ffmpeg missing (broken bundle, ClipLib path bridge failed);
            // PermissionDenied = usually AV quarantine. both ship-blocking.
            if let clipdip_diagnostics::Gate::Send { .. } =
                clipdip_diagnostics::gate("ffmpeg_not_found", std::time::Duration::from_secs(600))
            {
                clipdip_diagnostics::report_error(
                    "ffmpeg_not_found",
                    format!("failed to spawn ffmpeg: {}", e.kind()),
                    Some(serde_json::json!({
                        "io_kind": format!("{:?}", e.kind()),
                    })),
                );
            }
        });
        let output = output
            .with_context(|| format!("failed to spawn ffmpeg at {}", self.ffmpeg.display()))?;
        let stderr_text = String::from_utf8_lossy(&output.stderr);
        if !stderr_text.trim().is_empty() {
            debug!("ffmpeg {what} stderr: {}", stderr_text.trim());
        }
        if output.status.success() {
            return Ok(());
        }
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".into());
        // an aac_mf failure gets retried on native aac by the caller; only that
        // second failure is worth a telemetry row
        if encoder != AacEncoder::MediaFoundation {
            if let clipdip_diagnostics::Gate::Send { .. } =
                clipdip_diagnostics::gate("ffmpeg_mux_failed", std::time::Duration::from_secs(600))
            {
                // path-scrubbed stderr tail so the dashboard sees the actual ffmpeg diagnostic
                let mut tail_start = stderr_text.len().saturating_sub(4096);
                while !stderr_text.is_char_boundary(tail_start) {
                    tail_start += 1;
                }
                let tail = clipdip_diagnostics::scrub_user_paths(&stderr_text[tail_start..]);
                clipdip_diagnostics::report_error(
                    "ffmpeg_mux_failed",
                    format!("ffmpeg {what} exited with status {code}"),
                    Some(serde_json::json!({
                        "exit_code": code,
                        "stage": what,
                        "bitstream": self.bitstream.ffmpeg_format(),
                        "track_count": self.tracks.len(),
                        "do_mix": self.do_mix,
                        "fps": self.fps,
                        "stderr_tail": tail.trim(),
                    })),
                );
            }
        }
        Err(anyhow!("ffmpeg {what} exited with status {code}"))
    }
}

/// intermediates removed on drop, so an error anywhere in phase 1 or 2 still cleans up
#[derive(Default)]
struct TempFiles(Vec<PathBuf>);

impl TempFiles {
    fn add(&mut self, p: PathBuf) -> PathBuf {
        self.0.push(p.clone());
        p
    }
}

impl Drop for TempFiles {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Resolve ffmpeg path: config override, then a binary bundled next to clipdip.exe
/// (installer plug-and-play), then bare "ffmpeg" on PATH (cargo run in dev).
pub fn resolve_ffmpeg_path(override_path: Option<&Path>) -> PathBuf {
    if let Some(p) = override_path {
        return p.to_path_buf();
    }
    if let Some(bundled) = bundled_ffmpeg() {
        return bundled;
    }
    PathBuf::from("ffmpeg")
}

/// Sibling ffmpeg next to the exe, only if it exists (cargo run's target/debug
/// has no bundled binary; caller falls through to PATH otherwise).
fn bundled_ffmpeg() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    
    // 1. Sibling to the executable (portable/zip release)
    let sibling = dir.join(name);
    if sibling.is_file() {
        return Some(sibling);
    }

    // 2. Inside Tauri's resources directory (installed package)
    let resource = dir.join("resources").join(name);
    if resource.is_file() {
        return Some(resource);
    }

    None
}

// future: libavformat fragmented mp4

#[derive(Clone, Debug)]
pub struct VideoStreamInfo {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    /// Annex-B SPS+PPS or AVCC `extradata` blob from NVENC.
    pub extradata: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct AudioStreamInfo {
    pub sample_rate: u32,
    pub channels: u32,
    /// AAC AudioSpecificConfig bytes.
    pub extradata: Vec<u8>,
}

pub struct ClipWriter {
    // fields land with the libavformat path: fmt_ctx (AVFormatContext)
    // v_stream, a_streams (AVStream ptrs)
}

impl ClipWriter {
    pub fn open(
        _path: &Path,
        _video: &VideoStreamInfo,
        _audio: &[AudioStreamInfo],
    ) -> Result<Self> {
        todo!("libavformat fragmented MP4 writer — needs ffmpeg-next + vcpkg setup");
    }

    pub fn write_packet(&mut self, _packet: &EncodedPacket) -> Result<()> {
        todo!("libavformat write_packet")
    }

    pub fn finalize(self) -> Result<()> {
        todo!("libavformat finalize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_major_parses_gyan_and_btbn_banners() {
        assert_eq!(parse_ffmpeg_major("ffmpeg version 6.0-essentials_build-www.gyan.dev Copyright"), Some(6));
        assert_eq!(parse_ffmpeg_major("ffmpeg version n8.1.2-34-g9b6c8969e0-20260731 Copyright"), Some(8));
        assert_eq!(parse_ffmpeg_major("ffmpeg version 2024-05-01-git-abc"), Some(2024));
        assert_eq!(parse_ffmpeg_major("not ffmpeg"), None);
    }
}
