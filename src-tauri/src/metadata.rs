//! Per-clip `.gameinfo` sidecar capture.
//!
//! Snapshots the foreground window at the moment of the save hotkey
//! (HWND + PID), then — once the clip is muxed to disk — resolves the
//! window title and the owning process's exe path, optionally extracts
//! the exe icon as a PNG, and writes a small JSON sidecar next to the
//! clip:
//!
//! ```text
//! {output_dir}/
//!   foo-1700000000.mp4
//!   .clip_metadata/foo-1700000000.mp4.gameinfo   ← JSON: title + icon_file
//!   icons/Game.png                               ← PNG (deduped per-exe)
//! ```
//!
//! Lifted from the standalone Windhawk mod previously used to annotate
//! ShadowPlay clips. The bulk of the win32 work is icon extraction —
//! `ExtractIconExW` returns an HICON, which we crack open via
//! `GetIconInfo` + `GetDIBits` to read BGRA pixels, then encode with the
//! `png` crate.

use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use clipdip_core::config::MetadataConfig;
use tracing::{debug, warn};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::ExtractIconExW;
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetForegroundWindow, GetIconInfo, GetWindowThreadProcessId, IsWindow,
    SendMessageTimeoutW, HICON, ICONINFO, SMTO_ABORTIFHUNG, SMTO_NORMAL, WM_GETTEXT,
    WM_GETTEXTLENGTH,
};

/// Snapshot of the foreground window at the moment of the hotkey. We
/// capture HWND+PID synchronously up-front because by the time the clip
/// finishes muxing (~1–2 s later) the foreground may have shifted.
#[derive(Clone, Copy, Debug)]
pub struct ForegroundSnapshot {
    pub hwnd: isize,
    pub pid: u32,
}

impl ForegroundSnapshot {
    pub fn capture() -> Option<Self> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            Some(Self {
                hwnd: hwnd.0 as isize,
                pid,
            })
        }
    }
}

/// Quick name resolution for filename templating: the foreground exe's
/// stem (e.g. `VALORANT`) and — only when `need_title` is set, because
/// `WM_GETTEXT` against a hung window can block up to ~400 ms — the
/// window title.
pub fn filename_names(
    snap: Option<ForegroundSnapshot>,
    need_title: bool,
) -> (Option<String>, Option<String>) {
    let Some(snap) = snap else { return (None, None) };
    let app = exe_path_for_pid(snap.pid).and_then(|p| {
        p.file_stem().map(|s| s.to_string_lossy().to_string())
    });
    let title = if need_title {
        window_title(HWND(snap.hwnd as *mut _))
    } else {
        None
    };
    (app, title)
}

/// Output of the heavy resolution work — title query, exe lookup, icon
/// extraction. Computed up-front (in parallel with the mux) so the only
/// thing left at save-completion is a cheap JSON write keyed by the
/// clip's filename.
#[derive(Clone, Debug)]
pub struct ResolvedMetadata {
    pub title: String,
    pub exe_path: Option<PathBuf>,
    /// `{exe-stem}.png` for the gameinfo's `icon_file` field. `None`
    /// when icon capture is disabled or the icon extract failed.
    pub icon_filename: Option<String>,
    /// Encoded PNG bytes for the icon, ready to write. Kept in-memory
    /// during resolve so the actual file lands in the clip's directory
    /// at finalize time — `output_dir` may have changed between save
    /// hotkey and config reload, or the clip path's parent may simply
    /// differ from what we assumed (rename, etc.).
    pub icon_png: Option<Vec<u8>>,
    /// Set when the foreground exe matched `ignored_processes`. The
    /// final write step short-circuits on this so we don't even create
    /// the `.clip_metadata/` directory for the clip.
    pub ignored: bool,
}

/// Resolve everything we can without knowing the final clip path — the
/// expensive bits. Designed to run in parallel with `pipeline.save_clip()`
/// so the user-facing save latency isn't extended by the two 200 ms
/// `SendMessageTimeoutW` calls or the icon GDI/DIB pipeline.
pub fn resolve(snap: ForegroundSnapshot, cfg: &MetadataConfig) -> ResolvedMetadata {
    let hwnd = HWND(snap.hwnd as *mut _);
    let title = window_title(hwnd).unwrap_or_else(|| "Unknown".to_string());
    let exe_path = exe_path_for_pid(snap.pid);
    let exe_basename = exe_path.as_deref().and_then(file_name_lossy);

    if let Some(name) = exe_basename.as_deref() {
        if is_ignored(name, &cfg.ignored_processes) {
            debug!(exe = %name, "metadata: ignored process");
            return ResolvedMetadata {
                title,
                exe_path,
                icon_filename: None,
                icon_png: None,
                ignored: true,
            };
        }
    }

    let (icon_filename, icon_png) = if cfg.capture_icon {
        match (exe_path.as_deref(), exe_basename.as_deref()) {
            (Some(p), Some(name)) => {
                let stem = Path::new(name)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| name.to_string());
                let filename = format!("{stem}.png");
                match extract_icon_png(p) {
                    Ok(bytes) => (Some(filename), Some(bytes)),
                    Err(e) => {
                        warn!(exe = %p.display(), "metadata: icon extraction failed: {e:#}");
                        (Some(filename), None)
                    }
                }
            }
            _ => (None, None),
        }
    } else {
        (None, None)
    };

    ResolvedMetadata {
        title,
        exe_path,
        icon_filename,
        icon_png,
        ignored: false,
    }
}

/// Finalize step: writes `.clip_metadata/{clip}.gameinfo` and (if
/// available) `icons/{exe}.png` *next to* the saved MP4 — both
/// directories derive from `clip_path.parent()` so they follow the
/// clip's actual location, even if the user changed the output dir
/// mid-flight.
pub fn write_gameinfo(clip_path: &Path, resolved: &ResolvedMetadata) -> Result<()> {
    if resolved.ignored {
        return Ok(());
    }
    let dir = clip_path
        .parent()
        .ok_or_else(|| anyhow!("clip path has no parent"))?;

    // Icon: write only if we have bytes and the file doesn't already
    // exist (deduped per-exe across clips in the same folder).
    if let (Some(name), Some(bytes)) = (resolved.icon_filename.as_deref(), resolved.icon_png.as_deref()) {
        let icons_dir = dir.join("icons");
        fs::create_dir_all(&icons_dir).context("create icons directory")?;
        let icon_path = icons_dir.join(name);
        if !icon_path.exists() {
            fs::write(&icon_path, bytes)
                .with_context(|| format!("write {}", icon_path.display()))?;
        }
    }

    let meta_dir = dir.join(".clip_metadata");
    fs::create_dir_all(&meta_dir).context("create .clip_metadata directory")?;
    let clip_filename = clip_path
        .file_name()
        .ok_or_else(|| anyhow!("clip path has no filename"))?;
    let mut out_path = meta_dir.join(clip_filename);
    let mut name_os = out_path.file_name().unwrap_or_default().to_os_string();
    name_os.push(".gameinfo");
    out_path.set_file_name(name_os);

    let json = serde_json::json!({
        "window_title": resolved.title,
        "icon_file": resolved.icon_filename,
        "exe_path": resolved.exe_path.as_ref().map(|p| p.to_string_lossy().to_string()),
    });
    let body = serde_json::to_string_pretty(&json).context("serialize metadata JSON")?;
    let mut f = fs::File::create(&out_path)
        .with_context(|| format!("create {}", out_path.display()))?;
    f.write_all(body.as_bytes())?;
    Ok(())
}

fn is_ignored(exe_name: &str, ignored: &[String]) -> bool {
    let needle = exe_name.to_ascii_lowercase();
    ignored.iter().any(|i| i.to_ascii_lowercase() == needle)
}

fn file_name_lossy(p: &Path) -> Option<String> {
    p.file_name().map(|s| s.to_string_lossy().to_string())
}

fn window_title(hwnd: HWND) -> Option<String> {
    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return None;
        }
        // SendMessageTimeoutW so an unresponsive window can't block us.
        let mut len_result: usize = 0;
        let r = SendMessageTimeoutW(
            hwnd,
            WM_GETTEXTLENGTH,
            WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_NORMAL,
            200,
            Some(&mut len_result as *mut _ as *mut _),
        );
        if r.0 == 0 || len_result == 0 {
            return None;
        }
        let len = len_result;
        let mut buf: Vec<u16> = vec![0u16; len + 1];
        let mut text_result: usize = 0;
        let r = SendMessageTimeoutW(
            hwnd,
            WM_GETTEXT,
            WPARAM(len + 1),
            LPARAM(buf.as_mut_ptr() as isize),
            SMTO_ABORTIFHUNG | SMTO_NORMAL,
            200,
            Some(&mut text_result as *mut _ as *mut _),
        );
        if r.0 == 0 {
            return None;
        }
        let read = text_result.min(len);
        Some(OsString::from_wide(&buf[..read]).to_string_lossy().into_owned())
    }
}

fn exe_path_for_pid(pid: u32) -> Option<PathBuf> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf: Vec<u16> = vec![0u16; 1024];
        let mut size: u32 = buf.len() as u32;
        let ok =
            QueryFullProcessImageNameW(handle, PROCESS_NAME_FORMAT(0), windows::core::PWSTR(buf.as_mut_ptr()), &mut size)
                .is_ok();
        let _ = windows::Win32::Foundation::CloseHandle(handle);
        if !ok {
            return None;
        }
        let slice = &buf[..size as usize];
        Some(PathBuf::from(OsString::from_wide(slice)))
    }
}

/// Extract the large icon from `exe_path` and encode it as a PNG byte
/// buffer. Uses `ExtractIconExW` to get an HICON, then walks the icon's
/// color bitmap with `GetDIBits` to produce a flat BGRA buffer which we
/// swizzle to RGBA and feed to the `png` encoder. The caller writes the
/// bytes wherever it wants (we don't know the clip's parent dir here).
fn extract_icon_png(exe_path: &Path) -> Result<Vec<u8>> {
    let wide: Vec<u16> = exe_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut hicon: HICON = HICON::default();
    let count = unsafe {
        ExtractIconExW(
            PCWSTR(wide.as_ptr()),
            0,
            Some(&mut hicon),
            None,
            1,
        )
    };
    if count == 0 || hicon.is_invalid() {
        return Err(anyhow!("ExtractIconExW returned no icon"));
    }

    let res = icon_to_png_bytes(hicon);
    unsafe { let _ = DestroyIcon(hicon); }
    res
}

fn icon_to_png_bytes(hicon: HICON) -> Result<Vec<u8>> {
    unsafe {
        let mut info: ICONINFO = std::mem::zeroed();
        GetIconInfo(hicon, &mut info).ok().context("GetIconInfo")?;

        // hbmColor is the RGBA-ish bitmap; hbmMask is the AND-mask we
        // don't need (the color bitmap of a modern icon is already
        // 32-bit with proper alpha). Make sure we delete both.
        struct BitmapGuard(HBITMAP);
        impl Drop for BitmapGuard {
            fn drop(&mut self) {
                unsafe {
                    if !self.0.is_invalid() {
                        let _ = DeleteObject(self.0);
                    }
                }
            }
        }
        let _color = BitmapGuard(info.hbmColor);
        let _mask = BitmapGuard(info.hbmMask);

        let mut bm: BITMAP = std::mem::zeroed();
        let n = GetObjectW(
            info.hbmColor,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        );
        if n == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
            return Err(anyhow!("GetObjectW(BITMAP) failed"));
        }
        let width = bm.bmWidth;
        let height = bm.bmHeight;

        let hdc: HDC = CreateCompatibleDC(None);
        if hdc.is_invalid() {
            return Err(anyhow!("CreateCompatibleDC failed"));
        }
        struct DcGuard(HDC);
        impl Drop for DcGuard {
            fn drop(&mut self) {
                unsafe { let _ = DeleteDC(self.0); }
            }
        }
        let _dc = DcGuard(hdc);

        let mut header = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader = header;

        let stride = (width as usize) * 4;
        let mut pixels = vec![0u8; stride * (height as usize)];

        let rows = GetDIBits(
            hdc,
            info.hbmColor,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bi,
            DIB_RGB_COLORS,
        );
        if rows == 0 {
            return Err(anyhow!("GetDIBits failed"));
        }

        // Patch up header in case the driver only filled in dimensions.
        header.biSizeImage = (stride * height as usize) as u32;

        // BGRA -> RGBA in place.
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
        }

        // Some 32-bit icons come back with alpha=0 across the board (older
        // toolchains or 24-bit-converted icons). If every pixel is fully
        // transparent, force-fill alpha to 255 so we don't write an
        // invisible PNG.
        if pixels.chunks_exact(4).all(|p| p[3] == 0) {
            for px in pixels.chunks_exact_mut(4) {
                px[3] = 0xff;
            }
        }

        let mut buf: Vec<u8> = Vec::with_capacity(pixels.len() / 2);
        {
            let mut enc = png::Encoder::new(&mut buf, width as u32, height as u32);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut writer = enc.write_header().context("png write_header")?;
            writer.write_image_data(&pixels).context("png write_image_data")?;
        }
        Ok(buf)
    }
}
