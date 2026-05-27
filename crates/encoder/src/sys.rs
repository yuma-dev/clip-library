//! Hand-written FFI to a minimal subset of nvEncodeAPI.h (Video Codec SDK
//! 13.0). We dynamically load `nvEncodeAPI64.dll` from the NVIDIA driver
//! install at runtime — end users never need the Video Codec SDK, only a
//! working NVIDIA driver.
//!
//! Naming follows the C header exactly (snake_case in Rust, but field names
//! stay verbatim) so cross-referencing with the SDK docs is straightforward.

#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::ffi::c_void;

// =====================================================================
// Version macros
// =====================================================================

pub const NVENCAPI_MAJOR_VERSION: u32 = 13;
pub const NVENCAPI_MINOR_VERSION: u32 = 0;
pub const NVENCAPI_VERSION: u32 = NVENCAPI_MAJOR_VERSION | (NVENCAPI_MINOR_VERSION << 24);

pub const fn nvencapi_struct_version(ver: u32) -> u32 {
    NVENCAPI_VERSION | (ver << 16) | (0x7 << 28)
}

// `(1<<31)` flag on these versions is the "extended" version marker
// introduced for backwards-compatible struct growth.
pub const NV_ENCODE_API_FUNCTION_LIST_VER: u32 = nvencapi_struct_version(2);
pub const NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER: u32 = nvencapi_struct_version(1);
pub const NV_ENC_INITIALIZE_PARAMS_VER: u32 = nvencapi_struct_version(7) | (1 << 31);
pub const NV_ENC_REGISTER_RESOURCE_VER: u32 = nvencapi_struct_version(5);
pub const NV_ENC_MAP_INPUT_RESOURCE_VER: u32 = nvencapi_struct_version(4);
pub const NV_ENC_CREATE_BITSTREAM_BUFFER_VER: u32 = nvencapi_struct_version(1);
pub const NV_ENC_PIC_PARAMS_VER: u32 = nvencapi_struct_version(7) | (1 << 31);
pub const NV_ENC_LOCK_BITSTREAM_VER: u32 = nvencapi_struct_version(2) | (1 << 31);
pub const NV_ENC_CONFIG_VER: u32 = nvencapi_struct_version(9) | (1 << 31);
pub const NV_ENC_RC_PARAMS_VER: u32 = nvencapi_struct_version(1);
pub const NV_ENC_PRESET_CONFIG_VER: u32 = nvencapi_struct_version(5) | (1 << 31);
pub const NV_ENC_EVENT_PARAMS_VER: u32 = nvencapi_struct_version(2);
pub const NV_ENC_SEQUENCE_PARAM_PAYLOAD_VER: u32 = nvencapi_struct_version(1);

/// Sentinel for `NV_ENC_CONFIG::gopLength` meaning "never insert keyframes
/// automatically". Not used today but kept for API completeness.
pub const NVENC_INFINITE_GOPLENGTH: u32 = 0xffff_ffff;

// =====================================================================
// Status codes
// =====================================================================

pub type NVENCSTATUS = i32;
pub const NV_ENC_SUCCESS: NVENCSTATUS = 0;
pub const NV_ENC_ERR_NO_ENCODE_DEVICE: NVENCSTATUS = 1;
pub const NV_ENC_ERR_UNSUPPORTED_DEVICE: NVENCSTATUS = 2;
pub const NV_ENC_ERR_INVALID_ENCODERDEVICE: NVENCSTATUS = 3;
pub const NV_ENC_ERR_INVALID_DEVICE: NVENCSTATUS = 4;
pub const NV_ENC_ERR_DEVICE_NOT_EXIST: NVENCSTATUS = 5;
pub const NV_ENC_ERR_INVALID_PTR: NVENCSTATUS = 6;
pub const NV_ENC_ERR_INVALID_EVENT: NVENCSTATUS = 7;
pub const NV_ENC_ERR_INVALID_PARAM: NVENCSTATUS = 8;
pub const NV_ENC_ERR_INVALID_CALL: NVENCSTATUS = 9;
pub const NV_ENC_ERR_OUT_OF_MEMORY: NVENCSTATUS = 10;
pub const NV_ENC_ERR_ENCODER_NOT_INITIALIZED: NVENCSTATUS = 11;
pub const NV_ENC_ERR_UNSUPPORTED_PARAM: NVENCSTATUS = 12;
pub const NV_ENC_ERR_LOCK_BUSY: NVENCSTATUS = 13;
pub const NV_ENC_ERR_NOT_ENOUGH_BUFFER: NVENCSTATUS = 14;
pub const NV_ENC_ERR_INVALID_VERSION: NVENCSTATUS = 15;
pub const NV_ENC_ERR_MAP_FAILED: NVENCSTATUS = 16;
pub const NV_ENC_ERR_NEED_MORE_INPUT: NVENCSTATUS = 17;
pub const NV_ENC_ERR_ENCODER_BUSY: NVENCSTATUS = 18;
pub const NV_ENC_ERR_GENERIC: NVENCSTATUS = 21;

// =====================================================================
// Enums (always uint32_t in C)
// =====================================================================

pub type NV_ENC_DEVICE_TYPE = u32;
pub const NV_ENC_DEVICE_TYPE_DIRECTX: NV_ENC_DEVICE_TYPE = 0;
pub const NV_ENC_DEVICE_TYPE_CUDA: NV_ENC_DEVICE_TYPE = 1;

pub type NV_ENC_INPUT_RESOURCE_TYPE = u32;
pub const NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX: NV_ENC_INPUT_RESOURCE_TYPE = 0;

pub type NV_ENC_BUFFER_FORMAT = u32;
pub const NV_ENC_BUFFER_FORMAT_UNDEFINED: NV_ENC_BUFFER_FORMAT = 0;
pub const NV_ENC_BUFFER_FORMAT_NV12: NV_ENC_BUFFER_FORMAT = 0x00000001;
pub const NV_ENC_BUFFER_FORMAT_ARGB: NV_ENC_BUFFER_FORMAT = 0x01000000;
pub const NV_ENC_BUFFER_FORMAT_ABGR: NV_ENC_BUFFER_FORMAT = 0x04000000;

pub type NV_ENC_BUFFER_USAGE = u32;
pub const NV_ENC_INPUT_IMAGE: NV_ENC_BUFFER_USAGE = 0;

pub type NV_ENC_PIC_STRUCT = u32;
pub const NV_ENC_PIC_STRUCT_FRAME: NV_ENC_PIC_STRUCT = 1;

pub type NV_ENC_PIC_TYPE = u32;
pub const NV_ENC_PIC_TYPE_P: NV_ENC_PIC_TYPE = 0;
pub const NV_ENC_PIC_TYPE_B: NV_ENC_PIC_TYPE = 1;
pub const NV_ENC_PIC_TYPE_I: NV_ENC_PIC_TYPE = 2;
pub const NV_ENC_PIC_TYPE_IDR: NV_ENC_PIC_TYPE = 3;

pub type NV_ENC_PIC_FLAGS = u32;
pub const NV_ENC_PIC_FLAG_FORCEINTRA: NV_ENC_PIC_FLAGS = 0x1;
pub const NV_ENC_PIC_FLAG_FORCEIDR: NV_ENC_PIC_FLAGS = 0x2;
pub const NV_ENC_PIC_FLAG_OUTPUT_SPSPPS: NV_ENC_PIC_FLAGS = 0x4;
pub const NV_ENC_PIC_FLAG_EOS: NV_ENC_PIC_FLAGS = 0x8;

pub type NV_ENC_TUNING_INFO = u32;
pub const NV_ENC_TUNING_INFO_UNDEFINED: NV_ENC_TUNING_INFO = 0;
pub const NV_ENC_TUNING_INFO_HIGH_QUALITY: NV_ENC_TUNING_INFO = 1;
pub const NV_ENC_TUNING_INFO_LOW_LATENCY: NV_ENC_TUNING_INFO = 2;
pub const NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY: NV_ENC_TUNING_INFO = 3;

pub type NV_ENC_OUTPUT_STATS_LEVEL = u32;

pub type NV_ENC_PARAMS_RC_MODE = u32;
pub const NV_ENC_PARAMS_RC_CONSTQP: NV_ENC_PARAMS_RC_MODE = 0x0;
pub const NV_ENC_PARAMS_RC_VBR: NV_ENC_PARAMS_RC_MODE = 0x1;
pub const NV_ENC_PARAMS_RC_CBR: NV_ENC_PARAMS_RC_MODE = 0x2;

// =====================================================================
// GUID — exact 16-byte layout matching <guiddef.h>
// =====================================================================

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GUID {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}

// Codec
pub const NV_ENC_CODEC_H264_GUID: GUID = GUID {
    data1: 0x6bc82762,
    data2: 0x4e63,
    data3: 0x4ca4,
    data4: [0xaa, 0x85, 0x1e, 0x50, 0xf3, 0x21, 0xf6, 0xbf],
};

// H.264 profiles (we use HIGH for the prototype)
pub const NV_ENC_H264_PROFILE_HIGH_GUID: GUID = GUID {
    data1: 0xe7cbc309,
    data2: 0x4f7a,
    data3: 0x4b89,
    data4: [0xaf, 0x2a, 0xd5, 0x37, 0xc9, 0x2b, 0xe3, 0x10],
};

// Presets P1=fastest..P7=slowest. P4 is balanced; P5 is the OBS default.
pub const NV_ENC_PRESET_P4_GUID: GUID = GUID {
    data1: 0x90a7b826,
    data2: 0xdf06,
    data3: 0x4862,
    data4: [0xb9, 0xd2, 0xcd, 0x6d, 0x73, 0xa0, 0x86, 0x81],
};

// AV1 codec (NVENC SDK 13). Hardware support: RTX 40-series (Ada) and newer.
pub const NV_ENC_CODEC_AV1_GUID: GUID = GUID {
    data1: 0x0a352289,
    data2: 0x0aa7,
    data3: 0x4759,
    data4: [0x86, 0x2d, 0x5d, 0x15, 0xcd, 0x16, 0xd2, 0x54],
};

pub const NV_ENC_AV1_PROFILE_MAIN_GUID: GUID = GUID {
    data1: 0x5f2a39f5,
    data2: 0xf14e,
    data3: 0x4f95,
    data4: [0x9a, 0x9e, 0xb7, 0x6d, 0x56, 0x8f, 0xcf, 0x97],
};

// =====================================================================
// Opaque handle types
// =====================================================================

pub type NV_ENC_OUTPUT_PTR = *mut c_void;
pub type NV_ENC_INPUT_PTR = *mut c_void;
pub type NV_ENC_REGISTERED_PTR = *mut c_void;

// =====================================================================
// External-ME hint counts struct (16 bytes; we never use it but several
// structs embed it)
// =====================================================================

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE {
    /// Bitfields packed into a single u32 — we leave at 0.
    pub bitfields: u32,
    pub reserved1: [u32; 3],
}

// =====================================================================
// NV_ENC_EVENT_PARAMS — async-mode completion event registration
// =====================================================================

#[repr(C)]
pub struct NV_ENC_EVENT_PARAMS {
    pub version: u32,
    pub reserved: u32,
    pub completionEvent: *mut c_void,
    pub reserved1: [u32; 254],
    pub reserved2: [*mut c_void; 64],
}

// =====================================================================
// NV_ENC_SEQUENCE_PARAM_PAYLOAD — retrieve out-of-band sequence header
// (H.264 SPS+PPS, HEVC VPS+SPS+PPS, or AV1 sequence header OBU) from the
// open encoder session. OBS uses this to seed muxer extradata; we use it
// to prepend the header to clip files because the AV1 bitstream NVENC
// emits doesn't reliably contain the sequence header at the start of
// every IDR even with `repeatSeqHdr=1`.
// =====================================================================

#[repr(C)]
pub struct NV_ENC_SEQUENCE_PARAM_PAYLOAD {
    pub version: u32,
    pub inBufferSize: u32,
    pub spsId: u32,
    pub ppsId: u32,
    pub spsppsBuffer: *mut c_void,
    pub outSPSPPSPayloadSize: *mut u32,
    pub reserved: [u32; 250],
    pub reserved2: [*mut c_void; 64],
}

impl Default for NV_ENC_SEQUENCE_PARAM_PAYLOAD {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

impl Default for NV_ENC_EVENT_PARAMS {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// =====================================================================
// NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS
// =====================================================================

#[repr(C)]
pub struct NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
    pub version: u32,
    pub deviceType: NV_ENC_DEVICE_TYPE,
    pub device: *mut c_void,
    pub reserved: *mut c_void,
    pub apiVersion: u32,
    pub reserved1: [u32; 253],
    pub reserved2: [*mut c_void; 64],
}

impl Default for NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// =====================================================================
// NV_ENC_QP / NV_ENC_RC_PARAMS / NV_ENC_CONFIG / NV_ENC_PRESET_CONFIG
// =====================================================================
//
// We treat `NV_ENC_CODEC_CONFIG` (the union of H.264 / HEVC / AV1 / ME-only
// configs) as an opaque 1792-byte blob. `NV_ENC_CONFIG_H264` (the largest
// variant in SDK 13.0) is also 1792 bytes, so the union's size is exact.
// The handful of codec-specific fields we override — currently only
// H.264 `idrPeriod` — are written at known offsets via a typed helper
// on `NV_ENC_CONFIG`.
//
// Sizes verified against `cl` builds of a probe against `nvEncodeAPI.h`
// from Video Codec SDK 13.0.37; asserted in this module's tests.

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct NV_ENC_QP {
    pub qpInterP: u32,
    pub qpInterB: u32,
    pub qpIntra: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_RC_PARAMS {
    pub version: u32,
    pub rateControlMode: NV_ENC_PARAMS_RC_MODE,
    pub constQP: NV_ENC_QP,
    pub averageBitRate: u32,
    pub maxBitRate: u32,
    pub vbvBufferSize: u32,
    pub vbvInitialDelay: u32,
    /// Bitfields: enableMinQP(1) enableMaxQP(1) enableInitialRCQP(1)
    /// enableAQ(1) reservedBitField1(1) enableLookahead(1) disableIadapt(1)
    /// disableBadapt(1) enableTemporalAQ(1) zeroReorderDelay(1)
    /// enableNonRefP(1) strictGOPTarget(1) aqStrength(4)
    /// enableExtLookahead(1) reservedBitFields(15).
    pub bitfields: u32,
    pub minQP: NV_ENC_QP,
    pub maxQP: NV_ENC_QP,
    pub initialRCQP: NV_ENC_QP,
    pub temporallayerIdxMask: u32,
    pub temporalLayerQP: [u8; 8],
    pub targetQuality: u8,
    pub targetQualityLSB: u8,
    pub lookaheadDepth: u16,
    pub lowDelayKeyFrameScale: u8,
    pub yDcQPIndexOffset: i8,
    pub uDcQPIndexOffset: i8,
    pub vDcQPIndexOffset: i8,
    pub qpMapMode: u32,
    pub multiPass: u32,
    pub alphaLayerBitrateRatio: u32,
    pub cbQPIndexOffset: i8,
    pub crQPIndexOffset: i8,
    pub reserved2: u16,
    pub lookaheadLevel: u32,
    pub viewBitrateRatios: [u8; 7],
    pub reserved3: u8,
    pub reserved1: u32,
}

impl Default for NV_ENC_RC_PARAMS {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

/// Size of `NV_ENC_CODEC_CONFIG` (union of H264/HEVC/AV1/ME-only configs).
/// In SDK 13.0 this is exactly the size of `NV_ENC_CONFIG_H264`, the largest
/// variant.
pub const NV_ENC_CODEC_CONFIG_SIZE: usize = 1792;

/// Offset of `idrPeriod` inside `NV_ENC_CONFIG_H264`. Used by
/// `NV_ENC_CONFIG::set_h264_idr_period` to override the preset default.
pub const NV_ENC_CONFIG_H264_IDR_PERIOD_OFFSET: usize = 8;

/// Bit position of `repeatSPSPPS` inside the packed bitfield u32 that
/// starts `NV_ENC_CONFIG_H264` (offset 0). Counting from the C header,
/// in declaration order with LSB-first packing:
///   0 enableTemporalSVC, 1 enableStereoMVC, 2 hierarchicalPFrames,
///   3 hierarchicalBFrames, 4 outputBufferingPeriodSEI,
///   5 outputPictureTimingSEI, 6 outputAUD, 7 disableSPSPPS,
///   8 outputFramePackingSEI, 9 outputRecoveryPointSEI,
///   10 enableIntraRefresh, 11 enableConstrainedEncoding,
///   **12 repeatSPSPPS**, ...
pub const NV_ENC_CONFIG_H264_REPEAT_SPSPPS_BIT: u32 = 1 << 12;

// ---- AV1 ----------------------------------------------------------
//
// SDK 13.0 `_NV_ENC_CONFIG_AV1` layout. We model the full struct so we
// can assign fields by name instead of poking bytes at hand-counted
// offsets — the previous offset-based code had `idrPeriod` and the
// bitfield word swapped (off by one u32), which silently corrupted
// neighboring fields and prevented `repeatSeqHdr` from ever being set.
// That's why NVENC AV1 emitted `INTRA_ONLY_FRAME` instead of
// `KEY_FRAME` at IDR cadence and never re-emitted the sequence header.

pub type NV_ENC_AV1_PART_SIZE = u32;
pub const NV_ENC_AV1_PART_SIZE_AUTOSELECT: NV_ENC_AV1_PART_SIZE = 0;

pub type NV_ENC_VUI_COLOR_PRIMARIES = u32;
pub type NV_ENC_VUI_TRANSFER_CHARACTERISTIC = u32;
pub type NV_ENC_VUI_MATRIX_COEFFS = u32;

pub type NV_ENC_BFRAME_REF_MODE = u32;
pub const NV_ENC_BFRAME_REF_MODE_DISABLED: NV_ENC_BFRAME_REF_MODE = 0;

pub type NV_ENC_NUM_REF_FRAMES = u32;
pub const NV_ENC_NUM_REF_FRAMES_AUTOSELECT: NV_ENC_NUM_REF_FRAMES = 0;
pub const NV_ENC_NUM_REF_FRAMES_1: NV_ENC_NUM_REF_FRAMES = 1;

pub type NV_ENC_BIT_DEPTH = u32;
pub const NV_ENC_BIT_DEPTH_8: NV_ENC_BIT_DEPTH = 8;
pub const NV_ENC_BIT_DEPTH_10: NV_ENC_BIT_DEPTH = 10;

pub type NV_ENC_TEMPORAL_FILTER_LEVEL = u32;

pub type NV_ENC_LEVEL_AV1 = u32;
pub const NV_ENC_LEVEL_AV1_AUTOSELECT: NV_ENC_LEVEL_AV1 = 24;

pub type NV_ENC_TIER_AV1 = u32;
pub const NV_ENC_TIER_AV1_0: NV_ENC_TIER_AV1 = 0;

/// Faithful `#[repr(C)]` mirror of SDK 13.0 `NV_ENC_CONFIG_AV1`. Field
/// order, types, and padding must match the C header exactly — this
/// struct is reinterpreted onto `NV_ENC_CONFIG::encodeCodecConfig`,
/// which the driver also reinterprets through the same union, so any
/// drift produces silently miscoded frames.
#[repr(C)]
pub struct NV_ENC_CONFIG_AV1 {
    pub level: NV_ENC_LEVEL_AV1,
    pub tier: NV_ENC_TIER_AV1,
    pub minPartSize: NV_ENC_AV1_PART_SIZE,
    pub maxPartSize: NV_ENC_AV1_PART_SIZE,
    /// Packed bitfield. Layout (LSB-first per the C `: 1` declaration order):
    ///   0 outputAnnexBFormat, 1 enableTimingInfo, 2 enableDecoderModelInfo,
    ///   3 enableFrameIdNumbers, 4 disableSeqHdr, **5 repeatSeqHdr**,
    ///   6 enableIntraRefresh, 7-8 chromaFormatIDC (2 bits),
    ///   9 enableBitstreamPadding, 10 enableCustomTileConfig,
    ///   11 enableFilmGrainParams, 12 enableLTR, 13 enableTemporalSVC,
    ///   14 outputMaxCll, 15 outputMasteringDisplay,
    ///   16-17 reserved4, 18-31 reserved.
    pub flags: u32,
    pub idrPeriod: u32,
    pub intraRefreshPeriod: u32,
    pub intraRefreshCnt: u32,
    pub maxNumRefFramesInDPB: u32,
    pub numTileColumns: u32,
    pub numTileRows: u32,
    pub reserved2: u32,
    pub tileWidths: *mut u32,
    pub tileHeights: *mut u32,
    pub maxTemporalLayersMinus1: u32,
    pub colorPrimaries: NV_ENC_VUI_COLOR_PRIMARIES,
    pub transferCharacteristics: NV_ENC_VUI_TRANSFER_CHARACTERISTIC,
    pub matrixCoefficients: NV_ENC_VUI_MATRIX_COEFFS,
    pub colorRange: u32,
    pub chromaSamplePosition: u32,
    pub useBFramesAsRef: NV_ENC_BFRAME_REF_MODE,
    pub filmGrainParams: *mut c_void,
    pub numFwdRefs: NV_ENC_NUM_REF_FRAMES,
    pub numBwdRefs: NV_ENC_NUM_REF_FRAMES,
    pub outputBitDepth: NV_ENC_BIT_DEPTH,
    pub inputBitDepth: NV_ENC_BIT_DEPTH,
    pub ltrNumFrames: u32,
    pub numTemporalLayers: u32,
    pub tfLevel: NV_ENC_TEMPORAL_FILTER_LEVEL,
    pub reserved1: [u32; 230],
    pub reserved3: [*mut c_void; 62],
}

const _: () = {
    // Compile-time guard: AV1 union member must fit in encodeCodecConfig.
    assert!(std::mem::size_of::<NV_ENC_CONFIG_AV1>() <= NV_ENC_CODEC_CONFIG_SIZE);
};

/// Bit position of `repeatSeqHdr` in `NV_ENC_CONFIG_AV1::flags`. Used by
/// callers who want to flip individual flag bits without rebuilding the
/// whole word.
pub const NV_ENC_CONFIG_AV1_REPEAT_SEQ_HDR_BIT: u32 = 1 << 5;

#[repr(C)]
pub struct NV_ENC_CONFIG {
    pub version: u32,
    pub profileGUID: GUID,
    pub gopLength: u32,
    pub frameIntervalP: i32,
    pub monoChromeEncoding: u32,
    pub frameFieldMode: u32,
    pub mvPrecision: u32,
    pub rcParams: NV_ENC_RC_PARAMS,
    /// Opaque `NV_ENC_CODEC_CONFIG` union — set by the preset query and
    /// optionally edited via `set_h264_idr_period`.
    pub encodeCodecConfig: [u8; NV_ENC_CODEC_CONFIG_SIZE],
    pub reserved: [u32; 278],
    pub reserved2: [*mut c_void; 64],
}

impl Default for NV_ENC_CONFIG {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

impl NV_ENC_CONFIG {
    /// Write `idrPeriod` into the embedded `NV_ENC_CONFIG_H264`. Required
    /// because preset query fills idrPeriod separately from `gopLength`, and
    /// our `gopLength` override won't take effect for IDR cadence unless we
    /// match it here.
    pub fn set_h264_idr_period(&mut self, idr_period: u32) {
        let bytes = idr_period.to_ne_bytes();
        self.encodeCodecConfig
            [NV_ENC_CONFIG_H264_IDR_PERIOD_OFFSET..NV_ENC_CONFIG_H264_IDR_PERIOD_OFFSET + 4]
            .copy_from_slice(&bytes);
    }

    /// Set/clear `repeatSPSPPS` in the embedded `NV_ENC_CONFIG_H264`.
    /// When enabled, NVENC prepends SPS+PPS to **every IDR**, not just
    /// the first frame of the session. Required for clipping: once the
    /// ring evicts the original session-start SPS+PPS+IDR, every
    /// subsequent save would otherwise produce a `.h264` file that
    /// starts with an IDR slice referencing a PPS the decoder never
    /// saw, and ffmpeg/players reject it with "non-existing PPS 0
    /// referenced". OBS does the same for the same reason.
    pub fn set_h264_repeat_sps_pps(&mut self, repeat: bool) {
        let bf = u32::from_ne_bytes(self.encodeCodecConfig[0..4].try_into().unwrap());
        let bf = if repeat {
            bf | NV_ENC_CONFIG_H264_REPEAT_SPSPPS_BIT
        } else {
            bf & !NV_ENC_CONFIG_H264_REPEAT_SPSPPS_BIT
        };
        self.encodeCodecConfig[0..4].copy_from_slice(&bf.to_ne_bytes());
    }

    /// Reinterpret the `encodeCodecConfig` union as `&mut NV_ENC_CONFIG_AV1`.
    /// Only valid once the parent encode session was opened with the AV1
    /// `encodeGUID`; callers using H.264 must use the H.264 helpers above.
    ///
    /// SAFETY: the returned reference aliases `encodeCodecConfig` for the
    /// lifetime of `self`. The union is correctly sized (compile-time
    /// asserted in [`NV_ENC_CONFIG_AV1`]); using it under the wrong codec
    /// would misinterpret the bytes but not violate Rust aliasing.
    pub fn av1_config_mut(&mut self) -> &mut NV_ENC_CONFIG_AV1 {
        // SAFETY: encodeCodecConfig is a byte array large enough to hold
        // NV_ENC_CONFIG_AV1 (checked above), correctly aligned (u32+ptr
        // fields, parent struct is #[repr(C)] starting on a u32 boundary
        // and the byte array follows other u32 fields).
        unsafe { &mut *(self.encodeCodecConfig.as_mut_ptr() as *mut NV_ENC_CONFIG_AV1) }
    }
}

#[repr(C)]
pub struct NV_ENC_PRESET_CONFIG {
    pub version: u32,
    pub reserved: u32,
    pub presetCfg: NV_ENC_CONFIG,
    pub reserved1: [u32; 256],
    pub reserved2: [*mut c_void; 64],
}

impl Default for NV_ENC_PRESET_CONFIG {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// =====================================================================
// NV_ENC_INITIALIZE_PARAMS
// =====================================================================

#[repr(C)]
pub struct NV_ENC_INITIALIZE_PARAMS {
    pub version: u32,
    pub encodeGUID: GUID,
    pub presetGUID: GUID,
    pub encodeWidth: u32,
    pub encodeHeight: u32,
    pub darWidth: u32,
    pub darHeight: u32,
    pub frameRateNum: u32,
    pub frameRateDen: u32,
    pub enableEncodeAsync: u32,
    pub enablePTD: u32,
    /// Bitfields region. From the header: reportSliceOffsets (1),
    /// enableSubFrameWrite (1), enableExternalMEHints (1),
    /// enableMEOnlyMode (1), enableWeightedPrediction (1),
    /// splitEncodeMode (4), enableOutputInVidmem (1),
    /// enableReconFrameOutput (1), enableOutputStats (1),
    /// enableUniDirectionalB (1), reservedBitFields (19). Total 32 bits.
    pub bitfields: u32,
    pub privDataSize: u32,
    pub reserved: u32,
    pub privData: *mut c_void,
    /// Optional. Pass NULL to use preset defaults — what we do in v0.
    pub encodeConfig: *mut c_void,
    pub maxEncodeWidth: u32,
    pub maxEncodeHeight: u32,
    pub maxMEHintCountsPerBlock: [NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE; 2],
    pub tuningInfo: NV_ENC_TUNING_INFO,
    pub bufferFormat: NV_ENC_BUFFER_FORMAT,
    pub numStateBuffers: u32,
    pub outputStatsLevel: NV_ENC_OUTPUT_STATS_LEVEL,
    pub reserved1: [u32; 284],
    pub reserved2: [*mut c_void; 64],
}

impl Default for NV_ENC_INITIALIZE_PARAMS {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// =====================================================================
// NV_ENC_REGISTER_RESOURCE
// =====================================================================

#[repr(C)]
pub struct NV_ENC_REGISTER_RESOURCE {
    pub version: u32,
    pub resourceType: NV_ENC_INPUT_RESOURCE_TYPE,
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub subResourceIndex: u32,
    pub resourceToRegister: *mut c_void,
    pub registeredResource: NV_ENC_REGISTERED_PTR,
    pub bufferFormat: NV_ENC_BUFFER_FORMAT,
    pub bufferUsage: NV_ENC_BUFFER_USAGE,
    pub pInputFencePoint: *mut c_void,
    pub chromaOffset: [u32; 2],
    pub chromaOffsetIn: [u32; 2],
    pub reserved1: [u32; 244],
    pub reserved2: [*mut c_void; 61],
}

impl Default for NV_ENC_REGISTER_RESOURCE {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// =====================================================================
// NV_ENC_MAP_INPUT_RESOURCE
// =====================================================================

#[repr(C)]
pub struct NV_ENC_MAP_INPUT_RESOURCE {
    pub version: u32,
    pub subResourceIndex: u32,
    pub inputResource: *mut c_void,
    pub registeredResource: NV_ENC_REGISTERED_PTR,
    pub mappedResource: NV_ENC_INPUT_PTR,
    pub mappedBufferFmt: NV_ENC_BUFFER_FORMAT,
    pub reserved1: [u32; 251],
    pub reserved2: [*mut c_void; 63],
}

impl Default for NV_ENC_MAP_INPUT_RESOURCE {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// =====================================================================
// NV_ENC_CREATE_BITSTREAM_BUFFER
// =====================================================================

#[repr(C)]
pub struct NV_ENC_CREATE_BITSTREAM_BUFFER {
    pub version: u32,
    pub size: u32,
    pub memoryHeap: u32,
    pub reserved: u32,
    pub bitstreamBuffer: NV_ENC_OUTPUT_PTR,
    pub bitstreamBufferPtr: *mut c_void,
    pub reserved1: [u32; 58],
    pub reserved2: [*mut c_void; 64],
}

impl Default for NV_ENC_CREATE_BITSTREAM_BUFFER {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// =====================================================================
// NV_ENC_PIC_PARAMS
// =====================================================================

/// Union of per-codec picture parameters — 256 u32 in the C header.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_CODEC_PIC_PARAMS {
    pub raw: [u32; 256],
}

impl Default for NV_ENC_CODEC_PIC_PARAMS {
    fn default() -> Self {
        Self { raw: [0; 256] }
    }
}

#[repr(C)]
pub struct NV_ENC_PIC_PARAMS {
    pub version: u32,
    pub inputWidth: u32,
    pub inputHeight: u32,
    pub inputPitch: u32,
    pub encodePicFlags: NV_ENC_PIC_FLAGS,
    pub frameIdx: u32,
    pub inputTimeStamp: u64,
    pub inputDuration: u64,
    pub inputBuffer: NV_ENC_INPUT_PTR,
    pub outputBitstream: NV_ENC_OUTPUT_PTR,
    pub completionEvent: *mut c_void,
    pub bufferFmt: NV_ENC_BUFFER_FORMAT,
    pub pictureStruct: NV_ENC_PIC_STRUCT,
    pub pictureType: NV_ENC_PIC_TYPE,
    pub codecPicParams: NV_ENC_CODEC_PIC_PARAMS,
    pub meHintCountsPerBlock: [NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE; 2],
    pub meExternalHints: *mut c_void,
    pub reserved2: [u32; 7],
    pub reserved5: [*mut c_void; 2],
    pub qpDeltaMap: *mut i8,
    pub qpDeltaMapSize: u32,
    pub reservedBitFields: u32,
    pub meHintRefPicDist: [u16; 2],
    pub reserved4: u32,
    pub alphaBuffer: NV_ENC_INPUT_PTR,
    pub meExternalSbHints: *mut c_void,
    pub meSbHintsCount: u32,
    pub stateBufferIdx: u32,
    pub outputReconBuffer: NV_ENC_OUTPUT_PTR,
    pub reserved3: [u32; 284],
    pub reserved6: [*mut c_void; 57],
}

impl Default for NV_ENC_PIC_PARAMS {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// =====================================================================
// NV_ENC_LOCK_BITSTREAM
// =====================================================================

#[repr(C)]
pub struct NV_ENC_LOCK_BITSTREAM {
    pub version: u32,
    /// Bitfields: doNotWait (1) + ltrFrame (1) + getRCStats (1) + reserved (29)
    pub bitfields: u32,
    pub outputBitstream: *mut c_void,
    pub sliceOffsets: *mut u32,
    pub frameIdx: u32,
    pub hwEncodeStatus: u32,
    pub numSlices: u32,
    pub bitstreamSizeInBytes: u32,
    pub outputTimeStamp: u64,
    pub outputDuration: u64,
    pub bitstreamBufferPtr: *mut c_void,
    pub pictureType: NV_ENC_PIC_TYPE,
    pub pictureStruct: NV_ENC_PIC_STRUCT,
    pub frameAvgQP: u32,
    pub frameSatd: u32,
    pub ltrFrameIdx: u32,
    pub ltrFrameBitmap: u32,
    pub temporalId: u32,
    pub intraMBCount: u32,
    pub interMBCount: u32,
    pub averageMVX: i32,
    pub averageMVY: i32,
    pub alphaLayerSizeInBytes: u32,
    pub outputStatsPtrSize: u32,
    pub reserved: u32,
    pub outputStatsPtr: *mut c_void,
    pub frameIdxDisplay: u32,
    pub reserved1: [u32; 219],
    pub reserved2: [*mut c_void; 63],
    pub reservedInternal: [u32; 8],
}

impl Default for NV_ENC_LOCK_BITSTREAM {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// =====================================================================
// Function-pointer table
// =====================================================================

// Typed signatures for the entry points we actually call.

pub type PFN_OpenEncodeSessionEx = unsafe extern "C" fn(
    params: *mut NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS,
    encoder: *mut *mut c_void,
) -> NVENCSTATUS;

pub type PFN_InitializeEncoder = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_INITIALIZE_PARAMS,
) -> NVENCSTATUS;

pub type PFN_RegisterResource = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_REGISTER_RESOURCE,
) -> NVENCSTATUS;

pub type PFN_UnregisterResource = unsafe extern "C" fn(
    encoder: *mut c_void,
    registered: NV_ENC_REGISTERED_PTR,
) -> NVENCSTATUS;

pub type PFN_MapInputResource = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_MAP_INPUT_RESOURCE,
) -> NVENCSTATUS;

pub type PFN_UnmapInputResource = unsafe extern "C" fn(
    encoder: *mut c_void,
    mapped: NV_ENC_INPUT_PTR,
) -> NVENCSTATUS;

pub type PFN_CreateBitstreamBuffer = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_CREATE_BITSTREAM_BUFFER,
) -> NVENCSTATUS;

pub type PFN_DestroyBitstreamBuffer = unsafe extern "C" fn(
    encoder: *mut c_void,
    bitstream: NV_ENC_OUTPUT_PTR,
) -> NVENCSTATUS;

pub type PFN_EncodePicture = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_PIC_PARAMS,
) -> NVENCSTATUS;

pub type PFN_LockBitstream = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_LOCK_BITSTREAM,
) -> NVENCSTATUS;

pub type PFN_UnlockBitstream = unsafe extern "C" fn(
    encoder: *mut c_void,
    bitstream: NV_ENC_OUTPUT_PTR,
) -> NVENCSTATUS;

pub type PFN_DestroyEncoder = unsafe extern "C" fn(encoder: *mut c_void) -> NVENCSTATUS;

pub type PFN_GetSequenceParams = unsafe extern "C" fn(
    encoder: *mut c_void,
    payload: *mut NV_ENC_SEQUENCE_PARAM_PAYLOAD,
) -> NVENCSTATUS;

pub type PFN_GetLastErrorString =
    unsafe extern "C" fn(encoder: *mut c_void) -> *const std::ffi::c_char;

pub type PFN_RegisterAsyncEvent = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_EVENT_PARAMS,
) -> NVENCSTATUS;

pub type PFN_UnregisterAsyncEvent = unsafe extern "C" fn(
    encoder: *mut c_void,
    params: *mut NV_ENC_EVENT_PARAMS,
) -> NVENCSTATUS;

pub type PFN_GetEncodePresetConfigEx = unsafe extern "C" fn(
    encoder: *mut c_void,
    encodeGUID: GUID,
    presetGUID: GUID,
    tuningInfo: NV_ENC_TUNING_INFO,
    presetConfig: *mut NV_ENC_PRESET_CONFIG,
) -> NVENCSTATUS;

pub type PFN_GetEncodeGUIDCount =
    unsafe extern "C" fn(encoder: *mut c_void, encodeGUIDCount: *mut u32) -> NVENCSTATUS;

pub type PFN_GetEncodeGUIDs = unsafe extern "C" fn(
    encoder: *mut c_void,
    guids: *mut GUID,
    guidArraySize: u32,
    guidCount: *mut u32,
) -> NVENCSTATUS;

// Function-pointer table. Layout must match the C header line-for-line.
// Pointers we don't call are kept as opaque `*mut c_void`.
#[repr(C)]
pub struct NV_ENCODE_API_FUNCTION_LIST {
    pub version: u32,
    pub reserved: u32,

    pub nvEncOpenEncodeSession: *mut c_void,
    pub nvEncGetEncodeGUIDCount: Option<PFN_GetEncodeGUIDCount>,
    pub nvEncGetEncodeProfileGUIDCount: *mut c_void,
    pub nvEncGetEncodeProfileGUIDs: *mut c_void,
    pub nvEncGetEncodeGUIDs: Option<PFN_GetEncodeGUIDs>,
    pub nvEncGetInputFormatCount: *mut c_void,
    pub nvEncGetInputFormats: *mut c_void,
    pub nvEncGetEncodeCaps: *mut c_void,
    pub nvEncGetEncodePresetCount: *mut c_void,
    pub nvEncGetEncodePresetGUIDs: *mut c_void,
    pub nvEncGetEncodePresetConfig: *mut c_void,
    pub nvEncInitializeEncoder: Option<PFN_InitializeEncoder>,
    pub nvEncCreateInputBuffer: *mut c_void,
    pub nvEncDestroyInputBuffer: *mut c_void,
    pub nvEncCreateBitstreamBuffer: Option<PFN_CreateBitstreamBuffer>,
    pub nvEncDestroyBitstreamBuffer: Option<PFN_DestroyBitstreamBuffer>,
    pub nvEncEncodePicture: Option<PFN_EncodePicture>,
    pub nvEncLockBitstream: Option<PFN_LockBitstream>,
    pub nvEncUnlockBitstream: Option<PFN_UnlockBitstream>,
    pub nvEncLockInputBuffer: *mut c_void,
    pub nvEncUnlockInputBuffer: *mut c_void,
    pub nvEncGetEncodeStats: *mut c_void,
    pub nvEncGetSequenceParams: Option<PFN_GetSequenceParams>,
    pub nvEncRegisterAsyncEvent: Option<PFN_RegisterAsyncEvent>,
    pub nvEncUnregisterAsyncEvent: Option<PFN_UnregisterAsyncEvent>,
    pub nvEncMapInputResource: Option<PFN_MapInputResource>,
    pub nvEncUnmapInputResource: Option<PFN_UnmapInputResource>,
    pub nvEncDestroyEncoder: Option<PFN_DestroyEncoder>,
    pub nvEncInvalidateRefFrames: *mut c_void,
    pub nvEncOpenEncodeSessionEx: Option<PFN_OpenEncodeSessionEx>,
    pub nvEncRegisterResource: Option<PFN_RegisterResource>,
    pub nvEncUnregisterResource: Option<PFN_UnregisterResource>,
    pub nvEncReconfigureEncoder: *mut c_void,
    pub reserved1: *mut c_void,
    pub nvEncCreateMVBuffer: *mut c_void,
    pub nvEncDestroyMVBuffer: *mut c_void,
    pub nvEncRunMotionEstimationOnly: *mut c_void,
    pub nvEncGetLastErrorString: Option<PFN_GetLastErrorString>,
    pub nvEncSetIOCudaStreams: *mut c_void,
    pub nvEncGetEncodePresetConfigEx: Option<PFN_GetEncodePresetConfigEx>,
    pub nvEncGetSequenceParamEx: *mut c_void,
    pub nvEncRestoreEncoderState: *mut c_void,
    pub nvEncLookaheadPicture: *mut c_void,

    pub reserved2: [*mut c_void; 275],
}

impl Default for NV_ENCODE_API_FUNCTION_LIST {
    fn default() -> Self {
        unsafe { std::mem::zeroed() }
    }
}

// =====================================================================
// DLL entry point
// =====================================================================

pub type PFN_NvEncodeAPICreateInstance =
    unsafe extern "C" fn(function_list: *mut NV_ENCODE_API_FUNCTION_LIST) -> NVENCSTATUS;

pub const NVENC_DLL_NAME: &str = "nvEncodeAPI64.dll";
pub const NVENC_CREATE_INSTANCE_SYM: &[u8] = b"NvEncodeAPICreateInstance";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_macros_match_header() {
        assert_eq!(NVENCAPI_VERSION, 13);
        assert_eq!(NV_ENCODE_API_FUNCTION_LIST_VER, 0x7002_000D);
    }

    #[test]
    fn function_list_layout_size_matches_c() {
        // 8 + 42*8 + 8 + 275*8 = 2552
        assert_eq!(std::mem::size_of::<NV_ENCODE_API_FUNCTION_LIST>(), 2552);
    }

    #[test]
    fn guid_is_16_bytes() {
        assert_eq!(std::mem::size_of::<GUID>(), 16);
    }

    #[test]
    fn config_struct_sizes_match_sdk_13() {
        // Verified against `cl /Fe` of a probe including nvEncodeAPI.h from
        // Video Codec SDK 13.0.37. Do not change these without re-running
        // the probe against your SDK headers.
        assert_eq!(std::mem::size_of::<NV_ENC_QP>(), 12);
        assert_eq!(std::mem::size_of::<NV_ENC_RC_PARAMS>(), 128);
        assert_eq!(std::mem::size_of::<NV_ENC_CONFIG>(), 3584);
        assert_eq!(std::mem::size_of::<NV_ENC_PRESET_CONFIG>(), 5128);
        // 4 + 4 + 8 + 254*4 + 64*8 = 1544
        assert_eq!(std::mem::size_of::<NV_ENC_EVENT_PARAMS>(), 1544);

        assert_eq!(std::mem::offset_of!(NV_ENC_CONFIG, gopLength), 20);
        assert_eq!(std::mem::offset_of!(NV_ENC_CONFIG, rcParams), 40);
        assert_eq!(std::mem::offset_of!(NV_ENC_CONFIG, encodeCodecConfig), 168);
        assert_eq!(std::mem::offset_of!(NV_ENC_RC_PARAMS, averageBitRate), 20);
        assert_eq!(std::mem::offset_of!(NV_ENC_PRESET_CONFIG, presetCfg), 8);

        // AV1 struct layout — these MUST match SDK 13 `_NV_ENC_CONFIG_AV1`.
        // Counted from the header by hand (see `crates/encoder/src/sys.rs`
        // doc on `NV_ENC_CONFIG_AV1`). Previous offset-by-offset byte
        // poking had these wrong, which silently miscoded AV1 IDRs as
        // INTRA_ONLY_FRAME instead of KEY_FRAME.
        assert_eq!(std::mem::offset_of!(NV_ENC_CONFIG_AV1, flags), 16);
        assert_eq!(std::mem::offset_of!(NV_ENC_CONFIG_AV1, idrPeriod), 20);
        assert_eq!(std::mem::offset_of!(NV_ENC_CONFIG_AV1, tileWidths), 48);
        assert_eq!(std::mem::offset_of!(NV_ENC_CONFIG_AV1, filmGrainParams), 96);
        assert_eq!(std::mem::offset_of!(NV_ENC_CONFIG_AV1, numFwdRefs), 104);
        assert_eq!(std::mem::offset_of!(NV_ENC_CONFIG_AV1, tfLevel), 128);
    }

    #[test]
    fn me_hint_counts_per_blocktype_is_16_bytes() {
        // 4 (bitfields) + 12 (reserved1[3]) = 16
        assert_eq!(
            std::mem::size_of::<NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE>(),
            16
        );
    }
}
