//! Machine identity for reinstall detection.
//!
//! `machine_key` is a random UUIDv4 persisted in the registry at
//! `HKCU\Software\Clipdip\telemetry_machine_key`, so it survives an app
//! reinstall or config wipe (the server's requirement) while the file-based
//! `install_id` resets. Several install ids pointing at one machine key is
//! precisely the reinstall signal the server looks for.
//!
//! Deliberately NOT derived from the Windows MachineGuid or any hardware
//! serial: a salted hash of a stable hardware id is still pseudonymous
//! personal data, and a random value the user can delete (one registry value)
//! is the honest alternative. Trade-off: a full Windows reinstall mints a new
//! machine, which slightly undercounts. Acceptable.

const SUBKEY: &str = "Software\\Clipdip";
const VALUE: &str = "telemetry_machine_key";
/// Server clamp for identity fields.
const MAX_LEN: usize = 128;

/// Read the persisted machine key, creating it on first use. Returns `None`
/// only when both the read and the write fail — the caller must then omit the
/// field entirely (the server treats the install as its own machine), never
/// send an empty string or placeholder.
pub fn load_or_create_machine_key() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let (key, _disp) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(SUBKEY)
        .ok()?;

    if let Ok(existing) = key.get_value::<String, _>(VALUE) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            let mut s = trimmed.to_string();
            s.truncate(MAX_LEN);
            return Some(s);
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    key.set_value(VALUE, &id).ok()?;
    Some(id)
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trip_is_stable() {
        // Uses the real HKCU subkey; the value is a random UUID either way and
        // the test only asserts stability across two calls.
        let a = super::load_or_create_machine_key();
        let b = super::load_or_create_machine_key();
        assert_eq!(a, b);
        if let Some(v) = a {
            assert!(!v.is_empty() && v.len() <= 128);
        }
    }
}
