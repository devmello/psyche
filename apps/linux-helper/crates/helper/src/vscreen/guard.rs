//! Single-instance protection, before launch (linux-desktop design §7.2, rule 1).
//!
//! Many apps hand a new launch to an instance that already runs, and the window then opens on
//! the owner's real display. So before launching, the helper checks whether the app already runs
//! outside `psyche-vscreen.slice`: its desktop id's D-Bus name is owned by a process outside the
//! slice, or a process with its executable runs outside it. If so the launch is refused with
//! `already_open_on_your_screen`; the helper never asks the running instance to open a window.

use std::path::{Path, PathBuf};

use super::recipes::{recipe_for, DesktopEntry};

pub const SLICE: &str = "psyche-vscreen.slice";

/// The session bus, as far as the guard needs it.
pub trait SessionBus: Send + Sync {
    /// The pid of the process that owns `name`, `None` when nobody does.
    fn name_owner_pid(&self, name: &str) -> Option<u32>;
}

/// The process table.
pub trait Procs: Send + Sync {
    /// Pids whose executable path is `exe`, or whose `comm` is one of `names`.
    fn find(&self, exe: Option<&Path>, names: &[&str]) -> Vec<u32>;
    /// Whether `pid` runs inside `psyche-vscreen.slice`.
    fn in_vscreen_slice(&self, pid: u32) -> bool;
    /// `/proc/<pid>/cgroup`, empty when the process is gone.
    fn cgroup_text(&self, _pid: u32) -> String {
        String::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The app is open on the owner's screen (the pid is not shown to the model).
    AlreadyOpenOnYourScreen,
}

/// The D-Bus names a GApplication-style app owns: its desktop id, when that looks like one.
pub fn bus_names(entry: &DesktopEntry) -> Vec<String> {
    let id = entry.id.as_str();
    if id.contains('.') && !id.contains('/') {
        vec![id.to_string()]
    } else {
        Vec::new()
    }
}

/// Resolves `exec[0]` against `PATH` to a canonical file.
pub fn resolve_exe(entry: &DesktopEntry, path_var: &str) -> Option<PathBuf> {
    let first = entry.try_exec.as_deref().unwrap_or(&entry.exec[0]);
    let candidate = if first.contains('/') {
        PathBuf::from(first)
    } else {
        path_var
            .split(':')
            .filter(|d| !d.is_empty())
            .map(|d| Path::new(d).join(first))
            .find(|p| p.is_file())?
    };
    std::fs::canonicalize(candidate).ok()
}

/// The pre-launch check.
pub fn check_before_launch(
    entry: &DesktopEntry,
    exe: Option<&Path>,
    bus: &dyn SessionBus,
    procs: &dyn Procs,
) -> Result<(), Refusal> {
    for name in bus_names(entry) {
        if let Some(pid) = bus.name_owner_pid(&name) {
            if !procs.in_vscreen_slice(pid) {
                return Err(Refusal::AlreadyOpenOnYourScreen);
            }
        }
    }
    let names: &[&str] = recipe_for(&entry.id).map(|r| r.process_names).unwrap_or(&[]);
    // Without a recipe the executable path is all there is to match on.
    if exe.is_some() || !names.is_empty() {
        let outside = procs
            .find(exe, names)
            .into_iter()
            .any(|pid| !procs.in_vscreen_slice(pid));
        if outside {
            return Err(Refusal::AlreadyOpenOnYourScreen);
        }
    }
    Ok(())
}

// ---- the real thing ----

/// `busctl --user call org.freedesktop.DBus ... GetConnectionUnixProcessID`.
pub struct BusctlBus;

impl SessionBus for BusctlBus {
    fn name_owner_pid(&self, name: &str) -> Option<u32> {
        let out = std::process::Command::new("busctl")
            .args([
                "--user",
                "call",
                "org.freedesktop.DBus",
                "/org/freedesktop/DBus",
                "org.freedesktop.DBus",
                "GetConnectionUnixProcessID",
                "s",
                name,
            ])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        parse_busctl_u32(&String::from_utf8_lossy(&out.stdout))
    }
}

/// `u 1234` -> 1234.
pub fn parse_busctl_u32(text: &str) -> Option<u32> {
    let mut parts = text.split_whitespace();
    (parts.next()? == "u").then_some(())?;
    parts.next()?.parse().ok()
}

/// Whether a `/proc/<pid>/cgroup` text places the process in the virtual-screen slice.
pub fn cgroup_in_slice(cgroup_text: &str) -> bool {
    cgroup_text.lines().any(|l| l.contains(SLICE))
}

pub struct ProcFs;

impl ProcFs {
    fn pids() -> Vec<u32> {
        std::fs::read_dir("/proc")
            .map(|d| {
                d.filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Procs for ProcFs {
    fn find(&self, exe: Option<&Path>, names: &[&str]) -> Vec<u32> {
        let own = std::process::id();
        Self::pids()
            .into_iter()
            .filter(|&pid| pid != own)
            .filter(|pid| {
                if let (Some(want), Ok(have)) = (exe, std::fs::read_link(format!("/proc/{pid}/exe"))) {
                    if have == want {
                        return true;
                    }
                }
                std::fs::read_to_string(format!("/proc/{pid}/comm"))
                    .map(|c| names.contains(&c.trim()))
                    .unwrap_or(false)
            })
            .collect()
    }

    fn in_vscreen_slice(&self, pid: u32) -> bool {
        cgroup_in_slice(&self.cgroup_text(pid))
    }

    fn cgroup_text(&self, pid: u32) -> String {
        std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    struct FakeBus(HashMap<String, u32>);
    impl SessionBus for FakeBus {
        fn name_owner_pid(&self, name: &str) -> Option<u32> {
            self.0.get(name).copied()
        }
    }

    struct FakeProcs {
        running: Vec<(u32, Option<PathBuf>, String)>,
        ours: HashSet<u32>,
    }
    impl Procs for FakeProcs {
        fn find(&self, exe: Option<&Path>, names: &[&str]) -> Vec<u32> {
            self.running
                .iter()
                .filter(|(_, e, comm)| {
                    (exe.is_some() && e.as_deref() == exe) || names.contains(&comm.as_str())
                })
                .map(|(p, _, _)| *p)
                .collect()
        }
        fn in_vscreen_slice(&self, pid: u32) -> bool {
            self.ours.contains(&pid)
        }
    }

    fn entry(id: &str, exec: &str) -> DesktopEntry {
        DesktopEntry {
            id: id.into(),
            name: id.into(),
            exec: vec![exec.into()],
            try_exec: None,
            terminal: false,
            dbus_activatable: false,
            startup_wm_class: None,
        }
    }

    fn nothing() -> FakeProcs {
        FakeProcs { running: vec![], ours: HashSet::new() }
    }

    #[test]
    fn an_owned_bus_name_outside_the_slice_refuses() {
        let bus = FakeBus(HashMap::from([("org.gnome.TextEditor".into(), 100)]));
        let r = check_before_launch(&entry("org.gnome.TextEditor", "gnome-text-editor"), None, &bus, &nothing());
        assert_eq!(r, Err(Refusal::AlreadyOpenOnYourScreen));
    }

    #[test]
    fn an_owned_bus_name_inside_the_slice_is_ours_and_allowed() {
        let bus = FakeBus(HashMap::from([("org.gnome.TextEditor".into(), 100)]));
        let procs = FakeProcs { running: vec![], ours: HashSet::from([100]) };
        assert!(check_before_launch(&entry("org.gnome.TextEditor", "gnome-text-editor"), None, &bus, &procs).is_ok());
    }

    #[test]
    fn a_process_with_the_same_executable_outside_the_slice_refuses() {
        let exe = PathBuf::from("/usr/bin/gnome-text-editor");
        let procs = FakeProcs { running: vec![(7, Some(exe.clone()), "gnome-text-edit".into())], ours: HashSet::new() };
        let r = check_before_launch(&entry("gnome-text-editor", "gnome-text-editor"), Some(&exe), &FakeBus(HashMap::new()), &procs);
        assert_eq!(r, Err(Refusal::AlreadyOpenOnYourScreen));
        let procs = FakeProcs { running: vec![(7, Some(exe.clone()), "x".into())], ours: HashSet::from([7]) };
        assert!(check_before_launch(&entry("gnome-text-editor", "gnome-text-editor"), Some(&exe), &FakeBus(HashMap::new()), &procs).is_ok());
    }

    #[test]
    fn firefox_is_found_by_process_name_even_when_the_launcher_is_a_script() {
        let procs = FakeProcs { running: vec![(9, None, "firefox-bin".into())], ours: HashSet::new() };
        let r = check_before_launch(&entry("firefox", "firefox"), Some(Path::new("/usr/bin/firefox")), &FakeBus(HashMap::new()), &procs);
        assert_eq!(r, Err(Refusal::AlreadyOpenOnYourScreen));
    }

    #[test]
    fn nothing_running_means_go() {
        assert!(check_before_launch(&entry("firefox", "firefox"), None, &FakeBus(HashMap::new()), &nothing()).is_ok());
    }

    #[test]
    fn only_reverse_dns_ids_are_bus_names() {
        assert_eq!(bus_names(&entry("org.gnome.Calculator", "gnome-calculator")), vec!["org.gnome.Calculator"]);
        assert!(bus_names(&entry("firefox", "firefox")).is_empty());
    }

    #[test]
    fn busctl_output_and_cgroups_are_parsed() {
        assert_eq!(parse_busctl_u32("u 4242\n"), Some(4242));
        assert_eq!(parse_busctl_u32("s \"x\""), None);
        assert_eq!(parse_busctl_u32(""), None);
        assert!(cgroup_in_slice("0::/user.slice/user-1000.slice/user@1000.service/psyche-vscreen.slice/psyche-vs-a-1.scope\n"));
        assert!(!cgroup_in_slice("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-x.scope\n"));
    }

    #[test]
    fn the_executable_is_resolved_through_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("myapp");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        let found = resolve_exe(&entry("myapp", "myapp"), &format!("/nonexistent:{}", dir.path().display()));
        assert_eq!(found, Some(std::fs::canonicalize(&bin).unwrap()));
        assert_eq!(resolve_exe(&entry("nope", "nope"), "/nonexistent"), None);
    }
}
