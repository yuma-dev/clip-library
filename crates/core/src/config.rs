//! User-facing pipeline configuration.
//!
//! This is the single source of truth that the smoke binary, the future
//! walking-skeleton, and the Tauri UI all read from. Persisted as TOML
//! at `%APPDATA%\clipdip\config.toml` (Windows) — see [`Config::path`].
//!
//! Design notes:
//! - Sub-configs (`VideoConfig`, `AudioConfig`, `OutputConfig`) keep the
//!   top-level struct shallow so the TOML file stays human-editable.
//! - `AudioConfig::sources` is `Vec<AudioSource>` so users can add as
//!   many tracks as they want (system loopback + mic + N per-process
//!   captures). Default is `[SystemLoopback, Microphone]`, count = 2.
//! - `serde` `#[serde(default)]` on every field so missing keys in an
//!   old config file fall back to defaults instead of erroring.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Top-level user-editable configuration.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub video: VideoConfig,
    pub audio: AudioConfig,
    pub output: OutputConfig,
    pub hotkey: HotkeyConfig,
    pub notifications: NotificationsConfig,
    pub profile: ProfileConfig,
    /// Replay window in seconds. Ring buffer is sized for this duration at
    /// `video.bitrate_bps` (plus ~20% headroom for audio + muxer overhead).
    pub replay_seconds: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            video: VideoConfig::default(),
            audio: AudioConfig::default(),
            output: OutputConfig::default(),
            hotkey: HotkeyConfig::default(),
            notifications: NotificationsConfig::default(),
            profile: ProfileConfig::default(),
            replay_seconds: 60,
        }
    }
}

impl Config {
    /// Path the config is loaded from / saved to:
    /// `%APPDATA%\clipdip\config\config.toml` on Windows.
    ///
    /// Note: the `organization` segment is intentionally empty — passing
    /// `"clipdip"` for both org and app makes `directories` join them
    /// (`{org}\{app}\config`) and you get `clipdip\clipdip\config\…`.
    /// With empty org you get the cleaner `clipdip\config\…`.
    pub fn path() -> Result<PathBuf> {
        let dirs = directories::ProjectDirs::from("", "", "clipdip")
            .context("could not resolve user config directory")?;
        Ok(dirs.config_dir().join("config.toml"))
    }

    /// Load from `path`. If the file does not exist, write a fresh default
    /// config there and return it.
    pub fn load_or_default(path: &Path) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(s) => toml::from_str(&s).with_context(|| format!("parse {}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let cfg = Self::default();
                cfg.save(path)?;
                Ok(cfg)
            }
            Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
        }
    }

    /// Serialize and write atomically (tmp file + rename).
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create dir {}", parent.display()))?;
        }
        let body = toml::to_string_pretty(self).context("serialize config to TOML")?;
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, body).with_context(|| format!("write {}", tmp.display()))?;
        std::fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
        Ok(())
    }

    /// Byte budget for the packet ring, sized for `replay_seconds` of video
    /// at `video.bitrate_bps` plus 20% headroom for audio + muxer overhead.
    pub fn ring_byte_budget(&self) -> usize {
        let video = (self.replay_seconds as u64 * self.video.bitrate_bps as u64) / 8;
        ((video + video / 5) as usize).max(1024 * 1024)
    }
}

// ---- video --------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct VideoConfig {
    /// DXGI output index — which monitor to capture. 0 = primary.
    pub output_index: u32,
    pub fps: u32,
    /// Used to size the packet ring buffer ([`Config::ring_byte_budget`]).
    /// Under the default CQP rate-control this is a *hint*, not the actual
    /// encoder bitrate — pick generously so the ring isn't undersized on
    /// busy scenes. When `rate_control = Vbr { .. }` it doubles as the
    /// encoder's average-bitrate target.
    pub bitrate_bps: u32,
    /// Composite the OS mouse cursor onto each frame. DXGI Desktop
    /// Duplication never includes it natively.
    pub include_cursor: bool,
    /// IDR (keyframe) interval in seconds.
    pub gop_seconds: f32,
    /// Codec preference. `PreferAv1` (default) uses AV1 on RTX 40-series
    /// and newer, transparently falls back to H.264 elsewhere.
    pub codec: CodecPreferenceCfg,
    /// Rate-control mode. Default is CQP (constant quality, bitrate floats
    /// with scene complexity) — same model as NVIDIA ShadowPlay.
    pub rate_control: RateControlCfg,
}

impl Default for VideoConfig {
    fn default() -> Self {
        Self {
            output_index: 0,
            fps: 60,
            bitrate_bps: 30_000_000,
            include_cursor: true,
            gop_seconds: 1.0,
            codec: CodecPreferenceCfg::default(),
            rate_control: RateControlCfg::default(),
        }
    }
}

/// Serde-friendly mirror of [`clipdip_encoder::CodecPreference`]. Kept
/// separate from the encoder enum so the config crate doesn't have to
/// depend on encoder internals.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodecPreferenceCfg {
    #[default]
    PreferAv1,
    ForceH264,
    ForceAv1,
}

/// Serde-friendly mirror of [`clipdip_encoder::RateControl`].
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum RateControlCfg {
    /// Constant quantization. `qp` scale is codec-specific; if unset the
    /// encoder picks a sensible default (H.264 ~20, AV1 ~28).
    ConstantQp {
        #[serde(default = "default_qp")]
        qp: u32,
    },
    /// Variable bitrate with `avg_bps` average target.
    Vbr { avg_bps: u32 },
}

impl Default for RateControlCfg {
    fn default() -> Self {
        Self::ConstantQp { qp: default_qp() }
    }
}

fn default_qp() -> u32 {
    // 20 sits comfortably inside H.264's 0–51 range (visually-lossless-ish)
    // and is also a perfectly reasonable AV1 QP — AV1 has a wider 0–255
    // scale but the lower end of it is where high-quality clips live.
    20
}

// ---- audio --------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AudioConfig {
    /// Each entry is captured on its own thread and muxed as a separate
    /// audio track. Empty list = no audio at all.
    pub sources: Vec<AudioSource>,
    /// When `true` and at least two sources are captured, the muxer
    /// prepends a combined "Mix" track (sum of all sources via `amix`)
    /// as the first audio stream of the output MP4. With one source the
    /// flag is ignored (a mix of one input would be a redundant copy).
    #[serde(default = "default_include_mix")]
    pub include_mix: bool,
}

fn default_include_mix() -> bool {
    true
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            sources: vec![
                AudioSource::SystemLoopback { device_id: None },
                AudioSource::Microphone { device_id: None },
            ],
            include_mix: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AudioSource {
    /// WASAPI loopback on a render endpoint. `device_id = None` (or
    /// missing) uses the system default render device; `Some(id)` pins a
    /// specific one (use `clipdip --list-audio-devices` to find IDs).
    SystemLoopback {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device_id: Option<String>,
    },
    /// WASAPI capture from a microphone / line-in endpoint. Same
    /// `device_id = None` convention as above.
    Microphone {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device_id: Option<String>,
    },
    /// Per-process loopback (Windows 10 build 20348+). Not yet wired in;
    /// reserving the variant for forward-compatibility of the config file.
    ProcessLoopback { process_name: String },
}

impl AudioSource {
    /// Short human-readable label for logs and sidecar filenames. When a
    /// specific device is pinned we append a short suffix so multiple
    /// sources of the same kind don't collide in the WAV filename.
    pub fn label(&self) -> String {
        match self {
            AudioSource::SystemLoopback { device_id: None } => "loopback".into(),
            AudioSource::SystemLoopback { device_id: Some(id) } => {
                format!("loopback-{}", short_id(id))
            }
            AudioSource::Microphone { device_id: None } => "mic".into(),
            AudioSource::Microphone { device_id: Some(id) } => {
                format!("mic-{}", short_id(id))
            }
            AudioSource::ProcessLoopback { process_name } => {
                format!("proc-{}", sanitize(process_name))
            }
        }
    }

    /// Convenience accessor for the pinned device ID, if any.
    pub fn device_id(&self) -> Option<&str> {
        match self {
            AudioSource::SystemLoopback { device_id }
            | AudioSource::Microphone { device_id } => device_id.as_deref(),
            AudioSource::ProcessLoopback { .. } => None,
        }
    }
}

/// Take the last 8 hex chars of a WASAPI ID to make a stable short label.
fn short_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let len = cleaned.len();
    cleaned[len.saturating_sub(8)..].to_string()
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

// ---- output -------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct OutputConfig {
    /// Directory clips are written to.
    pub directory: PathBuf,
    /// Filename stem (no extension). Sidecars and the final container all
    /// derive from this — e.g. `{stem}.h264`, `{stem}.loopback.wav`, `{stem}.mp4`.
    pub filename_stem: String,
    /// Override path to the `ffmpeg` binary. `None` = use whatever's on
    /// `PATH`. Set this if you have multiple ffmpeg builds installed.
    pub ffmpeg_path: Option<PathBuf>,
    /// Keep the intermediate `.h264` and per-source `.wav` files after the
    /// `.mp4` mux completes. Useful for debugging; turn off in production.
    pub keep_sidecars: bool,
    /// AAC bitrate per audio track in the output MP4.
    pub audio_bitrate_bps: u32,
}

impl Default for OutputConfig {
    fn default() -> Self {
        let dir = directories::UserDirs::new()
            .and_then(|d| d.video_dir().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Clipdip");
        Self {
            directory: dir,
            filename_stem: "clipdip-test".into(),
            ffmpeg_path: None,
            keep_sidecars: true,
            audio_bitrate_bps: 192_000,
        }
    }
}

// ---- hotkey -------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct HotkeyConfig {
    /// Shortcut that triggers `save_clip`.
    pub save_clip: String,
    /// Shortcut that activates the rename input in the clip notification overlay.
    pub rename_clip: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            save_clip: "Ctrl+Alt+F10".into(),
            rename_clip: "Ctrl+F10".into(),
        }
    }
}

// ---- notifications -------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationCorner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Default for NotificationCorner {
    fn default() -> Self {
        Self::BottomRight
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct NotificationsConfig {
    pub enabled: bool,
    pub sound: bool,
    pub corner: NotificationCorner,
    /// Seconds before the notification auto-dismisses (0 = stay until renamed or dismissed).
    pub auto_dismiss_secs: u32,
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            sound: true,
            corner: NotificationCorner::TopRight,
            auto_dismiss_secs: 10,
        }
    }
}

// ---- profile ------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ProfileConfig {
    /// How often the profile reporter thread logs a per-stage summary.
    /// Only consulted when profiling is enabled (via `--profile` or
    /// `CLIPDIP_PROFILE=1`). 5 s is a reasonable trade-off — short
    /// enough to track interactive changes, long enough for stable
    /// percentiles.
    pub report_interval_ms: u64,
}

impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            report_interval_ms: 5_000,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_round_trips_through_toml() {
        let cfg = Config::default();
        let s = toml::to_string_pretty(&cfg).unwrap();
        let back: Config = toml::from_str(&s).unwrap();
        // Spot-check a few fields rather than implementing PartialEq.
        assert_eq!(cfg.video.fps, back.video.fps);
        assert_eq!(cfg.audio.sources.len(), back.audio.sources.len());
        assert_eq!(cfg.replay_seconds, back.replay_seconds);
    }

    #[test]
    fn defaults_to_two_audio_sources() {
        let cfg = Config::default();
        assert_eq!(cfg.audio.sources.len(), 2);
    }

    #[test]
    fn missing_keys_fall_back_to_defaults() {
        // A nearly empty file should still parse — every section uses
        // #[serde(default)].
        let cfg: Config = toml::from_str("replay_seconds = 30").unwrap();
        assert_eq!(cfg.replay_seconds, 30);
        assert_eq!(cfg.video.fps, 60); // default
        assert_eq!(cfg.audio.sources.len(), 2); // default
    }

    #[test]
    fn ring_budget_has_floor() {
        let mut cfg = Config::default();
        cfg.replay_seconds = 0;
        cfg.video.bitrate_bps = 0;
        // Floor at 1 MiB so a degenerate config doesn't yield a zero ring.
        assert!(cfg.ring_byte_budget() >= 1024 * 1024);
    }
}
