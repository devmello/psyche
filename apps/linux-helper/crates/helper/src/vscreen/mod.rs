//! The virtual screen (linux-desktop design §7): an invisible X display on the owner's machine
//! where Psyche uses the owner's apps without touching the owner's screen, pointer or keyboard.
//!
//! Layers, bottom to top:
//!
//! | file | what | pure? |
//! | --- | --- | --- |
//! | `wm.rs` | the window manager as a state machine | yes |
//! | `recipes.rs` | desktop entries, per-app launch recipes | yes |
//! | `guard.rs` | single-instance checks before launch | traits + fakes |
//! | `a11y.rs` | which AT-SPI apps each surface may see | trait + fakes |
//! | `scope.rs` | `systemd-run --user --scope` in `psyche-vscreen.slice` | args are pure |
//! | `xauth.rs`, `xvfb.rs` | the private X server | no |
//! | `wmdriver.rs`, `capture.rs`, `input.rs` | X11: window manager, XShm, XTest | no |
//! | `display.rs` | **`VirtualDisplay`**: Xvfb + window manager + capture + input in one value | no |
//! | `manager.rs` | apps, closing, parking, idle stop | traits |
//! | `capabilities.rs` | the five `vscreen.*` capabilities | no |
//!
//! `VirtualDisplay` is also the backend for the separate-desktop container, which runs the same
//! Xvfb and window manager inside the guest: it needs nothing from systemd or the Gateway.

pub mod a11y;
pub mod capabilities;
pub mod capture;
pub mod display;
pub mod guard;
pub mod input;
pub mod manager;
pub mod recipes;
pub mod scope;
pub mod wm;
pub mod wmdriver;
pub mod xauth;
pub mod xvfb;

use std::sync::Arc;

use crate::capability::Registry;
use crate::idle::IdleTimer;
use crate::paths::Env;

pub use manager::{Config, Deps, VscreenManager};

/// Adds the `vscreen.*` capabilities. Nothing starts until the first call that needs a display.
pub fn register(
    registry: &mut Registry,
    env: &dyn Env,
    idle: Arc<IdleTimer>,
) -> Arc<VscreenManager> {
    let manager = VscreenManager::new(Config::from_env(env), Deps::real(), idle);
    for capability in capabilities::all(&manager) {
        registry.register(capability);
    }
    manager
}
