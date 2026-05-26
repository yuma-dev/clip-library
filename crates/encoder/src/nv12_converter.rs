//! GPU shader BGRA→NV12 color-space converter.
//!
//! D3D11 `CopyResource` can only copy between format-compatible textures
//! (same family — e.g. typeless ↔ typed, or BGRA8 ↔ BGRA8_SRGB). It does
//! NOT do color-space conversion between unrelated formats, so a direct
//! `CopyResource(BGRA → NV12)` produces garbage (the chroma plane gets
//! uninitialized memory, which decodes as constant green).
//!
//! This module mirrors OBS's `format_conversion.effect`: render the
//! source BGRA texture into the two planes of an NV12 destination via
//! two pixel-shader passes — one writes the Y plane (full resolution,
//! R8 view of NV12), the other writes the UV plane (half resolution,
//! R8G8 view).
//!
//! Color matrix: BT.709, **limited range** (Y in 16..235, chroma in
//! 16..240). Limited range is what H.264 / MP4 players assume by
//! default — outputting full range here without setting
//! `video_full_range_flag = 1` in the encoder's VUI would make the
//! player expand 0..255 thinking it's 16..235, crushing blacks and
//! blowing out whites. We could go full-range + signal it via NVENC's
//! `videoFullRangeFlag`, but limited-range here matches the conventional
//! container assumption and what every player handles correctly out of
//! the box. Chosen for SDR game capture.

use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use windows::core::{Interface, PCSTR};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::{
    ID3DBlob, D3D11_SRV_DIMENSION_TEXTURE2D, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST,
};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader, ID3D11RenderTargetView,
    ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader,
    D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_RENDER_TARGET_VIEW_DESC,
    D3D11_RENDER_TARGET_VIEW_DESC_0, D3D11_RTV_DIMENSION_TEXTURE2D, D3D11_SAMPLER_DESC,
    D3D11_SHADER_RESOURCE_VIEW_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC_0, D3D11_TEX2D_RTV,
    D3D11_TEX2D_SRV, D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8_UNORM, DXGI_FORMAT_R8_UNORM,
};

/// BT.709 limited-range BGRA→YUV conversion. From the BT.709 standard:
///   Y'  = 16  + 219 * ( 0.2126 R + 0.7152 G + 0.0722 B)
///   Cb  = 128 + 224 * (-0.1146 R - 0.3854 G + 0.5    B)
///   Cr  = 128 + 224 * ( 0.5    R - 0.4542 G - 0.0458 B)
/// In normalized [0,1] shader output:
///   Y_norm  = 16/255  + (219/255) * matrix_Y(rgb)
///   UV_norm = 128/255 + (224/255) * matrix_UV(rgb)
const SHADER_SRC: &str = r#"
Texture2D Src : register(t0);
SamplerState SS : register(s0);

static const float Y_OFFSET  = 16.0 / 255.0;
static const float Y_SCALE   = 219.0 / 255.0;
static const float UV_OFFSET = 128.0 / 255.0;
static const float UV_SCALE  = 224.0 / 255.0;

struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

// Fullscreen triangle from SV_VertexID — no vertex buffer needed.
VSOut VSMain(uint vid : SV_VertexID) {
    VSOut o;
    o.pos = float4(
        (vid == 1) ?  3.0 : -1.0,
        (vid == 2) ? -3.0 :  1.0,
        0, 1
    );
    o.uv = float2(
        (vid == 1) ? 2.0 : 0.0,
        (vid == 2) ? 2.0 : 0.0
    );
    return o;
}

float PSY(VSOut i) : SV_TARGET {
    float3 rgb = Src.Sample(SS, i.uv).rgb;
    float y = dot(rgb, float3(0.2126, 0.7152, 0.0722));
    return Y_OFFSET + Y_SCALE * y;
}

float2 PSUV(VSOut i) : SV_TARGET {
    float3 rgb = Src.Sample(SS, i.uv).rgb;
    float u = dot(rgb, float3(-0.1146, -0.3854,  0.5000));
    float v = dot(rgb, float3( 0.5000, -0.4542, -0.0458));
    return float2(UV_OFFSET + UV_SCALE * u, UV_OFFSET + UV_SCALE * v);
}
"#;

/// Renders a BGRA source texture into the Y and UV planes of an NV12
/// destination. Shaders + sampler are owned here; per-texture RTVs and
/// SRVs are cached internally.
pub struct Nv12Converter {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    vs: ID3D11VertexShader,
    ps_y: ID3D11PixelShader,
    ps_uv: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    width: u32,
    height: u32,
    /// Cache of (Y RTV, UV RTV) per NV12 destination texture, keyed by
    /// the texture's raw pointer. The encoder reuses a small pool, so
    /// this will typically have 4 entries.
    rtv_cache: HashMap<usize, (ID3D11RenderTargetView, ID3D11RenderTargetView)>,
    /// Cache of SRVs per source BGRA texture, also keyed by raw pointer.
    /// The capture-side pool has 4 entries; this cache mirrors that.
    srv_cache: HashMap<usize, ID3D11ShaderResourceView>,
}

impl Nv12Converter {
    pub fn new(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        let vs_blob = compile(SHADER_SRC, "VSMain", "vs_5_0")?;
        let ps_y_blob = compile(SHADER_SRC, "PSY", "ps_5_0")?;
        let ps_uv_blob = compile(SHADER_SRC, "PSUV", "ps_5_0")?;

        let vs = unsafe {
            let bytes = blob_bytes(&vs_blob);
            let mut out = None;
            device.CreateVertexShader(bytes, None, Some(&mut out))?;
            out.ok_or_else(|| anyhow!("CreateVertexShader returned null"))?
        };
        let ps_y = unsafe {
            let bytes = blob_bytes(&ps_y_blob);
            let mut out = None;
            device.CreatePixelShader(bytes, None, Some(&mut out))?;
            out.ok_or_else(|| anyhow!("CreatePixelShader(Y) returned null"))?
        };
        let ps_uv = unsafe {
            let bytes = blob_bytes(&ps_uv_blob);
            let mut out = None;
            device.CreatePixelShader(bytes, None, Some(&mut out))?;
            out.ok_or_else(|| anyhow!("CreatePixelShader(UV) returned null"))?
        };

        let sampler_desc = D3D11_SAMPLER_DESC {
            // Linear so the half-resolution UV pass downsamples cleanly.
            Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
            AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
            AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
            ..Default::default()
        };
        let sampler = unsafe {
            let mut out = None;
            device.CreateSamplerState(&sampler_desc, Some(&mut out))?;
            out.ok_or_else(|| anyhow!("CreateSamplerState returned null"))?
        };

        Ok(Self {
            device,
            context,
            vs,
            ps_y,
            ps_uv,
            sampler,
            width,
            height,
            rtv_cache: HashMap::new(),
            srv_cache: HashMap::new(),
        })
    }

    /// Render `src` (BGRA) into `dst` (NV12). Both textures must be on
    /// the same device as this converter and sized `width × height`.
    pub fn convert(&mut self, src: &ID3D11Texture2D, dst: &ID3D11Texture2D) -> Result<()> {
        let src_key = src.as_raw() as usize;
        let srv = if let Some(s) = self.srv_cache.get(&src_key) {
            s.clone()
        } else {
            let s = create_srv(&self.device, src)?;
            self.srv_cache.insert(src_key, s.clone());
            s
        };

        let dst_key = dst.as_raw() as usize;
        let (y_rtv, uv_rtv) = if let Some(p) = self.rtv_cache.get(&dst_key) {
            p.clone()
        } else {
            let y = create_plane_rtv(&self.device, dst, DXGI_FORMAT_R8_UNORM)?;
            let uv = create_plane_rtv(&self.device, dst, DXGI_FORMAT_R8G8_UNORM)?;
            self.rtv_cache.insert(dst_key, (y.clone(), uv.clone()));
            (y, uv)
        };

        unsafe {
            self.context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.context.IASetInputLayout(None);
            self.context.VSSetShader(&self.vs, None);
            let srvs = [Some(srv)];
            self.context.PSSetShaderResources(0, Some(&srvs));
            let samplers = [Some(self.sampler.clone())];
            self.context.PSSetSamplers(0, Some(&samplers));
            self.context.RSSetState(None);
            self.context.OMSetBlendState(None, None, 0xFFFFFFFF);
            self.context.OMSetDepthStencilState(None, 0);

            // Pass 1 — Y plane, full resolution.
            let y_vp = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: self.width as f32,
                Height: self.height as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            self.context.RSSetViewports(Some(&[y_vp]));
            let y_rtvs = [Some(y_rtv.clone())];
            self.context.OMSetRenderTargets(Some(&y_rtvs), None);
            self.context.PSSetShader(&self.ps_y, None);
            self.context.Draw(3, 0);

            // Pass 2 — UV plane, half resolution.
            let uv_vp = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: (self.width / 2) as f32,
                Height: (self.height / 2) as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            self.context.RSSetViewports(Some(&[uv_vp]));
            let uv_rtvs = [Some(uv_rtv.clone())];
            self.context.OMSetRenderTargets(Some(&uv_rtvs), None);
            self.context.PSSetShader(&self.ps_uv, None);
            self.context.Draw(3, 0);

            // Unbind so NVENC and the duplicator can use these textures.
            self.context.OMSetRenderTargets(None, None);
            let null_srvs: [Option<ID3D11ShaderResourceView>; 1] = [None];
            self.context.PSSetShaderResources(0, Some(&null_srvs));
        }
        Ok(())
    }
}

// ---- helpers --------------------------------------------------------------

fn compile(src: &str, entry: &str, target: &str) -> Result<ID3DBlob> {
    let entry_c = std::ffi::CString::new(entry).unwrap();
    let target_c = std::ffi::CString::new(target).unwrap();
    let mut code = None;
    let mut errors: Option<ID3DBlob> = None;
    let hr = unsafe {
        D3DCompile(
            src.as_ptr() as *const _,
            src.len(),
            PCSTR::null(),
            None,
            None,
            PCSTR(entry_c.as_ptr() as _),
            PCSTR(target_c.as_ptr() as _),
            D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0,
            &mut code,
            Some(&mut errors),
        )
    };
    if hr.is_err() {
        let msg = if let Some(e) = errors {
            unsafe {
                let p = e.GetBufferPointer() as *const u8;
                let l = e.GetBufferSize();
                std::str::from_utf8(std::slice::from_raw_parts(p, l))
                    .unwrap_or("<non-utf8>")
                    .to_string()
            }
        } else {
            String::new()
        };
        bail!("D3DCompile {entry}/{target} failed ({:?}): {msg}", hr);
    }
    code.ok_or_else(|| anyhow!("D3DCompile returned null blob"))
}

unsafe fn blob_bytes(blob: &ID3DBlob) -> &[u8] {
    let p = blob.GetBufferPointer() as *const u8;
    let l = blob.GetBufferSize();
    std::slice::from_raw_parts(p, l)
}

fn create_srv(device: &ID3D11Device, tex: &ID3D11Texture2D) -> Result<ID3D11ShaderResourceView> {
    let desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        ViewDimension: D3D11_SRV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_SRV {
                MostDetailedMip: 0,
                MipLevels: 1,
            },
        },
    };
    let mut out = None;
    unsafe { device.CreateShaderResourceView(tex, Some(&desc), Some(&mut out))? };
    out.ok_or_else(|| anyhow!("CreateShaderResourceView returned null"))
}

fn create_plane_rtv(
    device: &ID3D11Device,
    tex: &ID3D11Texture2D,
    format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
) -> Result<ID3D11RenderTargetView> {
    let desc = D3D11_RENDER_TARGET_VIEW_DESC {
        Format: format,
        ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_RENDER_TARGET_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_RTV { MipSlice: 0 },
        },
    };
    let mut out = None;
    unsafe { device.CreateRenderTargetView(tex, Some(&desc), Some(&mut out))? };
    out.ok_or_else(|| anyhow!("CreateRenderTargetView returned null"))
}
