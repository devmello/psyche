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
//! - `dbus-daemon` listens on `<that dir>/bus`, in its own scope in the slice, with the apps'
//!   environment and its own minimal config (`bus_config`): a session bus with **no service
//!   directories**, so nothing on it can be activated. Apps cannot start a second keyring daemon on
//!   the owner's keyrings, online accounts, evolution-data-server, dconf-service (which would
//!   write the owner's settings), gvfs or the document portal (FUSE mounts onto the owner's
//!   files) here.
//! - Accessibility still works: the helper starts `at-spi-bus-launcher` itself on the private
//!   bus (best effort), so the AT-SPI tree of these apps is on a private a11y bus.
//! - The bus is used only once its socket answers from the daemon we started (`SO_PEERCRED`).
//! - Teardown removes the session dir with `rmtree::remove_tree`, which never follows a symlink
//!   or descends into another device.
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

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The private bus's whole configuration: a session-type bus on the session dir's socket, local
/// EXTERNAL auth, the stock session policy, and no `<servicedir>`, `<standard_session_servicedirs/>`
/// or `<include>`: nothing can be activated on it.
pub fn bus_config(session_dir: &Path) -> String {
    let listen = xml_escape(&bus_address(session_dir));
    format!(
        r#"<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>{listen}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
"#
    )
}

pub fn bus_config_path(session_dir: &Path) -> PathBuf {
    session_dir.join("bus.conf")
}

/// Writes `bus.conf` into the (new, private) session dir, 0600, never over an existing file.
pub fn write_bus_config(session_dir: &Path) -> std::io::Result<PathBuf> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = bus_config_path(session_dir);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    f.write_all(bus_config(session_dir).as_bytes())?;
    Ok(path)
}

pub fn dbus_daemon_argv(session_dir: &Path) -> Vec<String> {
    vec![
        "dbus-daemon".into(),
        format!("--config-file={}", bus_config_path(session_dir).display()),
        "--nofork".into(),
        "--nopidfile".into(),
    ]
}

/// Where distributions install `at-spi-bus-launcher`.
pub const A11Y_LAUNCHERS: &[&str] = &[
    "/usr/libexec/at-spi-bus-launcher",
    "/usr/lib/at-spi2-core/at-spi-bus-launcher",
    "/usr/lib/at-spi-bus-launcher",
    "/usr/lib/x86_64-linux-gnu/at-spi2-core/at-spi-bus-launcher",
    "/usr/lib/aarch64-linux-gnu/at-spi2-core/at-spi-bus-launcher",
    "/usr/lib64/at-spi-bus-launcher",
];

/// `at-spi-bus-launcher` for the private bus, when one is installed. It owns `org.a11y.Bus`
/// there and runs its own accessibility bus with at-spi's own config.
pub fn a11y_launcher_argv() -> Option<Vec<String>> {
    A11Y_LAUNCHERS
        .iter()
        .find(|p| Path::new(p).is_file())
        .map(|p| vec![p.to_string(), "--launch-immediately".into()])
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
    fn the_daemon_runs_on_its_own_config_only() {
        let argv = dbus_daemon_argv(Path::new("/run/user/1000/psyche/vs-1"));
        assert_eq!(
            argv,
            [
                "dbus-daemon",
                "--config-file=/run/user/1000/psyche/vs-1/bus.conf",
                "--nofork",
                "--nopidfile"
            ]
        );
        // Never the stock session config, which activates the owner's services.
        assert!(!argv
            .iter()
            .any(|a| a == "--session" || a.starts_with("--address")));
    }

    #[test]
    fn the_bus_config_activates_nothing() {
        let conf = bus_config(Path::new("/run/user/1000/psyche/vs-1"));
        for banned in [
            "servicedir",
            "standard_session_servicedirs",
            "standard_system_servicedirs",
            "<include",
            "includedir",
            "servicehelper",
            "tcp:",
        ] {
            assert!(!conf.contains(banned), "{banned} in\n{conf}");
        }
        assert!(conf.contains("<type>session</type>"));
        assert!(conf.contains("<listen>unix:path=/run/user/1000/psyche/vs-1/bus</listen>"));
        assert!(conf.contains("<auth>EXTERNAL</auth>"));
        assert_eq!(conf.matches("<listen>").count(), 1);
        // A path with XML in it cannot add elements.
        let odd = bus_config(Path::new("/tmp/a<servicedir>b&c"));
        assert!(!odd.contains("<servicedir>"));
        assert!(odd.contains("a&lt;servicedir&gt;b&amp;c"));
    }

    #[test]
    fn the_config_file_is_private_and_never_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let base = tempfile::tempdir().unwrap();
        let dir = make_session_dir(base.path()).unwrap();
        let path = write_bus_config(&dir).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), bus_config(&dir));
        assert!(write_bus_config(&dir).is_err());
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
