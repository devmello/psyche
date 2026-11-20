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

use psyche_linux_computer::app_id::{normalize, IdFacts};
use psyche_linux_computer::tiers::fixed_caps;

use crate::remote::policy::Policy;

/// The machine ceiling's two lists, asked separately (each matches snap aliases too).
pub trait Denies {
    /// Whether `apps.deny` names this id.
    fn deny_listed(&self, app_id: &str) -> bool;
    /// Whether `apps.allow` names this id.
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
        Policy::allow_listed(self, app_id)
    }
}

/// Who a process is: the app whose launch scope holds it, and what the process itself is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    /// The app whose **launch scope** holds the process. A program the app started (a link
    /// opened through `xdg-open`, a helper run by `gio launch`) stays in that scope, so this
    /// names the parent, not the program. `None` for a process that left every scope.
    pub holder: Option<String>,
    pub facts: IdFacts,
}

/// Where processes belong. `identity` is read **once** per process per question.
pub trait Scopes {
    /// Whether `pid` runs in the scope of an app launched here as `app_id`.
    fn in_scope(&self, app_id: &str, pid: u32) -> bool;
    fn identity(&self, pid: u32) -> Identity;
}

/// Why the ceiling puts a process out of reach: `(the app to name, the id that matched)`.
///
/// - `apps.deny` is applied to **every** identity: the launch scope's app, the strictest
///   candidate, the resolved entries and each candidate (cgroup, executable name, `comm`, a
///   Flatpak's name).
/// - `apps.allow` must cover the launch scope's app and every **resolved** desktop entry (the
///   executable's own entries: an xterm in an allowed app's scope resolves to `debian-xterm`).
///   It also covers the strictest candidate when that has a stricter fixed cap than the scope's
///   app (a terminal or browser with no entry), and when there is no scope and nothing
///   resolved. When nothing resolves the strictest candidate is judged too: **an id that names
///   no installed app is not on a narrow list**. File-name candidates otherwise take no part:
///   they would deny the apps the list names (`soffice.bin` for Writer, which resolves to
///   `libreoffice-writer` through its launcher script).
pub fn blocked_by(deny: &dyn Denies, scopes: &dyn Scopes, pid: u32) -> Option<(String, String)> {
    let id = scopes.identity(pid);
    let name = id
        .facts
        .own
        .clone()
        .or_else(|| id.holder.clone())
        .unwrap_or_default();
    if let Some(m) = id
        .holder
        .iter()
        .chain(id.facts.own.iter())
        .chain(id.facts.resolved.iter())
        .chain(id.facts.candidates.iter())
        .find(|i| deny.deny_listed(i))
    {
        return Some((name, m.clone()));
    }
    // A launcher shared by several entries (`libreoffice` starts Writer, Calc and the Start
    // Center from one `soffice.bin`) resolves to all of them. When the scope's own app is one of
    // them, the others are the same program and the scope's app is the answer.
    let holder_resolved = id.holder.as_deref().is_some_and(|h| {
        let h = normalize(h);
        id.facts.resolved.iter().any(|r| normalize(r) == h)
    });
    let mut judged: Vec<&String> = if holder_resolved {
        id.holder.iter().collect()
    } else {
        id.holder.iter().chain(id.facts.resolved.iter()).collect()
    };
    if let Some(own) = &id.facts.own {
        let judge_own = match &id.holder {
            None => id.facts.resolved.is_empty(),
            // Nothing resolved: an id that names no installed app is not on the list.
            Some(_) if id.facts.resolved.is_empty() => true,
            Some(h) => fixed_caps::cap(Some(own)) < fixed_caps::cap(Some(h)),
        };
        if judge_own {
            judged.push(own);
        }
    }
    judged
        .into_iter()
        .find(|i| !deny.allow_listed(i))
        .map(|m| (name, m.clone()))
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
            other: {
                let i = scopes.identity(pid);
                i.holder.or(i.facts.own)
            },
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
    use psyche_linux_computer::app_id::{id_facts, DesktopIndex, Evidence};
    use std::collections::HashMap;

    fn policy(allow: &[&str], deny: &[&str]) -> Policy {
        let mut p = Policy::default();
        p.apps = Apps {
            allow: allow.iter().map(|s| s.to_string()).collect(),
            deny: deny.iter().map(|s| s.to_string()).collect(),
        };
        p
    }

    /// pid -> (launch scope's app, the process's own app), the own app being resolved.
    struct Fake(HashMap<u32, (&'static str, &'static str)>);

    impl Scopes for Fake {
        fn in_scope(&self, app_id: &str, pid: u32) -> bool {
            self.0
                .get(&pid)
                .is_some_and(|(scope, _)| scope.eq_ignore_ascii_case(app_id))
        }
        fn identity(&self, pid: u32) -> Identity {
            match self.0.get(&pid) {
                Some((scope, own)) => Identity {
                    holder: Some(scope.to_string()),
                    facts: IdFacts {
                        own: Some(own.to_string()),
                        resolved: vec![own.to_string()],
                        candidates: vec![own.to_string()],
                    },
                },
                None => Identity::default(),
            }
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
        // Under `*` the check passes for a process in the scope (the editor, and the xterm it
        // started). That is not permission: the engine's own exact-pid comparison still runs
        // after it, and refuses the xterm (engine test
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
            fn identity(&self, _: u32) -> Identity {
                Identity {
                    holder: Some("org.gnome.TextEditor".into()),
                    facts: IdFacts {
                        own: Some("org.gnome.texteditor".into()),
                        resolved: vec!["org.gnome.texteditor".into()],
                        candidates: vec!["org.gnome.texteditor".into(), "gnome-text-edit".into()],
                    },
                }
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

    /// Identities built by the **real** resolver over desktop files on disk, the way `A11y`
    /// builds them.
    struct Real {
        index: DesktopIndex,
        procs: HashMap<u32, (Option<&'static str>, Evidence)>,
    }

    impl Scopes for Real {
        fn in_scope(&self, app_id: &str, pid: u32) -> bool {
            self.procs[&pid]
                .0
                .is_some_and(|h| h.eq_ignore_ascii_case(app_id))
        }
        fn identity(&self, pid: u32) -> Identity {
            let (holder, ev) = &self.procs[&pid];
            Identity {
                holder: holder.map(str::to_string),
                facts: id_facts(ev, &self.index, holder.as_deref(), None, false),
            }
        }
    }

    fn real() -> (tempfile::TempDir, Real) {
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("applications");
        std::fs::create_dir_all(&apps).unwrap();
        // Writer's `Exec=` is a launcher script that runs `soffice.bin`, as on a real system.
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(
            bin.join("libreoffice"),
            "#!/bin/sh\nsd_prog=/usr/lib/libreoffice/program\nexec $CHECK \"$sd_prog/soffice.bin\" \"$@\"\n",
        )
        .unwrap();
        let writer_exec = format!("{} --writer %U", bin.join("libreoffice").display());
        for (file, exec) in [
            ("org.gnome.TextEditor.desktop", "gnome-text-editor %U"),
            ("libreoffice-writer.desktop", writer_exec.as_str()),
            ("libreoffice-startcenter.desktop", writer_exec.as_str()),
            ("libreoffice-calc.desktop", writer_exec.as_str()),
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
        let index = DesktopIndex::load_with(&[dir.path().to_path_buf()], &|_| true);
        let ev = |exe: &str, comm: &str| Evidence {
            exe: Some(exe.into()),
            comm: Some(comm.into()),
            ..Default::default()
        };
        let procs = HashMap::from([
            (
                1,
                (
                    Some("org.gnome.TextEditor"),
                    ev("/usr/bin/gnome-text-editor", "gnome-text-edit"),
                ),
            ),
            (
                2,
                (
                    Some("libreoffice-writer"),
                    ev("/usr/lib/libreoffice/program/soffice.bin", "soffice.bin"),
                ),
            ),
            (
                3,
                (
                    Some("firefox"),
                    Evidence {
                        cgroup: Some("0::/user.slice/app-snap.firefox.firefox-1234.scope".into()),
                        ..ev("/snap/firefox/current/usr/lib/firefox/firefox", "firefox")
                    },
                ),
            ),
            // (a) an xterm the editor started: the editor's scope, its own executable.
            (
                4,
                (Some("org.gnome.TextEditor"), ev("/usr/bin/xterm", "xterm")),
            ),
            // (b) a process that left every scope.
            (5, (None, ev("/usr/bin/xterm", "xterm"))),
            (
                6,
                (
                    None,
                    ev("/usr/lib/libreoffice/program/soffice.bin", "soffice.bin"),
                ),
            ),
            // (c) a program with no desktop entry in an allowed scope: the documented gap.
            (7, (Some("org.gnome.TextEditor"), ev("/usr/bin/foo", "foo"))),
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
                real.identity(pid)
            );
        }
        // And the same apps under an allow list that names something else are out of reach.
        for pid in [1, 2, 3] {
            assert!(blocked_by(&policy(&["org.other.App"], &[]), &real, pid).is_some());
        }
    }

    /// (a) and (b) of the r2 review: what main hid stays hidden.
    #[test]
    fn under_a_narrow_allow_list_a_program_started_by_an_allowed_app_or_with_no_scope_is_out_of_reach(
    ) {
        let (_keep, real) = real();
        let p = policy(&["org.gnome.TextEditor"], &[]);
        // (a) The xterm in the editor's scope resolves to its own entry, `debian-xterm`.
        let (_, matched) = blocked_by(&p, &real, 4).expect("xterm in the editor's scope");
        assert_eq!(matched, "debian-xterm");
        // (b) No scope: the process is judged on what it is. An xterm, and Writer's executable
        // with no scope (nothing resolves, `soffice.bin` is not on the list).
        assert!(blocked_by(&p, &real, 5).is_some());
        assert!(blocked_by(&p, &real, 6).is_some());
        // ... and the same processes are fine when the list names them.
        assert_eq!(blocked_by(&policy(&["debian-xterm"], &[]), &real, 5), None);
        // With no scope to say which LibreOffice app it is, the list must name them all.
        assert!(blocked_by(&policy(&["libreoffice-writer"], &[]), &real, 6).is_some());
        assert_eq!(blocked_by(&policy(&["libreoffice-*"], &[]), &real, 6), None);
    }

    /// (c), closed: a program with no desktop entry inside an allowed app's scope is not on a
    /// narrow list. Writer, whose executable only resolves through its launcher script, is.
    #[test]
    fn an_unknown_program_in_an_allowed_scope_is_out_of_reach_and_writer_through_its_wrapper_is_not(
    ) {
        let (_keep, real) = real();
        let p = policy(&["org.gnome.TextEditor"], &[]);
        let (_, matched) = blocked_by(&p, &real, 7).expect("foo has no entry");
        assert_eq!(matched, "foo");
        // Under `*` nothing is judged.
        assert_eq!(blocked_by(&policy(&["*"], &[]), &real, 7), None);
        // Writer's executable is `soffice.bin`; its launcher script names it, so it resolves.
        let facts = real.identity(2).facts;
        // Every LibreOffice entry shares the launcher, so all of them resolve; the scope's app
        // names the process, and the others collapse into it.
        assert!(facts.resolved.iter().any(|r| r == "libreoffice-writer"));
        assert!(facts.resolved.iter().any(|r| r == "libreoffice-calc"));
        assert_eq!(facts.own.as_deref(), Some("libreoffice-writer"));
        assert_eq!(
            blocked_by(&policy(&["libreoffice-writer"], &[]), &real, 2),
            None,
            "Writer is shown under its own narrow list"
        );
        assert!(blocked_by(&policy(&["libreoffice-calc"], &[]), &real, 2).is_some());
    }

    /// A terminal with no desktop entry has a stricter fixed cap than the scope's app, so the
    /// allow list is applied to it even though nothing resolves.
    #[test]
    fn an_own_id_with_a_stricter_cap_is_judged_even_when_it_resolves_to_nothing() {
        struct Term;
        impl Scopes for Term {
            fn in_scope(&self, _: &str, _: u32) -> bool {
                true
            }
            fn identity(&self, _: u32) -> Identity {
                Identity {
                    holder: Some("org.gnome.TextEditor".into()),
                    facts: IdFacts {
                        own: Some("xterm".into()),
                        resolved: vec![],
                        candidates: vec!["xterm".into()],
                    },
                }
            }
        }
        assert!(blocked_by(&policy(&["org.gnome.TextEditor"], &[]), &Term, 1).is_some());
        assert_eq!(blocked_by(&policy(&["*"], &[]), &Term, 1), None);
    }

    /// The deny list catches any identity: the executable's name, the `comm`, the desktop
    /// entry, a file name.
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
        assert_eq!(
            blocked_by(&policy(&["*"], &["gnome-calculator"]), &real, 1),
            None
        );
    }

    /// Snap aliases agree everywhere: the gate's matcher and this one are the same.
    #[test]
    fn snap_aliases_match_on_both_lists_in_the_policy_itself() {
        let p = policy(&["firefox"], &[]);
        assert!(p.app_permitted("firefox_firefox"));
        assert!(!p.app_permitted("thunderbird_thunderbird"));
        assert!(!p.app_permitted("evil_firefox"));
        let p = policy(&["*"], &["firefox"]);
        assert!(!p.app_permitted("firefox_firefox"));
        assert!(p.app_permitted("firefox-esr"));
        let p = policy(&["firefox_firefox"], &[]);
        assert!(p.app_permitted("firefox"));
    }

    /// The allow list's snap aliases are narrow: the snap's own id and its short name, nothing
    /// wider. The deny list's are wide: every form an id can take.
    #[test]
    fn snap_aliases_are_narrow_on_allow_and_wide_on_deny() {
        // (pattern, id, allow matches, deny matches)
        for (pattern, id, allow, deny) in [
            ("firefox", "firefox_firefox", true, true),
            ("firefox_firefox", "firefox", true, true),
            ("firefox_firefox", "firefox_firefox", true, true),
            ("firefox", "firefox", true, true),
            // Near misses that share a word: never allowed.
            ("firefox", "evil_firefox", false, true),
            ("firefox", "firefox_evil", false, true),
            ("code", "code_insiders", false, true),
            ("code_insiders", "code", false, false),
            ("firefox_firefox", "evil_firefox", false, true),
            ("firefox", "firefox-esr", false, false),
            ("org.mozilla.firefox", "firefox", false, false),
            // A snap whose app is not its name, and a parallel install: denied by the snap name.
            ("libreoffice", "libreoffice_writer", false, true),
            ("firefox", "firefox+beta_firefox", false, true),
        ] {
            let p = policy(&[pattern], &[]);
            assert_eq!(p.allow_listed(id), allow, "allow {pattern} vs {id}");
            let p = policy(&["*"], &[pattern]);
            assert_eq!(p.deny_listed(id), deny, "deny {pattern} vs {id}");
        }
    }

    /// A Flatpak's app id is its identity; the host entries that share its executable's file
    /// name are not.
    #[test]
    fn a_flatpak_is_the_app_its_sandbox_says_not_the_host_entry_with_the_same_file_name() {
        let (_keep, real) = real();
        let ev = Evidence {
            exe: Some("/app/lib/firefox/firefox".into()),
            comm: Some("firefox".into()),
            ..Default::default()
        };
        let facts = id_facts(
            &ev,
            &real.index,
            None,
            Some("org.mozilla.firefox".into()),
            true,
        );
        assert_eq!(facts.own.as_deref(), Some("org.mozilla.firefox"));
        assert_eq!(facts.resolved, vec!["org.mozilla.firefox".to_string()]);
        // Without the sandbox's name, the host's `firefox_firefox` entry would answer for it.
        let host = id_facts(&ev, &real.index, None, None, false);
        // A name that is not shown to be the installed Flatpak adds a deny candidate and nothing
        // else: it gives no identity for an allow list to rely on.
        let forged = id_facts(
            &ev,
            &real.index,
            None,
            Some("org.gnome.TextEditor".into()),
            false,
        );
        assert_eq!(forged.own, host.own);
        assert_eq!(forged.resolved, host.resolved);
        assert!(forged
            .candidates
            .iter()
            .any(|c| c == "org.gnome.texteditor"));
        assert!(host.resolved.iter().any(|r| r == "firefox_firefox"));
        // And so the allow list that names the Flatpak covers it.
        let identity = Identity {
            holder: Some("org.mozilla.firefox".into()),
            facts,
        };
        struct Fp(Identity);
        impl Scopes for Fp {
            fn in_scope(&self, _: &str, _: u32) -> bool {
                true
            }
            fn identity(&self, _: u32) -> Identity {
                self.0.clone()
            }
        }
        assert_eq!(
            blocked_by(
                &policy(&["org.mozilla.firefox"], &[]),
                &Fp(identity.clone()),
                1
            ),
            None
        );
        assert!(blocked_by(&policy(&["firefox"], &[]), &Fp(identity), 1).is_some());
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
