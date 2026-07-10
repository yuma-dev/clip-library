//! DXGI Desktop Duplication capture.
//!
//! Acquires frames from `IDXGIOutputDuplication`, copies them into a private
//! `ID3D11Texture2D` so we can release the source immediately (otherwise the
//! desktop compositor stalls), and hands the private texture to the encoder.

use anyhow::{anyhow, Context, Result};
use windows::core::Interface;
use windows::Win32::Foundation::{HMODULE, TRUE};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    D3D11_RESOURCE_MISC_GDI_COMPATIBLE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter1, IDXGIDevice, IDXGIOutput1, IDXGIOutputDuplication, IDXGISurface1,
    DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_DESC,
    DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTPUT_DESC,
};
use windows::Win32::Graphics::Gdi::DeleteObject;
use windows::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, ICONINFO,
};
use tracing::{info, warn};

pub mod wgc;

const POOL_SIZE: usize = 4;

/// Which capture API to use for the monitor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureBackend {
    /// Try Windows.Graphics.Capture first, fall back to DXGI Desktop
    /// Duplication if WGC can't initialize. The default: WGC sees
    /// fullscreen-exclusive / independent-flip / MPO content that
    /// Desktop Duplication is blind to.
    Auto,
    /// Windows.Graphics.Capture only (error if unavailable).
    Wgc,
    /// DXGI Desktop Duplication only. Cannot capture content presented on
    /// independent-flip / MPO / exclusive-fullscreen paths — it will show
    /// the desktop or a frozen frame instead of the game. Kept as an
    /// escape hatch.
    Dxgi,
}

/// Unified monitor capturer over the two backends. Both produce
/// [`CapturedFrame`]s with identical semantics (private texture ring,
/// CFR repeats), so the pipeline is backend-agnostic.
pub enum Capturer {
    Wgc(wgc::WgcCapturer),
    Dxgi(DesktopDuplicator),
}

impl Capturer {
    /// Create a capturer on an existing D3D11 device (the one that also
    /// drives NVENC). Used both at pipeline start and when rebuilding
    /// capture after an error mid-session — the encoder keeps running on
    /// the same device, so the rebuilt capturer must share it.
    pub fn with_device(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        backend: CaptureBackend,
        output_index: u32,
        include_cursor: bool,
    ) -> Result<Self> {
        match backend {
            CaptureBackend::Wgc => {
                let c = wgc::WgcCapturer::new(device, context, output_index, include_cursor)?;
                info!("capture backend: Windows.Graphics.Capture");
                Ok(Capturer::Wgc(c))
            }
            CaptureBackend::Dxgi => {
                let mut d = DesktopDuplicator::new(device, context, output_index)?;
                d.set_include_cursor(include_cursor);
                info!("capture backend: DXGI Desktop Duplication");
                Ok(Capturer::Dxgi(d))
            }
            CaptureBackend::Auto => {
                match wgc::WgcCapturer::new(
                    device.clone(),
                    context.clone(),
                    output_index,
                    include_cursor,
                ) {
                    Ok(c) => {
                        info!("capture backend: Windows.Graphics.Capture (auto)");
                        Ok(Capturer::Wgc(c))
                    }
                    Err(e) => {
                        warn!(
                            "WGC init failed — falling back to DXGI Desktop Duplication \
                             (fullscreen-exclusive games may not be captured): {e:#}"
                        );
                        let mut d = DesktopDuplicator::new(device, context, output_index)?;
                        d.set_include_cursor(include_cursor);
                        Ok(Capturer::Dxgi(d))
                    }
                }
            }
        }
    }

    /// Create a fresh D3D11 device and a capturer on it.
    pub fn create(
        backend: CaptureBackend,
        output_index: u32,
        include_cursor: bool,
    ) -> Result<(Self, ID3D11Device, ID3D11DeviceContext)> {
        let (device, context) = create_d3d11_device()?;
        let cap = Self::with_device(
            device.clone(),
            context.clone(),
            backend,
            output_index,
            include_cursor,
        )?;
        Ok((cap, device, context))
    }

    pub fn acquire_frame(&mut self, timeout_ms: u32) -> Result<Option<CapturedFrame>> {
        match self {
            Capturer::Wgc(c) => c.acquire_frame(timeout_ms),
            Capturer::Dxgi(d) => d.acquire_frame(timeout_ms),
        }
    }

    pub fn width(&self) -> u32 {
        match self {
            Capturer::Wgc(c) => c.width(),
            Capturer::Dxgi(d) => d.width(),
        }
    }

    pub fn height(&self) -> u32 {
        match self {
            Capturer::Wgc(c) => c.height(),
            Capturer::Dxgi(d) => d.height(),
        }
    }

    pub fn backend_name(&self) -> &'static str {
        match self {
            Capturer::Wgc(_) => "wgc",
            Capturer::Dxgi(_) => "dxgi",
        }
    }
}

pub struct CapturedFrame {
    /// Private copy of the captured backbuffer. Owned by the caller.
    pub texture: ID3D11Texture2D,
    /// QPC-based presentation time, matches DXGI_OUTDUPL_FRAME_INFO::LastPresentTime.
    pub pts_100ns: i64,
    /// True if this frame is a re-emission of the previously captured frame —
    /// DXGI delivered no new desktop image within the acquire timeout, so we
    /// returned the last good texture again to keep the encoder fed at CFR.
    /// Unchanged content encodes as tiny P-frames; downstream code can also
    /// use this flag to suppress redundant work.
    pub was_repeat: bool,
}

pub struct DesktopDuplicator {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    dup_desc: DXGI_OUTDUPL_DESC,
    /// Private-texture ring. We rotate through slots so the encoder NEVER
    /// receives the same `ID3D11Texture2D` pointer twice in a row — NVENC
    /// retains the previous picture's input as an internal reference frame
    /// and rejects (INVALID_PARAM) a back-to-back submission of the same
    /// buffer. OBS uses 4–8 (matched to its async pipeline depth +
    /// lookahead); our encoder is strictly 1:1 (`LockBitstream` immediately
    /// after every `EncodePicture`), so a small ring of 4 is plenty and
    /// matches OBS's lower bound.
    pool: [Option<ID3D11Texture2D>; POOL_SIZE],
    /// Next slot to render into (mod POOL_SIZE).
    next_slot: usize,
    /// Slot holding the most recent successful capture; on DXGI timeout we
    /// `CopyResource` from this slot into `next_slot` to produce a CFR
    /// repeat frame with a fresh texture pointer.
    last_slot: Option<usize>,
    /// PTS of the last successful capture (kept so repeat frames carry the
    /// original presentation time — callers can override with their own
    /// pacing if they want strict monotonicity).
    last_pts: i64,
    /// QueryPerformanceFrequency, cached once. `LastPresentTime` is a raw
    /// QPC reading; we normalize it to 100-ns ticks so video PTS shares a
    /// unit with WASAPI audio positions (which Windows pre-normalizes).
    /// On most modern machines QPF is exactly 10 MHz and this is a no-op,
    /// but that's a coincidence we must not rely on.
    qpc_freq: i64,
    /// Top-left of this output's rect in the virtual desktop. `GetCursorInfo`
    /// reports cursor coordinates in virtual-desktop space; we subtract this
    /// to translate to texture-local coordinates.
    output_origin: (i32, i32),
    /// Whether to composite the OS mouse cursor onto each frame. DXGI never
    /// includes it natively. Defaults to `true`.
    include_cursor: bool,
    /// Screen-space cursor position the last time we composited. Used by
    /// `emit_repeat` to skip the GDI compositing work when neither the
    /// position nor the cursor shape has changed since — that's the most
    /// common case while the user is idle, and GDI on a D3D texture is
    /// the single biggest 3D-engine cost in steady state.
    last_cursor_pos: (i32, i32),
    /// Raw `HCURSOR` value from the last draw. Compared as an integer
    /// because `HCURSOR` is `!Send`. Combined with `last_cursor_pos` to
    /// decide whether a repeat-frame draw can be skipped.
    last_cursor_handle: isize,
}

/// Read the current OS cursor's screen position and handle, or `None` if
/// no cursor is showing. Cheap — `GetCursorInfo` is a syscall but no
/// allocation, no GDI handles.
fn read_cursor_state() -> Option<((i32, i32), isize)> {
    unsafe {
        let mut ci = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut ci).is_err() {
            return None;
        }
        if ci.flags.0 & CURSOR_SHOWING.0 == 0 || ci.hCursor.is_invalid() {
            return None;
        }
        Some(((ci.ptScreenPos.x, ci.ptScreenPos.y), ci.hCursor.0 as isize))
    }
}

impl DesktopDuplicator {
    /// Create a duplicator on the given D3D11 device. The device MUST be the
    /// one that will also drive NVENC — sharing one device eliminates the
    /// cross-context texture copy that costs ~1.5% game FPS (obs#6647).
    pub fn new(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        output_index: u32,
    ) -> Result<Self> {
        unsafe {
            let dxgi_device: IDXGIDevice = device.cast()?;
            let adapter: IDXGIAdapter1 = dxgi_device.GetParent()?;
            let output = adapter
                .EnumOutputs(output_index)
                .with_context(|| format!("no DXGI output at index {output_index}"))?;
            let output1: IDXGIOutput1 = output.cast()?;
            let out_desc: DXGI_OUTPUT_DESC = output1.GetDesc()?;
            let output_origin = (
                out_desc.DesktopCoordinates.left,
                out_desc.DesktopCoordinates.top,
            );
            let duplication = output1
                .DuplicateOutput(&device)
                .context("DuplicateOutput failed (HDCP? hybrid-GPU mismatch?)")?;
            let dup_desc = duplication.GetDesc();
            Ok(Self {
                device,
                context,
                duplication,
                dup_desc,
                pool: Default::default(),
                next_slot: 0,
                last_slot: None,
                last_pts: 0,
                qpc_freq: {
                    let mut f = 0i64;
                    let _ = windows::Win32::System::Performance::QueryPerformanceFrequency(&mut f);
                    f.max(1)
                },
                output_origin,
                include_cursor: true,
                last_cursor_pos: (i32::MIN, i32::MIN),
                last_cursor_handle: 0,
            })
        }
    }

    /// Create a fresh D3D11 device on the default adapter and a duplicator on
    /// `output_index`. Convenience for the walking skeleton.
    pub fn with_default_device(
        output_index: u32,
    ) -> Result<(Self, ID3D11Device, ID3D11DeviceContext)> {
        let (device, context) = create_d3d11_device()?;
        let dup = Self::new(device.clone(), context.clone(), output_index)?;
        Ok((dup, device, context))
    }

    /// Enable/disable cursor compositing. The compositor uses `IDXGISurface1::GetDC`
    /// + `DrawIconEx`; turning it off avoids the per-frame GDI cost when callers
    /// don't want a cursor (e.g. recording a kiosk-style fullscreen app).
    pub fn set_include_cursor(&mut self, include: bool) {
        self.include_cursor = include;
    }

    pub fn width(&self) -> u32 {
        self.dup_desc.ModeDesc.Width
    }

    pub fn height(&self) -> u32 {
        self.dup_desc.ModeDesc.Height
    }

    /// Convert a raw QPC reading to 100-ns ticks. Split arithmetic so
    /// `ticks * 1e7` can't overflow i64 after long uptimes.
    fn qpc_to_100ns(&self, ticks: i64) -> i64 {
        let secs = ticks / self.qpc_freq;
        let rem = ticks % self.qpc_freq;
        secs * 10_000_000 + rem * 10_000_000 / self.qpc_freq
    }

    /// Block up to `timeout_ms` for a new frame.
    ///
    /// On DXGI timeout (the desktop image hasn't changed in the timeout window),
    /// re-emit the last successfully captured texture with `was_repeat = true`
    /// so callers see a constant-frame-rate stream. If no frame has ever been
    /// captured yet, returns `Ok(None)`.
    pub fn acquire_frame(&mut self, timeout_ms: u32) -> Result<Option<CapturedFrame>> {
        let _t = clipdip_profile::start("capture.acquire");
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource = None;
            let hr = self.duplication.AcquireNextFrame(timeout_ms, &mut info, &mut resource);
            match hr {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    return self.emit_repeat();
                }
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                    return Err(anyhow!("DXGI access lost (likely mode change or HDCP)"));
                }
                Err(e) => return Err(e.into()),
            }
            let source: ID3D11Texture2D = resource
                .ok_or_else(|| anyhow!("AcquireNextFrame returned no resource"))?
                .cast()?;

            let mut src_desc = D3D11_TEXTURE2D_DESC::default();
            source.GetDesc(&mut src_desc);

            // Take the next ring slot, allocating lazily on first use.
            let slot_idx = self.next_slot;
            let dst = self.ensure_slot(slot_idx, &src_desc)?;
            let t_copy = clipdip_profile::start("capture.copy_flush");
            self.context.CopyResource(&dst, &source);
            // Force the copy to actually submit to the GPU before we hand
            // the texture to NVENC. Without this, NVENC can sample a
            // not-yet-written texture and emit black frames. Must also
            // complete before we grab an HDC for cursor compositing.
            // (Tried replacing this with a D3D11_QUERY_EVENT fence — no
            // measurable GPU% change. The ~11% is dominated by NVENC
            // encode, not by Flush bookkeeping. Revisit when we have
            // per-stage profiling.)
            self.context.Flush();
            drop(t_copy);

            // Release the source frame back to DXGI immediately so the compositor
            // can keep producing.
            self.duplication.ReleaseFrame().ok();

            // DXGI Desktop Duplication doesn't include the cursor in the
            // captured texture — paint it ourselves (unless the user
            // opted out via `set_include_cursor(false)`). Real frames
            // always need a fresh draw because the source texture has
            // no cursor in it at all.
            if self.include_cursor {
                let _t = clipdip_profile::start("capture.cursor");
                draw_cursor(&dst, self.output_origin);
                if let Some((pos, handle)) = read_cursor_state() {
                    self.last_cursor_pos = pos;
                    self.last_cursor_handle = handle;
                }
            }

            let pts_100ns = self.qpc_to_100ns(info.LastPresentTime);
            self.last_slot = Some(slot_idx);
            self.last_pts = pts_100ns;
            self.next_slot = (slot_idx + 1) % POOL_SIZE;

            Ok(Some(CapturedFrame {
                texture: dst,
                pts_100ns,
                was_repeat: false,
            }))
        }
    }

    /// Re-emit the last captured frame by copying it into a fresh ring slot.
    /// Used on `DXGI_ERROR_WAIT_TIMEOUT`. Returns `Ok(None)` if no frame has
    /// ever been captured (nothing to repeat from).
    ///
    /// Always emits a frame when prior content exists so the encoder
    /// keeps producing packets at the configured CFR — the muxer's raw
    /// `.h264 -> .mp4` path assigns synthetic constant-rate timestamps
    /// via ffmpeg's `-framerate` flag, so dropping frames here would
    /// fast-forward the output. The cursor *draw* itself is still
    /// skipped below when nothing changed; that's the cheap win.
    fn emit_repeat(&mut self) -> Result<Option<CapturedFrame>> {
        let src_slot = match self.last_slot {
            Some(s) => s,
            None => return Ok(None),
        };
        // Same logical slot is fine to copy from; the *destination* must be a
        // different slot so the encoder sees a new pointer.
        let dst_slot = self.next_slot;
        // Borrow the source texture out of the pool. Clone first (cheap
        // refcount bump) so we don't have aliasing issues if dst_slot ==
        // src_slot (which only happens if POOL_SIZE == 1 — guarded for).
        let src_tex = self
            .pool[src_slot]
            .clone()
            .ok_or_else(|| anyhow!("last_slot points at an unallocated pool entry"))?;
        let mut src_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { src_tex.GetDesc(&mut src_desc) };

        let dst_tex = self.ensure_slot(dst_slot, &src_desc)?;
        unsafe {
            self.context.CopyResource(&dst_tex, &src_tex);
            self.context.Flush();
        }
        // Repaint the cursor only if it actually moved or changed shape.
        // The source slot (last_slot) already has a cursor composited at
        // last_cursor_pos with last_cursor_handle — the CopyResource
        // carries that pixel data forward. If neither has changed, the
        // copy is already correct and we save the entire GDI roundtrip.
        if self.include_cursor {
            match read_cursor_state() {
                Some((pos, handle))
                    if pos == self.last_cursor_pos
                        && handle == self.last_cursor_handle => {
                    // Cursor unchanged — skip the GDI work entirely. This
                    // is the common idle path; cuts steady-state cursor
                    // GDI work to near-zero when nothing's happening.
                }
                Some((pos, handle)) => {
                    let _t = clipdip_profile::start("capture.cursor");
                    draw_cursor(&dst_tex, self.output_origin);
                    self.last_cursor_pos = pos;
                    self.last_cursor_handle = handle;
                }
                None => {
                    // Cursor went away (hidden or off-screen). The copy
                    // still has the stale cursor — could repaint with an
                    // empty draw, but in practice the next real frame
                    // refreshes it. Leave it.
                }
            }
        }

        self.last_slot = Some(dst_slot);
        self.next_slot = (dst_slot + 1) % POOL_SIZE;

        Ok(Some(CapturedFrame {
            texture: dst_tex,
            pts_100ns: self.last_pts,
            was_repeat: true,
        }))
    }

    /// Allocate (if needed) the texture in `pool[slot]` matching the given
    /// source descriptor, and return a refcounted clone of it.
    ///
    /// The DXGI source may carry `D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX`
    /// and other sharing flags we don't want on a private copy — we
    /// explicitly clear `MiscFlags`. Bind flags include both
    /// `RENDER_TARGET` (so the GPU can write via `CopyResource`) and
    /// `SHADER_RESOURCE` (so NVENC can sample). `ArraySize=1` /
    /// `MipLevels=1` keep NVENC happy.
    fn ensure_slot(
        &mut self,
        slot: usize,
        src_desc: &D3D11_TEXTURE2D_DESC,
    ) -> Result<ID3D11Texture2D> {
        if let Some(tex) = &self.pool[slot] {
            return Ok(tex.clone());
        }
        let mut dst_desc = *src_desc;
        dst_desc.Usage = D3D11_USAGE_DEFAULT;
        dst_desc.BindFlags = (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32;
        dst_desc.CPUAccessFlags = 0;
        // Clear any sharing flags from the DXGI source, but ADD
        // GDI_COMPATIBLE so we can grab an HDC and paint the mouse cursor
        // via `DrawIconEx` (DXGI Desktop Duplication never includes the
        // cursor — it's delivered out-of-band). Requires the texture format
        // be `DXGI_FORMAT_B8G8R8A8_UNORM[_SRGB]`, which is what Desktop
        // Duplication produces.
        dst_desc.MiscFlags = D3D11_RESOURCE_MISC_GDI_COMPATIBLE.0 as u32;
        dst_desc.ArraySize = 1;
        dst_desc.MipLevels = 1;
        dst_desc.SampleDesc = DXGI_SAMPLE_DESC { Count: 1, Quality: 0 };

        let mut dst = None;
        unsafe {
            self.device
                .CreateTexture2D(&dst_desc, None, Some(&mut dst))?;
        }
        let dst = dst.ok_or_else(|| anyhow!("CreateTexture2D returned null"))?;
        self.pool[slot] = Some(dst.clone());
        Ok(dst)
    }
}

/// Composite the current OS mouse cursor onto `target` via GDI.
///
/// DXGI Desktop Duplication delivers the cursor out-of-band; the captured
/// texture has no cursor in it. The fast path on Windows is `IDXGISurface1::GetDC`
/// on a `GDI_COMPATIBLE` texture and `DrawIconEx`, which avoids writing an
/// HLSL shader pipeline just for this.
///
/// Errors from any individual step are logged at WARN and otherwise
/// swallowed — a missing cursor frame is annoying, not fatal.
fn draw_cursor(target: &ID3D11Texture2D, output_origin: (i32, i32)) {
    unsafe {
        let mut ci = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut ci).is_err() {
            return;
        }
        if ci.flags.0 & CURSOR_SHOWING.0 == 0 || ci.hCursor.is_invalid() {
            return;
        }

        // Translate from virtual-desktop coords to texture-local coords.
        let mut x = ci.ptScreenPos.x - output_origin.0;
        let mut y = ci.ptScreenPos.y - output_origin.1;

        // `ptScreenPos` is the cursor hotspot. `DrawIconEx` draws from
        // top-left, so subtract the hotspot offset.
        let mut icon_info = ICONINFO::default();
        if GetIconInfo(ci.hCursor, &mut icon_info).is_ok() {
            x -= icon_info.xHotspot as i32;
            y -= icon_info.yHotspot as i32;
            // `GetIconInfo` returns owned bitmap handles — release them.
            if !icon_info.hbmMask.is_invalid() {
                let _ = DeleteObject(icon_info.hbmMask);
            }
            if !icon_info.hbmColor.is_invalid() {
                let _ = DeleteObject(icon_info.hbmColor);
            }
        }

        let surface: IDXGISurface1 = match target.cast() {
            Ok(s) => s,
            Err(_) => {
                warn!("cursor composite: target is not an IDXGISurface1");
                return;
            }
        };

        let hdc = match surface.GetDC(TRUE) {
            Ok(h) => h,
            Err(e) => {
                warn!(error = ?e, "cursor composite: GetDC failed");
                return;
            }
        };

        // HCURSOR is an alias for HICON; DrawIconEx accepts either.
        let hicon = windows::Win32::UI::WindowsAndMessaging::HICON(ci.hCursor.0);
        let _ = DrawIconEx(hdc, x, y, hicon, 0, 0, 0, None, DI_NORMAL);

        let _ = surface.ReleaseDC(None);
    }
}

/// Metadata for one DXGI output (monitor) attached to the default adapter.
#[derive(Clone, Debug)]
pub struct OutputInfo {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    pub device_name: String,
}

/// Enumerate every DXGI output on the default adapter. Useful for letting
/// users pick the right monitor for `video.output_index` in config.
pub fn list_outputs() -> Result<Vec<OutputInfo>> {
    let (device, _context) = create_d3d11_device()?;
    let mut out = Vec::new();
    unsafe {
        let dxgi_device: IDXGIDevice = device.cast()?;
        let adapter: IDXGIAdapter1 = dxgi_device.GetParent()?;
        let mut i = 0u32;
        loop {
            match adapter.EnumOutputs(i) {
                Ok(output) => {
                    let output1: IDXGIOutput1 = output.cast()?;
                    let desc = output1.GetDesc()?;
                    let device_name = String::from_utf16_lossy(&desc.DeviceName)
                        .trim_end_matches('\0')
                        .to_string();
                    out.push(OutputInfo {
                        index: i,
                        width: (desc.DesktopCoordinates.right - desc.DesktopCoordinates.left)
                            as u32,
                        height: (desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top)
                            as u32,
                        device_name,
                    });
                    i += 1;
                }
                // Out-of-range index → done enumerating.
                Err(_) => break,
            }
        }
    }
    Ok(out)
}

fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext)> {
    unsafe {
        let mut device = None;
        let mut context = None;
        let feature_levels = [D3D_FEATURE_LEVEL_11_0];
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&feature_levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
        let device = device.ok_or_else(|| anyhow!("D3D11CreateDevice returned null device"))?;
        let context = context.ok_or_else(|| anyhow!("D3D11CreateDevice returned null context"))?;
        Ok((device, context))
    }
}

