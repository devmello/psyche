//! Whose window has the keyboard, before agent input reaches it (linux-desktop design §7.3, the
//! #1452 review's finding 3).
//!
//! The window manager of the virtual screen focuses every new top-level, so a page's
//! `window.open` in the agent's Firefox, or any other client on the display, can take the focus
//! while the agent is typing into Writer. XTest delivers keys to the X input focus, whoever owns
//! it. So before each typed batch (and again before each chunk) the engine asks this: the pid
//! the X server recorded for the focused window's client (X-Resource, which a client cannot set;
//! not `_NET_WM_PID` and not `_NET_ACTIVE_WINDOW`, which any client can write) must be in the
//! launch scope of the app the agent means to type into.
//!
//! Pure: the facts come in, a verdict goes out.

use psyche_linux_computer::backend::AppInfo;
use psyche_linux_computer::error::{code, CapError};

use psyche_linux_computer::app_id::aliases;

use crate::remote::policy::Policy;

/// The machine ceiling's two lists, asked separately.
pub trait Denies {
    /// Whether `apps.deny` names this id.
    fn deny_listed(&self, app_id: &str) -> bool;
    /// Whether `apps.allow` names this id, or an alias of it (a snap's `<snap>_<app>`).
    fn allow_listed(&self, app_id: &str) -> bool;
    /// Out of reach for the app a call names: denied, or not allowed.
    fn is_denied(&self, app_id: &str) -> bool {
        self.deny_listed(app_id) || !self.allow_listed(app_id)
    }
}

impl Denies for Policy {
    fn deny_listed(&self, app_id: &str) -> bool {
        Policy::deny_listed(self, app_id)
    }
    fn allow_listed(&self, app_id: &str) -> bool {
        aliases(app_id)
            .iter()
            .any(|a| Policy::allow_listed(self, a))
    }
}

/// Where processes belong.
pub trait Scopes {
    /// Whether `pid` runs in the scope of an app launched here as `app_id`.
    fn in_scope(&self, app_id: &str, pid: u32) -> bool;
    /// The app whose **launch scope** holds `pid`. A program the app started (a link opened
    /// through `xdg-open`, a helper run by `gio launch`) stays in that scope, so this names the
    /// parent, not the program.
    fn app_of(&self, pid: u32) -> Option<String>;
    /// The app the process itself is (the strictest candidate), whichever scope it sits in. What
    /// errors name.
    fn own_id(&self, pid: u32) -> Option<String>;
    /// `own_id` when it names an installed desktop entry, else nothing: what an **allow list**
    /// is applied to. A name taken from the executable (`soffice.bin`) says nothing about
    /// whether the app is allowed.
    fn resolved_id(&self, pid: u32) -> Option<String> {
        self.own_id(pid)
    }
    /// Every id the process could be; a **deny list** is judged on all of them.
    fn own_ids(&self, pid: u32) -> Vec<String> {
        self.own_id(pid).into_iter().collect()
    }
}

/// Why the ceiling puts a process out of reach: `(the app to name, the id that matched)`.
///
/// - `apps.deny` is applied to **every** identity the process has: its launch scope's app, its
///   resolved id and each candidate (cgroup, desktop entries of its executable, launched file,
///   executable name, `comm`, a Flatpak's name).
/// - `apps.allow` is applied only to the launch scope's app and the resolved id, with snap
///   aliases. Candidates taken from file names do not take part: they would deny the apps the
///   list names (`gnome-text-edit` for the editor, `soffice.bin` for Writer).
pub fn blocked_by(deny: &dyn Denies, scopes: &dyn Scopes, pid: u32) -> Option<(String, String)> {
    let holder = scopes.app_of(pid);
    let resolved = scopes.resolved_id(pid);
    let all = scopes.own_ids(pid);
    let name = || {
        scopes
            .own_id(pid)
            .or_else(|| holder.clone())
            .unwrap_or_default()
    };
    if let Some(m) = holder
        .iter()
        .chain(resolved.iter())
        .chain(all.iter())
        .find(|id| deny.deny_listed(id))
    {
        return Some((name(), m.clone()));
    }
    holder
        .iter()
        .chain(resolved.iter())
        .find(|id| !deny.allow_listed(id))
        .map(|m| (name(), m.clone()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The server could not say whose window has the focus: nothing is typed.
    Unknown,
    /// The focus is in a window that is not the app's. `other` names the app when it is one we
    /// launched.
    Moved { other: Option<String> },
    /// The app the keys would reach is out of reach under the owner's ceiling, whichever app was
    /// meant: `app` is what it is, `matched` the identity that the list caught.
    Denied { app: String, matched: String },
}

/// Whether input may go on to `target` (a desktop id) when the focused window's client is
/// `focus_pid`. **It only refuses.** Passing means the focused process is in the target's scope
/// and nothing denied is involved; the engine still requires that process to be the app's own
/// (`app.owns(pid)`), because something an app launches does not count as that app.
pub fn decide(
    target: &str,
    focus_pid: Option<u32>,
    scopes: &dyn Scopes,
    deny: &dyn Denies,
) -> Result<(), Refusal> {
    if deny.is_denied(target) {
        return Err(Refusal::Denied {
            app: target.to_string(),
            matched: target.to_string(),
        });
    }
    let Some(pid) = focus_pid else {
        return Err(Refusal::Unknown);
    };
    if let Some((app, matched)) = blocked_by(deny, scopes, pid) {
        return Err(Refusal::Denied { app, matched });
    }
    if scopes.in_scope(target, pid) {
        Ok(())
    } else {
        Err(Refusal::Moved {
            other: scopes.app_of(pid).or_else(|| scopes.own_id(pid)),
        })
    }
}

pub fn to_error(refusal: &Refusal, app: &AppInfo) -> CapError {
    match refusal {
        Refusal::Unknown => CapError::new(
            code::CONFLICT,
            "focus_unknown",
            format!(
                "Psyche cannot tell which window has the keyboard, so it did not type into {}",
                app.name
            ),
        )
        .detail("app", app.id.as_str())
        .retryable(),
        Refusal::Moved { other } => {
            let mut e = CapError::new(
                code::CONFLICT,
                "focus_moved",
                format!("Keyboard focus is no longer in {}; input stopped", app.name),
            )
            .detail("app", app.id.as_str())
            .retryable();
            if let Some(o) = other {
                e = e.detail("focusedApp", o.as_str());
            }
            e
        }
        Refusal::Denied {
            app: denied,
            matched,
        } => CapError::new(
            code::POLICY_DENIED,
            "app_denied",
            "This computer's owner has put that app out of Psyche's reach",
        )
        .detail("app", denied.as_str())
        .detail("matched", matched.as_str()),
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::remote::policy::Apps;
    use psyche_linux_computer::app_id::{candidates, choose, normalize, DesktopIndex, Evidence};
    use std::collections::HashMap;

    fn policy(allow: &[&str], deny: &[&str]) -> Policy {
        let mut p = Policy::default();
        p.apps = Apps {
            allow: allow.iter().map(|s| s.to_string()).collect(),
            deny: deny.iter().map(|s| s.to_string()).collect(),
        };
        p
    }

    /// pid -> (launch scope's app, the process's own app).
    struct Fake(HashMap<u32, (&'static str, &'static str)>);

    impl Scopes for Fake {
        fn in_scope(&self, app_id: &str, pid: u32) -> bool {
            self.0
                .get(&pid)
                .is_some_and(|(scope, _)| scope.eq_ignore_ascii_case(app_id))
        }
        fn app_of(&self, pid: u32) -> Option<String> {
            self.0.get(&pid).map(|(scope, _)| scope.to_string())
        }
        fn own_id(&self, pid: u32) -> Option<String> {
            self.0.get(&pid).map(|(_, own)| own.to_string())
        }
    }

    fn scopes() -> Fake {
        Fake(HashMap::from([
            (100, ("org.gnome.TextEditor", "org.gnome.TextEditor")),
            // A terminal the editor started: it sits in the editor's scope.
            (101, ("org.gnome.TextEditor", "debian-xterm")),
            (200, ("org.mozilla.firefox", "org.mozilla.firefox")),
            (300, ("org.keepassxc.KeePassXC", "org.keepassxc.KeePassXC")),
            // KeePassXC started by the editor.
            (301, ("org.gnome.TextEditor", "org.keepassxc.KeePassXC")),
        ]))
    }

    fn info(id: &str, pid: u32) -> AppInfo {
        AppInfo {
            id: id.into(),
            name: id.into(),
            pid,
            electron: false,
            frontmost: true,
            windows: 1,
        }
    }

    fn keepass_denied() -> Policy {
        policy(&["*"], &["org.keepassxc.KeePassXC"])
    }

    #[test]
    fn the_scope_check_only_refuses_and_a_scope_child_passes_it_unvouched() {
        // The check passes for a process in the scope (the editor, and the xterm it started).
        // That is not permission: the engine's own exact-pid comparison still runs after it,
        // and refuses the xterm (engine test
        // `a_surface_that_allows_the_focus_does_not_replace_the_pid_comparison`).
        let n = policy(&["*"], &[]);
        assert_eq!(
            decide("org.gnome.TextEditor", Some(100), &scopes(), &n),
            Ok(())
        );
        assert_eq!(
            decide("org.gnome.TextEditor", Some(101), &scopes(), &n),
            Ok(())
        );
    }

    #[test]
    fn typing_is_refused_when_the_focus_is_another_apps_window() {
        let r = decide(
            "org.gnome.TextEditor",
            Some(200),
            &scopes(),
            &policy(&["*"], &[]),
        );
        assert_eq!(
            r,
            Err(Refusal::Moved {
                other: Some("org.mozilla.firefox".into())
            })
        );
        let e = to_error(&r.unwrap_err(), &info("org.gnome.texteditor", 100));
        assert_eq!((e.code, e.reason.as_str()), ("conflict", "focus_moved"));
        assert!(e.retryable);
    }

    #[test]
    fn typing_is_refused_for_a_window_that_belongs_to_no_launched_app() {
        let r = decide(
            "org.gnome.TextEditor",
            Some(4242),
            &scopes(),
            &policy(&["*"], &[]),
        );
        assert_eq!(r, Err(Refusal::Moved { other: None }));
    }

    #[test]
    fn typing_is_refused_when_the_focus_cannot_be_read() {
        assert_eq!(
            decide(
                "org.gnome.TextEditor",
                None,
                &scopes(),
                &policy(&["*"], &[])
            ),
            Err(Refusal::Unknown)
        );
    }

    #[test]
    fn a_denied_app_with_the_focus_gets_no_input_and_the_error_names_what_it_is() {
        let r = decide(
            "org.gnome.TextEditor",
            Some(300),
            &scopes(),
            &keepass_denied(),
        );
        assert_eq!(
            r,
            Err(Refusal::Denied {
                app: "org.keepassxc.KeePassXC".into(),
                matched: "org.keepassxc.KeePassXC".into()
            })
        );
        let r = decide(
            "org.keepassxc.KeePassXC",
            Some(300),
            &scopes(),
            &keepass_denied(),
        );
        let e = to_error(&r.unwrap_err(), &info("org.keepassxc.keepassxc", 300));
        assert_eq!((e.code, e.reason.as_str()), ("policy_denied", "app_denied"));
        assert!(!e.retryable);
    }

    #[test]
    fn a_denied_program_started_by_an_allowed_app_gets_no_input() {
        // Its scope is the editor's; the process itself is KeePassXC.
        let r = decide(
            "org.gnome.TextEditor",
            Some(301),
            &scopes(),
            &keepass_denied(),
        );
        assert!(matches!(r, Err(Refusal::Denied { .. })));
    }

    /// `comm` is cut at 15 characters and the executable is not a desktop id: the error still
    /// names the app, and says separately which identity the list matched.
    #[test]
    fn the_error_names_the_app_and_the_matched_identity_apart() {
        struct Comm;
        impl Scopes for Comm {
            fn in_scope(&self, _: &str, _: u32) -> bool {
                true
            }
            fn app_of(&self, _: u32) -> Option<String> {
                Some("org.gnome.TextEditor".into())
            }
            fn own_id(&self, _: u32) -> Option<String> {
                Some("org.gnome.texteditor".into())
            }
            fn own_ids(&self, _: u32) -> Vec<String> {
                vec!["org.gnome.texteditor".into(), "gnome-text-edit".into()]
            }
        }
        let r = decide(
            "org.gnome.TextEditor",
            Some(1),
            &Comm,
            &policy(&["*"], &["gnome-text-edit"]),
        );
        assert_eq!(
            r,
            Err(Refusal::Denied {
                app: "org.gnome.texteditor".into(),
                matched: "gnome-text-edit".into()
            })
        );
        let e = to_error(&r.unwrap_err(), &info("org.gnome.texteditor", 1));
        assert_eq!(e.details["app"], "org.gnome.texteditor");
        assert_eq!(e.details["matched"], "gnome-text-edit");
    }

    /// Scopes built from the **real** candidate resolver over desktop files on disk, the way
    /// `A11y` builds them: the launch scope names the app, the evidence names the process.
    struct Real {
        index: DesktopIndex,
        procs: HashMap<u32, (&'static str, Evidence)>,
    }

    impl Real {
        fn cands(&self, pid: u32) -> Vec<String> {
            let (_, ev) = &self.procs[&pid];
            let mut c = candidates(ev, &self.index);
            if let Some(comm) = ev.comm.as_deref().map(normalize) {
                if !c.contains(&comm) {
                    c.push(comm);
                }
            }
            c
        }
    }

    impl Scopes for Real {
        fn in_scope(&self, app_id: &str, pid: u32) -> bool {
            self.procs[&pid].0.eq_ignore_ascii_case(app_id)
        }
        fn app_of(&self, pid: u32) -> Option<String> {
            Some(self.procs[&pid].0.to_string())
        }
        fn own_id(&self, pid: u32) -> Option<String> {
            choose(&self.cands(pid))
        }
        fn resolved_id(&self, pid: u32) -> Option<String> {
            let id = self.own_id(pid)?;
            aliases(&id)
                .iter()
                .any(|a| self.index.get(a).is_some())
                .then_some(id)
        }
        fn own_ids(&self, pid: u32) -> Vec<String> {
            self.cands(pid)
        }
    }

    fn real() -> (tempfile::TempDir, Real) {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("applications");
        std::fs::create_dir_all(&apps).unwrap();
        for (file, exec) in [
            ("org.gnome.TextEditor.desktop", "gnome-text-editor %U"),
            ("libreoffice-writer.desktop", "libreoffice --writer %U"),
            (
                "firefox_firefox.desktop",
                "env BAMF_DESKTOP_FILE_HINT=x /snap/bin/firefox %u",
            ),
            ("debian-xterm.desktop", "xterm"),
        ] {
            std::fs::write(
                apps.join(file),
                format!("[Desktop Entry]\nType=Application\nName=x\nExec={exec}\n"),
            )
            .unwrap();
        }
        let index = DesktopIndex::load(&[dir.path().to_path_buf()]);
        let ev = |exe: &str, comm: &str| Evidence {
            exe: Some(exe.into()),
            comm: Some(comm.into()),
            ..Default::default()
        };
        let procs = HashMap::from([
            (
                1,
                (
                    "org.gnome.TextEditor",
                    ev("/usr/bin/gnome-text-editor", "gnome-text-edit"),
                ),
            ),
            (
                2,
                (
                    "libreoffice-writer",
                    ev("/usr/lib/libreoffice/program/soffice.bin", "soffice.bin"),
                ),
            ),
            (
                3,
                (
                    "firefox",
                    Evidence {
                        cgroup: Some("0::/user.slice/app-snap.firefox.firefox-1234.scope".into()),
                        ..ev("/snap/firefox/current/usr/lib/firefox/firefox", "firefox")
                    },
                ),
            ),
            // An xterm the editor started: the editor's scope, its own executable.
            (4, ("org.gnome.TextEditor", ev("/usr/bin/xterm", "xterm"))),
        ]);
        (dir, Real { index, procs })
    }

    /// The r1 review's probes, with real candidates: under a narrow allow list the apps the
    /// list names are allowed, whatever their executables and `comm` are called.
    #[test]
    fn a_narrow_allow_list_allows_the_apps_it_names_with_real_candidates() {
        let (_keep, real) = real();
        for (pid, allow) in [
            (1, "org.gnome.TextEditor"),
            (2, "libreoffice-writer"),
            (3, "firefox"),
        ] {
            let p = policy(&[allow], &[]);
            assert_eq!(
                blocked_by(&p, &real, pid),
                None,
                "{allow} {:?}",
                real.cands(pid)
            );
        }
        // And the same apps under an allow list that names something else are out of reach.
        for pid in [1, 2, 3] {
            assert!(blocked_by(&policy(&["org.other.App"], &[]), &real, pid).is_some());
        }
        // A program the editor started whose executable resolves to no desktop entry is not
        // covered by an allow list yet (the follow-up: an unresolved id is not permitted). It
        // still gets no keys (the engine's exact pid check), and a deny entry catches it, see
        // `a_deny_list_catches_a_process_under_any_candidate_id`.
    }

    /// The deny list, on the other hand, catches any identity: the executable's name, the
    /// `comm`, the desktop entry, a file name.
    #[test]
    fn a_deny_list_catches_a_process_under_any_candidate_id() {
        let (_keep, real) = real();
        for (pid, entry) in [
            (1, "gnome-text-edit"),
            (1, "gnome-text-editor"),
            (1, "org.gnome.TextEditor"),
            (2, "soffice.bin"),
            (2, "libreoffice-*"),
            (3, "firefox_firefox"),
            (4, "xterm"),
        ] {
            let p = policy(&["*"], &[entry]);
            assert!(blocked_by(&p, &real, pid).is_some(), "{entry} for {pid}");
        }
        // A near miss is not denied.
        assert_eq!(
            blocked_by(&policy(&["*"], &["gnome-calculator"]), &real, 1),
            None
        );
    }

    #[test]
    fn the_deny_list_does_not_touch_other_apps() {
        assert_eq!(
            decide(
                "org.gnome.TextEditor",
                Some(100),
                &scopes(),
                &keepass_denied()
            ),
            Ok(())
        );
        // A policy that allows nothing puts everything out of reach.
        assert!(matches!(
            decide(
                "org.gnome.TextEditor",
                Some(100),
                &scopes(),
                &policy(&[], &[])
            ),
            Err(Refusal::Denied { .. })
        ));
    }
}
