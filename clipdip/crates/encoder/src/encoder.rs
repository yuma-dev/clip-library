//! Safe wrapper around an NVENC encode session for D3D11 input: open/init
//! encode_frame, flush, Drop teardown. Registers the input resource per
//! frame rather than caching by texture pointer: simpler, slower, fine for now.

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

/// One submitted-but-unlocked frame; NVENC signals `pool[slot].event` when
/// its bitstream is ready.
struct PendingFrame {
    slot: usize,
}

/// Bitstream buffer + completion event. Sync mode (AV1: async makes NVENC
/// emit INTRA_ONLY instead of KEY_FRAME at IDRs) uses HANDLE(0) and skips the event.
struct PoolSlot {
    bitstream: NV_ENC_OUTPUT_PTR,
    event: HANDLE,
}

pub struct NvEncoderD3D11 {
    api: Arc<NvEncApi>,
    encoder: *mut std::ffi::c_void,
    _device: ID3D11Device,
    /// Immediate context; cloned into nv12_converter too, kept here so we hold
    /// our own reference for the encoder's lifetime.
    _context: ID3D11DeviceContext,
    /// NV12 staging textures, one per bitstream slot; round-robin so NVENC never
    /// gets the same pointer back-to-back while still holding a reference to it.
    nv12_pool: Vec<ID3D11Texture2D>,
    /// NVENC registration handles, one per nv12_pool slot; registered once at
    /// new() since nvEncRegisterResource is too expensive to redo per frame.
    nv12_registered: Vec<NV_ENC_REGISTERED_PTR>,
    /// BGRA to NV12 converter: CopyResource can't bridge these formats, so this
    /// runs two fullscreen-triangle passes (Y, then UV) instead.
    nv12_converter: Nv12Converter,
    config: EncoderConfig,
    /// Boxed for a stable address: reconfigure_rate_control resubmits this same
    /// config (with updated rcParams) through NVENC's Reconfigure API.
    enc_cfg: Box<NV_ENC_CONFIG>,
    /// Init params from session open, reused verbatim on reconfigure except
    /// for a refreshed encodeConfig pointer.
    init_params: NV_ENC_INITIALIZE_PARAMS,
    /// Codec negotiated at session open; drives the keyframe scanner and
    /// whether the bitstream is AVC NALs or AV1 OBUs.
    active_codec: ActiveCodec,
    /// (bitstream, event) pairs, allocated once and reused round-robin.
    pool: Vec<PoolSlot>,
    /// Next slot to hand out on submit. Wraps `0..pool.len()`.
    next_slot: usize,
    /// Submitted, not-yet-read bitstreams, FIFO. NVENC outputs in submission
    /// order for our no-B-frame config, so front is next to signal.
    pending: VecDeque<PendingFrame>,
    frames_submitted: u64,
    force_idr: bool,
    /// True for H.264 (async lets us submit ahead of encode). False for AV1:
    /// async mode there emits INTRA_ONLY instead of KEY_FRAME at IDRs.
    async_mode: bool,
    /// Sequence header bytes (H.264 SPS+PPS, AV1 OBU_SEQUENCE_HEADER), cached
    /// because NVENC doesn't reliably re-emit one at every AV1 IDR; callers prepend it.
    header: Vec<u8>,
}

// SAFETY: we own the encoder handle. NVENC sessions are not thread-safe and
// we never share the handle across threads, the type is !Send by default
// (raw pointer field).
unsafe impl Send for NvEncoderD3D11 {}

impl NvEncoderD3D11 {
    pub fn new(device: ID3D11Device, config: EncoderConfig) -> Result<Self> {
        let api = NvEncApi::load()?;

        // open session
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

        // codec capability probe: AV1 NVENC needs Ada (RTX 40+), older GPUs fall
        // back to H.264.
        let supported = query_supported_codecs(&api, encoder)?;
        let active_codec = resolve_codec(config.codec_preference, &supported)?;
        let encode_guid = match active_codec {
            ActiveCodec::H264 => NV_ENC_CODEC_H264_GUID,
            ActiveCodec::Av1 => NV_ENC_CODEC_AV1_GUID,
        };

        // query preset defaults: start from driver's recommended config for
        // codec+preset+tuning, override only gopLength/idrPeriod/rate-control.
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

        // override just the knobs we care about
        let mut enc_cfg = Box::new(preset.presetCfg);
        enc_cfg.version = NV_ENC_CONFIG_VER;
        enc_cfg.gopLength = config.gop_length;
        enc_cfg.frameIntervalP = 1; // IPP... (no B-frames in low-latency)

        match active_codec {
            ActiveCodec::H264 => {
                enc_cfg.set_h264_idr_period(config.gop_length);
                // repeat SPS+PPS at every IDR: the ring evicts whole GOPs, so a clip saved
                // after eviction would start IDR-only and ffmpeg rejects it (missing PPS).
                enc_cfg.set_h264_repeat_sps_pps(true);
            }
            ActiveCodec::Av1 => {
                // mirrors OBS's init_encoder_av1: without chromaFormatIDC=1, inputBitDepth
                // profile/tier/level, and ref counts, AV1 IDRs come out INTRA_ONLY not KEY_FRAME.
                enc_cfg.profileGUID = NV_ENC_AV1_PROFILE_MAIN_GUID;
                let av1 = enc_cfg.av1_config_mut();
                // level is filled in below once the rate control is known
                av1.level = NV_ENC_LEVEL_AV1_AUTOSELECT;
                av1.tier = NV_ENC_TIER_AV1_0;
                av1.idrPeriod = config.gop_length;
                // bitfield: repeatSeqHdr=1, chromaFormatIDC=1 (yuv420); other flags stay
                // zeroed from the preset query.
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

        if matches!(active_codec, ActiveCodec::Av1) {
            // AUTOSELECT declares level 7.3 high tier whenever averageBitRate is 0 (the
            // target quality mode every CQP config runs as), and libaom refuses that
            // header outright, so ClipLib thumbnails died on it. the recording boost
            // reconfigures the cap 1.5x higher while the level stays as declared here.
            let cap = enc_cfg.rcParams.maxBitRate;
            let peak = if cap == 0 { None } else { Some(cap.saturating_add(cap / 2)) };
            let (level, tier) =
                av1_level(config.width, config.height, config.fps_num, config.fps_den, peak);
            let av1 = enc_cfg.av1_config_mut();
            av1.level = level;
            av1.tier = tier;
            info!(level, tier, peak_bps = peak, "AV1 level declared");
        }

        // logs the effective config (preset defaults + our overrides) so a user's
        // log answers "what did the encoder actually run with". re-logged on reconfigure.
        log_effective_config(&enc_cfg);

        // initialize
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
        // NV12 input: CopyResource converts BGRA to NV12 in hardware; feeding NVENC
        // ARGB instead cost the ~5-10% delta we measured against OBS.
        init.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
        init.encodeConfig = enc_cfg.as_mut() as *mut NV_ENC_CONFIG as *mut std::ffi::c_void;
        // async mode lets us submit frame N+1 while N still encodes, saving ~2.2ms/frame
        // CPU wait; skipped for AV1 since it emits INTRA_ONLY instead of KEY_FRAME there.
        let async_mode = matches!(active_codec, ActiveCodec::H264);
        init.enableEncodeAsync = if async_mode { 1 } else { 0 };

        let init_fn = api.functions.nvEncInitializeEncoder.expect("loader checked");
        // SAFETY: encoder is a valid handle returned by OpenEncodeSessionEx;
        // `init` is properly initialized and `enc_cfg` lives until after
        // InitializeEncoder returns (the call copies what it needs).
        let status = unsafe { (init_fn)(encoder, &mut init) };
        nvenc_check(&api, encoder, status, "InitializeEncoder")?;

        // each output buffer pairs with an auto-reset Win32 event NVENC signals when
        // that picture's bitstream is ready; auto-reset gives consume-once semantics.
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
            let mut bs = NV_ENC_CREATE_BITSTREAM_BUFFER::default();
            bs.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
            // SAFETY: well-formed init struct.
            let status = unsafe { (create_bs)(encoder, &mut bs) };
            nvenc_check(&api, encoder, status, "CreateBitstreamBuffer")?;

            // completion event, only created/registered in async mode; sync mode uses
            // HANDLE(0) as a sentinel and skips wait/close.
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

        // one texture per bitstream slot, same round-robin reasoning as nv12_pool.
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

        // fetched once at init (not per-packet like OBS does) since sequence
        // params don't change for the session; keeps the hot path free of the call.
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
            // first frame always forces SPS+PPS+IDR so decoders latch on immediately
            // regardless of where the next gopLength-driven IDR would land.
            force_idr: true,
            async_mode,
            header: header_buf,
        })
    }

    /// Sequence-header bytes captured at open; save flows prepend these so
    /// decoders/ffmpeg see a valid header even off a keyframe boundary.
    pub fn header(&self) -> &[u8] {
        &self.header
    }

    /// Codec negotiated at session open; callers need it to know if the
    /// bitstream is H.264 NALs or AV1 OBUs.
    pub fn active_codec(&self) -> ActiveCodec {
        self.active_codec
    }

    /// Forces an IDR on the next frame; gopLength drives automatic IDR cadence
    /// normally, this is for on-demand scene cuts / recovery.
    pub fn force_idr_next_frame(&mut self) {
        self.force_idr = true;
    }

    /// Changes rate-control params on the live session (no reset) so packets
    /// mux continuously. `rc` must match the session's mode (CQP/VBR); forces an IDR.
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
            // session unchanged on failure, keep our mirror in sync.
            self.enc_cfg.rcParams = prev_rc_params;
            return Err(e);
        }
        self.config.rate_control = rc;
        log_effective_config(&self.enc_cfg);
        Ok(())
    }

    /// Submits one texture; NVENC may buffer a few frames before returning
    /// packets. Registrations cache by texture pointer (usually 1-2 live).
    pub fn encode_frame(
        &mut self,
        texture: &ID3D11Texture2D,
        pts_100ns: i64,
    ) -> Result<Vec<EncodedPacket>> {
        let _t = clipdip_profile::start("encoder.encode_frame");
        let mut packets = Vec::new();

        // safety valve: all slots in flight, wait on the oldest. rare: pool depth 4
        // p99 encode ~4ms vs a 16.7ms frame interval.
        if self.pending.len() >= self.pool.len() {
            let pkt = self.wait_and_lock_front()?;
            packets.push(pkt);
        }

        // same slot index for input NV12 and output bitstream: once slot N's
        // bitstream is consumed, slot N's texture is safe to overwrite.
        let slot = self.next_slot;
        self.next_slot = (slot + 1) % self.pool.len();

        // BGRA to NV12 via two shader passes (Y+UV): cheaper than NVENC's internal
        // ARGB conversion and gives explicit control of the color matrix (BT.709 full range).
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

        // encode picture
        let mut pic = NV_ENC_PIC_PARAMS::default();
        pic.version = NV_ENC_PIC_PARAMS_VER;
        pic.inputWidth = self.config.width;
        pic.inputHeight = self.config.height;
        pic.inputPitch = self.config.width;
        pic.inputBuffer = mapped.mappedResource;
        pic.bufferFmt = NV_ENC_BUFFER_FORMAT_NV12;
        pic.outputBitstream = output;
        // null completionEvent in sync mode: a non-null one there is a config error.
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

        // async: NEED_MORE_INPUT still consumes the picture, just push to pending
        // and let the event drain it. sync: SUCCESS drains inline in submit order.
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

        // unmap: NVENC already copied what it needs
        let unmap_fn = self.api.functions.nvEncUnmapInputResource.expect("loader checked");
        let status = unsafe { (unmap_fn)(self.encoder, mapped.mappedResource) };
        if status != NV_ENC_SUCCESS {
            warn!(status, "UnmapInputResource failed");
        }

        // non-blocking drain (async only): pop any already-signaled events; steady
        // state at 60fps is encode running ahead (p50 ~2.4ms). sync already drained above.
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

    /// Block-waits on the pending queue's front, locking its bitstream. Used
    /// by the safety valve and flush.
    fn wait_and_lock_front(&mut self) -> Result<EncodedPacket> {
        let slot = self
            .pending
            .pop_front()
            .ok_or_else(|| anyhow!("wait_and_lock_front called with empty queue"))?
            .slot;
        // sync mode has no event: anything pending got there via NEED_MORE_INPUT
        // and LockBitstream itself blocks until ready.
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

        // lock.pictureType isn't trustworthy: NVENC has returned 0 (P) for IDRs too.
        // scan the bitstream instead, same as OBS.
        let is_keyframe = match self.active_codec {
            ActiveCodec::H264 => scan_for_keyframe_h264(&bytes),
            ActiveCodec::Av1 => scan_for_keyframe_av1(&bytes),
        };

        let unlock_fn = self.api.functions.nvEncUnlockBitstream.expect("loader checked");
        let status = unsafe { (unlock_fn)(self.encoder, output) };
        if status != NV_ENC_SUCCESS {
            warn!(status, "UnlockBitstream failed");
        }

        // per-frame log is trace-level (too noisy otherwise); --profile aggregates
        // the same info periodically via clipdip-profile.
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

    /// Drains the pipeline: waits out every pending event in submission order
    /// then submits and waits on an EOS picture before teardown.
    pub fn flush(&mut self) -> Result<Vec<EncodedPacket>> {
        let mut packets = Vec::new();
        while !self.pending.is_empty() {
            packets.push(self.wait_and_lock_front()?);
        }

        // EOS needs a completion event in async mode too; reuse slot 0's (unsignaled
        // since auto-reset consumed its last signal). sync mode passes null and blocks itself.
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
        // drain remaining events if flush() was skipped: NVENC won't unregister an
        // event tied to a pending picture. sync mode has no events to wait on.
        if self.async_mode {
            while let Some(p) = self.pending.pop_front() {
                let event = self.pool[p.slot].event;
                unsafe { WaitForSingleObject(event, INFINITE) };
            }
        } else {
            self.pending.clear();
        }

        // order matters: unregister textures, then events, then destroy bitstream
        // buffers, close event handles, destroy encoder.
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

// bitstream helpers

/// Scans Annex-B H.264 for an IDR slice NAL (type 5) or SPS NAL (type 7
/// since SPS implies a random-access boundary decoders treat as one).
fn scan_for_keyframe_h264(bytes: &[u8]) -> bool {
    // NAL units start with `00 00 00 01` or `00 00 01`; nal_unit_type is the
    // low 5 bits of the byte right after the start code.
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

/// Scans low-overhead AV1 OBUs for a keyframe: OBU_SEQUENCE_HEADER, or an
/// OBU_FRAME/FRAME_HEADER with frame_type KEY_FRAME/INTRA_ONLY_FRAME.
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
            // no size field: the OBU must run to end of bitstream, only this one OBU
            // gets checked before bailing.
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

/// AV1 leb128 (little-endian base-128) decode; None if malformed/truncated.
/// Capped at 8 bytes per the AV1 spec.
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
    use super::{av1_level, read_leb128, scan_for_keyframe_av1, scan_for_keyframe_h264};
    use crate::sys::NV_ENC_LEVEL_AV1_AUTOSELECT;

    #[test]
    fn av1_level_follows_resolution_fps_and_cap() {
        // 1080p60 under the 0.6x derated 27 Mbps cap plus the recording boost: 4.1 main
        assert_eq!(av1_level(1920, 1080, 60, 1, Some(24_300_000)), (9, 1));
        assert_eq!(av1_level(1920, 1080, 60, 1, Some(16_200_000)), (9, 0));
        assert_eq!(av1_level(1920, 1080, 60, 1, None), (9, 0));
        assert_eq!(av1_level(1920, 1080, 30, 1, Some(10_000_000)), (8, 0));
        assert_eq!(av1_level(2560, 1440, 144, 1, Some(60_000_000)), (13, 1));
        assert_eq!(av1_level(3840, 2160, 60, 1, Some(40_000_000)), (13, 0));
        assert_eq!(av1_level(3840, 2160, 120, 1, Some(100_000_000)), (14, 1));
        assert_eq!(av1_level(7680, 4320, 60, 1, Some(200_000_000)), (17, 1));
        assert_eq!(av1_level(7680, 4320, 240, 1, Some(1_000_000_000)), (NV_ENC_LEVEL_AV1_AUTOSELECT, 0));
    }

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
        // SPS, PPS, IDR all in one buffer, first IDR triggers true.
        let bytes = [
            0, 0, 0, 1, 0x67, 0x42, // SPS, already triggers
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

// codec capability probe + selection

/// Enumerates codec GUIDs this NVENC session supports; Ada adds AV1 to the
/// H.264+HEVC that Turing reports.
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

/// Picks codec by preference vs GPU capability. Errors only on ForceAv1
/// without AV1 support; PreferAv1 silently falls back to H.264.
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

/// Logs the config post-apply_rate_control (clamps/derates already
/// applied), at init and after every reconfigure.
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

/// AV1 spec annex A.3: (seq_level_idx, max luma samples, max samples/s, main tier bps,
/// high tier bps). levels below 4.0 have no high tier, 7.x is reserved.
const AV1_LEVELS: [(u32, u64, u64, u64, u64); 14] = [
    (0, 147_456, 4_423_680, 1_500_000, 0),
    (1, 278_784, 8_363_520, 3_000_000, 0),
    (4, 665_856, 19_975_680, 6_000_000, 0),
    (5, 1_065_024, 31_950_720, 10_000_000, 0),
    (8, 2_359_296, 70_778_880, 12_000_000, 30_000_000),
    (9, 2_359_296, 141_557_760, 20_000_000, 50_000_000),
    (12, 8_912_896, 267_386_880, 30_000_000, 100_000_000),
    (13, 8_912_896, 534_773_760, 40_000_000, 160_000_000),
    (14, 8_912_896, 1_069_547_520, 60_000_000, 240_000_000),
    (15, 8_912_896, 1_069_547_520, 60_000_000, 240_000_000),
    (16, 35_651_584, 1_069_547_520, 60_000_000, 240_000_000),
    (17, 35_651_584, 2_139_095_040, 100_000_000, 480_000_000),
    (18, 35_651_584, 4_278_190_080, 160_000_000, 800_000_000),
    (19, 35_651_584, 4_278_190_080, 160_000_000, 800_000_000),
];

/// Lowest level whose picture size, display rate and (when capped) bitrate fit,
/// main tier first. Falls back to AUTOSELECT when nothing fits. The driver rejects
/// an explicit level whose tier bitrate is below maxBitRate, hence the tier walk.
fn av1_level(width: u32, height: u32, fps_num: u32, fps_den: u32, peak_bps: Option<u32>) -> (u32, u32) {
    let pixels = width as u64 * height as u64;
    let rate = pixels * fps_num as u64 / fps_den.max(1) as u64;
    for (idx, max_pixels, max_rate, main_bps, high_bps) in AV1_LEVELS {
        if pixels > max_pixels || rate > max_rate {
            continue;
        }
        match peak_bps {
            None => return (idx, NV_ENC_TIER_AV1_0),
            Some(bps) if bps as u64 <= main_bps => return (idx, NV_ENC_TIER_AV1_0),
            Some(bps) if bps as u64 <= high_bps => return (idx, NV_ENC_TIER_AV1_1),
            Some(_) => continue,
        }
    }
    (NV_ENC_LEVEL_AV1_AUTOSELECT, NV_ENC_TIER_AV1_0)
}

/// Writes `rc` into `rc_params`; shared by init and reconfigure_rate_control
/// so both scale/clamp QP identically.
fn apply_rate_control(rc_params: &mut NV_ENC_RC_PARAMS, codec: ActiveCodec, rc: RateControl) {
    match rc {
        RateControl::ConstantQp { qp } => {
            let scaled_qp = match codec {
                ActiveCodec::Av1 => qp * 4,
                _ => qp,
            };
            let final_qp = clamp_qp_for_codec(codec, scaled_qp);
            // intra gets a lower QP than delta: it's the GOP's quality ceiling (visible
            // as static-content "pumping" at equal QP). cheap: keyframes are ~7% of bits.
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
            // CQP ignores these; zeroed for tidiness since the preset query can leave
            // non-zero defaults behind.
            rc_params.averageBitRate = 0;
            rc_params.maxBitRate = 0;
        }
        RateControl::CappedQuality { cq, max_bps } => {
            // target-quality VBR: averageBitRate=0 + targetQuality puts NVENC in CQ
            // mode; maxBitRate + a 1s VBV cap the worst case, only engaging on bursts.
            //
            // AV1 gets ~0.6x the cap: it needs far fewer bits than H.264 at equal
            // quality, so an H264-sized ceiling would never engage on AV1.
            let cap = match codec {
                ActiveCodec::Av1 => (max_bps as u64 * 6 / 10) as u32,
                _ => max_bps,
            };
            rc_params.rateControlMode = NV_ENC_PARAMS_RC_VBR;
            // targetQuality is codec-agnostic 0-51, no AV1 x4 scaling (u8 field, 26x4
            // would be garbage). floored at 1: 0 means "auto" to NVENC.
            let cq = cq.clamp(1, 51);
            rc_params.targetQuality = cq as u8;
            rc_params.targetQualityLSB = 0;
            rc_params.averageBitRate = 0;
            rc_params.maxBitRate = cap;
            rc_params.vbvBufferSize = cap;
            rc_params.vbvInitialDelay = 0;
            // same keyframe headroom as ConstantQp: initialRCQP seeds the rate
            // controller's starting hint, intra ~4 QP better. bit 2 is enableInitialRCQP.
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
            // hard average-bitrate VBR; CBR would be stricter but fills quiet content
            // with padding bits. allows ~1.5x overshoot so motion bursts don't smear.
            rc_params.rateControlMode = NV_ENC_PARAMS_RC_VBR;
            rc_params.averageBitRate = avg_bps;
            rc_params.maxBitRate = avg_bps.saturating_add(avg_bps / 2);
        }
    }
}

/// Clamps QP to the codec's range (H.264/HEVC 0-51, AV1 0-255); saturates
/// rather than erroring since callers don't know the codec ahead of the probe.
fn clamp_qp_for_codec(codec: ActiveCodec, qp: u32) -> u32 {
    match codec {
        ActiveCodec::H264 => qp.min(51),
        ActiveCodec::Av1 => qp.min(255),
    }
}

// helpers

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
