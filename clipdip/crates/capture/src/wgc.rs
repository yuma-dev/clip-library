//! Windows.Graphics.Capture monitor capture. Unlike DXGI Desktop Duplication (which
//! duplicates DWM composition and misses independent-flip/MPO/exclusive-fullscreen
//! content), WGC sees the final composed image, fullscreen games included; same
//! API OBS and Game Bar use. Frames copy into a private texture ring like
//! [`crate::DesktopDuplicator`] so NVENC never sees the same pointer twice;
//! `was_repeat = true` on repeats to keep a CFR stream.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use tracing::{info, warn};
use windows::core::Interface;
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BIND_RENDER_TARGET,
    D3D11_BIND_SHADER_RESOURCE, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::{IDXGIAdapter1, IDXGIDevice};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use crate::CapturedFrame;

const POOL_SIZE: usize = 4;
/// WGC frame pool depth; 2 is the minimum since we drain to newest every acquire.
const WGC_BUFFERS: i32 = 2;

pub struct WgcCapturer {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    // dropping stops delivery
    frame_pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    _item: GraphicsCaptureItem,
    /// Set from the item's `Closed` event; once set, `acquire_frame` errors
    /// so the caller can rebuild.
    closed: Arc<AtomicBool>,
    width: u32,
    height: u32,
    /// NVENC rejects back-to-back submissions of the same input pointer.
    pool: [Option<ID3D11Texture2D>; POOL_SIZE],
    next_slot: usize,
    last_slot: Option<usize>,
    last_pts: i64,
}

impl WgcCapturer {
    /// `device` should be the one driving NVENC (avoids cross-device copies).
    /// `output_index` selects the DXGI output on its adapter.
    pub fn new(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        output_index: u32,
        include_cursor: bool,
    ) -> Result<Self> {
        unsafe {
            // WinRT activation needs the thread initialized; RPC_E_CHANGED_MODE is fine here
            let _ = RoInitialize(RO_INIT_MULTITHREADED);

            if !GraphicsCaptureSession::IsSupported().unwrap_or(false) {
                return Err(anyhow!(
                    "Windows.Graphics.Capture not supported on this OS build"
                ));
            }

            // HMONITOR for the requested output
            let dxgi_device: IDXGIDevice = device.cast()?;
            let adapter: IDXGIAdapter1 = dxgi_device.GetParent()?;
            let output = adapter
                .EnumOutputs(output_index)
                .with_context(|| format!("no DXGI output at index {output_index}"))?;
            let out_desc = output.GetDesc()?;
            let hmonitor = out_desc.Monitor;

            let interop =
                windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
            let item: GraphicsCaptureItem = interop
                .CreateForMonitor(hmonitor)
                .context("GraphicsCaptureItem::CreateForMonitor failed")?;

            let winrt_device: IDirect3DDevice = {
                let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)?;
                inspectable.cast()?
            };

            let size = item.Size()?;
            let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                &winrt_device,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                WGC_BUFFERS,
                size,
            )
            .context("Direct3D11CaptureFramePool::CreateFreeThreaded failed")?;

            let session = frame_pool
                .CreateCaptureSession(&item)
                .context("CreateCaptureSession failed")?;

            // cursor composited natively, no GDI pass needed
            if let Err(e) = session.SetIsCursorCaptureEnabled(include_cursor) {
                warn!(error = ?e, "WGC: SetIsCursorCaptureEnabled failed (older OS?)");
            }
            // best-effort: hide the yellow capture border (Win11+)
            if let Err(e) = session.SetIsBorderRequired(false) {
                info!(error = ?e, "WGC: capture border can't be hidden on this OS");
            }

            let closed = Arc::new(AtomicBool::new(false));
            {
                let closed = Arc::clone(&closed);
                item.Closed(&TypedEventHandler::new(move |_, _| {
                    closed.store(true, Ordering::Relaxed);
                    Ok(())
                }))?;
            }

            session.StartCapture().context("StartCapture failed")?;

            Ok(Self {
                device,
                context,
                frame_pool,
                session,
                _item: item,
                closed,
                width: size.Width.max(0) as u32,
                height: size.Height.max(0) as u32,
                pool: Default::default(),
                next_slot: 0,
                last_slot: None,
                last_pts: 0,
            })
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// Non-blocking; `_timeout_ms` is only for parity with the DXGI path.
    /// `Ok(None)` before the first frame, repeat frame if nothing new.
    pub fn acquire_frame(&mut self, _timeout_ms: u32) -> Result<Option<CapturedFrame>> {
        let _t = clipdip_profile::start("capture.acquire");
        if self.closed.load(Ordering::Relaxed) {
            return Err(anyhow!(
                "WGC capture item closed (monitor removed or display mode torn down)"
            ));
        }

        // drain to newest so latency never builds up
        let mut newest = None;
        while let Ok(frame) = self.frame_pool.TryGetNextFrame() {
            if let Some(prev) = newest.replace(frame) {
                let _ = prev.Close();
            }
        }

        let Some(frame) = newest else {
            return self.emit_repeat();
        };

        let result = (|| -> Result<Option<CapturedFrame>> {
            let surface = frame.Surface()?;
            let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
            let source: ID3D11Texture2D = unsafe { access.GetInterface()? };

            let mut src_desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { source.GetDesc(&mut src_desc) };

            // size mismatch means display mode changed; caller must rebuild capture
            if src_desc.Width != self.width || src_desc.Height != self.height {
                return Err(anyhow!(
                    "capture size changed {}x{} -> {}x{} (display mode change)",
                    self.width,
                    self.height,
                    src_desc.Width,
                    src_desc.Height
                ));
            }

            let slot_idx = self.next_slot;
            let dst = self.ensure_slot(slot_idx, &src_desc)?;
            let t_copy = clipdip_profile::start("capture.copy_flush");
            unsafe {
                self.context.CopyResource(&dst, &source);
                // flush before NVENC samples it, avoids black frames
                self.context.Flush();
            }
            drop(t_copy);

            // TimeSpan: 100ns ticks on QPC timebase, same as WASAPI/DXGI PTS
            let pts_100ns = frame.SystemRelativeTime().map(|t| t.Duration).unwrap_or(0);

            self.last_slot = Some(slot_idx);
            self.last_pts = pts_100ns;
            self.next_slot = (slot_idx + 1) % POOL_SIZE;

            Ok(Some(CapturedFrame {
                texture: dst,
                pts_100ns,
                was_repeat: false,
            }))
        })();

        let _ = frame.Close();
        result
    }

    /// Re-emits the last image from a fresh ring slot (fresh pointer for NVENC).
    /// `Ok(None)` if nothing captured yet.
    fn emit_repeat(&mut self) -> Result<Option<CapturedFrame>> {
        let src_slot = match self.last_slot {
            Some(s) => s,
            None => return Ok(None),
        };
        let dst_slot = self.next_slot;
        let src_tex = self.pool[src_slot]
            .clone()
            .ok_or_else(|| anyhow!("last_slot points at an unallocated pool entry"))?;
        let mut src_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { src_tex.GetDesc(&mut src_desc) };

        let dst_tex = self.ensure_slot(dst_slot, &src_desc)?;
        unsafe {
            self.context.CopyResource(&dst_tex, &src_tex);
            self.context.Flush();
        }

        self.last_slot = Some(dst_slot);
        self.next_slot = (dst_slot + 1) % POOL_SIZE;

        Ok(Some(CapturedFrame {
            texture: dst_tex,
            pts_100ns: self.last_pts,
            was_repeat: true,
        }))
    }

    /// Lazily allocates the ring texture for `slot`; no GDI compat flag needed
    /// WGC composites the cursor itself.
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
        dst_desc.MiscFlags = 0;
        dst_desc.ArraySize = 1;
        dst_desc.MipLevels = 1;
        dst_desc.SampleDesc = DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        };

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

impl Drop for WgcCapturer {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.frame_pool.Close();
    }
}
