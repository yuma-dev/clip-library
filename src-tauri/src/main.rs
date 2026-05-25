//! Clipdip — CLI front-end.
//!
//! Long-running clipper:
//!   1. Loads config from `%APPDATA%\clipdip\config.toml` (creates defaults
//!      on first run).
//!   2. Hands the config to `clipdip_core::Pipeline`, which spawns the
//!      capture threads (video via DXGI+NVENC, one WASAPI thread per
//!      `audio.sources` entry) and pushes packets into a shared GOP-aware
//!      ring.
//!   3. Spawns a `RegisterHotKey` listener bound to `hotkey.save_clip`.
//!   4. Loops on hotkey + Ctrl+C events. Hotkey → `pipeline.save_clip()`;
//!      Ctrl+C → `pipeline.stop()` and exit.
//!
//! Default hotkey: `Ctrl+Alt+F10`. Default replay window: 60 s. Edit
//! `config.toml` to change either. The Tauri UI (when it lands) will
//! call into the same `Pipeline` API.

use anyhow::{anyhow, Context, Result};
use clipdip_audio::{list_devices, AudioDeviceInfo, DeviceFlow};
use clipdip_capture::list_outputs;
use clipdip_core::config::{AudioSource, Config};
use clipdip_core::Pipeline;
use clipdip_hotkey::{HotkeyBinding, HotkeyListener};
use clipdip_muxer::resolve_ffmpeg_path;
use crossbeam_channel::{select, unbounded};
use tracing::{error, info, warn};

fn main() -> Result<()> {
    // ---- bare-bones CLI flag handling (no clap dep for two flags) -----
    let mut args: Vec<String> = std::env::args().skip(1).collect();

    // `--profile` may appear anywhere; consume it before the subcommand
    // dispatch so commands don't have to know about it. Env var
    // `CLIPDIP_PROFILE=1` does the same.
    let want_profile = std::env::var("CLIPDIP_PROFILE")
        .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes"))
        .unwrap_or(false)
        || {
            let before = args.len();
            args.retain(|a| a != "--profile");
            args.len() != before
        };
    if want_profile {
        clipdip_profile::enable();
    }

    match args.first().map(String::as_str) {
        Some("--help" | "-h") => {
            print_usage();
            return Ok(());
        }
        Some("--print-config-path") => {
            println!("{}", Config::path()?.display());
            return Ok(());
        }
        Some("--list-outputs") => {
            return cmd_list_outputs();
        }
        Some("--list-audio-devices") => {
            return cmd_list_audio_devices();
        }
        Some("--configure-audio") => {
            return cmd_configure_audio();
        }
        Some("--show-config") => {
            return cmd_show_config();
        }
        Some("--edit-config") => {
            return cmd_edit_config();
        }
        Some("--reset-config") => {
            return cmd_reset_config();
        }
        Some("--smoke") => {
            // `--smoke [N]`: record for N seconds (default 60), auto-save
            // to a fixed-name file (overwrites every run), print ffprobe
            // + final profile report, exit. Profile is force-enabled.
            let seconds = args
                .get(1)
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(60);
            return cmd_smoke(seconds);
        }
        Some(other) => {
            eprintln!("unknown flag: {other}");
            print_usage();
            std::process::exit(2);
        }
        None => {} // fall through to normal launch
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,clipdip=debug")),
        )
        .init();

    // ---- config -------------------------------------------------------
    let config_path = Config::path().context("resolve config path")?;
    let cfg = Config::load_or_default(&config_path)
        .with_context(|| format!("load config from {}", config_path.display()))?;
    info!(path = %config_path.display(), "config loaded");

    std::fs::create_dir_all(&cfg.output.directory)
        .with_context(|| format!("create output dir {}", cfg.output.directory.display()))?;

    // Preflight ffmpeg so users see a friendly error at launch instead of
    // a cryptic one at first save.
    let ffmpeg_bin = resolve_ffmpeg_path(cfg.output.ffmpeg_path.as_deref());
    match preflight_ffmpeg(&ffmpeg_bin) {
        Ok(()) => info!(ffmpeg = %ffmpeg_bin.display(), "ffmpeg ok"),
        Err(e) => warn!(
            "ffmpeg preflight failed: {e:#}\n\
             Saves will not work until ffmpeg is on PATH (try `choco install ffmpeg`) \
             or you set `output.ffmpeg_path` in {}.",
            config_path.display()
        ),
    }

    let hotkey_label = cfg.hotkey.save_clip.clone();
    let replay_seconds = cfg.replay_seconds;
    let output_dir = cfg.output.directory.clone();

    // ---- start the capture pipeline (ring + audio + video) -----------
    let pipeline = Pipeline::start(cfg).context("start capture pipeline")?;

    // ---- hotkey listener ---------------------------------------------
    let binding = HotkeyBinding::parse(&hotkey_label)
        .with_context(|| format!("parse hotkey '{hotkey_label}'"))?;
    let (_hk_listener, hk_rx) = HotkeyListener::spawn(binding).with_context(|| {
        format!(
            "register save-clip hotkey '{hotkey_label}' — if this says 'already registered', \
             another app owns that shortcut system-wide. Change `[hotkey] save_clip` in {} to \
             something free (e.g. 'Ctrl+Alt+F10' or 'Win+Alt+S') and try again.",
            config_path.display()
        )
    })?;

    // ---- Ctrl+C handler ----------------------------------------------
    let (ctrlc_tx, ctrlc_rx) = unbounded::<()>();
    ctrlc::set_handler(move || {
        let _ = ctrlc_tx.send(());
    })
    .context("install Ctrl+C handler")?;

    info!(
        hotkey = %hotkey_label,
        replay_seconds,
        output_dir = %output_dir.display(),
        "recording — press hotkey to save, Ctrl+C to exit"
    );

    // ---- main event loop ---------------------------------------------
    loop {
        select! {
            recv(hk_rx) -> _ => {
                if let Err(e) = pipeline.save_clip() {
                    error!("save failed: {e:#}");
                }
            }
            recv(ctrlc_rx) -> _ => {
                info!("Ctrl+C received, shutting down");
                break;
            }
        }
    }

    pipeline.stop().context("stop pipeline")?;
    info!("clean exit");
    Ok(())
}

fn print_usage() {
    println!(
        "clipdip — long-running screen+audio recorder with hotkey-triggered MP4 saves\n\
         \n\
         USAGE:\n  \
           clipdip                        run the recorder (default)\n  \
           clipdip --show-config          print the current config (loaded or defaults)\n  \
           clipdip --edit-config          open the config file in your editor\n  \
           clipdip --reset-config         delete the config so next launch writes defaults\n  \
           clipdip --print-config-path    print the config file path and exit\n  \
           clipdip --list-outputs         list DXGI outputs (monitors) with indices\n  \
           clipdip --list-audio-devices   list WASAPI audio endpoints with IDs\n  \
           clipdip --configure-audio      interactive: pick how many + which audio sources\n  \
           clipdip --smoke [SEC]          end-to-end smoke: record SEC sec (default 60),\n  \
           \x20                              save to clipdip-smoke-latest.mp4, print ffprobe + profile\n  \
           clipdip --help                 show this help\n  \
         \n  \
         OPTIONS:\n  \
           --profile                      enable per-stage timing report (also CLIPDIP_PROFILE=1)"
    );
}

/// Group enumerated devices by flow, with a stable `[r0]`/`[c0]` index per
/// side so users can refer to them in the interactive configurator.
fn group_audio_devices(devs: &[AudioDeviceInfo]) -> (Vec<&AudioDeviceInfo>, Vec<&AudioDeviceInfo>) {
    let render: Vec<&AudioDeviceInfo> = devs.iter().filter(|d| d.flow == DeviceFlow::Render).collect();
    let capture: Vec<&AudioDeviceInfo> = devs.iter().filter(|d| d.flow == DeviceFlow::Capture).collect();
    (render, capture)
}

fn print_audio_devices(render: &[&AudioDeviceInfo], capture: &[&AudioDeviceInfo]) {
    println!("Render (system audio / loopback):");
    if render.is_empty() {
        println!("  (none)");
    }
    for (i, d) in render.iter().enumerate() {
        let star = if d.is_default { "  (default)" } else { "" };
        println!("  [r{i}] {}{star}", d.friendly_name);
    }
    println!();
    println!("Capture (microphones / line-in):");
    if capture.is_empty() {
        println!("  (none)");
    }
    for (i, d) in capture.iter().enumerate() {
        let star = if d.is_default { "  (default)" } else { "" };
        println!("  [c{i}] {}{star}", d.friendly_name);
    }
}

fn cmd_list_audio_devices() -> Result<()> {
    let devs = list_devices().context("enumerate WASAPI devices")?;
    let (render, capture) = group_audio_devices(&devs);
    print_audio_devices(&render, &capture);
    println!();
    println!("Stable IDs (paste into config.toml `device_id` field):");
    for d in &devs {
        println!(
            "  {:?}  {}  id={}",
            d.flow,
            d.friendly_name,
            d.id
        );
    }
    Ok(())
}

/// Read one line from stdin, trimmed. Returns None on EOF.
fn read_line(prompt: &str) -> Result<Option<String>> {
    use std::io::Write;
    print!("{prompt}");
    std::io::stdout().flush().ok();
    let mut buf = String::new();
    let n = std::io::stdin()
        .read_line(&mut buf)
        .context("read stdin")?;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(buf.trim().to_string()))
}

/// Interactive: list devices, ask how many sources, ask which device for
/// each. Writes the result into the user's config file. Doesn't touch
/// any other config field.
fn cmd_configure_audio() -> Result<()> {
    let devs = list_devices().context("enumerate WASAPI devices")?;
    let (render, capture) = group_audio_devices(&devs);
    print_audio_devices(&render, &capture);
    println!();
    println!("Tokens you can use when picking a source:");
    println!("  default-loopback     system audio (whatever Windows considers default)");
    println!("  default-mic          microphone (whatever Windows considers default)");
    println!("  r0, r1, ...          a specific render device (loopback)");
    println!("  c0, c1, ...          a specific capture device (microphone)");
    println!("  skip                 skip this source slot");
    println!();

    // How many?
    let path = Config::path()?;
    let mut cfg = Config::load_or_default(&path)
        .with_context(|| format!("load config from {}", path.display()))?;
    let default_count = cfg.audio.sources.len();

    let count = loop {
        let ans = match read_line(&format!(
            "How many audio sources do you want? [default {default_count}]: "
        ))? {
            Some(s) => s,
            None => return Ok(()),
        };
        if ans.is_empty() {
            break default_count;
        }
        match ans.parse::<usize>() {
            Ok(n) if n <= 16 => break n,
            _ => println!("  please enter a number 0..=16"),
        }
    };

    let mut new_sources: Vec<AudioSource> = Vec::new();
    for i in 0..count {
        let pick = loop {
            let ans = match read_line(&format!("Source {} pick: ", i + 1))? {
                Some(s) => s,
                None => return Ok(()),
            };
            let lower = ans.to_ascii_lowercase();
            if lower == "skip" || lower.is_empty() {
                break None;
            }
            if lower == "default-loopback" {
                break Some(AudioSource::SystemLoopback { device_id: None });
            }
            if lower == "default-mic" {
                break Some(AudioSource::Microphone { device_id: None });
            }
            if let Some(rest) = lower.strip_prefix('r') {
                if let Ok(n) = rest.parse::<usize>() {
                    if let Some(d) = render.get(n) {
                        println!("  → {}", d.friendly_name);
                        break Some(AudioSource::SystemLoopback {
                            device_id: Some(d.id.clone()),
                        });
                    }
                }
            }
            if let Some(rest) = lower.strip_prefix('c') {
                if let Ok(n) = rest.parse::<usize>() {
                    if let Some(d) = capture.get(n) {
                        println!("  → {}", d.friendly_name);
                        break Some(AudioSource::Microphone {
                            device_id: Some(d.id.clone()),
                        });
                    }
                }
            }
            println!("  unrecognized — try again (e.g. 'r0', 'c1', 'default-loopback', 'skip')");
        };
        if let Some(s) = pick {
            new_sources.push(s);
        }
    }

    cfg.audio.sources = new_sources;
    cfg.save(&path)
        .with_context(|| format!("save config to {}", path.display()))?;
    println!();
    println!("Wrote {} audio source(s) to {}", cfg.audio.sources.len(), path.display());
    Ok(())
}

fn cmd_show_config() -> Result<()> {
    let path = Config::path()?;
    let cfg = Config::load_or_default(&path)
        .with_context(|| format!("load config from {}", path.display()))?;
    let body = toml::to_string_pretty(&cfg).context("serialize config")?;
    println!("# {}", path.display());
    print!("{body}");
    Ok(())
}

/// Spawn the user's editor on the config file. Uses `$VISUAL` / `$EDITOR`
/// if set, falls back to `notepad` on Windows and `nano` elsewhere. Creates
/// the file with defaults first if it doesn't exist.
fn cmd_edit_config() -> Result<()> {
    let path = Config::path()?;
    if !path.exists() {
        Config::default()
            .save(&path)
            .with_context(|| format!("create {}", path.display()))?;
    }
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .ok();
    let mut cmd = match editor.as_deref() {
        Some(e) if !e.is_empty() => std::process::Command::new(e),
        _ => {
            if cfg!(windows) {
                std::process::Command::new("notepad")
            } else {
                std::process::Command::new("nano")
            }
        }
    };
    let status = cmd
        .arg(&path)
        .status()
        .with_context(|| format!("spawn editor for {}", path.display()))?;
    if !status.success() {
        eprintln!(
            "editor exited with status {:?} — config may be unchanged",
            status.code()
        );
    }
    Ok(())
}

fn cmd_reset_config() -> Result<()> {
    let path = Config::path()?;
    if path.exists() {
        std::fs::remove_file(&path)
            .with_context(|| format!("remove {}", path.display()))?;
        println!("removed {} — next launch writes defaults", path.display());
    } else {
        println!("no config at {} — already reset", path.display());
    }
    Ok(())
}

/// End-to-end smoke run: record for `seconds`, save to a fixed filename
/// (overwriting any previous smoke output so the working directory stays
/// clean across iterations), then print ffprobe stream info + the final
/// profile-window report so a single command exercises the full
/// pipeline and emits everything we want to inspect.
///
/// Profile is force-enabled — the whole point is to read the numbers.
fn cmd_smoke(seconds: u64) -> Result<()> {
    use std::time::{Duration, Instant};

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,clipdip=debug")),
        )
        .init();

    clipdip_profile::enable();

    let config_path = Config::path().context("resolve config path")?;
    let cfg = Config::load_or_default(&config_path)
        .with_context(|| format!("load config from {}", config_path.display()))?;
    std::fs::create_dir_all(&cfg.output.directory)
        .with_context(|| format!("create output dir {}", cfg.output.directory.display()))?;

    let ffmpeg_bin = resolve_ffmpeg_path(cfg.output.ffmpeg_path.as_deref());
    preflight_ffmpeg(&ffmpeg_bin).context("ffmpeg preflight (required for --smoke)")?;

    info!(
        seconds,
        output_dir = %cfg.output.directory.display(),
        "smoke: recording — Ctrl+C aborts"
    );

    let pipeline = Pipeline::start(cfg).context("start capture pipeline")?;

    // Sleep in slices so Ctrl+C can interrupt early without waiting the
    // full window. Ctrl+C handler is best-effort — we still try to save
    // whatever's in the ring before exiting.
    let (ctrlc_tx, ctrlc_rx) = crossbeam_channel::unbounded::<()>();
    ctrlc::set_handler(move || {
        let _ = ctrlc_tx.send(());
    })
    .context("install Ctrl+C handler")?;

    let target = Duration::from_secs(seconds);
    let start = Instant::now();
    while start.elapsed() < target {
        if ctrlc_rx.recv_timeout(Duration::from_millis(200)).is_ok() {
            warn!("smoke: Ctrl+C — saving partial clip");
            break;
        }
    }

    let mp4 = pipeline
        .save_clip_as("clipdip-smoke-latest")
        .context("save smoke clip")?;
    pipeline.stop().context("stop pipeline")?;

    // Final profile window — drain whatever the reporter thread didn't
    // pick up before stop.
    let rep = clipdip_profile::report();
    println!();
    println!("=== profile (smoke window) ===");
    println!("{}", clipdip_profile::format_report(&rep));

    println!();
    println!("=== ffprobe ({}) ===", mp4.display());
    match run_ffprobe(&mp4) {
        Ok(out) => print!("{out}"),
        Err(e) => eprintln!("ffprobe failed: {e:#}"),
    }
    Ok(())
}

/// Spawn `ffprobe` (assumed alongside ffmpeg on PATH) and return its
/// filtered stream info. Only keeps the keys we actually care about so
/// the output stays one screen tall.
fn run_ffprobe(path: &std::path::Path) -> Result<String> {
    use std::process::{Command, Stdio};
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_entries",
            "stream=codec_name,codec_type,width,height,r_frame_rate,bit_rate,channels,sample_rate",
            "-of",
            "default=noprint_wrappers=0",
        ])
        .arg(path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .context("spawn ffprobe")?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!("ffprobe exited {:?}: {err}", out.status.code()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn cmd_list_outputs() -> Result<()> {
    let outputs = list_outputs().context("enumerate DXGI outputs")?;
    if outputs.is_empty() {
        println!("(no DXGI outputs found)");
        return Ok(());
    }
    println!("Available DXGI outputs (use index in `video.output_index`):");
    for o in outputs {
        println!(
            "  [{}] {:>5}x{:<5}  {}",
            o.index, o.width, o.height, o.device_name
        );
    }
    Ok(())
}

/// Run `ffmpeg -version`. If the command can't be spawned or exits non-zero,
/// return an error so the caller can warn the user. Suppresses output.
fn preflight_ffmpeg(ffmpeg: &std::path::Path) -> Result<()> {
    use std::process::{Command, Stdio};
    let status = Command::new(ffmpeg)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .with_context(|| format!("spawn {}", ffmpeg.display()))?;
    if !status.success() {
        return Err(anyhow!(
            "{} -version exited {:?}",
            ffmpeg.display(),
            status.code()
        ));
    }
    Ok(())
}

