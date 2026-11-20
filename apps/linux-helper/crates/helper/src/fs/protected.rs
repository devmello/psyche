//! Protected paths (design §5.1, §5.2): what the contained shell hides and what `fs.*` always
//! refuses, whatever the ceiling's roots say.
//!
//! - [`HOME_HIDDEN`]: secrets and the helper's own files: keys, keyrings, browser and mail
//!   profiles (snap and Flatpak ones too), display cookies, cloud and forge credentials. The
//!   contained shell mounts an empty tmpfs (or `/dev/null`) over each one that exists, and
//!   `fs.*` refuses them.
//! - [`HOME_PERSIST`]: places where a write runs code later (shell and session start-up files,
//!   git, editor and window manager configs, launchers, user units, Python's user
//!   site-packages, the user's own `bin`). `fs.*` refuses them, and a read-write folder of the
//!   contained shell may not hold any of them, so a command cannot plant persistence.
//! - [`ABSOLUTE`]: system places `fs.*` never touches.

use std::path::{Component, Path, PathBuf};

pub const HOME_HIDDEN: &[&str] = &[
    // Keys, keyrings and password stores.
    ".ssh",
    ".gnupg",
    ".local/share/keyrings",
    ".local/share/kwalletd",
    ".password-store",
    // Browser and mail profiles: cookies and saved logins. Snap and Flatpak keep each app's
    // own home below `~/snap/<app>` and `~/.var/app/<id>` (Ubuntu's default Firefox is a snap).
    ".mozilla",
    ".thunderbird",
    ".librewolf",
    ".waterfox",
    "snap",
    ".var/app",
    ".config/chromium",
    ".config/google-chrome",
    ".config/google-chrome-beta",
    ".config/google-chrome-unstable",
    ".config/BraveSoftware",
    ".config/microsoft-edge",
    ".config/microsoft-edge-beta",
    ".config/vivaldi",
    ".config/opera",
    // Display and session cookies: with one, a command drives the owner's own desktop.
    ".Xauthority",
    ".ICEauthority",
    // Cloud, cluster, registry and forge credentials.
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
    ".docker",
    ".netrc",
    ".git-credentials",
    ".config/git/credentials",
    ".config/gh",
    ".config/hub",
    ".pgpass",
    ".my.cnf",
    ".pypirc",
    ".vault-token",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".terraform.d/credentials.tfrc.json",
    ".config/rclone",
    ".config/op",
    // The helper's own files and the user's service manager.
    ".config/psyche-helper",
    ".local/state/psyche-helper",
    ".config/systemd",
    ".config/autostart",
];

pub const HOME_PERSIST: &[&str] = &[
    // Shell start-up files.
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_logout",
    ".bash_aliases",
    ".profile",
    ".zshrc",
    ".zprofile",
    ".zshenv",
    ".zlogin",
    ".zlogout",
    ".inputrc",
    ".config/fish",
    ".pam_environment",
    ".config/environment.d",
    // X and desktop session start-up, window manager configs that run programs.
    ".xprofile",
    ".xsession",
    ".xsessionrc",
    ".xinitrc",
    ".config/plasma-workspace",
    ".config/autostart-scripts",
    ".config/i3",
    ".config/sway",
    ".config/hypr",
    ".config/openbox",
    ".config/lxsession",
    ".config/labwc",
    // Programs that run hooks from their user config.
    ".gitconfig",
    ".config/git",
    ".tmux.conf",
    ".config/tmux",
    ".screenrc",
    ".vimrc",
    ".vim",
    ".config/nvim",
    ".emacs",
    ".emacs.d",
    ".config/emacs",
    ".cargo/config",
    ".cargo/config.toml",
    ".npmrc",
    // Launchers (`Exec=`), user units, and code on the user's own paths: `~/.local/lib` holds
    // pip's user site-packages, where a `.pth` file runs on every Python start.
    ".local/share/applications",
    ".local/share/systemd",
    ".local/lib",
    ".local/bin",
    ".cargo/bin",
    ".rustup",
    "bin",
];

pub const ABSOLUTE: &[&str] = &[
    "/etc/psyche-helper",
    "/proc",
    "/sys",
    "/dev",
    "/boot",
    "/root",
    "/run",
];

/// `path` with `.` dropped; `None` for a relative path, a `..`, a NUL or an empty one.
pub fn lexical(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') || !path.starts_with('/') {
        return None;
    }
    let mut out = PathBuf::from("/");
    for part in Path::new(path).components() {
        match part {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(p) => out.push(p),
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

/// The home folder as written and as it resolves (both spellings are judged).
fn homes(home: &Path) -> Vec<PathBuf> {
    let mut out = vec![home.to_path_buf()];
    if let Ok(real) = std::fs::canonicalize(home) {
        if real != home {
            out.push(real);
        }
    }
    out
}

/// Every protected path for this home, home-relative entries under both spellings of home.
pub fn protected_paths(home: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = ABSOLUTE.iter().map(PathBuf::from).collect();
    for h in homes(home) {
        for rel in HOME_HIDDEN.iter().chain(HOME_PERSIST) {
            out.push(h.join(rel));
        }
    }
    out
}

/// The hidden secrets only, for the contained shell's mounts.
pub fn hidden_paths(home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for h in homes(home) {
        for rel in HOME_HIDDEN {
            out.push(h.join(rel));
        }
    }
    out
}

/// Whether `path` is a protected path or inside one.
pub fn is_protected(path: &Path, home: &Path) -> bool {
    protected_paths(home).iter().any(|p| path.starts_with(p))
}

/// Whether a protected path lies inside `path` (or is it): removing or writing all of `path`
/// would reach it.
pub fn holds_protected(path: &Path, home: &Path) -> bool {
    protected_paths(home).iter().any(|p| p.starts_with(path))
        || homes(home).iter().any(|h| h.starts_with(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_paths_refuse_relative_dotdot_and_nul() {
        // (input, accepted)
        let table: [(&str, Option<&str>); 9] = [
            ("/home/dev/a", Some("/home/dev/a")),
            ("/home/dev/./a/", Some("/home/dev/a")),
            ("/", Some("/")),
            ("home/dev", None),
            ("", None),
            ("~/a", None),
            ("/home/dev/../root", None),
            ("/home/dev/a\0b", None),
            ("/a/..", None),
        ];
        for (input, want) in table {
            assert_eq!(lexical(input), want.map(PathBuf::from), "{input:?}");
        }
    }

    #[test]
    fn protected_paths_must_refuse_and_ordinary_paths_must_not() {
        let home = Path::new("/home/dev");
        let must_refuse = [
            "/home/dev/.ssh",
            "/home/dev/.ssh/id_ed25519",
            "/home/dev/.gnupg/private-keys-v1.d/x",
            "/home/dev/.local/share/keyrings/login.keyring",
            "/home/dev/.password-store/bank.gpg",
            "/home/dev/.mozilla/firefox/profiles.ini",
            "/home/dev/.config/chromium/Default/Cookies",
            "/home/dev/.config/google-chrome/Default",
            "/home/dev/.config/BraveSoftware/Brave-Browser",
            "/home/dev/.config/psyche-helper/policy.json",
            "/home/dev/.local/state/psyche-helper/remote-identity.json",
            "/home/dev/.config/systemd/user/x.service",
            "/home/dev/.config/autostart/x.desktop",
            "/home/dev/.bashrc",
            "/home/dev/.bash_profile",
            "/home/dev/.profile",
            "/home/dev/.zshrc",
            "/home/dev/.local/bin/ls",
            "/home/dev/bin/git",
            "/etc/psyche-helper/policy.json",
            "/proc/self/environ",
            "/sys/kernel",
            "/dev/sda",
            "/boot/vmlinuz",
            "/root/.bashrc",
            "/run/user/1000/bus",
            // Review r1 of #1512, finding 2: browser profiles under snap and Flatpak, display
            // cookies, credentials.
            "/home/dev/snap/firefox/common/.mozilla/firefox/x.default/cookies.sqlite",
            "/home/dev/snap/chromium/common/chromium/Default/Login Data",
            "/home/dev/.var/app/org.mozilla.firefox/.mozilla/firefox",
            "/home/dev/.var/app/com.google.Chrome/config/google-chrome",
            "/home/dev/.config/microsoft-edge/Default/Cookies",
            "/home/dev/.config/vivaldi/Default",
            "/home/dev/.thunderbird/x.default/logins.json",
            "/home/dev/.Xauthority",
            "/home/dev/.ICEauthority",
            "/home/dev/.aws/credentials",
            "/home/dev/.config/gcloud/credentials.db",
            "/home/dev/.kube/config",
            "/home/dev/.docker/config.json",
            "/home/dev/.docker/run/docker.sock",
            "/home/dev/.netrc",
            "/home/dev/.git-credentials",
            "/home/dev/.config/gh/hosts.yml",
            "/home/dev/.pgpass",
            "/home/dev/.local/share/kwalletd/kdewallet.kwl",
            "/home/dev/.cargo/credentials.toml",
            // Finding 8: places a write runs code later.
            "/home/dev/.bash_aliases",
            "/home/dev/.gitconfig",
            "/home/dev/.config/git/config",
            "/home/dev/.local/share/applications/firefox.desktop",
            "/home/dev/.local/lib/python3.12/site-packages/zz.pth",
            "/home/dev/.config/plasma-workspace/env/x.sh",
            "/home/dev/.xsession",
            "/home/dev/.config/i3/config",
            "/home/dev/.config/sway/config",
            "/home/dev/.config/nvim/init.lua",
            "/home/dev/.vimrc",
            "/home/dev/.tmux.conf",
            "/home/dev/.cargo/config.toml",
            "/home/dev/.cargo/bin/cargo",
            "/home/dev/.npmrc",
        ];
        for p in must_refuse {
            assert!(is_protected(Path::new(p), home), "{p} must be refused");
        }
        let must_allow = [
            "/home/dev/projects/app/src/main.rs",
            "/home/dev/.sshx",
            "/home/dev/.bashrc.bak",
            "/home/dev/.config/Code/User/settings.json",
            "/home/dev/.local/share/recently-used.xbel",
            "/home/dev/binaries/tool",
            "/home/dev/Documents/.profile-notes",
            "/etc/hosts",
            "/srv/data",
            "/home/devx/.ssh",
            "/devices",
            "/runner/x",
            "/home/dev/snapshots/a",
            "/home/dev/.variables",
            "/home/dev/.var/cache",
            "/home/dev/.dockerignore",
            "/home/dev/.gitconfig.d-notes/x",
            "/home/dev/.cargo/registry/index",
            "/home/dev/.local/share/fonts/x.ttf",
            "/home/dev/.local/libexec-notes",
            "/home/dev/projects/app/.gitconfig-sample",
        ];
        for p in must_allow {
            assert!(!is_protected(Path::new(p), home), "{p} must be allowed");
        }
    }

    #[test]
    fn a_folder_that_holds_a_protected_path_or_home_is_known() {
        let home = Path::new("/home/dev");
        for p in [
            "/home/dev",
            "/home",
            "/",
            "/home/dev/.config",
            "/home/dev/.local",
        ] {
            assert!(holds_protected(Path::new(p), home), "{p}");
        }
        for p in [
            "/home/dev/projects",
            "/home/dev/.config/Code",
            "/srv/data",
            "/home/dev/.local/share/fonts",
        ] {
            assert!(!holds_protected(Path::new(p), home), "{p}");
        }
    }
}
