//! Psyche wire protocol types for the Linux helper.
//!
//! `generated` is produced by `cargo gen` (apps/linux-helper/xtask) from
//! `packages/protocol/generated/schema.json` with `typify`; `cargo gen-check` fails when it is
//! stale. Everything else here is hand-written and small: the frame envelope and the signing
//! payloads, which the TypeScript and Swift implementations also write by hand.

#[allow(clippy::all, unused_qualifications, dead_code, missing_docs)]
pub mod generated;

pub mod frame;
pub mod signing;

pub use generated::*;

/// The wire protocol version this helper speaks (`PROTOCOL_VERSION` in packages/protocol).
pub const PROTOCOL_VERSION: u64 = 1;

/// Largest accepted frame in UTF-8 bytes (`MAX_FRAME_BYTES`).
pub const MAX_FRAME_BYTES: usize = 1_048_576;
