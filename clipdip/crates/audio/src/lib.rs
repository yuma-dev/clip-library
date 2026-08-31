//! WASAPI audio capture.
//!
//! One thread per source. Each thread opens an `IAudioClient` in shared
//! mode (loopback flag for system audio, plain capture for the mic), pumps
//! `IAudioCaptureClient::GetBuffer` in a polling loop, and pushes raw PCM
//! into the shared `PacketRing` with a distinct `stream_id`.
//!
//! Encoded-AAC packets will replace raw PCM once FFmpeg/ffmpeg-next lands
//! in task #5. Until then, downstream code can write `.wav` sidecars
//! using the format reported by [`AudioCapture::format`].

use anyhow::{anyhow, Context, Result};
use clipdip_ringbuf::{EncodedPacket, MediaClock, PacketRing};
use crossbeam_channel::{bounded, Sender};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;
use tracing::{debug, trace, warn};
use windows::core::GUID;
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, EDataFlow, ERole, IAudioCaptureClient, IAudioClient, IMMDevice,
    IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE, DEVICE_STATE_ACTIVE, WAVEFORMATEX,
    WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::System::Com::STGM_READ;
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PROPERTYKEY};

// WAVE_FORMAT_* tag values, from mmreg.h. The windows-rs `Win32::Media::Audio`
// module doesn't re-export these; they live in `Multimedia`/`KernelStreaming`
// behind feature flags we don't otherwise need. Hard-coding the (stable,
// since-forever) tag values is simpler than chasing feature transitively.
const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

/// Which WASAPI endpoint to open.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudioKind {
    /// `eRender` endpoint with `AUDCLNT_STREAMFLAGS_LOOPBACK` — system audio.
    SystemLoopback,
    /// `eCapture` endpoint — microphone / line-in.
    Microphone,
}

/// PCM format reported by WASAPI. Currently we pass through whatever the
/// device mix format is (almost always 32-bit float, 48 kHz, stereo).
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct WaveFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub is_float: bool,
}

impl WaveFormat {
    pub fn frame_bytes(&self) -> u32 {
        u32::from(self.channels) * u32::from(self.bits_per_sample / 8)
    }
}

/// Facts about a successfully opened capture stream, reported once by the
/// capture thread right after `IAudioClient::Start`.
#[derive(Clone, Debug)]
pub struct StreamInfo {
    pub format: WaveFormat,
    /// WASAPI id of the endpoint that was actually opened. For a
    /// `device_id = None` (system default) source this resolves which
    /// concrete device "default" meant at start time — a device-change
    /// watcher compares it against the current default to notice that a
    /// running stream is now pointed at yesterday's endpoint.
    pub device_id: String,
}

/// A running audio capture thread. Drop or call [`Self::stop`] to end.
pub struct AudioCapture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<Result<()>>>,
    format: WaveFormat,
    device_id_in_use: String,
    kind: AudioKind,
}

impl AudioCapture {
    /// Spawn a capture thread. `stream_id` is the value stamped on every
    /// emitted `EncodedPacket` — pick a unique one per source.
    ///
    /// `device_id` is an optional WASAPI device ID (from
    /// [`AudioDeviceInfo::id`]). `None` opens the system default
    /// endpoint for the given `kind` — same as before.
    pub fn start(
        kind: AudioKind,
        stream_id: u8,
        device_id: Option<String>,
        ring: Arc<PacketRing>,
        clock: Arc<MediaClock>,
    ) -> Result<Self> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        let (fmt_tx, fmt_rx) = bounded::<Result<StreamInfo>>(1);

        let label = match kind {
            AudioKind::SystemLoopback => "audio-loopback",
            AudioKind::Microphone => "audio-mic",
        };

        let thread = std::thread::Builder::new()
            .name(label.into())
            .spawn(move || {
                let result =
                    run_capture(kind, stream_id, device_id, ring, clock, stop_thread, &fmt_tx);
                // If init failed before we sent the format, surface the
                // error on the format channel so start() doesn't hang.
                if let Err(e) = &result {
                    let _ = fmt_tx.try_send(Err(anyhow!("{e:#}")));
                }
                result
            })
            .context("spawn audio capture thread")?;

        let info = fmt_rx
            .recv()
            .context("audio capture thread exited before reporting format")??;

        Ok(Self {
            stop,
            thread: Some(thread),
            format: info.format,
            device_id_in_use: info.device_id,
            kind,
        })
    }

    pub fn format(&self) -> WaveFormat {
        self.format
    }

    pub fn kind(&self) -> AudioKind {
        self.kind
    }

    /// WASAPI id of the endpoint this capture actually opened (the concrete
    /// device behind "system default" for unpinned sources).
    pub fn device_id_in_use(&self) -> &str {
        &self.device_id_in_use
    }

    /// True once the capture thread has exited — a mid-session death (the
    /// device was unplugged, the driver reset). The thread's error is only
    /// consumable at join; this is the cheap liveness probe for watchers.
    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().map_or(true, |t| t.is_finished())
    }

    /// Signal the thread to exit and wait for it. Errors from the thread
    /// are logged at WARN and otherwise swallowed.
    pub fn stop(mut self) {
        self.signal_and_join();
    }

    fn signal_and_join(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            match t.join() {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    warn!(kind = ?self.kind, "audio capture thread error: {e:#}");
                    // Mid-session audio death was completely invisible: the
                    // thread error only surfaces here, at pipeline stop, as
                    // a warn. AUDCLNT_E_DEVICE_INVALIDATED (0x88890004,
                    // endpoint unplugged / format changed) gets its own
                    // code — the "my clip has no sound" cohort. The message
                    // stays generic; the chain can embed device-id strings.
                    let chain = format!("{e:#}").to_ascii_lowercase();
                    let device_lost = chain.contains("0x88890004");
                    let code = if device_lost { "audio_device_lost" } else { "audio_thread_exited" };
                    if let clipdip_diagnostics::Gate::Send { suppressed } =
                        clipdip_diagnostics::gate(code, std::time::Duration::from_secs(60))
                    {
                        // The kind is part of the message on purpose: the
                        // server groups issues by message template, and a
                        // dead mic and dead system loopback are different
                        // problems that must not share one issue.
                        clipdip_diagnostics::report_error_with(
                            code,
                            clipdip_diagnostics::Severity::Warning,
                            if device_lost {
                                format!(
                                    "audio device invalidated mid-session ({:?}, unplugged or format changed)",
                                    self.kind
                                )
                            } else {
                                format!("audio capture thread exited with an error ({:?})", self.kind)
                            },
                            Some(serde_json::json!({
                                "audio_kind": format!("{:?}", self.kind),
                                "occurrences": suppressed + 1,
                            })),
                        );
                    }
                }
                Err(_) => warn!(kind = ?self.kind, "audio capture thread panicked"),
            }
        }
    }
}

impl Drop for AudioCapture {
    fn drop(&mut self) {
        self.signal_and_join();
    }
}

// ---- thread body --------------------------------------------------------

fn run_capture(
    kind: AudioKind,
    stream_id: u8,
    device_id: Option<String>,
    ring: Arc<PacketRing>,
    clock: Arc<MediaClock>,
    stop: Arc<AtomicBool>,
    fmt_tx: &Sender<Result<StreamInfo>>,
) -> Result<()> {
    // SAFETY: we're a fresh thread; COM must be initialized on it.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .context("CoInitializeEx")?;
    }
    let _com_guard = ComUninitGuard;

    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .context("CoCreateInstance(MMDeviceEnumerator)")?;

    // If a specific device was requested, look it up by ID; otherwise use
    // the system default for the appropriate endpoint side. Loopback only
    // works on render endpoints — passing a capture-side ID with
    // `SystemLoopback` will fail at `Initialize` below.
    let device = unsafe {
        match device_id.as_deref() {
            Some(id) => {
                let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
                enumerator
                    .GetDevice(windows::core::PCWSTR(wide.as_ptr()))
                    .with_context(|| format!("IMMDeviceEnumerator::GetDevice({id})"))?
            }
            None => match kind {
                AudioKind::SystemLoopback => enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?,
                AudioKind::Microphone => enumerator.GetDefaultAudioEndpoint(eCapture, eConsole)?,
            },
        }
    };

    let client: IAudioClient =
        unsafe { device.Activate(CLSCTX_ALL, None) }.context("IMMDevice::Activate")?;

    // Endpoint volume — polled per-buffer so mid-clip slider changes
    // take effect within one WASAPI period (~10ms). If activation fails
    // (rare; some virtual devices), fall back to unity gain.
    // For microphones, the audio engine/driver already applies the volume
    // slider to the capture stream. Applying it again in software double-dips.
    let endpoint_volume: Option<IAudioEndpointVolume> = match kind {
        AudioKind::SystemLoopback => unsafe { device.Activate(CLSCTX_ALL, None) }.ok(),
        AudioKind::Microphone => None,
    };
    if endpoint_volume.is_none() && matches!(kind, AudioKind::SystemLoopback) {
        warn!(?kind, "IAudioEndpointVolume unavailable; capturing at unity gain");
    }

    let mix_fmt = unsafe { client.GetMixFormat() }.context("GetMixFormat")?;
    if mix_fmt.is_null() {
        return Err(anyhow!("GetMixFormat returned null"));
    }
    let fmt = unsafe { decode_wave_format(mix_fmt) };

    let stream_flags = match kind {
        AudioKind::SystemLoopback => AUDCLNT_STREAMFLAGS_LOOPBACK,
        AudioKind::Microphone => 0,
    };

    // 200 ms request — WASAPI rounds up to the device period. Hard-coded
    // for now; if jitter becomes an issue, expose this in `AudioConfig`.
    const HNS_PER_MS: i64 = 10_000;
    let buffer_duration = 200 * HNS_PER_MS;

    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags,
                buffer_duration,
                0,
                mix_fmt,
                None,
            )
            .context("IAudioClient::Initialize")?;
    }

    // `mix_fmt` was allocated by COM; release it now that Initialize has
    // copied the relevant fields internally.
    unsafe { CoTaskMemFree(Some(mix_fmt as *const _)) };

    let capture: IAudioCaptureClient = unsafe { client.GetService() }
        .context("IAudioClient::GetService(IAudioCaptureClient)")?;
    unsafe { client.Start() }.context("IAudioClient::Start")?;
    let _client_stop = ClientStopGuard {
        client: client.clone(),
    };

    // Successful init — tell the caller the format (to size sidecars) and
    // which endpoint was actually opened (to track default-device drift).
    let opened_id = unsafe { read_device_id(&device) }.unwrap_or_default();
    let _ = fmt_tx.try_send(Ok(StreamInfo {
        format: fmt,
        device_id: opened_id,
    }));

    debug!(
        ?kind,
        sample_rate = fmt.sample_rate,
        channels = fmt.channels,
        bits = fmt.bits_per_sample,
        is_float = fmt.is_float,
        stream_id,
        "audio capture started"
    );

    let frame_bytes = fmt.frame_bytes();

    while !stop.load(Ordering::Relaxed) {
        let mut next = unsafe { capture.GetNextPacketSize() }.context("GetNextPacketSize")?;
        while next != 0 {
            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut num_frames: u32 = 0;
            let mut flags: u32 = 0;
            let mut qpc_pos: u64 = 0;
            unsafe {
                capture
                    .GetBuffer(
                        &mut data_ptr,
                        &mut num_frames,
                        &mut flags,
                        None,
                        Some(&mut qpc_pos),
                    )
                    .context("GetBuffer")?;
            }

            if num_frames > 0 {
                let byte_count = (num_frames * frame_bytes) as usize;
                let gain = current_gain(endpoint_volume.as_ref());
                let bytes: Arc<[u8]> = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0
                    || data_ptr.is_null()
                    || gain == 0.0
                {
                    // SILENT, muted, or null: emit zeros so the timeline
                    // stays continuous.
                    vec![0u8; byte_count].into()
                } else {
                    // SAFETY: WASAPI guarantees `data_ptr` is valid for
                    // `num_frames * frame_bytes` until ReleaseBuffer.
                    let mut buf = unsafe { std::slice::from_raw_parts(data_ptr, byte_count) }
                        .to_vec();
                    if gain != 1.0 {
                        apply_gain(&mut buf, &fmt, gain);
                    }
                    buf.into()
                };

                if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                    // TRACE, not DEBUG: WASAPI flags a discontinuity on nearly
                    // every buffer in some setups (millions of lines/day),
                    // which floods the file log. The silence-padding in the
                    // WAV writer already compensates for the gap; this is only
                    // useful at the finest verbosity.
                    trace!(?kind, "WASAPI reported data discontinuity");
                }

                // QPC position is already in 100ns units, but stamp it
                // through the shared media clock so a capture stall the
                // video thread compensated for shifts audio by the same
                // amount — keeping the two streams on one timeline.
                let pts = clock.to_media(qpc_pos as i64);
                ring.push(EncodedPacket {
                    bytes,
                    pts_100ns: pts,
                    dts_100ns: pts,
                    // Every PCM frame is independent. Same will be true
                    // of AAC frames once we encode in task #5.
                    is_keyframe: true,
                    stream_id,
                });
            }

            unsafe { capture.ReleaseBuffer(num_frames) }.context("ReleaseBuffer")?;
            next = unsafe { capture.GetNextPacketSize() }.context("GetNextPacketSize")?;
        }

        // Light polling — WASAPI typical period is 10ms, so 5ms is plenty
        // responsive without burning CPU.
        std::thread::sleep(Duration::from_millis(5));
    }

    Ok(())
}

/// Current effective gain (master scalar × !mute) for an endpoint. Returns
/// 1.0 if the endpoint volume interface is missing or any query fails — we
/// prefer "loud but present" over silent on transient COM hiccups.
fn current_gain(vol: Option<&IAudioEndpointVolume>) -> f32 {
    let Some(vol) = vol else { return 1.0 };
    let muted = unsafe { vol.GetMute() }.map(|b| b.as_bool()).unwrap_or(false);
    if muted {
        return 0.0;
    }
    unsafe { vol.GetMasterVolumeLevelScalar() }.unwrap_or(1.0)
}

/// Scale PCM samples in-place by `gain`. Handles the two formats WASAPI
/// shared-mode realistically hands us: 32-bit float (the mix format, used
/// by loopback and most mics) and 16-bit signed int (some legacy mics).
/// Other formats are passed through unchanged.
fn apply_gain(buf: &mut [u8], fmt: &WaveFormat, gain: f32) {
    if fmt.is_float && fmt.bits_per_sample == 32 {
        // SAFETY: WASAPI float buffers are 4-byte aligned by construction
        // and `buf` is a Vec<u8> we just allocated — the bytes::Vec layout
        // gives 8-byte alignment, so casting to f32 is sound.
        let samples = unsafe {
            std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut f32, buf.len() / 4)
        };
        for s in samples {
            *s *= gain;
        }
    } else if !fmt.is_float && fmt.bits_per_sample == 16 {
        let samples = unsafe {
            std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut i16, buf.len() / 2)
        };
        for s in samples {
            let scaled = (*s as f32) * gain;
            *s = scaled.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        }
    }
    // Other bit depths (24-bit packed, 32-bit int) are uncommon in shared
    // mode and would need byte-level decode; skip for now.
}

/// Read a WASAPI `WAVEFORMATEX[ENSIBLE]*` pointer into our typed snapshot.
/// Handles the EXTENSIBLE wrapper (most mix formats are EXTENSIBLE / float).
unsafe fn decode_wave_format(ptr: *const WAVEFORMATEX) -> WaveFormat {
    let base = unsafe { &*ptr };
    let mut is_float = base.wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    if base.wFormatTag == WAVE_FORMAT_EXTENSIBLE {
        // `WAVEFORMATEXTENSIBLE` is `#[repr(packed)]` in windows-rs, so we
        // can't take a reference to `SubFormat`. Read it via raw pointer.
        let ext_ptr = ptr as *const WAVEFORMATEXTENSIBLE;
        let sub_format = unsafe { std::ptr::addr_of!((*ext_ptr).SubFormat).read_unaligned() };
        // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
        // = {00000003-0000-0010-8000-00AA00389B71}
        const IEEE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00AA00389B71);
        is_float = sub_format == IEEE_FLOAT;
    }
    WaveFormat {
        sample_rate: base.nSamplesPerSec,
        channels: base.nChannels,
        bits_per_sample: base.wBitsPerSample,
        is_float,
    }
}

// ---- RAII guards --------------------------------------------------------

struct ComUninitGuard;
impl Drop for ComUninitGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct ClientStopGuard {
    client: IAudioClient,
}
impl Drop for ClientStopGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

// ---- device enumeration ------------------------------------------------

/// Which side of the audio system a device belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeviceFlow {
    /// Output endpoint (speakers / headphones) — usable for system loopback.
    Render,
    /// Input endpoint (microphone / line-in).
    Capture,
}

/// Snapshot of one WASAPI endpoint.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AudioDeviceInfo {
    /// Stable WASAPI device ID (e.g. `{0.0.0.00000000}.{abc-def-...}`).
    /// Use this in `AudioSource::device_id` to pin a specific endpoint.
    pub id: String,
    pub friendly_name: String,
    pub flow: DeviceFlow,
    /// True if this device is the system default for its flow on the
    /// `eConsole` role. The default endpoint changes when the user
    /// switches output / input in Windows settings.
    pub is_default: bool,
}

/// Enumerate every active WASAPI endpoint — render + capture — with
/// friendly names. Marks the system-default for each side.
///
/// This is a one-shot COM call; safe to invoke without an existing
/// `AudioCapture` running.
pub fn list_devices() -> Result<Vec<AudioDeviceInfo>> {
    // COM may already be initialized on this thread in a different
    // apartment (Tauri's invoke handlers run on threads that the runtime
    // may have STA-initialized). Treat RPC_E_CHANGED_MODE as a soft
    // success — we don't own the init, so we must NOT CoUninitialize on
    // drop. MMDevice works in either apartment.
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let owns_com = hr.is_ok();
    if !owns_com && hr != windows::Win32::Foundation::RPC_E_CHANGED_MODE {
        return Err(anyhow::anyhow!("CoInitializeEx failed: 0x{:08x}", hr.0));
    }
    let _com_guard = owns_com.then_some(ComUninitGuard);

    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .context("CoCreateInstance(MMDeviceEnumerator)")?;

    let mut devices = Vec::new();
    for &(flow, marker) in &[(eRender, DeviceFlow::Render), (eCapture, DeviceFlow::Capture)] {
        // Default device for this side — used to flag `is_default`.
        let default_id = unsafe {
            enumerator
                .GetDefaultAudioEndpoint(flow, eConsole)
                .ok()
                .and_then(|d| read_device_id(&d).ok())
        };

        let collection = unsafe { enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) }
            .with_context(|| format!("EnumAudioEndpoints({flow:?})"))?;
        let count = unsafe { collection.GetCount() }.context("collection GetCount")?;
        for i in 0..count {
            let dev = unsafe { collection.Item(i) }.with_context(|| format!("collection item {i}"))?;
            let id = match unsafe { read_device_id(&dev) } {
                Ok(s) => s,
                Err(e) => {
                    warn!("failed to read device id at index {i}: {e:#}");
                    continue;
                }
            };
            let friendly_name = unsafe { read_friendly_name(&dev) }
                .unwrap_or_else(|_| "(unknown)".into());
            let is_default = default_id.as_deref() == Some(id.as_str());
            devices.push(AudioDeviceInfo {
                id,
                friendly_name,
                flow: marker,
                is_default,
            });
        }
    }
    Ok(devices)
}

/// PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0}, pid=14.
/// Hand-defining the PROPERTYKEY constant avoids pulling in the
/// `Win32_Devices_FunctionDiscovery` feature for one value.
const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

unsafe fn read_device_id(dev: &IMMDevice) -> Result<String> {
    let pwstr = unsafe { dev.GetId() }.context("IMMDevice::GetId")?;
    let s = unsafe { pwstr.to_string() }.context("decode device id")?;
    // PWSTR returned by GetId is allocated by COM — free it.
    unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(pwstr.as_ptr() as *const _)) };
    Ok(s)
}

// ---- device change notifications ----------------------------------------

/// Something changed in the endpoint topology. Deliberately coarse: the
/// consumer re-enumerates and re-evaluates whatever it cares about, so the
/// variants only exist for logging.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceChange {
    Added,
    Removed,
    StateChanged,
    DefaultChanged,
}

#[windows::core::implement(IMMNotificationClient)]
struct NotificationClient {
    tx: Sender<DeviceChange>,
}

impl IMMNotificationClient_Impl for NotificationClient_Impl {
    fn OnDeviceStateChanged(
        &self,
        _device_id: &windows::core::PCWSTR,
        _new_state: DEVICE_STATE,
    ) -> windows::core::Result<()> {
        let _ = self.tx.try_send(DeviceChange::StateChanged);
        Ok(())
    }

    fn OnDeviceAdded(&self, _device_id: &windows::core::PCWSTR) -> windows::core::Result<()> {
        let _ = self.tx.try_send(DeviceChange::Added);
        Ok(())
    }

    fn OnDeviceRemoved(&self, _device_id: &windows::core::PCWSTR) -> windows::core::Result<()> {
        let _ = self.tx.try_send(DeviceChange::Removed);
        Ok(())
    }

    fn OnDefaultDeviceChanged(
        &self,
        _flow: EDataFlow,
        role: ERole,
        _default_id: &windows::core::PCWSTR,
    ) -> windows::core::Result<()> {
        // Fires once per role (console / multimedia / communications) on
        // every switch; we capture on the console role, so one is enough.
        if role == eConsole {
            let _ = self.tx.try_send(DeviceChange::DefaultChanged);
        }
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _device_id: &windows::core::PCWSTR,
        _key: &PROPERTYKEY,
    ) -> windows::core::Result<()> {
        // Property churn (volume, names) is frequent and irrelevant here.
        Ok(())
    }
}

/// Watches WASAPI endpoint arrivals/removals/state flips and default-device
/// switches. Events land on the returned channel (bounded; drops when the
/// consumer lags, which is fine — they carry no payload). Dropping the
/// watcher unregisters and stops the thread.
pub struct DeviceWatcher {
    stop_tx: Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl DeviceWatcher {
    pub fn start() -> Result<(Self, crossbeam_channel::Receiver<DeviceChange>)> {
        let (tx, rx) = bounded::<DeviceChange>(64);
        let (stop_tx, stop_rx) = bounded::<()>(1);
        let (ready_tx, ready_rx) = bounded::<Result<()>>(1);

        let thread = std::thread::Builder::new()
            .name("audio-device-watch".into())
            .spawn(move || {
                // COM must stay initialized on the registering thread for
                // as long as the registration lives.
                let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
                if hr.is_err() {
                    let _ = ready_tx.try_send(Err(anyhow!("CoInitializeEx: 0x{:08x}", hr.0)));
                    return;
                }
                let _com_guard = ComUninitGuard;

                let enumerator: IMMDeviceEnumerator =
                    match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
                        Ok(e) => e,
                        Err(e) => {
                            let _ = ready_tx
                                .try_send(Err(anyhow!("CoCreateInstance(MMDeviceEnumerator): {e}")));
                            return;
                        }
                    };
                let client: IMMNotificationClient = NotificationClient { tx }.into();
                if let Err(e) =
                    unsafe { enumerator.RegisterEndpointNotificationCallback(&client) }
                {
                    let _ = ready_tx.try_send(Err(anyhow!(
                        "RegisterEndpointNotificationCallback: {e}"
                    )));
                    return;
                }
                let _ = ready_tx.try_send(Ok(()));

                // Callbacks arrive on MMDevice's own threads; this thread
                // just anchors the COM apartment until stop.
                let _ = stop_rx.recv();
                unsafe {
                    let _ = enumerator.UnregisterEndpointNotificationCallback(&client);
                }
            })
            .context("spawn audio device watch thread")?;

        ready_rx
            .recv()
            .context("audio device watch thread exited before registering")??;

        Ok((
            Self {
                stop_tx,
                thread: Some(thread),
            },
            rx,
        ))
    }
}

impl Drop for DeviceWatcher {
    fn drop(&mut self) {
        let _ = self.stop_tx.try_send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

unsafe fn read_friendly_name(dev: &IMMDevice) -> Result<String> {
    let store: IPropertyStore =
        unsafe { dev.OpenPropertyStore(STGM_READ) }.context("OpenPropertyStore")?;
    // windows-rs 0.58 `PROPVARIANT` is a smart wrapper that hides the
    // tagged-union access and frees on drop. Its `Display`/`to_string`
    // formats VT_LPWSTR variants directly as the contained string.
    let var = unsafe { store.GetValue(&PKEY_DEVICE_FRIENDLY_NAME) }
        .context("GetValue(FriendlyName)")?;
    Ok(var.to_string())
}
