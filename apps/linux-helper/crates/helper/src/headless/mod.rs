//! Headless session mode (helper-only design §3.4, H1): a box with no graphical session runs
//! only `psyche-helper`, and the helper's own virtual screen (`vscreen/`, L6) is its only screen.
//!
//! | file | what | pure? |
//! | --- | --- | --- |
//! | `mode.rs` | `--display`, `PSYCHE_DISPLAY`, and detection from `DISPLAY` / `WAYLAND_DISPLAY` | yes |
//! | `deny.rs` | the ceiling's `apps.deny`, read from `policy.json` | yes |
//! | `focus.rs` | whose window has the keyboard: the check before every typed batch | yes |
//! | `nnp.rs` | `NoNewPrivileges` on the helper, so on everything it starts | mostly |
//! | `surface.rs` | the computer-use engine on the virtual display (`apps.open`, `computer.*`) | no |
//!
//! Bootstrap order, as in the container entrypoint, done at the first call that needs it:
//! the session bus (always the screen's own private bus, never the owner's), Xvfb, the AT-SPI bus
//! on that private bus, then each app in its own scope with the X11 and accessibility
//! environment (`vscreen/recipes.rs`).

pub mod deny;
pub mod focus;
pub mod mode;
pub mod nnp;
pub mod surface;

use std::sync::{Arc, OnceLock};

use psyche_linux_computer::engine::Engine;
use psyche_linux_computer::error::CapResult;
use psyche_linux_computer::linux::LinuxBackend;

use crate::vscreen::VscreenManager;

static SURFACE: OnceLock<Arc<surface::HeadlessSurface>> = OnceLock::new();

/// Makes the virtual screen the surface `apps.*` and `computer.*` act on. Called once, from
/// `main`, when the resolved mode is headless.
pub fn install(manager: Arc<VscreenManager>) {
    manager.set_headless(true);
    let _ = SURFACE.set(surface::HeadlessSurface::new(manager));
}

/// Whether this helper runs headless (the virtual screen is its only screen).
pub fn active() -> bool {
    SURFACE.get().is_some()
}

/// The engine on the virtual screen, or `None` when this helper is not headless (the direct
/// path then uses the owner's desktop).
pub fn engine() -> Option<CapResult<Arc<Engine<LinuxBackend>>>> {
    SURFACE.get().map(|s| s.engine())
}
