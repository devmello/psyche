//! Which AT-SPI applications a surface may see (linux-desktop design §7.2, last bullet).
//!
//! Apps on the virtual display share the owner's session bus, so they show up on the same
//! accessibility bus as the owner's real apps. The helper filters by process: an application is
//! on the virtual screen only if its pid (from `GetConnectionUnixProcessID` on the a11y bus) is
//! in `psyche-vscreen.slice`, and Direct mode sees only applications outside that slice. The two
//! surfaces can therefore not drive each other's apps.
//!
//! The AT-SPI module itself belongs to the direct-computer-use work (`a11y/`). This file is the
//! seam: that module implements `A11yApps` (or just calls `visible_to` on its own list of
//! applications) and the filter stays here, tested on its own.

use super::guard::Procs;

/// One AT-SPI application: its unique bus name on the a11y bus and the pid behind it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct A11yApp {
    pub bus_name: String,
    pub pid: u32,
}

/// The accessibility registry's list of applications.
pub trait A11yApps {
    fn applications(&self) -> Vec<A11yApp>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Direct,
    VirtualScreen,
}

/// The applications `surface` may see.
pub fn visible_to(surface: Surface, apps: Vec<A11yApp>, procs: &dyn Procs) -> Vec<A11yApp> {
    apps.into_iter()
        .filter(|app| {
            let ours = procs.in_vscreen_slice(app.pid);
            match surface {
                Surface::VirtualScreen => ours,
                Surface::Direct => !ours,
            }
        })
        .collect()
}

/// Whether `surface` may act on the application behind `pid` (the check every action makes).
pub fn may_act_on(surface: Surface, pid: u32, procs: &dyn Procs) -> bool {
    let ours = procs.in_vscreen_slice(pid);
    (surface == Surface::VirtualScreen) == ours
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::Path;

    struct Slice(HashSet<u32>);
    impl Procs for Slice {
        fn find(&self, _: Option<&Path>, _: &[&str]) -> Vec<u32> {
            Vec::new()
        }
        fn in_vscreen_slice(&self, pid: u32) -> bool {
            self.0.contains(&pid)
        }
    }

    fn apps() -> Vec<A11yApp> {
        vec![
            A11yApp { bus_name: ":1.10".into(), pid: 10 },
            A11yApp { bus_name: ":1.20".into(), pid: 20 },
            A11yApp { bus_name: ":1.30".into(), pid: 30 },
        ]
    }

    #[test]
    fn each_surface_sees_only_its_own_apps() {
        let procs = Slice(HashSet::from([20]));
        let v: Vec<u32> = visible_to(Surface::VirtualScreen, apps(), &procs).iter().map(|a| a.pid).collect();
        let d: Vec<u32> = visible_to(Surface::Direct, apps(), &procs).iter().map(|a| a.pid).collect();
        assert_eq!(v, vec![20]);
        assert_eq!(d, vec![10, 30]);
    }

    #[test]
    fn acting_across_surfaces_is_refused() {
        let procs = Slice(HashSet::from([20]));
        assert!(may_act_on(Surface::VirtualScreen, 20, &procs));
        assert!(!may_act_on(Surface::VirtualScreen, 10, &procs));
        assert!(may_act_on(Surface::Direct, 10, &procs));
        assert!(!may_act_on(Surface::Direct, 20, &procs));
    }
}
