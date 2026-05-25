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
use std::collections::{HashMap, VecDeque};
use std::ffi::CStr;
use std::ptr;
use std::sync::Arc;
use tracing::{trace, warn};
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};

use crate::loader::NvEncApi;
use crate::sys::*;
use crate::EncoderConfig;

const BITSTREAM_POOL_SIZE: usize = 4;

/// One submitted-but-not-yet-locked frame. NVENC will signal
/// `pool[slot].event` when the bitstream is ready; until then this entry
/// sits in `pending`.
struct PendingFrame {
    slot: usize,
}

/// Bitstream buffer + paired completion event. In async mode every
/// submitted picture is associated with one of these; NVENC signals the
/// event when the bitstream for that picture is ready.
struct PoolSlot {
    bitstream: NV_ENC_OUTPUT_PTR,
    event: HANDLE,
}

pub struct NvEncoderD3D11 {
    api: Arc<NvEncApi>,
    encoder: *mut std::ffi::c_void,
    _device: ID3D11Device,
    config: EncoderConfig,
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
    /// Texture pointer → NVENC registered handle. DXGI Desktop Duplication
    /// hands us the SAME private texture instance each call (we keep one
    /// "current" capture surface in the duplicator), so this cache will
    /// effectively size to 1–2 entries. Per-frame register/unregister was
    /// the dominant GPU-encode overhead before this cache (≈14% → ≈3%).
    reg_cache: HashMap<usize, NV_ENC_REGISTERED_PTR>,
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

        // ---- query preset defaults --------------------------------------
        // Start from the driver's recommended config for our chosen
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
                NV_ENC_CODEC_H264_GUID,
                NV_ENC_PRESET_P4_GUID,
                NV_ENC_TUNING_INFO_LOW_LATENCY,
                &mut preset,
            )
        };
        nvenc_check(&api, encoder, status, "GetEncodePresetConfigEx")?;

        // ---- override the knobs we care about ---------------------------
        let mut enc_cfg = preset.presetCfg;
        enc_cfg.version = NV_ENC_CONFIG_VER;
        enc_cfg.gopLength = config.gop_length;
        enc_cfg.frameIntervalP = 1; // IPP... (no B-frames in low-latency)
        enc_cfg.set_h264_idr_period(config.gop_length);
        // Emit SPS+PPS in front of EVERY IDR, not just frame 0. The ring
        // evicts whole GOPs once full, so without this any clip saved
        // after the first eviction would start with an IDR slice whose
        // SPS+PPS are no longer in the file — ffmpeg / players reject
        // it with "non-existing PPS 0 referenced".
        enc_cfg.set_h264_repeat_sps_pps(true);

        enc_cfg.rcParams.version = NV_ENC_RC_PARAMS_VER;
        // VBR with a hard average target. CBR would honor bitrate even more
        // strictly but produces filler bits on quiet content. VBR is the
        // right default for a clipper.
        enc_cfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_VBR;
        enc_cfg.rcParams.averageBitRate = config.bitrate_bps;
        // Allow short-term overshoot up to ~1.5× average so motion bursts
        // don't smear. Driver picks defaults when vbvBufferSize stays 0.
        enc_cfg.rcParams.maxBitRate = config
            .bitrate_bps
            .saturating_add(config.bitrate_bps / 2);

        // ---- initialize -------------------------------------------------
        let mut init = NV_ENC_INITIALIZE_PARAMS::default();
        init.version = NV_ENC_INITIALIZE_PARAMS_VER;
        init.encodeGUID = NV_ENC_CODEC_H264_GUID;
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
        init.bufferFormat = NV_ENC_BUFFER_FORMAT_ARGB;
        init.encodeConfig = &mut enc_cfg as *mut _ as *mut std::ffi::c_void;
        // Async mode: NVENC signals a per-frame completion event when the
        // bitstream is ready instead of making LockBitstream block. Lets
        // us submit frame N+1 while frame N is still encoding — saves the
        // ~2.2 ms / frame CPU wait we'd otherwise burn.
        init.enableEncodeAsync = 1;

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

            // Completion event.
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

            pool.push(PoolSlot {
                bitstream: bs.bitstreamBuffer,
                event,
            });
        }

        Ok(Self {
            api,
            encoder,
            _device: device,
            config,
            pool,
            next_slot: 0,
            pending: VecDeque::with_capacity(BITSTREAM_POOL_SIZE),
            frames_submitted: 0,
            // Force the very first frame to emit SPS+PPS+IDR so decoders
            // can latch on immediately, regardless of where the next
            // automatic IDR (driven by gopLength) would fall.
            force_idr: true,
            reg_cache: HashMap::new(),
        })
    }

    /// Manually request an IDR on the next submitted frame. Not needed for
    /// normal operation — the bound `gopLength` drives automatic IDR
    /// cadence — but useful if a future feature wants on-demand scene cuts
    /// or recovery after a network blip.
    pub fn force_idr_next_frame(&mut self) {
        self.force_idr = true;
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
        let tex_ptr = texture.as_raw() as usize;
        let registered = if let Some(&r) = self.reg_cache.get(&tex_ptr) {
            r
        } else {
            let mut reg = NV_ENC_REGISTER_RESOURCE::default();
            reg.version = NV_ENC_REGISTER_RESOURCE_VER;
            reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
            reg.width = self.config.width;
            reg.height = self.config.height;
            reg.pitch = 0;
            reg.resourceToRegister = tex_ptr as *mut _;
            reg.bufferFormat = NV_ENC_BUFFER_FORMAT_ARGB;
            reg.bufferUsage = NV_ENC_INPUT_IMAGE;

            let register_fn = self
                .api
                .functions
                .nvEncRegisterResource
                .expect("loader checked");
            let status = unsafe { (register_fn)(self.encoder, &mut reg) };
            nvenc_check(&self.api, self.encoder, status, "RegisterResource")?;
            self.reg_cache.insert(tex_ptr, reg.registeredResource);
            reg.registeredResource
        };

        self.encode_with_registered(registered, pts_100ns, /*eos=*/ false)
    }

    fn encode_with_registered(
        &mut self,
        registered: NV_ENC_REGISTERED_PTR,
        pts_100ns: i64,
        eos: bool,
    ) -> Result<Vec<EncodedPacket>> {
        let mut packets = Vec::new();

        // ---- safety valve: if all slots are in flight, wait on the
        // oldest before reusing its buffer. Should be rare under steady
        // state — pool depth is 4 and our per-frame encode latency p99
        // is ~4 ms vs a 16.7 ms frame interval, leaving plenty of slack.
        if self.pending.len() >= self.pool.len() {
            let pkt = self.wait_and_lock_front()?;
            packets.push(pkt);
        }

        let _t_map = clipdip_profile::start("encoder.map");
        // ---- map --------------------------------------------------------
        let mut mapped = NV_ENC_MAP_INPUT_RESOURCE::default();
        mapped.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
        mapped.registeredResource = registered;

        let map_fn = self.api.functions.nvEncMapInputResource.expect("loader checked");
        let status = unsafe { (map_fn)(self.encoder, &mut mapped) };
        nvenc_check(&self.api, self.encoder, status, "MapInputResource")?;

        // ---- pick a bitstream slot (round-robin) ------------------------
        let slot = self.next_slot;
        self.next_slot = (slot + 1) % self.pool.len();
        let output = self.pool[slot].bitstream;
        let event = self.pool[slot].event;

        // ---- encode picture ---------------------------------------------
        let mut pic = NV_ENC_PIC_PARAMS::default();
        pic.version = NV_ENC_PIC_PARAMS_VER;
        pic.inputWidth = self.config.width;
        pic.inputHeight = self.config.height;
        pic.inputPitch = self.config.width;
        pic.inputBuffer = mapped.mappedResource;
        pic.bufferFmt = NV_ENC_BUFFER_FORMAT_ARGB;
        pic.outputBitstream = output;
        pic.completionEvent = event.0 as *mut _;
        pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
        pic.inputTimeStamp = pts_100ns as u64;
        pic.frameIdx = self.frames_submitted as u32;
        if eos {
            pic.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
        } else if self.force_idr {
            pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
            self.force_idr = false;
        }

        drop(_t_map);
        let t_submit = clipdip_profile::start("encoder.submit");
        let encode_fn = self.api.functions.nvEncEncodePicture.expect("loader checked");
        let status = unsafe { (encode_fn)(self.encoder, &mut pic) };
        drop(t_submit);

        // In async mode, NVENC fires the completion event for every
        // submitted picture — even when `EncodePicture` returns
        // NEED_MORE_INPUT (the picture was consumed; output bitstream
        // simply isn't ready yet). So we add to `pending` for both
        // SUCCESS and NEED_MORE_INPUT.
        match status {
            NV_ENC_SUCCESS | NV_ENC_ERR_NEED_MORE_INPUT => {
                self.pending.push_back(PendingFrame { slot });
            }
            _ => {
                // Unmap before bubbling error so we don't leak the mapping.
                let unmap_fn = self.api.functions.nvEncUnmapInputResource.unwrap();
                unsafe { (unmap_fn)(self.encoder, mapped.mappedResource) };
                return Err(nvenc_error(&self.api, self.encoder, status, "EncodePicture"));
            }
        }
        if !eos {
            self.frames_submitted += 1;
        }

        // ---- unmap (safe to do now; NVENC has copied what it needs) ----
        let unmap_fn = self.api.functions.nvEncUnmapInputResource.expect("loader checked");
        let status = unsafe { (unmap_fn)(self.encoder, mapped.mappedResource) };
        if status != NV_ENC_SUCCESS {
            warn!(status, "UnmapInputResource failed");
        }

        // ---- non-blocking drain ----------------------------------------
        // Walk the front of the pending queue, popping any frames whose
        // events are already signaled. Lets us catch up if encode is
        // running ahead of submission (which is the steady state at
        // 60 fps + 2.4 ms p50 encode time).
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
        let event = self.pool[slot].event;
        let _t = clipdip_profile::start("encoder.wait_block");
        // SAFETY: HANDLE valid; INFINITE = WAIT_OBJECT_0 once signaled
        // (auto-reset event), or WAIT_FAILED if something is very wrong.
        let wait = unsafe { WaitForSingleObject(event, INFINITE) };
        if wait != WAIT_OBJECT_0 {
            bail!("WaitForSingleObject returned {:?} on completion event", wait);
        }
        drop(_t);
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
        // the bitstream for an IDR slice NAL (type 5) or SPS NAL (type 7)
        // instead. OBS does the same.
        let is_keyframe = scan_for_keyframe(&bytes);

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
        // consumed the last signal).
        let eos_event = self.pool[0].event;
        let mut pic = NV_ENC_PIC_PARAMS::default();
        pic.version = NV_ENC_PIC_PARAMS_VER;
        pic.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
        pic.completionEvent = eos_event.0 as *mut _;
        // EOS doesn't need an input buffer.
        let encode_fn = self.api.functions.nvEncEncodePicture.expect("loader checked");
        let status = unsafe { (encode_fn)(self.encoder, &mut pic) };
        if status != NV_ENC_SUCCESS && status != NV_ENC_ERR_NEED_MORE_INPUT {
            return Err(nvenc_error(&self.api, self.encoder, status, "EOS EncodePicture"));
        }
        // SAFETY: eos_event valid; INFINITE waits until NVENC signals.
        let wait = unsafe { WaitForSingleObject(eos_event, INFINITE) };
        if wait != WAIT_OBJECT_0 {
            bail!("WaitForSingleObject on EOS event returned {:?}", wait);
        }
        Ok(packets)
    }
}

impl Drop for NvEncoderD3D11 {
    fn drop(&mut self) {
        // If the caller skipped `flush()`, drain remaining events first
        // — NVENC won't let us unregister an event that still has a
        // pending picture associated with it.
        while let Some(p) = self.pending.pop_front() {
            let event = self.pool[p.slot].event;
            unsafe { WaitForSingleObject(event, INFINITE) };
        }

        // Order matters: unregister textures → unregister events →
        // destroy bitstream buffers → close event handles →
        // destroy encoder.
        if let Some(f) = self.api.functions.nvEncUnregisterResource {
            for &registered in self.reg_cache.values() {
                unsafe { (f)(self.encoder, registered) };
            }
        }
        self.reg_cache.clear();

        if let Some(f) = self.api.functions.nvEncUnregisterAsyncEvent {
            for slot in &self.pool {
                let mut params = NV_ENC_EVENT_PARAMS::default();
                params.version = NV_ENC_EVENT_PARAMS_VER;
                params.completionEvent = slot.event.0 as *mut _;
                unsafe { (f)(self.encoder, &mut params) };
            }
        }

        let destroy_bs = self.api.functions.nvEncDestroyBitstreamBuffer;
        for slot in &self.pool {
            if let Some(f) = destroy_bs {
                unsafe { (f)(self.encoder, slot.bitstream) };
            }
            // SAFETY: HANDLE is from CreateEventW; close exactly once.
            unsafe { CloseHandle(slot.event).ok() };
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
fn scan_for_keyframe(bytes: &[u8]) -> bool {
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

#[cfg(test)]
mod tests {
    use super::scan_for_keyframe;

    #[test]
    fn keyframe_scan_detects_idr_long_start_code() {
        // 00 00 00 01 65 = IDR slice
        let bytes = [0, 0, 0, 1, 0x65, 0x88];
        assert!(scan_for_keyframe(&bytes));
    }

    #[test]
    fn keyframe_scan_detects_sps_short_start_code() {
        // 00 00 01 67 = SPS
        let bytes = [0, 0, 1, 0x67, 0x42];
        assert!(scan_for_keyframe(&bytes));
    }

    #[test]
    fn keyframe_scan_rejects_p_slice() {
        // 00 00 00 01 41 = non-IDR slice (nal_type = 1)
        let bytes = [0, 0, 0, 1, 0x41, 0x9A];
        assert!(!scan_for_keyframe(&bytes));
    }

    #[test]
    fn keyframe_scan_finds_idr_after_sps_pps() {
        // SPS, PPS, IDR all in one buffer — first IDR triggers true.
        let bytes = [
            0, 0, 0, 1, 0x67, 0x42, // SPS — already triggers
            0, 0, 0, 1, 0x68, 0xeb, // PPS
            0, 0, 0, 1, 0x65, 0xb8, // IDR
        ];
        assert!(scan_for_keyframe(&bytes));
    }

    #[test]
    fn keyframe_scan_empty_or_tiny() {
        assert!(!scan_for_keyframe(&[]));
        assert!(!scan_for_keyframe(&[0, 0]));
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
