//! Disk facts for telemetry, in a shape that never leaks a user path.
//!
//! Events and the heartbeat's machine block need "is the clips drive full?"
//! and "what kind of volume is it?", but a raw path embeds the Windows
//! username and folder names. So the only representations that leave the
//! machine are a free-space number and a coarse volume category.

use std::path::{Component, Path, PathBuf};

/// Free bytes on the volume holding `path` (via `GetDiskFreeSpaceExW` on the
/// deepest existing ancestor, so a not-yet-created output dir still resolves).
pub fn free_disk_bytes(path: &Path) -> Option<u64> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let probe = deepest_existing(path)?;
    let mut free_to_caller = 0u64;
    let wide = HSTRING::from(probe.as_os_str());
    // SAFETY: valid wide string and out pointer; the other out params are optional.
    unsafe { GetDiskFreeSpaceExW(&wide, Some(&mut free_to_caller), None, None) }.ok()?;
    Some(free_to_caller)
}

/// Coarse category of the volume holding `path`. The only path-derived value
/// telemetry ever transmits.
pub fn volume_category(path: &Path) -> &'static str {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;

    // Raw GetDriveTypeW results (winbase.h).
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;

    // UNC paths are network shares regardless of what GetDriveType says.
    if path.as_os_str().to_string_lossy().starts_with(r"\\") {
        return "network";
    }
    let Some(root) = path_root(path) else {
        return "unknown";
    };
    let drive_type = unsafe { GetDriveTypeW(&HSTRING::from(root.as_os_str())) };
    match drive_type {
        DRIVE_FIXED => {
            if Some(root) == system_root() {
                "same_as_system"
            } else {
                "other_fixed"
            }
        }
        DRIVE_REMOVABLE | DRIVE_CDROM | DRIVE_RAMDISK => "removable",
        DRIVE_REMOTE => "network",
        _ => "unknown",
    }
}

/// Free space in whole GB on `path`'s volume, for heartbeat fields.
pub fn free_disk_gb(path: &Path) -> Option<u64> {
    free_disk_bytes(path).map(|b| b / (1 << 30))
}

fn deepest_existing(path: &Path) -> Option<PathBuf> {
    let mut p = path.to_path_buf();
    loop {
        if p.exists() {
            return Some(p);
        }
        if !p.pop() {
            return None;
        }
    }
}

/// `C:\` root of a path, if it has a drive prefix.
fn path_root(path: &Path) -> Option<PathBuf> {
    match path.components().next() {
        Some(Component::Prefix(prefix)) => {
            let mut root = PathBuf::from(prefix.as_os_str());
            root.push("\\");
            Some(root)
        }
        _ => None,
    }
}

/// The Windows system drive root (usually `C:\`).
fn system_root() -> Option<PathBuf> {
    let windir = std::env::var_os("SystemDrive")?;
    let mut root = PathBuf::from(windir);
    root.push("\\");
    Some(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_dir_is_same_as_system() {
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
        assert_eq!(volume_category(Path::new(&windir)), "same_as_system");
    }

    #[test]
    fn unc_is_network() {
        assert_eq!(volume_category(Path::new(r"\\server\share\x")), "network");
    }

    #[test]
    fn free_space_resolves_for_missing_subdir() {
        let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
        let missing = Path::new(&windir).join("definitely-not-a-real-dir-12345");
        assert!(free_disk_bytes(&missing).unwrap_or(0) > 0);
    }
}
