#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use crossbeam_channel::unbounded;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tracing::{error, info, warn};

// ---------- shared state --------------------------------------------------

struct AppState {
    config_path: PathBuf,
    /// Path of the clip whose notification is currently on-screen (if any).
    active_clip: Arc<Mutex<Option<String>>>,
}

// ---------- event payloads ------------------------------------------------

#[derive(Clone, Serialize)]
struct ClipSavedPayload {
    path: String,
    title: String,
    thumbnail: Option<String>,
    rename_hotkey: String,
    auto_dismiss_secs: u32,
    corner: String,
}

#[derive(Clone, Serialize)]
struct ClipRenamedPayload {
    old_path: String,
    new_path: String,
    new_title: String,
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
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.set_ignore_cursor_events(true);
        let _ = w.hide();
    }
    Ok(())
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

enum HotkeyEvent {
    Save,
    Rename,
}

fn run_capture_loop(
    app: AppHandle,
    config_path: PathBuf,
    active_clip: Arc<Mutex<Option<String>>>,
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
    let rename_hint = format!("Press {} to rename", rename_hk);
    let auto_dismiss = cfg.notifications.auto_dismiss_secs;
    let corner = format!("{:?}", cfg.notifications.corner)
        .chars()
        .fold(String::new(), |mut acc, c| {
            if c.is_uppercase() && !acc.is_empty() {
                acc.push('_');
            }
            acc.push(c.to_ascii_lowercase());
            acc
        });
    let notifs_enabled = cfg.notifications.enabled;

    let pipeline = match clipdip_core::Pipeline::start(cfg) {
        Ok(p) => p,
        Err(e) => {
            error!("pipeline start: {e:#}");
            let _ = app.emit("pipeline-error", format!("{e:#}"));
            return;
        }
    };
    info!("pipeline started");
    let _ = app.emit("pipeline-status", serde_json::json!({"running": true}));

    // Aggregate both hotkeys into one channel so we can handle them in one loop.
    let (ev_tx, ev_rx) = unbounded::<HotkeyEvent>();

    if let Ok(binding) = clipdip_hotkey::HotkeyBinding::parse(&save_hk) {
        match clipdip_hotkey::HotkeyListener::spawn(binding) {
            Ok((listener, rx)) => {
                let tx = ev_tx.clone();
                std::thread::spawn(move || {
                    let _l = listener;
                    while rx.recv().is_ok() {
                        if tx.send(HotkeyEvent::Save).is_err() {
                            break;
                        }
                    }
                });
            }
            Err(e) => {
                warn!("save hotkey: {e:#}");
                let _ = app.emit("pipeline-error", format!("save hotkey: {e:#}"));
            }
        }
    }

    if let Ok(binding) = clipdip_hotkey::HotkeyBinding::parse(&rename_hk) {
        match clipdip_hotkey::HotkeyListener::spawn(binding) {
            Ok((listener, rx)) => {
                let tx = ev_tx.clone();
                std::thread::spawn(move || {
                    let _l = listener;
                    while rx.recv().is_ok() {
                        if tx.send(HotkeyEvent::Rename).is_err() {
                            break;
                        }
                    }
                });
            }
            Err(e) => warn!("rename hotkey: {e:#} — rename via hotkey disabled"),
        }
    }

    drop(ev_tx);

    for event in &ev_rx {
        match event {
            HotkeyEvent::Save => {
                match pipeline.save_clip() {
                    Ok(path) => {
                        let title = path
                            .file_stem()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        let path_str = path.to_string_lossy().to_string();
                        *active_clip.lock().unwrap() = Some(path_str.clone());

                        let thumbnail = if notifs_enabled {
                            extract_thumbnail(&path)
                        } else {
                            None
                        };

                        if notifs_enabled {
                            if let Some(overlay) = app.get_webview_window("overlay") {
                                let _ = overlay.show();
                                let _ = overlay.set_ignore_cursor_events(true);
                            }
                            let _ = app.emit(
                                "clip-saved",
                                ClipSavedPayload {
                                    path: path_str,
                                    title,
                                    thumbnail,
                                    rename_hotkey: rename_hint.clone(),
                                    auto_dismiss_secs: auto_dismiss,
                                    corner: corner.clone(),
                                },
                            );
                        }
                    }
                    Err(e) => error!("save clip: {e:#}"),
                }
            }
            HotkeyEvent::Rename => {
                if active_clip.lock().unwrap().is_some() {
                    let _ = app.emit("activate-rename", ());
                    if let Some(overlay) = app.get_webview_window("overlay") {
                        let _ = overlay.set_ignore_cursor_events(false);
                        let _ = overlay.set_focus();
                    }
                }
            }
        }
    }
}

fn extract_thumbnail(path: &PathBuf) -> Option<String> {
    let path_str = path.to_str()?;
    let mut child = Command::new("ffmpeg")
        .args([
            "-ss",
            "1",
            "-i",
            path_str,
            "-vframes",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-vf",
            "scale=320:-1",
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

// ---------- main ----------------------------------------------------------

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config_path = clipdip_core::config::Config::path()
        .unwrap_or_else(|_| PathBuf::from("config.toml"));

    let active_clip: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .manage(AppState {
            config_path: config_path.clone(),
            active_clip: active_clip.clone(),
        })
        .setup(move |app| {
            // Size the overlay to cover the primary monitor.
            let (ow, oh) = app
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| (m.size().width, m.size().height))
                .unwrap_or((1920, 1080));

            WebviewWindowBuilder::new(
                app,
                "overlay",
                WebviewUrl::App("index.html?overlay=1".into()),
            )
            .inner_size(ow as f64, oh as f64)
            .position(0.0, 0.0)
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .resizable(false)
            .build()?;

            // Start the capture pipeline and hotkey loop in a background thread.
            let handle = app.handle().clone();
            let active = active_clip.clone();
            std::thread::spawn(move || run_capture_loop(handle, config_path, active));

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
        ])
        .run(tauri::generate_context!())
        .expect("error running clipdip");
}
