//! Runtime loader for nvEncodeAPI64.dll.
//!
//! `Library` and the function table are kept together so the DLL stays
//! mapped for as long as we hold a reference to any function pointer in it.

use anyhow::{anyhow, Context, Result};
use libloading::Library;
use std::sync::Arc;

use crate::sys::{
    NV_ENCODE_API_FUNCTION_LIST, NV_ENCODE_API_FUNCTION_LIST_VER, NV_ENC_SUCCESS,
    NVENC_CREATE_INSTANCE_SYM, NVENC_DLL_NAME, NVENCAPI_VERSION,
    PFN_NvEncodeAPICreateInstance,
};

pub struct NvEncApi {
    // Keep the library loaded for the lifetime of the function table.
    _lib: Library,
    pub functions: NV_ENCODE_API_FUNCTION_LIST,
}

impl NvEncApi {
    /// Load `nvEncodeAPI64.dll` from the standard Windows DLL search path
    /// (System32 is where the NVIDIA driver installs it) and call
    /// `NvEncodeAPICreateInstance` to populate the function pointer table.
    pub fn load() -> Result<Arc<Self>> {
        // SAFETY: libloading is inherently unsafe because DLL init code may
        // run anything. nvEncodeAPI64.dll's init is well-behaved (it's part
        // of the production NVIDIA driver).
        let lib = unsafe { Library::new(NVENC_DLL_NAME) }
            .with_context(|| format!("loading {NVENC_DLL_NAME} — is the NVIDIA driver installed?"))?;

        let create: libloading::Symbol<PFN_NvEncodeAPICreateInstance> = unsafe {
            lib.get(NVENC_CREATE_INSTANCE_SYM).with_context(|| {
                format!("resolving NvEncodeAPICreateInstance in {NVENC_DLL_NAME}")
            })?
        };

        let mut functions = NV_ENCODE_API_FUNCTION_LIST::default();
        functions.version = NV_ENCODE_API_FUNCTION_LIST_VER;

        // SAFETY: `functions` is a properly-sized #[repr(C)] struct with
        // the correct version tag. NvEncodeAPICreateInstance writes function
        // pointers into it.
        let status = unsafe { (create)(&mut functions) };
        if status != NV_ENC_SUCCESS {
            return Err(anyhow!(
                "NvEncodeAPICreateInstance returned status {status} \
                 (driver too old for SDK 13.0 / NVENCAPI_VERSION=0x{:x}?)",
                NVENCAPI_VERSION
            ));
        }

        // Sanity check: the loader must have populated at least the entry
        // points we plan to use. If any of these are still null after a
        // successful return, something is very wrong with the driver.
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

    /// Run with `cargo test -p clipdip-encoder -- --ignored` on a machine
    /// with a working NVIDIA driver. Ignored by default so CI / non-NVIDIA
    /// dev machines don't fail.
    #[test]
    #[ignore = "requires NVIDIA driver on host"]
    fn loads_real_driver_dll() {
        let api = NvEncApi::load().expect("load nvEncodeAPI64.dll");
        // Every function pointer should be non-null after a successful call.
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
