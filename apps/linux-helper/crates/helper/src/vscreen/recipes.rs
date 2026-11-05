//! Desktop entries and the per-app launch recipes (linux-desktop design §7.2).
//!
//! An app opened on the virtual screen must not hand its window to an instance that already
//! runs on the owner's real display. Where an app supports a second, independent instance, the
//! recipe says how (a separate profile or user-data directory); where it does not, the guard
//! (`guard.rs`) refuses the launch. Every recipe lists its tradeoff, and the table has a test
//! per entry.
//!
//! This module is pure: it parses text and builds argument lists.

use std::path::{Path, PathBuf};

/// A parsed `.desktop` file, reduced to what a launch needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopEntry {
    /// The desktop file id without `.desktop` (`org.gnome.TextEditor`, `firefox`).
    pub id: String,
    pub name: String,
    /// `Exec=` split into words, with the field codes (`%U`, `%f`, ...) removed.
    pub exec: Vec<String>,
    pub try_exec: Option<String>,
    pub terminal: bool,
    pub dbus_activatable: bool,
    pub startup_wm_class: Option<String>,
}

/// Splits an `Exec=` value by the desktop-entry quoting rules and drops field codes.
pub fn split_exec(exec: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut quoted = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                in_word = true;
            }
            '\\' if quoted => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                    in_word = true;
                }
            }
            c if c.is_whitespace() && !quoted => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            c => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    if in_word {
        words.push(cur);
    }
    words
        .into_iter()
        .filter_map(|w| strip_field_codes(&w))
        .collect()
}

/// `%f %F %u %U %d %D %n %N %i %c %k %v %m` go; `%%` becomes `%`. A word that is only a code
/// disappears.
fn strip_field_codes(word: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = word.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        if let Some('%') = chars.next() {
            out.push('%');
        }
    }
    (!out.is_empty() || word.is_empty()).then_some(out)
}

/// Parses the `[Desktop Entry]` group. `None` for hidden entries and non-applications.
pub fn parse_desktop_entry(id: &str, text: &str) -> Option<DesktopEntry> {
    let mut in_group = false;
    let (mut name, mut exec, mut try_exec, mut wm_class) = (None, None, None, None);
    let (mut terminal, mut dbus, mut hidden, mut is_app) = (false, false, false, true);
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_group || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "Name" => name = Some(value.trim().to_string()),
            "Exec" => exec = Some(value.trim().to_string()),
            "TryExec" => try_exec = Some(value.trim().to_string()),
            "StartupWMClass" => wm_class = Some(value.trim().to_string()),
            "Terminal" => terminal = value.trim() == "true",
            "DBusActivatable" => dbus = value.trim() == "true",
            "Hidden" => hidden = value.trim() == "true",
            "Type" => is_app = value.trim() == "Application",
            _ => {}
        }
    }
    if hidden || !is_app {
        return None;
    }
    let exec = split_exec(&exec?);
    if exec.is_empty() {
        return None;
    }
    Some(DesktopEntry {
        id: id.trim_end_matches(".desktop").to_string(),
        name: name.unwrap_or_else(|| id.to_string()),
        exec,
        try_exec,
        terminal,
        dbus_activatable: dbus,
        startup_wm_class: wm_class,
    })
}

/// `applications` directories, owner's data home first.
pub fn application_dirs(
    home: &Path,
    xdg_data_home: Option<&str>,
    xdg_data_dirs: Option<&str>,
) -> Vec<PathBuf> {
    let data_home = xdg_data_home
        .filter(|d| Path::new(d).is_absolute())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    let mut dirs = vec![data_home.join("applications")];
    let system = xdg_data_dirs
        .filter(|d| !d.is_empty())
        .unwrap_or("/usr/local/share:/usr/share");
    for d in system.split(':').filter(|d| Path::new(d).is_absolute()) {
        dirs.push(Path::new(d).join("applications"));
    }
    dirs.push(home.join(".local/share/flatpak/exports/share/applications"));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    dirs.push(PathBuf::from("/var/lib/snapd/desktop/applications"));
    dirs
}

/// Finds `<id>.desktop` (a `-` for a `/` in the id, as the spec allows for subdirectories).
pub fn find_desktop_entry(id: &str, dirs: &[PathBuf]) -> Option<DesktopEntry> {
    let id = id.trim_end_matches(".desktop");
    if id.is_empty() || id.contains("..") || id.starts_with('/') {
        return None;
    }
    for dir in dirs {
        let file = dir.join(format!("{id}.desktop"));
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Some(entry) = parse_desktop_entry(id, &text) {
                return Some(entry);
            }
        }
    }
    None
}

/// How a family of apps gets its own instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Firefox,
    ChromiumFamily,
    VsCode,
    Electron,
    LibreOffice,
    /// Everything else: launched as its desktop entry says.
    Plain,
}

/// One row of the recipe table.
#[derive(Debug)]
pub struct RecipeEntry {
    pub family: Family,
    /// Desktop ids (without `.desktop`) the recipe applies to.
    pub ids: &'static [&'static str],
    /// Process names (`/proc/<pid>/comm`) of an instance that may be running on the real screen.
    pub process_names: &'static [&'static str],
    /// What the owner gives up by this recipe, in one sentence (shown nowhere automatically:
    /// the table is the record the tests and docs read).
    pub tradeoff: &'static str,
    /// The app cannot run a second instance, so a running one means refusing.
    pub refuse_while_open: bool,
}

pub const RECIPES: &[RecipeEntry] = &[
    RecipeEntry {
        family: Family::Firefox,
        ids: &["firefox", "firefox-esr", "org.mozilla.firefox", "firefox_firefox"],
        process_names: &["firefox", "firefox-bin", "firefox-esr", "MainThread"],
        tradeoff: "Runs on a copy of the owner's profile made on first use, so it has the logins from then, not later ones. A profile in use cannot be shared, so it is refused while Firefox is open.",
        refuse_while_open: true,
    },
    RecipeEntry {
        family: Family::ChromiumFamily,
        ids: &[
            "chromium",
            "chromium-browser",
            "org.chromium.Chromium",
            "google-chrome",
            "google-chrome-stable",
            "com.google.Chrome",
            "brave-browser",
            "com.brave.Browser",
            "vivaldi-stable",
            "com.vivaldi.Vivaldi",
            "microsoft-edge",
            "opera",
        ],
        process_names: &["chrome", "chromium", "brave", "vivaldi-bin", "msedge", "opera"],
        tradeoff: "Uses its own empty profile, so it has no logged-in sessions.",
        refuse_while_open: false,
    },
    RecipeEntry {
        family: Family::VsCode,
        ids: &["code", "code-insiders", "codium", "com.visualstudio.code", "com.vscodium.codium"],
        process_names: &["code", "code-insiders", "codium"],
        tradeoff: "Uses its own settings and extensions directory, so the owner's are not loaded.",
        refuse_while_open: false,
    },
    RecipeEntry {
        family: Family::Electron,
        ids: &[
            "slack",
            "com.slack.Slack",
            "discord",
            "com.discordapp.Discord",
            "signal-desktop",
            "org.signal.Signal",
            "obsidian",
            "md.obsidian.Obsidian",
        ],
        process_names: &["slack", "discord", "signal-desktop", "obsidian"],
        tradeoff: "Uses its own data directory, so it starts logged out.",
        refuse_while_open: false,
    },
    RecipeEntry {
        family: Family::LibreOffice,
        ids: &[
            "libreoffice-writer",
            "libreoffice-calc",
            "libreoffice-impress",
            "libreoffice-draw",
            "libreoffice-math",
            "libreoffice-base",
            "libreoffice-startcenter",
            "org.libreoffice.LibreOffice.writer",
            "org.libreoffice.LibreOffice.calc",
        ],
        process_names: &["soffice.bin", "oosplash", "soffice"],
        tradeoff: "Uses its own user profile, so the owner's templates and settings are not loaded.",
        refuse_while_open: false,
    },
];

pub fn recipe_for(id: &str) -> Option<&'static RecipeEntry> {
    let id = id.trim_end_matches(".desktop");
    RECIPES.iter().find(|r| r.ids.contains(&id))
}

/// Everything a launch builds its command from.
#[derive(Debug, Clone)]
pub struct LaunchContext {
    /// `$XDG_STATE_HOME/psyche-helper`.
    pub state_dir: PathBuf,
    pub display: String,
    pub xauthority: PathBuf,
    /// The Firefox profile copy, already made (the manager copies it first).
    pub firefox_profile: Option<PathBuf>,
}

/// The command and environment of one launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub argv: Vec<String>,
    pub env_set: Vec<(String, String)>,
    pub env_remove: Vec<String>,
}

const ENV_REMOVE: &[&str] = &[
    "WAYLAND_DISPLAY",
    "XDG_ACTIVATION_TOKEN",
    "DESKTOP_STARTUP_ID",
    "XDG_SESSION_TYPE",
];

/// Where a recipe keeps a separate data directory for `id`.
fn data_dir(ctx: &LaunchContext, kind: &str, id: &str) -> String {
    ctx.state_dir
        .join("vscreen")
        .join(kind)
        .join(id)
        .to_string_lossy()
        .into_owned()
}

pub fn launch_spec(entry: &DesktopEntry, ctx: &LaunchContext) -> Result<LaunchSpec, String> {
    let mut argv = entry.exec.clone();
    let recipe = recipe_for(&entry.id);
    let family = recipe.map(|r| r.family).unwrap_or(Family::Plain);
    match family {
        Family::Firefox => {
            let profile = ctx
                .firefox_profile
                .as_ref()
                .ok_or("Firefox needs its profile copy before launch")?;
            argv.push("--no-remote".into());
            argv.push("--profile".into());
            argv.push(profile.to_string_lossy().into_owned());
        }
        Family::ChromiumFamily | Family::Electron | Family::VsCode => {
            let kind = match family {
                Family::VsCode => "code",
                Family::ChromiumFamily => "chromium",
                _ => "electron",
            };
            argv.push(format!(
                "--user-data-dir={}",
                data_dir(ctx, kind, &entry.id)
            ));
            argv.push("--ozone-platform=x11".into());
        }
        Family::LibreOffice => {
            argv.push(format!(
                "-env:UserInstallation=file://{}",
                data_dir(ctx, "lo", "profile")
            ));
        }
        Family::Plain => {}
    }
    let env_set = vec![
        ("DISPLAY".to_string(), ctx.display.clone()),
        (
            "XAUTHORITY".to_string(),
            ctx.xauthority.to_string_lossy().into_owned(),
        ),
        ("GDK_BACKEND".to_string(), "x11".to_string()),
        ("QT_QPA_PLATFORM".to_string(), "xcb".to_string()),
        ("MOZ_ENABLE_WAYLAND".to_string(), "0".to_string()),
        ("SDL_VIDEODRIVER".to_string(), "x11".to_string()),
        // AT-SPI: apps on the session bus are discoverable, and toolkits expose themselves.
        ("GTK_A11Y".to_string(), "atspi".to_string()),
        (
            "QT_LINUX_ACCESSIBILITY_ALWAYS_ON".to_string(),
            "1".to_string(),
        ),
        ("ACCESSIBILITY_ENABLED".to_string(), "1".to_string()),
        ("GNOME_ACCESSIBILITY".to_string(), "1".to_string()),
    ];
    Ok(LaunchSpec {
        argv,
        env_set,
        env_remove: ENV_REMOVE.iter().map(|s| s.to_string()).collect(),
    })
}

/// Firefox profile directories to try for the owner's default profile, from `profiles.ini`.
pub fn firefox_profile_from_ini(ini: &str, base: &Path) -> Option<PathBuf> {
    let mut sections: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for line in ini.lines().map(str::trim) {
        if line.starts_with('[') && line.ends_with(']') {
            sections.push((line[1..line.len() - 1].to_string(), Vec::new()));
        } else if let (Some((k, v)), Some(last)) = (line.split_once('='), sections.last_mut()) {
            last.1.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let get = |section: &[(String, String)], key: &str| {
        section
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };
    // The install-specific default beats the profile flagged Default=1.
    let install_default = sections
        .iter()
        .filter(|(n, _)| n.starts_with("Install"))
        .find_map(|(_, kv)| get(kv, "Default"));
    let chosen = install_default.map(|p| (p, true)).or_else(|| {
        sections
            .iter()
            .filter(|(n, _)| n.starts_with("Profile"))
            .find(|(_, kv)| get(kv, "Default").as_deref() == Some("1"))
            .and_then(|(_, kv)| {
                Some((
                    get(kv, "Path")?,
                    get(kv, "IsRelative").as_deref() != Some("0"),
                ))
            })
    })?;
    let (path, relative) = chosen;
    Some(if relative && !path.starts_with('/') {
        base.join(path)
    } else {
        PathBuf::from(path)
    })
}

/// Names under a profile that must not be copied: caches, locks and the running instance's files.
pub fn firefox_skip(name: &str) -> bool {
    matches!(
        name,
        "lock"
            | ".parentlock"
            | "parent.lock"
            | "cache2"
            | "startupCache"
            | "crashes"
            | "minidumps"
            | "datareporting"
            | "saved-telemetry-pings"
            | "storage"
            | "thumbnails"
            | "sessionstore-backups"
    )
}

/// Copies a profile on first use. Does nothing when `dest` already exists. Symlinks are skipped.
pub fn copy_profile(src: &Path, dest: &Path) -> std::io::Result<()> {
    if dest.exists() {
        return Ok(());
    }
    let partial = dest.with_extension("partial");
    let _ = std::fs::remove_dir_all(&partial);
    copy_dir(src, &partial)?;
    std::fs::rename(&partial, dest)
}

fn copy_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dest)?;
    for item in std::fs::read_dir(src)? {
        let item = item?;
        let name = item.file_name();
        if firefox_skip(&name.to_string_lossy()) {
            continue;
        }
        let kind = item.file_type()?;
        if kind.is_dir() {
            copy_dir(&item.path(), &dest.join(&name))?;
        } else if kind.is_file() {
            std::fs::copy(item.path(), dest.join(&name))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> LaunchContext {
        LaunchContext {
            state_dir: PathBuf::from("/state/psyche-helper"),
            display: ":90".into(),
            xauthority: PathBuf::from("/run/user/1000/psyche/xauth-90"),
            firefox_profile: Some(PathBuf::from(
                "/state/psyche-helper/vscreen/firefox/profile",
            )),
        }
    }

    fn entry(id: &str, exec: &[&str]) -> DesktopEntry {
        DesktopEntry {
            id: id.into(),
            name: id.into(),
            exec: exec.iter().map(|s| s.to_string()).collect(),
            try_exec: None,
            terminal: false,
            dbus_activatable: false,
            startup_wm_class: None,
        }
    }

    fn has(spec: &LaunchSpec, arg: &str) -> bool {
        spec.argv.iter().any(|a| a == arg)
    }

    #[test]
    fn exec_lines_lose_their_field_codes_and_keep_their_quotes() {
        assert_eq!(split_exec("firefox %u"), vec!["firefox"]);
        assert_eq!(
            split_exec("env FOO=1 /usr/bin/app --new-window %U"),
            vec!["env", "FOO=1", "/usr/bin/app", "--new-window"]
        );
        assert_eq!(
            split_exec(r#""/opt/My App/app" --name "a b" 100%%"#),
            vec!["/opt/My App/app", "--name", "a b", "100%"]
        );
        assert_eq!(
            split_exec("gnome-text-editor --gapplication-service"),
            vec!["gnome-text-editor", "--gapplication-service"]
        );
    }

    #[test]
    fn a_desktop_file_is_read() {
        let text = "[Desktop Entry]\nType=Application\nName=Text Editor\nName[de]=Texteditor\nExec=gnome-text-editor %U\nDBusActivatable=true\nStartupWMClass=org.gnome.TextEditor\n[Desktop Action new]\nExec=other\n";
        let e = parse_desktop_entry("org.gnome.TextEditor.desktop", text).unwrap();
        assert_eq!(e.id, "org.gnome.TextEditor");
        assert_eq!(e.name, "Text Editor");
        assert_eq!(e.exec, vec!["gnome-text-editor"]);
        assert!(e.dbus_activatable);
        assert_eq!(e.startup_wm_class.as_deref(), Some("org.gnome.TextEditor"));
        assert!(parse_desktop_entry("x", "[Desktop Entry]\nType=Link\nExec=a\n").is_none());
        assert!(parse_desktop_entry("x", "[Desktop Entry]\nHidden=true\nExec=a\n").is_none());
        assert!(parse_desktop_entry("x", "[Desktop Entry]\nName=n\n").is_none());
    }

    #[test]
    fn lookup_reads_the_first_matching_directory_and_refuses_odd_ids() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("app.desktop"),
            "[Desktop Entry]\nExec=app\n",
        )
        .unwrap();
        let dirs = vec![PathBuf::from("/nonexistent"), dir.path().to_path_buf()];
        assert_eq!(find_desktop_entry("app", &dirs).unwrap().exec, vec!["app"]);
        assert!(find_desktop_entry("../app", &dirs).is_none());
        assert!(find_desktop_entry("missing", &dirs).is_none());
    }

    #[test]
    fn application_dirs_start_with_the_owners() {
        let dirs = application_dirs(Path::new("/h"), None, Some("/a:/b"));
        assert_eq!(dirs[0], PathBuf::from("/h/.local/share/applications"));
        assert_eq!(dirs[1], PathBuf::from("/a/applications"));
        assert_eq!(dirs[2], PathBuf::from("/b/applications"));
    }

    // One test per recipe entry. A new table row without its own test is caught by the last one.

    #[test]
    fn recipe_firefox_runs_without_remote_on_the_profile_copy() {
        let spec = launch_spec(&entry("firefox", &["firefox"]), &ctx()).unwrap();
        assert_eq!(
            &spec.argv[1..],
            [
                "--no-remote",
                "--profile",
                "/state/psyche-helper/vscreen/firefox/profile"
            ]
        );
        let mut c = ctx();
        c.firefox_profile = None;
        assert!(launch_spec(&entry("firefox", &["firefox"]), &c).is_err());
        assert!(recipe_for("firefox").unwrap().refuse_while_open);
    }

    #[test]
    fn recipe_chromium_family_gets_its_own_user_data_dir_and_x11() {
        for id in RECIPES[1].ids {
            let spec = launch_spec(&entry(id, &["browser"]), &ctx()).unwrap();
            assert!(
                has(
                    &spec,
                    &format!("--user-data-dir=/state/psyche-helper/vscreen/chromium/{id}")
                ),
                "{id}"
            );
            assert!(has(&spec, "--ozone-platform=x11"), "{id}");
        }
    }

    #[test]
    fn recipe_vscode_gets_its_own_user_data_dir_and_x11() {
        for id in RECIPES[2].ids {
            let spec = launch_spec(&entry(id, &["code"]), &ctx()).unwrap();
            assert!(
                has(
                    &spec,
                    &format!("--user-data-dir=/state/psyche-helper/vscreen/code/{id}")
                ),
                "{id}"
            );
            assert!(has(&spec, "--ozone-platform=x11"), "{id}");
        }
    }

    #[test]
    fn recipe_electron_apps_get_their_own_data_dir_and_x11() {
        for id in RECIPES[3].ids {
            let spec = launch_spec(&entry(id, &["app"]), &ctx()).unwrap();
            assert!(
                has(
                    &spec,
                    &format!("--user-data-dir=/state/psyche-helper/vscreen/electron/{id}")
                ),
                "{id}"
            );
            assert!(has(&spec, "--ozone-platform=x11"), "{id}");
        }
    }

    #[test]
    fn recipe_libreoffice_gets_its_own_user_installation() {
        for id in RECIPES[4].ids {
            let spec = launch_spec(&entry(id, &["libreoffice", "--writer"]), &ctx()).unwrap();
            assert!(
                has(
                    &spec,
                    "-env:UserInstallation=file:///state/psyche-helper/vscreen/lo/profile"
                ),
                "{id}"
            );
            assert!(has(&spec, "--writer"));
        }
    }

    #[test]
    fn every_table_row_is_covered_and_has_a_tradeoff() {
        // Rows 0..=4 have a test above. Adding a row means adding its test and bumping this.
        assert_eq!(RECIPES.len(), 5);
        let mut seen = std::collections::HashSet::new();
        for r in RECIPES {
            assert!(!r.tradeoff.is_empty());
            assert!(!r.process_names.is_empty());
            for id in r.ids {
                assert!(seen.insert(*id), "{id} appears twice");
            }
        }
    }

    #[test]
    fn other_apps_launch_as_their_entry_says_with_the_x11_environment() {
        let spec = launch_spec(
            &entry("org.gnome.TextEditor", &["gnome-text-editor"]),
            &ctx(),
        )
        .unwrap();
        assert_eq!(spec.argv, vec!["gnome-text-editor"]);
        let env = |k: &str| {
            spec.env_set
                .iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(env("DISPLAY"), Some(":90"));
        assert_eq!(env("GDK_BACKEND"), Some("x11"));
        assert_eq!(env("QT_QPA_PLATFORM"), Some("xcb"));
        assert_eq!(env("MOZ_ENABLE_WAYLAND"), Some("0"));
        assert_eq!(env("XAUTHORITY"), Some("/run/user/1000/psyche/xauth-90"));
        assert_eq!(env("WAYLAND_DISPLAY"), None);
        for gone in [
            "WAYLAND_DISPLAY",
            "XDG_ACTIVATION_TOKEN",
            "DESKTOP_STARTUP_ID",
        ] {
            assert!(spec.env_remove.iter().any(|v| v == gone), "{gone}");
        }
    }

    #[test]
    fn the_default_firefox_profile_comes_from_profiles_ini() {
        let ini = "[Profile0]\nName=default\nIsRelative=1\nPath=abc.default\n\n[Profile1]\nName=release\nIsRelative=1\nPath=xyz.release\nDefault=1\n\n[General]\nStartWithLastProfile=1\n";
        assert_eq!(
            firefox_profile_from_ini(ini, Path::new("/h/.mozilla/firefox")),
            Some(PathBuf::from("/h/.mozilla/firefox/xyz.release"))
        );
        let with_install =
            format!("{ini}\n[Install4F96D1932A9F858E]\nDefault=abc.default\nLocked=1\n");
        assert_eq!(
            firefox_profile_from_ini(&with_install, Path::new("/h/.mozilla/firefox")),
            Some(PathBuf::from("/h/.mozilla/firefox/abc.default"))
        );
        assert_eq!(
            firefox_profile_from_ini("[General]\n", Path::new("/x")),
            None
        );
    }

    #[test]
    fn a_profile_is_copied_once_without_locks_or_caches() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(src.join("cache2")).unwrap();
        std::fs::create_dir_all(src.join("extensions")).unwrap();
        std::fs::write(src.join("prefs.js"), "x").unwrap();
        std::fs::write(src.join("lock"), "x").unwrap();
        std::fs::write(src.join(".parentlock"), "x").unwrap();
        std::fs::write(src.join("cache2/junk"), "x").unwrap();
        std::fs::write(src.join("extensions/a.xpi"), "x").unwrap();
        let dest = dir.path().join("dest");
        copy_profile(&src, &dest).unwrap();
        assert!(dest.join("prefs.js").is_file());
        assert!(dest.join("extensions/a.xpi").is_file());
        assert!(!dest.join("lock").exists());
        assert!(!dest.join(".parentlock").exists());
        assert!(!dest.join("cache2").exists());
        // A second call does not touch the copy.
        std::fs::write(dest.join("prefs.js"), "changed").unwrap();
        copy_profile(&src, &dest).unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("prefs.js")).unwrap(),
            "changed"
        );
    }
}
