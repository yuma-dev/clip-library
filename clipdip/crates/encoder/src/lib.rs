//! NVENC encoder wrapper. Loads `nvEncodeAPI64.dll` from the driver at
//! runtime (we never redistribute the SDK). Takes an `ID3D11Texture2D`
//! (same device as capture), produces Annex-B NAL units (H.264) or AV1
//! OBUs wrapped in `clipdip_ringbuf::EncodedPacket`.

pub mod encoder;
pub mod loader;
mod nv12_converter;
pub mod sys;

pub use encoder::NvEncoderD3D11;
pub use loader::NvEncApi;

/// Codec actually negotiated at session open (capability probe in
/// [`NvEncoderD3D11::new`]), so the muxer/keyframe scanner know the bitstream format.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveCodec {
    H264,
    Av1,
}

/// What the caller wants; resolved against driver capabilities at session open, see `ActiveCodec`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CodecPreference {
    /// AV1 on RTX 40+, else H.264. Mirrors NVIDIA ShadowPlay.
    #[default]
    PreferAv1,
    /// For compatibility testing or players that can't decode AV1.
    ForceH264,
    /// `NvEncoderD3D11::new` errors on GPUs without AV1 NVENC.
    ForceAv1,
}

/// CQP keeps quality fixed, bitrate floats with scene complexity (ShadowPlay
/// default). VBR is for callers wanting a hard average bitrate.
#[derive(Clone, Copy, Debug)]
pub enum RateControl {
    /// `qp` scale is codec-specific: H.264/HEVC 0-51, AV1 0-255 (lower = better;
    /// AV1 ~28 is roughly H.264 QP 20 perceptually).
    ConstantQp { qp: u32 },
    /// NVENC target-quality VBR (targetQuality + maxBitRate/VBV): behaves like
    /// constant quality below the cap, trades quality for a bounded clip size above it.
    /// `cq` always uses the H.264 0-51 scale (targetQuality is codec-agnostic
    /// don't apply AV1's x4 QP scaling). Encoder derates `max_bps` ~0.6x for AV1.
    CappedQuality { cq: u32, max_bps: u32 },
    /// Peak is set to 1.5x `avg_bps` by the encoder.
    Vbr { avg_bps: u32 },
}

impl Default for RateControl {
    fn default() -> Self {
        // near-lossless default for AV1; H.264 gets a tighter QP via `qp_for_codec`
        Self::ConstantQp { qp: 28 }
    }
}

#[derive(Clone, Debug)]
pub struct EncoderConfig {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    /// `fps_num/fps_den` for a 1-second IDR interval. Drives both
    /// `NV_ENC_CONFIG::gopLength` and the codec-specific `idrPeriod`.
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
