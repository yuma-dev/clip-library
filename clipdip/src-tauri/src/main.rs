#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod machine_profile;
mod metadata;
mod shutdown_watch;

use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use crossbeam_channel::unbounded;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tracing::{debug, error, info, warn};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOL, HWND, TRUE};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};

// overlay: fullscreen transparent click-through window, corner position via CSS.
// fullscreen also hides Windows' DWM shadow (it extends past the screen edge).

/// disables DWM transitions on the HWND so `show()` is instant, no scale-up
/// animation racing the React enter animation.
fn disable_window_transitions(hwnd: HWND) {
    unsafe {
        let value: BOOL = TRUE;
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_TRANSITIONS_FORCEDISABLED,
            &value as *const _ as *const _,
            std::mem::size_of::<BOOL>() as u32,
        );
    }
}

/// embedded so we don't resolve a file path at runtime; PlaySoundW with
/// SND_MEMORY reads straight from this static buffer.
const SAVE_SOUND_WAV: &[u8] = include_bytes!("../../assets/sound/save.wav");

/// async, replacing the webview-side `new Audio()` call which blocked the JS
/// event loop and forced an extra layout pass while WebView2 was busy.
fn play_save_sound() {
    unsafe {
        let _ = PlaySoundW(
            PCWSTR(SAVE_SOUND_WAV.as_ptr() as *const u16),
            None,
            SND_ASYNC | SND_MEMORY | SND_NODEFAULT,
        );
    }
}

/// Injected into every webview window so console.* output is forwarded to the
/// Rust tracing subscriber (visible in the terminal alongside app logs).
const CONSOLE_SCRIPT: &str = r#"
(function() {
  var label = (
    window.__TAURI_INTERNALS__ &&
    window.__TAURI_INTERNALS__.metadata &&
    window.__TAURI_INTERNALS__.metadata.currentWindow &&
    window.__TAURI_INTERNALS__.metadata.currentWindow.label
  ) || '?';
  function fwd(level, args) {
    try {
      var msg = Array.prototype.slice.call(args).map(function(a) {
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
        catch(e) { return '[unserializable]'; }
      }).join(' ');
      if (window.__TAURI_INTERNALS__) {
        window.__TAURI_INTERNALS__.invoke(
          'forward_console',
          { windowLabel: label, level: level, msg: msg }
        ).catch(function(){});
      }
    } catch(e) {}
  }
  ['log','info','warn','error'].forEach(function(l) {
    var orig = console[l].bind(console);
    console[l] = function() { orig.apply(console, arguments); fwd(l, arguments); };
  });
  // Uncaught errors and unhandled rejections were previously invisible:
  // only explicit console.* calls got forwarded. Ship them as structured
  // telemetry events, deduped per stack hash. Paths are stripped down to
  // basenames HERE, before anything leaves the page.
  var reported = {};
  function stackFrames(err) {
    try {
      var lines = String((err && err.stack) || '').split('\n').slice(0, 6);
      return lines.map(function(l) {
        return l.replace(/[A-Za-z]:[\\\/][^\s)]*[\\\/]/g, '')
                .replace(/https?:\/\/[^\s)]*\//g, '')
                .trim();
      }).filter(Boolean).slice(0, 5);
    } catch(e) { return []; }
  }
  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return (h >>> 0).toString(16);
  }
  function reportJsError(code, name, message, frames) {
    try {
      var fp = hashStr(code + '|' + name + '|' + frames.join('|'));
      var now = Date.now();
      if (reported[fp] && now - reported[fp] < 60000) return;
      reported[fp] = now;
      if (window.__TAURI_INTERNALS__) {
        window.__TAURI_INTERNALS__.invoke('report_frontend_event', {
          windowLabel: label,
          code: code,
          message: (name ? name + ': ' : '') + String(message).slice(0, 500),
          context: { frames: frames, fingerprint: fp }
        }).catch(function(){});
      }
    } catch(e) {}
  }
  try {
    window.addEventListener('error', function(e) {
      var err = e.error || {};
      reportJsError('js_uncaught_error', err.name || 'Error',
        e.message || String(err.message || ''), stackFrames(err));
    });
    window.addEventListener('unhandledrejection', function(e) {
      var r = e.reason || {};
      reportJsError('js_unhandled_rejection', r.name || 'Rejection',
        String(r.message || r).slice(0, 500), stackFrames(r));
    });
  } catch(e) {}
  // Devtools helper: call testNotification() to trigger a fake clip-save flow.
  try {
    window.testNotification = function() {
      if (!window.__TAURI_INTERNALS__) { console.warn('Tauri not available'); return; }
      return window.__TAURI_INTERNALS__.invoke('test_notification');
    };
  } catch(e) {}
})();
"#;

// shared state

struct AppState {
    config_path: PathBuf,
    /// path of the clip whose notification is currently on-screen (if any)
    active_clip: Arc<Mutex<Option<String>>>,
    pipeline_running: Arc<Mutex<bool>>,
    /// audio source states, refreshed on pipeline (re)start and device
    /// re-evaluation; served in the control server's `status` for ClipLib's device banner.
    audio_status: Arc<Mutex<serde_json::Value>>,
    /// latest `clip-saving` payload; overlay fetches it via `overlay_get_pending`
    /// on mount since events emitted before mount are dropped silently.
    pending_saving: Arc<Mutex<Option<ClipSavingPayload>>>,
    /// phase-2 companion to `pending_saving`. WebView2 cold-start can outlast
    /// the whole save flow, so a late overlay hydrates straight to "saved".
    pending_saved: Arc<Mutex<Option<ClipSavedPayload>>>,
    /// latest update from the background checker; same late-mount race as the
    /// other pendings, also queried by the settings window on mount.
    pending_update: Arc<Mutex<Option<UpdatePayload>>>,
    /// version already toasted, so the 30s checker doesn't re-toast the same release.
    update_toast_shown: Arc<Mutex<Option<String>>>,
    /// true while the update toast is up; gates global Escape (dismiss) and
    /// the rename hotkey (install now).
    update_toast_active: Arc<std::sync::atomic::AtomicBool>,
    /// true during a silent hotkey-triggered install; blocks double-triggers
    /// and Escape-dismiss mid-install.
    update_installing: Arc<std::sync::atomic::AtomicBool>,
    /// current hint card, same late-mount pattern as the other pendings; also
    /// gates the rename-hotkey dismiss.
    pending_hint: Arc<Mutex<Option<HintPayload>>>,
    /// true while a hint card is on screen; gates the rename hotkey's dismiss
    /// like `update_toast_active` does for updates.
    hint_active: Arc<std::sync::atomic::AtomicBool>,
    /// transient notice toasts ("Recording started"), same late-mount race as above.
    pending_notice: Arc<Mutex<Option<NoticePayload>>>,
    /// running pipeline's packet ring, for the settings UI's size estimate;
    /// `None` while no pipeline is running.
    ring: Arc<Mutex<Option<Arc<clipdip_ringbuf::PacketRing>>>>,
    /// manual recording in progress; drives the overlay's red dot, survives
    /// re-mounts via `overlay_get_pending`.
    recording_active: Arc<Mutex<bool>>,
    /// channel into `run_capture_loop`, for commands to ask for a pipeline restart
    loop_tx: crossbeam_channel::Sender<LoopEvent>,
    /// true once the overlay reports in via `overlay_get_pending`; the boot
    /// watchdog force-closes an overlay that never sets this.
    overlay_booted: Arc<std::sync::atomic::AtomicBool>,
    /// background Discord RPC connection, keeps the voice-call roster warm for
    /// hotkey-time snapshot; reports `Disabled` with no compiled-in secret.
    discord: Arc<clipdip_discord::DiscordHandle>,
    /// opt-out diagnostics client; drives the settings toggle and manual
    /// upload action. Inert without a compiled-in ingest key.
    diagnostics: Arc<clipdip_diagnostics::Diagnostics>,
    /// most recent `pipeline-error`, for the control server's `status`;
    /// cleared on a successful pipeline (re)start.
    pipeline_error: Arc<Mutex<Option<String>>>,
}

/// emits `pipeline-error` and retains it for the control server's `status` command.
fn report_pipeline_error(app: &AppHandle, err: String) {
    if let Some(state) = app.try_state::<AppState>() {
        *state.pipeline_error.lock().unwrap() = Some(err.clone());
    }
    let _ = app.emit("pipeline-error", err);
}

/// Clear the retained pipeline error after a successful (re)start.
fn clear_pipeline_error(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        *state.pipeline_error.lock().unwrap() = None;
    }
}

// event payloads

/// phase-1 notification, emitted ~150-250ms after the hotkey, before title
/// and path exist; overlay shows a spinner until phase 2 fills them in.
#[derive(Clone, Serialize)]
struct ClipSavingPayload {
    thumbnail: Option<String>,
    rename_hotkey: String,
    auto_dismiss_secs: u32,
    corner: String,
    sound: bool,
    /// mirrors `clipdip_profile::enabled()` so the overlay emits phase-timing logs too
    profile: bool,
    /// `"clip"` or `"recording"`; overlay words its messages accordingly
    kind: String,
}

/// Transient toast with no save flow attached ("Recording started").
/// The overlay shows the message and auto-dismisses after a few seconds.
#[derive(Clone, Serialize)]
struct NoticePayload {
    message: String,
    corner: String,
    /// auto-dismiss override in ms; 0 keeps the overlay's default short duration
    duration_ms: u32,
}

/// rich hint card; `kind` picks accent+icon (info/tip/education/warning/success/discord
/// unknown falls back to info). Shown via [`show_hint`] only.
#[derive(Clone, Serialize)]
struct HintPayload {
    kind: String,
    /// One line, ~40 chars max.
    title: String,
    /// Optional body line. Tiny markup: `**text**` renders an accent
    /// span, `[[Ctrl+F10]]` renders hotkey chips. Empty = title only.
    sub: String,
    /// Auto-dismiss in ms; 0 = overlay default (8 s), floored at 5 s.
    duration_ms: u32,
    /// The rename hotkey, rendered as the card's dismiss chips.
    dismiss_hotkey: String,
    corner: String,
}

/// "update available" toast, shown when the settings window is closed;
/// tells the user to open the app where the banner does the 2-click install.
#[derive(Clone, Serialize)]
struct UpdatePayload {
    version: String,
    corner: String,
    /// rename hotkey doubles as "update now" while the toast is up (rendered as kbd chips)
    hotkey: String,
    /// `"available"` (update found, prompt to act) or `"installed"`
    /// (post-restart confirmation after a silent hotkey update).
    kind: String,
}

/// phase-2 payload once the mux finishes; overlay swaps spinner for pip
/// reveals title + rename input, and only now lets the rename hotkey focus it.
#[derive(Clone, Serialize)]
struct ClipSavedPayload {
    path: String,
    title: String,
    /// Same convention as [`ClipSavingPayload::kind`].
    kind: String,
}

#[derive(Clone, Serialize)]
struct ClipRenamedPayload {
    old_path: String,
    new_path: String,
    new_title: String,
}

// overlay window management

/// `BottomRight` to `"bottom_right"`, the corner format the overlay CSS uses.
fn corner_slug(corner: &clipdip_core::config::NotificationCorner) -> String {
    format!("{:?}", corner)
        .chars()
        .fold(String::new(), |mut acc, c| {
            if c.is_uppercase() && !acc.is_empty() {
                acc.push('_');
            }
            acc.push(c.to_ascii_lowercase());
            acc
        })
}

/// disables WebView2 form autofill; HTML `autocomplete` hints don't stop
/// Edge's general autofill dropdown, only the engine-level setting does.
fn disable_webview_autofill(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(|webview| {
        #[cfg(windows)]
        unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
            use windows_core_061::Interface as _;
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let Ok(settings) = core.Settings() else { return };
            if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
                let _ = s4.SetIsGeneralAutofillEnabled(false);
                let _ = s4.SetIsPasswordAutosaveEnabled(false);
            }
        }
    });
}

/// creates (or repositions + shows, if it exists) the transparent overlay
/// window. Called per-hotkey, not at startup, so WebView2 stays dead while idle.
fn ensure_overlay_window(app: &AppHandle, corner: &str) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.set_ignore_cursor_events(true);
        exclude_from_capture(&w);
        let _ = w.show();
        return Some(w);
    }
    let monitor = app.primary_monitor().ok().flatten()?;
    let (mw, mh) = (monitor.size().width, monitor.size().height);
    // overlay.html is plain HTML/CSS/JS, no React/Tailwind/module graph (the
    // settings UI uses index.html); shaves most of WebView2 cold-start time.
    let url = format!("overlay.html?corner={}", corner);
    let w = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App(url.into()))
        .inner_size(mw as f64, mh as f64)
        .position(0.0, 0.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        // build hidden, disable DWM transitions, then show, else Windows plays a
        // scale-up animation that competes with the React enter animation.
        .visible(false)
        .resizable(false)
        .initialization_script(CONSOLE_SCRIPT)
        .build()
        .ok()?;
    let _ = w.set_ignore_cursor_events(true);
    if let Ok(hwnd) = w.hwnd() {
        // tauri uses windows 0.61, we pin 0.58 workspace-wide for COM-ABI
        // consistency; HWND types differ but share layout, bridge via raw pointer.
        disable_window_transitions(HWND(hwnd.0 as *mut _));
    }
    exclude_from_capture(&w);
    disable_webview_autofill(&w);
    let _ = w.show();

    // boot watchdog: a fresh overlay must call `overlay_get_pending` within 6s
    // or its page failed to load (dev server down, WebView2 wedged). force-destroy
    // it so a broken load can't leave a stuck error page onscreen; never fires
    // in the installed build, purely a safety net.
    if let Some(state) = app.try_state::<AppState>() {
        use std::sync::atomic::Ordering;
        state.overlay_booted.store(false, Ordering::SeqCst);
        let booted = Arc::clone(&state.overlay_booted);
        let app2 = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(6));
            if !booted.load(Ordering::SeqCst) {
                warn!("overlay webview did not load within 6s — closing it to avoid a stuck overlay");
                if let Some(w) = app2.get_webview_window("overlay") {
                    let _ = w.destroy();
                }
                if let Some(state) = app2.try_state::<AppState>() {
                    *state.pending_saving.lock().unwrap() = None;
                    *state.pending_saved.lock().unwrap() = None;
                    *state.pending_notice.lock().unwrap() = None;
                    *state.pending_update.lock().unwrap() = None;
                }
            }
        });
    }
    Some(w)
}

/// excludes the overlay from screen capture (DXGI, gdigrab) so the toast/dot
/// never photobomb clips. Windows 10 2004+; failure just makes it visible again.
fn exclude_from_capture(w: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };
    if let Ok(hwnd) = w.hwnd() {
        unsafe {
            let _ = SetWindowDisplayAffinity(HWND(hwnd.0 as *mut _), WDA_EXCLUDEFROMCAPTURE);
        }
    }
}

/// kills the overlay after a save failure; guarantees teardown even if the
/// error fires before React's listener attaches (Tauri drops unlistened events)
/// and clears the pending stashes so a fresh mount can't hydrate the dead session.
fn tear_down_overlay(app: &AppHandle, err: String) {
    record_notification("error", "Clip save failed", &err);
    if let Some(state) = app.try_state::<AppState>() {
        *state.pending_saving.lock().unwrap() = None;
        *state.pending_saved.lock().unwrap() = None;
        *state.pending_notice.lock().unwrap() = None;
        *state.pending_update.lock().unwrap() = None;
        *state.pending_hint.lock().unwrap() = None;
        state
            .update_toast_active
            .store(false, std::sync::atomic::Ordering::SeqCst);
        state
            .hint_active
            .store(false, std::sync::atomic::Ordering::SeqCst);
        *state.active_clip.lock().unwrap() = None;
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.emit("clip-error", err);
        let _ = overlay.destroy();
    }
}

// notification history

/// one shown notification, kept so the user can look up what an
/// auto-dismissing toast said (Focus Assist eats native toasts in fullscreen).
#[derive(Clone, Serialize, serde::Deserialize)]
struct NotificationRecord {
    /// Unix epoch milliseconds when the notification was shown.
    at_ms: u64,
    /// `"health"`, `"clip"`, `"recording"`, `"notice"`, `"hint"`, or
    /// `"error"`.
    kind: String,
    title: String,
    #[serde(default)]
    body: String,
}

const NOTIFICATION_HISTORY_CAP: usize = 200;

fn notification_history_path() -> Option<PathBuf> {
    clipdip_diagnostics::paths::data_dir().map(|d| d.join("notification-history.json"))
}

/// in-memory history hydrated from disk on first use; one mutex, writes
/// rewrite the whole small capped file for trivial consistency.
fn notification_history() -> &'static Mutex<Vec<NotificationRecord>> {
    static HISTORY: std::sync::OnceLock<Mutex<Vec<NotificationRecord>>> =
        std::sync::OnceLock::new();
    HISTORY.get_or_init(|| {
        let loaded = notification_history_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Vec<NotificationRecord>>(&s).ok())
            .unwrap_or_default();
        Mutex::new(loaded)
    })
}

/// Append one record and persist. Failure to persist only costs history
/// across a restart, never the notification itself.
fn record_notification(kind: &str, title: &str, body: &str) {
    let at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut h = notification_history().lock().unwrap();
    h.push(NotificationRecord {
        at_ms,
        kind: kind.to_string(),
        title: title.to_string(),
        body: body.to_string(),
    });
    let len = h.len();
    if len > NOTIFICATION_HISTORY_CAP {
        h.drain(..len - NOTIFICATION_HISTORY_CAP);
    }
    if let Some(path) = notification_history_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match serde_json::to_string(&*h) {
            Ok(json) => {
                if let Err(e) = std::fs::write(&path, json) {
                    warn!("notification history write failed: {e:#}");
                }
            }
            Err(e) => warn!("notification history serialize failed: {e:#}"),
        }
    }
}

/// Newest-first history for the settings UIs.
#[tauri::command]
fn get_notification_history() -> Vec<NotificationRecord> {
    let mut h = notification_history().lock().unwrap().clone();
    h.reverse();
    h
}

// tauri commands

#[derive(serde::Serialize)]
struct AutostartInfo {
    enabled: bool,
    is_dev: bool,
}

#[tauri::command]
fn get_autostart_info() -> Result<AutostartInfo, String> {
    let is_dev = cfg!(debug_assertions);
    if is_dev {
        return Ok(AutostartInfo {
            enabled: false,
            is_dev: true,
        });
    }

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Failed to get current executable path: {}", e))?;
    let exe_path_str = exe_path.to_string_lossy().to_string();

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // checks both the current name and pre-rebrand "ClipDip" so an install from
    // before the rename still reports enabled until migrated by the next toggle.
    let mut enabled = false;
    for value_name in ["ClipLib", "ClipDip"] {
        let mut cmd = Command::new("reg");
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.args(&[
            "query",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "/v",
            value_name,
        ]);
        if let Ok(output) = cmd.output() {
            if output.status.success()
                && String::from_utf8_lossy(&output.stdout).contains(&exe_path_str)
            {
                enabled = true;
                break;
            }
        }
    }

    Ok(AutostartInfo {
        enabled,
        is_dev: false,
    })
}

#[tauri::command]
fn set_autostart_status(enabled: bool) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Autostart cannot be enabled in development mode.".into());
    }

    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Failed to get current executable path: {}", e))?;
    let exe_path_str = format!("\"{}\"", exe_path.to_string_lossy());

    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // drop the pre-rebrand "ClipDip" value too so toggling never leaves two entries.
    let mut legacy = Command::new("reg");
    legacy.creation_flags(CREATE_NO_WINDOW);
    legacy.args(&[
        "delete",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "/v",
        "ClipDip",
        "/f",
    ]);
    let _ = legacy.output();

    let mut cmd = Command::new("reg");
    cmd.creation_flags(CREATE_NO_WINDOW);

    if enabled {
        cmd.args(&[
            "add",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "/v",
            "ClipLib",
            "/t",
            "REG_SZ",
            "/d",
            &exe_path_str,
            "/f",
        ]);
    } else {
        cmd.args(&[
            "delete",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "/v",
            "ClipLib",
            "/f",
        ]);
    }

    let output = cmd.output().map_err(|e| format!("Failed to run reg: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Registry operation failed: {}", stderr));
    }

    Ok(())
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = clipdip_core::config::Config::load_or_default(&state.config_path)
        .map_err(|e| e.to_string())?;
    serde_json::to_value(cfg).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_config(config: serde_json::Value, state: State<'_, AppState>) -> Result<(), String> {
    let mut cfg: clipdip_core::config::Config =
        serde_json::from_value(config).map_err(|e| e.to_string())?;
    // telemetry is owned by `set_telemetry_enabled`; preserve the on-disk value
    // so this general save can't clobber the opt-out toggle with a stale UI value.
    if let Ok(existing) = clipdip_core::config::Config::load_or_default(&state.config_path) {
        cfg.telemetry = existing.telemetry;
    }
    cfg.save(&state.config_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_clip(
    old_path: String,
    new_name: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let old = std::path::Path::new(&old_path);
    let dir = old.parent().ok_or("no parent directory")?;
    let ext = old.extension().unwrap_or_default();

    let safe: String = new_name
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim().to_string();
    if safe.is_empty() {
        return Err("name cannot be empty".into());
    }

    let new_path = dir.join(format!("{}.{}", safe, ext.to_string_lossy()));
    std::fs::rename(&old, &new_path).map_err(|e| e.to_string())?;

    let new_path_str = new_path.to_string_lossy().to_string();
    *state.active_clip.lock().unwrap() = Some(new_path_str.clone());

    let _ = app.emit(
        "clip-renamed",
        ClipRenamedPayload {
            old_path,
            new_path: new_path_str.clone(),
            new_title: safe,
        },
    );
    Ok(new_path_str)
}

/// enables/disables click-through on the overlay; enabling also focuses the
/// window so it receives keyboard events.
#[tauri::command]
fn set_overlay_input_mode(enabled: bool, app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("overlay") {
        w.set_ignore_cursor_events(!enabled)
            .map_err(|e| e.to_string())?;
        if enabled {
            let _ = w.set_focus();
        }
    }
    Ok(())
}

/// plays the save chirp; overlay calls this exactly when its "saved" animation
/// starts so audio/visuals land together regardless of WebView2 cold-start races.
#[tauri::command]
fn play_saved_sound() {
    std::thread::spawn(play_save_sound);
}

#[tauri::command]
fn dismiss_notification(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.active_clip.lock().unwrap() = None;
    *state.pending_saving.lock().unwrap() = None;
    *state.pending_saved.lock().unwrap() = None;
    *state.pending_notice.lock().unwrap() = None;
    *state.pending_update.lock().unwrap() = None;
    *state.pending_hint.lock().unwrap() = None;
    state
        .update_toast_active
        .store(false, std::sync::atomic::Ordering::SeqCst);
    state
        .hint_active
        .store(false, std::sync::atomic::Ordering::SeqCst);
    // keep the overlay alive during a manual recording (for the red dot); the
    // card has already slid out on the JS side.
    if *state.recording_active.lock().unwrap() {
        return Ok(());
    }
    if let Some(w) = app.get_webview_window("overlay") {
        // destroy, not hide: hide() keeps WebView2 alive as a visible process in Task Manager.
        let _ = w.destroy();
    }
    Ok(())
}

/// combined phase-1/phase-2 stash so a late-mounting overlay hydrates to the
/// right phase; `None` means not fired yet, or already consumed.
#[derive(Clone, Serialize)]
struct PendingState {
    saving: Option<ClipSavingPayload>,
    saved: Option<ClipSavedPayload>,
    notice: Option<NoticePayload>,
    update: Option<UpdatePayload>,
    hint: Option<HintPayload>,
    recording: bool,
}

/// returns whatever clip-saving/saved payloads were stashed before the overlay
/// mounted; Tauri drops unlistened events and WebView2 cold-start can outrun the save flow.
#[tauri::command]
fn overlay_get_pending(state: State<'_, AppState>) -> PendingState {
    // proves the page loaded; clears the boot watchdog so it won't force-close a healthy overlay.
    state
        .overlay_booted
        .store(true, std::sync::atomic::Ordering::SeqCst);
    PendingState {
        saving: state.pending_saving.lock().unwrap().clone(),
        saved: state.pending_saved.lock().unwrap().clone(),
        notice: state.pending_notice.lock().unwrap().clone(),
        update: state.pending_update.lock().unwrap().clone(),
        hint: state.pending_hint.lock().unwrap().clone(),
        recording: *state.recording_active.lock().unwrap(),
    }
}

/// fake overlay flow for smoke testing (stage: flow/notice/hint/update/rec_on/rec_off).
/// must be async: a sync command building a window here deadlocks the main thread on Windows.
#[tauri::command]
async fn test_overlay(
    app: AppHandle,
    state: State<'_, AppState>,
    stage: String,
) -> Result<(), String> {
    let cfg = clipdip_core::config::Config::load_or_default(&state.config_path)
        .map_err(|e| e.to_string())?;
    if !cfg.notifications.enabled {
        return Err("notifications are disabled in config".into());
    }
    let corner = corner_slug(&cfg.notifications.corner);

    match stage.as_str() {
        "flow" => {
            let saving_payload = ClipSavingPayload {
                thumbnail: None,
                rename_hotkey: format!("Press {} to rename", cfg.hotkey.rename_clip),
                auto_dismiss_secs: cfg.notifications.auto_dismiss_secs,
                corner: corner.clone(),
                sound: cfg.notifications.sound,
                profile: false,
                kind: "clip".into(),
            };

            *state.pending_saving.lock().unwrap() = Some(saving_payload.clone());
            *state.pending_saved.lock().unwrap() = None;
            *state.pending_notice.lock().unwrap() = None;

            // no chirp here, the overlay calls `play_saved_sound` when its saved animation shows.

            if let Some(overlay) = ensure_overlay_window(&app, &corner) {
                let _ = overlay.emit("clip-saving", saving_payload);
            }

            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(900));
                let saved = ClipSavedPayload {
                    path: "C:\\Users\\Demo\\Videos\\Clipdip\\demo_clip.mp4".into(),
                    title: "demo_clip".into(),
                    kind: "clip".into(),
                };
                if let Some(state) = app2.try_state::<AppState>() {
                    *state.pending_saved.lock().unwrap() = Some(saved.clone());
                }
                if let Some(overlay) = app2.get_webview_window("overlay") {
                    let _ = overlay.emit("clip-saved", saved);
                }
            });
        }
        "notice" => {
            let notice = NoticePayload {
                message: "Recording started".into(),
                corner: corner.clone(),
                duration_ms: 0,
            };
            *state.pending_notice.lock().unwrap() = Some(notice.clone());
            *state.pending_saving.lock().unwrap() = None;
            *state.pending_saved.lock().unwrap() = None;
            if let Some(overlay) = ensure_overlay_window(&app, &corner) {
                let _ = overlay.emit("overlay-notice", notice);
            }
        }
        // "hint" previews discord; "hint:<kind>" (e.g. "hint:warning") previews others.
        s if s == "hint" || s.starts_with("hint:") => {
            let kind = s.strip_prefix("hint:").unwrap_or("discord");
            *state.pending_saving.lock().unwrap() = None;
            *state.pending_saved.lock().unwrap() = None;
            *state.pending_notice.lock().unwrap() = None;
            show_hint(
                &app,
                kind,
                "Discord keeps asking to connect",
                "Turn off **voice capture** in settings, or ask on our Discord for a whitelist invite",
                "Preview hint (test_overlay).",
                10_000,
            );
        }
        "update" | "updated" => {
            let payload = UpdatePayload {
                version: "9.9.9".into(),
                corner: corner.clone(),
                hotkey: cfg.hotkey.rename_clip.clone(),
                kind: if stage == "updated" { "installed" } else { "available" }.into(),
            };
            *state.pending_update.lock().unwrap() = Some(payload.clone());
            *state.pending_saving.lock().unwrap() = None;
            *state.pending_saved.lock().unwrap() = None;
            *state.pending_notice.lock().unwrap() = None;
            if let Some(overlay) = ensure_overlay_window(&app, &corner) {
                if stage == "update" {
                    state
                        .update_toast_active
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                }
                let _ = overlay.emit("update-available", payload);
            }
        }
        "rec_on" | "rec_off" => {
            let on = stage == "rec_on";
            // mirror the real recording flow's UI state so the dot survives re-mounts
            *state.recording_active.lock().unwrap() = on;
            if on {
                if let Some(overlay) = ensure_overlay_window(&app, &corner) {
                    let _ = overlay
                        .emit("recording-state", serde_json::json!({"recording": true}));
                }
            } else if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay.emit("recording-state", serde_json::json!({"recording": false}));
                // no toast and the dot just went away, drop the window like the real flow does.
                let no_toast = state.pending_saving.lock().unwrap().is_none()
                    && state.pending_saved.lock().unwrap().is_none()
                    && state.pending_notice.lock().unwrap().is_none()
                    && state.pending_update.lock().unwrap().is_none();
                if no_toast {
                    let _ = overlay.destroy();
                }
            }
        }
        other => return Err(format!("unknown overlay test stage '{other}'")),
    }
    Ok(())
}

/// back-compat alias for the devtools `testNotification()` global, previews the full save flow.
#[tauri::command]
async fn test_notification(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    test_overlay(app, state, "flow".into()).await
}

// auto-update

/// update found but not installed; settings window queries this on mount so
/// the banner shows without waiting for the next 30s tick.
#[tauri::command]
fn get_pending_update(state: State<'_, AppState>) -> Option<UpdatePayload> {
    state.pending_update.lock().unwrap().clone()
}

/// surfaces a new update: settings window (if open) gets the in-app banner;
/// else the overlay toasts once per version (the checker re-fires every 30s).
fn notify_update_available(app: &AppHandle, version: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };

    let cfg = clipdip_core::config::Config::load_or_default(&state.config_path)
        .unwrap_or_default();
    let payload = UpdatePayload {
        version: version.to_string(),
        corner: corner_slug(&cfg.notifications.corner),
        hotkey: cfg.hotkey.rename_clip.clone(),
        kind: "available".into(),
    };
    *state.pending_update.lock().unwrap() = Some(payload.clone());

    // settings window open: the banner handles it, no overlay toast.
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("update-available", payload.clone());
        if main.is_visible().unwrap_or(false) {
            return;
        }
    }

    // Only toast the overlay once per version.
    {
        let mut shown = state.update_toast_shown.lock().unwrap();
        if shown.as_deref() == Some(version) {
            return;
        }
        *shown = Some(version.to_string());
    }

    // don't steal the overlay from an in-flight save toast; the stash is set
    // so the banner still shows next time the app opens.
    let busy = state.pending_saving.lock().unwrap().is_some()
        || state.pending_saved.lock().unwrap().is_some();
    if busy {
        return;
    }

    info!("update v{version} available — showing overlay toast");
    if let Some(overlay) = ensure_overlay_window(app, &payload.corner) {
        state
            .update_toast_active
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = overlay.emit("update-available", payload);
    }
}

/// post-restart "Updated to vX" toast after a silent hotkey update; triggered
/// by the marker file `start_silent_update` leaves behind.
fn notify_updated(app: &AppHandle, version: &str) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let cfg = clipdip_core::config::Config::load_or_default(&state.config_path)
        .unwrap_or_default();
    let payload = UpdatePayload {
        version: version.to_string(),
        corner: corner_slug(&cfg.notifications.corner),
        hotkey: String::new(),
        kind: "installed".into(),
    };
    // Never bump an in-flight save toast for a pure confirmation.
    let busy = state.pending_saving.lock().unwrap().is_some()
        || state.pending_saved.lock().unwrap().is_some();
    if busy {
        return;
    }
    *state.pending_update.lock().unwrap() = Some(payload.clone());
    info!("showing post-update toast for v{version}");
    if let Some(overlay) = ensure_overlay_window(app, &payload.corner) {
        let _ = overlay.emit("update-available", payload);
    }
}

/// marker file (target version) the silent updater writes before installing;
/// next launch shows the toast if the running version matches.
fn updated_marker_path(config_path: &std::path::Path) -> Option<PathBuf> {
    config_path.parent().map(|p| p.join("updated-toast.marker"))
}

/// downloads+installs the pending update after the toast's hotkey press;
/// overlay shows "Updating..." until quiet NSIS restarts the app.
fn start_silent_update(app: AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri_plugin_updater::UpdaterExt;

    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if state
        .update_installing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    info!("silent update triggered from overlay hotkey");
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.emit("update-installing", ());
    }

    std::thread::spawn(move || {
        let fail = |e: String, version: Option<&str>| {
            warn!("silent update failed: {e}");
            clipdip_diagnostics::report_error(
                "update_install_failed",
                format!("silent update failed: {e}"),
                Some(serde_json::json!({ "target_version": version })),
            );
            if let Some(state) = app.try_state::<AppState>() {
                state.update_installing.store(false, Ordering::SeqCst);
            }
            if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay.emit("update-error", e);
            }
        };
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => return fail(e.to_string(), None),
        };
        let update = match tauri::async_runtime::block_on(updater.check()) {
            Ok(Some(u)) => u,
            Ok(None) => return fail("update no longer available".into(), None),
            Err(e) => return fail(e.to_string(), None),
        };
        // marker before install: next launch toasts "updated" only if the running version matches it.
        if let Some(state) = app.try_state::<AppState>() {
            if let Some(marker) = updated_marker_path(&state.config_path) {
                let _ = std::fs::write(marker, &update.version);
            }
        }
        info!("downloading update v{} for silent install", update.version);
        // session ends here: NSIS may kill us before the restart below runs, no later hook exists.
        // bounded ~2s.
        clipdip_diagnostics::session_end("update");
        match tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
            Ok(()) => {
                // quiet NSIS usually kills + relaunches us itself; restart is the fallback if still alive.
                info!("silent update installed — restarting");
                app.restart();
            }
            Err(e) => fail(e.to_string(), Some(&update.version)),
        }
    });
}

/// self-updating is retired: clipdip ships inside ClipLib and updates in
/// lockstep with it, so a self-update would drift its config schema. Flip only for a standalone build.
const SELF_UPDATER_ENABLED: bool = false;

fn spawn_update_checker(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    if !SELF_UPDATER_ENABLED {
        info!("self-updater disabled (ClipLib manages clipdip updates)");
        return;
    }

    let forced = matches!(
        std::env::var("CLIPDIP_FORCE_UPDATE_CHECK").as_deref(),
        Ok("1") | Ok("true")
    );
    if cfg!(debug_assertions) && !forced {
        info!("auto-update checker disabled in dev build");
        return;
    }

    const CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
    std::thread::spawn(move || loop {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                warn!("updater unavailable, auto-update checks disabled: {e}");
                return;
            }
        };
        match tauri::async_runtime::block_on(updater.check()) {
            Ok(Some(update)) => notify_update_available(&app, &update.version),
            Ok(None) => {}
            // transient network failures are expected, keep polling.
            Err(e) => debug!("update check failed: {e}"),
        }
        std::thread::sleep(CHECK_INTERVAL);
    });
}

#[tauri::command]
fn list_audio_devices() -> Result<Vec<clipdip_audio::AudioDeviceInfo>, String> {
    clipdip_audio::list_devices().map_err(|e| format!("{e:#}"))
}

/// The filename-template variables reference, for the settings UI.
#[derive(Clone, Serialize)]
struct FilenameVariableInfo {
    token: String,
    description: String,
    example: String,
}

#[tauri::command]
fn get_filename_variables() -> Vec<FilenameVariableInfo> {
    clipdip_core::filename::VARIABLES
        .iter()
        .map(|v| FilenameVariableInfo {
            token: v.token.into(),
            description: v.description.into(),
            example: v.example.into(),
        })
        .collect()
}

/// expands a template with sample values + the current clock for the
/// settings UI's live preview.
#[tauri::command]
fn preview_filename(template: String) -> String {
    let vars = clipdip_core::filename::FilenameVars {
        app_name: Some("VALORANT".into()),
        window_title: Some("VALORANT".into()),
        kind: "Clip",
    };
    clipdip_core::filename::expand(&template, &vars)
}

#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<serde_json::Value> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, m)| {
            serde_json::json!({
                "index": i,
                "name": m.name().map(|s| s.to_string()).unwrap_or_default(),
                "width": m.size().width,
                "height": m.size().height,
            })
        })
        .collect()
}

#[tauri::command]
fn forward_console(window_label: String, level: String, msg: String) {
    match level.as_str() {
        "error" => tracing::error!(target: "js", "[{window_label}] {msg}"),
        "warn"  => tracing::warn!(target: "js", "[{window_label}] {msg}"),
        _       => tracing::info!(target: "js", "[{window_label}] {msg}"),
    }
}

/// structured frontend failure reports; the only webview-writable telemetry
/// surface, so locked down: allowlisted codes, scrubbed message, rate-gated on top of JS-side dedupe.
#[tauri::command]
fn report_frontend_event(
    window_label: String,
    code: String,
    message: String,
    context: Option<serde_json::Value>,
) {
    let (kind, severity) = match code.as_str() {
        "js_uncaught_error" | "js_unhandled_rejection" => {
            (clipdip_diagnostics::EventKind::Error, clipdip_diagnostics::Severity::Error)
        }
        "overlay_saving_timeout" => (
            clipdip_diagnostics::EventKind::CaptureFailure,
            clipdip_diagnostics::Severity::Error,
        ),
        _ => return, // unknown codes are dropped, not forwarded
    };
    let fingerprint = context
        .as_ref()
        .and_then(|c| c.get("fingerprint"))
        .and_then(|f| f.as_str())
        .map(str::to_string);
    let gate_key = format!("{code}:{}", fingerprint.as_deref().unwrap_or(""));
    let clipdip_diagnostics::Gate::Send { suppressed } =
        clipdip_diagnostics::gate(&gate_key, std::time::Duration::from_secs(60))
    else {
        return;
    };
    let mut context = context.unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = context.as_object_mut() {
        obj.insert("window".into(), window_label.into());
        obj.insert("occurrences".into(), (suppressed + 1).into());
    }
    if let Some(d) = clipdip_diagnostics::global() {
        d.report(clipdip_diagnostics::Event {
            kind,
            code: Some(code),
            message: Some(clipdip_diagnostics::scrub_user_paths(&message)),
            context: Some(context),
            attach_log: true,
            severity,
            fingerprint,
        });
    }
}

#[tauri::command]
fn get_pipeline_running(state: State<'_, AppState>) -> bool {
    *state.pipeline_running.lock().unwrap()
}

/// asks the capture loop to restart so changed capture settings take effect;
/// async, `pipeline-status` events report the result.
#[tauri::command]
fn restart_pipeline(state: State<'_, AppState>) -> Result<(), String> {
    state
        .loop_tx
        .send(LoopEvent::Restart)
        .map_err(|e| e.to_string())
}

/// re-registers global hotkeys from saved config; cheap, replay buffer keeps running.
#[tauri::command]
fn reload_hotkeys(state: State<'_, AppState>) -> Result<(), String> {
    state
        .loop_tx
        .send(LoopEvent::ReloadHotkeys)
        .map_err(|e| e.to_string())
}

/// live size estimate for the settings UI: real encoded video bytes over the
/// buffered span, plus audio tracks' AAC bitrate at save time.
#[derive(Clone, Serialize, Default)]
struct BufferStats {
    /// `false` while there's no pipeline or under ~3s of footage buffered
    /// (the other fields are zero in that case).
    measuring: bool,
    mb_per_minute: f64,
    /// `mb_per_minute` scaled to what a clip saved now would cover: the replay
    /// window, or the shorter buffered span while filling/memory-limited.
    clip_mb: f64,
    buffered_secs: f64,
    /// true when the replay window is truncated by the ring's memory ceiling;
    /// settings UIs switch to honest copy on this.
    memory_limited: bool,
    /// Total ring occupancy (all streams incl. raw PCM audio), MB.
    bytes_used_mb: f64,
    /// The ring's memory ceiling, MB.
    budget_mb: f64,
}

#[tauri::command]
fn get_buffer_stats(state: State<'_, AppState>) -> BufferStats {
    let ring = state.ring.lock().unwrap().clone();
    let Some(ring) = ring else {
        return BufferStats::default();
    };
    let s = ring.stats();
    let span_secs = s.video_span_100ns as f64 / 1e7;
    if span_secs < 3.0 {
        return BufferStats::default();
    }
    let cfg = clipdip_core::config::Config::load_or_default(&state.config_path)
        .unwrap_or_default();
    let video_bytes_per_sec = s.video_bytes as f64 / span_secs;
    let sources = cfg
        .audio
        .sources
        .iter()
        .filter(|s| {
            !matches!(
                s,
                clipdip_core::config::AudioSource::ProcessLoopback { .. }
            )
        })
        .count();
    let audio_streams = sources + usize::from(cfg.audio.include_mix && sources >= 2);
    let audio_bytes_per_sec = audio_streams as f64 * cfg.output.audio_bitrate_bps as f64 / 8.0;
    let mb_per_minute = (video_bytes_per_sec + audio_bytes_per_sec) * 60.0 / 1_000_000.0;
    // same predicates the health monitor uses on RingStats, plus a span gate:
    // only claim memory-limited while under the configured window.
    let window_100ns = cfg.replay_seconds as i64 * 10_000_000;
    let memory_limited = s.pressure_recent(window_100ns)
        && s.past_hold_grace(window_100ns)
        && span_secs + 3.0 < cfg.replay_seconds as f64;
    BufferStats {
        measuring: true,
        mb_per_minute,
        clip_mb: mb_per_minute * span_secs.min(cfg.replay_seconds as f64) / 60.0,
        buffered_secs: span_secs,
        memory_limited,
        bytes_used_mb: s.bytes_used as f64 / 1_000_000.0,
        budget_mb: s.byte_budget as f64 / 1_000_000.0,
    }
}

#[tauri::command]
fn open_clips_folder(state: State<'_, AppState>) -> Result<(), String> {
    let cfg = clipdip_core::config::Config::load_or_default(&state.config_path)
        .map_err(|e| e.to_string())?;
    Command::new("explorer")
        .arg(cfg.output.directory.to_string_lossy().as_ref())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// discord commands

/// Current Discord connection state for the settings UI (serialized
/// [`clipdip_discord::DiscordStatus`]).
#[tauri::command]
fn discord_status(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::to_value(state.discord.status()).unwrap_or(serde_json::Value::Null)
}

/// begins the one-time authorization (consent popup in the user's Discord
/// client); silent-refresh keeps it connected afterward.
#[tauri::command]
fn discord_connect(state: State<'_, AppState>) {
    state.discord.connect();
}

/// Forget the stored token; the manager drops back to needs-authorization.
#[tauri::command]
fn discord_disconnect(state: State<'_, AppState>) {
    state.discord.disconnect();
}

/// The current voice-call roster (for a live preview in settings), or null
/// if not in a call / not connected.
#[tauri::command]
fn discord_current_roster(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::to_value(state.discord.roster()).unwrap_or(serde_json::Value::Null)
}

// diagnostics commands

/// Telemetry state for the settings UI: whether the opt-out toggle is on, and
/// whether this build can actually report (an ingest key was compiled in).
#[tauri::command]
fn get_telemetry_status(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({
        "enabled": state.diagnostics.is_enabled(),
        "configured": state.diagnostics.is_configured(),
        "install_id": state.diagnostics.install_id(),
    })
}

/// Flip the opt-out switch. Persists to config and tells the running client to
/// start/stop reporting immediately.
#[tauri::command]
fn set_telemetry_enabled(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    let mut cfg = clipdip_core::config::Config::load_or_default(&state.config_path)
        .map_err(|e| format!("load config: {e:#}"))?;
    cfg.telemetry.enabled = enabled;
    cfg.save(&state.config_path)
        .map_err(|e| format!("save config: {e:#}"))?;
    state.diagnostics.set_enabled(enabled);
    info!("telemetry {}", if enabled { "enabled" } else { "disabled" });
    Ok(())
}

/// Build and upload a diagnostic bundle now. Returns the server-assigned bundle
/// id on success. Blocks on the network call (runs on Tauri's command thread).
#[tauri::command]
fn upload_diagnostics_bundle(
    note: Option<String>,
    state: State<'_, AppState>,
) -> Result<i64, String> {
    state.diagnostics.upload_bundle_manual(note)
}

// capture loop

#[derive(Clone, Copy)]
enum LoopEvent {
    Save,
    Rename,
    ToggleRecording,
    /// tears down + restarts the pipeline with fresh config; sent by
    /// `restart_pipeline` since encoder options only apply at start
    Restart,
    /// same teardown/restart, but from the health monitor after the video
    /// thread died; storm-guarded so broken capture can't loop-restart
    RestartAfterFailure,
    /// WASAPI endpoint topology changed (plug/unplug/default switch);
    /// debounced from the device watcher, restarts only if it'd improve a source
    AudioDevicesChanged,
    /// re-registers global hotkeys from fresh config; sent by `reload_hotkeys`
    /// so an edited hotkey applies without restarting the pipeline
    ReloadHotkeys,
    /// global Escape; only acted on while the update toast is up, dismisses it instantly
    UpdateEscape,
}

/// what the shared save flow is saving (replay clip vs a just-stopped
/// recording); picks the pipeline call and overlay wording.
#[derive(Clone, Copy, PartialEq)]
enum SaveKind {
    Clip,
    Recording,
}

impl SaveKind {
    fn as_str(self) -> &'static str {
        match self {
            SaveKind::Clip => "clip",
            SaveKind::Recording => "recording",
        }
    }
}

/// spawns one Raw Input listener for all hotkeys: RegisterRawInputDevices
/// allows only one registration per device type per process, so multiple listeners would silently
/// discard all but the last.
fn spawn_hotkey_listener(
    cfg: &clipdip_core::config::Config,
    ev_tx: &crossbeam_channel::Sender<LoopEvent>,
    app: &AppHandle,
) -> Option<clipdip_hotkey::HotkeyListener> {
    info!(
        "hotkeys — save: {}  rename: {}  record: {}",
        cfg.hotkey.save_clip, cfg.hotkey.rename_clip, cfg.hotkey.toggle_recording
    );

    let mut binding_events: Vec<LoopEvent> = Vec::new();
    let mut binding_defs: Vec<clipdip_hotkey::HotkeyBinding> = Vec::new();
    for (name, s, event) in [
        ("save", &cfg.hotkey.save_clip, LoopEvent::Save),
        ("rename", &cfg.hotkey.rename_clip, LoopEvent::Rename),
        ("record", &cfg.hotkey.toggle_recording, LoopEvent::ToggleRecording),
    ] {
        match clipdip_hotkey::HotkeyBinding::parse(s) {
            Ok(b) => {
                binding_events.push(event);
                binding_defs.push(b);
            }
            Err(e) => warn!("{name} hotkey parse failed: {e:#}"),
        }
    }
    // global Escape, only acted on while the update toast is up (loop handler gates it).
    match clipdip_hotkey::HotkeyBinding::parse("Esc") {
        Ok(b) => {
            binding_events.push(LoopEvent::UpdateEscape);
            binding_defs.push(b);
        }
        Err(e) => warn!("esc binding parse failed: {e:#}"),
    }
    if binding_defs.is_empty() {
        // all hotkeys failed to parse, app becomes a dead tray icon; report which
        // binding but not the strings (config content, stays local).
        clipdip_diagnostics::report_error(
            "hotkeys_all_invalid",
            "all configured hotkeys failed to parse — no hotkeys registered",
            Some(serde_json::json!({
                "save_valid": clipdip_hotkey::HotkeyBinding::parse(&cfg.hotkey.save_clip).is_ok(),
                "rename_valid": clipdip_hotkey::HotkeyBinding::parse(&cfg.hotkey.rename_clip).is_ok(),
                "record_valid": clipdip_hotkey::HotkeyBinding::parse(&cfg.hotkey.toggle_recording).is_ok(),
            })),
        );
        return None;
    }

    match clipdip_hotkey::HotkeyListener::spawn(&binding_defs) {
        Ok((listener, rxs)) => {
            info!("hotkey listener spawned ok ({} binding(s))", binding_defs.len());
            for (event, rx) in binding_events.into_iter().zip(rxs) {
                let tx = ev_tx.clone();
                std::thread::spawn(move || {
                    while rx.recv().is_ok() {
                        if tx.send(event).is_err() {
                            break;
                        }
                    }
                });
            }
            Some(listener)
        }
        Err(e) => {
            warn!("hotkey listener spawn failed: {e:#}");
            // root of "hotkeys don't work" reports: raw-input held by another process/anti-cheat,
            // or window creation failure.
            let chain = format!("{e:#}");
            let step = if chain.contains("CreateWindowExW") {
                "create_window"
            } else if chain.contains("RegisterRawInputDevices") {
                "register_raw_input"
            } else if chain.contains("spawn") {
                "thread_spawn"
            } else {
                "thread_died"
            };
            clipdip_diagnostics::report_error(
                "hotkey_listener_spawn_failed",
                format!("hotkey listener spawn failed ({step}): {chain}"),
                Some(serde_json::json!({
                    "step": step,
                    "binding_count": binding_defs.len(),
                })),
            );
            report_pipeline_error(app, format!("hotkeys: {e:#}"));
            None
        }
    }
}

/// "870 MB" / "1.4 GB" for notification copy.
fn fmt_size(bytes: u64) -> String {
    if bytes >= 1_000_000_000 {
        format!("{:.1} GB", bytes as f64 / 1e9)
    } else {
        format!("{} MB", bytes / 1_000_000)
    }
}

/// native Windows toast; failure to show is swallowed, a missing notification must never take down capture.
fn notify_native(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        warn!("native notification failed: {e:#}");
    }
}

/// health alert goes both ways: native toast (Focus Assist eats these in
/// fullscreen, per the 2026-07-05 incident) and the overlay notice.
/// overlay shows only `title` (auto-dismisses, can't be screenshotted); toast carries `body`.
fn notify_health(app: &AppHandle, corner: &str, title: &str, body: &str) {
    record_notification("health", title, body);
    notify_native(app, title, body);
    let notice = NoticePayload {
        message: title.to_string(),
        corner: corner.to_string(),
        duration_ms: 0,
    };
    if let Some(state) = app.try_state::<AppState>() {
        *state.pending_notice.lock().unwrap() = Some(notice.clone());
    }
    if let Some(overlay) = ensure_overlay_window(app, corner) {
        let _ = overlay.emit("overlay-notice", notice);
    }
}

/// Human wording for one audio source kind: ("what it is", "what's lost").
fn audio_kind_words(kind: clipdip_audio::AudioKind) -> (&'static str, &'static str) {
    match kind {
        clipdip_audio::AudioKind::SystemLoopback => ("System audio", "game sound"),
        clipdip_audio::AudioKind::Microphone => ("Microphone", "mic audio"),
    }
}

/// toasts when an audio source's situation changes (silent/fallback/recovered);
/// diffed against previous states by index+kind so a restart doesn't re-toast the unchanged.
fn notify_audio_state_changes(
    app: &AppHandle,
    corner: &str,
    prev: Option<&[clipdip_core::pipeline::AudioSourceState]>,
    cur: &[clipdip_core::pipeline::AudioSourceState],
) {
    for st in cur {
        let old = prev.and_then(|p| p.iter().find(|o| o.index == st.index && o.kind == st.kind));
        let (what, lost) = audio_kind_words(st.kind);
        if st.silent() {
            if !old.is_some_and(|o| o.silent()) {
                notify_health(
                    app,
                    corner,
                    &format!("{what} not recording"),
                    &format!(
                        "{} isn't available and no fallback device worked. Clips will have \
                         no {lost} until it returns or you pick another device in settings.",
                        st.wanted_label
                    ),
                );
            }
        } else if st.on_fallback() {
            if !old.is_some_and(|o| o.rank == st.rank && o.using_id == st.using_id) {
                notify_health(
                    app,
                    corner,
                    &format!("{what}: using fallback device"),
                    &format!(
                        "{} isn't available — recording {} instead.",
                        st.wanted_label,
                        st.using_label.as_deref().unwrap_or("another device")
                    ),
                );
            }
        } else if let Some(old) = old {
            if old.silent() || old.on_fallback() {
                notify_health(
                    app,
                    corner,
                    &format!("{what} restored"),
                    &format!(
                        "Recording {} again.",
                        st.using_label.as_deref().unwrap_or(&st.wanted_label)
                    ),
                );
                clipdip_diagnostics::report_custom(
                    "audio_source_recovered",
                    clipdip_diagnostics::Severity::Info,
                    format!("audio source recovered to its primary device ({:?})", st.kind),
                    Some(serde_json::json!({
                        "audio_kind": format!("{:?}", st.kind),
                        "was_silent": old.silent(),
                    })),
                );
            }
        }
    }
}

/// JSON snapshot of the audio source states for the control-server status
/// payload (ClipLib's settings UI renders a repair banner from this).
fn audio_states_json(states: &[clipdip_core::pipeline::AudioSourceState]) -> serde_json::Value {
    serde_json::Value::Array(
        states
            .iter()
            .map(|st| {
                serde_json::json!({
                    "index": st.index,
                    "kind": match st.kind {
                        clipdip_audio::AudioKind::SystemLoopback => "system_loopback",
                        clipdip_audio::AudioKind::Microphone => "microphone",
                    },
                    "wanted": st.wanted_label,
                    "using": st.using_label,
                    "on_fallback": st.on_fallback(),
                    "missing": st.silent(),
                })
            })
            .collect(),
    )
}

fn set_audio_status(app: &AppHandle, states: &[clipdip_core::pipeline::AudioSourceState]) {
    if let Some(state) = app.try_state::<AppState>() {
        *state.audio_status.lock().unwrap() = audio_states_json(states);
    }
}

fn clear_audio_status(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        *state.audio_status.lock().unwrap() = serde_json::Value::Array(Vec::new());
    }
}

/// would restarting improve any audio source? returns a log reason or None: a
/// better candidate appeared, a dead source could start, or an unpinned stream is stuck on a stale default.
fn audio_restart_reason(states: &[clipdip_core::pipeline::AudioSourceState]) -> Option<String> {
    let devices = match clipdip_audio::list_devices() {
        Ok(d) => d,
        Err(e) => {
            warn!("device re-evaluation skipped, list_devices failed: {e:#}");
            return None;
        }
    };
    for st in states {
        let flow = match st.kind {
            clipdip_audio::AudioKind::SystemLoopback => clipdip_audio::DeviceFlow::Render,
            clipdip_audio::AudioKind::Microphone => clipdip_audio::DeviceFlow::Capture,
        };
        let default_id = devices
            .iter()
            .find(|d| d.flow == flow && d.is_default)
            .map(|d| d.id.clone());
        // Same chain the pipeline builds: primary, then fallbacks, deduped.
        let mut candidates: Vec<Option<String>> = vec![st.primary_id.clone()];
        for fb in &st.fallback_ids {
            let cand = if fb == clipdip_core::config::DEFAULT_DEVICE_SENTINEL {
                None
            } else {
                Some(fb.clone())
            };
            if !candidates.contains(&cand) {
                candidates.push(cand);
            }
        }
        let available = |cand: &Option<String>| match cand {
            None => default_id.is_some(),
            Some(id) => devices.iter().any(|d| d.flow == flow && d.id == *id),
        };
        // Anything strictly better than what's running (everything, when
        // nothing is running) that is present now justifies a restart.
        let limit = st.rank.unwrap_or(usize::MAX);
        for (rank, cand) in candidates.iter().enumerate() {
            if rank >= limit {
                break;
            }
            if available(cand) {
                return Some(if st.silent() {
                    format!("a {:?} device is available again", st.kind)
                } else {
                    format!("a higher-priority {:?} device is available", st.kind)
                });
            }
        }
        // default drift: a stream on "system default" keeps recording whatever
        // was default at start; WASAPI doesn't follow a later default switch.
        if st.rank.is_some_and(|r| candidates.get(r).is_some_and(|c| c.is_none())) {
            if let (Some(def), Some(used)) = (default_id.as_deref(), st.using_id.as_deref()) {
                if def != used {
                    return Some(format!("default {:?} endpoint changed", st.kind));
                }
            }
        }
    }
    None
}

/// forwards debounced WASAPI endpoint changes into the capture loop; one
/// physical event (e.g. a headset connecting) bursts several callbacks, coalesced into one re-evaluation.
fn spawn_audio_device_watcher(loop_tx: crossbeam_channel::Sender<LoopEvent>) {
    std::thread::spawn(move || {
        let (watcher, rx) = match clipdip_audio::DeviceWatcher::start() {
            Ok(x) => x,
            Err(e) => {
                warn!("audio device watcher unavailable: {e:#}");
                return;
            }
        };
        let _keep = watcher;
        while let Ok(first) = rx.recv() {
            let mut last = first;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                let now = std::time::Instant::now();
                if now >= deadline {
                    break;
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(ev) => last = ev,
                    Err(_) => break,
                }
            }
            debug!(?last, "audio endpoints changed — asking capture loop to re-evaluate");
            if loop_tx.send(LoopEvent::AudioDevicesChanged).is_err() {
                return;
            }
        }
    });
}

/// shows a hint card + native toast + history entry (durable trail since
/// Focus Assist eats toasts in fullscreen).
/// skips the card (not the toast) if another overlay card is up, returning
/// false; hint triggers are expected to retry on their own.
fn show_hint(
    app: &AppHandle,
    kind: &str,
    title: &str,
    sub: &str,
    toast_body: &str,
    duration_ms: u32,
) -> bool {
    use std::sync::atomic::Ordering;

    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let Ok(cfg) = clipdip_core::config::Config::load_or_default(&state.config_path) else {
        return false;
    };
    let busy = state.pending_saving.lock().unwrap().is_some()
        || state.pending_saved.lock().unwrap().is_some()
        || state.pending_notice.lock().unwrap().is_some()
        || state.update_toast_active.load(Ordering::SeqCst);
    if busy {
        info!("hint '{kind}' skipped — another overlay card is on screen");
        return false;
    }

    // toast + history only when the hint is actually delivered, so a retry after a skip can't spam
    // the action center.
    record_notification("hint", title, toast_body);
    notify_native(app, title, toast_body);
    if !cfg.notifications.enabled {
        // overlay cards are opted out; the toast + history entry above still count as delivered.
        return true;
    }

    let corner = corner_slug(&cfg.notifications.corner);
    let payload = HintPayload {
        kind: kind.to_string(),
        title: title.to_string(),
        sub: sub.to_string(),
        duration_ms,
        dismiss_hotkey: cfg.hotkey.rename_clip.clone(),
        corner: corner.clone(),
    };
    *state.pending_hint.lock().unwrap() = Some(payload.clone());
    state.hint_active.store(true, Ordering::SeqCst);
    if let Some(overlay) = ensure_overlay_window(app, &corner) {
        let _ = overlay.emit("overlay-hint", payload);
    }
    true
}

/// watches for Discord consent-popup storms (normally one popup ever); after
/// an abnormal burst, shows a one-off hint about the settings toggle. Threshold/cooldown live in
/// the discord crate.
fn spawn_discord_prompt_watch(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(120));
        let Some(state) = app.try_state::<AppState>() else {
            continue;
        };
        if !state.discord.prompt_hint_due() {
            continue;
        }
        let Ok(cfg) = clipdip_core::config::Config::load_or_default(&state.config_path) else {
            continue;
        };
        // toggle already off means no more popups, nothing to hint at.
        if !cfg.discord.enabled {
            continue;
        }
        let shown = show_hint(
            &app,
            "discord",
            "Discord keeps asking to connect",
            "Turn off **voice capture** in settings, or ask on our Discord for a whitelist invite",
            "Turn off voice capture in settings to stop the popups, or ask on our Discord for a whitelist invite.",
            10_000,
        );
        // start the cooldown only once the card made it on screen; a skip retries next tick.
        if shown {
            state.discord.mark_prompt_hint_shown();
        }
    });
}

/// How long a wedge restart stays on the record for the storm guard.
const WEDGE_RESTART_WINDOW_SECS: u64 = 30 * 60;
/// wedge restarts allowed in that window before auto-restart gives up (the third is refused).
const WEDGE_RESTART_MAX: usize = 3;

/// JSON file of recent wedge-restart timestamps next to config; must be on
/// disk since `app.restart()` wipes in-process counters.
fn wedge_restart_log_path() -> Option<PathBuf> {
    clipdip_core::config::Config::path()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("wedge-restarts.json")))
}

/// appends now, drops entries older than the window, returns the in-window
/// count; IO failure degrades to 1 so a broken file can't block a recovery restart.
fn record_wedge_restart() -> usize {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let Some(path) = wedge_restart_log_path() else {
        return 1;
    };
    let mut stamps: Vec<u64> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<u64>>(&s).ok())
        .unwrap_or_default();
    stamps.retain(|t| *t <= now && now - *t < WEDGE_RESTART_WINDOW_SECS);
    stamps.push(now);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    if let Ok(body) = serde_json::to_string(&stamps) {
        let _ = std::fs::write(&path, body);
    }
    stamps.len()
}

/// watchdog turning silent capture degradation into a proactive toast, ~1Hz
/// for one pipeline's lifetime (drop stops+joins the thread).
/// watches capture stalls and low replay buffer (memory-limited vs gap cause), debounced with hysteresis.
struct HealthMonitor {
    stop: Arc<std::sync::atomic::AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

/// everything one `health_loop` needs, bundled so the two spawn sites don't repeat positional args.
struct HealthMonitorArgs {
    ring: Arc<clipdip_ringbuf::PacketRing>,
    liveness: Arc<std::sync::atomic::AtomicI64>,
    /// Error the video thread died with, if it has died.
    video_error: Arc<Mutex<Option<String>>>,
    phase: Arc<std::sync::atomic::AtomicU8>,
    replay_seconds: u32,
    /// Overlay corner for in-game health notices.
    corner: String,
    /// channel back into the capture loop, to request a restart when the video thread died
    ev_tx: crossbeam_channel::Sender<LoopEvent>,
}

impl HealthMonitor {
    fn spawn(app: AppHandle, args: HealthMonitorArgs) -> Self {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);
        let handle = std::thread::Builder::new()
            .name("clipdip-health".into())
            .spawn(move || health_loop(app, args, stop_thread))
            .ok();
        Self { stop, handle }
    }
}

impl Drop for HealthMonitor {
    fn drop(&mut self) {
        self.stop
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn health_loop(
    app: AppHandle,
    args: HealthMonitorArgs,
    stop: Arc<std::sync::atomic::AtomicBool>,
) {
    use clipdip_core::pipeline::{capture_phase, qpc_now_100ns};
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    let HealthMonitorArgs {
        ring,
        liveness,
        video_error,
        phase,
        replay_seconds,
        corner,
        ev_tx,
    } = args;

    // no frame for this long means capture stalled; well above ~200ms DXGI
    // acquire stalls under load and the video thread's own 0.5s compensation.
    const STALL_IDLE_100NS: i64 = 20_000_000; // 2s
    // this long means the capture thread is wedged in a GPU call that never
    // returned (the "1-second clip" bug); it holds the DXGI duplication and
    // can't be torn down, so only a process restart recovers. 15s: no legitimate gap lasts that long.
    const WEDGE_RESTART_100NS: i64 = 150_000_000; // 15s
    let window_100ns = replay_seconds as i64 * 10_000_000;
    // "Low" = the buffer dropped more than max(10%, 5s) below the window.
    let underfull_floor = window_100ns - (window_100ns / 10).max(50_000_000);

    let mut polls: u64 = 0; // ~one per second
    let mut bad = 0u32; // consecutive degraded ticks (debounce in)
    let mut good = 0u32; // consecutive healthy ticks (debounce out)
    let mut degraded = false;
    // memory pressure is a steady config fact, not transient: alert once per
    // pipeline run (respawn resets this), never a "recovered" counterpart, or
    // the gap debounce ping-pongs forever.
    let mut memory_alerted = false;
    // Only auto-restart once capture has actually worked this session, so a
    // wedge that somehow happens at startup can't cause a restart loop.
    let mut seen_healthy = false;
    // Latched once the cross-run storm guard has said "no more restarts".
    // Heartbeats and alerts keep running; only the restart is off.
    let mut wedge_giveup = false;
    // after a gap recovers, the ring refills in real time; suppress buffer-low
    // until it's had a full window+margin, or one stall double-alerts.
    let mut refill_grace_until: u64 = 0;
    // Whether the current degraded episode is a frame gap (vs. a short ring).
    let mut degraded_gap = false;
    // Poll index of the last gap recovery, so a low-buffer alert that still
    // fires afterwards can name the refill as its cause.
    let mut last_gap_recovery: Option<u64> = None;
    let mut since_poll = Duration::ZERO;
    let tick = Duration::from_millis(250); // short slices so stop is prompt

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(tick);
        if stop.load(Ordering::Relaxed) {
            break;
        }
        since_poll += tick;
        if since_poll < Duration::from_secs(1) {
            continue;
        }
        since_poll = Duration::ZERO;
        polls += 1;

        // video thread died (e.g. a display-mode change invalidated encoder dims):
        // alert + ask for an in-process restart, cheaper than the wedge path's
        // whole-app restart. one-shot, exits after sending.
        if let Some(err) = video_error.lock().unwrap().clone() {
            error!("health: video capture thread died — requesting pipeline restart: {err}");
            clipdip_diagnostics::report_capture_failure(
                "video_thread_died",
                format!("video capture thread died: {err}"),
                serde_json::json!({
                    "phase": capture_phase::name(phase.load(Ordering::Relaxed)),
                }),
            );
            notify_health(
                &app,
                &corner,
                "Capture error, restarting",
                "Screen capture hit an error and is restarting. The replay buffer starts refilling now.",
            );
            let _ = ev_tx.send(LoopEvent::RestartAfterFailure);
            return;
        }

        // heartbeat (~10s) logged from this thread, not the video loop, so it
        // keeps reporting even if capture freezes: a heartbeat gap means the
        // process froze, rising frame_idle + shrinking ring_span means frames stopped while the ring drained.
        if polls % 10 == 0 {
            let live_now = liveness.load(Ordering::Relaxed);
            let idle_secs = if live_now == 0 {
                -1.0
            } else {
                (qpc_now_100ns() - live_now) as f64 / 1e7
            };
            let stats = ring.stats();
            let span_secs = stats.video_span_100ns as f64 / 1e7;
            // effective video bitrate + keyframe share; on static content the
            // once-per-GOP IDR dominates, this pair proves it from a log.
            let video_mbps = if span_secs > 0.0 {
                stats.video_bytes as f64 * 8.0 / span_secs / 1e6
            } else {
                0.0
            };
            let kf_share = if stats.video_bytes > 0 {
                stats.video_keyframe_bytes as f64 / stats.video_bytes as f64
            } else {
                0.0
            };
            debug!(
                frame_idle_secs = idle_secs,
                ring_span_secs = span_secs,
                ring_video_mb = stats.video_bytes / 1_000_000,
                video_mbps = format!("{video_mbps:.1}"),
                keyframe_share = format!("{kf_share:.2}"),
                phase = capture_phase::name(phase.load(Ordering::Relaxed)),
                "capture heartbeat"
            );
        }

        let live = liveness.load(Ordering::Relaxed);

        // wedge recovery: capture alive but idle too long means stuck in a GPU
        // call; restart the process, the only thing that works (see WEDGE_RESTART_100NS).
        if live != 0 {
            let idle = qpc_now_100ns() - live;
            if idle < STALL_IDLE_100NS {
                seen_healthy = true;
            }
            if seen_healthy && idle > WEDGE_RESTART_100NS && !wedge_giveup {
                let stuck_in = capture_phase::name(phase.load(Ordering::Relaxed));
                // cross-run storm guard (count lives in a file since restart wipes
                // memory): 3 wedge restarts in 30min means restarting isn't fixing it
                // (and re-pops the Discord consent dialog), so stop and tell the user.
                let recent = record_wedge_restart();
                if recent >= WEDGE_RESTART_MAX {
                    wedge_giveup = true;
                    error!(
                        restarts = recent,
                        stuck_in, "capture wedged repeatedly, giving up on auto-restart"
                    );
                    clipdip_diagnostics::report_capture_failure(
                        "capture_wedge_giveup",
                        format!(
                            "capture wedged {recent} times in 30 minutes, auto-restart stopped"
                        ),
                        serde_json::json!({
                            "restarts": recent,
                            "idle_secs": idle as f64 / 1e7,
                            "stuck_in": stuck_in,
                        }),
                    );
                    notify_health(
                        &app,
                        &corner,
                        "Capture keeps freezing",
                        "Restarting Clipdip isn't helping. Restart your PC or check your \
                         graphics drivers.",
                    );
                    continue;
                }
                error!(
                    idle_secs = idle as f64 / 1e7,
                    stuck_in,
                    "capture wedged (no frames; thread stuck in this stage) — restarting Clipdip to recover"
                );
                clipdip_diagnostics::report_capture_failure(
                    "capture_wedged",
                    format!("capture wedged in {stuck_in} for {:.0}s — restarting app", idle as f64 / 1e7),
                    serde_json::json!({
                        "idle_secs": idle as f64 / 1e7,
                        "stuck_in": stuck_in,
                        "restarts_in_window": recent,
                    }),
                );
                notify_health(
                    &app,
                    &corner,
                    "Capture froze, restarting Clipdip",
                    "Screen capture stopped responding. Restarting Clipdip to recover…",
                );
                // let the toast surface before the process exits.
                std::thread::sleep(Duration::from_millis(1200));
                // deliberate exit after a fatal capture failure: the server vocabulary for that is
                // `crash`, distinct from `died`.
                clipdip_diagnostics::session_end("crash");
                app.restart();
            }
        }
        // third field is the cause slug: tags telemetry and tells recovery
        // whether frames were missing (gap, ring refills) or just short.
        let issue: Option<(String, String, &'static str)> = if live == 0 {
            // no frame yet: normal at start, but persisting means capture never came
            // up (previously silent forever, no liveness meant no checks at all).
            if polls > 15 {
                Some((
                    "Capture never started, check settings".into(),
                    format!(
                        "No frames have been captured since capture started \
                         ({polls}s ago). Check the monitor / capture settings."
                    ),
                    "never_started",
                ))
            } else {
                None
            }
        } else {
            let idle = qpc_now_100ns() - live;
            let span = ring.stats().video_span_100ns;
            if idle > STALL_IDLE_100NS {
                Some((
                    format!("No new frames for {:.0}s", idle as f64 / 1e7),
                    format!(
                        "No frames captured for {:.0}s. Clips saved now won't show \
                         the screen until capture resumes.",
                        idle as f64 / 1e7
                    ),
                    "no_frames",
                ))
            } else if polls as i64 > replay_seconds as i64 + 5
                && polls > refill_grace_until
                && span < underfull_floor
            {
                // only judge "low" after a full window has had time to fill (also
                // after a gap, so one stall doesn't double-alert).
                // classify: a recent byte-budget eviction means memory-limited
                // (stable fact); anything else is a transient gap. stopping a
                // recording flushes the ring and must suppress the gap toast too, not just the memory one.
                let stats = ring.stats();
                if stats.pressure_recent(window_100ns) {
                    if stats.past_hold_grace(window_100ns) && !memory_alerted {
                        memory_alerted = true;
                        let span_secs = span as f64 / 1e7;
                        let rate = stats.bytes_used as f64 / span_secs.max(1.0);
                        let needed = fmt_size((rate * replay_seconds as f64) as u64);
                        let budget = fmt_size(stats.byte_budget);
                        let body = format!(
                            "Buffer holds {span_secs:.0} s of your {replay_seconds} s \
                             replay length. Keeping all of it needs about {needed} but \
                             the memory limit is {budget}. Lower quality or shorten \
                             the replay length."
                        );
                        warn!("health: {body}");
                        clipdip_diagnostics::report_capture_failure_with(
                            "ring_memory_pressure",
                            clipdip_diagnostics::Severity::Warning,
                            body.clone(),
                            serde_json::json!({
                                "span_secs": span_secs,
                                "replay_seconds": replay_seconds,
                                "needed_mb": (rate * replay_seconds as f64 / 1e6) as u64,
                                "budget_mb": stats.byte_budget / 1_000_000,
                            }),
                        );
                        notify_health(&app, &corner, "Replay limited by memory", &body);
                    }
                    None
                } else {
                    Some((
                        "Replay buffer low".to_string(),
                        format!(
                            "Buffer holds only {:.0}s of your {}s replay window. A clip \
                             saved now would be short.",
                            span as f64 / 1e7,
                            replay_seconds
                        ),
                        // the grace above covers the normal refill; if it still reads low right
                        // after one, say so.
                        if last_gap_recovery
                            .is_some_and(|p| polls - p <= (replay_seconds as u64 + 5) * 2)
                        {
                            "refill_after_gap"
                        } else {
                            "buffer_low"
                        },
                    ))
                }
            } else {
                None
            }
        };

        match (issue, degraded) {
            (Some((title, body, cause)), false) => {
                bad += 1;
                good = 0;
                if bad >= 2 {
                    degraded = true;
                    degraded_gap = matches!(cause, "no_frames" | "never_started");
                    warn!("health: degraded — {body}");
                    clipdip_diagnostics::report_capture_failure_with(
                        "capture_degraded",
                        clipdip_diagnostics::Severity::Warning,
                        body.clone(),
                        serde_json::json!({ "title": title, "cause": cause }),
                    );
                    notify_health(&app, &corner, &title, &body);
                }
            }
            (None, true) => {
                good += 1;
                bad = 0;
                if good >= 3 {
                    degraded = false;
                    info!("health: capture recovered");
                    // frames were missing, ring refills in real time; hold buffer-low
                    // off for one window+margin, else one stall alerts twice.
                    if degraded_gap {
                        refill_grace_until = polls + replay_seconds as u64 + 5;
                        last_gap_recovery = Some(polls);
                    }
                    degraded_gap = false;
                    // keep the refill claim honest: a gap ring hitting the byte budget
                    // while refilling routes to the memory path above; don't promise more than memory allows.
                    let stats = ring.stats();
                    let body = if stats.video_span_100ns < underfull_floor
                        && stats.pressure_recent(window_100ns)
                    {
                        "Replay capture is healthy again. The replay length \
                         is still limited by memory."
                    } else {
                        "Replay capture is healthy again and the buffer is refilling."
                    };
                    notify_health(&app, &corner, "Capture recovered", body);
                }
            }
            // already alerted and still bad, or healthy and still fine: reset the opposing streak
            // and stay quiet.
            (Some(_), true) => {
                good = 0;
            }
            (None, false) => {
                bad = 0;
            }
        }
    }
}

/// builds+pushes the heartbeat's `app` block (encoder/capture mode only once
/// the pipeline opened them, never attributed from config, plus settings/clip
/// count/free space). Diagnostics re-sends only on change.
fn push_app_info(
    cfg: &clipdip_core::config::Config,
    session: Option<clipdip_core::pipeline::SessionInfo>,
) {
    let mut app = serde_json::json!({
        "replay_seconds": cfg.replay_seconds,
        "fps": cfg.video.fps,
        "clips_saved_total": clipdip_diagnostics::clips_saved_total(),
    });
    if let Some(gb) = clipdip_core::diskinfo::free_disk_gb(&cfg.output.directory) {
        app["storage_free_gb"] = gb.into();
    }
    if let Some(s) = session {
        app["encoder"] = s.encoder_slug().into();
        app["capture_mode"] = s.capture_mode_slug().into();
        app["resolution"] = format!("{}x{}", s.width, s.height).into();
    }
    clipdip_diagnostics::update_app_info(app);
}

/// waits off-thread for the video thread to open the encoder, then pushes
/// the resolved app block; falls back to config-only if it never comes up.
fn push_app_info_when_ready(
    session_info: Arc<Mutex<Option<clipdip_core::pipeline::SessionInfo>>>,
    cfg: clipdip_core::config::Config,
) {
    std::thread::spawn(move || {
        for _ in 0..20 {
            if let Some(s) = *session_info.lock().unwrap() {
                push_app_info(&cfg, Some(s));
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        push_app_info(&cfg, None);
    });
}

fn run_capture_loop(
    app: AppHandle,
    config_path: PathBuf,
    active_clip: Arc<Mutex<Option<String>>>,
    pipeline_running: Arc<Mutex<bool>>,
    ring_handle: Arc<Mutex<Option<Arc<clipdip_ringbuf::PacketRing>>>>,
    ev_tx: crossbeam_channel::Sender<LoopEvent>,
    ev_rx: crossbeam_channel::Receiver<LoopEvent>,
) {
    let cfg = match clipdip_core::config::Config::load_or_default(&config_path) {
        Ok(c) => c,
        Err(e) => {
            error!("config load: {e:#}");
            report_pipeline_error(&app, format!("{e:#}"));
            return;
        }
    };

    // hotkeys register before the pipeline starts so they work even if init
    // fails (e.g. NVENC unavailable); listener lives until return or ReloadHotkeys.
    let mut listener = spawn_hotkey_listener(&cfg, &ev_tx, &app);

    // ev_tx stays alive for ReloadHotkeys; AppState holds its own loop_tx
    // clone for the process lifetime anyway.

    // values the health monitor needs, read before `cfg` moves into the pipeline
    let mut replay_seconds = cfg.replay_seconds;
    let mut health_alerts = cfg.notifications.enabled && cfg.notifications.health_alerts;
    let mut notif_corner = corner_slug(&cfg.notifications.corner);

    // recent health-initiated restart timestamps, storm guard against capture
    // that re-dies immediately after each restart
    let mut auto_restarts: Vec<std::time::Instant> = Vec::new();

    // same idea for audio-driven restarts (flapping Bluetooth cycling);
    // separate counter since these are healthy restarts, not failures
    let mut audio_restarts: Vec<std::time::Instant> = Vec::new();

    // audio states last told to the user, so restarts only toast actual changes
    let mut last_audio_states: Option<Vec<clipdip_core::pipeline::AudioSourceState>> = None;

    // a mid-recording device change parks here until the recording ends
    let mut audio_restart_deferred = false;

    // start the pipeline after hotkeys are live; on failure keep the loop running so hotkeys stay registered
    let mut monitor: Option<HealthMonitor> = None;
    let cfg_for_app_block = cfg.clone();
    let mut pipeline = match clipdip_core::Pipeline::start(cfg) {
        Ok(p) => {
            info!("pipeline started");
            let states = p.audio_states();
            notify_audio_state_changes(&app, &notif_corner, None, &states);
            set_audio_status(&app, &states);
            last_audio_states = Some(states);
            push_app_info_when_ready(p.session_info_handle(), cfg_for_app_block);
            *ring_handle.lock().unwrap() = Some(p.ring());
            *pipeline_running.lock().unwrap() = true;
            clear_pipeline_error(&app);
            let _ = app.emit("pipeline-status", serde_json::json!({"running": true}));
            if health_alerts {
                monitor = Some(HealthMonitor::spawn(
                    app.clone(),
                    HealthMonitorArgs {
                        ring: p.ring(),
                        liveness: p.frame_liveness(),
                        video_error: p.video_error(),
                        phase: p.capture_phase(),
                        replay_seconds,
                        corner: notif_corner.clone(),
                        ev_tx: ev_tx.clone(),
                    },
                ));
            }
            Some(p)
        }
        Err(e) => {
            error!("pipeline start: {e:#}");
            report_pipeline_error(&app, format!("{e:#}"));
            // config-only app block, deliberately no encoder field so attribution
            // never implies a pipeline that didn't run.
            push_app_info(&cfg_for_app_block, None);
            None
        }
    };

    for event in &ev_rx {
        match event {
            LoopEvent::Save | LoopEvent::ToggleRecording => {
                let Some(ref pipeline) = pipeline else {
                    warn!("save/record hotkey fired but pipeline is not running");
                    // the loudest user-visible failure: a hotkey press that does nothing at all
                    if let clipdip_diagnostics::Gate::Send { suppressed } =
                        clipdip_diagnostics::gate("hotkey_no_pipeline", std::time::Duration::from_secs(60))
                    {
                        clipdip_diagnostics::report_error(
                            "hotkey_no_pipeline",
                            "save/record hotkey fired but the pipeline is not running",
                            Some(serde_json::json!({ "occurrences": suppressed + 1 })),
                        );
                    }
                    continue;
                };

                // ToggleRecording is two actions on one key: first press arms recording
                // here, second falls through to the shared save flow as Recording.
                let save_kind = match event {
                    LoopEvent::ToggleRecording if !pipeline.is_recording() => {
                        match pipeline.start_recording() {
                            Ok(()) => {
                                info!("manual recording started");
                                let cur =
                                    clipdip_core::config::Config::load_or_default(&config_path)
                                        .unwrap_or_default();
                                if let Some(state) = app.try_state::<AppState>() {
                                    *state.recording_active.lock().unwrap() = true;
                                }
                                // recordings are silent by design, only the overlay notice + the red dot
                                if cur.notifications.enabled {
                                    record_notification("notice", "Recording started", "");
                                    let corner = corner_slug(&cur.notifications.corner);
                                    let notice = NoticePayload {
                                        message: "Recording started".into(),
                                        corner: corner.clone(),
                                        duration_ms: 0,
                                    };
                                    if let Some(state) = app.try_state::<AppState>() {
                                        *state.pending_notice.lock().unwrap() =
                                            Some(notice.clone());
                                        *state.pending_saving.lock().unwrap() = None;
                                        *state.pending_saved.lock().unwrap() = None;
                                    }
                                    if let Some(overlay) = ensure_overlay_window(&app, &corner) {
                                        let _ = overlay
                                            .emit("recording-state", serde_json::json!({"recording": true}));
                                        let _ = overlay.emit("overlay-notice", notice);
                                    }
                                }
                            }
                            Err(e) => {
                                warn!("start recording: {e:#}");
                                let chain = format!("{e:#}");
                                let cause = if chain.contains("already in progress") {
                                    "already_in_progress"
                                } else {
                                    "no_video_yet"
                                };
                                if let clipdip_diagnostics::Gate::Send { suppressed } =
                                    clipdip_diagnostics::gate(
                                        "recording_start_failed",
                                        std::time::Duration::from_secs(60),
                                    )
                                {
                                    clipdip_diagnostics::report_error_with(
                                        "recording_start_failed",
                                        clipdip_diagnostics::Severity::Warning,
                                        format!("manual recording failed to start ({cause})"),
                                        Some(serde_json::json!({
                                            "cause": cause,
                                            "occurrences": suppressed + 1,
                                        })),
                                    );
                                }
                            }
                        }
                        continue;
                    }
                    LoopEvent::ToggleRecording => SaveKind::Recording,
                    _ => SaveKind::Clip,
                };

                // anchor for all stage timings, logged as `t+Nms` to line up backend and frontend.
                let t0 = std::time::Instant::now();
                let prof = clipdip_profile::enabled();
                if prof { info!("save flow start [t+0ms]"); }

                // snapshot foreground HWND+PID now, so metadata reflects the hotkey
                // moment, not whatever stole focus by the time the mux ends (~1-2s later).
                let foreground = metadata::ForegroundSnapshot::capture();

                // snapshot the Discord roster at the hotkey moment too (background
                // manager keeps it warm), not whoever's there after the mux.
                let discord_roster = app
                    .try_state::<AppState>()
                    .and_then(|s| s.discord.roster());

                // re-read config so notification settings reflect changes since the pipeline started
                let cur = clipdip_core::config::Config::load_or_default(&config_path)
                    .unwrap_or_default();
                let notifs_enabled = cur.notifications.enabled;

                // recording stop: drop the red dot immediately, the save flow's own toasts take over
                if save_kind == SaveKind::Recording {
                    if let Some(state) = app.try_state::<AppState>() {
                        *state.recording_active.lock().unwrap() = false;
                    }
                    if let Some(overlay) = app.get_webview_window("overlay") {
                        let _ = overlay
                            .emit("recording-state", serde_json::json!({"recording": false}));
                    }
                }

                // chirp isn't fired here anymore; overlay calls `play_saved_sound` when
                // its saved animation starts, so it can't leak into the clip and lands
                // even if cold-start outruns the mux. Recordings stay silent (chirp only for kind == "clip").
                if prof { info!("config reloaded [t+{}ms]", t0.elapsed().as_millis()); }

                // pre-compute the static phase-1 fields so the scope block below just consumes them
                let rename_hint = format!("Press {} to rename", cur.hotkey.rename_clip);
                let corner = corner_slug(&cur.notifications.corner);

                // mux and metadata run in parallel via thread::scope (lets them borrow
                // `pipeline` without 'static)
                std::thread::scope(|s| {
                    // save thread first: it only needs the pipeline and the config snapshot,
                    // everything below (overlay, metadata) runs alongside the mux
                    let save_dir = cur.output.directory.clone();
                    let stem_template = cur.output.filename_stem.clone();
                    let save_thread = s.spawn(move || {
                        let t_start = t0.elapsed().as_millis();
                        // window title costs up to ~400ms against a hung window, only
                        // fetched when the filename template actually uses [title]
                        let (app_name, window_title) = metadata::filename_names(
                            foreground,
                            stem_template.contains("[title]"),
                        );
                        let vars = clipdip_core::filename::FilenameVars {
                            app_name,
                            window_title,
                            kind: match save_kind {
                                SaveKind::Clip => "Clip",
                                SaveKind::Recording => "Recording",
                            },
                        };
                        let r = match save_kind {
                            SaveKind::Clip => pipeline.save_clip_in(
                                Some(&save_dir),
                                &vars,
                            ),
                            SaveKind::Recording => pipeline.stop_recording_and_save_in(
                                Some(&save_dir),
                                &vars,
                            ),
                        };
                        if prof {
                            let t_end = t0.elapsed().as_millis();
                            info!(
                                "save_clip [t+{}ms .. t+{}ms = {}ms]",
                                t_start, t_end, t_end - t_start
                            );
                        }
                        r
                    });

                    // phase 1 emits with thumbnail null; overlay.html never used one and the
                    // gdigrab grab that filled it cost ~2s of cpu beside the mux. the overlay
                    // webview is built here, after the save thread is already running: cold
                    // WebView2 creation used to sit between the hotkey and the ring snapshot.
                    if notifs_enabled {
                        let saving_payload = ClipSavingPayload {
                            thumbnail: None,
                            rename_hotkey: rename_hint.clone(),
                            auto_dismiss_secs: cur.notifications.auto_dismiss_secs,
                            corner: corner.clone(),
                            sound: cur.notifications.sound,
                            profile: prof,
                            kind: save_kind.as_str().into(),
                        };
                        // stash before creating the window: `clip-saving` below races React's
                        // listener, overlay reads the stash via `overlay_get_pending` instead.
                        // also clear a stale saved payload so it doesn't hydrate the wrong flow.
                        if let Some(state) = app.try_state::<AppState>() {
                            *state.pending_saving.lock().unwrap() = Some(saving_payload.clone());
                            *state.pending_saved.lock().unwrap() = None;
                            *state.pending_notice.lock().unwrap() = None;
                        }
                        if let Some(overlay) = ensure_overlay_window(&app, &corner) {
                            let _ = overlay.emit("clip-saving", saving_payload);
                        }
                        if prof { info!("emit clip-saving [t+{}ms]", t0.elapsed().as_millis()); }
                    }

                    // metadata resolution runs parallel to the mux; the two 200ms
                    // SendMessageTimeoutW calls + GDI icon walk would otherwise add ~0.5s if run
                    // serially after.
                    let meta_thread = if cur.metadata.enabled {
                        foreground.map(|snap| {
                            let meta_cfg = cur.metadata.clone();
                            s.spawn(move || {
                                let t_start = t0.elapsed().as_millis();
                                let r = metadata::resolve(snap, &meta_cfg);
                                if prof {
                                    let t_end = t0.elapsed().as_millis();
                                    info!(
                                        "metadata.resolve [t+{}ms .. t+{}ms = {}ms]",
                                        t_start, t_end, t_end - t_start
                                    );
                                }
                                r
                            })
                        })
                    } else {
                        None
                    };

                    // phase 2: mux done, emit clip-saved with title+path; overlay swaps
                    // spinner for pip and reveals rename input.
                    match save_thread.join() {
                        Ok(Ok(path)) => {
                            let title = path
                                .file_stem()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string();
                            let path_str = path.to_string_lossy().to_string();
                            *active_clip.lock().unwrap() = Some(path_str.clone());

                            if prof {
                                info!("clip saved: {path_str} [t+{}ms]", t0.elapsed().as_millis());
                            } else {
                                info!("clip saved: {path_str}");
                            }

                            // .gameinfo finalize: game-info + roster were already resolved
                            // earlier, this just writes the JSON keyed by the now-known path.
                            // either alone still writes a sidecar; failures only log.
                            let resolved = meta_thread.and_then(|h| match h.join() {
                                Ok(r) => Some(r),
                                Err(_) => {
                                    warn!("metadata resolve thread panicked");
                                    None
                                }
                            });
                            let discord_json = if cur.discord.enabled {
                                discord_roster
                                    .as_ref()
                                    .and_then(|r| serde_json::to_value(r).ok())
                            } else {
                                None
                            };
                            if resolved.is_some() || discord_json.is_some() {
                                if let Err(e) = metadata::write_gameinfo(
                                    &path,
                                    resolved.as_ref(),
                                    discord_json.as_ref(),
                                ) {
                                    warn!("metadata write failed: {e:#}");
                                } else if prof {
                                    info!("metadata.write_gameinfo [t+{}ms]", t0.elapsed().as_millis());
                                }
                            }

                            if notifs_enabled {
                                record_notification(save_kind.as_str(), &title, &path_str);
                                let payload = ClipSavedPayload {
                                    path: path_str,
                                    title,
                                    kind: save_kind.as_str().into(),
                                };
                                // stash for a late-mounting overlay too, since cold-start often
                                // outruns the mux
                                if let Some(state) = app.try_state::<AppState>() {
                                    *state.pending_saved.lock().unwrap() = Some(payload.clone());
                                }
                                if let Some(overlay) = app.get_webview_window("overlay") {
                                    let _ = overlay.emit("clip-saved", payload);
                                }
                                if prof { info!("emit clip-saved [t+{}ms]", t0.elapsed().as_millis()); }
                            }
                        }
                        Ok(Err(e)) => {
                            if prof {
                                error!("save clip: {e:#} [t+{}ms]", t0.elapsed().as_millis());
                            } else {
                                error!("save clip: {e:#}");
                            }
                            // aggregate save-failure event, path-scrubbed; specific causes (disk
                            // full, mux, no IDR) already shipped their own codes deeper in the stack.
                            if let clipdip_diagnostics::Gate::Send { suppressed } =
                                clipdip_diagnostics::gate("clip_save_failed", std::time::Duration::from_secs(60))
                            {
                                clipdip_diagnostics::report_capture_failure(
                                    "clip_save_failed",
                                    format!(
                                        "clip save failed: {}",
                                        clipdip_diagnostics::scrub_user_paths(&format!("{e:#}"))
                                    ),
                                    serde_json::json!({
                                        "save_kind": save_kind.as_str(),
                                        "elapsed_ms": t0.elapsed().as_millis() as u64,
                                        "occurrences": suppressed + 1,
                                    }),
                                );
                            }
                            if notifs_enabled {
                                tear_down_overlay(&app, format!("{e:#}"));
                            }
                        }
                        Err(_) => {
                            if prof {
                                error!("save clip thread panicked [t+{}ms]", t0.elapsed().as_millis());
                            } else {
                                error!("save clip thread panicked");
                            }
                            clipdip_diagnostics::report_crash_event(
                                "save_thread_panicked",
                                "save clip thread panicked",
                                Some(serde_json::json!({
                                    "save_kind": save_kind.as_str(),
                                    "elapsed_ms": t0.elapsed().as_millis() as u64,
                                })),
                            );
                            if notifs_enabled {
                                tear_down_overlay(&app, "save thread panicked".to_string());
                            }
                        }
                    }
                });
            }
            LoopEvent::Rename => {
                if active_clip.lock().unwrap().is_some() {
                    if let Some(overlay) = app.get_webview_window("overlay") {
                        let _ = overlay.emit("activate-rename", ());
                        let _ = overlay.set_ignore_cursor_events(false);
                        let _ = overlay.set_focus();
                    }
                } else if let Some(state) = app.try_state::<AppState>() {
                    // no clip on screen: rename hotkey doubles as "update now" during
                    // the update toast, or "dismiss" during a hint card.
                    use std::sync::atomic::Ordering;
                    let no_save_toast = state.pending_saving.lock().unwrap().is_none()
                        && state.pending_saved.lock().unwrap().is_none();
                    if no_save_toast && state.update_toast_active.load(Ordering::SeqCst) {
                        start_silent_update(app.clone());
                    } else if no_save_toast && state.hint_active.swap(false, Ordering::SeqCst) {
                        *state.pending_hint.lock().unwrap() = None;
                        if let Some(overlay) = app.get_webview_window("overlay") {
                            let _ = overlay.emit("hint-dismiss", ());
                        }
                    }
                }
            }
            LoopEvent::UpdateEscape => {
                if let Some(state) = app.try_state::<AppState>() {
                    use std::sync::atomic::Ordering;
                    // never dismissible mid-install, the toast is the only sign the app is about to restart
                    if !state.update_installing.load(Ordering::SeqCst)
                        && state.update_toast_active.swap(false, Ordering::SeqCst)
                    {
                        if let Some(overlay) = app.get_webview_window("overlay") {
                            let _ = overlay.emit("update-dismiss", ());
                        }
                    }
                }
            }
            LoopEvent::Restart | LoopEvent::RestartAfterFailure | LoopEvent::AudioDevicesChanged => {
                if matches!(event, LoopEvent::AudioDevicesChanged) {
                    // restart only if it'd actually improve a source; otherwise endpoint
                    // churn isn't our business (a restart clears the buffer).
                    let Some(p) = pipeline.as_ref() else { continue };
                    if p.is_recording() {
                        audio_restart_deferred = true;
                        continue;
                    }
                    let states = p.audio_states();
                    let Some(reason) = audio_restart_reason(&states) else {
                        // no restart needed, but states may have changed (a device died
                        // with no fallback); tell the user and keep status honest.
                        notify_audio_state_changes(
                            &app,
                            &notif_corner,
                            last_audio_states.as_deref(),
                            &states,
                        );
                        set_audio_status(&app, &states);
                        last_audio_states = Some(states);
                        continue;
                    };
                    // storm guard for a flapping device (headset cycling): at most 4 audio-driven
                    // restarts per 10 min
                    let now = std::time::Instant::now();
                    audio_restarts
                        .retain(|t| now.duration_since(*t) < std::time::Duration::from_secs(600));
                    if audio_restarts.len() >= 4 {
                        warn!("audio device flapping — skipping restart ({reason})");
                        continue;
                    }
                    audio_restarts.push(now);
                    info!("restarting pipeline: {reason}");
                } else if matches!(event, LoopEvent::RestartAfterFailure) {
                    // storm guard: 3 failure-restarts in 10min means capture is
                    // persistently broken, stop cycling and wait for a manual restart or settings change.
                    let now = std::time::Instant::now();
                    auto_restarts
                        .retain(|t| now.duration_since(*t) < std::time::Duration::from_secs(600));
                    if auto_restarts.len() >= 3 {
                        error!(
                            "capture failed {} times in 10 minutes — giving up on auto-restart",
                            auto_restarts.len() + 1
                        );
                        clipdip_diagnostics::report_capture_failure(
                            "capture_restart_giveup",
                            format!(
                                "capture failed {} times in 10 minutes — auto-restart stopped",
                                auto_restarts.len() + 1
                            ),
                            serde_json::json!({ "restarts": auto_restarts.len() + 1 }),
                        );
                        notify_health(
                            &app,
                            &notif_corner,
                            "Capture stopped after repeated failures",
                            "Screen capture failed repeatedly and is now stopped. \
                             Check the capture settings (monitor / backend) and restart \
                             capture from the Clipdip window.",
                        );
                        drop(monitor.take());
                        *ring_handle.lock().unwrap() = None;
                        *pipeline_running.lock().unwrap() = false;
                        if let Some(p) = pipeline.take() {
                            let _ = p.stop();
                        }
                        clear_audio_status(&app);
                        last_audio_states = None;
                        let _ = app.emit("pipeline-status", serde_json::json!({"running": false}));
                        continue;
                    }
                    auto_restarts.push(now);
                    info!("restarting pipeline after capture failure");
                } else {
                    if pipeline.as_ref().is_some_and(|p| p.is_recording()) {
                        warn!("capture settings changed during a manual recording — restart deferred; re-save settings after the recording ends");
                        continue;
                    }
                    info!("restarting pipeline to apply changed capture settings");
                }
                // drop the old monitor first (stops + joins its thread) so it can't fire on the
                // torn-down pipeline
                drop(monitor.take());
                *ring_handle.lock().unwrap() = None;
                *pipeline_running.lock().unwrap() = false;
                if let Some(p) = pipeline.take() {
                    if let Err(e) = p.stop() {
                        warn!("pipeline stop during restart: {e:#}");
                    }
                }
                let cfg = match clipdip_core::config::Config::load_or_default(&config_path) {
                    Ok(c) => c,
                    Err(e) => {
                        error!("config load for restart: {e:#}");
                        report_pipeline_error(&app, format!("{e:#}"));
                        continue;
                    }
                };
                replay_seconds = cfg.replay_seconds;
                health_alerts = cfg.notifications.enabled && cfg.notifications.health_alerts;
                notif_corner = corner_slug(&cfg.notifications.corner);
                pipeline = match clipdip_core::Pipeline::start(cfg) {
                    Ok(p) => {
                        info!("pipeline restarted");
                        let states = p.audio_states();
                        notify_audio_state_changes(
                            &app,
                            &notif_corner,
                            last_audio_states.as_deref(),
                            &states,
                        );
                        set_audio_status(&app, &states);
                        last_audio_states = Some(states);
                        *ring_handle.lock().unwrap() = Some(p.ring());
                        *pipeline_running.lock().unwrap() = true;
                        clear_pipeline_error(&app);
                        let _ = app.emit(
                            "pipeline-status",
                            serde_json::json!({"running": true}),
                        );
                        if health_alerts {
                            monitor = Some(HealthMonitor::spawn(
                                app.clone(),
                                HealthMonitorArgs {
                                    ring: p.ring(),
                                    liveness: p.frame_liveness(),
                                    video_error: p.video_error(),
                                    phase: p.capture_phase(),
                                    replay_seconds,
                                    corner: notif_corner.clone(),
                                    ev_tx: ev_tx.clone(),
                                },
                            ));
                        }
                        Some(p)
                    }
                    Err(e) => {
                        error!("pipeline restart: {e:#}");
                        report_pipeline_error(&app, format!("{e:#}"));
                        clear_audio_status(&app);
                        last_audio_states = None;
                        None
                    }
                };
            }
            LoopEvent::ReloadHotkeys => {
                let cfg = match clipdip_core::config::Config::load_or_default(&config_path) {
                    Ok(c) => c,
                    Err(e) => {
                        error!("config load for hotkey reload: {e:#}");
                        continue;
                    }
                };
                info!("reloading global hotkeys");
                // drop the old Raw Input window before registering the new one, only one
                // registration exists per process
                drop(listener.take());
                listener = spawn_hotkey_listener(&cfg, &ev_tx, &app);
            }
        }

        // a mid-recording device change parks here until the recording ends
        // (its save flow loops back through here).
        if audio_restart_deferred && pipeline.as_ref().is_some_and(|p| !p.is_recording()) {
            audio_restart_deferred = false;
            let _ = ev_tx.send(LoopEvent::AudioDevicesChanged);
        }
    }
    // stop the health monitor (and its thread) before tearing down hotkeys
    drop(monitor.take());
    drop(listener);
}

// helpers

// legacy React settings window, retired: config now lives in ClipLib's
// Settings -> Clipdip page. kept for reference.
#[allow(dead_code)]
fn open_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if let Ok(w) = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("ClipLib")
        .inner_size(980.0, 700.0)
        .min_inner_size(820.0, 580.0)
        .center()
        .decorations(false)
        .resizable(true)
        .visible(true)
        .initialization_script(CONSOLE_SCRIPT)
        .build()
    {
        disable_webview_autofill(&w);
        let _ = w.set_focus();
    }
}

/// opens ClipLib directly on its Clipdip settings page via the `cliplib://`
/// protocol; Windows starts (or focuses) the library.
fn open_library(_app: &AppHandle) {
    use windows::core::w;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            w!("cliplib://settings/clipdip"),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW returns >32 on success; no fallback UI since an
    // unregistered protocol means ClipLib itself was removed.
    if result.0 as usize <= 32 {
        warn!(
            "cliplib:// protocol not available (ShellExecuteW={}) — is ClipLib installed?",
            result.0 as usize
        );
    }
}

// stateless CLI queries

/// enumerates displays via Win32 so `--list-monitors` works without a Tauri
/// handle; order matches winit's `available_monitors`, so index lines up with `video.output_index`.
fn enumerate_monitors() -> Vec<serde_json::Value> {
    use windows::Win32::Foundation::{LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
    };

    unsafe extern "system" fn callback(
        hmon: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let monitors = &mut *(lparam.0 as *mut Vec<serde_json::Value>);
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmon, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
            let len = info
                .szDevice
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(info.szDevice.len());
            let rc = info.monitorInfo.rcMonitor;
            // MONITORINFOF_PRIMARY
            let is_primary = info.monitorInfo.dwFlags & 1 != 0;
            monitors.push(serde_json::json!({
                "index": monitors.len(),
                "name": String::from_utf16_lossy(&info.szDevice[..len]),
                "width": rc.right - rc.left,
                "height": rc.bottom - rc.top,
                "is_primary": is_primary,
            }));
        }
        TRUE
    }

    let mut monitors: Vec<serde_json::Value> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            HDC(std::ptr::null_mut()),
            None,
            Some(callback),
            LPARAM(&mut monitors as *mut _ as isize),
        );
    }
    monitors
}

/// handles stateless query flags ClipLib shells out for, before tauri/
/// single-instance init so they work regardless of a running instance.
/// prints one JSON line and exits (0/1), or returns normally.
fn handle_cli_query_flags() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let result: Option<Result<serde_json::Value, String>> =
        if argv.iter().any(|a| a == "--list-audio-devices") {
            Some(
                clipdip_audio::list_devices()
                    .map(|devices| serde_json::json!({ "devices": devices }))
                    .map_err(|e| format!("{e:#}")),
            )
        } else if argv.iter().any(|a| a == "--list-monitors") {
            Some(Ok(serde_json::json!({ "monitors": enumerate_monitors() })))
        } else if argv.iter().any(|a| a == "--filename-variables") {
            let variables: Vec<serde_json::Value> = clipdip_core::filename::VARIABLES
                .iter()
                .map(|v| {
                    serde_json::json!({
                        "token": v.token,
                        "description": v.description,
                        "example": v.example,
                    })
                })
                .collect();
            Some(Ok(serde_json::json!({ "variables": variables })))
        } else if let Some(pos) = argv.iter().position(|a| a == "--preview-filename") {
            Some(match argv.get(pos + 1) {
                Some(template) => Ok(serde_json::json!({
                    "preview": preview_filename(template.clone()),
                })),
                None => Err("--preview-filename requires a template argument".into()),
            })
        } else {
            return;
        };

    match result {
        Some(Ok(serde_json::Value::Object(mut payload))) => {
            payload.insert("ok".into(), true.into());
            println!("{}", serde_json::Value::Object(payload));
            std::process::exit(0);
        }
        Some(Err(e)) => {
            println!("{}", serde_json::json!({ "ok": false, "error": e }));
            std::process::exit(1);
        }
        // Payloads above are always objects; unreachable in practice.
        _ => std::process::exit(1),
    }
}

// control server

/// `control.json` lives next to `config.toml` and tells ClipLib where the
/// control server listens plus the token that authorizes requests.
fn control_file_path() -> Option<PathBuf> {
    let cfg = clipdip_core::config::Config::path().ok()?;
    cfg.parent().map(|p| p.join("control.json"))
}

/// starts the TCP JSON-lines control server (127.0.0.1, ephemeral port) for
/// ClipLib's UI: one request/response line per connection. failure is logged, non-fatal.
fn spawn_control_server(app: AppHandle) {
    let Some(control_path) = control_file_path() else {
        warn!("control server: could not resolve config directory, not starting");
        return;
    };
    let spawned = std::thread::Builder::new()
        .name("clipdip-control".into())
        .spawn(move || {
            if let Err(e) = run_control_server(app, control_path) {
                warn!("control server failed: {e:#}");
            }
        });
    if let Err(e) = spawned {
        warn!("control server thread spawn failed: {e}");
    }
}

fn run_control_server(app: AppHandle, control_path: PathBuf) -> anyhow::Result<()> {
    use std::fmt::Write as _;

    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();

    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| anyhow::anyhow!("getrandom: {e}"))?;
    let token = bytes.iter().fold(String::with_capacity(32), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    });

    let doc = serde_json::json!({
        "port": port,
        "token": token,
        "pid": std::process::id(),
    });
    std::fs::write(&control_path, doc.to_string())?;
    info!("control server listening on 127.0.0.1:{port}");

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let app = app.clone();
        let token = token.clone();
        let _ = std::thread::Builder::new()
            .name("clipdip-control-conn".into())
            .spawn(move || handle_control_connection(stream, &app, &token));
    }
    Ok(())
}

fn handle_control_connection(stream: std::net::TcpStream, app: &AppHandle, token: &str) {
    use std::io::{BufRead as _, BufReader, Write as _};

    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(10)));
    let Ok(read_half) = stream.try_clone() else { return };
    let mut line = String::new();
    if BufReader::new(read_half).read_line(&mut line).is_err() {
        return;
    }
    let response = control_dispatch(app, token, &line);
    let mut stream = stream;
    let _ = writeln!(stream, "{response}");
}

/// Parse + authorize one request line and run the command. Always returns a
/// JSON object with `ok`; errors carry an `error` message.
fn control_dispatch(app: &AppHandle, token: &str, line: &str) -> serde_json::Value {
    let err = |msg: String| serde_json::json!({ "ok": false, "error": msg });

    let req: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(e) => return err(format!("malformed request: {e}")),
    };
    if req.get("token").and_then(|t| t.as_str()) != Some(token) {
        return err("unauthorized".into());
    }
    let Some(cmd) = req.get("cmd").and_then(|c| c.as_str()) else {
        return err("missing cmd".into());
    };
    let args = req.get("args").cloned().unwrap_or(serde_json::Value::Null);

    match run_control_command(app, cmd, &args) {
        Ok(payload) => {
            let mut obj = match payload {
                serde_json::Value::Object(m) => m,
                serde_json::Value::Null => serde_json::Map::new(),
                other => {
                    let mut m = serde_json::Map::new();
                    m.insert("result".into(), other);
                    m
                }
            };
            obj.insert("ok".into(), true.into());
            serde_json::Value::Object(obj)
        }
        Err(e) => err(e),
    }
}

/// control command set: thin adapters over the same functions the Tauri
/// commands use, so behavior matches the legacy window and ClipLib.
fn run_control_command(
    app: &AppHandle,
    cmd: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "app state unavailable".to_string())?;

    match cmd {
        "status" => Ok(serde_json::json!({
            "pipeline_running": *state.pipeline_running.lock().unwrap(),
            "pipeline_error": state.pipeline_error.lock().unwrap().clone(),
            "buffer_stats": get_buffer_stats(state.clone()),
            "discord": state.discord.status(),
            "audio_sources": state.audio_status.lock().unwrap().clone(),
            "version": env!("CARGO_PKG_VERSION"),
        })),
        "get_pipeline_running" => Ok(serde_json::json!({
            "running": get_pipeline_running(state),
        })),
        "test_overlay" => {
            let stage = args
                .get("stage")
                .and_then(|s| s.as_str())
                .ok_or("missing stage")?
                .to_string();
            tauri::async_runtime::block_on(test_overlay(app.clone(), state, stage))?;
            Ok(serde_json::json!({}))
        }
        "discord_connect" => {
            state.discord.connect();
            Ok(serde_json::json!({}))
        }
        "discord_disconnect" => {
            state.discord.disconnect();
            Ok(serde_json::json!({}))
        }
        "open_clips_folder" => {
            open_clips_folder(state)?;
            Ok(serde_json::json!({}))
        }
        "get_telemetry_status" => Ok(get_telemetry_status(state)),
        "set_telemetry_enabled" => {
            let enabled = args
                .get("enabled")
                .and_then(|e| e.as_bool())
                .ok_or("missing enabled")?;
            set_telemetry_enabled(enabled, state)?;
            Ok(serde_json::json!({}))
        }
        "upload_diagnostics_bundle" => {
            let note = args
                .get("note")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string());
            let id = upload_diagnostics_bundle(note, state)?;
            Ok(serde_json::json!({ "id": id }))
        }
        "restart_pipeline" => {
            restart_pipeline(state)?;
            Ok(serde_json::json!({}))
        }
        "reload_hotkeys" => {
            reload_hotkeys(state)?;
            Ok(serde_json::json!({}))
        }
        "get_notification_history" => Ok(serde_json::json!({
            "notifications": get_notification_history(),
        })),
        other => {
            // ClipLib sent a command this build doesn't know, a direct detector for bridge version skew
            if let clipdip_diagnostics::Gate::Send { suppressed } =
                clipdip_diagnostics::gate("control_unknown_command", std::time::Duration::from_secs(60))
            {
                clipdip_diagnostics::report_error_with(
                    "control_unknown_command",
                    clipdip_diagnostics::Severity::Warning,
                    format!("control server received unknown command '{other}'"),
                    Some(serde_json::json!({
                        "cmd": other,
                        "occurrences": suppressed + 1,
                    })),
                );
            }
            Err(format!("unknown command '{other}'"))
        }
    }
}

// main

fn main() {
    // stateless query flags exit here, before logging (stdout must stay pure JSON), single-instance
    // forwarding, and tauri init
    handle_cli_query_flags();
    use tracing_subscriber::prelude::*;

    // held for the whole process: dropping this guard flushes and stops the non-blocking log
    // writer's background thread
    let mut _log_guard: Option<tracing_appender::non_blocking::WorkerGuard> = None;
    let mut file_layer = None;
    // diagnostics client uses this to raise the file-log level on a server
    // override (debug/trace); `None` restores default, set only if the file log exists.
    let mut set_log_level: Option<
        Box<dyn Fn(Option<clipdip_diagnostics::LogLevel>) + Send + Sync>,
    > = None;

    if let Some(dirs) = directories::ProjectDirs::from("", "", "clipdip") {
        let log_dir = dirs.data_local_dir().join("logs");
        if std::fs::create_dir_all(&log_dir).is_ok() {
            let log_path = log_dir.join("clipdip.log");

            // Rotate at startup if the file exceeds 10MB.
            if let Ok(metadata) = std::fs::metadata(&log_path) {
                if metadata.len() > 10 * 1024 * 1024 {
                    let old_path = log_dir.join("clipdip.log.old");
                    let _ = std::fs::remove_file(&old_path);
                    let _ = std::fs::rename(&log_path, &old_path);
                }
            }

            if let Ok(file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                // non-blocking writer: threads hand lines to a queue drained by one
                // background thread, not a synchronous write() under a shared mutex.
                // critical for capture: the old blocking writer let a disk hitch (AV
                // scan, NTFS flush) stall every capture thread and collapse the buffer
                // to ~1s. DEBUG keeps per-frame/audio spam off disk.
                let (non_blocking, guard) = tracing_appender::non_blocking(file);
                _log_guard = Some(guard);

                // reload handle lets diagnostics bump this install to TRACE on server
                // request, back to DEBUG when the override expires.
                use tracing_subscriber::filter::LevelFilter;
                let (reload_filter, reload_handle) =
                    tracing_subscriber::reload::Layer::new(LevelFilter::DEBUG);
                let layer = tracing_subscriber::fmt::layer()
                    .with_writer(non_blocking)
                    .with_ansi(false)
                    .with_filter(reload_filter);
                file_layer = Some(layer);
                set_log_level = Some(Box::new(move |level| {
                    let target = match level {
                        None | Some(clipdip_diagnostics::LogLevel::Debug) => LevelFilter::DEBUG,
                        Some(clipdip_diagnostics::LogLevel::Trace) => LevelFilter::TRACE,
                    };
                    let _ = reload_handle.modify(|f| *f = target);
                }));
            }
        }
    }

    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        );

    tracing_subscriber::registry()
        .with(stdout_layer)
        .with(file_layer)
        .init();

    // global profiler opt-in; controls the periodic stage reporter and the per-save timing logs below
    if matches!(
        std::env::var("CLIPDIP_PROFILE").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    ) {
        clipdip_profile::enable();
        info!("profiling enabled (CLIPDIP_PROFILE)");
    }

    // pins the process-wide MTA: the windows crate caches WinRT factories
    // globally, owned by the thread that first called RoInitialize (the video
    // thread). that thread exiting on a restart tears it down, dangling the
    // cached pointers, a deterministic AV on the next WGC call.
    unsafe {
        use windows::Win32::System::Com::CoIncrementMTAUsage;
        if let Err(e) = CoIncrementMTAUsage() {
            warn!("CoIncrementMTAUsage failed: {e:?} — pipeline restart may crash");
        }
    }

    let config_path = clipdip_core::config::Config::path()
        .unwrap_or_else(|_| PathBuf::from("config.toml"));

    let active_clip: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let pipeline_running: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));
    let ring_handle: Arc<Mutex<Option<Arc<clipdip_ringbuf::PacketRing>>>> =
        Arc::new(Mutex::new(None));
    // control + hotkey event channel for the capture loop, created here so commands can send via AppState
    let (loop_tx, loop_rx) = unbounded::<LoopEvent>();

    // Discord RPC manager keeps a warm connection + voice-call roster once
    // authorized; tokens live next to config. enabled+unauthenticated prompts on its own (once per run).
    let discord_enabled = clipdip_core::config::Config::load_or_default(&config_path)
        .map(|c| c.discord.enabled)
        .unwrap_or(true);
    let discord_dir = config_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let discord = Arc::new(clipdip_discord::spawn(discord_dir, discord_enabled));

    // opt-out diagnostics client reports failures/crashes + a heartbeat; inert
    // without a compiled-in CLIPDIP_INGEST_KEY or if opted out. wired to the
    // log-level reload handle for server-triggered debug.
    let startup_cfg = clipdip_core::config::Config::load_or_default(&config_path);
    let telemetry_enabled = startup_cfg
        .as_ref()
        .map(|c| c.telemetry.enabled)
        .unwrap_or(true);
    // one-shot hardware profile for the heartbeat; collected regardless of opt-out (cheap, local),
    // only sent when telemetry is on
    let machine = startup_cfg
        .as_ref()
        .ok()
        .map(|c| machine_profile::collect(c));
    let diagnostics = clipdip_diagnostics::init(clipdip_diagnostics::InitOptions {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        enabled: telemetry_enabled,
        on_log_level: set_log_level,
        base_url: None,
        machine,
    });

    // panics report as `crash` events; release aborts on panic, so this
    // appends synchronously to the durable queue and ships next launch.
    {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // thread name + backtrace make crash groups actionable; scrubber strips
            // Windows usernames since panic messages love embedding paths.
            let thread = std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_string();
            let backtrace = std::backtrace::Backtrace::force_capture().to_string();
            let bt_short: String = backtrace.chars().take(3000).collect();
            let message = clipdip_diagnostics::scrub_user_paths(&format!(
                "{thread}: {info}\n{bt_short}"
            ));
            clipdip_diagnostics::report_crash(&message);
            prev(info);
        }));
    }

    tauri::Builder::default()
        // registered first so a second invocation exits before doing work;
        // doubles as the control surface, ClipLib's `--reload`/`--quit` argv gets forwarded here
        // into the running process.
        .plugin(tauri_plugin_single_instance::init({
            let loop_tx = loop_tx.clone();
            move |app, argv, _cwd| {
                if argv.iter().any(|a| a == "--quit") {
                    info!("control: --quit received, exiting");
                    app.exit(0);
                    return;
                }
                if argv.iter().any(|a| a == "--reload") {
                    info!("control: --reload received, restarting pipeline + hotkeys");
                    let _ = loop_tx.send(LoopEvent::Restart);
                    let _ = loop_tx.send(LoopEvent::ReloadHotkeys);
                } else if argv.iter().any(|a| a == "--reload-hotkeys") {
                    // cheap path: re-register hotkeys without tearing down the pipeline (a full
                    // restart clears the buffer)
                    info!("control: --reload-hotkeys received");
                    let _ = loop_tx.send(LoopEvent::ReloadHotkeys);
                }
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            config_path: config_path.clone(),
            active_clip: active_clip.clone(),
            pipeline_running: pipeline_running.clone(),
            audio_status: Arc::new(Mutex::new(serde_json::Value::Array(Vec::new()))),
            pending_saving: Arc::new(Mutex::new(None)),
            pending_saved: Arc::new(Mutex::new(None)),
            pending_notice: Arc::new(Mutex::new(None)),
            pending_hint: Arc::new(Mutex::new(None)),
            hint_active: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            pending_update: Arc::new(Mutex::new(None)),
            update_toast_shown: Arc::new(Mutex::new(None)),
            update_toast_active: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            update_installing: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            ring: ring_handle.clone(),
            recording_active: Arc::new(Mutex::new(false)),
            loop_tx: loop_tx.clone(),
            overlay_booted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            discord: discord.clone(),
            diagnostics: diagnostics.clone(),
            pipeline_error: Arc::new(Mutex::new(None)),
        })
        .setup(move |app| {
            // a control invocation with no running instance becomes the primary
            // itself; exit before tray/capture loop start so a stale reload can't boot a
            // second-class capturing instance.
            if std::env::args().any(|a| a == "--quit" || a == "--reload" || a == "--reload-hotkeys") {
                info!("control flag on primary instance argv — nothing running to control, exiting");
                app.handle().exit(0);
                return Ok(());
            }

            // log configured hotkeys so the user can confirm them in the console
            let cfg_peek = clipdip_core::config::Config::load_or_default(&config_path)
                .unwrap_or_default();
            info!(
                "hotkeys — save: {}  rename: {}  record: {}",
                cfg_peek.hotkey.save_clip,
                cfg_peek.hotkey.rename_clip,
                cfg_peek.hotkey.toggle_recording
            );

            // build system tray
            let menu = Menu::with_items(app, &[
                &MenuItem::with_id(app, "show", "Open ClipLib", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "quit", "Quit ClipLib", true, None::<&str>)?,
            ])?;

            let tooltip = format!(
                "ClipLib\nSave clip: {}\nRecord: {}",
                cfg_peek.hotkey.save_clip, cfg_peek.hotkey.toggle_recording
            );

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip(tooltip)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => open_library(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        open_library(tray.app_handle());
                    }
                })
                .build(app)?;

            // no webview windows at startup; main opens on demand via the tray
            // overlay per-notification, so WebView2 isn't running while idle.

            // poll GitHub Releases for updates every 30 seconds
            spawn_update_checker(app.handle().clone());

            // hint at the settings toggle if Discord consent popups fire abnormally often
            spawn_discord_prompt_watch(app.handle().clone());

            // silent hotkey update leaves a marker with the target version; if
            // we're now running it, confirm with an "Updated to vX" toast.
            if let Some(marker) = updated_marker_path(&config_path) {
                if let Ok(v) = std::fs::read_to_string(&marker) {
                    let _ = std::fs::remove_file(&marker);
                    let v = v.trim().to_string();
                    if v == env!("CARGO_PKG_VERSION") {
                        // the true end-to-end update success signal: the installed build actually booted
                        clipdip_diagnostics::report_custom(
                            "update_completed",
                            clipdip_diagnostics::Severity::Info,
                            format!("update to v{v} landed and booted"),
                            Some(serde_json::json!({ "version": v })),
                        );
                        let app2 = app.handle().clone();
                        std::thread::spawn(move || {
                            // give WebView2 + the pipeline a beat to settle so the toast isn't
                            // eaten by startup
                            std::thread::sleep(std::time::Duration::from_secs(3));
                            notify_updated(&app2, &v);
                        });
                    } else {
                        info!(
                            "stale update marker (v{v}, running v{}) — ignored",
                            env!("CARGO_PKG_VERSION")
                        );
                        // install ran but a different version is running: a silently failed or
                        // rolled-back install
                        clipdip_diagnostics::report_error(
                            "update_stale_marker",
                            format!(
                                "update marker v{v} but running v{} — install silently failed?",
                                env!("CARGO_PKG_VERSION")
                            ),
                            Some(serde_json::json!({
                                "marker_version": v,
                                "running_version": env!("CARGO_PKG_VERSION"),
                            })),
                        );
                    }
                }
            }

            // Start the capture pipeline and hotkey loop in a background thread.
            let handle = app.handle().clone();
            let active = active_clip.clone();
            let running = pipeline_running.clone();
            let ring = ring_handle.clone();
            let tx = loop_tx.clone();
            std::thread::spawn(move || {
                run_capture_loop(handle, config_path, active, running, ring, tx, loop_rx)
            });

            // react to audio devices coming/going: a reconnected headset or default
            // switch re-points sources instead of leaving silent tracks until reboot.
            spawn_audio_device_watcher(loop_tx.clone());

            // control surface for ClipLib's settings UI (TCP JSON-lines on localhost; port + token
            // published via control.json)
            spawn_control_server(app.handle().clone());

            // hidden window watching for WM_QUERYENDSESSION so an OS shutdown ends the session as
            // "shutdown", not "died"
            shutdown_watch::spawn();

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            update_config,
            rename_clip,
            set_overlay_input_mode,
            dismiss_notification,
            play_saved_sound,
            list_monitors,
            list_audio_devices,
            get_filename_variables,
            preview_filename,
            open_clips_folder,
            get_pipeline_running,
            restart_pipeline,
            get_buffer_stats,
            forward_console,
            report_frontend_event,
            overlay_get_pending,
            test_notification,
            test_overlay,
            get_autostart_info,
            set_autostart_status,
            reload_hotkeys,
            discord_status,
            discord_connect,
            discord_disconnect,
            discord_current_roster,
            get_telemetry_status,
            set_telemetry_enabled,
            upload_diagnostics_bundle,
            get_pending_update,
            get_notification_history,
        ])
        .build(tauri::generate_context!())
        .expect("error building clipdip")
        .run(|_app, event| {
            // tray-resident background process: destroying the overlay or closing
            // settings would drop the last webview and exit Tauri, so keep the process alive.
            match &event {
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    info!("run event: ExitRequested (code={code:?})");
                    if code.is_none() {
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::Exit => {
                    info!("run event: Exit");
                    // clean shutdown beacon (tray quit, --quit, control-flag exit all
                    // funnel here); no-op if an earlier path already reported a more specific reason.
                    clipdip_diagnostics::session_end("quit");
                    // drop the control file so clients don't try to reach a dead server
                    if let Some(p) = control_file_path() {
                        let _ = std::fs::remove_file(p);
                    }
                }
                _ => {}
            }
        });
}
