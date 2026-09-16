//! Hidden top-level window that catches WM_QUERYENDSESSION and fires
//! session_end("shutdown") before Windows kills the process (else it ages out as a crash).
//! Not the hotkey crate's window: message-only windows never get broadcast messages like this.

use tracing::{debug, warn};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, TRUE, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassExW,
    TranslateMessage, MSG, WINDOW_EX_STYLE, WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSEXW,
    WS_POPUP,
};

const CLASS_NAME: PCWSTR = w!("ClipdipShutdownWatch");

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_QUERYENDSESSION => {
            debug!("shutdown watch: WM_QUERYENDSESSION");
            // session_end is bounded at ~2s; TRUE never blocks shutdown beyond that
            clipdip_diagnostics::session_end("shutdown");
            LRESULT(TRUE.0 as isize)
        }
        WM_ENDSESSION => {
            // session_end + dirty-marker removal already happened on WM_QUERYENDSESSION
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// spawns the watcher thread; failures are logged and ignored, losing
/// shutdown attribution must never affect the app.
pub fn spawn() {
    let result = std::thread::Builder::new()
        .name("clipdip-shutdown-watch".into())
        .spawn(|| unsafe {
            let hinstance = match GetModuleHandleW(None) {
                Ok(h) => h,
                Err(e) => {
                    warn!("shutdown watch: GetModuleHandleW failed: {e:?}");
                    return;
                }
            };
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(wnd_proc),
                hInstance: hinstance.into(),
                lpszClassName: CLASS_NAME,
                ..Default::default()
            };
            if RegisterClassExW(&class) == 0 {
                warn!("shutdown watch: RegisterClassExW failed");
                return;
            }
            // hidden top-level window (not message-only) so it gets the WM_QUERYENDSESSION broadcast
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                CLASS_NAME,
                CLASS_NAME,
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                hinstance,
                None,
            );
            let hwnd = match hwnd {
                Ok(h) => h,
                Err(e) => {
                    warn!("shutdown watch: CreateWindowExW failed: {e:?}");
                    return;
                }
            };
            debug!("shutdown watch: running");
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, hwnd, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
    if let Err(e) = result {
        warn!("shutdown watch: thread spawn failed: {e}");
    }
}
