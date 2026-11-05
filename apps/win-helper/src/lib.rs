//! Psyche Helper for Windows (`psyche-helper.exe`): the Windows node. It speaks the node wire
//! protocol of the mac helper over a named pipe and serves Windows-backed capabilities with the
//! same names and shapes. See `README.md` for the layout and how to add a capability.

#![cfg(windows)]

pub mod groups;
pub mod node;
pub mod win;

// Capability groups (each exposes `pub fn register(reg: &mut CapabilityRegistry)`).
pub mod apps;
pub mod files;
pub mod health;
pub mod keychain;
pub mod notify;
pub mod ocr;
pub mod permissions;
pub mod presence;

// Wave-2 groups: wired, registering nothing yet.
pub mod computer;
pub mod dictation;
pub mod screen;
pub mod speech;
pub mod teach;
