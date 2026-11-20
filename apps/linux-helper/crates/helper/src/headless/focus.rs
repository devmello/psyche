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

use super::deny::Deny;

/// Where processes belong.
pub trait Scopes {
    /// Whether `pid` runs in the scope of an app launched here as `app_id`.
    fn in_scope(&self, app_id: &str, pid: u32) -> bool;
    /// The app whose **launch scope** holds `pid`. A program the app started (a link opened
    /// through `xdg-open`, a helper run by `gio launch`) stays in that scope, so this names the
    /// parent, not the program.
    fn app_of(&self, pid: u32) -> Option<String>;
    /// The app the process itself is (its own executable and desktop entry), whichever scope it
    /// sits in.
    fn own_id(&self, pid: u32) -> Option<String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The server could not say whose window has the focus: nothing is typed.
    Unknown,
    /// The focus is in a window that is not the app's. `other` names the app when it is one we
    /// launched.
    Moved { other: Option<String> },
    /// The app the keys would reach is on the owner's deny list, whichever app was meant.
    Denied { app: String },
}

/// Whether input may go on to `target` (a desktop id) when the focused window's client is
/// `focus_pid`. **It only refuses.** Passing means the focused process is in the target's scope
/// and nothing denied is involved; the engine still requires that process to be the app's own
/// (`app.owns(pid)`), because something an app launches does not count as that app.
///
/// The deny list is checked for the target and, for the focused process, both for the scope's
/// app and for what the process itself is, so a denied program started by an allowed app gets no
/// keys.
pub fn decide(
    target: &str,
    focus_pid: Option<u32>,
    scopes: &dyn Scopes,
    deny: &Deny,
) -> Result<(), Refusal> {
    if deny.is_denied(target) {
        return Err(Refusal::Denied {
            app: target.to_string(),
        });
    }
    let Some(pid) = focus_pid else {
        return Err(Refusal::Unknown);
    };
    let holder = scopes.app_of(pid);
    let own = scopes.own_id(pid);
    if let Some(app) = [&holder, &own]
        .into_iter()
        .flatten()
        .find(|a| deny.is_denied(a))
    {
        return Err(Refusal::Denied { app: app.clone() });
    }
    if scopes.in_scope(target, pid) {
        Ok(())
    } else {
        Err(Refusal::Moved {
            other: holder.or(own),
        })
    }
}

/// The last check, made as the keys are sent with the server held (so the focus cannot change
/// between this and delivery): everything `decide` checks, and the focused client must be the
/// app's own process, exactly.
pub fn at_send(
    app: &AppInfo,
    focus_pid: Option<u32>,
    scopes: &dyn Scopes,
    deny: &Deny,
) -> Result<(), Refusal> {
    decide(&app.id, focus_pid, scopes, deny)?;
    match focus_pid {
        Some(p) if app.owns(p) => Ok(()),
        _ => Err(Refusal::Moved {
            other: focus_pid.and_then(|p| scopes.own_id(p)),
        }),
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
        Refusal::Denied { app: denied } => CapError::new(
            code::POLICY_DENIED,
            "app_denied",
            "This computer's owner has put that app out of Psyche's reach",
        )
        .detail("app", denied.as_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

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
            (101, ("org.gnome.TextEditor", "xterm")),
            (200, ("org.mozilla.firefox", "org.mozilla.firefox")),
            (300, ("org.keepassxc.KeePassXC", "org.keepassxc.KeePassXC")),
            // KeePassXC started by the editor.
            (301, ("org.gnome.TextEditor", "org.keepassxc.KeePassXC")),
        ]))
    }

    fn keepass_denied() -> Deny {
        Deny::Some(vec!["org.keepassxc.keepassxc".into()])
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

    #[test]
    fn the_scope_check_only_refuses_and_a_scope_child_passes_it_unvouched() {
        // The check passes for a process in the scope (the editor, and the xterm it started).
        // That is not permission: the engine's own exact-pid comparison still runs after it,
        // and refuses the xterm (see the engine test
        // `a_surface_that_allows_the_focus_does_not_replace_the_pid_comparison`).
        let n = Deny::Nothing;
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
    fn a_focus_change_between_the_check_and_the_send_leaks_nothing() {
        let app = info("org.gnome.TextEditor", 100);
        let n = Deny::Nothing;
        // The check passed with the editor focused; at send time the focus is a window of
        // another program (an xterm in the editor's scope, Firefox, an unknown client).
        assert_eq!(at_send(&app, Some(100), &scopes(), &n), Ok(()));
        assert!(matches!(
            at_send(&app, Some(101), &scopes(), &n),
            Err(Refusal::Moved { .. })
        ));
        assert!(matches!(
            at_send(&app, Some(200), &scopes(), &n),
            Err(Refusal::Moved { .. })
        ));
        assert!(matches!(
            at_send(&app, Some(4242), &scopes(), &n),
            Err(Refusal::Moved { .. })
        ));
        assert_eq!(at_send(&app, None, &scopes(), &n), Err(Refusal::Unknown));
        // And a denied program is refused as denied, not as a focus change.
        assert!(matches!(
            at_send(&app, Some(301), &scopes(), &keepass_denied()),
            Err(Refusal::Denied { .. })
        ));
    }

    #[test]
    fn typing_is_refused_when_the_focus_is_another_apps_window() {
        // The agent's Firefox opened a window and took the focus while it types into the editor.
        let r = decide("org.gnome.TextEditor", Some(200), &scopes(), &Deny::Nothing);
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
            &Deny::Nothing,
        );
        assert_eq!(r, Err(Refusal::Moved { other: None }));
    }

    #[test]
    fn typing_is_refused_when_the_focus_cannot_be_read() {
        assert_eq!(
            decide("org.gnome.TextEditor", None, &scopes(), &Deny::Nothing),
            Err(Refusal::Unknown)
        );
    }

    #[test]
    fn a_denied_app_with_the_focus_gets_no_input() {
        let r = decide(
            "org.gnome.TextEditor",
            Some(300),
            &scopes(),
            &keepass_denied(),
        );
        assert_eq!(
            r,
            Err(Refusal::Denied {
                app: "org.keepassxc.KeePassXC".into()
            })
        );
        let r = decide(
            "org.keepassxc.KeePassXC",
            Some(300),
            &scopes(),
            &keepass_denied(),
        );
        assert!(matches!(r, Err(Refusal::Denied { .. })));
        let e = to_error(&r.unwrap_err(), &info("org.keepassxc.keepassxc", 300));
        assert_eq!((e.code, e.reason.as_str()), ("policy_denied", "app_denied"));
        assert!(!e.retryable);
    }

    #[test]
    fn a_denied_program_started_by_an_allowed_app_gets_no_input() {
        // Its scope is the editor's, so the scope says "allowed"; the process itself is KeePassXC.
        let r = decide(
            "org.gnome.TextEditor",
            Some(301),
            &scopes(),
            &keepass_denied(),
        );
        assert_eq!(
            r,
            Err(Refusal::Denied {
                app: "org.keepassxc.KeePassXC".into()
            })
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
        assert!(matches!(
            decide(
                "org.gnome.TextEditor",
                Some(100),
                &scopes(),
                &Deny::Everything
            ),
            Err(Refusal::Denied { .. })
        ));
    }
}
