//! Single-instance protection, before launch (linux-desktop design §7.2, rule 1).
//!
//! Many apps hand a new launch to an instance that already runs, and the window then opens on
//! the owner's real display. So before launching, the helper checks whether the app already runs
//! outside `psyche-vscreen.slice`: its desktop id's D-Bus name is owned by a process outside the
//! slice, or a process with its executable runs outside it. If so the launch is refused with
//! `already_open_on_your_screen`; the helper never asks the running instance to open a window.
//!
//! - **Fails closed.** When the owner's bus cannot be asked (no `busctl`, no bus, an odd answer),
//!   the launch is refused with `guard_unavailable`, not let through to the 10 s post-check.
//! - **Recipes that make a separate instance** (`refuse_while_open: false`: their own profile or
//!   user-data directory) skip the process check: a copy on the owner's screen cannot receive
//!   the launch. Every other app is refused while a copy runs outside the slice.

use std::path::{Path, PathBuf};

use super::recipes::{recipe_for, DesktopEntry};

pub const SLICE: &str = "psyche-vscreen.slice";

/// The owner's session bus, as far as the guard needs it.
pub trait SessionBus: Send + Sync {
    /// The pid of the process that owns `name`: `Ok(None)` when nobody does, `Err` when the bus
    /// could not be asked (the guard then refuses).
    fn name_owner_pid(&self, name: &str) -> Result<Option<u32>, String>;
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
    /// `/proc/<pid>/comm` without its newline, empty when the process is gone.
    fn comm(&self, _pid: u32) -> String {
        String::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The app is open on the owner's screen (the pid is not shown to the model).
    AlreadyOpenOnYourScreen,
    /// The owner's session bus could not be asked, so whether the app runs there is unknown.
    CannotCheck,
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

/// Programs that only run another program or hold a process open. Matching on their executable
/// would refuse a launch because some unrelated `env` or `sleep` runs on the owner's screen.
const WRAPPERS: &[&str] = &[
    "env",
    "nohup",
    "setsid",
    "nice",
    "ionice",
    "exec",
    "sh",
    "bash",
    "dash",
    "zsh",
    "fish",
    "flatpak",
    "snap",
    "sleep",
    "timeout",
    "xvfb-run",
    "dbus-run-session",
    "dbus-launch",
    "gtk-launch",
    "gio",
    "xdg-open",
    "python",
    "python3",
    "perl",
    "ruby",
    "node",
    "systemd-run",
];

/// The real program an `Exec=` line starts: the word after `env`'s options and `VAR=value`
/// settings (and the same for `nohup`, `setsid`, `nice`, `exec`). `None` when the line starts a
/// generic wrapper that cannot be seen through (`sh -c`, `flatpak run`, `sleep`, ...): the
/// executable check is then skipped and the D-Bus name check stands alone.
pub fn real_program(exec: &[String]) -> Option<String> {
    let mut words = exec.iter().map(String::as_str).peekable();
    loop {
        let first = words.next()?;
        let name = first.rsplit('/').next().unwrap_or(first);
        if !WRAPPERS.contains(&name) {
            return Some(first.to_string());
        }
        if !matches!(name, "env" | "nohup" | "setsid" | "nice" | "exec") {
            return None;
        }
        // Skip this wrapper's own options and VAR=value words.
        while let Some(w) = words.peek() {
            if w.starts_with('-') || (w.contains('=') && !w.starts_with('/')) {
                words.next();
            } else {
                break;
            }
        }
    }
}

/// Resolves the real program of the entry against `PATH` to a canonical file.
pub fn resolve_exe(entry: &DesktopEntry, path_var: &str) -> Option<PathBuf> {
    let first = match entry.try_exec.as_deref() {
        Some(t) if real_program(&entry.exec).as_deref() == Some(entry.exec[0].as_str()) => {
            t.to_string()
        }
        _ => real_program(&entry.exec)?,
    };
    let candidate = if first.contains('/') {
        PathBuf::from(&first)
    } else {
        path_var
            .split(':')
            .filter(|d| !d.is_empty())
            .map(|d| Path::new(d).join(&first))
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
        match bus.name_owner_pid(&name) {
            Ok(Some(pid)) if !procs.in_vscreen_slice(pid) => {
                return Err(Refusal::AlreadyOpenOnYourScreen)
            }
            Ok(_) => {}
            Err(e) => {
                crate::log(&format!("vscreen: guard: {e}"));
                return Err(Refusal::CannotCheck);
            }
        }
    }
    let recipe = recipe_for(&entry.id);
    if recipe.is_some_and(|r| !r.refuse_while_open) {
        // The recipe gives this launch its own instance (`recipes.rs`).
        return Ok(());
    }
    let names: &[&str] = recipe.map(|r| r.process_names).unwrap_or(&[]);
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

/// `busctl --user call org.freedesktop.DBus ... NameHasOwner`, then
/// `GetConnectionUnixProcessID`. Any failure is an error, never "nobody owns it".
pub struct BusctlBus;

fn busctl_dbus(method: &str, name: &str) -> Result<String, String> {
    let out = std::process::Command::new("busctl")
        .args([
            "--user",
            "call",
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            method,
            "s",
            name,
        ])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("busctl: {e}"))?;
    if !out.status.success() {
        return Err(format!("busctl {method}: {}", out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

impl SessionBus for BusctlBus {
    fn name_owner_pid(&self, name: &str) -> Result<Option<u32>, String> {
        let has = busctl_dbus("NameHasOwner", name)?;
        match parse_busctl_bool(&has) {
            Some(false) => Ok(None),
            Some(true) => {
                let pid = busctl_dbus("GetConnectionUnixProcessID", name)?;
                parse_busctl_u32(&pid)
                    .map(Some)
                    .ok_or_else(|| format!("busctl: unexpected answer {pid:?}"))
            }
            None => Err(format!("busctl: unexpected answer {has:?}")),
        }
    }
}

/// `u 1234` -> 1234.
pub fn parse_busctl_u32(text: &str) -> Option<u32> {
    let mut parts = text.split_whitespace();
    (parts.next()? == "u").then_some(())?;
    let n = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some(n)
}

/// `b true` -> true.
pub fn parse_busctl_bool(text: &str) -> Option<bool> {
    match text.split_whitespace().collect::<Vec<_>>().as_slice() {
        ["b", "true"] => Some(true),
        ["b", "false"] => Some(false),
        _ => None,
    }
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
                if let (Some(want), Ok(have)) =
                    (exe, std::fs::read_link(format!("/proc/{pid}/exe")))
                {
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

    fn comm(&self, pid: u32) -> String {
        std::fs::read_to_string(format!("/proc/{pid}/comm"))
            .map(|c| c.trim_end().to_string())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    struct FakeBus(HashMap<String, u32>);
    impl SessionBus for FakeBus {
        fn name_owner_pid(&self, name: &str) -> Result<Option<u32>, String> {
            Ok(self.0.get(name).copied())
        }
    }

    /// A bus that cannot be asked: busctl missing, no session bus, an odd answer.
    struct DownBus;
    impl SessionBus for DownBus {
        fn name_owner_pid(&self, _: &str) -> Result<Option<u32>, String> {
            Err("busctl: not found".into())
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
        FakeProcs {
            running: vec![],
            ours: HashSet::new(),
        }
    }

    #[test]
    fn an_owned_bus_name_outside_the_slice_refuses() {
        let bus = FakeBus(HashMap::from([("org.gnome.TextEditor".into(), 100)]));
        let r = check_before_launch(
            &entry("org.gnome.TextEditor", "gnome-text-editor"),
            None,
            &bus,
            &nothing(),
        );
        assert_eq!(r, Err(Refusal::AlreadyOpenOnYourScreen));
    }

    #[test]
    fn an_owned_bus_name_inside_the_slice_is_ours_and_allowed() {
        let bus = FakeBus(HashMap::from([("org.gnome.TextEditor".into(), 100)]));
        let procs = FakeProcs {
            running: vec![],
            ours: HashSet::from([100]),
        };
        assert!(check_before_launch(
            &entry("org.gnome.TextEditor", "gnome-text-editor"),
            None,
            &bus,
            &procs
        )
        .is_ok());
    }

    #[test]
    fn a_process_with_the_same_executable_outside_the_slice_refuses() {
        let exe = PathBuf::from("/usr/bin/gnome-text-editor");
        let procs = FakeProcs {
            running: vec![(7, Some(exe.clone()), "gnome-text-edit".into())],
            ours: HashSet::new(),
        };
        let r = check_before_launch(
            &entry("gnome-text-editor", "gnome-text-editor"),
            Some(&exe),
            &FakeBus(HashMap::new()),
            &procs,
        );
        assert_eq!(r, Err(Refusal::AlreadyOpenOnYourScreen));
        let procs = FakeProcs {
            running: vec![(7, Some(exe.clone()), "x".into())],
            ours: HashSet::from([7]),
        };
        assert!(check_before_launch(
            &entry("gnome-text-editor", "gnome-text-editor"),
            Some(&exe),
            &FakeBus(HashMap::new()),
            &procs
        )
        .is_ok());
    }

    #[test]
    fn firefox_is_found_by_process_name_even_when_the_launcher_is_a_script() {
        let procs = FakeProcs {
            running: vec![(9, None, "firefox-bin".into())],
            ours: HashSet::new(),
        };
        let r = check_before_launch(
            &entry("firefox", "firefox"),
            Some(Path::new("/usr/bin/firefox")),
            &FakeBus(HashMap::new()),
            &procs,
        );
        assert_eq!(r, Err(Refusal::AlreadyOpenOnYourScreen));
    }

    #[test]
    fn nothing_running_means_go() {
        assert!(check_before_launch(
            &entry("firefox", "firefox"),
            None,
            &FakeBus(HashMap::new()),
            &nothing()
        )
        .is_ok());
    }

    #[test]
    fn only_reverse_dns_ids_are_bus_names() {
        assert_eq!(
            bus_names(&entry("org.gnome.Calculator", "gnome-calculator")),
            vec!["org.gnome.Calculator"]
        );
        assert!(bus_names(&entry("firefox", "firefox")).is_empty());
    }

    #[test]
    fn a_bus_that_cannot_be_asked_refuses_instead_of_letting_it_through() {
        let r = check_before_launch(
            &entry("org.gnome.TextEditor", "gnome-text-editor"),
            None,
            &DownBus,
            &nothing(),
        );
        assert_eq!(r, Err(Refusal::CannotCheck));
        // An app with no bus name never asks the bus, so a down bus does not block it.
        assert!(check_before_launch(&entry("xterm", "xterm"), None, &DownBus, &nothing()).is_ok());
    }

    #[test]
    fn refuse_while_open_decides_whether_a_running_copy_blocks_the_launch() {
        // (desktop id, comm of a copy running on the owner's screen, refused?)
        let table: &[(&str, &str, bool)] = &[
            // Separate instance by recipe: allowed next to the owner's copy.
            ("chromium", "chromium", false),
            ("google-chrome", "chrome", false),
            ("code", "code", false),
            ("libreoffice-writer", "soffice.bin", false),
            // No separate-instance promise: refused.
            ("firefox", "firefox", true),
            ("firefox-esr", "firefox-esr", true),
            ("slack", "slack", true),
            ("obsidian", "obsidian", true),
        ];
        for (id, comm, refused) in table {
            let procs = FakeProcs {
                running: vec![(11, None, comm.to_string())],
                ours: HashSet::new(),
            };
            let r = check_before_launch(
                &entry(id, id),
                Some(Path::new("/usr/bin/x")),
                &FakeBus(HashMap::new()),
                &procs,
            );
            assert_eq!(r.is_err(), *refused, "{id} with {comm} running");
        }
        // An app without a recipe is refused when its executable runs outside the slice.
        let exe = PathBuf::from("/usr/bin/gedit");
        let procs = FakeProcs {
            running: vec![(12, Some(exe.clone()), "gedit".into())],
            ours: HashSet::new(),
        };
        assert!(check_before_launch(
            &entry("gedit", "gedit"),
            Some(&exe),
            &FakeBus(HashMap::new()),
            &procs
        )
        .is_err());
    }

    #[test]
    fn busctl_output_and_cgroups_are_parsed() {
        assert_eq!(parse_busctl_u32("u 4242\n"), Some(4242));
        assert_eq!(parse_busctl_u32("s \"x\""), None);
        assert_eq!(parse_busctl_u32(""), None);
        assert_eq!(parse_busctl_u32("u 1 2"), None);
        assert_eq!(parse_busctl_bool("b true\n"), Some(true));
        assert_eq!(parse_busctl_bool("b false\n"), Some(false));
        assert_eq!(parse_busctl_bool("b maybe"), None);
        assert_eq!(parse_busctl_bool(""), None);
        assert!(cgroup_in_slice("0::/user.slice/user-1000.slice/user@1000.service/psyche-vscreen.slice/psyche-vs-a-1.scope\n"));
        assert!(!cgroup_in_slice(
            "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-x.scope\n"
        ));
    }

    #[test]
    fn the_executable_is_resolved_through_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("myapp");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        let found = resolve_exe(
            &entry("myapp", "myapp"),
            &format!("/nonexistent:{}", dir.path().display()),
        );
        assert_eq!(found, Some(std::fs::canonicalize(&bin).unwrap()));
        assert_eq!(resolve_exe(&entry("nope", "nope"), "/nonexistent"), None);
    }

    #[test]
    fn wrappers_are_seen_through_or_skipped() {
        let w = |s: &str| super::super::recipes::split_exec(s);
        assert_eq!(
            real_program(&w("/usr/bin/app --x")).as_deref(),
            Some("/usr/bin/app")
        );
        assert_eq!(
            real_program(&w("env FOO=1 BAR=2 /opt/app/app --new")).as_deref(),
            Some("/opt/app/app")
        );
        assert_eq!(
            real_program(&w("env -i HOME=/h myapp")).as_deref(),
            Some("myapp")
        );
        assert_eq!(
            real_program(&w("/usr/bin/env nohup setsid myapp")).as_deref(),
            Some("myapp")
        );
        for opaque in [
            "sh -c 'app --x'",
            "bash -lc app",
            "flatpak run org.x.App",
            "sleep 30",
            "snap run firefox",
            "python3 /opt/x.py",
            "env",
        ] {
            assert_eq!(real_program(&w(opaque)), None, "{opaque}");
        }
    }

    #[test]
    fn a_generic_wrapper_never_matches_unrelated_processes() {
        // Some other `sleep` runs on the owner's screen; an app whose Exec is `sleep` must not be
        // refused for it. Without a recipe or a bus name there is nothing left to match.
        let e = entry("psyche.test.Sleeper", "sleep");
        assert_eq!(resolve_exe(&e, "/usr/bin:/bin"), None);
        let procs = FakeProcs {
            running: vec![(5, Some(PathBuf::from("/usr/bin/sleep")), "sleep".into())],
            ours: HashSet::new(),
        };
        assert!(check_before_launch(&e, None, &FakeBus(HashMap::new()), &procs).is_ok());
        // The bus name still protects a GApplication behind a wrapper.
        let e = entry("org.gnome.TextEditor", "flatpak");
        let bus = FakeBus(HashMap::from([("org.gnome.TextEditor".into(), 100)]));
        assert_eq!(
            check_before_launch(&e, None, &bus, &procs),
            Err(Refusal::AlreadyOpenOnYourScreen)
        );
    }

    #[test]
    fn env_in_front_of_an_app_resolves_to_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("realapp");
        std::fs::write(
            &bin,
            "#!/bin/sh
",
        )
        .unwrap();
        let mut e = entry("realapp", "env");
        e.exec = vec!["env".into(), "FOO=1".into(), "realapp".into()];
        assert_eq!(
            resolve_exe(&e, &format!("{}", dir.path().display())),
            Some(std::fs::canonicalize(&bin).unwrap())
        );
    }
}
