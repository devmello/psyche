//! The virtual screen's own session: a private runtime directory and a private D-Bus session bus
//! (and with it a private AT-SPI bus) for the apps in `psyche-vscreen.slice`.
//!
//! **Why.** On the owner's session bus an app opened here would own its well-known name
//! (`org.gnome.TextEditor`, any GApplication or DBusActivatable app). When the owner later
//! clicked that app in the dock, or used "Open with", GNOME would activate the hidden instance
//! and the owner's document would open on the invisible screen, readable through frames.
//! Notifications, portal file choosers and `gio open` handlers would also cross to the real
//! screen. So nothing here sees the owner's bus.
//!
//! **What runs.** Per display session:
//! - `$XDG_RUNTIME_DIR/psyche/vs-<random>/`, mode 0700, becomes the apps' `XDG_RUNTIME_DIR`. The
//!   conventional paths of the owner's bus, keyring, SSH agent, Wayland, PipeWire and AT-SPI
//!   sockets under the real runtime dir are out of their sight.
//! - `dbus-daemon --session` listens on `<that dir>/bus`, in its own scope in the slice, with the
//!   apps' environment. Services it activates (`at-spi-bus-launcher`, notification daemons,
//!   portals) start there too, so they show on the virtual screen and the AT-SPI tree of these
//!   apps is on that private bus, not the owner's.
//! - The bus is used only once its socket answers from the daemon we started (`SO_PEERCRED`).
//!
//! **Without `dbus-daemon`** (dbus-broker-only systems), apps get an address that leads nowhere,
//! never the owner's, and apps that need a session bus to run at all (GApplication and
//! DBusActivatable ids) are refused with `needs_private_bus`.
//!
//! **What remains shared**, because it is the same user account:
//! - files: the home directory, dconf's database (a dconf service activated here writes the same
//!   `~/.config/dconf/user`), keyring files on disk;
//! - the owner's systemd user manager, which the helper uses to create scopes;
//! - anything an app finds by other means than the conventional variables and paths.
//!
//! None of this is a boundary against a hostile process of the same uid. It stops the
//! accidental crossings: windows, activations and notifications going to the wrong screen.

use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{Duration, Instant};

use super::guard::bus_names;
use super::recipes::DesktopEntry;
use super::spawn::check_peer;

/// Makes `<base>/psyche/vs-<12 hex>`, mode 0700, new (never an existing directory).
pub fn make_session_dir(psyche_runtime_dir: &Path) -> std::io::Result<PathBuf> {
    let mut tag = [0u8; 6];
    getrandom::fill(&mut tag).map_err(|e| std::io::Error::other(e.to_string()))?;
    let hex: String = tag.iter().map(|b| format!("{b:02x}")).collect();
    let dir = psyche_runtime_dir.join(format!("vs-{hex}"));
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    Ok(dir)
}

pub fn bus_socket(session_dir: &Path) -> PathBuf {
    session_dir.join("bus")
}

pub fn bus_address(session_dir: &Path) -> String {
    format!("unix:path={}", bus_socket(session_dir).display())
}

/// Where apps are pointed when there is no private bus: a path nobody listens on. Never unset,
/// because a toolkit with no address falls back to `$XDG_RUNTIME_DIR/bus`.
pub fn no_bus_address(session_dir: &Path) -> String {
    format!("unix:path={}", session_dir.join("no-bus").display())
}

pub fn dbus_daemon_argv(session_dir: &Path) -> Vec<String> {
    vec![
        "dbus-daemon".into(),
        "--session".into(),
        "--nofork".into(),
        "--nopidfile".into(),
        format!("--address={}", bus_address(session_dir)),
    ]
}

/// Whether the app needs a session bus to start at all: a GApplication (its id is a bus name) or
/// a DBusActivatable entry.
pub fn needs_session_bus(entry: &DesktopEntry) -> bool {
    entry.dbus_activatable
        || !bus_names(entry).is_empty()
        || entry.exec.iter().any(|w| w == "--gapplication-service")
}

/// Waits until the daemon `child` answers on the session's bus socket.
pub fn wait_for_bus(
    session_dir: &Path,
    child: &mut Child,
    timeout: Duration,
) -> Result<(), String> {
    let socket = bus_socket(session_dir);
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("dbus-daemon exited ({status})"));
        }
        if let Ok(stream) = UnixStream::connect(&socket) {
            return check_peer(&stream, child.id());
        }
        if Instant::now() >= deadline {
            return Err("dbus-daemon did not start listening".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn entry(id: &str, exec: &[&str], dbus: bool) -> DesktopEntry {
        DesktopEntry {
            id: id.into(),
            name: id.into(),
            exec: exec.iter().map(|s| s.to_string()).collect(),
            try_exec: None,
            terminal: false,
            dbus_activatable: dbus,
            startup_wm_class: None,
        }
    }

    #[test]
    fn the_session_dir_is_new_and_private() {
        let base = tempfile::tempdir().unwrap();
        let a = make_session_dir(base.path()).unwrap();
        let b = make_session_dir(base.path()).unwrap();
        assert_ne!(a, b);
        assert_eq!(
            std::fs::metadata(&a).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(bus_address(&a).starts_with("unix:path="));
        assert!(bus_address(&a).ends_with("/bus"));
        assert_ne!(no_bus_address(&a), bus_address(&a));
    }

    #[test]
    fn the_daemon_listens_only_in_the_session_dir() {
        let argv = dbus_daemon_argv(Path::new("/run/user/1000/psyche/vs-1"));
        assert_eq!(argv[0], "dbus-daemon");
        assert!(argv.contains(&"--session".to_string()));
        assert!(argv.contains(&"--nofork".to_string()));
        assert!(argv.contains(&"--address=unix:path=/run/user/1000/psyche/vs-1/bus".to_string()));
    }

    #[test]
    fn apps_that_cannot_run_without_a_bus_are_recognised() {
        // Must match: a GApplication id, a DBusActivatable entry, a service-mode Exec.
        assert!(needs_session_bus(&entry(
            "org.gnome.TextEditor",
            &["gnome-text-editor"],
            false
        )));
        assert!(needs_session_bus(&entry("nautilus", &["nautilus"], true)));
        assert!(needs_session_bus(&entry(
            "evince",
            &["evince", "--gapplication-service"],
            false
        )));
        // Must not: plain ids that work without a bus.
        for id in ["firefox", "code", "libreoffice-writer", "xterm"] {
            assert!(!needs_session_bus(&entry(id, &[id], false)), "{id}");
        }
    }
}
