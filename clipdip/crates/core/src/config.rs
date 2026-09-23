//! User-facing pipeline configuration; single source of truth for the smoke binary
//! walking-skeleton, and Tauri UI. Persisted as TOML at `%APPDATA%\clipdip\config.toml`
//! see [`Config::path`]. `#[serde(default)]` on every field so old files load with gaps.

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
    pub metadata: MetadataConfig,
    pub discord: DiscordConfig,
    pub telemetry: TelemetryConfig,
    pub memory: MemoryConfig,
    /// Ring buffer evicts by time to hold exactly this much footage; see
    /// [`Config::ring_byte_budget`] for the memory ceiling.
    pub replay_seconds: u32,
    /// Files older than this marker deserialize as 0 and get each migration
    /// up to [`CONFIG_REVISION`] applied once; then values become free user choices again.
    #[serde(default)]
    pub config_revision: u32,
}

/// Bump when adding a migration to [`Config::migrate`].
pub const CONFIG_REVISION: u32 = 1;

impl Default for Config {
    fn default() -> Self {
        Self {
            video: VideoConfig::default(),
            audio: AudioConfig::default(),
            output: OutputConfig::default(),
            hotkey: HotkeyConfig::default(),
            notifications: NotificationsConfig::default(),
            profile: ProfileConfig::default(),
            metadata: MetadataConfig::default(),
            discord: DiscordConfig::default(),
            telemetry: TelemetryConfig::default(),
            memory: MemoryConfig::default(),
            replay_seconds: 60,
            config_revision: CONFIG_REVISION,
        }
    }
}

/// Deliberate overestimate of NVENC output at preset QPs (16-32) even at 4K
/// high-motion, so byte eviction stays a backstop, not the buffer's sizing mechanism.
const CQP_SAFETY_BPS: u64 = 150_000_000;

/// Raw f32-48k PCM allowance alongside video; covers two 8-channel/7.1
/// sources with margin (issue #4: 8ch loopback measured 1.54 MB/s).
const AUDIO_PCM_ALLOWANCE_BPS: u64 = 32_000_000;

/// Replay-buffer memory policy.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryConfig {
    /// `0` (default) sizes automatically from quality mode and physical RAM.
    /// Clamped to half of physical RAM; applies on next pipeline (re)start.
    pub max_ring_mb: u32,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self { max_ring_mb: 0 }
    }
}

/// Falls back to 8 GiB if `GlobalMemoryStatusEx` fails. `pub` for telemetry reuse.
pub fn physical_ram_bytes() -> u64 {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // SAFETY: `status` is a properly initialized MEMORYSTATUSEX with
    // dwLength set, as the API requires.
    match unsafe { GlobalMemoryStatusEx(&mut status) } {
        Ok(()) => status.ullTotalPhys,
        Err(_) => 8 * 1024 * 1024 * 1024,
    }
}

impl Config {
    /// `%APPDATA%\clipdip\config\config.toml` on Windows. Empty `organization`
    /// avoids `directories` joining org+app into `clipdip\clipdip\config\...`.
    pub fn path() -> Result<PathBuf> {
        let dirs = directories::ProjectDirs::from("", "", "clipdip")
            .context("could not resolve user config directory")?;
        Ok(dirs.config_dir().join("config.toml"))
    }

    /// Writes a fresh default config to `path` if it doesn't exist yet.
    pub fn load_or_default(path: &Path) -> Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(s) => {
                let mut cfg: Self = toml::from_str(&s)
                    .inspect_err(|e| {
                        // corrupt config: settings vanish either way; hour-gated since this
                        // runs on every save/restart. line/col + size only, toml's error
                        // text can quote file content (paths, device ids)
                        if let clipdip_diagnostics::Gate::Send { suppressed } =
                            clipdip_diagnostics::gate(
                                "config_parse_failed",
                                std::time::Duration::from_secs(3600),
                            )
                        {
                            clipdip_diagnostics::report_error(
                                "config_parse_failed",
                                "config.toml failed to parse",
                                Some(serde_json::json!({
                                    "span": e.span().map(|s| format!("{s:?}")),
                                    "file_bytes": s.len(),
                                    "bak_exists": path.with_extension("toml.bak").exists(),
                                    "occurrences": suppressed + 1,
                                })),
                            );
                        }
                    })
                    .with_context(|| format!("parse {}", path.display()))?;
                // a downgraded binary strips config_revision on save, which would
                // re-run migrations on the user's deliberate values; the sidecar
                // marker survives that, so once it exists migrations only restamp
                let marker = path.with_extension("toml.migrated");
                if cfg.migrate(marker.exists()) {
                    let from_revision = cfg.config_revision; // already restamped; informational
                    // toml serializer is comment-lossy, keep a one-time pre-migration backup
                    let backup = path.with_extension("toml.bak");
                    if !backup.exists() {
                        let _ = std::fs::copy(path, &backup);
                    }
                    // failed save just re-runs next load; migrations are idempotent
                    let mut save_ok = true;
                    let mut marker_ok = true;
                    if let Err(e) = cfg.save(path) {
                        tracing::warn!("config migration save failed: {e:#}");
                        save_ok = false;
                    }
                    if let Err(e) = std::fs::write(&marker, CONFIG_REVISION.to_string()) {
                        tracing::warn!("config migration marker write failed: {e:#}");
                        marker_ok = false;
                    }
                    // a failed migration save re-runs this block every load, hence the gate
                    if let clipdip_diagnostics::Gate::Send { .. } = clipdip_diagnostics::gate(
                        "config_migrated",
                        std::time::Duration::from_secs(3600),
                    ) {
                        if save_ok {
                            clipdip_diagnostics::report_custom(
                                "config_migrated",
                                clipdip_diagnostics::Severity::Info,
                                format!("config migrated to revision {CONFIG_REVISION}"),
                                Some(serde_json::json!({
                                    "to_revision": CONFIG_REVISION,
                                    "restamped_revision": from_revision,
                                    "marker_ok": marker_ok,
                                })),
                            );
                        } else {
                            clipdip_diagnostics::report_error(
                                "config_migration_save_failed",
                                "config migration computed but could not be persisted",
                                Some(serde_json::json!({
                                    "to_revision": CONFIG_REVISION,
                                    "marker_ok": marker_ok,
                                })),
                            );
                        }
                    }
                }
                Ok(cfg)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let cfg = Self::default();
                cfg.save(path)?;
                Ok(cfg)
            }
            Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
        }
    }

    /// Returns true if anything changed (caller persists). With `already_migrated`
    /// value changes are skipped and only the revision is restamped.
    fn migrate(&mut self, already_migrated: bool) -> bool {
        if self.config_revision >= CONFIG_REVISION {
            return false;
        }
        if !already_migrated && self.config_revision < 1 {
            // rev 1: default gop_seconds moved 1.0 -> 2.0; pre-rev configs persist
            // exactly 1.0 since writers rewrite the whole file, so it means "old default"
            if (self.video.gop_seconds - 1.0).abs() < f32::EPSILON {
                self.video.gop_seconds = 2.0;
            }
        }
        self.config_revision = CONFIG_REVISION;
        true
    }

    /// Writes atomically (tmp file + rename).
    pub fn save(&self, path: &Path) -> Result<()> {
        // a failed save means settings silently don't stick
        let report = |stage: &'static str, kind: Option<std::io::ErrorKind>| {
            if let clipdip_diagnostics::Gate::Send { suppressed } =
                clipdip_diagnostics::gate("config_save_failed", std::time::Duration::from_secs(60))
            {
                clipdip_diagnostics::report_error(
                    "config_save_failed",
                    format!("config save failed at {stage}"),
                    Some(serde_json::json!({
                        "stage": stage,
                        "io_kind": kind.map(|k| format!("{k:?}")),
                        "occurrences": suppressed + 1,
                    })),
                );
            }
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .inspect_err(|e| report("dir", Some(e.kind())))
                .with_context(|| format!("create dir {}", parent.display()))?;
        }
        let body = toml::to_string_pretty(self)
            .inspect_err(|_| report("serialize", None))
            .context("serialize config to TOML")?;
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, body)
            .inspect_err(|e| report("write", Some(e.kind())))
            .with_context(|| format!("write {}", tmp.display()))?;
        std::fs::rename(&tmp, path)
            .inspect_err(|e| report("rename", Some(e.kind())))
            .with_context(|| format!("rename into {}", path.display()))?;
        Ok(())
    }

    /// Safety ceiling, not the sizing mechanism: the ring evicts by time
    /// (`replay_seconds`), so this normally sits well above resident memory.
    /// CQP uses `CQP_SAFETY_BPS`; VBR uses 2x the average target; both clamp to RAM.
    pub fn ring_byte_budget(&self) -> usize {
        self.ring_byte_budget_with_ram(physical_ram_bytes())
    }

    /// [`Config::ring_byte_budget`] with RAM injected, for tests.
    fn ring_byte_budget_with_ram(&self, phys_ram: u64) -> usize {
        const MIB: u64 = 1024 * 1024;
        let window = self.replay_seconds as u64;
        let budget = if self.memory.max_ring_mb > 0 {
            (self.memory.max_ring_mb as u64 * MIB).min(phys_ram / 2)
        } else {
            let video = match self.video.rate_control {
                RateControlCfg::Vbr { avg_bps } => window * avg_bps as u64 / 8 * 2,
                RateControlCfg::ConstantQp { .. } => window * CQP_SAFETY_BPS / 8,
            };
            let audio = window * AUDIO_PCM_ALLOWANCE_BPS / 8;
            let ram_clamp = (phys_ram / 4).clamp(1024 * MIB, 4096 * MIB);
            (video + audio).min(ram_clamp)
        };
        (budget as usize).max(1024 * 1024)
    }

    /// Replay window in 100ns ticks, with slack over `replay_seconds` so save
    /// always finds an IDR at/before the window start. Slack must exceed one GOP.
    pub fn ring_time_window_100ns(&self) -> i64 {
        let slack = (self.video.gop_seconds.max(1.0) + 1.0).max(2.0) as f64;
        ((self.replay_seconds as f64 + slack) * 1e7) as i64
    }
}

// video

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct VideoConfig {
    /// Which monitor to capture. 0 = primary.
    pub output_index: u32,
    /// `auto` (default) tries Windows.Graphics.Capture (sees fullscreen-exclusive/
    /// independent-flip/MPO content DXGI misses) and falls back to DXGI if WGC can't start.
    pub capture_backend: CaptureBackendCfg,
    pub fps: u32,
    /// Seeds the VBR slider in the UI only; the encoder reads `rate_control.avg_bps`
    /// and ring sizing derives from the rate-control mode directly (issue #4).
    pub bitrate_bps: u32,
    /// Composite the OS cursor onto each frame; DXGI never includes it natively.
    pub include_cursor: bool,
    /// IDR interval in seconds. 2.0 default: idle bitrate scales inversely with
    /// this and 1.0 measured ~2x the idle size for no visible benefit.
    pub gop_seconds: f32,
    /// `PreferAv1` (default) uses AV1 on RTX 40-series+, falls back to H.264 elsewhere.
    pub codec: CodecPreferenceCfg,
    /// Default is CQP (bitrate floats with scene complexity), same model as ShadowPlay.
    pub rate_control: RateControlCfg,
    /// Ceiling on `ConstantQp` (VBR caps itself). `None` = automatic per-tier cap
    /// via [`max_bps_for_quality`] (issue #4: 98 Mbps at "Balanced"). `Some(0)` = uncapped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality_cap_bps: Option<u32>,
    /// Quality while a manual recording is active; defaults higher (QP 14, ~2x
    /// bitrate) than the replay buffer. Applied via NVENC reconfigure on start/stop.
    pub recording_quality: RecordingQualityCfg,
}

impl Default for VideoConfig {
    fn default() -> Self {
        Self {
            output_index: 0,
            capture_backend: CaptureBackendCfg::default(),
            fps: 60,
            bitrate_bps: 30_000_000,
            include_cursor: true,
            gop_seconds: 2.0,
            codec: CodecPreferenceCfg::default(),
            quality_cap_bps: None,
            rate_control: RateControlCfg::default(),
            recording_quality: RecordingQualityCfg::default(),
        }
    }
}

/// Mirrors `clipdip_capture::CaptureBackend`.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureBackendCfg {
    #[default]
    Auto,
    Wgc,
    Dxgi,
}

/// Mirrors [`clipdip_encoder::CodecPreference`]; kept separate so config
/// doesn't depend on encoder internals.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CodecPreferenceCfg {
    #[default]
    PreferAv1,
    ForceH264,
    ForceAv1,
}

/// Mirrors [`clipdip_encoder::RateControl`].
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum RateControlCfg {
    /// `qp` is codec-specific (H.264 ~20, AV1 ~28 default). With
    /// [`VideoConfig::quality_cap_bps`] this caps runaway scenes only.
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

/// Referenced to 1440p60 H264 (scaled by pixel rate, AV1 derated ~0.6x).
/// Generous on purpose: bounds the runaway tail, not ordinary clips.
pub fn max_bps_for_quality(qp: u32) -> u32 {
    match qp {
        q if q >= 32 => 25_000_000,  // Space saver
        q if q >= 26 => 60_000_000,  // Balanced
        q if q >= 20 => 80_000_000,  // High quality
        _ => 100_000_000,            // Maximum
    }
}

fn default_qp() -> u32 {
    20 // H.264 0-51 range, visually-lossless-ish; also fine for AV1's 0-255 scale
}

/// Only meaningful under `ConstantQp`: NVENC can't switch rate-control mode
/// live, so VBR recordings keep the configured average bitrate.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum RecordingQualityCfg {
    /// Recordings use the same quality as replay-buffer clips.
    MatchClips,
    /// H.264 0-51 scale (AV1 matched internally); never lowers quality
    /// clamped to the clip QP.
    ConstantQp {
        #[serde(default = "default_recording_qp")]
        qp: u32,
    },
}

impl Default for RecordingQualityCfg {
    fn default() -> Self {
        Self::ConstantQp {
            qp: default_recording_qp(),
        }
    }
}

fn default_recording_qp() -> u32 {
    14 // +6 QP ~ half bitrate, so ~2x the QP-20 clip default: upload-clean, not lossless-sized
}

// audio

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AudioConfig {
    /// Each entry is captured on its own thread, muxed as a separate track.
    /// Empty = no audio.
    pub sources: Vec<AudioSource>,
    /// With 2+ sources, prepends a combined "Mix" track (`amix`) as the
    /// first stream; ignored with only one source.
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
                AudioSource::SystemLoopback {
                    device_id: None,
                    device_name: None,
                    fallbacks: Vec::new(),
                },
                AudioSource::Microphone {
                    device_id: None,
                    device_name: None,
                    fallbacks: Vec::new(),
                },
            ],
            include_mix: true,
        }
    }
}

/// Use the system default endpoint; WASAPI ids always look like
/// `{0.0.X.00000000}.{guid}` so this can't collide.
pub const DEFAULT_DEVICE_SENTINEL: &str = "default";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AudioSource {
    /// `device_id = None` uses system default; `Some(id)` pins one (see
    /// `clipdip --list-audio-devices`). `fallbacks` tried in order if the
    /// primary doesn't start; empty means a missing pinned device records nothing.
    /// `device_name` is the pinned endpoint's friendly name: windows mints a new
    /// endpoint id when a usb device moves ports or its driver reinstalls, and
    /// the name is how the pipeline finds it again (learned on first good start)
    SystemLoopback {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device_name: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        fallbacks: Vec<String>,
    },
    /// Same `device_id`/`device_name`/`fallbacks` conventions as `SystemLoopback`.
    Microphone {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device_name: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        fallbacks: Vec<String>,
    },
    /// Windows 10 20348+. Not yet wired in, reserved for config forward-compat.
    ProcessLoopback { process_name: String },
}

impl AudioSource {
    /// Label for logs/sidecars; pinned devices get a suffix to avoid WAV filename collisions.
    pub fn label(&self) -> String {
        match self {
            AudioSource::SystemLoopback { device_id: None, .. } => "loopback".into(),
            AudioSource::SystemLoopback { device_id: Some(id), .. } => {
                format!("loopback-{}", short_id(id))
            }
            AudioSource::Microphone { device_id: None, .. } => "mic".into(),
            AudioSource::Microphone { device_id: Some(id), .. } => {
                format!("mic-{}", short_id(id))
            }
            AudioSource::ProcessLoopback { process_name } => {
                format!("proc-{}", sanitize(process_name))
            }
        }
    }

    /// Pinned device ID, if any.
    pub fn device_id(&self) -> Option<&str> {
        match self {
            AudioSource::SystemLoopback { device_id, .. }
            | AudioSource::Microphone { device_id, .. } => device_id.as_deref(),
            AudioSource::ProcessLoopback { .. } => None,
        }
    }

    /// Friendly name saved alongside the pin, if any.
    pub fn device_name(&self) -> Option<&str> {
        match self {
            AudioSource::SystemLoopback { device_name, .. }
            | AudioSource::Microphone { device_name, .. } => device_name.as_deref(),
            AudioSource::ProcessLoopback { .. } => None,
        }
    }

    /// Rewrites the pin after the pipeline found it under a new id or learned its
    /// name. Returns false when nothing changed (or the source has no pin).
    pub fn set_pin(&mut self, id: &str, name: &str) -> bool {
        match self {
            AudioSource::SystemLoopback { device_id, device_name, .. }
            | AudioSource::Microphone { device_id, device_name, .. } => {
                if device_id.as_deref() == Some(id) && device_name.as_deref() == Some(name) {
                    return false;
                }
                *device_id = Some(id.to_string());
                *device_name = Some(name.to_string());
                true
            }
            AudioSource::ProcessLoopback { .. } => false,
        }
    }

    /// May include [`DEFAULT_DEVICE_SENTINEL`]; empty for `ProcessLoopback`.
    pub fn fallbacks(&self) -> &[String] {
        match self {
            AudioSource::SystemLoopback { fallbacks, .. }
            | AudioSource::Microphone { fallbacks, .. } => fallbacks,
            AudioSource::ProcessLoopback { .. } => &[],
        }
    }
}

/// Last 8 hex chars of a WASAPI ID, for a stable short label.
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

// output

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct OutputConfig {
    /// Directory clips are written to.
    pub directory: PathBuf,
    /// `[token]` template, no extension; see [`crate::filename`]. Sidecars and
    /// the mp4 derive from the expanded stem; collisions get a ` (2)` suffix.
    pub filename_stem: String,
    /// `None` = whatever's on `PATH`.
    pub ffmpeg_path: Option<PathBuf>,
    /// Keep intermediate `.h264`/`.wav` files after the mp4 mux completes.
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
            filename_stem: "[app] [HH].[mm].[ss] - [dd].[MM].[yyyy]".into(),
            ffmpeg_path: None,
            keep_sidecars: true,
            audio_bitrate_bps: 192_000,
        }
    }
}

// hotkey

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct HotkeyConfig {
    /// Shortcut that triggers `save_clip`.
    pub save_clip: String,
    /// Shortcut that activates the rename input in the clip notification overlay.
    pub rename_clip: String,
    /// First press marks the start; second press saves everything since as a clip.
    pub toggle_recording: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            save_clip: "Ctrl+Alt+F10".into(),
            rename_clip: "Ctrl+F10".into(),
            toggle_recording: "Ctrl+Alt+F9".into(),
        }
    }
}

// notifications

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
    /// Native toast on runtime capture degradation (stall, replay window
    /// shrinking); independent of the per-save overlay notification.
    pub health_alerts: bool,
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            sound: true,
            corner: NotificationCorner::TopRight,
            auto_dismiss_secs: 10,
            health_alerts: true,
        }
    }
}

// profile

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ProfileConfig {
    /// Only consulted with profiling enabled (`--profile` or `CLIPDIP_PROFILE=1`).
    pub report_interval_ms: u64,
}

impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            report_interval_ms: 5_000,
        }
    }
}

// metadata

/// When enabled, each clip gets a `{directory}/.clip_metadata/{clip}.gameinfo`
/// sidecar with the foreground window title, and optionally an extracted icon.
/// Disabled by default since it touches the foreground HWND and process image.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct MetadataConfig {
    pub enabled: bool,
    /// Extracts the foreground exe's icon to `icons/{exe-basename}.png`;
    /// skipped if it already exists (one-time cost per game).
    pub capture_icon: bool,
    /// Lower-cased exe basenames to skip (e.g. `explorer.exe`).
    pub ignored_processes: Vec<String>,
}

impl Default for MetadataConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            capture_icon: true,
            ignored_processes: default_ignored_processes(),
        }
    }
}

// discord

/// Records the Discord voice-call roster (ids + names) into the clip's
/// `.gameinfo` sidecar, via local RPC, no server bot. Enabled by default
/// but no-ops until the user completes onboarding's one-time authorization.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct DiscordConfig {
    pub enabled: bool,
}

impl Default for DiscordConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

// telemetry

/// Anonymous, opt-out diagnostics: crash/failure reports plus a heartbeat
/// keyed to a random per-install id, no accounts or PII. `enabled = false`
/// stops all network calls; also no-ops without a compiled-in ingest key.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct TelemetryConfig {
    pub enabled: bool,
}

impl Default for TelemetryConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

fn default_ignored_processes() -> Vec<String> {
    [
        "explorer.exe", "systemsettings.exe", "searchui.exe", "searchapp.exe",
        "shellexperiencehost.exe", "startmenuexperiencehost.exe", "taskmgr.exe",
        "snippingtool.exe", "snipandsketch.exe", "lockapp.exe", "ctfmon.exe",
        "sihost.exe", "applicationframehost.exe", "runtimebroker.exe",
        "smartscreen.exe", "werfault.exe", "cmd.exe", "powershell.exe",
        "windowsterminal.exe", "wt.exe", "conhost.exe", "rundll32.exe",
        "msiexec.exe", "setup.exe",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_round_trips_through_toml() {
        let cfg = Config::default();
        let s = toml::to_string_pretty(&cfg).unwrap();
        let back: Config = toml::from_str(&s).unwrap();
        // spot-check a few fields rather than implementing PartialEq
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
    fn audio_fallbacks_parse_and_round_trip() {
        // old configs (no fallbacks key) parse to an empty chain
        let cfg: Config = toml::from_str(
            r#"
            [[audio.sources]]
            kind = "system_loopback"
            device_id = "{0.0.0.00000000}.{aaaa}"
            fallbacks = ["{0.0.0.00000000}.{bbbb}", "default"]

            [[audio.sources]]
            kind = "microphone"
            "#,
        )
        .unwrap();
        assert_eq!(
            cfg.audio.sources[0].fallbacks(),
            &["{0.0.0.00000000}.{bbbb}".to_string(), DEFAULT_DEVICE_SENTINEL.to_string()]
        );
        assert!(cfg.audio.sources[1].fallbacks().is_empty());

        let out = toml::to_string(&cfg).unwrap();
        let back: Config = toml::from_str(&out).unwrap();
        assert_eq!(back.audio.sources[0].fallbacks().len(), 2);
        // empty chains stay off disk entirely
        assert!(!out.contains("fallbacks = []"));
    }

    #[test]
    fn device_name_round_trips_and_set_pin_reports_change() {
        let mut cfg: Config = toml::from_str(
            r#"
            [[audio.sources]]
            kind = "microphone"
            device_id = "{0.0.1.00000000}.{aaaa}"
            "#,
        )
        .unwrap();
        assert_eq!(cfg.audio.sources[0].device_name(), None);
        assert!(cfg.audio.sources[0].set_pin("{0.0.1.00000000}.{bbbb}", "Mikrofon (Auna Mic CM900)"));
        assert!(!cfg.audio.sources[0].set_pin("{0.0.1.00000000}.{bbbb}", "Mikrofon (Auna Mic CM900)"));

        let out = toml::to_string(&cfg).unwrap();
        let back: Config = toml::from_str(&out).unwrap();
        assert_eq!(back.audio.sources[0].device_id(), Some("{0.0.1.00000000}.{bbbb}"));
        assert_eq!(back.audio.sources[0].device_name(), Some("Mikrofon (Auna Mic CM900)"));
        // unpinned sources keep the key off disk
        assert!(!toml::to_string(&Config::default()).unwrap().contains("device_name"));
    }

    #[test]
    fn missing_keys_fall_back_to_defaults() {
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
        // floor at 1 MiB so a degenerate config doesn't yield a zero ring
        assert!(cfg.ring_byte_budget() >= 1024 * 1024);
    }

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn cqp_budget_ignores_bitrate_bps_and_scales_with_window() {
        // issue #4: bitrate_bps must play no role under CQP
        let mut cfg = Config::default();
        cfg.replay_seconds = 120;
        cfg.video.bitrate_bps = 5_000_000; // stale VBR leftover, must be inert
        let budget = cfg.ring_byte_budget_with_ram(32 * GIB) as u64;
        let expected = 120 * (CQP_SAFETY_BPS + AUDIO_PCM_ALLOWANCE_BPS) / 8;
        assert_eq!(budget, expected.min(4096 * 1024 * 1024));
        // far above the old fiction-derived 900 MB cap
        assert!(budget > 2 * GIB, "got {budget}");
    }

    #[test]
    fn vbr_budget_uses_encoder_target_plus_audio() {
        let mut cfg = Config::default();
        cfg.replay_seconds = 120;
        cfg.video.rate_control = RateControlCfg::Vbr { avg_bps: 5_000_000 };
        let budget = cfg.ring_byte_budget_with_ram(32 * GIB) as u64;
        let expected = 120 * (5_000_000u64 * 2 + AUDIO_PCM_ALLOWANCE_BPS) / 8;
        assert_eq!(budget, expected);
        // old 5-Mbps trap produced a 150 MB budget; audio allowance alone beats that
        assert!(budget > 300 * 1024 * 1024, "got {budget}");
    }

    #[test]
    fn ram_clamp_bounds_the_automatic_budget() {
        let mut cfg = Config::default();
        cfg.replay_seconds = 300; // slider max, would want ~6 GiB unclamped
        assert_eq!(cfg.ring_byte_budget_with_ram(8 * GIB) as u64, 2 * GIB); // phys/4
        assert_eq!(cfg.ring_byte_budget_with_ram(64 * GIB) as u64, 4 * GIB); // saturates
        // floors at 1 GiB
        assert_eq!(cfg.ring_byte_budget_with_ram(2 * GIB) as u64, 1 * GIB);
    }

    #[test]
    fn manual_override_is_respected_and_ram_guarded() {
        let mut cfg = Config::default();
        cfg.replay_seconds = 120;
        cfg.memory.max_ring_mb = 300;
        assert_eq!(
            cfg.ring_byte_budget_with_ram(32 * GIB) as u64,
            300 * 1024 * 1024
        );
        // hand-edited far past physical RAM: guarded to half of it
        cfg.memory.max_ring_mb = 1_000_000;
        assert_eq!(cfg.ring_byte_budget_with_ram(8 * GIB) as u64, 4 * GIB);
    }

    #[test]
    fn quality_cap_defaults_to_auto_and_stays_off_disk() {
        let cfg = Config::default();
        assert_eq!(cfg.video.quality_cap_bps, None);
        let s = toml::to_string_pretty(&cfg).unwrap();
        assert!(!s.contains("quality_cap_bps"));
        let old: Config = toml::from_str("replay_seconds = 60").unwrap();
        assert_eq!(old.video.quality_cap_bps, None);

        let cfg: Config =
            toml::from_str("[video]\nquality_cap_bps = 0\n").unwrap();
        assert_eq!(cfg.video.quality_cap_bps, Some(0));
    }

    #[test]
    fn quality_cap_ladder_is_generous_and_monotonic() {
        assert_eq!(max_bps_for_quality(32), 25_000_000); // Space saver
        assert_eq!(max_bps_for_quality(26), 60_000_000); // Balanced
        assert_eq!(max_bps_for_quality(20), 80_000_000); // High (default)
        assert_eq!(max_bps_for_quality(16), 100_000_000); // Maximum
        // issue #4: Balanced bursts measured ~98 Mbps, capped at 60, still above ShadowPlay's 40
        assert!(max_bps_for_quality(26) > 40_000_000);
    }

    #[test]
    fn migration_bumps_old_default_gop_once() {
        let mut cfg: Config =
            toml::from_str("replay_seconds = 60\n[video]\ngop_seconds = 1.0\n").unwrap();
        assert_eq!(cfg.config_revision, 0);
        assert!(cfg.migrate(false));
        assert_eq!(cfg.video.gop_seconds, 2.0);
        assert_eq!(cfg.config_revision, CONFIG_REVISION);
        assert!(!cfg.migrate(false)); // idempotent

        // deliberate non-default value: revision stamped, value untouched
        let mut cfg: Config =
            toml::from_str("replay_seconds = 60\n[video]\ngop_seconds = 0.5\n").unwrap();
        assert!(cfg.migrate(false));
        assert_eq!(cfg.video.gop_seconds, 0.5);

        // user chose 1.0 on purpose post-revision: kept
        let mut cfg: Config = toml::from_str(
            "replay_seconds = 60\nconfig_revision = 1\n[video]\ngop_seconds = 1.0\n",
        )
        .unwrap();
        assert!(!cfg.migrate(false));
        assert_eq!(cfg.video.gop_seconds, 1.0);

        // stamp stripped by an old binary, marker says already migrated: restamp only
        let mut cfg: Config =
            toml::from_str("replay_seconds = 60\n[video]\ngop_seconds = 1.0\n").unwrap();
        assert!(cfg.migrate(true));
        assert_eq!(cfg.video.gop_seconds, 1.0);
        assert_eq!(cfg.config_revision, CONFIG_REVISION);
    }

    #[test]
    fn ring_slack_tracks_gop_length() {
        let mut cfg = Config::default();
        cfg.replay_seconds = 60;
        assert_eq!(cfg.ring_time_window_100ns(), 63 * 10_000_000); // 2s GOP: slack = gop+1
        cfg.video.gop_seconds = 0.5;
        assert_eq!(cfg.ring_time_window_100ns(), 62 * 10_000_000); // 2s floor
        // long GOP grows slack so save always finds an IDR at/before window start
        cfg.video.gop_seconds = 5.0;
        assert_eq!(cfg.ring_time_window_100ns(), 66 * 10_000_000);
    }

    #[test]
    fn legacy_toml_without_memory_section_gets_auto_sizing() {
        // pre-existing configs persist bitrate_bps with no [memory] table
        let cfg: Config = toml::from_str(
            "replay_seconds = 120\n[video]\nbitrate_bps = 30000000\n",
        )
        .unwrap();
        assert_eq!(cfg.memory.max_ring_mb, 0);
        let budget = cfg.ring_byte_budget_with_ram(32 * GIB) as u64;
        assert!(budget > 2 * GIB, "got {budget}");
    }
}
