//! Safe wrapper around an NVENC encode session for D3D11 input.
//!
//! Lifecycle:
//!   `NvEncoderD3D11::new(device, config)`
//!       -> opens session with `nvEncOpenEncodeSessionEx`
//!       -> initializes with H.264 / preset P4 / LOW_LATENCY tuning
//!       -> allocates a small pool of bitstream output buffers
//!   `encode_frame(texture, pts_100ns)`
//!       -> registers the texture as input (NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX)
//!       -> maps -> encodes -> locks bitstream -> copies NAL bytes out
//!       -> unmaps / unregisters / unlocks
//!   `flush()`
//!       -> EOS picture, drains remaining encoded packets
//!   `Drop`
//!       -> destroys bitstream buffers, destroys encoder
//!
//! Per-frame register/unregister is slower than maintaining a registration
//! cache keyed by texture pointer, but it's the simplest correct
//! implementation and keeps the prototype small. Optimization is a follow-up.

use anyhow::{anyhow, bail, Result};
use clipdip_ringbuf::{EncodedPacket, STREAM_VIDEO};
use std::collections::VecDeque;
use std::ffi::CStr;
use std::ptr;
use std::sync::Arc;
use tracing::{info, trace, warn};
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};

use crate::loader::NvEncApi;
use crate::nv12_converter::Nv12Converter;
use crate::sys::*;
use crate::{ActiveCodec, CodecPreference, EncoderConfig, RateControl};

const BITSTREAM_POOL_SIZE: usize = 4;

/// One submitted-but-not-yet-locked frame. NVENC will signal
/// `pool[slot].event` when the bitstream is ready; until then this entry
/// sits in `pending`.
struct PendingFrame {
    slot: usize,
}

/// Bitstream buffer + paired completion event. In async mode every
/// submitted picture is associated with one of these; NVENC signals the
/// event when the bitstream for that picture is ready. In sync mode
/// (AV1 — async is unreliable on the AV1 codec path and causes the
/// driver to emit INTRA_ONLY instead of KEY_FRAME at IDRs) `event` is
/// `HANDLE(0)` and we don't register/wait on it.
struct PoolSlot {
    bitstream: NV_ENC_OUTPUT_PTR,
    event: HANDLE,
}

pub struct NvEncoderD3D11 {
    api: Arc<NvEncApi>,
    encoder: *mut std::ffi::c_void,
    _device: ID3D11Device,
    /// Immediate device context. Cloned into `nv12_converter` for the
    /// per-frame draw calls; kept here too so we own a reference for the
    /// encoder's lifetime independent of the converter.
    _context: ID3D11DeviceContext,
    /// NV12-format staging textures, one per bitstream slot. We
    /// round-robin so back-to-back submissions never reuse the same
    /// texture pointer — NVENC holds a reference to the input until the
    /// corresponding output bitstream is consumed.
    nv12_pool: Vec<ID3D11Texture2D>,
    /// NVENC registered-resource handles for each `nv12_pool` slot.
    /// Registered once at `new()` and reused for the lifetime of the
    /// encoder — `nvEncRegisterResource` is expensive and unnecessary
    /// per frame when the textures are stable.
    nv12_registered: Vec<NV_ENC_REGISTERED_PTR>,
    /// Shader-based BGRA→NV12 converter. `CopyResource` cannot bridge
    /// these formats (it's a bit-level copy across compatible families
    /// only), so each frame we render the capture into NV12 via two
    /// fullscreen-triangle pixel-shader passes — Y plane, then UV.
    nv12_converter: Nv12Converter,
    config: EncoderConfig,
    /// The NV_ENC_CONFIG submitted at init, kept boxed (stable address)
    /// because `reconfigure_rate_control` re-submits it — with updated
    /// `rcParams` — through NVENC's Reconfigure API.
    enc_cfg: Box<NV_ENC_CONFIG>,
    /// The init params submitted at init, re-used verbatim (except for the
    /// `encodeConfig` pointer, refreshed each call) on reconfigure.
    init_params: NV_ENC_INITIALIZE_PARAMS,
    /// Codec actually negotiated at session open. Drives the keyframe
    /// scanner and any caller that needs to know whether the bitstream is
    /// AVC NAL units or AV1 OBUs.
    active_codec: ActiveCodec,
    /// Paired (bitstream, completion event) entries. Allocated once at
    /// `new()`; reused via round-robin across submissions.
    pool: Vec<PoolSlot>,
    /// Next slot to hand out on submit. Wraps `0..pool.len()`.
    next_slot: usize,
    /// Submitted frames whose bitstream we haven't read back yet, in
    /// submission order (FIFO). NVENC produces output strictly in
    /// submission order for our no-B-frame config, so the front entry is
    /// the next one whose event will signal.
    pending: VecDeque<PendingFrame>,
    frames_submitted: u64,
    force_idr: bool,
    /// Async-mode flag chosen at session open. True for H.264 (per-frame
    /// completion events let us submit ahead of encode). False for AV1 —
    /// the NVENC AV1 path in async mode empirically produces IDRs as
    /// `OBU_FRAME` with `frame_type=INTRA_ONLY` (2) instead of `KEY_FRAME`
    /// (0). INTRA_ONLY doesn't reset reference picture state, so decoders
    /// bootstrapping from a saved clip fail with "no sequence header" on
    /// every frame and the muxed mp4 is unusable. Sync mode side-steps
    /// the bug entirely.
    async_mode: bool,
    /// Codec-specific sequence header bytes retrieved via
    /// `nvEncGetSequenceParams` after `InitializeEncoder` returns.
    /// For H.264 this is concatenated SPS+PPS; for AV1 it's an
    /// `OBU_SEQUENCE_HEADER`. We cache it here because NVENC AV1 doesn't
    /// reliably embed the sequence header at the head of every IDR
    /// bitstream even with `repeatSeqHdr=1`, and ffmpeg refuses to mux an
    /// AV1 raw input where the first OBU is not a sequence header
    /// ("dimensions not set"). Callers prepend this to the saved
    /// bitstream file. OBS does the same.
    header: Vec<u8>,
}

// SAFETY: we own the encoder handle. NVENC sessions are not thread-safe and
// we never share the handle across threads — the type is !Send by default
// (raw pointer field).
unsafe impl Send for NvEncoderD3D11 {}

impl NvEncoderD3D11 {
    pub fn new(device: ID3D11Device, config: EncoderConfig) -> Result<Self> {
        let api = NvEncApi::load()?;

        // ---- open session ------------------------------------------------
        let mut session = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS::default();
        session.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
        session.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
        // SAFETY: ID3D11Device implements IUnknown via the windows-rs Interface
        // trait; its raw pointer is what NVENC expects as `device`.
        session.device = device.as_raw() as *mut _;
        session.apiVersion = NVENCAPI_VERSION;

        let mut encoder: *mut std::ffi::c_void = ptr::null_mut();
        let open = api.functions.nvEncOpenEncodeSessionEx.expect("loader checked");
        // SAFETY: `session` is a properly-initialized #[repr(C)] struct with
        // the correct version tag and a valid D3D11 device pointer.
        let status = unsafe { (open)(&mut session, &mut encoder) };
        nvenc_check(&api, encoder, status, "OpenEncodeSessionEx")?;
        if encoder.is_null() {
            bail!("OpenEncodeSessionEx returned success but encoder handle is null");
        }

        // ---- codec capability probe -------------------------------------
        // Ask the driver which codec GUIDs this GPU supports, then resolve
        // the caller's preference. AV1 NVENC needs Ada (RTX 40+); on older
        // silicon we transparently fall back to H.264.
        let supported = query_supported_codecs(&api, encoder)?;
        let active_codec = resolve_codec(config.codec_preference, &supported)?;
        let encode_guid = match active_codec {
            ActiveCodec::H264 => NV_ENC_CODEC_H264_GUID,
            ActiveCodec::Av1 => NV_ENC_CODEC_AV1_GUID,
        };

        // ---- query preset defaults --------------------------------------
        // Start from the driver's recommended config for our chosen codec +
        // preset + tuning, then override only what we care about
        // (gopLength + idrPeriod + rate-control). This preserves any AQ /
        // VBV / profile defaults the driver picked.
        let mut preset = NV_ENC_PRESET_CONFIG::default();
        preset.version = NV_ENC_PRESET_CONFIG_VER;
        preset.presetCfg.version = NV_ENC_CONFIG_VER;
        preset.presetCfg.rcParams.version = NV_ENC_RC_PARAMS_VER;
        let preset_fn = api
            .functions
            .nvEncGetEncodePresetConfigEx
            .expect("loader checked");
        // SAFETY: `preset` is a valid #[repr(C)] struct with correct version
        // tags. encoder is a live session handle.
        let status = unsafe {
            (preset_fn)(
                encoder,
                encode_guid,
                NV_ENC_PRESET_P4_GUID,
                NV_ENC_TUNING_INFO_LOW_LATENCY,
                &mut preset,
            )
        };
        nvenc_check(&api, encoder, status, "GetEncodePresetConfigEx")?;

        // ---- override the knobs we care about ---------------------------
        // Boxed so the pointer handed to NVENC in `encodeConfig` stays
        // valid for the encoder's lifetime — `reconfigure_rate_control`
        // re-submits the same config with updated rcParams.
        let mut enc_cfg = Box::new(preset.presetCfg);
        enc_cfg.version = NV_ENC_CONFIG_VER;
        enc_cfg.gopLength = config.gop_length;
        enc_cfg.frameIntervalP = 1; // IPP... (no B-frames in low-latency)

        match active_codec {
            ActiveCodec::H264 => {
                enc_cfg.set_h264_idr_period(config.gop_length);
                // Emit SPS+PPS in front of EVERY IDR, not just frame 0. The
                // ring evicts whole GOPs once full, so without this any
                // clip saved after the first eviction would start with an
                // IDR slice whose SPS+PPS are no longer in the file —
                // ffmpeg / players reject it with "non-existing PPS 0
                // referenced".
                enc_cfg.set_h264_repeat_sps_pps(true);
            }
            ActiveCodec::Av1 => {
                // AV1 needs more than the preset query supplies. Mirror
                // what OBS does in obs-nvenc/nvenc.c `init_encoder_av1`:
                // without `chromaFormatIDC=1`, `inputBitDepth`, profile/
                // tier/level, and explicit reference counts, NVENC AV1
                // produces malformed bitstreams — IDRs come out as
                // OBU_FRAME with frame_type=INTRA_ONLY_FRAME instead of
                // KEY_FRAME, the sequence header is never re-emitted,
                // and decoders fail to bootstrap on saved clips.
                enc_cfg.profileGUID = NV_ENC_AV1_PROFILE_MAIN_GUID;
                let av1 = enc_cfg.av1_config_mut();
                av1.level = NV_ENC_LEVEL_AV1_AUTOSELECT;
                av1.tier = NV_ENC_TIER_AV1_0;
                av1.idrPeriod = config.gop_length;
                // Bitfield: repeatSeqHdr=1, chromaFormatIDC=1 (yuv420).
                // All other flag bits start zeroed from the preset query
                // and we keep them that way.
                av1.flags = (1 << 5) | (1 << 7);
                av1.chromaSamplePosition = 0;
                av1.colorRange = 0; // studio range
                av1.numFwdRefs = NV_ENC_NUM_REF_FRAMES_1;
                av1.numBwdRefs = NV_ENC_NUM_REF_FRAMES_1;
                av1.inputBitDepth = NV_ENC_BIT_DEPTH_8;
                av1.outputBitDepth = NV_ENC_BIT_DEPTH_8;
                av1.useBFramesAsRef = NV_ENC_BFRAME_REF_MODE_DISABLED;
            }
        }

        enc_cfg.rcParams.version = NV_ENC_RC_PARAMS_VER;
        apply_rate_control(&mut enc_cfg.rcParams, active_codec, config.rate_control);

        // Dump of the effective encode config (driver preset defaults +
        // our overrides). Preset defaults vary by driver version, so this
        // line is what makes "what did the encoder actually run with"
        // answerable from a user's log. Re-logged on every reconfigure.
        log_effective_config(&enc_cfg);

        // ---- initialize -------------------------------------------------
        let mut init = NV_ENC_INITIALIZE_PARAMS::default();
        init.version = NV_ENC_INITIALIZE_PARAMS_VER;
        init.encodeGUID = encode_guid;
        init.presetGUID = NV_ENC_PRESET_P4_GUID;
        init.encodeWidth = config.width;
        init.encodeHeight = config.height;
        init.darWidth = config.width;
        init.darHeight = config.height;
        init.frameRateNum = config.fps_num;
        init.frameRateDen = config.fps_den;
        init.enablePTD = 1; // let NVENC choose picture types
        init.maxEncodeWidth = config.width;
        init.maxEncodeHeight = config.height;
        init.tuningInfo = NV_ENC_TUNING_INFO_LOW_LATENCY;
        // NV12 input. The capture path runs `CopyResource` from each
        // BGRA frame into one of `nv12_pool` (allocated below), letting
        // the D3D11 driver do the color-space conversion in hardware.
        // Feeding NVENC ARGB instead makes it do the conversion on the
        // 3D engine internally, which is roughly the entire 5–10% delta
        // we measured against OBS.
        init.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
        init.encodeConfig = enc_cfg.as_mut() as *mut NV_ENC_CONFIG as *mut std::ffi::c_void;
        // Async mode: NVENC signals a per-frame completion event when the
        // bitstream is ready instead of making LockBitstream block. Lets
        // us submit frame N+1 while frame N is still encoding — saves the
        // ~2.2 ms / frame CPU wait we'd otherwise burn.
        //
        // AV1 exception: async mode on the AV1 codec path causes the
        // driver to emit `INTRA_ONLY_FRAME` (frame_type=2) at IDR
        // boundaries instead of `KEY_FRAME` (frame_type=0). INTRA_ONLY
        // doesn't reset reference picture state, so saved clips can't
        // be bootstrapped by decoders ("no sequence header" cascade).
        // Sync mode produces real KEY_FRAMEs.
        let async_mode = matches!(active_codec, ActiveCodec::H264);
        init.enableEncodeAsync = if async_mode { 1 } else { 0 };

        let init_fn = api.functions.nvEncInitializeEncoder.expect("loader checked");
        // SAFETY: encoder is a valid handle returned by OpenEncodeSessionEx;
        // `init` is properly initialized and `enc_cfg` lives until after
        // InitializeEncoder returns (the call copies what it needs).
        let status = unsafe { (init_fn)(encoder, &mut init) };
        nvenc_check(&api, encoder, status, "InitializeEncoder")?;

        // ---- allocate bitstream output pool + completion events --------
        // Each output buffer is paired with a Win32 auto-reset event.
        // NVENC signals the event for picture N when picture N's bitstream
        // is ready to lock. Auto-reset (`bManualReset=FALSE`) means a
        // successful WaitForSingleObject leaves the event unsignaled —
        // exactly what we want for "consume once" semantics.
        let mut pool = Vec::with_capacity(BITSTREAM_POOL_SIZE);
        let create_bs = api
            .functions
            .nvEncCreateBitstreamBuffer
            .expect("loader checked");
        let register_evt = api
            .functions
            .nvEncRegisterAsyncEvent
            .expect("loader checked");
        for _ in 0..BITSTREAM_POOL_SIZE {
            // Bitstream buffer.
            let mut bs = NV_ENC_CREATE_BITSTREAM_BUFFER::default();
            bs.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
            // SAFETY: well-formed init struct.
            let status = unsafe { (create_bs)(encoder, &mut bs) };
            nvenc_check(&api, encoder, status, "CreateBitstreamBuffer")?;

            // Completion event — only created/registered in async mode.
            // Sync mode uses HANDLE(0) as a sentinel and skips wait/close.
            let event = if async_mode {
                // SAFETY: parameters are all null/false except `bManualReset`
                // which we explicitly want false (auto-reset).
                let event = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }
                    .map_err(|e| anyhow!("CreateEventW failed: {e}"))?;
                let mut evt_params = NV_ENC_EVENT_PARAMS::default();
                evt_params.version = NV_ENC_EVENT_PARAMS_VER;
                evt_params.completionEvent = event.0 as *mut _;
                // SAFETY: encoder + params are valid.
                let status = unsafe { (register_evt)(encoder, &mut evt_params) };
                nvenc_check(&api, encoder, status, "RegisterAsyncEvent")?;
                event
            } else {
                HANDLE(std::ptr::null_mut())
            };

            pool.push(PoolSlot {
                bitstream: bs.bitstreamBuffer,
                event,
            });
        }

        // ---- allocate NV12 staging textures + register with NVENC -------
        // One texture per bitstream slot so round-robin submissions never
        // hand NVENC the same pointer back-to-back. The driver does
        // BGRA→NV12 on `CopyResource` into these.
        // SAFETY: device is a live D3D11 device; GetImmediateContext is
        // always safe to call and returns the device's immediate context.
        let context = unsafe { device.GetImmediateContext() }
            .map_err(|e| anyhow!("GetImmediateContext failed: {e}"))?;

        let mut nv12_pool: Vec<ID3D11Texture2D> = Vec::with_capacity(BITSTREAM_POOL_SIZE);
        let mut nv12_registered: Vec<NV_ENC_REGISTERED_PTR> =
            Vec::with_capacity(BITSTREAM_POOL_SIZE);
        let register_fn = api
            .functions
            .nvEncRegisterResource
            .expect("loader checked");
        for _ in 0..BITSTREAM_POOL_SIZE {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: config.width,
                Height: config.height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut tex = None;
            // SAFETY: well-formed desc; driver fills in tex.
            unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex))? };
            let tex = tex.ok_or_else(|| anyhow!("CreateTexture2D(NV12) returned null"))?;

            let mut reg = NV_ENC_REGISTER_RESOURCE::default();
            reg.version = NV_ENC_REGISTER_RESOURCE_VER;
            reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
            reg.width = config.width;
            reg.height = config.height;
            reg.pitch = 0;
            reg.resourceToRegister = tex.as_raw() as *mut _;
            reg.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
            reg.bufferUsage = NV_ENC_INPUT_IMAGE;
            // SAFETY: encoder live; reg is properly initialized.
            let status = unsafe { (register_fn)(encoder, &mut reg) };
            nvenc_check(&api, encoder, status, "RegisterResource (NV12)")?;

            nv12_pool.push(tex);
            nv12_registered.push(reg.registeredResource);
        }

        let nv12_converter =
            Nv12Converter::new(device.clone(), context.clone(), config.width, config.height)?;

        // Retrieve the codec sequence header (H.264 SPS+PPS or AV1
        // sequence header OBU) out of band. OBS does this on the first
        // packet; doing it once at init is equivalent because the
        // sequence parameters don't change for the life of the session,
        // and it keeps the per-packet hot path free of an extra API
        // call. Saving paths prepend these bytes to the bitstream file
        // so decoders / muxers see a sequence header at byte 0 even
        // when NVENC's `repeatSeqHdr` doesn't materialize one in front
        // of an arbitrary mid-stream IDR.
        let mut header_buf = vec![0u8; 1024];
        let mut header_size: u32 = 0;
        let mut payload = NV_ENC_SEQUENCE_PARAM_PAYLOAD::default();
        payload.version = NV_ENC_SEQUENCE_PARAM_PAYLOAD_VER;
        payload.inBufferSize = header_buf.len() as u32;
        payload.spsppsBuffer = header_buf.as_mut_ptr() as *mut std::ffi::c_void;
        payload.outSPSPPSPayloadSize = &mut header_size;
        let get_seq = api
            .functions
            .nvEncGetSequenceParams
            .expect("loader checked");
        // SAFETY: encoder is initialized; payload buffer is large enough
        // for both H.264 SPS+PPS (~50 B) and AV1 sequence header (~30 B).
        let status = unsafe { (get_seq)(encoder, &mut payload) };
        nvenc_check(&api, encoder, status, "GetSequenceParams")?;
        header_buf.truncate(header_size as usize);

        Ok(Self {
            api,
            encoder,
            _device: device,
            _context: context,
            nv12_pool,
            nv12_registered,
            nv12_converter,
            config,
            enc_cfg,
            init_params: init,
            active_codec,
            pool,
            next_slot: 0,
            pending: VecDeque::with_capacity(BITSTREAM_POOL_SIZE),
            frames_submitted: 0,
            // Force the very first frame to emit SPS+PPS+IDR so decoders
            // can latch on immediately, regardless of where the next
            // automatic IDR (driven by gopLength) would fall.
            force_idr: true,
            async_mode,
            header: header_buf,
        })
    }

    /// Codec sequence-header bytes (H.264 SPS+PPS, AV1 OBU_SEQUENCE_HEADER)
    /// captured once at session open. Save flows prepend these to the
    /// bitstream file so ffmpeg / decoders always see a valid header even
    /// when the saved window doesn't start exactly at a NVENC keyframe
    /// that re-emitted one.
    pub fn header(&self) -> &[u8] {
        &self.header
    }

    /// Codec the encoder negotiated at session open. Useful for logging
    /// and for callers (muxer / keyframe scanner) that need to know
    /// whether the bitstream is H.264 NAL units or AV1 OBUs.
    pub fn active_codec(&self) -> ActiveCodec {
        self.active_codec
    }

    /// Manually request an IDR on the next submitted frame. Not needed for
    /// normal operation — the bound `gopLength` drives automatic IDR
    /// cadence — but useful if a future feature wants on-demand scene cuts
    /// or recovery after a network blip.
    pub fn force_idr_next_frame(&mut self) {
        self.force_idr = true;
    }

    /// Change rate-control *parameters* on the live session without
    /// resetting it — used to boost quality for the duration of a manual
    /// recording. The bitstream stays continuous (same sequence header,
    /// same reference state), so packets from before and after the switch
    /// mux into one playable file.
    ///
    /// NVENC cannot switch rate-control *mode* dynamically, so `rc` must be
    /// the same variant the session was opened with (CQP→CQP or VBR→VBR).
    /// Forces an IDR so the new quality takes effect on a clean GOP
    /// boundary instead of mid-GOP.
    pub fn reconfigure_rate_control(&mut self, rc: RateControl) -> Result<()> {
        if std::mem::discriminant(&rc) != std::mem::discriminant(&self.config.rate_control) {
            bail!(
                "NVENC can't switch rate-control mode on a live session \
                 (session: {:?}, requested: {:?})",
                self.config.rate_control,
                rc
            );
        }
        let reconfigure = self
            .api
            .functions
            .nvEncReconfigureEncoder
            .ok_or_else(|| anyhow!("driver did not populate nvEncReconfigureEncoder"))?;

        let prev_rc_params = self.enc_cfg.rcParams;
        apply_rate_control(&mut self.enc_cfg.rcParams, self.active_codec, rc);

        let mut params = NV_ENC_RECONFIGURE_PARAMS::default();
        params.version = NV_ENC_RECONFIGURE_PARAMS_VER;
        params.reInitEncodeParams = self.init_params;
        params.reInitEncodeParams.encodeConfig =
            self.enc_cfg.as_mut() as *mut NV_ENC_CONFIG as *mut std::ffi::c_void;
        // No resetEncoder: keep reference state + sequence header so the
        // in-flight bitstream stays decodable across the switch.
        params.bitfields = NV_ENC_RECONFIGURE_FLAG_FORCE_IDR;

        // SAFETY: encoder is a live session handle; `params` is a
        // well-formed #[repr(C)] struct whose encodeConfig points at the
        // boxed NV_ENC_CONFIG owned by `self`, alive for the whole call.
        let status = unsafe { (reconfigure)(self.encoder, &mut params) };
        if let Err(e) = nvenc_check(&self.api, self.encoder, status, "ReconfigureEncoder") {
            // Session unchanged on failure — keep our mirror in sync.
            self.enc_cfg.rcParams = prev_rc_params;
            return Err(e);
        }
        self.config.rate_control = rc;
        log_effective_config(&self.enc_cfg);
        Ok(())
    }

    /// Submit one captured texture. Returns zero or more encoded packets —
    /// NVENC may buffer the first few frames before producing output.
    ///
    /// Registrations are cached by texture pointer. The duplicator reuses
    /// the same private texture handle across calls, so the cache typically
    /// has only 1–2 live entries.
    pub fn encode_frame(
        &mut self,
        texture: &ID3D11Texture2D,
        pts_100ns: i64,
    ) -> Result<Vec<EncodedPacket>> {
        let _t = clipdip_profile::start("encoder.encode_frame");
        let mut packets = Vec::new();

        // ---- safety valve: if all slots are in flight, wait on the
        // oldest before reusing its buffer. Should be rare under steady
        // state — pool depth is 4 and our per-frame encode latency p99
        // is ~4 ms vs a 16.7 ms frame interval, leaving plenty of slack.
        if self.pending.len() >= self.pool.len() {
            let pkt = self.wait_and_lock_front()?;
            packets.push(pkt);
        }

        // ---- pick a slot. Same index for input NV12 staging and output
        // bitstream so they stay in lockstep — when slot N's bitstream
        // is consumed, slot N's NV12 texture is safe to overwrite.
        let slot = self.next_slot;
        self.next_slot = (slot + 1) % self.pool.len();

        // ---- BGRA → NV12 via two pixel-shader passes (Y + UV). This
        // replaces what NVENC would otherwise do internally for ARGB
        // input — the driver+shader path here is cheaper and gives us
        // explicit control of the color matrix (BT.709 full range).
        let _t_copy = clipdip_profile::start("encoder.bgra_to_nv12");
        self.nv12_converter
            .convert(texture, &self.nv12_pool[slot])?;
        drop(_t_copy);

        let _t_map = clipdip_profile::start("encoder.map");
        let mut mapped = NV_ENC_MAP_INPUT_RESOURCE::default();
        mapped.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
        mapped.registeredResource = self.nv12_registered[slot];

        let map_fn = self.api.functions.nvEncMapInputResource.expect("loader checked");
        let status = unsafe { (map_fn)(self.encoder, &mut mapped) };
        nvenc_check(&self.api, self.encoder, status, "MapInputResource")?;

        let output = self.pool[slot].bitstream;
        let event = self.pool[slot].event;

        // ---- encode picture ---------------------------------------------
        let mut pic = NV_ENC_PIC_PARAMS::default();
        pic.version = NV_ENC_PIC_PARAMS_VER;
        pic.inputWidth = self.config.width;
        pic.inputHeight = self.config.height;
        pic.inputPitch = self.config.width;
        pic.inputBuffer = mapped.mappedResource;
        pic.bufferFmt = NV_ENC_BUFFER_FORMAT_NV12;
        pic.outputBitstream = output;
        // Null completionEvent in sync mode — NVENC interprets a non-null
        // event in sync mode as a config error.
        pic.completionEvent = if self.async_mode {
            event.0 as *mut _
        } else {
            std::ptr::null_mut()
        };
        pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
        pic.inputTimeStamp = pts_100ns as u64;
        pic.frameIdx = self.frames_submitted as u32;
        if self.force_idr {
            pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
            self.force_idr = false;
        }

        drop(_t_map);
        let t_submit = clipdip_profile::start("encoder.submit");
        let encode_fn = self.api.functions.nvEncEncodePicture.expect("loader checked");
        let status = unsafe { (encode_fn)(self.encoder, &mut pic) };
        drop(t_submit);

        // Async mode: NVENC fires a completion event for every submitted
        // picture even when EncodePicture returns NEED_MORE_INPUT (the
        // picture was consumed; the bitstream just isn't ready yet). Push
        // to `pending` and let the drain logic pick it up via the event.
        //
        // Sync mode: SUCCESS means the bitstream for *this* picture (plus
        // any earlier buffered ones in submission order) is ready to
        // lock right now — drain inline. NEED_MORE_INPUT means the
        // picture was consumed but output is still buffered up; defer it.
        match status {
            NV_ENC_SUCCESS => {
                self.pending.push_back(PendingFrame { slot });
                if !self.async_mode {
                    while let Some(p) = self.pending.pop_front() {
                        packets.push(self.lock_one(self.pool[p.slot].bitstream)?);
                    }
                }
            }
            NV_ENC_ERR_NEED_MORE_INPUT => {
                self.pending.push_back(PendingFrame { slot });
            }
            _ => {
                // Unmap before bubbling error so we don't leak the mapping.
                let unmap_fn = self.api.functions.nvEncUnmapInputResource.unwrap();
                unsafe { (unmap_fn)(self.encoder, mapped.mappedResource) };
                return Err(nvenc_error(&self.api, self.encoder, status, "EncodePicture"));
            }
        }
        self.frames_submitted += 1;

        // ---- unmap (safe to do now; NVENC has copied what it needs) ----
        let unmap_fn = self.api.functions.nvEncUnmapInputResource.expect("loader checked");
        let status = unsafe { (unmap_fn)(self.encoder, mapped.mappedResource) };
        if status != NV_ENC_SUCCESS {
            warn!(status, "UnmapInputResource failed");
        }

        // ---- non-blocking drain (async mode only) ----------------------
        // Walk the front of the pending queue, popping any frames whose
        // events are already signaled. Lets us catch up if encode is
        // running ahead of submission (which is the steady state at
        // 60 fps + 2.4 ms p50 encode time). Sync mode already drained
        // above on SUCCESS, so there's nothing to poll for here.
        if self.async_mode {
            loop {
                let front_slot = match self.pending.front() {
                    Some(f) => f.slot,
                    None => break,
                };
                let front_event = self.pool[front_slot].event;
                // SAFETY: HANDLE is valid until Drop.
                let wait = unsafe { WaitForSingleObject(front_event, 0) };
                if wait == WAIT_OBJECT_0 {
                    self.pending.pop_front();
                    packets.push(self.lock_one(self.pool[front_slot].bitstream)?);
                } else {
                    break;
                }
            }
        }

        Ok(packets)
    }

    /// Block-wait on the front of the pending queue and lock its
    /// bitstream. Used by the safety valve (pool full) and by `flush`.
    fn wait_and_lock_front(&mut self) -> Result<EncodedPacket> {
        let slot = self
            .pending
            .pop_front()
            .ok_or_else(|| anyhow!("wait_and_lock_front called with empty queue"))?
            .slot;
        // Sync mode: no completion event — anything in `pending` got there
        // because EncodePicture returned NEED_MORE_INPUT, and LockBitstream
        // will itself block until the bitstream is ready.
        if self.async_mode {
            let event = self.pool[slot].event;
            let _t = clipdip_profile::start("encoder.wait_block");
            // SAFETY: HANDLE valid; INFINITE = WAIT_OBJECT_0 once signaled
            // (auto-reset event), or WAIT_FAILED if something is very wrong.
            let wait = unsafe { WaitForSingleObject(event, INFINITE) };
            if wait != WAIT_OBJECT_0 {
                bail!("WaitForSingleObject returned {:?} on completion event", wait);
            }
            drop(_t);
        }
        self.lock_one(self.pool[slot].bitstream)
    }

    fn lock_one(&self, output: NV_ENC_OUTPUT_PTR) -> Result<EncodedPacket> {
        let _t = clipdip_profile::start("encoder.lock");
        let mut lock = NV_ENC_LOCK_BITSTREAM::default();
        lock.version = NV_ENC_LOCK_BITSTREAM_VER;
        lock.outputBitstream = output;

        let lock_fn = self.api.functions.nvEncLockBitstream.expect("loader checked");
        let status = unsafe { (lock_fn)(self.encoder, &mut lock) };
        nvenc_check(&self.api, self.encoder, status, "LockBitstream")?;

        // SAFETY: lock.bitstreamBufferPtr is valid for lock.bitstreamSizeInBytes
        // until we call UnlockBitstream.
        let bytes = unsafe {
            std::slice::from_raw_parts(
                lock.bitstreamBufferPtr as *const u8,
                lock.bitstreamSizeInBytes as usize,
            )
        }
        .to_vec();

        let pts = lock.outputTimeStamp as i64;

        // Don't trust lock.pictureType — in our config NVENC has been
        // observed to return 0 (P) for every frame including IDRs. Scan
        // the bitstream instead. OBS does the same.
        let is_keyframe = match self.active_codec {
            ActiveCodec::H264 => scan_for_keyframe_h264(&bytes),
            ActiveCodec::Av1 => scan_for_keyframe_av1(&bytes),
        };

        let unlock_fn = self.api.functions.nvEncUnlockBitstream.expect("loader checked");
        let status = unsafe { (unlock_fn)(self.encoder, output) };
        if status != NV_ENC_SUCCESS {
            warn!(status, "UnlockBitstream failed");
        }

        // Per-frame line is at `trace!` — too noisy for `info`/`debug`
        // routine output. The `--profile` flag gives the same info
        // aggregated (frame count, size percentiles) every N seconds
        // via `clipdip-profile`; reach for `RUST_LOG=clipdip_encoder=trace`
        // only when investigating a specific per-frame anomaly.
        trace!(
            size = bytes.len(),
            is_keyframe,
            reported_pic_type = lock.pictureType,
            "encoded frame"
        );

        Ok(EncodedPacket {
            bytes: bytes.into(),
            pts_100ns: pts,
            dts_100ns: pts,
            is_keyframe,
            stream_id: STREAM_VIDEO,
        })
    }

    /// Drain the encoder pipeline.
    ///
    /// Block-wait on every still-pending completion event in submission
    /// order, locking each bitstream and emitting the encoded packet.
    /// Then submit an EOS picture (with its own completion event in async
    /// mode) and wait for that too — confirming NVENC has flushed
    /// internal state before we tear down.
    pub fn flush(&mut self) -> Result<Vec<EncodedPacket>> {
        let mut packets = Vec::new();
        while !self.pending.is_empty() {
            packets.push(self.wait_and_lock_front()?);
        }

        // Submit EOS. In async mode this requires a completion event
        // too — reuse slot 0's, which is now unsignaled (auto-reset
        // consumed the last signal). In sync mode pass null; EOS in
        // sync mode is itself blocking.
        let eos_event = self.pool[0].event;
        let mut pic = NV_ENC_PIC_PARAMS::default();
        pic.version = NV_ENC_PIC_PARAMS_VER;
        pic.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
        pic.completionEvent = if self.async_mode {
            eos_event.0 as *mut _
        } else {
            std::ptr::null_mut()
        };
        // EOS doesn't need an input buffer.
        let encode_fn = self.api.functions.nvEncEncodePicture.expect("loader checked");
        let status = unsafe { (encode_fn)(self.encoder, &mut pic) };
        if status != NV_ENC_SUCCESS && status != NV_ENC_ERR_NEED_MORE_INPUT {
            return Err(nvenc_error(&self.api, self.encoder, status, "EOS EncodePicture"));
        }
        if self.async_mode {
            // SAFETY: eos_event valid; INFINITE waits until NVENC signals.
            let wait = unsafe { WaitForSingleObject(eos_event, INFINITE) };
            if wait != WAIT_OBJECT_0 {
                bail!("WaitForSingleObject on EOS event returned {:?}", wait);
            }
        }
        Ok(packets)
    }
}

impl Drop for NvEncoderD3D11 {
    fn drop(&mut self) {
        // If the caller skipped `flush()`, drain remaining events first
        // — NVENC won't let us unregister an event that still has a
        // pending picture associated with it. (Sync mode has no events
        // to wait on; LockBitstream / EOS already blocked as needed.)
        if self.async_mode {
            while let Some(p) = self.pending.pop_front() {
                let event = self.pool[p.slot].event;
                unsafe { WaitForSingleObject(event, INFINITE) };
            }
        } else {
            self.pending.clear();
        }

        // Order matters: unregister textures → unregister events →
        // destroy bitstream buffers → close event handles →
        // destroy encoder.
        if let Some(f) = self.api.functions.nvEncUnregisterResource {
            for &registered in &self.nv12_registered {
                unsafe { (f)(self.encoder, registered) };
            }
        }
        self.nv12_registered.clear();
        // `nv12_pool` textures release on their own via ID3D11Texture2D
        // ComPtr drop; their NVENC registrations are gone above.

        if self.async_mode {
            if let Some(f) = self.api.functions.nvEncUnregisterAsyncEvent {
                for slot in &self.pool {
                    let mut params = NV_ENC_EVENT_PARAMS::default();
                    params.version = NV_ENC_EVENT_PARAMS_VER;
                    params.completionEvent = slot.event.0 as *mut _;
                    unsafe { (f)(self.encoder, &mut params) };
                }
            }
        }

        let destroy_bs = self.api.functions.nvEncDestroyBitstreamBuffer;
        for slot in &self.pool {
            if let Some(f) = destroy_bs {
                unsafe { (f)(self.encoder, slot.bitstream) };
            }
            // SAFETY: HANDLE is from CreateEventW; close exactly once.
            // Skip when sync mode left HANDLE(null) as a sentinel.
            if !slot.event.0.is_null() {
                unsafe { CloseHandle(slot.event).ok() };
            }
        }
        if let Some(f) = self.api.functions.nvEncDestroyEncoder {
            unsafe { (f)(self.encoder) };
        }
    }
}

// ---- bitstream helpers -----------------------------------------------

/// Scan an Annex-B H.264 bitstream for a keyframe marker — either an IDR
/// slice NAL (`nal_unit_type == 5`) or an SPS NAL (`nal_unit_type == 7`).
/// SPS-present implies a stream boundary which all decoders treat as
/// random-access, so we count it as a keyframe too.
fn scan_for_keyframe_h264(bytes: &[u8]) -> bool {
    // Walk the Annex-B byte stream. NAL units begin with `00 00 00 01` or
    // `00 00 01`. The byte after the start code holds:
    //     bit 7    : forbidden_zero_bit (always 0)
    //     bits 6-5 : nal_ref_idc
    //     bits 4-0 : nal_unit_type
    let mut i = 0;
    while i + 4 < bytes.len() {
        let is_long = bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0 && bytes[i + 3] == 1;
        let is_short = bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1;
        if is_long || is_short {
            let header_idx = if is_long { i + 4 } else { i + 3 };
            if header_idx < bytes.len() {
                let nal_type = bytes[header_idx] & 0x1F;
                if nal_type == 5 || nal_type == 7 {
                    return true;
                }
            }
            i = header_idx + 1;
        } else {
            i += 1;
        }
    }
    false
}

/// Scan an AV1 low-overhead bitstream for a keyframe access unit. NVENC
/// emits OBUs with `obu_has_size_field=1` for the low-overhead format,
/// which lets us walk OBU-by-OBU using the leb128 size field.
///
/// Triggers on:
/// - any OBU_SEQUENCE_HEADER (type 1) — implies a random-access point
///   (and with `set_av1_repeat_seq_hdr(true)` every keyframe re-emits one)
/// - any OBU_FRAME (6) or OBU_FRAME_HEADER (3) whose first bit is
///   `show_existing_frame=0` and whose 2-bit `frame_type` is KEY_FRAME (0)
///   or INTRA_ONLY_FRAME (2)
fn scan_for_keyframe_av1(bytes: &[u8]) -> bool {
    let mut i = 0;
    while i < bytes.len() {
        let header = bytes[i];
        let obu_type = (header >> 3) & 0xF;
        let has_extension = (header >> 2) & 1 != 0;
        let has_size = (header >> 1) & 1 != 0;
        i += 1;
        if has_extension {
            if i >= bytes.len() {
                return false;
            }
            i += 1;
        }
        let payload_size: usize;
        if has_size {
            let (size, leb_len) = match read_leb128(&bytes[i..]) {
                Some(v) => v,
                None => return false,
            };
            i += leb_len;
            payload_size = size as usize;
        } else {
            // No size field — the OBU must run to end of bitstream. We can
            // only check this single OBU before bailing.
            payload_size = bytes.len().saturating_sub(i);
        }

        if obu_type == 1 {
            return true;
        }
        if (obu_type == 3 || obu_type == 6) && i < bytes.len() {
            let b = bytes[i];
            let show_existing = (b >> 7) & 1 != 0;
            if !show_existing {
                let frame_type = (b >> 5) & 0b11;
                if frame_type == 0 || frame_type == 2 {
                    return true;
                }
            }
        }

        if !has_size {
            return false;
        }
        i = i.saturating_add(payload_size);
    }
    false
}

/// Read an AV1 leb128 (little-endian base-128) integer. Returns
/// `(value, bytes_consumed)` or `None` if the input is malformed or
/// truncated. AV1 leb128 is capped at 8 bytes.
fn read_leb128(bytes: &[u8]) -> Option<(u64, usize)> {
    let mut val: u64 = 0;
    for n in 0..8 {
        if n >= bytes.len() {
            return None;
        }
        let b = bytes[n];
        val |= ((b & 0x7F) as u64) << (7 * n);
        if b & 0x80 == 0 {
            return Some((val, n + 1));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{read_leb128, scan_for_keyframe_av1, scan_for_keyframe_h264};

    #[test]
    fn keyframe_scan_detects_idr_long_start_code() {
        // 00 00 00 01 65 = IDR slice
        let bytes = [0, 0, 0, 1, 0x65, 0x88];
        assert!(scan_for_keyframe_h264(&bytes));
    }

    #[test]
    fn keyframe_scan_detects_sps_short_start_code() {
        // 00 00 01 67 = SPS
        let bytes = [0, 0, 1, 0x67, 0x42];
        assert!(scan_for_keyframe_h264(&bytes));
    }

    #[test]
    fn keyframe_scan_rejects_p_slice() {
        // 00 00 00 01 41 = non-IDR slice (nal_type = 1)
        let bytes = [0, 0, 0, 1, 0x41, 0x9A];
        assert!(!scan_for_keyframe_h264(&bytes));
    }

    #[test]
    fn keyframe_scan_finds_idr_after_sps_pps() {
        // SPS, PPS, IDR all in one buffer — first IDR triggers true.
        let bytes = [
            0, 0, 0, 1, 0x67, 0x42, // SPS — already triggers
            0, 0, 0, 1, 0x68, 0xeb, // PPS
            0, 0, 0, 1, 0x65, 0xb8, // IDR
        ];
        assert!(scan_for_keyframe_h264(&bytes));
    }

    #[test]
    fn keyframe_scan_empty_or_tiny() {
        assert!(!scan_for_keyframe_h264(&[]));
        assert!(!scan_for_keyframe_h264(&[0, 0]));
    }

    // OBU header byte: bits 6-3 = obu_type, bit 1 = has_size_field.
    // For type=N with size field, byte = (N << 3) | 0b10 = (N << 3) | 2.
    const fn obu_hdr(obu_type: u8) -> u8 {
        (obu_type << 3) | 0b10
    }

    #[test]
    fn av1_leb128_round_trip_small_values() {
        assert_eq!(read_leb128(&[0]), Some((0, 1)));
        assert_eq!(read_leb128(&[0x7F]), Some((127, 1)));
        // 128 -> 0x80, 0x01
        assert_eq!(read_leb128(&[0x80, 0x01]), Some((128, 2)));
        assert_eq!(read_leb128(&[]), None);
        // Continuation bit set on every byte -> malformed (truncated).
        assert_eq!(read_leb128(&[0x80, 0x80, 0x80]), None);
    }

    #[test]
    fn av1_scan_detects_sequence_header_obu() {
        // OBU_SEQUENCE_HEADER (type 1) with 2-byte payload.
        let bytes = [obu_hdr(1), 2, 0xAA, 0xBB];
        assert!(scan_for_keyframe_av1(&bytes));
    }

    #[test]
    fn av1_scan_detects_key_frame_obu() {
        // OBU_FRAME (type 6), 1-byte payload whose first byte has
        // show_existing_frame=0 (bit 7) and frame_type=0 (bits 6-5 = 00).
        let bytes = [obu_hdr(6), 1, 0b0000_0000];
        assert!(scan_for_keyframe_av1(&bytes));
    }

    #[test]
    fn av1_scan_detects_intra_only_frame_obu() {
        // OBU_FRAME (6), frame_type = INTRA_ONLY (2) -> bits 6-5 = 10.
        let bytes = [obu_hdr(6), 1, 0b0100_0000];
        assert!(scan_for_keyframe_av1(&bytes));
    }

    #[test]
    fn av1_scan_rejects_inter_frame_obu() {
        // OBU_FRAME (6), frame_type = INTER (1) -> bits 6-5 = 01.
        let bytes = [obu_hdr(6), 1, 0b0010_0000];
        assert!(!scan_for_keyframe_av1(&bytes));
    }

    #[test]
    fn av1_scan_rejects_show_existing_frame() {
        // show_existing_frame=1 (bit 7) -> not a real frame header; skip.
        let bytes = [obu_hdr(6), 1, 0b1000_0000];
        assert!(!scan_for_keyframe_av1(&bytes));
    }

    #[test]
    fn av1_scan_skips_temporal_delimiter_then_finds_keyframe() {
        // OBU_TEMPORAL_DELIMITER (2), 0-byte payload, then sequence header.
        let bytes = [obu_hdr(2), 0, obu_hdr(1), 2, 0xAA, 0xBB];
        assert!(scan_for_keyframe_av1(&bytes));
    }

    #[test]
    fn av1_scan_empty_or_tiny() {
        assert!(!scan_for_keyframe_av1(&[]));
        assert!(!scan_for_keyframe_av1(&[obu_hdr(1)]));
    }
}

// ---- codec capability probe + selection -------------------------------

/// Enumerate codec GUIDs the open NVENC session can encode. Driven by
/// `nvEncGetEncodeGUIDCount` + `nvEncGetEncodeGUIDs` — on Ada the list
/// includes H.264, HEVC, and AV1; on Turing it's H.264 + HEVC.
fn query_supported_codecs(
    api: &NvEncApi,
    encoder: *mut std::ffi::c_void,
) -> Result<Vec<GUID>> {
    let count_fn = api
        .functions
        .nvEncGetEncodeGUIDCount
        .ok_or_else(|| anyhow!("nvEncGetEncodeGUIDCount missing from function table"))?;
    let guids_fn = api
        .functions
        .nvEncGetEncodeGUIDs
        .ok_or_else(|| anyhow!("nvEncGetEncodeGUIDs missing from function table"))?;

    let mut count: u32 = 0;
    // SAFETY: encoder is a live session; &mut count is a valid u32 pointer.
    let status = unsafe { (count_fn)(encoder, &mut count) };
    nvenc_check(api, encoder, status, "GetEncodeGUIDCount")?;
    if count == 0 {
        return Ok(Vec::new());
    }

    let mut guids: Vec<GUID> = vec![
        GUID {
            data1: 0,
            data2: 0,
            data3: 0,
            data4: [0; 8],
        };
        count as usize
    ];
    let mut written: u32 = 0;
    // SAFETY: encoder live; the buffer has space for `count` GUIDs and we
    // pass that capacity as `guidArraySize`.
    let status = unsafe { (guids_fn)(encoder, guids.as_mut_ptr(), count, &mut written) };
    nvenc_check(api, encoder, status, "GetEncodeGUIDs")?;
    guids.truncate(written as usize);
    Ok(guids)
}

/// Pick the codec to use given the caller's preference and the GPU's
/// reported capabilities. Errors only for `ForceAv1` on a GPU without
/// AV1 support — `PreferAv1` silently falls back to H.264.
fn resolve_codec(pref: CodecPreference, supported: &[GUID]) -> Result<ActiveCodec> {
    let has_h264 = supported.contains(&NV_ENC_CODEC_H264_GUID);
    let has_av1 = supported.contains(&NV_ENC_CODEC_AV1_GUID);
    match pref {
        CodecPreference::ForceH264 => {
            if !has_h264 {
                bail!("driver reports no H.264 NVENC support — cannot ForceH264");
            }
            Ok(ActiveCodec::H264)
        }
        CodecPreference::ForceAv1 => {
            if !has_av1 {
                bail!(
                    "driver reports no AV1 NVENC support on this GPU — requires \
                     RTX 40-series (Ada) or newer. Use PreferAv1 to fall back to H.264."
                );
            }
            Ok(ActiveCodec::Av1)
        }
        CodecPreference::PreferAv1 => {
            if has_av1 {
                Ok(ActiveCodec::Av1)
            } else if has_h264 {
                Ok(ActiveCodec::H264)
            } else {
                bail!("driver reports neither AV1 nor H.264 NVENC support");
            }
        }
    }
}

/// Log the encode config as NVENC will actually run it — post
/// `apply_rate_control`, so derates/clamps are already reflected. Called
/// at session init and after every successful reconfigure.
fn log_effective_config(enc_cfg: &NV_ENC_CONFIG) {
    let rc = &enc_cfg.rcParams;
    info!(
        rc_mode = rc.rateControlMode,
        qp_inter_p = rc.constQP.qpInterP,
        qp_intra = rc.constQP.qpIntra,
        avg_bps = rc.averageBitRate,
        max_bps = rc.maxBitRate,
        vbv_size = rc.vbvBufferSize,
        rc_bitfields = format!("{:#x}", rc.bitfields),
        lookahead_depth = rc.lookaheadDepth,
        multi_pass = rc.multiPass,
        target_quality = rc.targetQuality,
        frame_interval_p = enc_cfg.frameIntervalP,
        gop_length = enc_cfg.gopLength,
        "effective NVENC config"
    );
}

/// Write `rc` into `rc_params`. Shared by session init and
/// [`NvEncoderD3D11::reconfigure_rate_control`] so both paths scale and
/// clamp QP identically.
fn apply_rate_control(rc_params: &mut NV_ENC_RC_PARAMS, codec: ActiveCodec, rc: RateControl) {
    match rc {
        RateControl::ConstantQp { qp } => {
            let scaled_qp = match codec {
                ActiveCodec::Av1 => qp * 4,
                _ => qp,
            };
            let final_qp = clamp_qp_for_codec(codec, scaled_qp);
            // Keyframes get a better (lower) QP than delta frames. Every
            // GOP references its IDR, so intra quality is the ceiling for
            // everything that follows — most visibly on static content,
            // where deltas are pure skips and the picture IS the keyframe
            // re-encoded once per GOP (blocky text + once-a-second
            // "pumping" at equal QP). ~4 H.264 QP steps of headroom; the
            // size cost is small because keyframes are a tiny share of
            // motion clips (~7%) and static clips are tiny anyway.
            let intra_qp = match codec {
                ActiveCodec::Av1 => final_qp.saturating_sub(16),
                _ => final_qp.saturating_sub(4),
            }
            .max(1);
            rc_params.rateControlMode = NV_ENC_PARAMS_RC_CONSTQP;
            rc_params.constQP = NV_ENC_QP {
                qpInterP: final_qp,
                qpInterB: final_qp,
                qpIntra: intra_qp,
            };
            // CQP ignores these, but zero them for tidiness — the
            // preset query may have left non-zero defaults behind.
            rc_params.averageBitRate = 0;
            rc_params.maxBitRate = 0;
        }
        RateControl::CappedQuality { cq, max_bps } => {
            // Target-quality VBR: constant quality below the cap, hard
            // ceiling above it. `averageBitRate = 0` + `targetQuality`
            // puts NVENC in CQ mode; `maxBitRate` + a 1-second VBV bound
            // the worst case — the VBV only engages on sustained bursts,
            // so ordinary content encodes exactly like constant quality.
            //
            // AV1 gets ~0.6× the cap: at equal perceptual quality it
            // needs far fewer bits than H.264, so an H264-sized ceiling
            // on AV1 would never engage and silently un-cap the mode.
            let cap = match codec {
                ActiveCodec::Av1 => (max_bps as u64 * 6 / 10) as u32,
                _ => max_bps,
            };
            rc_params.rateControlMode = NV_ENC_PARAMS_RC_VBR;
            // `targetQuality` is codec-agnostic 0–51 (no AV1 ×4 scaling —
            // the field is u8 and 26×4 would be off-scale garbage). Floor
            // at 1: a value of 0 means "auto" to NVENC and would silently
            // discard the quality target for hand-edited qp=0 configs.
            let cq = cq.clamp(1, 51);
            rc_params.targetQuality = cq as u8;
            rc_params.targetQualityLSB = 0;
            rc_params.averageBitRate = 0;
            rc_params.maxBitRate = cap;
            rc_params.vbvBufferSize = cap;
            rc_params.vbvInitialDelay = 0;
            // Keep the ConstantQp arm's keyframe headroom (see its comment
            // on static-content IDR "pumping"): in CQ mode `initialRCQP`
            // is the rate controller's starting hint, so seed intra ~4 QP
            // better than delta. Bit 2 of the packed bitfields word is
            // enableInitialRCQP.
            rc_params.initialRCQP = NV_ENC_QP {
                qpInterP: cq,
                qpInterB: cq,
                qpIntra: cq.saturating_sub(4).max(1),
            };
            rc_params.bitfields |= 1 << 2;
            // VBR ignores constQP; zero the preset leftovers for tidiness.
            rc_params.constQP = NV_ENC_QP { qpInterP: 0, qpInterB: 0, qpIntra: 0 };
        }
        RateControl::Vbr { avg_bps } => {
            // VBR with a hard average target. CBR would honor bitrate
            // even more strictly but produces filler bits on quiet
            // content. Allow short-term overshoot up to ~1.5× average
            // so motion bursts don't smear.
            rc_params.rateControlMode = NV_ENC_PARAMS_RC_VBR;
            rc_params.averageBitRate = avg_bps;
            rc_params.maxBitRate = avg_bps.saturating_add(avg_bps / 2);
        }
    }
}

/// Clamp a caller-supplied QP to the codec's valid range. H.264 / HEVC
/// use 0–51; AV1 uses 0–255. Out-of-range values silently saturate
/// rather than failing — the caller is unlikely to know the codec ahead
/// of the capability probe.
fn clamp_qp_for_codec(codec: ActiveCodec, qp: u32) -> u32 {
    match codec {
        ActiveCodec::H264 => qp.min(51),
        ActiveCodec::Av1 => qp.min(255),
    }
}

// ---- helpers ----------------------------------------------------------

fn nvenc_check(
    api: &NvEncApi,
    encoder: *mut std::ffi::c_void,
    status: NVENCSTATUS,
    op: &str,
) -> Result<()> {
    if status == NV_ENC_SUCCESS {
        Ok(())
    } else {
        Err(nvenc_error(api, encoder, status, op))
    }
}

fn nvenc_error(
    api: &NvEncApi,
    encoder: *mut std::ffi::c_void,
    status: NVENCSTATUS,
    op: &str,
) -> anyhow::Error {
    let detail = if !encoder.is_null() {
        api.functions
            .nvEncGetLastErrorString
            .and_then(|f| {
                let ptr = unsafe { f(encoder) };
                if ptr.is_null() {
                    None
                } else {
                    Some(unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned())
                }
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    if detail.is_empty() {
        anyhow!("NVENC {op} failed with status {status}")
    } else {
        anyhow!("NVENC {op} failed (status {status}): {detail}")
    }
    .context("nvenc")
}
