//! One-shot hardware profile for the telemetry heartbeat's `machine` block.
//!
//! Collected once at startup (before the diagnostics client spawns) and sent
//! on the first heartbeat of each session; the server retains the last known
//! profile. Every field degrades to omission on failure — a partial profile
//! is fine, a blocked startup is not.
//!
//! Privacy shape: hardware class data only. GPU/CPU model strings, OS build,
//! RAM, display modes, locale. No serial numbers, no MachineGuid, no user
//! paths (the clips volume appears only as free GB + a drive-type category),
//! no monitor EDID names, no timezone.

use clipdip_core::config::Config;
use clipdip_core::diskinfo;
use serde_json::{Map, Value};

pub fn collect(cfg: &Config) -> Value {
    let mut m = Map::new();
    m.insert("os".into(), "windows".into());
    if let Some(v) = os_version() {
        m.insert("os_version".into(), v.into());
    }
    m.insert("arch".into(), std::env::consts::ARCH.into());
    if let Some(cpu) = cpu_model() {
        m.insert("cpu".into(), cpu.into());
    }
    if let Ok(cores) = std::thread::available_parallelism() {
        m.insert("cores".into(), (cores.get() as u64).into());
    }
    m.insert(
        "ram_mb".into(),
        (clipdip_core::config::physical_ram_bytes() / (1 << 20)).into(),
    );
    if let Some(gpu) = primary_gpu() {
        m.insert("gpu_vendor".into(), gpu.vendor.into());
        m.insert("gpu_model".into(), gpu.model.into());
        m.insert("gpu_vram_mb".into(), gpu.vram_mb.into());
        if let Some(driver) = gpu.driver {
            m.insert("gpu_driver".into(), driver.into());
        }
    }
    if let Some(locale) = user_locale() {
        m.insert("locale".into(), locale.into());
    }
    let monitors = crate::enumerate_monitors();
    if !monitors.is_empty() {
        m.insert("monitor_count".into(), (monitors.len() as u64).into());
        m.insert("monitors".into(), monitor_summary(&monitors).into());
    }
    if let Some(gb) = diskinfo::free_disk_gb(&cfg.output.directory) {
        m.insert("disk_free_gb".into(), gb.into());
    }
    m.insert(
        "disk_volume".into(),
        diskinfo::volume_category(&cfg.output.directory).into(),
    );
    Value::Object(m)
}

/// "11 26100" style: marketing major (10 vs 11 by the 22000 build cutoff) plus
/// the build number, which is what actually identifies the OS revision.
fn os_version() -> Option<String> {
    let v = windows_version::OsVersion::current();
    let marketing = if v.build >= 22000 { 11 } else { v.major };
    Some(format!("{} {}", marketing, v.build))
}

fn cpu_model() -> Option<String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey("HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0")
        .ok()?;
    let name: String = key.get_value("ProcessorNameString").ok()?;
    let trimmed = name.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

struct GpuInfo {
    vendor: &'static str,
    model: String,
    vram_mb: u64,
    driver: Option<String>,
}

/// The hardware adapter with the most dedicated VRAM (skipping software
/// renderers like WARP). One-shot DXGI enumeration, independent of the
/// capture pipeline.
fn primary_gpu() -> Option<GpuInfo> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
    let mut best: Option<GpuInfo> = None;
    let mut i = 0u32;
    loop {
        let Ok(adapter) = (unsafe { factory.EnumAdapters1(i) }) else {
            break;
        };
        i += 1;
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else {
            continue;
        };
        // DXGI_ADAPTER_FLAG_SOFTWARE
        if desc.Flags & 0x2 != 0 {
            continue;
        }
        let vram_mb = (desc.DedicatedVideoMemory / (1 << 20)) as u64;
        if best.as_ref().is_some_and(|b| b.vram_mb >= vram_mb) {
            continue;
        }
        let len = desc
            .Description
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(desc.Description.len());
        let model = String::from_utf16_lossy(&desc.Description[..len])
            .trim()
            .to_string();
        let vendor = match desc.VendorId {
            0x10DE => "nvidia",
            0x1002 | 0x1022 => "amd",
            0x8086 => "intel",
            _ => "other",
        };
        // UMD driver version via CheckInterfaceSupport (the canonical trick:
        // it reports the driver version even though 3D interface support
        // itself is a D3D10+ relic).
        use windows::core::Interface;
        let driver = unsafe {
            adapter.CheckInterfaceSupport(&windows::Win32::Graphics::Dxgi::IDXGIDevice::IID)
        }
        .ok()
        .map(|v| {
            let v = v as u64;
            format!(
                "{}.{}.{}.{}",
                (v >> 48) & 0xffff,
                (v >> 32) & 0xffff,
                (v >> 16) & 0xffff,
                v & 0xffff
            )
        });
        best = Some(GpuInfo {
            vendor,
            model,
            vram_mb,
            driver,
        });
    }
    best
}

fn user_locale() -> Option<String> {
    use windows::Win32::Globalization::GetUserDefaultLocaleName;
    let mut buf = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH
    let len = unsafe { GetUserDefaultLocaleName(&mut buf) };
    if len <= 1 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..(len as usize - 1)]))
}

/// "2560x1440*,1920x1080" — resolutions only, primary starred. Uses the same
/// enumeration the `--list-monitors` CLI query exposes.
fn monitor_summary(monitors: &[Value]) -> String {
    monitors
        .iter()
        .map(|m| {
            let w = m.get("width").and_then(Value::as_i64).unwrap_or(0);
            let h = m.get("height").and_then(Value::as_i64).unwrap_or(0);
            let primary = m
                .get("is_primary")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            format!("{w}x{h}{}", if primary { "*" } else { "" })
        })
        .collect::<Vec<_>>()
        .join(",")
}
