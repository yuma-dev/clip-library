//! Clip muxing. Two paths: `mux_with_ffmpeg_cli` (used today, shells out to
//! ffmpeg to combine raw h264 + WAV sidecars into an MP4 with N audio streams)
//! and `ClipWriter` (future libavformat fragmented MP4, stubbed, see HANDOFF.md).

use anyhow::{anyhow, bail, Context, Result};
use clipdip_ringbuf::EncodedPacket;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tracing::{debug, info};

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

    let mut cmd = Command::new(ffmpeg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd.arg("-y").arg("-hide_banner").arg("-loglevel").arg("warning");

    // pin demuxer format explicitly, raw h264/av1 sidecars fool ffmpeg's probing.
    // fps is measured from pts (not config target): dropped frames under load
    // would otherwise compress the timeline and drift audio.
    cmd.arg("-f")
        .arg(video_bitstream.ffmpeg_format())
        .arg("-framerate")
        .arg(format!("{:.6}", video_fps))
        .arg("-i")
        .arg(video_h264);

    // no -itsoffset: it writes an elst edit-list atom that Chrome's <audio> clamps
    // desyncing downstream tools. offset is materialized as real silence via adelay below.
    for t in audio_tracks {
        cmd.arg("-i").arg(&t.path);
    }

    // adelay pads each input, amix (normalize=0, full gain) combines into [mix].
    // pads are single-use so asplit into [aN]/[aNm], else ffmpeg errors "label already used".
    if !audio_tracks.is_empty() {
        let mut fc = String::new();
        for (i, t) in audio_tracks.iter().enumerate() {
            let idx = i + 1;
            let delay_ms = (t.offset_secs.max(0.0) * 1000.0).round() as u64;
            let head = if delay_ms > 0 {
                format!("[{idx}:a]adelay={delay_ms}:all=1")
            } else {
                format!("[{idx}:a]anull")
            };
            if do_mix {
                fc.push_str(&format!("{head},asplit=2[a{idx}][a{idx}m];"));
            } else {
                fc.push_str(&format!("{head}[a{idx}];"));
            }
        }
        if do_mix {
            for i in 0..audio_tracks.len() {
                fc.push_str(&format!("[a{}m]", i + 1));
            }
            fc.push_str(&format!(
                "amix=inputs={}:duration=longest:normalize=0[mix]",
                audio_tracks.len()
            ));
        } else if fc.ends_with(';') {
            fc.pop();
        }
        cmd.arg("-filter_complex").arg(&fc);
    }

    // map streams in output order
    cmd.arg("-map").arg("0:v:0");

    // set both title and handler_name: players (vlc/mpv/wmp) read handler_name from
    // the trak handler box, title alone leaves it as literal "SoundHandler".
    let set_audio_title = |cmd: &mut Command, out_idx: usize, title: &str| {
        cmd.arg(format!("-metadata:s:a:{}", out_idx))
            .arg(format!("title={}", title));
        cmd.arg(format!("-metadata:s:a:{}", out_idx))
            .arg(format!("handler_name={}", title));
    };

    // increments per map added
    let mut out_a_idx: usize = 0;
    if do_mix {
        cmd.arg("-map").arg("[mix]");
        set_audio_title(&mut cmd, out_a_idx, "Mix");
        out_a_idx += 1;
    }
    for (idx, t) in audio_tracks.iter().enumerate() {
        // map the delayed pad, not raw input, so adelay silence bakes into AAC
        // instead of becoming an edit list.
        cmd.arg("-map").arg(format!("[a{}]", idx + 1));
        set_audio_title(&mut cmd, out_a_idx, &t.title);
        out_a_idx += 1;
    }

    cmd.arg("-c:v").arg("copy");
    if !audio_tracks.is_empty() {
        cmd.arg("-c:a").arg("aac");
        // mix bitrate = first track's bitrate (heuristic; could expose per-track config later)
        let mut a_idx: usize = 0;
        if do_mix {
            cmd.arg(format!("-b:a:{}", a_idx))
                .arg(audio_tracks[0].bitrate_bps.to_string());
            a_idx += 1;
        }
        for t in audio_tracks {
            cmd.arg(format!("-b:a:{}", a_idx))
                .arg(t.bitrate_bps.to_string());
            a_idx += 1;
        }
    }

    // +faststart moves the moov atom to the front so the file is streamable; cheap on a 3s clip
    cmd.arg("-movflags").arg("+faststart");

    // suppress elst: aac's priming-sample delay would otherwise become an edit list
    // that chrome's <audio> clamps, misaligning stream-time vs media-time downstream.
    cmd.arg("-use_editlist").arg("0");

    cmd.arg(output_mp4);

    debug!(?cmd, "running ffmpeg mux");

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
    let output = output.with_context(|| format!("failed to spawn ffmpeg at {}", ffmpeg.display()))?;
    let stderr_text = String::from_utf8_lossy(&output.stderr);
    if !stderr_text.trim().is_empty() {
        debug!("ffmpeg stderr: {}", stderr_text.trim());
    }
    if !output.status.success() {
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".into());
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
                format!("ffmpeg exited with status {code}"),
                Some(serde_json::json!({
                    "exit_code": code,
                    "bitstream": video_bitstream.ffmpeg_format(),
                    "track_count": audio_tracks.len(),
                    "do_mix": do_mix,
                    "fps": video_fps,
                    "stderr_tail": tail.trim(),
                })),
            );
        }
        return Err(anyhow!("ffmpeg exited with status {code}"));
    }

    info!(
        output = %output_mp4.display(),
        video = %video_h264.display(),
        audio_sources = audio_tracks.len(),
        output_audio_streams = if do_mix { audio_tracks.len() + 1 } else { audio_tracks.len() },
        mix_track = do_mix,
        "muxed clip"
    );
    Ok(())
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
