pub mod art;
pub mod gsi;
pub mod http;
pub mod process;
pub mod riot;
pub mod shm;
pub mod tail;
pub mod window;

/// unix ms
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Exe file name, lowercase, for `matches`.
pub fn exe_name(t: &crate::Target) -> String {
    t.exe
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|f| f.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Discord wants details/state 2..=128 chars and rejects the whole activity
/// otherwise.
pub fn clamp(s: impl Into<String>) -> Option<String> {
    let s: String = s.into();
    let s = s.trim();
    match s.chars().count() {
        0..=1 => None,
        2..=128 => Some(s.to_string()),
        _ => Some(format!("{}...", s.chars().take(125).collect::<String>())),
    }
}
