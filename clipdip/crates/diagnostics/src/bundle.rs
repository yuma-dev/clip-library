//! Builds the diagnostic `.zip` uploaded to `/v1/bundles`.
//!
//! Deliberately an *allowlist*: only the app logs, the (secret-free) config
//! TOML, and a small generated system-info sheet. Discord OAuth tokens live in
//! a separate file that is never named here, so they can't leak into a bundle.

use crate::paths;
use anyhow::{Context, Result};
use std::io::Write;
use zip::write::SimpleFileOptions;

/// Build the bundle in memory. Kept small (logs are capped at 10 MB by the
/// app's own rotation) so this stays well under the server's 50 MB limit.
pub fn build_zip(install_id: &str, app_version: &str) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        if let Some(p) = paths::log_path() {
            add_file(&mut zw, "clipdip.log", &p, opts);
        }
        if let Some(p) = paths::log_path_old() {
            add_file(&mut zw, "clipdip.log.old", &p, opts);
        }
        if let Some(p) = paths::config_path() {
            add_file(&mut zw, "config.toml", &p, opts);
        }

        zw.start_file("system-info.txt", opts)
            .context("start system-info entry")?;
        zw.write_all(system_info(install_id, app_version).as_bytes())
            .context("write system-info")?;

        zw.finish().context("finalize zip")?;
    }
    Ok(buf)
}

/// Add a file if it exists; a missing log/config is not an error (fresh install,
/// no rotation yet), we just omit it.
fn add_file<W: Write + std::io::Seek>(
    zw: &mut zip::ZipWriter<W>,
    name: &str,
    path: &std::path::Path,
    opts: SimpleFileOptions,
) {
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    if zw.start_file(name, opts).is_ok() {
        let _ = zw.write_all(&bytes);
    }
}

fn system_info(install_id: &str, app_version: &str) -> String {
    format!(
        "clipdip diagnostic bundle\n\
         generated:    {}\n\
         install_id:   {}\n\
         app_version:  {}\n\
         os:           {} ({})\n\
         family:       {}\n",
        chrono::Utc::now().to_rfc3339(),
        install_id,
        app_version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::consts::FAMILY,
    )
}
