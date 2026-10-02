// the reference's currentserver endpoint wraps a read-only lookup in HS256
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::ffi::c_void;

#[link(name = "bcrypt")]
extern "system" {
    fn BCryptOpenAlgorithmProvider(
        handle: *mut *mut c_void,
        id: *const u16,
        implementation: *const u16,
        flags: u32,
    ) -> i32;
    fn BCryptCloseAlgorithmProvider(handle: *mut c_void, flags: u32) -> i32;
    fn BCryptCreateHash(
        algorithm: *mut c_void,
        handle: *mut *mut c_void,
        object: *mut u8,
        object_len: u32,
        secret: *const u8,
        secret_len: u32,
        flags: u32,
    ) -> i32;
    fn BCryptHashData(handle: *mut c_void, data: *const u8, len: u32, flags: u32) -> i32;
    fn BCryptFinishHash(handle: *mut c_void, output: *mut u8, len: u32, flags: u32) -> i32;
    fn BCryptDestroyHash(handle: *mut c_void) -> i32;
}

fn hmac(secret: &[u8], data: &[u8]) -> Option<[u8; 32]> {
    let secret_len = u32::try_from(secret.len()).ok()?;
    let len = u32::try_from(data.len()).ok()?;
    let algorithm: Vec<u16> = "SHA256".encode_utf16().chain(Some(0)).collect();
    let mut provider = std::ptr::null_mut();
    let mut hash = std::ptr::null_mut();
    let mut out = [0; 32];
    // CNG handles are independent of any game process and always released
    unsafe {
        if BCryptOpenAlgorithmProvider(&mut provider, algorithm.as_ptr(), std::ptr::null(), 8) < 0 {
            return None;
        }
        let result = if BCryptCreateHash(
            provider,
            &mut hash,
            std::ptr::null_mut(),
            0,
            secret.as_ptr(),
            secret_len,
            0,
        ) < 0
        {
            None
        } else {
            let ok = BCryptHashData(hash, data.as_ptr(), len, 0) >= 0
                && BCryptFinishHash(hash, out.as_mut_ptr(), 32, 0) >= 0;
            BCryptDestroyHash(hash);
            ok.then_some(out)
        };
        BCryptCloseAlgorithmProvider(provider, 0);
        result
    }
}

pub(super) fn token(player: &str) -> Option<String> {
    let now = crate::util::now_ms() / 1000;
    let post = serde_json::to_string(&serde_json::json!({"playerName":player})).ok()?;
    let payload =
        serde_json::to_vec(&serde_json::json!({"post":post,"nbf":now,"iat":now,"exp":now+180}))
            .ok()?;
    let message = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#),
        URL_SAFE_NO_PAD.encode(payload)
    );
    // this public placeholder is the key shipped by the reference, not a user credential
    let signature = hmac(b"SUPERSECRETPLACEHOLDER", message.as_bytes())?;
    Some(format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc4231_hmac_and_token_shape() {
        assert_eq!(
            hmac(&[0x0b; 20], b"Hi There").unwrap(),
            [
                0xb0, 0x34, 0x4c, 0x61, 0xd8, 0xdb, 0x38, 0x53, 0x5c, 0xa8, 0xaf, 0xce, 0xaf, 0x0b,
                0xf1, 0x2b, 0x88, 0x1d, 0xc2, 0x00, 0xc9, 0x83, 0x3d, 0xa7, 0x26, 0xe9, 0x37, 0x6c,
                0x2e, 0x32, 0xcf, 0xf7
            ]
        );
        let t = token("Example").unwrap();
        let parts: Vec<_> = t.split('.').collect();
        assert_eq!(parts.len(), 3);
        let payload: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(
            payload["exp"].as_i64().unwrap() - payload["iat"].as_i64().unwrap(),
            180
        );
    }
}
