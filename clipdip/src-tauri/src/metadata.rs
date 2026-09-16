//! Per-clip `.gameinfo` sidecar: snapshots the foreground window at save time, resolves
//! title/exe/icon once muxed, writes JSON next to the clip. Icon extraction (from the
//! old Windhawk ShadowPlay mod) uses ExtractIconExW, GetIconInfo/GetDIBits, and the png crate.
//!
//! ```text
//! {output_dir}/
//!   foo-1700000000.mp4
//!   .clip_metadata/foo-1700000000.mp4.gameinfo   JSON: title + icon_file
//!   icons/Game.png                               PNG (deduped per-exe)
//! ```

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
    DestroyIcon, GetForegroundWindow, GetIconInfo, GetWindowThreadProcessId,
    IsWindow, SendMessageTimeoutW, HICON, ICONINFO, SMTO_ABORTIFHUNG, SMTO_NORMAL, WM_GETTEXT,
    WM_GETTEXTLENGTH,
};

/// hwnd+pid captured synchronously at hotkey time; muxing takes ~1-2s so the
/// foreground window may have changed by the time we resolve it.
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

/// exe stem for filename templating, plus window title only if need_title
/// (WM_GETTEXT on a hung window can block up to ~400ms).
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

/// title/exe/icon resolved up front in parallel with the mux, so save-completion
/// is just a JSON write keyed by the clip's filename.
#[derive(Clone, Debug)]
pub struct ResolvedMetadata {
    pub title: String,
    pub exe_path: Option<PathBuf>,
    /// `{exe-stem}.png` for the gameinfo's `icon_file` field. `None`
    /// when icon capture is disabled or the icon extract failed.
    pub icon_filename: Option<String>,
    /// PNG bytes kept in-memory until finalize, since output_dir may change
    /// between the save hotkey and config reload (or a rename).
    pub icon_png: Option<Vec<u8>>,
    /// set when the exe matched ignored_processes; write_gameinfo skips creating
    /// .clip_metadata/ entirely when true.
    pub ignored: bool,
}

/// runs in parallel with pipeline.save_clip() so the 200ms SendMessageTimeoutW
/// calls and icon GDI/DIB work don't add to save latency.
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

/// writes .clip_metadata/{clip}.gameinfo + icons/{exe}.png beside the clip's
/// actual dir; resolved and discord are independent, an ignored resolved keeps the discord roster
/// but drops game fields.
pub fn write_gameinfo(
    clip_path: &Path,
    resolved: Option<&ResolvedMetadata>,
    discord: Option<&serde_json::Value>,
) -> Result<()> {
    // game fields only if resolved isn't ignored
    let game = resolved.filter(|r| !r.ignored);
    if game.is_none() && discord.is_none() {
        return Ok(());
    }
    let dir = clip_path
        .parent()
        .ok_or_else(|| anyhow!("clip path has no parent"))?;

    // dedup: skip write if the icon file already exists for this exe
    if let Some(r) = game {
        if let (Some(name), Some(bytes)) = (r.icon_filename.as_deref(), r.icon_png.as_deref()) {
            let icons_dir = dir.join("icons");
            fs::create_dir_all(&icons_dir).context("create icons directory")?;
            let icon_path = icons_dir.join(name);
            if !icon_path.exists() {
                fs::write(&icon_path, bytes)
                    .with_context(|| format!("write {}", icon_path.display()))?;
            }
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

    let mut json = serde_json::Map::new();
    if let Some(r) = game {
        json.insert("window_title".into(), r.title.clone().into());
        json.insert(
            "icon_file".into(),
            serde_json::to_value(&r.icon_filename).unwrap_or(serde_json::Value::Null),
        );
        json.insert(
            "exe_path".into(),
            r.exe_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .into(),
        );
    }
    if let Some(d) = discord {
        json.insert("discord".into(), d.clone());
    }
    let body = serde_json::to_string_pretty(&serde_json::Value::Object(json))
        .context("serialize metadata JSON")?;
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

/// ExtractIconExW gets an HICON; GetDIBits reads BGRA, swizzled to RGBA, png-encoded.
/// caller writes the bytes; this fn doesn't know the clip's parent dir.
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

        // hbmColor is the pixel bitmap (modern icons are already 32-bit with
        // alpha); hbmMask (AND mask) is unused but still needs deleting.
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

        // BGRA to RGBA, in place
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
        }

        // some 32-bit icons come back with alpha=0 (old toolchains); if fully
        // transparent, force alpha=255 so we don't write an invisible PNG
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
