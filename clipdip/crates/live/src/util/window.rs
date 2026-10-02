//! Window titles of a process, for games that put their state in the title bar.

/// Titles of the pid's visible top-level windows (owned popups skipped), in z-order.
pub fn titles(pid: u32) -> Vec<String> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER,
    };

    struct Search {
        pid: u32,
        found: Vec<String>,
    }

    unsafe extern "system" fn each(hwnd: HWND, lp: LPARAM) -> BOOL {
        // SAFETY: lp is the &mut Search passed to EnumWindows below, alive for the whole call
        let s = &mut *(lp.0 as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != s.pid || !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        if GetWindow(hwnd, GW_OWNER)
            .map(|h| !h.is_invalid())
            .unwrap_or(false)
        {
            return BOOL(1);
        }
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut buf).clamp(0, 512) as usize;
        if n > 0 {
            s.found.push(String::from_utf16_lossy(&buf[..n]));
        }
        BOOL(1)
    }

    let mut s = Search {
        pid,
        found: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut s as *mut Search as isize));
    }
    s.found
}

/// The first visible title, the usual case of one game window.
pub fn title(pid: u32) -> Option<String> {
    titles(pid).into_iter().next()
}
