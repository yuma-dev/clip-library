//! Setsu launcher, what shortcuts/taskbar pins point at. Plays the Setsu
//! reveal within tens of ms of the click, starts `Setsu.exe` with the same
//! args plus `--splash-logo=x,y,w,h` (physical pixels, so the app can take the
//! mark over in place) and `--splash-handoff` (when it may), fades out once
//! the app window is visible and opaque.

#![windows_subsystem = "windows"]

use std::env;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use windows::core::{w, PCWSTR};
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
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, EnumWindows,
    GetLayeredWindowAttributes, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId,
    IsWindowVisible, MessageBoxW, PeekMessageW, RegisterClassW, ShowWindow, SystemParametersInfoW,
    TranslateMessage, UpdateLayeredWindow, GWL_EXSTYLE, LWA_ALPHA, MSG, PM_REMOVE, SPI_GETWORKAREA,
    MB_ICONERROR, MB_OK, SW_SHOWNOACTIVATE, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, ULW_ALPHA, WNDCLASSW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

// ClipLib.exe: an old launcher left next to a new app or the other way round mid update
const APP_EXES: [&str; 2] = ["Setsu.exe", "ClipLib.exe"];
// baked by scripts/bake-splash.mjs from the setsu web component, format documented there.
// empty when it was not baked, then there is no splash
const SPLASH: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/splash.bin"));

// short: the app draws the same mark at the same spot once opaque and animates from there
const FADE_OUT: Duration = Duration::from_millis(120);
// longer than the app's own 30s never-ready fallback, so no gap before it reveals the window
const MAX_WAIT: Duration = Duration::from_secs(35);

fn u16_at(b: &[u8], at: usize) -> usize {
    b.get(at..at + 2).map_or(0, |s| u16::from_le_bytes([s[0], s[1]]) as usize)
}

fn u32_at(b: &[u8], at: usize) -> usize {
    b.get(at..at + 4).map_or(0, |s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize)
}

/// One scale's frames, each a delta against the frame before. The last one takes the picture
/// back to frame `hold`, so the loop goes on at `hold + 1` with deltas only.
struct Splash {
    scale: f32,
    win_w: i32,
    win_h: i32,
    // logical px in the window: x, y, size
    mark: (f32, f32, f32),
    fps: u64,
    frames: usize,
    hold_ms: u64,
    loop_ms: u64,
    blink_ms: (u64, u64),
    // known once reached, frames are walked in order the first time round
    offsets: Vec<Option<usize>>,
}

impl Splash {
    /// largest baked scale not above the system's, else the smallest
    fn load(system_scale: f32) -> Option<Splash> {
        let b = SPLASH;
        if b.len() < 32 || &b[0..4] != b"STSU" || u16_at(b, 4) != 1 {
            return None;
        }
        let fits = |s: f32| s <= system_scale + 0.01;
        let mut pick: Option<(f32, usize)> = None;
        for k in 0..u16_at(b, 28) {
            let scale = u16_at(b, 32 + k * 8) as f32 / 100.0;
            let offset = u32_at(b, 32 + k * 8 + 4);
            let better = match pick {
                None => true,
                Some((p, _)) if fits(p) => fits(scale) && scale > p,
                Some((p, _)) => fits(scale) || scale < p,
            };
            if better {
                pick = Some((scale, offset));
            }
        }
        let (scale, offset) = pick?;
        let (fps, frames) = (u16_at(b, 16) as u64, u16_at(b, 18));
        let (hold_ms, loop_ms) = (u16_at(b, 20) as u64, u16_at(b, 22) as u64);
        let hold = (hold_ms * fps / 1000) as usize;
        if fps == 0 || loop_ms == 0 || hold + 1 >= frames || offset >= b.len() {
            return None;
        }
        let mut offsets = vec![None; frames];
        offsets[0] = Some(offset);
        Some(Splash {
            scale,
            win_w: (u16_at(b, 6) as f32 * scale).round() as i32,
            win_h: (u16_at(b, 8) as f32 * scale).round() as i32,
            mark: (u16_at(b, 10) as f32 / 100.0, u16_at(b, 12) as f32 / 100.0, u16_at(b, 14) as f32 / 100.0),
            fps,
            frames,
            hold_ms,
            loop_ms,
            blink_ms: (u16_at(b, 24) as u64 * loop_ms / 1000, u16_at(b, 26) as u64 * loop_ms / 1000),
            offsets,
        })
    }

    /// stored frame for the `step`th one played
    fn frame_at(&self, step: u64) -> usize {
        let last = self.frames as u64 - 1;
        if step <= last {
            return step as usize;
        }
        let hold = self.hold_ms * self.fps / 1000;
        (hold + 1 + (step - last - 1) % (last - hold)) as usize
    }

    /// adds frame `i`'s delta onto the canvas; false on a broken file
    fn apply(&mut self, i: usize, canvas: &mut Canvas) -> bool {
        let Some(at) = self.offsets.get(i).copied().flatten() else { return false };
        let b = SPLASH;
        let (x, y, w, h) = (u16_at(b, at), u16_at(b, at + 2), u16_at(b, at + 4), u16_at(b, at + 6));
        let end = at + 12 + u32_at(b, at + 8);
        if end > b.len() {
            return false;
        }
        if let Some(next) = self.offsets.get_mut(i + 1) {
            *next = Some(end);
        }
        if w == 0 || h == 0 {
            return true;
        }
        if x + w > canvas.width as usize || y + h > canvas.height as usize {
            return false;
        }
        let Ok(delta) = miniz_oxide::inflate::decompress_to_vec_zlib(&b[at + 12..end]) else { return false };
        if delta.len() != w * h * 4 {
            return false;
        }
        let stride = canvas.width as usize * 4;
        for (row, src) in delta.chunks_exact(w * 4).enumerate() {
            // SAFETY: row and box are inside the canvas, checked above
            let dst = unsafe { std::slice::from_raw_parts_mut(canvas.pixels.add((y + row) * stride + x * 4), w * 4) };
            for (d, s) in dst.iter_mut().zip(src) {
                *d = d.wrapping_add(*s);
            }
        }
        true
    }
}

struct Canvas {
    width: i32,
    height: i32,
    hdc: HDC,
    bitmap: HBITMAP,
    old: windows::Win32::Graphics::Gdi::HGDIOBJ,
    // premultiplied BGRA, top-down, zeroed by CreateDIBSection
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

// npm run dev: CLIPLIB_DEV_APP is the electron binary, CLIPLIB_DEV_APP_DIR the project it runs
const DEV_APP: &str = "CLIPLIB_DEV_APP";
const DEV_APP_DIR: &str = "CLIPLIB_DEV_APP_DIR";

fn app_exe_path() -> Option<PathBuf> {
    if let Some(dev) = env::var_os(DEV_APP) {
        return Some(PathBuf::from(dev));
    }
    let exe = env::current_exe().ok()?;
    let dir = exe.parent()?;
    APP_EXES.iter().map(|name| dir.join(name)).find(|app| app.is_file())
}

// a click that does nothing reads as a dead app, say why instead
fn report_launch_failure(detail: &str) {
    let text: Vec<u16> = format!("Setsu could not start: {detail}.\n\nReinstalling from setsu.gg fixes this.\0")
        .encode_utf16()
        .collect();
    unsafe {
        MessageBoxW(None, PCWSTR(text.as_ptr()), w!("Setsu"), MB_OK | MB_ICONERROR);
    }
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
    // cloaked = DWM hasn't composed it yet, not actually on screen
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
    // app shows at opacity 0 and stays there until the handoff (hides Windows' first white frame)
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

fn main() {
    // splash must never delay the app; only geometry is computed before spawn
    let Some(app) = app_exe_path() else {
        report_launch_failure("Setsu.exe is missing next to the launcher");
        return;
    };
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let mut splash = Splash::load(unsafe { GetDpiForSystem() } as f32 / 96.0);
    let mut work = RECT::default();
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut work as *mut RECT as *mut core::ffi::c_void),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
    }
    let (width, height) = splash.as_ref().map_or((0, 0), |s| (s.win_w, s.win_h));
    let x = work.left + (work.right - work.left - width) / 2;
    let y = work.top + (work.bottom - work.top - height) / 2;

    let started = Instant::now();
    let mut command = Command::new(&app);
    let dev = env::var_os(DEV_APP).is_some();
    if let Some(dir) = env::var_os(DEV_APP_DIR) {
        command.arg(dir);
    }
    // deep links, flags pass straight through
    command.args(env::args_os().skip(1));
    if let Some(s) = &splash {
        let px = |v: f32| (v * s.scale).round() as i32;
        let (mx, my, size) = s.mark;
        command.arg(format!("--splash-logo={},{},{},{}", x + px(mx), y + px(my), px(size), px(size)));
        // start (unix ms), hold, loop, blink from/to (ms into the loop). the app stays
        // transparent until the name has landed and the star is at rest, so the takeover never
        // cuts the reveal short or lands mid-blink
        let epoch = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
        command.arg(format!(
            "--splash-handoff={},{},{},{},{}",
            epoch, s.hold_ms, s.loop_ms, s.blink_ms.0, s.blink_ms.1
        ));
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            report_launch_failure(&error.to_string());
            return;
        }
    };
    if let Some(splash) = splash.as_mut() {
        play(splash, &mut child, started, (x, y, width, height));
    }
    // dev runner (concurrently) treats our exit as the app quitting
    if dev {
        let _ = child.wait();
    }
}

fn play(splash: &mut Splash, child: &mut Child, started: Instant, (x, y, width, height): (i32, i32, i32, i32)) {
    let pid = child.id();

    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(w!("com.yuma-dev.clips"));
    }

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
            w!("Setsu"),
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

        let mut played: Option<u64> = None;
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

            // a late tick still applies every frame in between, each delta builds on the last
            let due = now.duration_since(started).as_millis() as u64 * splash.fps / 1000;
            let mut broken = false;
            while played.map_or(true, |p| p < due) {
                let step = played.map_or(0, |p| p + 1);
                if !splash.apply(splash.frame_at(step), &mut canvas) {
                    broken = true;
                    break;
                }
                played = Some(step);
            }
            if broken {
                break;
            }

            let alpha = match fading_out {
                Some(at) => {
                    let f = 1.0 - (now.duration_since(at).as_secs_f32() / FADE_OUT.as_secs_f32()).min(1.0);
                    (f * 255.0) as u8
                }
                None => 255,
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
            std::thread::sleep(Duration::from_millis(8));
        }
        let _ = DestroyWindow(hwnd);
    }
}
