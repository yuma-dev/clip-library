//! Named shared memory that games publish on purpose for telemetry tools
//! (iRacing, Assetto Corsa, rFactor-family sims, RaceRoom, MumbleLink). Opened
//! read-only by name, copied out, closed again: no handle to the game process.

use windows::core::PCWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_READ,
};

/// Copies the first `len` bytes of the mapping `name` (e.g. `Local\acpmf_physics`).
/// None while the game hasn't created it or it's smaller than asked.
pub fn read(name: &str, len: usize) -> Option<Vec<u8>> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let h = OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(wide.as_ptr())).ok()?;
        let view = MapViewOfFile(h, FILE_MAP_READ, 0, 0, len);
        let out = if view.Value.is_null() {
            None
        } else {
            // SAFETY: the view is at least `len` bytes, MapViewOfFile fails otherwise
            let bytes = std::slice::from_raw_parts(view.Value as *const u8, len).to_vec();
            let _ = UnmapViewOfFile(view);
            Some(bytes)
        };
        let _ = CloseHandle(h);
        out
    }
}

/// Little-endian readers over a copied block; None past the end.
pub fn i32_at(b: &[u8], at: usize) -> Option<i32> {
    Some(i32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

pub fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

pub fn f32_at(b: &[u8], at: usize) -> Option<f32> {
    Some(f32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

pub fn f64_at(b: &[u8], at: usize) -> Option<f64> {
    Some(f64::from_le_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// A fixed-size UTF-16 string field (wchar_t[n]), up to the first NUL.
pub fn utf16_at(b: &[u8], at: usize, chars: usize) -> Option<String> {
    let raw = b.get(at..at + chars * 2)?;
    let units: Vec<u16> = raw
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&u| u != 0)
        .collect();
    Some(String::from_utf16_lossy(&units))
}

/// A fixed-size byte string field (char[n]), up to the first NUL.
pub fn cstr_at(b: &[u8], at: usize, len: usize) -> Option<String> {
    let raw = b.get(at..at + len)?;
    let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
    Some(String::from_utf8_lossy(&raw[..end]).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_readers() {
        let mut b = vec![0u8; 32];
        b[0..4].copy_from_slice(&7i32.to_le_bytes());
        b[4..8].copy_from_slice(&1.5f32.to_le_bytes());
        b[8..10].copy_from_slice(&('A' as u16).to_le_bytes());
        b[10..12].copy_from_slice(&('C' as u16).to_le_bytes());
        b[16..19].copy_from_slice(b"spa");
        assert_eq!(i32_at(&b, 0), Some(7));
        assert_eq!(f32_at(&b, 4), Some(1.5));
        assert_eq!(utf16_at(&b, 8, 4).as_deref(), Some("AC"));
        assert_eq!(cstr_at(&b, 16, 8).as_deref(), Some("spa"));
        assert_eq!(i32_at(&b, 30), None);
        assert!(read("Local\\clipdip-no-such-mapping", 16).is_none());
    }
}
