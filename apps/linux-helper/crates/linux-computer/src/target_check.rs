//! `computer.check_target` (teach by showing, replay): the accessibility twin of the browser's
//! `browser.check_target`, a port of the mac helper's `AXTargetCheck`. A replayed step names its
//! target by the role and name it was recorded with; this looks that up in a fresh snapshot by
//! **exact role and name** (ignoring case and spacing) and answers `found` (one match, with its
//! ref), `missing` or `ambiguous`. It is read-only and deterministic. Anything but `found`
//! carries `stop`, and the skill tells the agent to stop and ask the owner. A similar-looking
//! element is not the same element.

use crate::snapshot::SnapshotNode;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query {
    /// A role as the recording keeps it (`button`, `textbox`, `menuitem`); `generic` or `None` matches any.
    pub role: Option<String>,
    pub name: Option<String>,
    /// The element's automation id (the recording's `identifier:` fallback).
    pub identifier: Option<String>,
    /// For a menu choice: titles from the menu bar down ("File", "Export").
    pub menu_path: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Found {
        ref_: String,
        role: String,
        label: Option<String>,
    },
    Missing,
    Ambiguous(Vec<String>),
}

impl Outcome {
    pub fn status(&self) -> &'static str {
        match self {
            Outcome::Found { .. } => "found",
            Outcome::Missing => "missing",
            Outcome::Ambiguous(_) => "ambiguous",
        }
    }
}

/// Lowercased, whitespace collapsed, a truncation suffix (`…(+N)`) dropped.
pub fn norm(s: Option<&str>) -> String {
    let Some(s) = s else { return String::new() };
    let base = s.find("…(+").map_or(s, |i| &s[..i]);
    base.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// A snapshot node's role (`textfield`, `button:closeButton`, `popupbutton`) as the recording's role
/// (`policy::roles::map` in the helper, over the same vocabulary).
pub fn recorded_role(snapshot_role: &str) -> &'static str {
    let base = snapshot_role.split(':').next().unwrap_or(snapshot_role);
    match base {
        "button" | "menubutton" | "disclosuretriangle" => "button",
        "textfield" if snapshot_role.contains(":searchField") => "searchbox",
        "textfield" | "textarea" | "securetextfield" => "textbox",
        "searchfield" => "searchbox",
        "combobox" | "popupbutton" => "combobox",
        "checkbox" => {
            if snapshot_role.to_lowercase().contains("switch") {
                "switch"
            } else {
                "checkbox"
            }
        }
        "radiobutton" => "radio",
        "menuitem" | "menubaritem" => "menuitem",
        "link" => "link",
        "slider" => "slider",
        "row" => "row",
        "cell" => "cell",
        "tabgroup" => "tablist",
        "table" | "outline" => "table",
        "toolbar" => "toolbar",
        "list" => "list",
        "image" => "img",
        _ => "generic",
    }
}

pub fn check(nodes: &[SnapshotNode], q: &Query) -> Outcome {
    if !q.menu_path.is_empty() {
        return check_menu(nodes, &q.menu_path);
    }
    let want_name = norm(q.name.as_deref());
    let want_id = q
        .identifier
        .as_deref()
        .map(|i| i.replace("identifier:", ""));
    if want_name.is_empty() && want_id.is_none() {
        return Outcome::Missing;
    }
    let any_role = q
        .role
        .as_deref()
        .map_or(true, |r| r.is_empty() || r == "generic");
    let hits: Vec<&SnapshotNode> = nodes
        .iter()
        .filter(|n| {
            // A secure field is never a replay target: the owner types those themselves.
            if n.role.to_lowercase().contains("securetextfield")
                || n.flags.iter().any(|f| f == "secure")
            {
                return false;
            }
            if !any_role && Some(recorded_role(&n.role)) != q.role.as_deref() {
                return false;
            }
            if !want_name.is_empty() && norm(n.label.as_deref()) != want_name {
                return false;
            }
            want_id
                .as_ref()
                .map_or(true, |id| n.id.as_deref() == Some(id.as_str()))
        })
        .collect();
    outcome(&hits)
}

/// The menu item whose chain of ancestors' titles is the path, exactly.
pub fn check_menu(nodes: &[SnapshotNode], path: &[String]) -> Outcome {
    let by_ref: std::collections::HashMap<&str, &SnapshotNode> =
        nodes.iter().map(|n| (n.ref_.as_str(), n)).collect();
    let want: Vec<String> = path.iter().map(|p| norm(Some(p))).collect();
    let Some(last) = want.last().filter(|l| !l.is_empty()) else {
        return Outcome::Missing;
    };
    let hits: Vec<&SnapshotNode> = nodes
        .iter()
        .filter(|n| {
            if recorded_role(&n.role) != "menuitem" || norm(n.label.as_deref()) != *last {
                return false;
            }
            // Walk up through menu items / bar items; menus themselves carry no title of their own.
            let mut chain = vec![norm(n.label.as_deref())];
            let mut cursor = n.parent.as_deref().and_then(|p| by_ref.get(p).copied());
            while let Some(c) = cursor {
                if recorded_role(&c.role) == "menuitem" {
                    chain.insert(0, norm(c.label.as_deref()));
                }
                cursor = c.parent.as_deref().and_then(|p| by_ref.get(p).copied());
            }
            chain == want
        })
        .collect();
    outcome(&hits)
}

fn outcome(hits: &[&SnapshotNode]) -> Outcome {
    match hits {
        [] => Outcome::Missing,
        [one] => Outcome::Found {
            ref_: one.ref_.clone(),
            role: one.role.clone(),
            label: one.label.clone(),
        },
        many => Outcome::Ambiguous(many.iter().take(5).map(|n| n.ref_.clone()).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(
        ref_: &str,
        role: &str,
        label: Option<&str>,
        id: Option<&str>,
        parent: Option<&str>,
        flags: &[&str],
    ) -> SnapshotNode {
        SnapshotNode {
            ref_: ref_.into(),
            role: role.into(),
            label: label.map(str::to_owned),
            value: None,
            placeholder: None,
            url: None,
            id: id.map(str::to_owned),
            actions: vec![],
            flags: flags.iter().map(|f| (*f).to_owned()).collect(),
            frame: None,
            depth: 0,
            parent: parent.map(str::to_owned),
        }
    }

    fn q(role: Option<&str>, name: Option<&str>) -> Query {
        Query {
            role: role.map(str::to_owned),
            name: name.map(str::to_owned),
            ..Default::default()
        }
    }

    #[test]
    fn exact_role_and_name_found_missing_ambiguous() {
        let nodes = vec![
            node(
                "e1",
                "button",
                Some("New Message"),
                Some("newMessage"),
                None,
                &[],
            ),
            node("e2", "textfield", Some("Subject"), None, None, &[]),
            node("e3", "button", Some("Archive"), None, None, &[]),
            node("e4", "button", Some("Archive"), None, None, &[]),
            node("e5", "link", Some("  new   MESSAGE "), None, None, &[]),
        ];
        let found = check(&nodes, &q(Some("button"), Some("new message")));
        assert_eq!(
            found,
            Outcome::Found {
                ref_: "e1".into(),
                role: "button".into(),
                label: Some("New Message".into())
            }
        );
        // The same name with another role is another element.
        assert_eq!(
            check(&nodes, &q(Some("link"), Some("New Message"))).status(),
            "found"
        );
        assert_eq!(
            check(&nodes, &q(Some("checkbox"), Some("New Message"))),
            Outcome::Missing
        );
        // A similar-looking element is not the same element.
        assert_eq!(
            check(&nodes, &q(Some("button"), Some("New Messages"))),
            Outcome::Missing
        );
        assert_eq!(
            check(&nodes, &q(Some("button"), Some("Archive"))),
            Outcome::Ambiguous(vec!["e3".into(), "e4".into()])
        );
        // `generic` or no role matches any role.
        assert_eq!(
            check(&nodes, &q(Some("generic"), Some("Subject"))).status(),
            "found"
        );
        // Nothing to look by.
        assert_eq!(check(&nodes, &q(Some("button"), None)), Outcome::Missing);
    }

    #[test]
    fn identifier_matches_and_narrows() {
        let nodes = vec![
            node("e1", "button", Some("Go"), Some("goButton"), None, &[]),
            node("e2", "button", Some("Go"), Some("other"), None, &[]),
        ];
        let by_id = Query {
            role: Some("button".into()),
            identifier: Some("identifier:goButton".into()),
            ..Default::default()
        };
        assert_eq!(check(&nodes, &by_id).status(), "found");
        let both = Query {
            role: Some("button".into()),
            name: Some("Go".into()),
            identifier: Some("goButton".into()),
            ..Default::default()
        };
        assert_eq!(
            check(&nodes, &both),
            Outcome::Found {
                ref_: "e1".into(),
                role: "button".into(),
                label: Some("Go".into())
            }
        );
    }

    #[test]
    fn a_secure_field_is_never_a_target() {
        let nodes = vec![
            node("e1", "securetextfield", Some("Password"), None, None, &[]),
            node(
                "e2",
                "textfield:secureTextField",
                Some("PIN"),
                None,
                None,
                &["secure"],
            ),
        ];
        assert_eq!(
            check(&nodes, &q(Some("textbox"), Some("Password"))),
            Outcome::Missing
        );
        assert_eq!(check(&nodes, &q(None, Some("PIN"))), Outcome::Missing);
    }

    #[test]
    fn truncated_labels_compare_by_their_visible_part() {
        let nodes = vec![node(
            "e1",
            "button",
            Some("Export to a very long…(+12)"),
            None,
            None,
            &[],
        )];
        assert_eq!(
            check(&nodes, &q(Some("button"), Some("export to a very long"))).status(),
            "found"
        );
    }

    #[test]
    fn recorded_roles_follow_the_recordings_fixed_list() {
        for (snap, rec) in [
            ("button", "button"),
            ("button:closeButton", "button"),
            ("textfield", "textbox"),
            ("textfield:searchField", "searchbox"),
            ("textarea", "textbox"),
            ("popupbutton", "combobox"),
            ("checkbox:switch", "switch"),
            ("checkbox:toggle", "checkbox"),
            ("menubaritem", "menuitem"),
            ("row:outlineRow", "row"),
            ("incrementor", "generic"),
        ] {
            assert_eq!(recorded_role(snap), rec, "{snap}");
        }
    }

    #[test]
    fn a_menu_path_must_match_the_whole_chain() {
        let nodes = vec![
            node("e1", "menubaritem", Some("File"), None, None, &[]),
            node("e2", "menuitem", Some("Export"), None, Some("e1"), &[]),
            node("e3", "menuitem", Some("PDF"), None, Some("e2"), &[]),
            node("e4", "menubaritem", Some("Edit"), None, None, &[]),
            node("e5", "menuitem", Some("Export"), None, Some("e4"), &[]),
        ];
        let path = |p: &[&str]| Query {
            menu_path: p.iter().map(|s| (*s).to_owned()).collect(),
            ..Default::default()
        };
        assert_eq!(check(&nodes, &path(&["File", "Export"])).status(), "found");
        assert_eq!(
            check(&nodes, &path(&["file", "export", "pdf"])).status(),
            "found"
        );
        // "Export" under another menu is another item; the bare name is ambiguous across menus.
        assert_eq!(
            check(&nodes, &path(&["Edit", "Export"])),
            Outcome::Found {
                ref_: "e5".into(),
                role: "menuitem".into(),
                label: Some("Export".into())
            }
        );
        assert_eq!(check(&nodes, &path(&["View", "Export"])), Outcome::Missing);
        assert_eq!(check(&nodes, &path(&["Export"])), Outcome::Missing);
    }
}
