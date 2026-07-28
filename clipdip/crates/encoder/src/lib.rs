//! NVENC encoder wrapper.
//!
//! Loads `nvEncodeAPI64.dll` from the user's driver install at runtime — we
//! never redistribute the NVIDIA SDK. The encoder accepts an
//! `ID3D11Texture2D` (same device as capture) and produces Annex-B NAL units
//! (H.264) or AV1 OBUs wrapped in `clipdip_ringbuf::EncodedPacket`.
//!
//! Modules
//! - [`sys`]     — raw FFI types & version macros (hand-bound subset of
//!                  nvEncodeAPI.h)
//! - [`loader`]  — safe wrapper that opens the DLL and populates the
//!                  function-pointer table
//! - [`encoder`] — safe wrapper around a live encode session for D3D11 input

pub mod encoder;
pub mod loader;
mod nv12_converter;
pub mod sys;

pub use encoder::NvEncoderD3D11;
pub use loader::NvEncApi;

/// Which codec the encoder actually negotiated at session open. Set after
/// the capability probe in [`NvEncoderD3D11::new`] and exposed via
/// [`NvEncoderD3D11::active_codec`] so the muxer / keyframe scanner know
/// which bitstream format to expect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveCodec {
    H264,
    Av1,
}

/// What the caller would *like* the encoder to use. Resolved against the
/// driver's reported capabilities at session open — see `ActiveCodec`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CodecPreference {
    /// Prefer AV1 on GPUs that support it (RTX 40+), transparently fall
    /// back to H.264 elsewhere. Default — mirrors NVIDIA ShadowPlay.
    #[default]
    PreferAv1,
    /// Always use H.264. Useful for compatibility testing or when the
    /// target player can't decode AV1.
    ForceH264,
    /// Require AV1. `NvEncoderD3D11::new` returns an error on GPUs without
    /// AV1 NVENC support.
    ForceAv1,
}

/// Rate-control strategy. CQP keeps perceived quality fixed and lets bitrate
/// float with scene complexity — the ShadowPlay default for clip recording.
/// VBR is retained for callers that want a hard average bitrate.
#[derive(Clone, Copy, Debug)]
pub enum RateControl {
    /// Constant quantization. `qp` scale is codec-specific:
    /// - H.264 / HEVC: 0–51 (lower = higher quality)
    /// - AV1: 0–255 (lower = higher quality; ~28 is roughly equivalent to
    ///   H.264 QP 20 perceptually)
    ConstantQp { qp: u32 },
    /// Constant quality with a hard bitrate ceiling: NVENC target-quality
    /// VBR (`targetQuality` + `maxBitRate`/VBV). Below the cap it behaves
    /// like constant quality; scenes that would exceed `max_bps` trade
    /// quality down instead of running away — the worst-case clip size is
    /// bounded, which pure CQP can never guarantee.
    ///
    /// `cq` uses the H.264 0–51 scale for BOTH codecs — NVENC's
    /// `targetQuality` field is codec-agnostic (do NOT apply the AV1 ×4
    /// QP scaling here). `max_bps` is the final cap for this session; the
    /// encoder derates it ~0.6× for AV1 internally.
    CappedQuality { cq: u32, max_bps: u32 },
    /// Variable bitrate with `avg_bps` average target. Peak is set to
    /// 1.5× average by the encoder.
    Vbr { avg_bps: u32 },
}

impl Default for RateControl {
    fn default() -> Self {
        // Visually-lossless-ish default for AV1; H.264 maps to a tighter QP
        // automatically via `qp_for_codec` in the encoder.
        Self::ConstantQp { qp: 28 }
    }
}

#[derive(Clone, Debug)]
pub struct EncoderConfig {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    /// GOP length in frames. Set to `fps_num/fps_den` for a 1-second IDR
    /// interval. Drives both `NV_ENC_CONFIG::gopLength` and the
    /// codec-specific `idrPeriod`, so NVENC inserts IDRs automatically at
    /// this cadence.
    pub gop_length: u32,
    pub codec_preference: CodecPreference,
    pub rate_control: RateControl,
}

impl Default for EncoderConfig {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps_num: 60,
            fps_den: 1,
            gop_length: 60,
            codec_preference: CodecPreference::default(),
            rate_control: RateControl::default(),
        }
    }
}
