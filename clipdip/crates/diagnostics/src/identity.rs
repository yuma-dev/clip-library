//! Machine identity for reinstall detection: a random UUIDv4 in
//! `HKCU\Software\Clipdip\telemetry_machine_key`, survives reinstall/config wipe
//! unlike `install_id`. Not derived from hardware (privacy); a full reinstall mints a new one.

const SUBKEY: &str = "Software\\Clipdip";
const VALUE: &str = "telemetry_machine_key";
/// Server clamp for identity fields.
const MAX_LEN: usize = 128;

/// Creates the key on first use. `None` only when both read and write fail;
/// caller must omit the field then, never send empty/placeholder.
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
        // uses the real HKCU subkey, just checks stability
        let a = super::load_or_create_machine_key();
        let b = super::load_or_create_machine_key();
        assert_eq!(a, b);
        if let Some(v) = a {
            assert!(!v.is_empty() && v.len() <= 128);
        }
    }
}
