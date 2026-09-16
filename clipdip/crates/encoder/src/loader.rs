//! Runtime loader for nvEncodeAPI64.dll. `Library` and the function table
//! are kept together so the DLL stays mapped while any function pointer is held.

use anyhow::{anyhow, Context, Result};
use libloading::Library;
use std::sync::Arc;

use crate::sys::{
    NV_ENCODE_API_FUNCTION_LIST, NV_ENCODE_API_FUNCTION_LIST_VER, NV_ENC_SUCCESS,
    NVENC_CREATE_INSTANCE_SYM, NVENC_DLL_NAME, NVENCAPI_VERSION,
    PFN_NvEncodeAPICreateInstance,
};

pub struct NvEncApi {
    _lib: Library, // keeps the DLL loaded for the function table's lifetime
    pub functions: NV_ENCODE_API_FUNCTION_LIST,
}

impl NvEncApi {
    /// Loads from the standard DLL search path (System32, where the driver installs it).
    pub fn load() -> Result<Arc<Self>> {
        // SAFETY: DLL init code may run anything, but this is the production NVIDIA driver.
        let lib = unsafe { Library::new(NVENC_DLL_NAME) }
            .with_context(|| format!("loading {NVENC_DLL_NAME} — is the NVIDIA driver installed?"))?;

        let create: libloading::Symbol<PFN_NvEncodeAPICreateInstance> = unsafe {
            lib.get(NVENC_CREATE_INSTANCE_SYM).with_context(|| {
                format!("resolving NvEncodeAPICreateInstance in {NVENC_DLL_NAME}")
            })?
        };

        let mut functions = NV_ENCODE_API_FUNCTION_LIST::default();
        functions.version = NV_ENCODE_API_FUNCTION_LIST_VER;

        // SAFETY: `functions` is a correctly sized/versioned #[repr(C)] struct.
        let status = unsafe { (create)(&mut functions) };
        if status != NV_ENC_SUCCESS {
            return Err(anyhow!(
                "NvEncodeAPICreateInstance returned status {status} \
                 (driver too old for SDK 13.0 / NVENCAPI_VERSION=0x{:x}?)",
                NVENCAPI_VERSION
            ));
        }

        // catches a driver that reports success but left entry points we need null
        if functions.nvEncOpenEncodeSessionEx.is_none() {
            return Err(anyhow!(
                "function table populated but nvEncOpenEncodeSessionEx is null"
            ));
        }
        if functions.nvEncGetEncodePresetConfigEx.is_none() {
            return Err(anyhow!(
                "function table populated but nvEncGetEncodePresetConfigEx is null"
            ));
        }
        if functions.nvEncRegisterAsyncEvent.is_none()
            || functions.nvEncUnregisterAsyncEvent.is_none()
        {
            return Err(anyhow!(
                "function table populated but async-event entry points are null"
            ));
        }
        if functions.nvEncGetSequenceParams.is_none() {
            return Err(anyhow!(
                "function table populated but nvEncGetSequenceParams is null"
            ));
        }

        Ok(Arc::new(Self {
            _lib: lib,
            functions,
        }))
    }

    pub fn api_version(&self) -> u32 {
        NVENCAPI_VERSION
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cargo test -p clipdip-encoder -- --ignored`, needs a real NVIDIA driver.
    #[test]
    #[ignore = "requires NVIDIA driver on host"]
    fn loads_real_driver_dll() {
        let api = NvEncApi::load().expect("load nvEncodeAPI64.dll");
        assert!(!api.functions.nvEncOpenEncodeSession.is_null());
        assert!(api.functions.nvEncOpenEncodeSessionEx.is_some());
        assert!(api.functions.nvEncInitializeEncoder.is_some());
        assert!(api.functions.nvEncRegisterResource.is_some());
        assert!(api.functions.nvEncEncodePicture.is_some());
        assert!(api.functions.nvEncLockBitstream.is_some());
        assert!(api.functions.nvEncDestroyEncoder.is_some());
        println!("NVENC API loaded, version = 0x{:x}", api.api_version());
    }
}
