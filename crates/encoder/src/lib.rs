//! NVENC encoder wrapper.
//!
//! Loads `nvEncodeAPI64.dll` from the user's driver install at runtime — we
//! never redistribute the NVIDIA SDK. The encoder accepts an
//! `ID3D11Texture2D` (same device as capture) and produces Annex-B NAL units
//! wrapped in `clipdip_ringbuf::EncodedPacket`.
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

#[derive(Clone, Debug)]
pub struct EncoderConfig {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub bitrate_bps: u32,
    /// GOP length in frames. Set to `fps_num/fps_den` for a 1-second IDR
    /// interval. Drives both `NV_ENC_CONFIG::gopLength` and the H.264
    /// `idrPeriod`, so NVENC inserts IDRs automatically at this cadence.
    pub gop_length: u32,
}

impl Default for EncoderConfig {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps_num: 60,
            fps_den: 1,
            bitrate_bps: 20_000_000,
            gop_length: 60,
        }
    }
}
