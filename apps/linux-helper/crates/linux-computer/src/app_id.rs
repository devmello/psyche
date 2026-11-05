//! The one Linux app identity: what the Mac helper calls a bundle id, and what every capability
//! of the Linux helper reports as `bundleId` / `app` (`apps.*`, `computer.*`). The Gateway matches
//! approvals and per-app tiers on it, so all of them must agree for the same window.
//!
//! **Rule.** The *desktop file id* of the app (`org.gnome.TextEditor`, `firefox`,
//! `libreoffice-writer`), without `.desktop`, compared case-insensitively. It comes from, in order:
//!
//! 1. the process's systemd scope or service in `/proc/<pid>/cgroup`
//!    (`app-gnome-org.gnome.TextEditor-4242.scope`, the XDG "systemd and desktop environments"
//!    naming), which the launcher set and the app cannot change;
//! 2. the process's executable (`/proc/<pid>/exe`) matched against the `Exec=` lines of the
//!    installed `.desktop` files;
//! 3. `GIO_LAUNCHED_DESKTOP_FILE` in the process's environment;
//! 4. the executable's file name.
//!
//! **Why more than one.** The environment is chosen by whoever launched the process, and a
//! program can carry a different name than its file. An id decides an app's cap (browsers are
//! read only, terminals click only, password managers off), so [`choose`] takes *every* candidate
//! and returns the one with the strictest fixed cap: an app cannot step out of a cap by
//! presenting a friendlier id.

use crate::tiers::fixed_caps;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// `Foo.desktop` and `foo` are the same id; ids compare lowercase.
pub fn normalize(id: &str) -> String {
    let lower = id.trim().to_lowercase();
    lower.strip_suffix(".desktop").unwrap_or(&lower).to_string()
}

/// Whether `query` looks like an app id (as opposed to a free-form display name or a path).
pub fn is_app_id(query: &str) -> bool {
    let q = query.trim();
    !q.is_empty()
        && q.len() <= 200
        && q.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && q.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'))
}

/// Undoes systemd's unit-name escaping (`\x2d` for `-`, `\x2f` for `/`, ...).
fn unescape_unit(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() && b[i + 1] == b'x' {
            if let Ok(v) = u8::from_str_radix(&s[i + 2..i + 4], 16) {
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The app id in one unit name, per the XDG naming:
/// `app[-<launcher>]-<id>[@<random>].service` and `app[-<launcher>]-<id>-<random>.scope`.
pub fn id_from_unit(unit: &str) -> Option<String> {
    let rest = unit.strip_prefix("app-")?;
    let (stem, is_scope) = if let Some(s) = rest.strip_suffix(".scope") {
        (s, true)
    } else {
        (rest.strip_suffix(".service")?, false)
    };
    let stem = if is_scope {
        // `<...>-<random>`: the random part is the last dash-separated piece.
        let cut = stem.rfind('-')?;
        &stem[..cut]
    } else {
        stem.split('@').next().unwrap_or(stem)
    };
    // `<launcher>-<id>` or `<id>`; dashes inside either are escaped as `\x2d`.
    let parts: Vec<&str> = stem.split('-').collect();
    let id = match parts.as_slice() {
        [id] => *id,
        [_launcher, id] => *id,
        _ => return None,
    };
    let id = normalize(&unescape_unit(id));
    is_app_id(&id).then_some(id)
}

/// The app id named by a `/proc/<pid>/cgroup` file: the innermost `app-*` unit on the path.
pub fn id_from_cgroup(text: &str) -> Option<String> {
    text.lines()
        .filter_map(|l| l.rsplit(':').next())
        .flat_map(|path| path.rsplit('/'))
        .find_map(id_from_unit)
}

/// `GIO_LAUNCHED_DESKTOP_FILE=/usr/share/applications/org.gnome.TextEditor.desktop`.
pub fn id_from_launched_desktop_file(value: &str) -> Option<String> {
    let name = Path::new(value.trim()).file_name()?.to_str()?;
    let name = name.strip_suffix(".desktop")?;
    let id = normalize(name);
    is_app_id(&id).then_some(id)
}

/// The executable file name as an id (`/usr/bin/Firefox` -> `firefox`).
pub fn id_from_exe_name(path: &str) -> Option<String> {
    let name = path.trim_end_matches(" (deleted)").rsplit('/').next()?;
    let id = normalize(name);
    is_app_id(&id).then_some(id)
}

/// What a `.desktop` file launches: its id and the executable of its `Exec=` line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopEntry {
    pub id: String,
    /// Absolute path or bare command of the first token of `Exec=` (after `env` and variables).
    pub exec: String,
    /// `Name=`, untranslated.
    pub name: Option<String>,
    pub no_display: bool,
    /// `StartupWMClass=`, lowercase.
    pub wm_class: Option<String>,
}

/// Parses one `.desktop` file's `[Desktop Entry]` group. `id` is the file's id.
pub fn parse_desktop(id: &str, text: &str) -> Option<DesktopEntry> {
    let mut in_main = false;
    let (mut exec, mut name, mut no_display, mut wm) = (None, None, false, None);
    let mut kind_ok = true;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_main = line == "[Desktop Entry]";
            continue;
        }
        if !in_main || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        match k.trim() {
            "Exec" => exec = exec.or(Some(v.trim().to_string())),
            "Name" => name = name.or(Some(v.trim().to_string())),
            "NoDisplay" => no_display = v.trim().eq_ignore_ascii_case("true"),
            "StartupWMClass" => wm = Some(v.trim().to_lowercase()),
            "Type" => kind_ok = v.trim() == "Application",
            _ => {}
        }
    }
    if !kind_ok {
        return None;
    }
    let exec = exec_program(&exec?)?;
    Some(DesktopEntry {
        id: normalize(id),
        exec,
        name,
        no_display,
        wm_class: wm,
    })
}

/// The program of an `Exec=` value: skips `env VAR=x`, field codes and quotes. For
/// `flatpak run ... org.app.Id` the program is the `flatpak` marker `flatpak:<app id>`.
pub fn exec_program(exec: &str) -> Option<String> {
    let mut tokens = split_exec(exec).into_iter().peekable();
    let mut first = tokens.next()?;
    if first == "env" || first.ends_with("/env") {
        while let Some(t) = tokens.peek() {
            if t.contains('=') && !t.starts_with('/') {
                tokens.next();
            } else {
                break;
            }
        }
        first = tokens.next()?;
    }
    if first == "flatpak" || first.ends_with("/flatpak") {
        let app = tokens.find(|t| !t.starts_with('-') && *t != "run" && !t.starts_with('@'));
        return app.map(|a| format!("flatpak:{}", normalize(&a)));
    }
    (!first.is_empty() && !first.starts_with('%')).then_some(first)
}

fn split_exec(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '\\' if quoted => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// The installed `.desktop` files, by executable.
#[derive(Debug, Default, Clone)]
pub struct DesktopIndex {
    pub entries: Vec<DesktopEntry>,
}

impl DesktopIndex {
    /// Reads `applications/` under each data dir (XDG_DATA_DIRS, XDG_DATA_HOME, flatpak exports).
    pub fn load(dirs: &[PathBuf]) -> DesktopIndex {
        let mut entries: Vec<DesktopEntry> = Vec::new();
        let mut seen: HashMap<String, ()> = HashMap::new();
        for dir in dirs {
            let apps = dir.join("applications");
            let Ok(rd) = std::fs::read_dir(&apps) else {
                continue;
            };
            let mut files: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            files.sort();
            for path in files {
                let Some(file) = path.file_name().and_then(|f| f.to_str()) else {
                    continue;
                };
                let Some(id) = file.strip_suffix(".desktop") else {
                    continue;
                };
                if seen.contains_key(&normalize(id)) {
                    continue; // earlier dirs win, as in the spec
                }
                // Bounded read: a desktop file is a few KiB.
                let Ok(bytes) = std::fs::read(&path) else {
                    continue;
                };
                if bytes.len() > 256 * 1024 {
                    continue;
                }
                let text = String::from_utf8_lossy(&bytes);
                if let Some(e) = parse_desktop(id, &text) {
                    seen.insert(e.id.clone(), ());
                    entries.push(e);
                }
            }
        }
        DesktopIndex { entries }
    }

    /// The default search path: `$XDG_DATA_HOME`, `$XDG_DATA_DIRS`, flatpak exports.
    pub fn default_dirs(env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
        let home = env("HOME").unwrap_or_default();
        let data_home = env("XDG_DATA_HOME").unwrap_or_else(|| format!("{home}/.local/share"));
        let data_dirs =
            env("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".into());
        let mut dirs = vec![PathBuf::from(data_home)];
        dirs.extend(
            data_dirs
                .split(':')
                .filter(|d| !d.is_empty())
                .map(PathBuf::from),
        );
        dirs.push(PathBuf::from(format!(
            "{home}/.local/share/flatpak/exports/share"
        )));
        dirs.push(PathBuf::from("/var/lib/flatpak/exports/share"));
        dirs
    }

    /// Every desktop id whose `Exec=` program is `exe` (full path or file name).
    pub fn ids_for_exe(&self, exe: &str) -> Vec<String> {
        let exe = exe.trim_end_matches(" (deleted)");
        let base = exe.rsplit('/').next().unwrap_or(exe);
        self.entries
            .iter()
            .filter(|e| {
                !e.exec.starts_with("flatpak:")
                    && (e.exec == exe || e.exec.rsplit('/').next() == Some(base))
            })
            .map(|e| e.id.clone())
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<&DesktopEntry> {
        let id = normalize(id);
        self.entries.iter().find(|e| e.id == id)
    }
}

/// Everything known about one process, gathered by the caller.
#[derive(Debug, Default, Clone)]
pub struct Evidence {
    pub cgroup: Option<String>,
    pub launched_desktop_file: Option<String>,
    pub exe: Option<String>,
    pub comm: Option<String>,
}

/// Every id the evidence supports, best first.
pub fn candidates(ev: &Evidence, index: &DesktopIndex) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |id: Option<String>| {
        if let Some(id) = id {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    };
    add(ev.cgroup.as_deref().and_then(id_from_cgroup));
    if let Some(exe) = &ev.exe {
        for id in index.ids_for_exe(exe) {
            add(Some(id));
        }
    }
    add(ev
        .launched_desktop_file
        .as_deref()
        .and_then(id_from_launched_desktop_file));
    add(ev.exe.as_deref().and_then(id_from_exe_name));
    out
}

fn strictness(id: &str) -> u8 {
    // Lower cap = stricter = sorts first.
    fixed_caps::cap(Some(id)) as u8
}

/// The id to report: the candidate with the strictest fixed cap, ties by the order of
/// [`candidates`]. A process that presents a friendly id next to a restricted one (a terminal
/// whose cgroup says `org.gnome.TextEditor`) is treated as the restricted one.
pub fn choose(cands: &[String]) -> Option<String> {
    cands
        .iter()
        .enumerate()
        .min_by_key(|(i, id)| (strictness(id), *i))
        .map(|(_, id)| id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_name_the_app() {
        assert_eq!(
            id_from_unit("app-gnome-org.gnome.TextEditor-4242.scope").as_deref(),
            Some("org.gnome.texteditor")
        );
        assert_eq!(
            id_from_unit("app-org.gnome.Nautilus@autostart.service").as_deref(),
            Some("org.gnome.nautilus")
        );
        assert_eq!(
            id_from_unit("app-firefox-123.scope").as_deref(),
            Some("firefox")
        );
        assert_eq!(
            id_from_unit("app-KDE-org.kde.konsole-777.scope").as_deref(),
            Some("org.kde.konsole")
        );
        assert_eq!(
            id_from_unit(r"app-gnome-gnome\x2dterminal-9.scope").as_deref(),
            Some("gnome-terminal")
        );
        assert_eq!(
            id_from_unit(r"app-gnome-jetbrains\x2didea-9.scope").as_deref(),
            Some("jetbrains-idea")
        );
        assert_eq!(id_from_unit("session-3.scope"), None);
        assert_eq!(id_from_unit("app-.scope"), None);
        assert_eq!(id_from_unit("app-a-b-c-d-9.scope"), None);
    }

    #[test]
    fn cgroup_files_use_the_innermost_app_unit() {
        let t = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-org.gnome.TextEditor-4242.scope\n";
        assert_eq!(id_from_cgroup(t).as_deref(), Some("org.gnome.texteditor"));
        assert_eq!(id_from_cgroup("0::/user.slice/session-2.scope\n"), None);
    }

    #[test]
    fn launched_desktop_file_and_exe_names() {
        assert_eq!(
            id_from_launched_desktop_file("/usr/share/applications/org.gnome.TextEditor.desktop")
                .as_deref(),
            Some("org.gnome.texteditor")
        );
        assert_eq!(
            id_from_launched_desktop_file("/usr/share/applications/x.txt"),
            None
        );
        assert_eq!(
            id_from_exe_name("/usr/bin/Firefox").as_deref(),
            Some("firefox")
        );
        assert_eq!(
            id_from_exe_name("/usr/lib/firefox/firefox (deleted)").as_deref(),
            Some("firefox")
        );
        assert_eq!(id_from_exe_name("/tmp/a b"), None);
    }

    #[test]
    fn exec_lines() {
        assert_eq!(
            exec_program("gnome-text-editor --new-window %U").as_deref(),
            Some("gnome-text-editor")
        );
        assert_eq!(
            exec_program("env GTK_THEME=x /usr/bin/foo %f").as_deref(),
            Some("/usr/bin/foo")
        );
        assert_eq!(
            exec_program(r#""/opt/my app/run" --x"#).as_deref(),
            Some("/opt/my app/run")
        );
        assert_eq!(
            exec_program("/usr/bin/flatpak run --branch=stable --command=firefox org.mozilla.firefox @@u %u @@").as_deref(),
            Some("flatpak:org.mozilla.firefox")
        );
        assert_eq!(exec_program(""), None);
    }

    const EDITOR: &str = "[Desktop Entry]\nType=Application\nName=Text Editor\nExec=gnome-text-editor %U\nStartupWMClass=org.gnome.TextEditor\n[Desktop Action new]\nExec=other\n";

    #[test]
    fn desktop_files_parse_only_the_main_group() {
        let e = parse_desktop("org.gnome.TextEditor", EDITOR).unwrap();
        assert_eq!(
            (e.id.as_str(), e.exec.as_str()),
            ("org.gnome.texteditor", "gnome-text-editor")
        );
        assert_eq!(e.name.as_deref(), Some("Text Editor"));
        assert_eq!(e.wm_class.as_deref(), Some("org.gnome.texteditor"));
        assert!(parse_desktop("x", "[Desktop Entry]\nType=Link\nExec=a\n").is_none());
        assert!(parse_desktop("x", "[Desktop Entry]\nType=Application\n").is_none());
    }

    #[test]
    fn the_index_matches_executables() {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("applications");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::write(apps.join("org.gnome.TextEditor.desktop"), EDITOR).unwrap();
        std::fs::write(
            apps.join("firefox.desktop"),
            "[Desktop Entry]\nType=Application\nExec=/usr/lib/firefox/firefox %u\n",
        )
        .unwrap();
        let index = DesktopIndex::load(&[dir.path().to_path_buf()]);
        assert_eq!(index.entries.len(), 2);
        assert_eq!(
            index.ids_for_exe("/usr/bin/gnome-text-editor"),
            vec!["org.gnome.texteditor"]
        );
        assert_eq!(
            index.ids_for_exe("/usr/lib/firefox/firefox"),
            vec!["firefox"]
        );
        assert!(index.ids_for_exe("/usr/bin/unknown").is_empty());
        assert!(index.get("ORG.gnome.texteditor.desktop").is_some());
    }

    #[test]
    fn the_strictest_candidate_wins() {
        // A terminal launched with a friendly desktop file in its environment.
        let index = DesktopIndex::default();
        let ev = Evidence {
            launched_desktop_file: Some(
                "/usr/share/applications/org.gnome.TextEditor.desktop".into(),
            ),
            exe: Some("/usr/bin/gnome-terminal".into()),
            ..Default::default()
        };
        let c = candidates(&ev, &index);
        assert_eq!(c, vec!["org.gnome.texteditor", "gnome-terminal"]);
        assert_eq!(choose(&c).as_deref(), Some("gnome-terminal"));
        // Ordinary apps keep the first candidate.
        let ev = Evidence {
            cgroup: Some("0::/app.slice/app-gnome-org.gnome.TextEditor-1.scope\n".into()),
            exe: Some("/usr/bin/gnome-text-editor".into()),
            ..Default::default()
        };
        assert_eq!(
            choose(&candidates(&ev, &index)).as_deref(),
            Some("org.gnome.texteditor")
        );
        assert_eq!(choose(&[]), None);
    }

    #[test]
    fn app_id_queries() {
        assert!(is_app_id("org.gnome.TextEditor"));
        assert!(is_app_id("gnome-terminal"));
        assert!(!is_app_id("../etc/passwd"));
        assert!(!is_app_id("Text Editor"));
        assert!(!is_app_id(""));
        assert!(!is_app_id("-rf"));
    }
}
