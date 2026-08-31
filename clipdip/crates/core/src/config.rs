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
    pub metadata: MetadataConfig,
    pub discord: DiscordConfig,
    pub telemetry: TelemetryConfig,
    pub memory: MemoryConfig,
    /// Replay window in seconds. The ring buffer evicts by time to hold
    /// exactly this much footage; its memory ceiling comes from
    /// [`Config::ring_byte_budget`].
    pub replay_seconds: u32,
    /// One-time-migration marker. Files written before the marker existed
    /// deserialize as 0 (field-level default) and get each migration up to
    /// [`CONFIG_REVISION`] applied exactly once on load; after that the
    /// stamped revision makes every migrated value a free user choice
    /// again. Fresh configs start at the current revision.
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

/// Sizing assumption for the ring's CQP memory ceiling: a deliberate
/// overestimate of what NVENC produces at the preset QPs (16-32) even at
/// 4K high-motion, so byte eviction stays a runaway backstop and never the
/// thing that decides how many seconds the buffer holds. If
/// `ring_memory_pressure` telemetry ever shows real users pinned at the
/// resulting ceiling, bump this (or build measured-rate sizing).
const CQP_SAFETY_BPS: u64 = 150_000_000;

/// Budget allowance for the audio the ring buffers alongside video: raw
/// f32-48k PCM at the endpoint's native channel count. Stereo is ~0.38
/// MB/s per source, but 7.1 surround endpoints are real in the wild
/// (issue #4's reporter: 8-channel loopback = 1.54 MB/s), and WASAPI
/// delivers ~100 packets/s per source, each paying
/// `size_of::<EncodedPacket>()` in accounting overhead. 32 Mbps covers
/// two 8-channel sources with margin.
const AUDIO_PCM_ALLOWANCE_BPS: u64 = 32_000_000;

/// Replay-buffer memory policy.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryConfig {
    /// Manual override for the ring's memory ceiling, in MiB. `0` (the
    /// default) sizes automatically from the quality mode and physical
    /// RAM — the right choice for almost everyone. Hand-edit this only if
    /// the app reports the replay window is limited by memory and you'd
    /// rather spend more RAM than lower quality. Values are clamped to
    /// half of physical RAM. Applies on the next pipeline (re)start.
    pub max_ring_mb: u32,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self { max_ring_mb: 0 }
    }
}

/// Total physical RAM in bytes via `GlobalMemoryStatusEx`. Falls back to
/// 8 GiB if the call fails (it practically can't), keeping the budget sane.
/// `pub` so the telemetry machine profile can reuse it.
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
            Ok(s) => {
                let mut cfg: Self = toml::from_str(&s)
                    .inspect_err(|e| {
                        // Corrupt config: some callers bail (capture loop
                        // dies), others silently run on defaults — either
                        // way a user's settings just vanished. Called on
                        // every save/restart/command, hence the hour gate.
                        // Line/col + size only: toml's error text can quote
                        // file content (paths, device ids).
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
                // A downgraded binary's settings save strips the
                // `config_revision` stamp (it serializes the old struct),
                // which would re-run value migrations against what are
                // now the user's deliberate choices. The sidecar marker
                // survives such rewrites: once it exists, migrations only
                // restamp the revision, never touch values again.
                let marker = path.with_extension("toml.migrated");
                if cfg.migrate(marker.exists()) {
                    let from_revision = cfg.config_revision; // already restamped; informational
                    // One-time keepsake of the pre-migration file — the
                    // TOML serializer is comment-lossy, and this is the
                    // first write hand-editing users didn't initiate.
                    let backup = path.with_extension("toml.bak");
                    if !backup.exists() {
                        let _ = std::fs::copy(path, &backup);
                    }
                    // Persist so the migration runs exactly once; a failed
                    // save just means it re-runs next load, which is
                    // harmless (migrations are idempotent).
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
                    // Once per hour: a *failed* migration save re-runs this
                    // block on every subsequent load.
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

    /// Apply one-time migrations for configs written by older versions.
    /// Returns true if anything changed (caller persists). With
    /// `already_migrated` set (the sidecar marker exists), value changes
    /// are skipped and only the revision is restamped — the missing stamp
    /// then means "an old binary rewrote the file", not "never migrated".
    fn migrate(&mut self, already_migrated: bool) -> bool {
        if self.config_revision >= CONFIG_REVISION {
            return false;
        }
        if !already_migrated && self.config_revision < 1 {
            // Revision 1: the default keyframe interval moved 1.0 -> 2.0
            // (idle bitrate is dominated by the once-per-GOP IDR; see
            // `gop_seconds`). Every pre-revision config persists 1.0
            // explicitly because the writers rewrite the whole file, so
            // exactly 1.0 means "old default", not a user choice.
            if (self.video.gop_seconds - 1.0).abs() < f32::EPSILON {
                self.video.gop_seconds = 2.0;
            }
        }
        self.config_revision = CONFIG_REVISION;
        true
    }

    /// Serialize and write atomically (tmp file + rename).
    pub fn save(&self, path: &Path) -> Result<()> {
        // A failed save means the user's settings silently don't stick.
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

    /// Byte budget for the packet ring. This is a *safety ceiling*, not the
    /// sizing mechanism — the ring evicts by time (`replay_seconds`), so
    /// resident memory tracks the encoder's actual bitrate and normally
    /// sits well below this cap.
    ///
    /// Derivation (issue #4): under constant-QP the encoder has no bitrate
    /// target, so the ceiling comes from `CQP_SAFETY_BPS`, a generous
    /// overestimate of real CQP output. Under VBR the encoder's actual
    /// average target is known, so 2× that absorbs bursts. Both include an
    /// allowance for the raw-PCM audio sharing the ring, and both are
    /// clamped against physical RAM so a big window on a small machine
    /// degrades to an honest "window limited by memory" alert instead of
    /// paging the system out. `memory.max_ring_mb` overrides the automatic
    /// ceiling (still RAM-guarded).
    pub fn ring_byte_budget(&self) -> usize {
        self.ring_byte_budget_with_ram(physical_ram_bytes())
    }

    /// [`Config::ring_byte_budget`] with physical RAM injected, for tests.
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

    /// Replay window in 100-ns ticks for the ring's time-based eviction.
    /// Slack on top of `replay_seconds` so the save path always finds an
    /// IDR at/before the window start — guaranteeing the saved clip covers
    /// the full configured duration. The slack must exceed one GOP: with
    /// eviction cutting at IDR boundaries, less than `gop_seconds` of
    /// slack intermittently leaves no IDR at-or-before the window start
    /// and the save falls back to a truncated clip.
    pub fn ring_time_window_100ns(&self) -> i64 {
        let slack = (self.video.gop_seconds.max(1.0) + 1.0).max(2.0) as f64;
        ((self.replay_seconds as f64 + slack) * 1e7) as i64
    }
}

// ---- video --------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct VideoConfig {
    /// DXGI output index — which monitor to capture. 0 = primary.
    pub output_index: u32,
    /// Which capture API to use. `auto` (default) tries
    /// Windows.Graphics.Capture — which sees fullscreen-exclusive /
    /// independent-flip / MPO-presented games that DXGI Desktop Duplication
    /// is blind to (those clips showed the desktop or a frozen frame) —
    /// and falls back to DXGI Desktop Duplication when WGC can't start.
    /// `wgc` / `dxgi` force a specific backend.
    pub capture_backend: CaptureBackendCfg,
    pub fps: u32,
    /// Seed value for the VBR target-bitrate slider in the settings UIs.
    /// Not read anywhere else: the encoder's VBR target comes from
    /// `rate_control.avg_bps`, and ring sizing
    /// ([`Config::ring_byte_budget`]) derives from the rate-control mode
    /// directly (it historically derived from this field, which under CQP
    /// nothing ever set — issue #4).
    pub bitrate_bps: u32,
    /// Composite the OS mouse cursor onto each frame. DXGI Desktop
    /// Duplication never includes it natively.
    pub include_cursor: bool,
    /// IDR (keyframe) interval in seconds. Default 2.0: on static content
    /// the bitstream is essentially one full-frame IDR per GOP (P-frames
    /// are near-free skips), so idle bitrate scales inversely with this —
    /// 1.0 measured ~2x the idle size of 2.0 for no visible benefit. The
    /// ring's eviction granularity and the worst-case "clip starts early"
    /// overshoot both equal one GOP, which keeps 2.0 comfortable.
    pub gop_seconds: f32,
    /// Codec preference. `PreferAv1` (default) uses AV1 on RTX 40-series
    /// and newer, transparently falls back to H.264 elsewhere.
    pub codec: CodecPreferenceCfg,
    /// Rate-control mode. Default is CQP (constant quality, bitrate floats
    /// with scene complexity) — same model as NVIDIA ShadowPlay.
    pub rate_control: RateControlCfg,
    /// Bitrate ceiling applied on top of `ConstantQp` (ignored under VBR,
    /// which caps itself). `None` (missing key, the default) = automatic:
    /// [`max_bps_for_quality`] picks a generous cap for the quality tier
    /// so runaway scenes can't balloon clips (issue #4: 98 Mbps at
    /// "Balanced"). `Some(0)` = uncapped, the pre-cap behavior. `Some(n)`
    /// = explicit cap in bps, referenced to 1440p60 H264 (scaled by
    /// pixel rate and codec like the automatic value). A separate field —
    /// not a rate-control variant — so configs written by this version
    /// still load on older binaries, which simply ignore the key and run
    /// uncapped CQP.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality_cap_bps: Option<u32>,
    /// Encode quality while a *manual recording* is in progress. Manual
    /// recordings are meant to be kept and uploaded, so they default to a
    /// noticeably higher quality (QP 14 ≈ 2× the bitrate of the QP-20
    /// clip default) than the always-on replay buffer. Applied via NVENC
    /// reconfigure when the recording starts, reverted when it stops.
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

/// Serde-friendly mirror of `clipdip_capture::CaptureBackend`.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureBackendCfg {
    #[default]
    Auto,
    Wgc,
    Dxgi,
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
    /// encoder picks a sensible default (H.264 ~20, AV1 ~28). Combined
    /// with [`VideoConfig::quality_cap_bps`] this runs as capped quality
    /// by default — same quality on ordinary content, hard bitrate
    /// ceiling on runaway scenes.
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

/// Automatic bitrate ceiling for a quality tier, referenced to 1440p60
/// H264 (the pipeline scales by actual pixel rate; the encoder derates
/// AV1 ~0.6×). Values are deliberately generous — the cap exists to bound
/// the runaway tail (issue #4 measured 98 Mbps at "Balanced"), not to
/// shave ordinary clips.
pub fn max_bps_for_quality(qp: u32) -> u32 {
    match qp {
        q if q >= 32 => 25_000_000,  // Space saver
        q if q >= 26 => 60_000_000,  // Balanced
        q if q >= 20 => 80_000_000,  // High quality
        _ => 100_000_000,            // Maximum
    }
}

fn default_qp() -> u32 {
    // 20 sits comfortably inside H.264's 0–51 range (visually-lossless-ish)
    // and is also a perfectly reasonable AV1 QP — AV1 has a wider 0–255
    // scale but the lower end of it is where high-quality clips live.
    20
}

/// Quality boost applied for the duration of a manual recording.
///
/// Only meaningful when `rate_control` is `ConstantQp` — NVENC can't switch
/// rate-control *mode* on a live session, so under VBR the recording keeps
/// the configured average bitrate and this setting is ignored.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum RecordingQualityCfg {
    /// Recordings use the same quality as replay-buffer clips.
    MatchClips,
    /// Boost to this QP (H.264 0–51 scale; AV1 is matched internally) while
    /// recording. Never *lowers* quality: values above the clip QP are
    /// clamped to it.
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
    // +6 QP ≈ half the bitrate, so 14 is roughly twice the data rate of the
    // QP-20 clip default — comfortably clean enough to master a YouTube
    // upload from, without ballooning into lossless-tier file sizes.
    14
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
                AudioSource::SystemLoopback { device_id: None, fallbacks: Vec::new() },
                AudioSource::Microphone { device_id: None, fallbacks: Vec::new() },
            ],
            include_mix: true,
        }
    }
}

/// Sentinel accepted in [`AudioSource`] `fallbacks` entries: use the system
/// default endpoint for the source's flow. (WASAPI ids always look like
/// `{0.0.X.00000000}.{guid}`, so the bare word can't collide.)
pub const DEFAULT_DEVICE_SENTINEL: &str = "default";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AudioSource {
    /// WASAPI loopback on a render endpoint. `device_id = None` (or
    /// missing) uses the system default render device; `Some(id)` pins a
    /// specific one (use `clipdip --list-audio-devices` to find IDs).
    ///
    /// `fallbacks` is an ordered list of device ids tried when the entry
    /// above it doesn't start: primary first, then `fallbacks[0]`, then
    /// `fallbacks[1]`, … The literal `"default"` means the system default
    /// endpoint. Empty (the default) keeps the strict behavior: a pinned
    /// device that's missing records nothing rather than something else.
    SystemLoopback {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device_id: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        fallbacks: Vec<String>,
    },
    /// WASAPI capture from a microphone / line-in endpoint. Same
    /// `device_id = None` / `fallbacks` conventions as above.
    Microphone {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device_id: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        fallbacks: Vec<String>,
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

    /// Convenience accessor for the pinned device ID, if any.
    pub fn device_id(&self) -> Option<&str> {
        match self {
            AudioSource::SystemLoopback { device_id, .. }
            | AudioSource::Microphone { device_id, .. } => device_id.as_deref(),
            AudioSource::ProcessLoopback { .. } => None,
        }
    }

    /// Ordered fallback device ids tried after the primary; entries may be
    /// [`DEFAULT_DEVICE_SENTINEL`]. Empty for `ProcessLoopback`.
    pub fn fallbacks(&self) -> &[String] {
        match self {
            AudioSource::SystemLoopback { fallbacks, .. }
            | AudioSource::Microphone { fallbacks, .. } => fallbacks,
            AudioSource::ProcessLoopback { .. } => &[],
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
    /// Filename template (no extension). Supports `[token]` variables —
    /// see [`crate::filename`] for the full list. Sidecars and the final
    /// container all derive from the expanded stem — e.g. `{stem}.h264`,
    /// `{stem}.loopback.wav`, `{stem}.mp4`. On a name collision a ` (2)`
    /// style suffix is appended.
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
            filename_stem: "[app] [HH].[mm].[ss] - [dd].[MM].[yyyy]".into(),
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
    /// Shortcut that toggles a manual recording: first press marks the
    /// start point, second press saves everything since then as a clip.
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
    /// Whether the background health monitor raises a native Windows toast
    /// when capture degrades at runtime (capture stall, replay buffer
    /// dropping below the configured window). Independent of the per-save
    /// overlay notification above — this is the "something is going wrong
    /// right now" alert, not a save confirmation.
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

// ---- metadata -----------------------------------------------------------

/// Per-clip game-info capture. When enabled, each saved clip gets a sidecar
/// JSON file under `{directory}/.clip_metadata/{clip}.gameinfo` containing
/// the foreground window title at hotkey time, and (optionally) the
/// foreground exe's icon is extracted to `{directory}/icons/{exe}.png`.
///
/// Disabled by default — the capture touches the foreground HWND and reads
/// the target process's image, which some users may not want.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct MetadataConfig {
    pub enabled: bool,
    /// When `true` (and `enabled`), extract the foreground exe's icon as
    /// a PNG into `icons/{exe-basename}.png`. Skipped if the file already
    /// exists, so it's a one-time cost per game.
    pub capture_icon: bool,
    /// Lower-cased exe basenames to skip (e.g. `explorer.exe`). If the
    /// foreground process at hotkey time matches one of these, no
    /// metadata is written for the clip.
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

// ---- discord ------------------------------------------------------------

/// Capture the Discord voice-call roster at clip time. When enabled (and
/// the user has authorized via the settings UI / onboarding), each saved
/// clip records the user IDs + names of everyone in the call into its
/// `.gameinfo` sidecar. Reads only the call the user is already in, via
/// Discord's local RPC — no server bot.
///
/// Enabled by default. It still does nothing until the user completes the
/// one-time authorization (onboarding offers it), and writes nothing when
/// not in a call — so "on" just means "capture it once you've connected".
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

// ---- telemetry ----------------------------------------------------------

/// Anonymous, opt-out diagnostics. When enabled (the default), the app reports
/// capture failures / crashes and a periodic heartbeat to the diagnostics
/// server so problems on machines we don't own become visible. Identity is a
/// random per-install id — no accounts, no PII. See `clipdip-diagnostics`.
///
/// Opt-out: `enabled = false` stops all network calls. The app also does
/// nothing here unless an ingest key was compiled into the build.
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
    fn audio_fallbacks_parse_and_round_trip() {
        // Old configs (no fallbacks key) parse to an empty chain; a chain
        // with the "default" sentinel survives a serialize/parse cycle.
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
        // Empty chains stay off disk entirely.
        assert!(!out.contains("fallbacks = []"));
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

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn cqp_budget_ignores_bitrate_bps_and_scales_with_window() {
        // Issue #4: bitrate_bps must play no role under CQP. A 120s window
        // sizes from CQP_SAFETY_BPS + audio allowance, RAM permitting.
        let mut cfg = Config::default();
        cfg.replay_seconds = 120;
        cfg.video.bitrate_bps = 5_000_000; // stale VBR leftover, must be inert
        let budget = cfg.ring_byte_budget_with_ram(32 * GIB) as u64;
        let expected = 120 * (CQP_SAFETY_BPS + AUDIO_PCM_ALLOWANCE_BPS) / 8;
        assert_eq!(budget, expected.min(4096 * 1024 * 1024));
        // Far above the old fiction-derived 900 MB cap.
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
        // The old 5-Mbps trap produced a 150 MB budget; audio allowance
        // alone keeps this comfortably above that.
        assert!(budget > 300 * 1024 * 1024, "got {budget}");
    }

    #[test]
    fn ram_clamp_bounds_the_automatic_budget() {
        let mut cfg = Config::default();
        cfg.replay_seconds = 300; // slider max — would want ~6 GiB unclamped
        // 8 GiB machine: clamp = phys/4 = 2 GiB.
        assert_eq!(cfg.ring_byte_budget_with_ram(8 * GIB) as u64, 2 * GIB);
        // 64 GiB machine: clamp saturates at 4 GiB.
        assert_eq!(cfg.ring_byte_budget_with_ram(64 * GIB) as u64, 4 * GIB);
        // Tiny machine: clamp floors at 1 GiB.
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
        // Hand-edited far past physical RAM: guarded to half of it.
        cfg.memory.max_ring_mb = 1_000_000;
        assert_eq!(cfg.ring_byte_budget_with_ram(8 * GIB) as u64, 4 * GIB);
    }

    #[test]
    fn quality_cap_defaults_to_auto_and_stays_off_disk() {
        // Missing key = automatic capping; the key is skipped on
        // serialize so configs stay loadable by older binaries.
        let cfg = Config::default();
        assert_eq!(cfg.video.quality_cap_bps, None);
        let s = toml::to_string_pretty(&cfg).unwrap();
        assert!(!s.contains("quality_cap_bps"));
        let old: Config = toml::from_str("replay_seconds = 60").unwrap();
        assert_eq!(old.video.quality_cap_bps, None);

        // Explicit values round-trip.
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
        // Issue #4's reporter: Balanced bursts measured ~98 Mbps got a
        // 60 Mbps ceiling — bounded, but far above ShadowPlay's 40.
        assert!(max_bps_for_quality(26) > 40_000_000);
    }

    #[test]
    fn migration_bumps_old_default_gop_once() {
        // Pre-revision file with the old default: migrated.
        let mut cfg: Config =
            toml::from_str("replay_seconds = 60\n[video]\ngop_seconds = 1.0\n").unwrap();
        assert_eq!(cfg.config_revision, 0);
        assert!(cfg.migrate(false));
        assert_eq!(cfg.video.gop_seconds, 2.0);
        assert_eq!(cfg.config_revision, CONFIG_REVISION);
        // Idempotent: nothing further to do.
        assert!(!cfg.migrate(false));

        // Pre-revision file with a deliberate non-default value: revision
        // stamped, value untouched.
        let mut cfg: Config =
            toml::from_str("replay_seconds = 60\n[video]\ngop_seconds = 0.5\n").unwrap();
        assert!(cfg.migrate(false));
        assert_eq!(cfg.video.gop_seconds, 0.5);

        // Post-revision file where the user chose 1.0 on purpose: kept.
        let mut cfg: Config = toml::from_str(
            "replay_seconds = 60\nconfig_revision = 1\n[video]\ngop_seconds = 1.0\n",
        )
        .unwrap();
        assert!(!cfg.migrate(false));
        assert_eq!(cfg.video.gop_seconds, 1.0);

        // Stamp stripped by an old binary's settings save, but the marker
        // says we already migrated: restamp only, keep the user's 1.0.
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
        // Default 2s GOP: slack = gop + 1 = 3s.
        assert_eq!(cfg.ring_time_window_100ns(), 63 * 10_000_000);
        // Short GOP keeps the historical 2s floor.
        cfg.video.gop_seconds = 0.5;
        assert_eq!(cfg.ring_time_window_100ns(), 62 * 10_000_000);
        // Long GOP grows the slack so the save cut always finds an IDR
        // at-or-before the window start.
        cfg.video.gop_seconds = 5.0;
        assert_eq!(cfg.ring_time_window_100ns(), 66 * 10_000_000);
    }

    #[test]
    fn legacy_toml_without_memory_section_gets_auto_sizing() {
        // Every pre-existing config.toml explicitly persists bitrate_bps
        // and has no [memory] table — it must load and size the new way.
        let cfg: Config = toml::from_str(
            "replay_seconds = 120\n[video]\nbitrate_bps = 30000000\n",
        )
        .unwrap();
        assert_eq!(cfg.memory.max_ring_mb, 0);
        let budget = cfg.ring_byte_budget_with_ram(32 * GIB) as u64;
        assert!(budget > 2 * GIB, "got {budget}");
    }
}
