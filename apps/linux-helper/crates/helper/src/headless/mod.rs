//! Headless session mode (helper-only design §3.4, H1): a box with no graphical session runs
//! only `psyche-helper`, and the helper's own virtual screen (`vscreen/`, L6) is its only screen.
//!
//! | file | what | pure? |
//! | --- | --- | --- |
//! | `mode.rs` | `--display`, `PSYCHE_DISPLAY`, and detection from `DISPLAY` / `WAYLAND_DISPLAY` | yes |
//! | `focus.rs` | whose window has the keyboard: the check before every typed batch | yes |
//! | `nnp.rs` | `NoNewPrivileges` on the helper, so on everything it starts | mostly |
//! | `surface.rs` | the computer-use engine on the virtual display (`apps.open`, `computer.*`) | no |
//!
//! Bootstrap order, as in the container entrypoint, done at the first call that needs it:
//! the session bus (always the screen's own private bus, never the owner's), Xvfb, the AT-SPI bus
//! on that private bus, then each app in its own scope with the X11 and accessibility
//! environment (`vscreen/recipes.rs`).

pub mod focus;
pub mod mode;
pub mod nnp;
pub mod surface;

use std::sync::{Arc, OnceLock};

use crate::paths::Env;

use psyche_linux_computer::engine::Engine;
use psyche_linux_computer::error::CapResult;
use psyche_linux_computer::linux::LinuxBackend;

use crate::vscreen::VscreenManager;

static FLAG: OnceLock<Option<mode::DisplayMode>> = OnceLock::new();

/// Records `--display` for whichever entry point runs (`serve` or `remote`).
pub fn set_display_flag(flag: Option<mode::DisplayMode>) {
    let _ = FLAG.set(flag);
}

/// The one setup both `serve` and `remote` run before anything is registered: resolve the mode
/// and, when headless, set `NoNewPrivileges` on the helper. `Err` is `(message, exit code)`.
/// Afterwards the entry point registers its capabilities and, if this returned `true`, calls
/// [`install`] with the virtual-screen manager.
pub fn setup(env: &dyn Env) -> Result<bool, (String, u8)> {
    let flag = FLAG.get().copied().flatten();
    let headless = mode::is_headless(flag, env).map_err(|m| (m, 2))?;
    if headless {
        nnp::enforce().map_err(|m| (m, 78))?;
        crate::log("display: headless (the virtual screen is the only screen)");
    }
    Ok(headless)
}

/// The surface `apps.*` and `computer.*` serve in this mode.
pub fn mode_surface(headless: bool) -> &'static str {
    if headless {
        "virtual_screen"
    } else {
        "direct"
    }
}

/// Whether a call's `surface` is the one this helper serves. A call that names none is the
/// local Host path's and is judged by the machine ceiling elsewhere; one that names another
/// surface is refused, never served by the engine of the surface it did not ask for.
pub fn surface_matches(requested: Option<&serde_json::Value>, headless: bool) -> bool {
    match requested {
        None => true,
        Some(v) => v.as_str() == Some(mode_surface(headless)),
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_call_for_another_surface_is_not_served() {
        let vs = json!("virtual_screen");
        let direct = json!("direct");
        assert!(surface_matches(Some(&vs), true));
        assert!(!surface_matches(Some(&direct), true));
        assert!(surface_matches(Some(&direct), false));
        assert!(!surface_matches(Some(&vs), false));
        assert!(!surface_matches(Some(&json!("separate_desktop")), true));
        assert!(!surface_matches(Some(&json!(7)), false));
        assert!(!surface_matches(Some(&json!(null)), false));
        assert!(surface_matches(None, true));
        assert_eq!(mode_surface(true), "virtual_screen");
        assert_eq!(mode_surface(false), "direct");
    }
}
