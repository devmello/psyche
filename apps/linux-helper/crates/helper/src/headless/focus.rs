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

/// Where processes belong: which app's launch scope holds a pid.
pub trait Scopes {
    /// Whether `pid` runs in the scope of an app launched here as `app_id`.
    fn in_scope(&self, app_id: &str, pid: u32) -> bool;
    /// The app (desktop id) whose scope holds `pid`.
    fn app_of(&self, pid: u32) -> Option<String>;
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

/// Whether input may go to `target` (a desktop id) when the focused window's client is
/// `focus_pid`. The deny list is checked first and for both the target and the app that really
/// holds the focus: a denied app never receives input, even when the agent named another app and
/// the focus moved there.
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
    if let Some(app) = holder.as_deref().filter(|a| deny.is_denied(a)) {
        return Err(Refusal::Denied {
            app: app.to_string(),
        });
    }
    if scopes.in_scope(target, pid) {
        Ok(())
    } else {
        Err(Refusal::Moved { other: holder })
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

    /// pid → app id.
    struct Fake(HashMap<u32, &'static str>);

    impl Scopes for Fake {
        fn in_scope(&self, app_id: &str, pid: u32) -> bool {
            self.0
                .get(&pid)
                .is_some_and(|a| a.eq_ignore_ascii_case(app_id))
        }
        fn app_of(&self, pid: u32) -> Option<String> {
            self.0.get(&pid).map(|a| a.to_string())
        }
    }

    fn scopes() -> Fake {
        Fake(HashMap::from([
            (100, "org.gnome.TextEditor"),
            (101, "org.gnome.TextEditor"), // a child process in the same scope
            (200, "org.mozilla.firefox"),
            (300, "org.keepassxc.KeePassXC"),
        ]))
    }

    fn keepass_denied() -> Deny {
        Deny::Some(vec!["org.keepassxc.keepassxc".into()])
    }

    #[test]
    fn typing_goes_to_the_apps_own_window_and_its_scope_children() {
        let s = scopes();
        let n = Deny::Nothing;
        assert_eq!(decide("org.gnome.TextEditor", Some(100), &s, &n), Ok(()));
        assert_eq!(decide("org.gnome.texteditor", Some(101), &s, &n), Ok(()));
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
        let e = to_error(
            &r.unwrap_err(),
            &AppInfo {
                id: "org.gnome.texteditor".into(),
                name: "Text Editor".into(),
                pid: 100,
                electron: false,
                frontmost: true,
                windows: 1,
            },
        );
        assert_eq!((e.code, e.reason.as_str()), ("conflict", "focus_moved"));
        assert!(e.retryable);
    }

    #[test]
    fn typing_is_refused_for_a_window_that_belongs_to_no_launched_app() {
        // A client on the display we did not launch (or a process that left its scope).
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
        // The agent means the editor, the focus is in the denied app: refused as denied, not
        // as an ordinary focus change that a retry might fix.
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
        // Even when the focus is right: the denied app itself.
        let r = decide(
            "org.keepassxc.KeePassXC",
            Some(300),
            &scopes(),
            &keepass_denied(),
        );
        assert!(matches!(r, Err(Refusal::Denied { .. })));
        let e = to_error(
            &r.unwrap_err(),
            &AppInfo {
                id: "org.keepassxc.keepassxc".into(),
                name: "KeePassXC".into(),
                pid: 300,
                electron: false,
                frontmost: true,
                windows: 1,
            },
        );
        assert_eq!((e.code, e.reason.as_str()), ("policy_denied", "app_denied"));
        assert!(!e.retryable);
    }

    #[test]
    fn the_deny_list_does_not_touch_other_apps() {
        // A near miss: same vendor prefix, not on the list.
        assert_eq!(
            decide(
                "org.gnome.TextEditor",
                Some(100),
                &scopes(),
                &keepass_denied()
            ),
            Ok(())
        );
        // A policy file that could not be read denies everything.
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
