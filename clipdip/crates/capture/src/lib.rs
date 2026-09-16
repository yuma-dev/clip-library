//! DXGI Desktop Duplication capture. Copies frames into a private `ID3D11Texture2D`
//! so the source can be released immediately (otherwise the desktop compositor stalls).

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
    /// Try WGC first, fall back to DXGI if it can't initialize. Default
    /// since WGC sees fullscreen-exclusive/independent-flip/MPO content DXGI misses.
    Auto,
    /// Windows.Graphics.Capture only (error if unavailable).
    Wgc,
    /// DXGI only; escape hatch. Shows desktop or a frozen frame for
    /// independent-flip/MPO/exclusive-fullscreen content.
    Dxgi,
}

/// Unified capturer over both backends; identical [`CapturedFrame`] semantics
/// keeps the pipeline backend-agnostic.
pub enum Capturer {
    Wgc(wgc::WgcCapturer),
    Dxgi(DesktopDuplicator),
}

impl Capturer {
    /// `device` must be the one driving NVENC; used at pipeline start and when
    /// rebuilding capture mid-session while the encoder keeps running on it.
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
                        // root cause of "my clip is just my desktop" reports; gated to
                        // once per 15 min since rebuild loops retry this path
                        if let clipdip_diagnostics::Gate::Send { suppressed } =
                            clipdip_diagnostics::gate(
                                "wgc_init_failed_fell_back_to_dxgi",
                                std::time::Duration::from_secs(900),
                            )
                        {
                            clipdip_diagnostics::report_capture_failure_with(
                                "wgc_init_failed_fell_back_to_dxgi",
                                clipdip_diagnostics::Severity::Warning,
                                format!("WGC init failed, fell back to DXGI: {e:#}"),
                                serde_json::json!({
                                    "output_index": output_index,
                                    "occurrences": suppressed + 1,
                                }),
                            );
                        }
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
    /// Private copy of the captured backbuffer, owned by the caller.
    pub texture: ID3D11Texture2D,
    /// QPC-based, matches DXGI_OUTDUPL_FRAME_INFO::LastPresentTime.
    pub pts_100ns: i64,
    /// True if no new image arrived in the acquire timeout and this re-emits
    /// the last texture to keep the encoder fed at CFR.
    pub was_repeat: bool,
}

pub struct DesktopDuplicator {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    dup_desc: DXGI_OUTDUPL_DESC,
    /// Rotated so NVENC never sees the same pointer twice in a row (rejects
    /// back-to-back resubmission with INVALID_PARAM). 4 matches OBS's lower bound.
    pool: [Option<ID3D11Texture2D>; POOL_SIZE],
    /// Next slot to render into (mod POOL_SIZE).
    next_slot: usize,
    /// Most recent successful capture slot; source for a CFR repeat frame on timeout.
    last_slot: Option<usize>,
    /// PTS of the last successful capture, carried forward on repeat frames.
    last_pts: i64,
    /// QueryPerformanceFrequency, cached once; normalizes QPC to 100ns ticks
    /// to match WASAPI's units. Often 10 MHz but don't rely on that.
    qpc_freq: i64,
    /// Output's top-left in virtual-desktop space; subtract from `GetCursorInfo`
    /// coords to get texture-local ones.
    output_origin: (i32, i32),
    /// Composite the OS cursor onto each frame; DXGI never includes it natively.
    include_cursor: bool,
    /// Last composited cursor pos; lets `emit_repeat` skip the GDI redraw
    /// (biggest steady-state 3D-engine cost) when nothing moved.
    last_cursor_pos: (i32, i32),
    /// Last `HCURSOR`, as an integer since `HCURSOR` is `!Send`.
    last_cursor_handle: isize,
}

/// Current cursor's screen position and handle, `None` if not showing.
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
    /// `device` must also drive NVENC; sharing it avoids the cross-context
    /// copy that costs ~1.5% game FPS (obs#6647).
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

    /// Fresh D3D11 device on the default adapter, duplicator on `output_index`.
    pub fn with_default_device(
        output_index: u32,
    ) -> Result<(Self, ID3D11Device, ID3D11DeviceContext)> {
        let (device, context) = create_d3d11_device()?;
        let dup = Self::new(device.clone(), context.clone(), output_index)?;
        Ok((dup, device, context))
    }

    /// Off avoids the per-frame GDI cost (`GetDC` + `DrawIconEx`) for callers
    /// that don't want a cursor.
    pub fn set_include_cursor(&mut self, include: bool) {
        self.include_cursor = include;
    }

    pub fn width(&self) -> u32 {
        self.dup_desc.ModeDesc.Width
    }

    pub fn height(&self) -> u32 {
        self.dup_desc.ModeDesc.Height
    }

    /// QPC ticks to 100ns; split arithmetic avoids i64 overflow on long uptimes.
    fn qpc_to_100ns(&self, ticks: i64) -> i64 {
        let secs = ticks / self.qpc_freq;
        let rem = ticks % self.qpc_freq;
        secs * 10_000_000 + rem * 10_000_000 / self.qpc_freq
    }

    /// Blocks up to `timeout_ms`. On DXGI timeout, re-emits the last texture
    /// (`was_repeat = true`) for CFR; `Ok(None)` if nothing captured yet.
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

            let slot_idx = self.next_slot;
            let dst = self.ensure_slot(slot_idx, &src_desc)?;
            let t_copy = clipdip_profile::start("capture.copy_flush");
            self.context.CopyResource(&dst, &source);
            // must submit before NVENC samples it, else black frames; a QUERY_EVENT
            // fence showed no GPU% improvement (encode dominates, not Flush)
            self.context.Flush();
            drop(t_copy);

            // release back to DXGI immediately so the compositor can keep producing
            self.duplication.ReleaseFrame().ok();

            // DXGI never includes the cursor; paint it ourselves unless opted out
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

    /// Re-emits the last frame on `DXGI_ERROR_WAIT_TIMEOUT`; `Ok(None)` if
    /// nothing captured yet. Must always emit or the muxer's synthetic CFR
    /// timestamps (`-framerate`) fast-forward the output.
    fn emit_repeat(&mut self) -> Result<Option<CapturedFrame>> {
        let src_slot = match self.last_slot {
            Some(s) => s,
            None => return Ok(None),
        };
        // dest must be a different slot so the encoder sees a new pointer
        let dst_slot = self.next_slot;
        // cheap refcount clone avoids aliasing if dst_slot == src_slot (POOL_SIZE == 1)
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
        // repaint only if cursor moved/changed; CopyResource already carried the
        // prior composited cursor forward otherwise
        if self.include_cursor {
            match read_cursor_state() {
                Some((pos, handle))
                    if pos == self.last_cursor_pos
                        && handle == self.last_cursor_handle => {
                    // unchanged, skip GDI entirely
                }
                Some((pos, handle)) => {
                    let _t = clipdip_profile::start("capture.cursor");
                    draw_cursor(&dst_tex, self.output_origin);
                    self.last_cursor_pos = pos;
                    self.last_cursor_handle = handle;
                }
                None => {
                    // cursor gone; stale copy is fine, next real frame refreshes it
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

    /// Lazily allocates `pool[slot]`, returns a refcounted clone. Sharing flags
    /// from the DXGI source are cleared; bind flags are RENDER_TARGET (CopyResource) +
    /// SHADER_RESOURCE (NVENC).
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
        // GDI_COMPATIBLE lets us grab an HDC for DrawIconEx cursor painting;
        // needs DXGI_FORMAT_B8G8R8A8_UNORM[_SRGB], which Desktop Duplication produces
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

/// Composites the OS cursor onto `target` via GDI (`GetDC` + `DrawIconEx`), since
/// DXGI delivers it out-of-band. Errors just warn, a missing cursor isn't fatal.
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

        // virtual-desktop coords to texture-local coords
        let mut x = ci.ptScreenPos.x - output_origin.0;
        let mut y = ci.ptScreenPos.y - output_origin.1;

        // DrawIconEx draws from top-left; subtract the hotspot offset
        let mut icon_info = ICONINFO::default();
        if GetIconInfo(ci.hCursor, &mut icon_info).is_ok() {
            x -= icon_info.xHotspot as i32;
            y -= icon_info.yHotspot as i32;
            // GetIconInfo returns owned handles, release them
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

        // HCURSOR aliases HICON; DrawIconEx accepts either
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

/// Every DXGI output on the default adapter, for picking `video.output_index`.
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
                // out-of-range index
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

