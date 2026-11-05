//! `screen.context` for "Ask about my screen" (docs/design/screen-ask-2026.md): one capture of the
//! foreground window or a region, with the app, window title, selected text and browser URL.
//! Served by `psyche_win_computer` through the same adapter as `computer.*`. Owner-initiated:
//! only the desktop reaches it, through the Gateway's own `screen.capture`.

use psyche_win_computer as wc;

use crate::node::CapabilityRegistry;

pub fn register(reg: &mut CapabilityRegistry) {
    for s in wc::specs().iter().filter(|s| s.name.starts_with("screen.")) {
        crate::computer::add(reg, s);
    }
}
