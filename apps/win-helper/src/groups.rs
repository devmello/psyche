//! The one list of capability groups. Order is manifest order. Adding a group: create
//! `src/<group>/mod.rs` with `pub fn register(reg: &mut CapabilityRegistry)`, declare it in
//! `lib.rs`, and append it here.

use std::sync::Arc;

use crate::node::{CapabilityRegistry, Runtime};

pub type RegisterFn = fn(&mut CapabilityRegistry);

pub const GROUPS: &[(&str, RegisterFn)] = &[
    ("permissions", crate::permissions::register),
    ("computer", crate::computer::register),
    ("screen", crate::screen::register),
    ("apps", crate::apps::register),
    ("notify", crate::notify::register),
    ("speech", crate::speech::register),
    ("keychain", crate::keychain::register),
    ("presence", crate::presence::register),
    ("ocr", crate::ocr::register),
    ("dictation", crate::dictation::register),
    ("files", crate::files::register),
    ("outlook", crate::outlook::register),
    ("teach", crate::teach::register),
    ("health", crate::health::register),
];

/// Builds the registry with every group.
pub fn build(runtime: Arc<Runtime>) -> CapabilityRegistry {
    let mut reg = CapabilityRegistry::new(runtime);
    for (_, register) in GROUPS {
        register(&mut reg);
    }
    reg
}
