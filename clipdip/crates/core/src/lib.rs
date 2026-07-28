//! `clipdip-core` — shared types and the capture-pipeline orchestrator.
//!
//! - [`config`] is the user-tunable settings model persisted as TOML.
//! - [`pipeline::Pipeline`] owns the running capture: ring buffer, video
//!   capture+encode thread, per-source audio threads, and the save
//!   path. The CLI binary and (when it lands) the Tauri UI both call
//!   into the same `start` / `save_clip` / `stop` API.

pub mod config;
pub mod diskinfo;
pub mod filename;
pub mod pipeline;

pub use pipeline::{AudioMeta, Pipeline};
