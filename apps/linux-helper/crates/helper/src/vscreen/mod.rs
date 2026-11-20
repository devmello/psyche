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
//! | `scope.rs` | `systemd-run --user --scope` in `psyche-vscreen.slice`, the slice's caps | args are pure |
//! | `bus.rs` | the session's private runtime dir and D-Bus session bus | mostly |
//! | `spawn.rs` | children forked from a process-lifetime thread, peer checks | no |
//! | `rmtree.rs` | removing a tree without following symlinks or crossing mounts | no |
//! | `sweep.rs` | what a crashed helper left behind, cleared at start | mostly |
//! | `xauth.rs`, `xvfb.rs` | the private X server | no |
//! | `wmdriver.rs`, `capture.rs`, `input.rs` | X11: window manager, XShm, XTest | no |
//! | `display.rs` | **`VirtualDisplay`**: Xvfb + window manager + capture + input in one value | no |
//! | `manager.rs` | apps, closing, parking, idle stop | traits |
//! | `capabilities.rs` | the five `vscreen.*` capabilities | no |
//!
//! `VirtualDisplay` is also the backend for the separate-desktop container, which runs the same
//! Xvfb and window manager inside the guest: it needs nothing from systemd or the Gateway.

pub mod a11y;
pub mod bus;
pub mod capabilities;
pub mod capture;
pub mod display;
pub mod guard;
pub mod input;
pub mod manager;
pub mod recipes;
pub mod rmtree;
pub mod scope;
pub mod spawn;
pub mod sweep;
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
    let manager = add_capabilities(registry, env, idle);
    // A helper that crashed left its bus, accessibility launcher, app scopes and session dirs.
    let sweeper = Arc::clone(&manager);
    std::thread::Builder::new()
        .name("vscreen-sweep".into())
        .spawn(move || sweeper.sweep_leftovers())
        .ok();
    manager
}

/// [`register`] without the leftover sweep: the capabilities and their manager, which starts
/// nothing on its own.
pub fn add_capabilities(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildinfo::BuildInfo;

    /// The registry `main` builds: direct computer use (L5), then virtual screens (L6).
    /// `Registry::register` panics on a duplicate name, so a clash fails here, not at start.
    #[test]
    fn main_registers_direct_and_vscreen_with_distinct_names() {
        let mut registry = Registry::standard(BuildInfo::current());
        crate::direct::register(&mut registry);
        add_capabilities(
            &mut registry,
            &crate::paths::ProcessEnv,
            Arc::new(IdleTimer::new(None)),
        );
        assert!(registry.get("apps.open").is_some() && registry.get("vscreen.start").is_some());
    }
}
