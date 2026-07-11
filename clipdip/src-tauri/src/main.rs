#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod metadata;

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
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

// Overlay is a fullscreen transparent click-through window — the React
// side positions the card at the configured corner via CSS. Fullscreen
// also hides Windows' DWM shadow (it extends past the screen edge).

/// Disable Windows' DWM transition animations on the overlay HWND so
/// `show()` is instant — no scale-up animation playing on top of the
/// React enter animation.
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

/// Save-sound WAV bytes, embedded so we don't have to resolve a file path at
/// runtime. PlaySoundW with SND_MEMORY reads directly from this static buffer.
const SAVE_SOUND_WAV: &[u8] = include_bytes!("../../assets/sound/save.wav");

/// Play the embedded save-sound asynchronously. Replaces the webview-side
/// `new Audio()` call — playing from the webview blocks on the JS event
/// loop and forces an extra layout pass while the WebView2 process is
/// already busy rendering the notification.
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
  // Devtools helper: call testNotification() to trigger a fake clip-save flow.
  try {
    window.testNotification = function() {
      if (!window.__TAURI_INTERNALS__) { console.warn('Tauri not available'); return; }
      return window.__TAURI_INTERNALS__.invoke('test_notification');
    };
  } catch(e) {}
})();
"#;

// ---------- shared state --------------------------------------------------

struct AppState {
    config_path: PathBuf,
    /// Path of the clip whose notification is currently on-screen (if any).
    active_clip: Arc<Mutex<Option<String>>>,
    pipeline_running: Arc<Mutex<bool>>,
    /// Latest `clip-saving` payload, stashed here for the overlay to fetch
    /// on mount via `overlay_get_pending`. Events emitted before a webview
    /// is mounted are dropped silently — the overlay is now lazily
    /// created per-notification, so we'd lose the phase-1 payload without
    /// this safety net.
    pending_saving: Arc<Mutex<Option<ClipSavingPayload>>>,
    /// Companion to `pending_saving` for phase 2. WebView2 cold-start can
    /// take several seconds — long enough for the entire save flow
    /// (saving → saved) to complete before the overlay's listeners
    /// attach, in which case both events fire into the void. Stashing
    /// the saved payload too lets the overlay hydrate straight into the
    /// "Clip saved" state on mount instead of being stuck on the
    /// spinner forever.
    pending_saved: Arc<Mutex<Option<ClipSavedPayload>>>,
    /// Latest update found by the background checker, stashed for the
    /// overlay to hydrate from (same race as the other pendings) and for
    /// the settings window to query on mount.
    pending_update: Arc<Mutex<Option<UpdatePayload>>>,
    /// Version the update overlay toast was already shown for — the
    /// 30-second checker must not re-toast the same release forever.
    update_toast_shown: Arc<Mutex<Option<String>>>,
    /// True while the update toast is on screen. Gates the global Escape
    /// (dismiss) and rename-hotkey (install now) behaviors.
    update_toast_active: Arc<std::sync::atomic::AtomicBool>,
    /// True while a silent hotkey-triggered install is running — blocks
    /// double-triggers and Escape-dismiss mid-install.
    update_installing: Arc<std::sync::atomic::AtomicBool>,
    /// Stash for transient notice toasts ("Recording started"), same
    /// late-mount race as the two fields above.
    pending_notice: Arc<Mutex<Option<NoticePayload>>>,
    /// Live handle to the running pipeline's packet ring, for the settings
    /// UI's size estimate. `None` while no pipeline is running.
    ring: Arc<Mutex<Option<Arc<clipdip_ringbuf::PacketRing>>>>,
    /// Whether a manual recording is in progress — drives the overlay's
    /// red recording dot (and survives overlay re-mounts via
    /// `overlay_get_pending`).
    recording_active: Arc<Mutex<bool>>,
    /// Control channel into `run_capture_loop` — lets commands ask the
    /// capture loop to restart the pipeline after config changes.
    loop_tx: crossbeam_channel::Sender<LoopEvent>,
    /// Set true once the overlay webview reports in via `overlay_get_pending`
    /// (i.e. its page actually loaded). A boot watchdog uses this to
    /// force-close an overlay whose page failed to load, so a broken webview
    /// can never leave a stuck (potentially fullscreen) error page on screen.
    overlay_booted: Arc<std::sync::atomic::AtomicBool>,
    /// Background Discord RPC connection. Keeps the current voice-call
    /// roster warm so the save flow can snapshot it at hotkey time. Always
    /// present; reports `Disabled` when no client secret is compiled in.
    discord: Arc<clipdip_discord::DiscordHandle>,
    /// Anonymous, opt-out diagnostics client. Drives the settings toggle and
    /// the manual "export & upload diagnostics" action. Inert without a
    /// compiled-in ingest key.
    diagnostics: Arc<clipdip_diagnostics::Diagnostics>,
    /// Most recent `pipeline-error` payload, retained for the control
    /// server's `status` command. Cleared when the pipeline (re)starts
    /// successfully.
    pipeline_error: Arc<Mutex<Option<String>>>,
}

/// Emit a `pipeline-error` event and retain the message in state so the
/// control server's `status` command can report it after the fact.
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

// ---------- event payloads ------------------------------------------------

/// Phase-1 notification, emitted as soon as the desktop screenshot is
/// ready (~150–250 ms after the hotkey). Carries the thumbnail and every
/// visual the overlay needs to render its initial state — corner,
/// auto-dismiss window, rename hint, whether to chirp. Title and path
/// don't exist yet; the overlay shows a spinner where the saved-state
/// pip will go.
#[derive(Clone, Serialize)]
struct ClipSavingPayload {
    thumbnail: Option<String>,
    rename_hotkey: String,
    auto_dismiss_secs: u32,
    corner: String,
    sound: bool,
    /// Mirrors `clipdip_profile::enabled()` so the overlay knows whether
    /// to emit its phase-timing logs alongside the backend's.
    profile: bool,
    /// `"clip"` (replay-buffer save) or `"recording"` (manual recording
    /// stop) — the overlay words its messages accordingly.
    kind: String,
}

/// Transient toast with no save flow attached ("Recording started").
/// The overlay shows the message and auto-dismisses after a few seconds.
#[derive(Clone, Serialize)]
struct NoticePayload {
    message: String,
    corner: String,
}

/// "A new version is out" toast. Shown on the in-game overlay when the
/// background update check finds a release while the settings window is
/// closed — it tells the user to open the app, where the in-app banner
/// does the actual 2-click update.
#[derive(Clone, Serialize)]
struct UpdatePayload {
    version: String,
    corner: String,
    /// The rename hotkey doubles as the "update now" hotkey while the
    /// toast is up — the toast renders it as kbd chips.
    hotkey: String,
    /// `"available"` (update found, prompt to act) or `"installed"`
    /// (post-restart confirmation after a silent hotkey update).
    kind: String,
}

/// Phase-2 update, emitted once the mux finishes. The overlay merges
/// these fields into the saving state — spinner → teal pip, title +
/// rename input appear — and only now allows the rename hotkey to
/// focus the input.
#[derive(Clone, Serialize)]
struct ClipSavedPayload {
    path: String,
    title: String,
    /// Same convention as [`ClipSavingPayload::kind`].
    kind: String,
}

/// Out-of-band thumbnail delivery. ffmpeg's `gdigrab` pays ~1–2 s of
/// process startup + DirectShow init the first time it runs, so we no
/// longer block phase-1 on it — the overlay slots the image in whenever
/// this event arrives, which may be during phase 1 or phase 2.
#[derive(Clone, Serialize)]
struct ClipThumbnailPayload {
    thumbnail: String,
}

#[derive(Clone, Serialize)]
struct ClipRenamedPayload {
    old_path: String,
    new_path: String,
    new_title: String,
}

// ---------- overlay window management -------------------------------------

/// `BottomRight` → `"bottom_right"` — the corner format the overlay CSS uses.
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

/// Turn off WebView2's form autofill on a window. The rename input already
/// carries `autocomplete="new-password"` etc., but Edge's *general
/// autofill* (the "things you typed before" dropdown) ignores all of the
/// HTML-side hints — it can only be disabled at the engine level.
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

/// Create the notification overlay window (small, transparent, positioned
/// at the configured corner) and disable its native window-show animation.
/// Idempotent — if the window already exists, repositions it for the
/// requested corner, shows it, and returns it.
///
/// This is called on every save hotkey rather than at startup so the
/// WebView2 process stays dead while the user isn't actively saving.
fn ensure_overlay_window(app: &AppHandle, corner: &str) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.set_ignore_cursor_events(true);
        exclude_from_capture(&w);
        let _ = w.show();
        return Some(w);
    }
    let monitor = app.primary_monitor().ok().flatten()?;
    let (mw, mh) = (monitor.size().width, monitor.size().height);
    // Separate entry point: `overlay.html` is a self-contained vanilla
    // HTML/CSS/JS file with no React, no Tailwind, no Google Fonts and
    // no module graph. The settings UI loads from `index.html`. This
    // shaves the bulk of WebView2 cold-start time — the bottleneck was
    // never the webview itself, it was bundling + parsing the React
    // app before the overlay could paint.
    let url = format!("overlay.html?corner={}", corner);
    let w = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App(url.into()))
        .inner_size(mw as f64, mh as f64)
        .position(0.0, 0.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        // Build hidden, disable DWM transitions, THEN show — otherwise
        // Windows plays the scale-up animation on first show, which
        // visibly competes with the React enter animation.
        .visible(false)
        .resizable(false)
        .initialization_script(CONSOLE_SCRIPT)
        .build()
        .ok()?;
    let _ = w.set_ignore_cursor_events(true);
    if let Ok(hwnd) = w.hwnd() {
        // Tauri pulls in `windows` 0.61; we pin 0.58 across the workspace
        // for COM-ABI consistency, so HWND types differ between crates
        // despite being identical layout. Round-trip through the raw
        // pointer to bridge them.
        disable_window_transitions(HWND(hwnd.0 as *mut _));
    }
    exclude_from_capture(&w);
    disable_webview_autofill(&w);
    let _ = w.show();

    // Boot watchdog: a fresh overlay must report in via `overlay_get_pending`
    // (it calls that on mount) within a few seconds. If it doesn't, the page
    // failed to load — e.g. the dev server is down (404), or WebView2 wedged —
    // and the window would otherwise sit on screen showing a broken,
    // full-window error page that no JS can dismiss. Force-destroy it so a
    // failed load can never leave a stuck overlay over the user's game.
    // In the installed build the overlay is bundled and always loads, so this
    // never fires there — it's purely a safety net.
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

/// Exclude the overlay window from screen capture (DXGI duplication,
/// gdigrab, …) so the toast and the recording dot never photobomb the
/// clips themselves. Windows 10 2004+; failure is harmless (the overlay
/// just becomes visible in captures, as before).
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

/// Kill the overlay after a save failure. The React side has its own
/// clip-error listener, but if the error fires before the webview
/// finishes booting (Tauri drops events with no listener), the
/// notification stays stuck on "Saving clip…". Destroying the window
/// from the backend guarantees teardown regardless of webview state,
/// and also clears the stashed pending payload so a freshly-mounted
/// overlay can't hydrate the dead session.
fn tear_down_overlay(app: &AppHandle, err: String) {
    if let Some(state) = app.try_state::<AppState>() {
        *state.pending_saving.lock().unwrap() = None;
        *state.pending_saved.lock().unwrap() = None;
        *state.pending_notice.lock().unwrap() = None;
        *state.pending_update.lock().unwrap() = None;
        state
            .update_toast_active
            .store(false, std::sync::atomic::Ordering::SeqCst);
        *state.active_clip.lock().unwrap() = None;
    }
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.emit("clip-error", err);
        let _ = overlay.destroy();
    }
}

// ---------- tauri commands ------------------------------------------------

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

    // Check the current value name and the pre-rebrand "ClipDip" one, so an
    // install that autostarted before the ClipLib rename still reports
    // enabled until the value is migrated by the next toggle.
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

    // Best-effort: drop the pre-rebrand "ClipDip" value so toggling never
    // leaves two autostart entries behind.
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
    // Telemetry is owned by `set_telemetry_enabled` (which also notifies the
    // running diagnostics client). Preserve whatever is on disk so this
    // general settings round-trip can never clobber the opt-out toggle with a
    // stale value from the UI's config object.
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

/// Enable (true) or disable (false) click-through on the overlay window.
/// When enabling input mode, also focuses the window so it receives keyboard events.
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

/// Play the save chirp. Invoked by the overlay at the exact moment the
/// "saved" payoff animation starts, so audio and visuals land together
/// regardless of how WebView2 cold start raced the mux. The overlay only
/// calls this when the `sound` flag from the clip-saving payload was true
/// and the toast is for a clip, so no config re-check is needed here.
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
    state
        .update_toast_active
        .store(false, std::sync::atomic::Ordering::SeqCst);
    // While a manual recording runs, the overlay window stays alive to
    // keep the red recording dot on screen — the card has already slid
    // out on the JS side.
    if *state.recording_active.lock().unwrap() {
        return Ok(());
    }
    if let Some(w) = app.get_webview_window("overlay") {
        // Destroy (not hide) the window so the WebView2 process can exit
        // when the user isn't actively saving. `hide()` keeps the webview
        // alive and counts as a process the user can see in Task Manager.
        let _ = w.destroy();
    }
    Ok(())
}

/// Combined pending payload — both phase-1 (saving) and phase-2 (saved)
/// stashes, so a late-mounting overlay can hydrate straight to the
/// correct phase. Either field is `None` if that event hasn't fired yet
/// (or has already been consumed by a previous overlay mount).
#[derive(Clone, Serialize)]
struct PendingState {
    saving: Option<ClipSavingPayload>,
    saved: Option<ClipSavedPayload>,
    notice: Option<NoticePayload>,
    update: Option<UpdatePayload>,
    recording: bool,
}

/// Returns whatever clip-saving / clip-saved payloads were stashed
/// before the overlay window mounted. Tauri drops events with no
/// listener attached, and WebView2 cold start can outrun the entire
/// save flow — without this safety net the overlay would sit on the
/// spinner forever after a late mount.
#[tauri::command]
fn overlay_get_pending(state: State<'_, AppState>) -> PendingState {
    // The overlay calls this on mount — proof its page loaded. Clears the
    // boot watchdog so it won't force-close a healthy overlay.
    state
        .overlay_booted
        .store(true, std::sync::atomic::Ordering::SeqCst);
    PendingState {
        saving: state.pending_saving.lock().unwrap().clone(),
        saved: state.pending_saved.lock().unwrap().clone(),
        notice: state.pending_notice.lock().unwrap().clone(),
        update: state.pending_update.lock().unwrap().clone(),
        recording: *state.recording_active.lock().unwrap(),
    }
}

/// Trigger a fake overlay flow for design / smoke testing. `stage` picks
/// what to preview:
/// - `"flow"`     — full save flow: `clip-saving` then `clip-saved` 900 ms
///                  later, exactly like a real save.
/// - `"notice"`   — transient "Recording started" toast.
/// - `"rec_on"` / `"rec_off"` — toggle the red recording dot.
///
/// MUST be `async`: synchronous commands run on the main thread, and
/// `ensure_overlay_window` builds a webview window — window creation from
/// a sync command deadlocks the main thread on Windows (frozen UI, dead
/// IPC). Async commands run on the runtime thread pool, where the build
/// call can safely dispatch to the main thread.
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

            // No chirp here — the overlay invokes `play_saved_sound` when
            // its saved-state animation actually shows.

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
            };
            *state.pending_notice.lock().unwrap() = Some(notice.clone());
            *state.pending_saving.lock().unwrap() = None;
            *state.pending_saved.lock().unwrap() = None;
            if let Some(overlay) = ensure_overlay_window(&app, &corner) {
                let _ = overlay.emit("overlay-notice", notice);
            }
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
            // Mirror the real recording flow's UI state so the dot
            // survives overlay re-mounts and keeps the window alive.
            *state.recording_active.lock().unwrap() = on;
            if on {
                if let Some(overlay) = ensure_overlay_window(&app, &corner) {
                    let _ = overlay
                        .emit("recording-state", serde_json::json!({"recording": true}));
                }
            } else if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay.emit("recording-state", serde_json::json!({"recording": false}));
                // No toast on screen and the dot just went away — drop the
                // window like the real flow does after a recording ends.
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

/// Back-compat alias for the devtools `testNotification()` global —
/// previews the full save flow.
#[tauri::command]
async fn test_notification(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    test_overlay(app, state, "flow".into()).await
}

// ---------- auto-update ----------------------------------------------------

/// Update found by the background checker but not yet installed — the
/// settings window queries this on mount so the banner shows without
/// waiting for the next 30-second tick.
#[tauri::command]
fn get_pending_update(state: State<'_, AppState>) -> Option<UpdatePayload> {
    state.pending_update.lock().unwrap().clone()
}

/// Surface a freshly-discovered update to the user:
/// - the settings window (if open) gets an `update-available` event and
///   shows the in-app banner with the 2-click install;
/// - otherwise the in-game overlay shows a toast telling the user to
///   open the app (once per version — the checker re-fires every 30 s).
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

    // Settings window open → the banner handles it, no overlay toast.
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

    // Don't steal the overlay from an in-flight save toast — the stash is
    // set, so the user still gets the banner next time they open the app.
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

/// Post-restart confirmation after a silent hotkey update — short "Updated
/// to vX" toast in the same ember style. Triggered by the marker file the
/// installing process leaves behind (see `start_silent_update`).
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

/// Marker file the silent updater writes (target version) right before
/// installing. The next launch reads it: if the running version matches,
/// the update landed — show the "Updated to vX" toast.
fn updated_marker_path(config_path: &std::path::Path) -> Option<PathBuf> {
    config_path.parent().map(|p| p.join("updated-toast.marker"))
}

/// Download + install the pending update with zero further interaction —
/// the user pressed the update hotkey on the toast. The overlay shows an
/// "Updating…" state until the installer (quiet NSIS) restarts the app.
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
        let fail = |e: String| {
            warn!("silent update failed: {e}");
            if let Some(state) = app.try_state::<AppState>() {
                state.update_installing.store(false, Ordering::SeqCst);
            }
            if let Some(overlay) = app.get_webview_window("overlay") {
                let _ = overlay.emit("update-error", e);
            }
        };
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => return fail(e.to_string()),
        };
        let update = match tauri::async_runtime::block_on(updater.check()) {
            Ok(Some(u)) => u,
            Ok(None) => return fail("update no longer available".into()),
            Err(e) => return fail(e.to_string()),
        };
        // Marker before install: next launch shows the "updated" toast
        // only if the running version equals the marker (i.e. it landed).
        if let Some(state) = app.try_state::<AppState>() {
            if let Some(marker) = updated_marker_path(&state.config_path) {
                let _ = std::fs::write(marker, &update.version);
            }
        }
        info!("downloading update v{} for silent install", update.version);
        match tauri::async_runtime::block_on(update.download_and_install(|_, _| {}, || {})) {
            Ok(()) => {
                // Quiet NSIS usually kills + relaunches us itself; restart
                // is the fallback if we're still alive.
                info!("silent update installed — restarting");
                app.restart();
            }
            Err(e) => fail(e.to_string()),
        }
    });
}

/// Background auto-update checker: polls the GitHub Releases `latest.json`
/// every 30 seconds. Runs only in release builds (a dev build at 0.x would
/// nag about every published release) unless CLIPDIP_FORCE_UPDATE_CHECK=1.
/// Self-updating is retired: the binary ships inside ClipLib and the
/// library's updater replaces it in lockstep with the app. A self-updated
/// clipdip would drift from the config schema the library's settings UI
/// was written against. Flip only for a standalone build.
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
            // Transient network failures are expected — keep polling.
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

/// Expand a filename template with sample values + the current clock, so
/// the settings UI can show a live preview while the user types.
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

#[tauri::command]
fn get_pipeline_running(state: State<'_, AppState>) -> bool {
    *state.pipeline_running.lock().unwrap()
}

/// Ask the capture loop to restart the pipeline so changed capture
/// settings (encoder, audio sources, replay length) take effect. The
/// restart is asynchronous; `pipeline-status` events report the result.
#[tauri::command]
fn restart_pipeline(state: State<'_, AppState>) -> Result<(), String> {
    state
        .loop_tx
        .send(LoopEvent::Restart)
        .map_err(|e| e.to_string())
}

/// Ask the capture loop to re-register global hotkeys from the saved
/// config. Cheap — the replay buffer keeps running.
#[tauri::command]
fn reload_hotkeys(state: State<'_, AppState>) -> Result<(), String> {
    state
        .loop_tx
        .send(LoopEvent::ReloadHotkeys)
        .map_err(|e| e.to_string())
}

/// Live size estimate for the settings UI, measured from the ring buffer:
/// real encoded video bytes over the buffered time span, plus the AAC
/// bitrate the audio tracks will encode to at save time.
#[derive(Clone, Serialize, Default)]
struct BufferStats {
    /// `false` while there's no pipeline or under ~3s of footage buffered
    /// (the other fields are zero in that case).
    measuring: bool,
    mb_per_minute: f64,
    /// `mb_per_minute` scaled to the configured replay window.
    clip_mb: f64,
    buffered_secs: f64,
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
    BufferStats {
        measuring: true,
        mb_per_minute,
        clip_mb: mb_per_minute * cfg.replay_seconds as f64 / 60.0,
        buffered_secs: span_secs,
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

// ---------- discord commands ----------------------------------------------

/// Current Discord connection state for the settings UI (serialized
/// [`clipdip_discord::DiscordStatus`]).
#[tauri::command]
fn discord_status(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::to_value(state.discord.status()).unwrap_or(serde_json::Value::Null)
}

/// Begin the one-time authorization — shows the consent popup in the user's
/// Discord client. Silent-refresh keeps it connected afterward.
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

// ---------- diagnostics commands ------------------------------------------

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

// ---------- capture loop --------------------------------------------------

#[derive(Clone, Copy)]
enum LoopEvent {
    Save,
    Rename,
    ToggleRecording,
    /// Tear down and re-start the pipeline with freshly-loaded config.
    /// Sent by the `restart_pipeline` command after capture settings
    /// change (encoder options only apply at pipeline start).
    Restart,
    /// Same teardown/re-start, but initiated by the health monitor after
    /// the video capture thread died. Rate-limited by a storm guard in
    /// the capture loop so a persistently-broken capture can't restart
    /// the pipeline in a tight loop.
    RestartAfterFailure,
    /// Re-register the global hotkey listener with freshly-loaded config.
    /// Sent by the `reload_hotkeys` command when the user edits a hotkey,
    /// so the change applies without restarting the pipeline (or the app).
    ReloadHotkeys,
    /// Escape pressed anywhere (global). Only acted on while the update
    /// toast is on screen — dismisses it instantly.
    UpdateEscape,
}

/// What the shared save flow below is saving — a replay-buffer clip or a
/// just-stopped manual recording. Controls which pipeline call runs and
/// how the overlay words its messages.
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

/// Parse the configured hotkeys and spawn the single Raw Input listener
/// for all of them. A single HotkeyListener handles all bindings —
/// RegisterRawInputDevices only supports one registration per device type
/// per process, so splitting them across multiple listeners would
/// silently discard all but the last. Fired hotkeys are forwarded into
/// the capture loop via `ev_tx`; the forwarder threads exit on their own
/// when the returned listener is dropped (their receivers disconnect).
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
    // Global Escape — only acted on while the update toast is on screen
    // (the loop handler gates it), so it never eats anything.
    match clipdip_hotkey::HotkeyBinding::parse("Esc") {
        Ok(b) => {
            binding_events.push(LoopEvent::UpdateEscape);
            binding_defs.push(b);
        }
        Err(e) => warn!("esc binding parse failed: {e:#}"),
    }
    if binding_defs.is_empty() {
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
            report_pipeline_error(app, format!("hotkeys: {e:#}"));
            None
        }
    }
}

/// Native Windows toast. No-op-safe: failure to show is swallowed (a missing
/// notification must never take down capture).
fn notify_native(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        warn!("native notification failed: {e:#}");
    }
}

/// Health alert that the user can actually see while gaming. Windows
/// suppresses native toasts during fullscreen play (gaming Do-Not-Disturb /
/// Focus Assist) — on 2026-07-05 five "capture froze" toasts fired and the
/// user saw none of them. So health alerts go BOTH ways: the toast (for
/// desktop visibility + the Action Center trail) and the in-game overlay
/// notice (the same always-on-top window the clip-saved card uses).
fn notify_health(app: &AppHandle, corner: &str, title: &str, body: &str) {
    notify_native(app, title, body);
    let notice = NoticePayload {
        message: format!("{title} — {body}"),
        corner: corner.to_string(),
    };
    if let Some(state) = app.try_state::<AppState>() {
        *state.pending_notice.lock().unwrap() = Some(notice.clone());
    }
    if let Some(overlay) = ensure_overlay_window(app, corner) {
        let _ = overlay.emit("overlay-notice", notice);
    }
}

/// Background watchdog that turns silent capture degradation into an instant,
/// proactive Windows toast — independent of the clip/save flow. Runs on its
/// own ~1 Hz timer for the lifetime of one pipeline; dropping it stops and
/// joins the thread (so a pipeline Restart cleanly replaces the monitor).
///
/// Two signals, both read from data the pipeline already exposes:
/// - **Capture stall** — `qpc_now - frame_liveness` exceeds a threshold, i.e.
///   no frame has been produced for seconds (GPU/display power transition).
/// - **Replay buffer low** — the buffered video span has dropped well below
///   the configured window, so a clip saved *right now* would be short.
///
/// Hysteresis (fire only after the condition persists, clear only after it's
/// been gone a few ticks) keeps a flaky moment from spamming toasts.
struct HealthMonitor {
    stop: Arc<std::sync::atomic::AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

/// Everything one `health_loop` needs; bundled so the two spawn sites
/// don't repeat a pile of positional arguments.
struct HealthMonitorArgs {
    ring: Arc<clipdip_ringbuf::PacketRing>,
    liveness: Arc<std::sync::atomic::AtomicI64>,
    /// Error the video thread died with, if it has died.
    video_error: Arc<Mutex<Option<String>>>,
    phase: Arc<std::sync::atomic::AtomicU8>,
    replay_seconds: u32,
    /// Overlay corner for in-game health notices.
    corner: String,
    /// Channel back into the capture loop, for requesting a pipeline
    /// restart when the video thread has died.
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

    // No frame for this long ⇒ capture stalled. Well above the ~200ms DXGI
    // acquire stalls that happen under load, and above the video thread's own
    // 0.5s stall-compensation threshold.
    const STALL_IDLE_100NS: i64 = 20_000_000; // 2s
    // No frame for THIS long ⇒ the capture thread is wedged inside a GPU call
    // that never returned (the "1-second clip" root cause). It can't self-heal
    // — the thread holds the DXGI duplication and can't be torn down — so the
    // only reliable recovery is restarting the process. 15s is unambiguous: no
    // legitimate gap lasts that long, and the media clock already absorbs real
    // stalls shorter than the window.
    const WEDGE_RESTART_100NS: i64 = 150_000_000; // 15s
    let window_100ns = replay_seconds as i64 * 10_000_000;
    // "Low" = the buffer dropped more than max(10%, 5s) below the window.
    let underfull_floor = window_100ns - (window_100ns / 10).max(50_000_000);

    let mut polls: u64 = 0; // ~one per second
    let mut bad = 0u32; // consecutive degraded ticks (debounce in)
    let mut good = 0u32; // consecutive healthy ticks (debounce out)
    let mut degraded = false;
    // Only auto-restart once capture has actually worked this session, so a
    // wedge that somehow happens at startup can't cause a restart loop.
    let mut seen_healthy = false;
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

        // Video thread died (capture error it couldn't recover from, e.g.
        // a display-mode change that invalidated the encoder dimensions).
        // Alert + ask the capture loop for an in-process pipeline restart —
        // much cheaper than the whole-app restart the wedge path needs, and
        // it re-inits the encoder at the new display size. One-shot: send
        // the request, then exit; the restart replaces this monitor.
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
                "Clipdip — capture stopped",
                "Screen capture hit an error and is restarting. The replay buffer starts refilling now.",
            );
            let _ = ev_tx.send(LoopEvent::RestartAfterFailure);
            return;
        }

        // Independent capture heartbeat (~every 10s). Logged from this thread,
        // NOT the video loop, so it keeps reporting even if capture freezes —
        // a gap in heartbeats means the *process* froze; a heartbeat showing
        // frame_idle climbing while ring_span shrinks means frame production
        // stopped while the ring drained. This is the trail that pins down the
        // "ring emptied to <1s" failure the per-frame logs used to (noisily)
        // reveal.
        if polls % 10 == 0 {
            let live_now = liveness.load(Ordering::Relaxed);
            let idle_secs = if live_now == 0 {
                -1.0
            } else {
                (qpc_now_100ns() - live_now) as f64 / 1e7
            };
            let stats = ring.stats();
            debug!(
                frame_idle_secs = idle_secs,
                ring_span_secs = stats.video_span_100ns as f64 / 1e7,
                ring_video_mb = stats.video_bytes / 1_000_000,
                phase = capture_phase::name(phase.load(Ordering::Relaxed)),
                "capture heartbeat"
            );
        }

        let live = liveness.load(Ordering::Relaxed);

        // Wedge recovery: capture thread alive but producing nothing for a
        // long time ⇒ stuck in a GPU call that won't return. Restart the
        // process to bring capture back (last-resort, but the only thing that
        // works — see WEDGE_RESTART_100NS).
        if live != 0 {
            let idle = qpc_now_100ns() - live;
            if idle < STALL_IDLE_100NS {
                seen_healthy = true;
            }
            if seen_healthy && idle > WEDGE_RESTART_100NS {
                let stuck_in = capture_phase::name(phase.load(Ordering::Relaxed));
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
                    }),
                );
                notify_health(
                    &app,
                    &corner,
                    "Clipdip — capture froze",
                    "Screen capture stopped responding. Restarting Clipdip to recover…",
                );
                // Let the toast surface before the process exits.
                std::thread::sleep(Duration::from_millis(1200));
                app.restart();
            }
        }
        let issue: Option<(String, String)> = if live == 0 {
            // No frame produced yet. Normal for the first seconds after
            // start — but persisting means capture never came up at all,
            // which used to be a silent-forever state (no liveness ⇒ no
            // wedge check, no stall alert, nothing).
            if polls > 15 {
                Some((
                    "Clipdip — capture never started".into(),
                    format!(
                        "No frames have been captured since capture started \
                         ({polls}s ago). Check the monitor / capture settings."
                    ),
                ))
            } else {
                None
            }
        } else {
            let idle = qpc_now_100ns() - live;
            let span = ring.stats().video_span_100ns;
            if idle > STALL_IDLE_100NS {
                Some((
                    "Clipdip — capture stalled".into(),
                    format!(
                        "No frames captured for {:.0}s. Clips saved now won't show \
                         the screen until capture resumes.",
                        idle as f64 / 1e7
                    ),
                ))
            } else if polls as i64 > replay_seconds as i64 + 5 && span < underfull_floor {
                // Only judge "low" once the buffer has had a full window to
                // fill, so normal startup doesn't trip it.
                Some((
                    "Clipdip — replay buffer low".into(),
                    format!(
                        "Buffer holds only {:.0}s of your {}s replay window. A clip \
                         saved now would be short.",
                        span as f64 / 1e7,
                        replay_seconds
                    ),
                ))
            } else {
                None
            }
        };

        match (issue, degraded) {
            (Some((title, body)), false) => {
                bad += 1;
                good = 0;
                if bad >= 2 {
                    degraded = true;
                    warn!("health: degraded — {body}");
                    clipdip_diagnostics::report_capture_failure(
                        "capture_degraded",
                        body.clone(),
                        serde_json::json!({ "title": title }),
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
                    notify_health(
                        &app,
                        &corner,
                        "Clipdip — capture recovered",
                        "Replay capture is healthy again and the buffer is refilling.",
                    );
                }
            }
            // Already alerted and still bad, or healthy and still fine: reset
            // the opposing streak and stay quiet.
            (Some(_), true) => {
                good = 0;
            }
            (None, false) => {
                bad = 0;
            }
        }
    }
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

    // Register hotkeys BEFORE starting the pipeline so they work even if
    // the pipeline fails to initialise (e.g. NVENC unavailable).
    // The listener stays alive until run_capture_loop returns (or until it
    // is replaced by a ReloadHotkeys event), keeping the Raw Input thread
    // running for the entire session.
    let mut listener = spawn_hotkey_listener(&cfg, &ev_tx, &app);

    // ev_tx stays alive for ReloadHotkeys re-registration. Loop shutdown
    // is unaffected: AppState holds a loop_tx clone for the whole process
    // lifetime anyway.

    // Read the values the health monitor needs before `cfg` is moved into the
    // pipeline.
    let mut replay_seconds = cfg.replay_seconds;
    let mut health_alerts = cfg.notifications.enabled && cfg.notifications.health_alerts;
    let mut notif_corner = corner_slug(&cfg.notifications.corner);

    // Timestamps of recent health-initiated pipeline restarts, for the
    // storm guard: a capture that re-dies immediately after every restart
    // must not put the pipeline in a restart loop.
    let mut auto_restarts: Vec<std::time::Instant> = Vec::new();

    // Start the pipeline after hotkeys are live. On failure we emit the error
    // and keep the event loop running so hotkeys remain registered.
    let mut monitor: Option<HealthMonitor> = None;
    let mut pipeline = match clipdip_core::Pipeline::start(cfg) {
        Ok(p) => {
            info!("pipeline started");
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
            None
        }
    };

    for event in &ev_rx {
        match event {
            LoopEvent::Save | LoopEvent::ToggleRecording => {
                let Some(ref pipeline) = pipeline else {
                    warn!("save/record hotkey fired but pipeline is not running");
                    continue;
                };

                // ToggleRecording is two actions on one key: the first
                // press arms a manual recording (handled right here), the
                // second press falls through into the shared save flow
                // below with kind = Recording.
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
                                // Recordings are silent by design — only the
                                // overlay notice + the red dot.
                                if cur.notifications.enabled {
                                    let corner = corner_slug(&cur.notifications.corner);
                                    let notice = NoticePayload {
                                        message: "Recording started".into(),
                                        corner: corner.clone(),
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
                            Err(e) => warn!("start recording: {e:#}"),
                        }
                        continue;
                    }
                    LoopEvent::ToggleRecording => SaveKind::Recording,
                    _ => SaveKind::Clip,
                };

                // Anchor for all stage timings. Logged as `t+Nms` so backend
                // and frontend lines can be lined up against the same zero.
                let t0 = std::time::Instant::now();
                let prof = clipdip_profile::enabled();
                if prof { info!("save flow start [t+0ms]"); }

                // Snapshot foreground HWND+PID up-front so the metadata
                // reflects what was on screen at the hotkey moment, not
                // whatever app has stolen focus by the time the mux ends
                // (~1–2 s later). Cheap call — pure GetForegroundWindow +
                // GetWindowThreadProcessId.
                let foreground = metadata::ForegroundSnapshot::capture();

                // Snapshot the Discord call roster at the hotkey moment too.
                // The background manager keeps it warm (polled ~every 2s), so
                // this is just a lock — it reflects who was in the call when
                // the user pressed the key, not whoever's there after the mux.
                let discord_roster = app
                    .try_state::<AppState>()
                    .and_then(|s| s.discord.roster());

                // Re-read config so notification settings reflect any changes
                // since the pipeline started.
                let cur = clipdip_core::config::Config::load_or_default(&config_path)
                    .unwrap_or_default();
                let notifs_enabled = cur.notifications.enabled;

                // Recording stop: drop the red dot immediately — the save
                // flow's own toasts take over from here.
                if save_kind == SaveKind::Recording {
                    if let Some(state) = app.try_state::<AppState>() {
                        *state.recording_active.lock().unwrap() = false;
                    }
                    if let Some(overlay) = app.get_webview_window("overlay") {
                        let _ = overlay
                            .emit("recording-state", serde_json::json!({"recording": false}));
                    }
                }

                // The save chirp is no longer fired here — the overlay
                // invokes `play_saved_sound` at the exact moment its
                // "saved" payoff animation starts, so audio and visuals
                // land together even when WebView2 cold start outruns the
                // mux. The chirp can't leak into the clip because it only
                // plays after the save completes, well after the ring
                // snapshot was taken. Recordings stay silent (the overlay
                // only chirps for kind == "clip").
                if prof { info!("config reloaded [t+{}ms]", t0.elapsed().as_millis()); }

                // Pre-compute the static phase-1 fields so the scope block
                // below can just consume them.
                let rename_hint = format!("Press {} to rename", cur.hotkey.rename_clip);
                let corner = corner_slug(&cur.notifications.corner);

                // Run the desktop screenshot and the clip mux in parallel.
                // Both start at t=0; whichever lags doesn't extend the other.
                // `thread::scope` lets these threads borrow `pipeline`
                // without requiring 'static.
                // Phase 1: emit immediately so the overlay paints within a
                // few ms of the hotkey, BEFORE either work thread runs. The
                // thumbnail field stays null here — the overlay shows a
                // placeholder where it'll appear, and a separate
                // `clip-thumbnail` event slots it in once gdigrab finishes
                // (which can take a couple seconds the first time).
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
                    // Stash the payload BEFORE creating the window — the
                    // overlay reads it via `overlay_get_pending` on mount
                    // because the `clip-saving` event below races with React
                    // attaching its listener. Also clear any stale saved
                    // payload from a previous flow so the new overlay
                    // doesn't accidentally hydrate to the old "Clip saved"
                    // state before phase 2 of THIS flow lands.
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

                std::thread::scope(|s| {
                    // Thumbnail thread: emits `clip-thumbnail` itself so it
                    // doesn't serialize with anything else. The handle is
                    // discarded — we don't await its completion before
                    // returning from the scope (well, scope still joins it,
                    // but we don't gate the save flow on its result).
                    let _thumb_thread = if notifs_enabled {
                        let app = &app;
                        Some(s.spawn(move || {
                            let t_start = t0.elapsed().as_millis();
                            let r = capture_desktop_thumbnail();
                            if prof {
                                let t_end = t0.elapsed().as_millis();
                                info!(
                                    "thumbnail [t+{}ms .. t+{}ms = {}ms]",
                                    t_start, t_end, t_end - t_start
                                );
                            }
                            if let Some(thumbnail) = r {
                                if let Some(overlay) = app.get_webview_window("overlay") {
                                    let _ = overlay.emit(
                                        "clip-thumbnail",
                                        ClipThumbnailPayload { thumbnail },
                                    );
                                }
                                if prof {
                                    info!("emit clip-thumbnail [t+{}ms]", t0.elapsed().as_millis());
                                }
                            }
                        }))
                    } else {
                        None
                    };

                    let save_dir = cur.output.directory.clone();
                    let stem_template = cur.output.filename_stem.clone();
                    let save_thread = s.spawn(move || {
                        let t_start = t0.elapsed().as_millis();
                        // Resolve the focused app's name for the filename
                        // template. The window title costs up to ~400 ms
                        // against a hung window, so only fetch it when the
                        // template actually uses it.
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

                    // Metadata resolution (window title, exe lookup,
                    // icon extraction) in parallel with the mux. The
                    // two 200 ms SendMessageTimeoutW calls + GDI icon
                    // walk would otherwise add ~half a second to the
                    // observed save time if we ran them serially after
                    // save_clip returned.
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

                    // Phase 2: wait for the mux, then emit clip-saved with
                    // the title + path. The overlay swaps the spinner for
                    // the pip and reveals the rename input.
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

                            // `.gameinfo` finalize. The heavy game-info
                            // work (title + icon) already ran in parallel
                            // with the mux above; the Discord roster was
                            // snapshotted at the hotkey moment. This step
                            // just writes the JSON keyed by the now-known
                            // clip path. Game info and the call roster are
                            // independent — either alone still writes a
                            // sidecar. Best-effort; failures only log.
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
                                let payload = ClipSavedPayload {
                                    path: path_str,
                                    title,
                                    kind: save_kind.as_str().into(),
                                };
                                // Stash for late-mounting overlay too —
                                // WebView2 cold start often outruns the
                                // mux, so an overlay that comes up after
                                // clip-saved fires would otherwise be
                                // stuck on the spinner forever.
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
                    // No clip on screen — the rename hotkey doubles as
                    // "update now" while the update toast is showing.
                    use std::sync::atomic::Ordering;
                    let no_save_toast = state.pending_saving.lock().unwrap().is_none()
                        && state.pending_saved.lock().unwrap().is_none();
                    if no_save_toast && state.update_toast_active.load(Ordering::SeqCst) {
                        start_silent_update(app.clone());
                    }
                }
            }
            LoopEvent::UpdateEscape => {
                if let Some(state) = app.try_state::<AppState>() {
                    use std::sync::atomic::Ordering;
                    // Never dismissible mid-install — the toast is the only
                    // sign the app is about to restart itself.
                    if !state.update_installing.load(Ordering::SeqCst)
                        && state.update_toast_active.swap(false, Ordering::SeqCst)
                    {
                        if let Some(overlay) = app.get_webview_window("overlay") {
                            let _ = overlay.emit("update-dismiss", ());
                        }
                    }
                }
            }
            LoopEvent::Restart | LoopEvent::RestartAfterFailure => {
                if matches!(event, LoopEvent::RestartAfterFailure) {
                    // Storm guard: three failure-restarts inside 10 minutes
                    // means capture is persistently broken — stop cycling,
                    // tell the user, and wait for a manual restart (or a
                    // settings change, which sends a plain Restart).
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
                            "Clipdip — capture keeps failing",
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
                // Drop the old monitor first (stops + joins its thread) so it
                // can't fire on the torn-down pipeline.
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
                // Drop the old Raw Input window before registering the new
                // one — only one raw-input registration exists per process.
                drop(listener.take());
                listener = spawn_hotkey_listener(&cfg, &ev_tx, &app);
            }
        }
    }
    // Stop the health monitor (and its thread) before tearing down hotkeys.
    drop(monitor.take());
    drop(listener);
}

/// Grab a single frame from the primary desktop via ffmpeg's `gdigrab` and
/// return a small, low-quality JPEG encoded as a `data:` URL. Runs in
/// parallel with `save_clip()` so the latency is hidden, and the captured
/// frame reflects the screen at the moment of the hotkey rather than after
/// the mux finishes.
fn capture_desktop_thumbnail() -> Option<String> {
    use std::os::windows::process::CommandExt;
    let mut child = Command::new("ffmpeg")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .args([
            "-loglevel", "error",
            "-f", "gdigrab",
            "-framerate", "1",
            "-i", "desktop",
            "-frames:v", "1",
            // ~240px wide preserving aspect ratio, even height (yuv420 friendly).
            "-vf", "scale=240:-2",
            // High q value = low quality / small file (MJPEG q range 2..31).
            "-q:v", "18",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut bytes = Vec::new();
    child.stdout.as_mut()?.read_to_end(&mut bytes).ok()?;
    let _ = child.wait();

    if bytes.is_empty() {
        return None;
    }

    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

// ---------- helpers -------------------------------------------------------

// Legacy: the built-in React settings window. Retired — configuration lives
// in ClipLib's Settings → Clipdip page and index.html is no longer built or
// embedded. Kept for reference.
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

/// Open the ClipLib library app directly on its Clipdip settings page via
/// the `cliplib://` protocol. Windows starts (or focuses) the library.
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
    // ShellExecuteW returns a value > 32 on success. No fallback UI — the
    // binary ships inside ClipLib, so an unregistered protocol means the
    // library was removed out from under us; nothing sensible to open.
    if result.0 as usize <= 32 {
        warn!(
            "cliplib:// protocol not available (ShellExecuteW={}) — is ClipLib installed?",
            result.0 as usize
        );
    }
}

// ---------- stateless CLI queries ------------------------------------------

/// Enumerate physical displays via Win32 so `--list-monitors` works without
/// a Tauri app handle. EnumDisplayMonitors returns monitors in the same
/// order winit (and thus Tauri's `available_monitors`) reports them, so the
/// index lines up with `video.output_index`.
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

/// Handle the stateless query flags ClipLib's settings UI shells out for.
/// Runs before any tauri / single-instance init, so these work whether or
/// not another clipdip instance is running and never forward argv to it.
/// A matched flag prints exactly one JSON line to stdout and exits the
/// process (0 on success, 1 on failure); otherwise returns normally.
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

// ---------- control server --------------------------------------------------

/// `control.json` lives next to `config.toml` and tells ClipLib where the
/// control server listens plus the token that authorizes requests.
fn control_file_path() -> Option<PathBuf> {
    let cfg = clipdip_core::config::Config::path().ok()?;
    cfg.parent().map(|p| p.join("control.json"))
}

/// Start the TCP JSON-lines control server (127.0.0.1, ephemeral port) the
/// ClipLib settings UI talks to. One request line per connection, one
/// response line back, then the connection closes. Failure to start is
/// logged and non-fatal — the app keeps working without the control surface.
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

/// The control command set — thin adapters over the same functions the
/// Tauri commands use, so behavior stays identical between the legacy
/// settings window and ClipLib.
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
        other => Err(format!("unknown command '{other}'")),
    }
}

// ---------- main ----------------------------------------------------------

fn main() {
    // Stateless query flags exit here, before logging (stdout must stay
    // pure JSON), single-instance forwarding, and tauri init.
    handle_cli_query_flags();
    use tracing_subscriber::prelude::*;

    // Held for the whole process: dropping this guard flushes and stops the
    // non-blocking log writer's background thread.
    let mut _log_guard: Option<tracing_appender::non_blocking::WorkerGuard> = None;
    let mut file_layer = None;
    // Setter the diagnostics client uses to raise the file-log level when the
    // server flips a per-install override (debug/trace). `None` restores the
    // default. Populated only when the file log is actually created.
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
                // Non-blocking writer: capture/audio/hotkey threads hand a
                // formatted line to a bounded queue drained by one dedicated
                // background thread, instead of each doing a synchronous
                // write() under a shared mutex. This is critical for capture
                // reliability — with the old blocking writer, a disk hitch
                // (anti-cheat/AV scanning the growing log, an NTFS flush, disk
                // contention mid-game) would stall *every* capture thread
                // mid-log, freezing frame production and collapsing the replay
                // buffer to ~1s. DEBUG (not TRACE) also keeps the per-frame
                // encoder traces and per-buffer audio spam off the disk.
                let (non_blocking, guard) = tracing_appender::non_blocking(file);
                _log_guard = Some(guard);

                // Wrap the level filter in a reload handle so the diagnostics
                // client can bump this install to TRACE on the server's request
                // and drop it back to DEBUG when the override expires.
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

    // Flip on the global profiler if the user opted in. Controls both the
    // periodic pipeline-stage reporter and the per-save flow timing logs
    // below.
    if matches!(
        std::env::var("CLIPDIP_PROFILE").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    ) {
        clipdip_profile::enable();
        info!("profiling enabled (CLIPDIP_PROFILE)");
    }

    // Pin the process-wide MTA for the whole process lifetime. The windows
    // crate caches WinRT activation factories (Windows.Graphics.Capture)
    // process-globally, but the implicit MTA they're created in is owned by
    // whichever thread called RoInitialize first — the video capture thread.
    // When that thread exits on a pipeline restart, the MTA is torn down and
    // the cached factory pointers dangle: the next WGC call (IsSupported, in
    // the restarted thread) is a deterministic access violation. Holding an
    // MTA usage cookie keeps the apartment alive independent of any thread.
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
    // Control + hotkey event channel for the capture loop. Created here so
    // commands (restart_pipeline) can send into it via AppState.
    let (loop_tx, loop_rx) = unbounded::<LoopEvent>();

    // Start the background Discord RPC manager. It keeps a warm connection
    // to the local Discord client and (once the user authorizes) tracks the
    // current voice-call roster. Tokens live next to the config file.
    // With the feature enabled, an unauthenticated start prompts for
    // authorization on its own (once per run) — no waiting for the user to
    // find the Connect button in ClipLib's settings.
    let discord_enabled = clipdip_core::config::Config::load_or_default(&config_path)
        .map(|c| c.discord.enabled)
        .unwrap_or(true);
    let discord_dir = config_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let discord = Arc::new(clipdip_discord::spawn(discord_dir, discord_enabled));

    // Start the anonymous, opt-out diagnostics client. It reports capture
    // failures / crashes and a heartbeat so problems on machines we don't own
    // surface. Inert unless an ingest key was compiled in (CLIPDIP_INGEST_KEY)
    // and the user hasn't opted out. Wired to the file-log reload handle so the
    // server can raise this install's log level to debug a hard case.
    let telemetry_enabled = clipdip_core::config::Config::load_or_default(&config_path)
        .map(|c| c.telemetry.enabled)
        .unwrap_or(true);
    let diagnostics = clipdip_diagnostics::init(clipdip_diagnostics::InitOptions {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        enabled: telemetry_enabled,
        on_log_level: set_log_level,
        base_url: None,
    });

    // Report panics as `crash` events. The release build aborts on panic, so
    // the reporter appends synchronously to the durable queue and it ships on
    // the next launch.
    {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            clipdip_diagnostics::report_crash(&info.to_string());
            prev(info);
        }));
    }

    tauri::Builder::default()
        // Registered first so a second invocation exits before doing any
        // work. The guard doubles as the external control surface: the clip
        // library runs `clipdip.exe --reload` / `--quit`, and that second
        // instance's argv is forwarded here — into the running process,
        // where the capture loop's channel is reachable.
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
                    // Cheap path: re-register hotkeys without tearing down the
                    // pipeline (a full restart clears the replay buffer).
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
            pending_saving: Arc::new(Mutex::new(None)),
            pending_saved: Arc::new(Mutex::new(None)),
            pending_notice: Arc::new(Mutex::new(None)),
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
            // A control invocation (--quit/--reload) that finds no running
            // instance becomes the primary itself. There is nothing to
            // control — exit before the tray or capture loop start, so a
            // stale "reload" from the library can never boot a second-class
            // capturing instance.
            if std::env::args().any(|a| a == "--quit" || a == "--reload" || a == "--reload-hotkeys") {
                info!("control flag on primary instance argv — nothing running to control, exiting");
                app.handle().exit(0);
                return Ok(());
            }

            // Log configured hotkeys so the user can confirm them in the console.
            let cfg_peek = clipdip_core::config::Config::load_or_default(&config_path)
                .unwrap_or_default();
            info!(
                "hotkeys — save: {}  rename: {}  record: {}",
                cfg_peek.hotkey.save_clip,
                cfg_peek.hotkey.rename_clip,
                cfg_peek.hotkey.toggle_recording
            );

            // Build system tray.
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

            // No webview windows are built at startup — main is opened on
            // demand via the tray, overlay is created per-notification by
            // ensure_overlay_window(). That way WebView2 isn't running
            // while the user is idle.

            // Poll GitHub Releases for updates every 30 seconds.
            spawn_update_checker(app.handle().clone());

            // A silent hotkey update leaves a marker with the target
            // version — if we're now running that version, the update
            // landed: confirm it with a short "Updated to vX" toast.
            if let Some(marker) = updated_marker_path(&config_path) {
                if let Ok(v) = std::fs::read_to_string(&marker) {
                    let _ = std::fs::remove_file(&marker);
                    let v = v.trim().to_string();
                    if v == env!("CARGO_PKG_VERSION") {
                        let app2 = app.handle().clone();
                        std::thread::spawn(move || {
                            // Give WebView2 + the pipeline a beat to settle
                            // so the toast entrance isn't eaten by startup.
                            std::thread::sleep(std::time::Duration::from_secs(3));
                            notify_updated(&app2, &v);
                        });
                    } else {
                        info!(
                            "stale update marker (v{v}, running v{}) — ignored",
                            env!("CARGO_PKG_VERSION")
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

            // Control surface for ClipLib's settings UI (TCP JSON-lines on
            // localhost; port + token published via control.json).
            spawn_control_server(app.handle().clone());

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
        ])
        .build(tauri::generate_context!())
        .expect("error building clipdip")
        .run(|_app, event| {
            // The app is a tray-resident background process. Destroying the
            // overlay window after a notification dismisses (or closing the
            // main settings window) would otherwise drop the last webview
            // and Tauri would exit — keep the process alive for the next
            // save hotkey.
            match &event {
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    info!("run event: ExitRequested (code={code:?})");
                    if code.is_none() {
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::Exit => {
                    info!("run event: Exit");
                    // Best-effort: drop the control file so clients don't
                    // try to reach a dead server.
                    if let Some(p) = control_file_path() {
                        let _ = std::fs::remove_file(p);
                    }
                }
                _ => {}
            }
        });
}
