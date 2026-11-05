//! The Psyche Linux helper (linux-desktop design §4): a node that speaks the same node protocol
//! as the Mac helper, over the Gateway's node socket, so the Gateway sees "a helper" and not a
//! Linux special case.
//!
//! This crate is plain Rust and builds and tests on macOS too. Linux-only code (AT-SPI, portals,
//! PipeWire, X11 in later PRs) goes behind `cfg(target_os = "linux")`.

pub mod backoff;
pub mod buildinfo;
pub mod capability;
pub mod channel;
pub mod cli;
pub mod daemon;
pub mod handshake;
pub mod identity;
pub mod idle;
pub mod paths;
pub mod session;

/// Structured, content-free logging to stderr: phases, names and sizes only, never params,
/// results or secrets. The service manager captures it.
pub fn log(message: &str) {
    eprintln!("psyche-helper: {message}");
}
