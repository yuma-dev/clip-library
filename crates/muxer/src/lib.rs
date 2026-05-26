//! Clip muxing.
//!
//! Two paths exist:
//!
//! 1. **`mux_with_ffmpeg_cli`** — pragmatic path used today. Spawns the
//!    system `ffmpeg` binary as a subprocess to combine a raw `.h264`
//!    file and N WAV sidecars into a single MP4 with one video stream
//!    and N separately-mapped audio streams ("Tonspur"). No vcpkg /
//!    libavformat dependency, AAC encoding handled by the CLI.
//!
//! 2. **`ClipWriter`** — *future* live-write fragmented MP4 backed by
//!    `libavformat` (`ffmpeg-next`). This is what the eventual hotkey-
//!    triggered save flow will use, writing fragments to disk as the
//!    encoder produces packets so a crash can't lose the moov atom.
//!    Not implemented yet — stubbed and tracked in HANDOFF.md.

use anyhow::{anyhow, bail, Context, Result};
use clipdip_ringbuf::EncodedPacket;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tracing::{debug, info};

// ---- ffmpeg CLI path ----------------------------------------------------

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
    /// Seconds to delay this track relative to the video start. Positive
    /// values push audio later (used when the first audio packet's QPC
    /// is slightly after the video IDR PTS).
    pub offset_secs: f64,
}

/// Mux `video_h264` (raw Annex-B at `video_fps`) plus each of `audio_tracks`
/// into an MP4 at `output_mp4`. Video is stream-copied (no re-encode);
/// audio is encoded to AAC.
///
/// **Track layout** when ≥ 2 audio sources are present:
///   - track 0: combined mix of every source (via ffmpeg's `amix` filter).
///     This is what default playback / single-track players hear.
///   - tracks 1..=N: one per source, in input order, so you can switch to
///     "just mic" or "just system" in a player that supports track selection.
///
/// With 0 or 1 source the mix track is omitted (it would be redundant).
///
/// `ffmpeg` is the binary to invoke — pass `Path::new("ffmpeg")` to use
/// whatever's on `PATH`, or an absolute path to override.
pub fn mux_with_ffmpeg_cli(
    ffmpeg: &Path,
    video_h264: &Path,
    video_fps: f64,
    audio_tracks: &[AudioTrack],
    output_mp4: &Path,
) -> Result<()> {
    if !video_h264.exists() {
        bail!("video input does not exist: {}", video_h264.display());
    }
    for t in audio_tracks {
        if !t.path.exists() {
            bail!("audio input does not exist: {}", t.path.display());
        }
    }

    let do_mix = audio_tracks.len() >= 2;

    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-y").arg("-hide_banner").arg("-loglevel").arg("warning");

    // Input 0: raw H.264, tell ffmpeg the framerate so PTS are assigned.
    // Pass the *actual* fps measured from PTS (frames / pts_span) — not
    // the target fps from config. Under load the capture loop drops
    // frames, so target-fps would compress the video timeline and the
    // audio would visibly drift later as the clip plays.
    cmd.arg("-framerate")
        .arg(format!("{:.6}", video_fps))
        .arg("-i")
        .arg(video_h264);

    // Inputs 1..N: one per audio track. `-itsoffset` shifts the audio
    // start by the gap between the first audio packet's QPC and the
    // video IDR's QPC, so playback aligns at frame 0.
    for t in audio_tracks {
        if t.offset_secs.abs() > 1e-4 {
            cmd.arg("-itsoffset").arg(format!("{:.6}", t.offset_secs));
        }
        cmd.arg("-i").arg(&t.path);
    }

    // If we have ≥ 2 sources, build an `amix` filter that combines them
    // into a single `[mix]` pad. `normalize=0` keeps each input at full
    // gain (i.e. sum, may clip on extreme signals) instead of the default
    // 1/N attenuation which makes 2-source mixes sound half-volume.
    if do_mix {
        let mut fc = String::new();
        for i in 0..audio_tracks.len() {
            fc.push_str(&format!("[{}:a]", i + 1));
        }
        fc.push_str(&format!(
            "amix=inputs={}:duration=longest:normalize=0[mix]",
            audio_tracks.len()
        ));
        cmd.arg("-filter_complex").arg(&fc);
    }

    // ---- map streams in OUTPUT order --------------------------------
    cmd.arg("-map").arg("0:v:0");

    // Output audio stream index — increments as we add maps.
    let mut out_a_idx: usize = 0;
    if do_mix {
        cmd.arg("-map").arg("[mix]");
        cmd.arg(format!("-metadata:s:a:{}", out_a_idx))
            .arg("title=Mix");
        out_a_idx += 1;
    }
    for (idx, t) in audio_tracks.iter().enumerate() {
        cmd.arg("-map").arg(format!("{}:a:0", idx + 1));
        cmd.arg(format!("-metadata:s:a:{}", out_a_idx))
            .arg(format!("title={}", t.title));
        out_a_idx += 1;
    }

    // Codec: video stream-copy, audio re-encode to AAC.
    cmd.arg("-c:v").arg("copy");
    if !audio_tracks.is_empty() {
        cmd.arg("-c:a").arg("aac");
        // Bitrates per output audio stream. Mix gets the first track's
        // bitrate (good-enough heuristic; users can override later by
        // exposing per-track bitrates in config).
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

    // `+faststart` rewrites the moov atom to the front so the file is
    // streamable; cheap on a 3s clip.
    cmd.arg("-movflags").arg("+faststart");

    cmd.arg(output_mp4);

    debug!(?cmd, "running ffmpeg mux");

    // Stream ffmpeg's stderr to our stderr so warnings/progress are visible.
    cmd.stdout(Stdio::null()).stderr(Stdio::inherit());

    let status = cmd
        .status()
        .with_context(|| format!("failed to spawn ffmpeg at {}", ffmpeg.display()))?;
    if !status.success() {
        return Err(anyhow!(
            "ffmpeg exited with status {}",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into())
        ));
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

/// Resolve the `ffmpeg` binary path with this precedence:
/// 1. **Explicit override** from config (`output.ffmpeg_path`) — wins
///    unconditionally if set.
/// 2. **Bundled** alongside the running `clipdip` binary (sibling
///    `ffmpeg.exe` on Windows, `ffmpeg` elsewhere). This is what lets
///    us ship the installer plug-and-play: drop ffmpeg next to
///    clipdip.exe and end users don't have to install it themselves.
/// 3. **PATH fallback** — the literal name `"ffmpeg"`, which the OS
///    resolves through the standard search path. Useful for `cargo
///    run` during dev when no bundled binary exists yet.
pub fn resolve_ffmpeg_path(override_path: Option<&Path>) -> PathBuf {
    if let Some(p) = override_path {
        return p.to_path_buf();
    }
    if let Some(bundled) = bundled_ffmpeg() {
        return bundled;
    }
    PathBuf::from("ffmpeg")
}

/// Look for an `ffmpeg` binary sibling to the running executable. Returns
/// the path only if the file actually exists — otherwise the caller
/// should fall through to the PATH lookup (`cargo run` builds end up
/// in `target/debug` without a bundled binary, and we don't want to
/// hand back a non-existent path).
fn bundled_ffmpeg() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let candidate = dir.join(name);
    candidate.is_file().then_some(candidate)
}

// ---- future: libavformat-based fragmented MP4 ---------------------------

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
    // Fields land with the libavformat path:
    //   fmt_ctx:   *mut ffmpeg::sys::AVFormatContext
    //   v_stream:  *mut AVStream
    //   a_streams: Vec<*mut AVStream>
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
