#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
use tracing::{error, info, warn};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{BOOL, HWND, TRUE};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};

/// Notification window dimensions. Sized just larger than the actual
/// notification card so the rename input + thumbnail + status text can
/// expand without overflow, and so the card's drop shadow has room to
/// render inside the window bounds. NOT fullscreen — that's the entire
/// point: a fullscreen transparent always-on-top window forces DWM to
/// recomposite the whole desktop through it.
const OVERLAY_W: u32 = 480;
const OVERLAY_H: u32 = 140;

fn corner_window_position(monitor_w: u32, monitor_h: u32, corner: &str) -> (i32, i32) {
    let mw = monitor_w as i32;
    let mh = monitor_h as i32;
    let ow = OVERLAY_W as i32;
    let oh = OVERLAY_H as i32;
    match corner {
        "top_left"     => (0,        0),
        "top_right"    => (mw - ow,  0),
        "bottom_left"  => (0,        mh - oh),
        _              => (mw - ow,  mh - oh), // bottom_right default
    }
}

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
}

/// Phase-2 update, emitted once the mux finishes. The overlay merges
/// these fields into the saving state — spinner → teal pip, title +
/// rename input appear — and only now allows the rename hotkey to
/// focus the input.
#[derive(Clone, Serialize)]
struct ClipSavedPayload {
    path: String,
    title: String,
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

/// Create the notification overlay window (small, transparent, positioned
/// at the configured corner) and disable its native window-show animation.
/// Idempotent — if the window already exists, repositions it for the
/// requested corner, shows it, and returns it.
///
/// This is called on every save hotkey rather than at startup so the
/// WebView2 process stays dead while the user isn't actively saving.
fn ensure_overlay_window(app: &AppHandle, corner: &str) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window("overlay") {
        if let Ok(Some(monitor)) = w.current_monitor() {
            let (x, y) = corner_window_position(
                monitor.size().width,
                monitor.size().height,
                corner,
            );
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
        let _ = w.set_ignore_cursor_events(true);
        let _ = w.show();
        return Some(w);
    }
    let monitor = app.primary_monitor().ok().flatten()?;
    let (mw, mh) = (monitor.size().width, monitor.size().height);
    let (x, y) = corner_window_position(mw, mh, corner);
    let url = format!("index.html?overlay=1&corner={}", corner);
    let w = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App(url.into()))
        .inner_size(OVERLAY_W as f64, OVERLAY_H as f64)
        .position(x as f64, y as f64)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
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
    let _ = w.show();
    Some(w)
}

// ---------- tauri commands ------------------------------------------------

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cfg = clipdip_core::config::Config::load_or_default(&state.config_path)
        .map_err(|e| e.to_string())?;
    serde_json::to_value(cfg).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_config(config: serde_json::Value, state: State<'_, AppState>) -> Result<(), String> {
    let cfg: clipdip_core::config::Config =
        serde_json::from_value(config).map_err(|e| e.to_string())?;
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

#[tauri::command]
fn dismiss_notification(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    *state.active_clip.lock().unwrap() = None;
    *state.pending_saving.lock().unwrap() = None;
    if let Some(w) = app.get_webview_window("overlay") {
        // Destroy (not hide) the window so the WebView2 process can exit
        // when the user isn't actively saving. `hide()` keeps the webview
        // alive and counts as a process the user can see in Task Manager.
        let _ = w.destroy();
    }
    Ok(())
}

/// Returns the latest `clip-saving` payload that was stashed before the
/// overlay window mounted. The overlay calls this on mount because Tauri
/// events emitted before any listener is attached are dropped silently —
/// and we now create the overlay window on demand, so the phase-1 emit
/// races with the React mount.
#[tauri::command]
fn overlay_get_pending(state: State<'_, AppState>) -> Option<ClipSavingPayload> {
    state.pending_saving.lock().unwrap().clone()
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

// ---------- capture loop --------------------------------------------------

#[derive(Clone, Copy)]
enum HotkeyEvent {
    Save,
    Rename,
}

fn run_capture_loop(
    app: AppHandle,
    config_path: PathBuf,
    active_clip: Arc<Mutex<Option<String>>>,
    pipeline_running: Arc<Mutex<bool>>,
) {
    let cfg = match clipdip_core::config::Config::load_or_default(&config_path) {
        Ok(c) => c,
        Err(e) => {
            error!("config load: {e:#}");
            let _ = app.emit("pipeline-error", format!("{e:#}"));
            return;
        }
    };

    let save_hk = cfg.hotkey.save_clip.clone();
    let rename_hk = cfg.hotkey.rename_clip.clone();
    info!("hotkeys — save: {}  rename: {}", save_hk, rename_hk);

    // Register hotkeys BEFORE starting the pipeline so they work even if
    // the pipeline fails to initialise (e.g. NVENC unavailable).
    // A single HotkeyListener handles all bindings — RegisterRawInputDevices
    // only supports one registration per device type per process, so splitting
    // them across multiple listeners would silently discard all but the last.
    let (ev_tx, ev_rx) = unbounded::<HotkeyEvent>();

    let mut binding_events: Vec<HotkeyEvent> = Vec::new();
    let mut binding_defs: Vec<clipdip_hotkey::HotkeyBinding> = Vec::new();

    match clipdip_hotkey::HotkeyBinding::parse(&save_hk) {
        Ok(b) => { binding_events.push(HotkeyEvent::Save); binding_defs.push(b); }
        Err(e) => warn!("save hotkey parse failed: {e:#}"),
    }
    match clipdip_hotkey::HotkeyBinding::parse(&rename_hk) {
        Ok(b) => { binding_events.push(HotkeyEvent::Rename); binding_defs.push(b); }
        Err(e) => warn!("rename hotkey parse failed: {e:#}"),
    }

    // _listener stays alive until run_capture_loop returns, keeping the
    // Raw Input thread running for the entire session.
    let _listener = if !binding_defs.is_empty() {
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
                let _ = app.emit("pipeline-error", format!("hotkeys: {e:#}"));
                None
            }
        }
    } else {
        None
    };

    drop(ev_tx);

    // Start the pipeline after hotkeys are live. On failure we emit the error
    // and keep the event loop running so hotkeys remain registered.
    let pipeline = match clipdip_core::Pipeline::start(cfg) {
        Ok(p) => {
            info!("pipeline started");
            *pipeline_running.lock().unwrap() = true;
            let _ = app.emit("pipeline-status", serde_json::json!({"running": true}));
            Some(p)
        }
        Err(e) => {
            error!("pipeline start: {e:#}");
            let _ = app.emit("pipeline-error", format!("{e:#}"));
            None
        }
    };

    for event in &ev_rx {
        match event {
            HotkeyEvent::Save => {
                let Some(ref pipeline) = pipeline else {
                    warn!("save hotkey fired but pipeline is not running");
                    continue;
                };

                // Anchor for all stage timings. Logged as `t+Nms` so backend
                // and frontend lines can be lined up against the same zero.
                // `Instant` is Copy, so we just clone it into each scope-spawned
                // thread rather than going through a closure. Capture is cheap
                // (~tens of ns); skipping the log lines when profiling is off
                // keeps the steady-state info stream uncluttered.
                let t0 = std::time::Instant::now();
                let prof = clipdip_profile::enabled();
                if prof { info!("save flow start [t+0ms]"); }

                // Re-read config so notification settings reflect any changes
                // since the pipeline started.
                let cur = clipdip_core::config::Config::load_or_default(&config_path)
                    .unwrap_or_default();
                let notifs_enabled = cur.notifications.enabled;
                if prof { info!("config reloaded [t+{}ms]", t0.elapsed().as_millis()); }

                // Pre-compute the static phase-1 fields so the scope block
                // below can just consume them.
                let rename_hint = format!("Press {} to rename", cur.hotkey.rename_clip);
                let corner = format!("{:?}", cur.notifications.corner)
                    .chars()
                    .fold(String::new(), |mut acc, c| {
                        if c.is_uppercase() && !acc.is_empty() {
                            acc.push('_');
                        }
                        acc.push(c.to_ascii_lowercase());
                        acc
                    });

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
                    if cur.notifications.sound {
                        play_save_sound();
                    }
                    let saving_payload = ClipSavingPayload {
                        thumbnail: None,
                        rename_hotkey: rename_hint.clone(),
                        auto_dismiss_secs: cur.notifications.auto_dismiss_secs,
                        corner: corner.clone(),
                        sound: cur.notifications.sound,
                        profile: prof,
                    };
                    // Stash the payload BEFORE creating the window — the
                    // overlay reads it via `overlay_get_pending` on mount
                    // because the `clip-saving` event below races with React
                    // attaching its listener.
                    if let Some(state) = app.try_state::<AppState>() {
                        *state.pending_saving.lock().unwrap() = Some(saving_payload.clone());
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

                    let save_thread = s.spawn(move || {
                        let t_start = t0.elapsed().as_millis();
                        let r = pipeline.save_clip();
                        if prof {
                            let t_end = t0.elapsed().as_millis();
                            info!(
                                "save_clip [t+{}ms .. t+{}ms = {}ms]",
                                t_start, t_end, t_end - t_start
                            );
                        }
                        r
                    });

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

                            if notifs_enabled {
                                let payload = ClipSavedPayload {
                                    path: path_str,
                                    title,
                                };
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
                                if let Some(overlay) = app.get_webview_window("overlay") {
                                    let _ = overlay.emit("clip-error", format!("{e:#}"));
                                }
                            }
                        }
                        Err(_) => {
                            if prof {
                                error!("save clip thread panicked [t+{}ms]", t0.elapsed().as_millis());
                            } else {
                                error!("save clip thread panicked");
                            }
                            if notifs_enabled {
                                if let Some(overlay) = app.get_webview_window("overlay") {
                                    let _ = overlay.emit("clip-error", "save thread panicked".to_string());
                                }
                            }
                        }
                    }
                });
            }
            HotkeyEvent::Rename => {
                if active_clip.lock().unwrap().is_some() {
                    if let Some(overlay) = app.get_webview_window("overlay") {
                        let _ = overlay.emit("activate-rename", ());
                        let _ = overlay.set_ignore_cursor_events(false);
                        let _ = overlay.set_focus();
                    }
                }
            }
        }
    }
}

/// Grab a single frame from the primary desktop via ffmpeg's `gdigrab` and
/// return a small, low-quality JPEG encoded as a `data:` URL. Runs in
/// parallel with `save_clip()` so the latency is hidden, and the captured
/// frame reflects the screen at the moment of the hotkey rather than after
/// the mux finishes.
fn capture_desktop_thumbnail() -> Option<String> {
    let mut child = Command::new("ffmpeg")
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

fn open_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if let Ok(w) = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Clipdip")
        .inner_size(980.0, 700.0)
        .min_inner_size(820.0, 580.0)
        .center()
        .decorations(false)
        .resizable(true)
        .visible(true)
        .initialization_script(CONSOLE_SCRIPT)
        .build()
    {
        let _ = w.set_focus();
    }
}

// ---------- main ----------------------------------------------------------

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
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

    let config_path = clipdip_core::config::Config::path()
        .unwrap_or_else(|_| PathBuf::from("config.toml"));

    let active_clip: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let pipeline_running: Arc<Mutex<bool>> = Arc::new(Mutex::new(false));

    tauri::Builder::default()
        .manage(AppState {
            config_path: config_path.clone(),
            active_clip: active_clip.clone(),
            pipeline_running: pipeline_running.clone(),
            pending_saving: Arc::new(Mutex::new(None)),
        })
        .setup(move |app| {
            // Log configured hotkeys so the user can confirm them in the console.
            let cfg_peek = clipdip_core::config::Config::load_or_default(&config_path)
                .unwrap_or_default();
            info!(
                "hotkeys — save: {}  rename: {}",
                cfg_peek.hotkey.save_clip, cfg_peek.hotkey.rename_clip
            );

            // Build system tray.
            let menu = Menu::with_items(app, &[
                &MenuItem::with_id(app, "show", "Open ClipDip", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "quit", "Quit ClipDip", true, None::<&str>)?,
            ])?;

            let tooltip = format!(
                "ClipDip\nSave clip: {}",
                cfg_peek.hotkey.save_clip
            );

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip(tooltip)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => open_main_window(app),
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
                        open_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // No webview windows are built at startup — main is opened on
            // demand via the tray, overlay is created per-notification by
            // ensure_overlay_window(). That way WebView2 isn't running
            // while the user is idle.

            // Start the capture pipeline and hotkey loop in a background thread.
            let handle = app.handle().clone();
            let active = active_clip.clone();
            let running = pipeline_running.clone();
            std::thread::spawn(move || run_capture_loop(handle, config_path, active, running));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            update_config,
            rename_clip,
            set_overlay_input_mode,
            dismiss_notification,
            list_monitors,
            open_clips_folder,
            get_pipeline_running,
            forward_console,
            overlay_get_pending,
        ])
        .run(tauri::generate_context!())
        .expect("error running clipdip");
}
