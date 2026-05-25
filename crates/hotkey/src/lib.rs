//! Global hotkey listener that works inside games.
//!
//! Previously this used `RegisterHotKey`, which delivers `WM_HOTKEY` via
//! the thread message queue. Fullscreen-exclusive games and any game
//! that grabs the keyboard via DirectInput / RawInput swallow keys
//! before that path fires — League of Legends being the test case that
//! exposed it. So we switched to **Raw Input with `RIDEV_INPUTSINK`**:
//! we create a hidden message-only window, register for raw keyboard
//! events with the "inputsink" flag (input regardless of focus), and
//! decode + match in the window procedure ourselves.
//!
//! Trade-offs we accepted:
//! - **Observe-only, not consume.** Raw input doesn't block the
//!   foreground app from receiving the same key. Fine for our default
//!   `Ctrl+Alt+F10` — no game claims that. If we later want to swallow
//!   a key with a higher collision risk, we'd need a low-level keyboard
//!   hook (`WH_KEYBOARD_LL`), which kernel anti-cheats (Vanguard / EAC)
//!   may flag.
//! - **No suppression of the OS hotkey conflict warning** — but there
//!   shouldn't be one. We don't claim the hotkey system-wide; we just
//!   listen.
//! - **Anti-repeat is now our responsibility.** `MOD_NOREPEAT` from
//!   `RegisterHotKey` is gone; we track whether the non-modifier key is
//!   currently held and only fire on the down-transition.

use anyhow::{anyhow, Context, Result};
use crossbeam_channel::{Receiver, Sender};
use std::cell::RefCell;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::thread::JoinHandle;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE,
    RAWINPUTHEADER, RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEKEYBOARD,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    PostThreadMessageW, RegisterClassExW, TranslateMessage, HMENU, HWND_MESSAGE, MSG,
    RI_KEY_BREAK, WINDOW_EX_STYLE, WINDOW_STYLE, WM_INPUT, WM_QUIT, WNDCLASSEXW,
};

/// Mirrors the `MOD_*` constants from `winuser.h` — preserved for
/// backwards-compatible parsing even though we no longer call
/// `RegisterHotKey`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Modifiers(pub u32);

impl Modifiers {
    pub const ALT: Self = Self(0x0001);
    pub const CONTROL: Self = Self(0x0002);
    pub const SHIFT: Self = Self(0x0004);
    pub const WIN: Self = Self(0x0008);

    pub fn contains(self, other: Self) -> bool {
        (self.0 & other.0) == other.0
    }
}

impl std::ops::BitOr for Modifiers {
    type Output = Self;
    fn bitor(self, rhs: Self) -> Self {
        Self(self.0 | rhs.0)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct HotkeyBinding {
    pub modifiers: Modifiers,
    /// Windows `VK_*` virtual-key code.
    pub vk: u32,
}

impl HotkeyBinding {
    /// Parse a human-readable shortcut like `"Ctrl+Shift+S"` or `"Alt+F9"`
    /// into a binding. Case-insensitive, separator is `+`.
    ///
    /// Supported tokens:
    /// - Modifiers: `ctrl`/`control`, `shift`, `alt`, `win`/`super`
    /// - Letters: `a`–`z` (single ASCII char)
    /// - Digits: `0`–`9`
    /// - Function keys: `f1`–`f24`
    ///
    /// The final non-modifier token is taken as the key. Exactly one key
    /// token is required.
    pub fn parse(s: &str) -> Result<Self> {
        let mut modifiers = Modifiers::default();
        let mut vk: Option<u32> = None;
        for raw in s.split('+').map(str::trim).filter(|p| !p.is_empty()) {
            let lower = raw.to_ascii_lowercase();
            match lower.as_str() {
                "ctrl" | "control" => modifiers = modifiers | Modifiers::CONTROL,
                "shift" => modifiers = modifiers | Modifiers::SHIFT,
                "alt" => modifiers = modifiers | Modifiers::ALT,
                "win" | "super" | "meta" => modifiers = modifiers | Modifiers::WIN,
                key => {
                    let code = parse_vk(key)
                        .with_context(|| format!("unknown hotkey token '{raw}' in '{s}'"))?;
                    if vk.is_some() {
                        return Err(anyhow!(
                            "hotkey '{s}' has multiple non-modifier keys; only one is allowed"
                        ));
                    }
                    vk = Some(code);
                }
            }
        }
        Ok(Self {
            modifiers,
            vk: vk.ok_or_else(|| anyhow!("hotkey '{s}' has no key (only modifiers)"))?,
        })
    }
}

/// Parse a single non-modifier key token into a Windows VK code.
fn parse_vk(key: &str) -> Result<u32> {
    if key.len() == 1 {
        let c = key.chars().next().unwrap().to_ascii_uppercase();
        if c.is_ascii_alphabetic() || c.is_ascii_digit() {
            return Ok(c as u32);
        }
    }
    if let Some(n_str) = key.strip_prefix('f') {
        if let Ok(n) = n_str.parse::<u32>() {
            if (1..=24).contains(&n) {
                return Ok(0x70 + (n - 1));
            }
        }
    }
    Err(anyhow!("unsupported key '{key}' — use a letter, digit, or F1–F24"))
}

/// A handle to the message-pump thread. Drop to stop the listener.
pub struct HotkeyListener {
    thread_id: u32,
    join: Option<JoinHandle<()>>,
}

impl HotkeyListener {
    /// Spawn a thread that listens for the given hotkey. The returned
    /// `Receiver` yields a `()` every time the hotkey fires (key
    /// transition only — no auto-repeat).
    pub fn spawn(binding: HotkeyBinding) -> Result<(Self, Receiver<()>)> {
        let (event_tx, event_rx) = crossbeam_channel::unbounded::<()>();
        let (ready_tx, ready_rx) = crossbeam_channel::bounded::<Result<u32>>(1);

        let join = std::thread::Builder::new()
            .name("clipdip-hotkey".into())
            .spawn(move || run_thread(binding, event_tx, ready_tx))
            .context("spawn hotkey thread")?;

        let thread_id = ready_rx
            .recv()
            .context("hotkey thread died before reporting status")??;

        Ok((
            Self {
                thread_id,
                join: Some(join),
            },
            event_rx,
        ))
    }
}

impl Drop for HotkeyListener {
    fn drop(&mut self) {
        // Post WM_QUIT to the listener's message queue so GetMessage
        // returns zero and the thread exits cleanly.
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

// ----- Thread-local listener state ------------------------------------
//
// The window procedure runs on the hotkey thread and needs access to the
// binding, sender, and live modifier state. Stash it in a thread-local
// `RefCell` so `wnd_proc` (a plain `extern "system"` fn pointer) can
// borrow it. Reentrancy isn't a concern — Raw Input messages are
// delivered serially via the message pump.

struct ListenerState {
    binding: HotkeyBinding,
    /// Modifier-key bitmask currently held (uses the same bit layout as
    /// [`Modifiers`]).
    modifiers_held: u32,
    /// True while the binding's non-modifier key is currently down.
    /// Used to suppress OS-driven key auto-repeat — we fire once per
    /// physical press, not 30 times/sec.
    key_pressed: bool,
    event_tx: Sender<()>,
}

thread_local! {
    static LISTENER: RefCell<Option<ListenerState>> = const { RefCell::new(None) };
}

/// Lazily register the window class once per process. The class name is
/// fixed; if multiple `HotkeyListener`s ever coexist, they share the
/// class but each gets its own window/thread/thread-local state.
fn window_class_name() -> PCWSTR {
    static CLASS: OnceLock<Vec<u16>> = OnceLock::new();
    let buf = CLASS.get_or_init(|| {
        let name: Vec<u16> = "clipdip_hotkey_window\0".encode_utf16().collect();
        // SAFETY: registration may race across threads on first call;
        // RegisterClassExW with the same atom is idempotent in practice
        // (returns the existing atom on duplicate). Use a static
        // sentinel to ensure we only register once.
        static REGISTERED: AtomicU32 = AtomicU32::new(0);
        if REGISTERED.swap(1, Ordering::SeqCst) == 0 {
            unsafe {
                let hinst = GetModuleHandleW(None).unwrap_or_default();
                let mut wc = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    lpfnWndProc: Some(wnd_proc),
                    hInstance: HINSTANCE(hinst.0),
                    lpszClassName: PCWSTR(name.as_ptr()),
                    ..Default::default()
                };
                // RegisterClassExW returns 0 on failure; we don't bail
                // here because errors will surface at CreateWindowExW.
                let _ = RegisterClassExW(&mut wc);
            }
        }
        name
    });
    PCWSTR(buf.as_ptr())
}

fn run_thread(binding: HotkeyBinding, event_tx: Sender<()>, ready_tx: Sender<Result<u32>>) {
    LISTENER.with(|cell| {
        *cell.borrow_mut() = Some(ListenerState {
            binding,
            modifiers_held: 0,
            key_pressed: false,
            event_tx,
        });
    });

    let class_name = window_class_name();

    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            HWND_MESSAGE, // message-only window — no visual, no Z-order
            HMENU::default(),
            HINSTANCE::default(),
            None,
        )
    };
    let hwnd = match hwnd {
        Ok(h) => h,
        Err(e) => {
            let _ = ready_tx.send(Err(anyhow!("CreateWindowExW failed: {e}")));
            return;
        }
    };

    // Register the keyboard for raw input with INPUTSINK — i.e. deliver
    // WM_INPUT to our window even when the foreground app has focus.
    // Usage page 0x01 (Generic Desktop), usage 0x06 (Keyboard).
    let device = RAWINPUTDEVICE {
        usUsagePage: 0x01,
        usUsage: 0x06,
        dwFlags: RIDEV_INPUTSINK,
        hwndTarget: hwnd,
    };
    if let Err(e) = unsafe {
        RegisterRawInputDevices(&[device], std::mem::size_of::<RAWINPUTDEVICE>() as u32)
    } {
        unsafe { let _ = DestroyWindow(hwnd); }
        let _ = ready_tx.send(Err(anyhow!("RegisterRawInputDevices failed: {e}")));
        return;
    }

    let thread_id = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
    if ready_tx.send(Ok(thread_id)).is_err() {
        unsafe { let _ = DestroyWindow(hwnd); }
        return;
    }

    // Standard Win32 message pump. GetMessageW returns 0 on WM_QUIT.
    let mut msg = MSG::default();
    loop {
        let res = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if res.0 <= 0 {
            break;
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    unsafe {
        let _ = DestroyWindow(hwnd);
    }
    LISTENER.with(|cell| *cell.borrow_mut() = None);
}

extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_INPUT {
        // SAFETY: lParam of WM_INPUT is a HRAWINPUT handle valid until
        // we forward to DefWindowProcW.
        unsafe { handle_raw_input(HRAWINPUT(lparam.0 as *mut _)) };
    }
    // Always forward to DefWindowProcW so the OS can clean up the raw
    // input handle (MSDN: "Call DefWindowProc so the system can perform
    // the cleanup").
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

unsafe fn handle_raw_input(h_raw_input: HRAWINPUT) {
    let header_size = std::mem::size_of::<RAWINPUTHEADER>() as u32;

    // First call queries the size of the data. We pre-size for a single
    // RAWINPUT (the keyboard variant is small, <50 bytes). If the OS
    // ever asks for more we fall through to dynamic.
    let mut size = std::mem::size_of::<RAWINPUT>() as u32;
    let mut buf = vec![0u8; size as usize];

    let read = GetRawInputData(
        h_raw_input,
        RID_INPUT,
        Some(buf.as_mut_ptr() as *mut _),
        &mut size,
        header_size,
    );
    if read == u32::MAX {
        return;
    }
    if read == 0 && size > buf.len() as u32 {
        // System asked for more — retry with the requested size.
        buf.resize(size as usize, 0);
        let read = GetRawInputData(
            h_raw_input,
            RID_INPUT,
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
            header_size,
        );
        if read == u32::MAX || read == 0 {
            return;
        }
    }

    let raw = &*(buf.as_ptr() as *const RAWINPUT);
    if raw.header.dwType != RIM_TYPEKEYBOARD.0 {
        return;
    }
    let kb = &raw.data.keyboard;
    let vk = kb.VKey as u32;
    let is_down = (kb.Flags as u32 & RI_KEY_BREAK) == 0;

    LISTENER.with(|cell| {
        let mut state_ref = cell.borrow_mut();
        let Some(state) = state_ref.as_mut() else {
            return;
        };

        // Modifier keys come in left/right (`VK_LCONTROL`/`VK_RCONTROL`)
        // and generic (`VK_CONTROL`) forms depending on the keyboard
        // driver. Match either — we only care whether *any* of that
        // modifier side is currently held.
        let mod_bit = match vk {
            0x11 | 0xA2 | 0xA3 => Modifiers::CONTROL.0, // CONTROL, LCONTROL, RCONTROL
            0x12 | 0xA4 | 0xA5 => Modifiers::ALT.0,     // MENU, LMENU, RMENU
            0x10 | 0xA0 | 0xA1 => Modifiers::SHIFT.0,   // SHIFT, LSHIFT, RSHIFT
            0x5B | 0x5C => Modifiers::WIN.0,            // LWIN, RWIN
            _ => 0,
        };
        if mod_bit != 0 {
            if is_down {
                state.modifiers_held |= mod_bit;
            } else {
                state.modifiers_held &= !mod_bit;
            }
            return;
        }

        // Non-modifier key. Fire on the down-transition only — the OS
        // auto-repeats held keys at ~30 Hz, and we want one event per
        // physical press (matches RegisterHotKey's MOD_NOREPEAT
        // behavior).
        if vk == state.binding.vk {
            if is_down {
                if !state.key_pressed
                    && (state.modifiers_held & state.binding.modifiers.0)
                        == state.binding.modifiers.0
                {
                    let _ = state.event_tx.send(());
                }
                state.key_pressed = true;
            } else {
                state.key_pressed = false;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifiers_compose() {
        let m = Modifiers::CONTROL | Modifiers::SHIFT;
        assert!(m.contains(Modifiers::CONTROL));
        assert!(m.contains(Modifiers::SHIFT));
        assert!(!m.contains(Modifiers::ALT));
    }

    #[test]
    fn parse_basic_letter_hotkey() {
        let b = HotkeyBinding::parse("Ctrl+Shift+S").unwrap();
        assert!(b.modifiers.contains(Modifiers::CONTROL));
        assert!(b.modifiers.contains(Modifiers::SHIFT));
        assert!(!b.modifiers.contains(Modifiers::ALT));
        assert_eq!(b.vk, 'S' as u32);
    }

    #[test]
    fn parse_is_case_insensitive() {
        let b = HotkeyBinding::parse("alt+f9").unwrap();
        assert!(b.modifiers.contains(Modifiers::ALT));
        assert_eq!(b.vk, 0x78); // VK_F9 = 0x70 + 8
    }

    #[test]
    fn parse_digit_key() {
        let b = HotkeyBinding::parse("Win+3").unwrap();
        assert!(b.modifiers.contains(Modifiers::WIN));
        assert_eq!(b.vk, '3' as u32);
    }

    #[test]
    fn parse_rejects_no_key() {
        assert!(HotkeyBinding::parse("Ctrl+Shift").is_err());
    }

    #[test]
    fn parse_rejects_multiple_keys() {
        assert!(HotkeyBinding::parse("Ctrl+S+T").is_err());
    }

    #[test]
    fn parse_rejects_unknown_token() {
        assert!(HotkeyBinding::parse("Ctrl+Banana").is_err());
    }

    // No integration test for actual hotkey delivery — Raw Input requires
    // a real interactive desktop session, which test runners typically
    // don't have. Manual verification: run `cargo run --bin clipdip` and
    // press the configured hotkey while a fullscreen-exclusive game is
    // active (League of Legends is the regression target).
}
