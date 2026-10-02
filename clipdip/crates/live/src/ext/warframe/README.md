# warframe presence port

Port bundle version: 0.1.1. The module manifest records sources, options, and preview scenarios. Runtime and previews share the same card builder.

Read `LICENSES.md` for copied source licenses. `log.rs` follows the shared Tail helper, clears state on rotation/truncation/missing data, and ignores files older than the session (with a 30-second launch allowance). Tests cover parsing, preview fallbacks, display options, and file following.

Validation in the isolated crate: `cargo test warframe` and `cargo clippy --all-targets`. Only this module and its directory are copied into the shared crate.
