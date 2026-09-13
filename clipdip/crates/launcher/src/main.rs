//! ClipLib launcher: `ClipLib Launcher.exe`, what shortcuts and taskbar pins
//! point at. It draws the splash (logo with a breathing halo and a sweep bar,
//! per-pixel alpha, no window frame) within a few tens of milliseconds of the
//! click, starts the Electron app (`ClipLib.exe` next to it) with the same
//! arguments plus `--splash-logo=x,y,w,h` (where the logo sits, in physical
//! screen pixels, so the app can take it over in place), and fades out as
//! soon as the app's window is visible and opaque. Electron itself needs
//! about 1.5 s to put the library on screen; this covers that wait with
//! immediate feedback and costs the app nothing (no extra renderer process).
//!
//! If the app is already running, the spawned instance hands over to it and
//! exits at once, so the splash disappears again right away.

#![windows_subsystem = "windows"]

use std::env;
use std::io::Cursor;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use windows::core::w;
use windows::Win32::Foundation::{BOOL, COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS,
    HBITMAP, HDC,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    GetDpiForSystem, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, EnumWindows, GetLayeredWindowAttributes,
    GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, PeekMessageW,
    RegisterClassW, ShowWindow, SystemParametersInfoW, TranslateMessage, UpdateLayeredWindow,
    GWL_EXSTYLE, LWA_ALPHA, MSG, PM_REMOVE, SPI_GETWORKAREA, SW_SHOWNOACTIVATE,
    SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, ULW_ALPHA, WINDOW_EX_STYLE, WNDCLASSW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

const APP_EXE: &str = "ClipLib.exe";
const LOGO_PNG: &[u8] = include_bytes!("../../../../assets/title.png");

// Logical layout, matching the old in-app splash.
const WIN_W: i32 = 480;
const WIN_H: i32 = 360;
const LOGO_W: i32 = 140;
const BAR_W: i32 = 200;
const BAR_H: i32 = 2;
const GAP: i32 = 28;

const FADE_IN: Duration = Duration::from_millis(260);
// Short: the app draws the same logo at the same spot the moment it is opaque
// and animates from there, so the launcher only has to get out of the way.
const FADE_OUT: Duration = Duration::from_millis(120);
const SWEEP_PERIOD: Duration = Duration::from_millis(1800);
// Accent halo behind the logo, breathing with the same period as the sweep.
const HALO_RADIUS: i32 = 87;
const HALO_PERIOD: Duration = Duration::from_millis(1800);
// Give up covering for the app after this long; it will show up by itself.
// Longer than the app's own 30 s never-ready fallback, so the splash never
// leaves a gap before that fallback reveals the window.
const MAX_WAIT: Duration = Duration::from_secs(35);

struct Rgba {
    width: usize,
    height: usize,
    // Straight (non-premultiplied) RGBA.
    pixels: Vec<u8>,
}

fn decode_logo() -> Option<Rgba> {
    let decoder = png::Decoder::new(Cursor::new(LOGO_PNG));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let (width, height) = (info.width as usize, info.height as usize);
    let pixels = match info.color_type {
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => buf[..info.buffer_size()]
            .chunks(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        _ => return None,
    };
    Some(Rgba { width, height, pixels })
}

/// Box-filter downscale (the logo is 1024 px, drawn at ~140 px).
fn downscale(src: &Rgba, dst_w: usize, dst_h: usize) -> Rgba {
    let mut out = vec![0u8; dst_w * dst_h * 4];
    for y in 0..dst_h {
        let sy0 = y * src.height / dst_h;
        let sy1 = ((y + 1) * src.height / dst_h).max(sy0 + 1).min(src.height);
        for x in 0..dst_w {
            let sx0 = x * src.width / dst_w;
            let sx1 = ((x + 1) * src.width / dst_w).max(sx0 + 1).min(src.width);
            let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for sy in sy0..sy1 {
                for sx in sx0..sx1 {
                    let i = (sy * src.width + sx) * 4;
                    let pa = src.pixels[i + 3] as u64;
                    // Weight color by alpha so transparent pixels do not darken edges.
                    r += src.pixels[i] as u64 * pa;
                    g += src.pixels[i + 1] as u64 * pa;
                    b += src.pixels[i + 2] as u64 * pa;
                    a += pa;
                    n += 1;
                }
            }
            let o = (y * dst_w + x) * 4;
            if a > 0 {
                out[o] = (r / a) as u8;
                out[o + 1] = (g / a) as u8;
                out[o + 2] = (b / a) as u8;
                out[o + 3] = (a / n) as u8;
            }
        }
    }
    Rgba { width: dst_w, height: dst_h, pixels: out }
}

struct Canvas {
    width: i32,
    height: i32,
    hdc: HDC,
    bitmap: HBITMAP,
    old: windows::Win32::Graphics::Gdi::HGDIOBJ,
    pixels: *mut u8,
}

impl Canvas {
    unsafe fn new(width: i32, height: i32) -> Option<Canvas> {
        let screen = GetDC(None);
        let hdc = CreateCompatibleDC(screen);
        ReleaseDC(None, screen);
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels: *mut core::ffi::c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(hdc, &bmi, DIB_RGB_COLORS, &mut pixels, None, 0).ok()?;
        let old = SelectObject(hdc, bitmap);
        Some(Canvas { width, height, hdc, bitmap, old, pixels: pixels as *mut u8 })
    }

    fn clear(&mut self) {
        unsafe { std::ptr::write_bytes(self.pixels, 0, (self.width * self.height * 4) as usize) };
    }

    /// Premultiplied BGRA write with source-over blending.
    fn blend(&mut self, x: i32, y: i32, r: u8, g: u8, b: u8, a: u8) {
        if x < 0 || y < 0 || x >= self.width || y >= self.height || a == 0 {
            return;
        }
        let i = ((y * self.width + x) * 4) as usize;
        unsafe {
            let p = self.pixels.add(i);
            let sa = a as u32;
            let inv = 255 - sa;
            let db = *p as u32;
            let dg = *p.add(1) as u32;
            let dr = *p.add(2) as u32;
            let da = *p.add(3) as u32;
            *p = ((b as u32 * sa + db * inv) / 255) as u8;
            *p.add(1) = ((g as u32 * sa + dg * inv) / 255) as u8;
            *p.add(2) = ((r as u32 * sa + dr * inv) / 255) as u8;
            *p.add(3) = (sa + da * inv / 255) as u8;
        }
    }

    fn draw_image(&mut self, img: &Rgba, x0: i32, y0: i32) {
        for y in 0..img.height {
            for x in 0..img.width {
                let i = (y * img.width + x) * 4;
                self.blend(
                    x0 + x as i32,
                    y0 + y as i32,
                    img.pixels[i],
                    img.pixels[i + 1],
                    img.pixels[i + 2],
                    img.pixels[i + 3],
                );
            }
        }
    }
}

impl Drop for Canvas {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.hdc, self.old);
            let _ = DeleteObject(self.bitmap);
            let _ = DeleteDC(self.hdc);
        }
    }
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn app_exe_path() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let dir = exe.parent()?;
    let app = dir.join(APP_EXE);
    app.is_file().then_some(app)
}

struct Probe {
    pid: u32,
    found: bool,
}

unsafe extern "system" fn enum_windows(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let probe = &mut *(lparam.0 as *mut Probe);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid != probe.pid || !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_err() || rect.right - rect.left < 200 || rect.bottom - rect.top < 200 {
        return BOOL(1);
    }
    // A cloaked window (DWM has not composed it yet) is not on screen.
    let mut cloaked: u32 = 0;
    let _ = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut core::ffi::c_void,
        std::mem::size_of::<u32>() as u32,
    );
    if cloaked != 0 {
        return BOOL(1);
    }
    // The app shows its window at opacity 0 and switches to opaque one frame
    // later (that hides Windows' first white frame); wait for the opaque one.
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_LAYERED.0 != 0 {
        let mut key = COLORREF(0);
        let mut alpha = 0u8;
        let mut flags = Default::default();
        if GetLayeredWindowAttributes(hwnd, Some(&mut key), Some(&mut alpha), Some(&mut flags)).is_ok()
            && (flags & LWA_ALPHA) == LWA_ALPHA
            && alpha < 250
        {
            return BOOL(1);
        }
    }
    probe.found = true;
    BOOL(0)
}

fn app_window_visible(pid: u32) -> bool {
    let mut probe = Probe { pid, found: false };
    unsafe {
        let _ = EnumWindows(Some(enum_windows), LPARAM(&mut probe as *mut Probe as isize));
    }
    probe.found
}

fn ease_out(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

/// Halo colour and alpha at normalised distance `d` from the centre (0 at the
/// centre, 1 at the radius): accent core fading to a deeper purple, then out.
fn halo_at(d: f32) -> Option<(u8, u8, u8, f32)> {
    if d < 0.4 {
        let t = d / 0.4;
        let mix = |a: f32, b: f32| a + (b - a) * t;
        Some((mix(199.0, 142.0) as u8, mix(116.0, 50.0) as u8, mix(224.0, 155.0) as u8, mix(0.35, 0.12)))
    } else if d < 0.7 {
        Some((142, 50, 155, 0.12 * (1.0 - (d - 0.4) / 0.3)))
    } else {
        None
    }
}

fn main() {
    // The app starts first: the splash only covers its startup and must never
    // delay it. Only the window geometry is computed before the spawn (a few
    // microseconds) because the app needs to know where the logo will be.
    let Some(app) = app_exe_path() else { return };
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let scale = unsafe { GetDpiForSystem() } as f32 / 96.0;
    let px = |v: i32| (v as f32 * scale).round() as i32;
    let (width, height) = (px(WIN_W), px(WIN_H));
    let mut work = RECT::default();
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut work as *mut RECT as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
    }
    let x = work.left + (work.right - work.left - width) / 2;
    let y = work.top + (work.bottom - work.top - height) / 2;
    // The logo is square (title.png is 1024 x 1024); the layout below assumes so.
    let logo_w = px(LOGO_W);
    let logo_y = (height - (logo_w + px(GAP) + px(BAR_H))) / 2;
    let logo_x = (width - logo_w) / 2;
    let splash_logo = format!("--splash-logo={},{},{},{}", x + logo_x, y + logo_y, logo_w, logo_w);

    // Arguments (deep links, flags) pass straight through.
    let child: Option<Child> = Command::new(&app)
        .args(env::args_os().skip(1))
        .arg(&splash_logo)
        .spawn()
        .ok();
    let Some(mut child) = child else { return };
    let pid = child.id();

    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(w!("com.yuma-dev.clips"));
    }

    let logo = decode_logo().map(|src| {
        let w = logo_w as usize;
        let h = (w * src.height / src.width.max(1)).max(1);
        downscale(&src, w, h)
    });

    let started = Instant::now();
    unsafe {
        let instance = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(_) => return,
        };
        let class = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: instance.into(),
            lpszClassName: w!("ClipLibLauncherSplash"),
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return;
        }
        let hwnd = match CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            w!("ClipLibLauncherSplash"),
            w!("ClipLib"),
            WS_POPUP,
            x,
            y,
            width,
            height,
            None,
            None,
            instance,
            None,
        ) {
            Ok(h) => h,
            Err(_) => return,
        };
        let Some(mut canvas) = Canvas::new(width, height) else { return };

        let bar_y = logo_y + logo_w + px(GAP);
        let halo_r = px(HALO_RADIUS) as f32;
        let (halo_cx, halo_cy) = ((logo_x + logo_w / 2) as f32, (logo_y + logo_w / 2) as f32);
        let bar_x = (width - px(BAR_W)) / 2;
        let bar_w = px(BAR_W);
        let bar_h = px(BAR_H).max(1);

        let mut shown = false;
        let mut fading_out: Option<Instant> = None;
        let mut msg = MSG::default();
        loop {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let now = Instant::now();
            if fading_out.is_none() {
                let child_gone = matches!(child.try_wait(), Ok(Some(_)) | Err(_));
                if child_gone || app_window_visible(pid) || now.duration_since(started) > MAX_WAIT {
                    fading_out = Some(now);
                }
            }

            // Frame: breathing halo, logo, sweep bar.
            canvas.clear();
            {
                let phase = (now.duration_since(started).as_secs_f32() / HALO_PERIOD.as_secs_f32()).fract();
                let breath = 0.5 - 0.5 * (phase * std::f32::consts::TAU).cos();
                let r = halo_r * (0.85 + 0.20 * breath);
                let strength = 0.6 + 0.4 * breath;
                let reach = (r * 0.7).ceil() as i32;
                let (cx, cy) = (halo_cx.round() as i32, halo_cy.round() as i32);
                for yy in (cy - reach).max(0)..(cy + reach).min(height) {
                    for xx in (cx - reach).max(0)..(cx + reach).min(width) {
                        let dx = xx as f32 - halo_cx;
                        let dy = yy as f32 - halo_cy;
                        let d = (dx * dx + dy * dy).sqrt() / r;
                        if let Some((cr, cg, cb, a)) = halo_at(d) {
                            canvas.blend(xx, yy, cr, cg, cb, (a * strength * 255.0) as u8);
                        }
                    }
                }
            }
            if let Some(l) = &logo {
                canvas.draw_image(l, logo_x, logo_y);
            }
            let t = (now.duration_since(started).as_secs_f32() / SWEEP_PERIOD.as_secs_f32()).fract();
            // Sweep across in the first 72% of the period, then rest (as the CSS did).
            let sweep = if t < 0.72 { ease_out(t / 0.72) } else { 1.0 };
            let head = -1.15 + sweep * 2.3; // in bar widths
            for yy in 0..bar_h {
                for xx in 0..bar_w {
                    let u = xx as f32 / bar_w as f32;
                    let d = (u - head).abs();
                    let glow = (1.0 - d * 2.2).clamp(0.0, 1.0);
                    let a = 0.15 + glow * 0.7;
                    canvas.blend(bar_x + xx, bar_y + yy, 255, 255, 255, (a * 255.0) as u8);
                }
            }

            let alpha = match fading_out {
                Some(at) => {
                    let f = 1.0 - (now.duration_since(at).as_secs_f32() / FADE_OUT.as_secs_f32()).min(1.0);
                    (f * 255.0) as u8
                }
                None => {
                    let f = (now.duration_since(started).as_secs_f32() / FADE_IN.as_secs_f32()).min(1.0);
                    (ease_out(f) * 255.0) as u8
                }
            };
            let blend = BLENDFUNCTION {
                BlendOp: AC_SRC_OVER as u8,
                BlendFlags: 0,
                SourceConstantAlpha: alpha,
                AlphaFormat: AC_SRC_ALPHA as u8,
            };
            let size = SIZE { cx: width, cy: height };
            let src = POINT { x: 0, y: 0 };
            let dst = POINT { x, y };
            let _ = UpdateLayeredWindow(
                hwnd,
                None,
                Some(&dst),
                Some(&size),
                canvas.hdc,
                Some(&src),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            );
            if !shown {
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                shown = true;
            }
            if let Some(at) = fading_out {
                if now.duration_since(at) >= FADE_OUT {
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(16));
        }
        let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(hwnd);
        let _ = WINDOW_EX_STYLE(0);
    }
}
