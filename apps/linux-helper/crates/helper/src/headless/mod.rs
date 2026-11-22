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

/// Whether the helper runs headless. `remote` (a machine paired to a Gateway) is **always**
/// headless: the private screen is all a machine offers until the later desktop opt-in (H9), and
/// `auto` must not turn it into a helper that reads the owner's desktop because a `DISPLAY`
/// happened to be set. An explicit `--display desktop` is refused there, not honoured.
pub fn resolve_headless(
    remote: bool,
    flag: Option<mode::DisplayMode>,
    env: &dyn Env,
) -> Result<bool, String> {
    if remote {
        if flag == Some(mode::DisplayMode::Desktop) {
            return Err("remote mode serves the private screen only; --display desktop is not available there".into());
        }
        if flag.is_none() {
            // PSYCHE_DISPLAY=desktop is the same request as the flag.
            if let Some(v) = env.get("PSYCHE_DISPLAY") {
                if mode::DisplayMode::parse(v.trim()) == Some(mode::DisplayMode::Desktop) {
                    return Err("remote mode serves the private screen only; PSYCHE_DISPLAY=desktop is not available there".into());
                }
            }
        }
        return Ok(true);
    }
    mode::is_headless(flag, env)
}

/// The one setup both `serve` and `remote` run before anything is registered: resolve the mode
/// and, when headless, set `NoNewPrivileges` on the helper. `Err` is `(message, exit code)`.
/// Afterwards the entry point registers its capabilities and, if this returned `true`, calls
/// [`install`] with the virtual-screen manager.
pub fn setup(remote: bool, env: &dyn Env) -> Result<bool, (String, u8)> {
    let flag = FLAG.get().copied().flatten();
    let headless = resolve_headless(remote, flag, env).map_err(|m| (m, 2))?;
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

/// The other ids the app a call names carries on the running virtual screen (a verified
/// Flatpak's own id beside the host id that caps it, and the other way round), for the dispatch
/// gate. Never starts the screen: with no screen, or no engine on it yet, nothing is running and
/// there are none.
pub fn other_ids(id: &str) -> Vec<String> {
    match SURFACE.get().and_then(|s| s.running_engine()) {
        Some(engine) => {
            use psyche_linux_computer::backend::Backend;
            surface::ids_carried(&engine.backend.apps(), id)
        }
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn remote_is_headless_whatever_the_environment_says() {
        use std::collections::HashMap;
        let desk: HashMap<String, String> = [
            ("DISPLAY".to_string(), ":0".to_string()),
            ("WAYLAND_DISPLAY".to_string(), "wayland-0".to_string()),
        ]
        .into();
        // `serve` follows the environment; `remote` does not.
        assert_eq!(resolve_headless(false, None, &desk), Ok(false));
        assert_eq!(resolve_headless(true, None, &desk), Ok(true));
        assert_eq!(
            resolve_headless(true, Some(mode::DisplayMode::Auto), &desk),
            Ok(true)
        );
        assert_eq!(
            resolve_headless(true, Some(mode::DisplayMode::Headless), &desk),
            Ok(true)
        );
        // The desktop is refused for a machine, by flag or by variable.
        assert!(resolve_headless(true, Some(mode::DisplayMode::Desktop), &desk).is_err());
        let mut env = desk.clone();
        env.insert("PSYCHE_DISPLAY".into(), "desktop".into());
        assert!(resolve_headless(true, None, &env).is_err());
    }

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
