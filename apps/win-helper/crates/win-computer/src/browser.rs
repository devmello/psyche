//! Open tabs of Chromium browsers (Google Chrome, Microsoft Edge, Brave) through UI Automation:
//! the Windows side of the mac helper's `chrome.tabs` / `chrome.current_tab` (AppleScript there).
//!
//! - **Windows** are the browsers' visible top-level windows in z-order, front first: window 0 is
//!   the frontmost browser window (the mac's `window 1`). Edge, Chrome and Brave are listed together;
//!   each tab says which `browser` it belongs to.
//! - **Titles** are the tab strip's `TabItem` names (horizontal or vertical tabs), in visual order.
//!   Chromium may append a status to a tab's name ("- Audio playing", "- Network error").
//! - **URLs**: UI Automation only exposes the *active* tab's page (its document's value, else the
//!   address bar), so only active tabs carry a `url`; every other tab has `url: ""`. The mac reads
//!   every tab's URL through AppleScript; Windows offers no equivalent without a browser extension.
//! - **current** marks the active tab of window 0, as on the Mac. `active` (Windows only) marks
//!   the selected tab of every window.
//!
//! The web page itself is never walked (the document subtree is skipped), so page content cannot
//! add fake tabs. Never launches a browser: no browser window, no tabs.

use crate::error::CapResult;
use crate::roles::ct;
use crate::snapshot::TreeSource;
use crate::win::apps::{self, WinInfo};
use crate::win::{com, uia};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Executable name → `browser` value.
pub const BROWSERS: &[(&str, &str)] = &[("chrome.exe", "chrome"), ("msedge.exe", "edge"), ("brave.exe", "brave")];

const PER_WINDOW: Duration = Duration::from_millis(2500);
const MAX_VISIT: usize = 1500;
const MAX_DEPTH: usize = 24;
/// Longer URLs (big `data:` pages) are not reported: they would not fit a frame.
pub const MAX_URL: usize = 8192;

/// One tab as the mac helper's `SafariTabRecord`, plus `browser` and `active`.
#[derive(Debug, Clone, PartialEq)]
pub struct Tab {
    pub window: usize,
    pub index: usize,
    pub title: String,
    pub url: String,
    pub current: bool,
    pub active: bool,
    pub browser: &'static str,
}

impl Tab {
    pub fn json(&self) -> Value {
        json!({
            "window": self.window, "index": self.index, "title": self.title, "url": self.url,
            "current": self.current, "active": self.active, "browser": self.browser,
        })
    }
}

/// A URL worth reporting: trimmed, no whitespace or control characters, no credentials, a
/// scheme, at most [`MAX_URL`] characters.
pub fn clean_url(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.chars().count() > MAX_URL || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let scheme_end = s.find(':')?;
    let scheme = &s[..scheme_end];
    if scheme.is_empty()
        || !scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    {
        return None;
    }
    // Drop `user:password@` from an authority.
    if let Some(rest) = s[scheme_end + 1..].strip_prefix("//") {
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        if let Some(at) = rest[..end].rfind('@') {
            return Some(format!("{scheme}://{}", &rest[at + 1..]));
        }
    }
    Some(s.to_string())
}

/// The address bar hides some schemes: `example.com/path` for https pages, `C:/dir/a.html` for
/// local files. Put them back.
fn address_url(v: &str) -> Option<String> {
    let v = v.trim();
    if v.is_empty() || v.contains(' ') {
        return None;
    }
    let b = v.as_bytes();
    if b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\') {
        return clean_url(&format!("file:///{}", v.replace('\\', "/")));
    }
    if v.contains("://") || v.starts_with("data:") || v.starts_with("about:") {
        return clean_url(v);
    }
    v.contains('.').then(|| format!("https://{v}")).and_then(|u| clean_url(&u))
}

/// A tab found in the strip: (top, left) when it has bounds, discovery order, name, selected.
type Found = (Option<(f64, f64)>, usize, String, bool);

/// Visual order: top to bottom, then left to right (horizontal and vertical tab strips).
fn order(mut found: Vec<Found>) -> Vec<(String, bool)> {
    found.sort_by(|a, b| match (a.0, b.0) {
        (Some((ay, ax)), Some((by, bx))) => ay.total_cmp(&by).then(ax.total_cmp(&bx)),
        _ => a.1.cmp(&b.1),
    });
    found.into_iter().map(|(_, _, t, s)| (t, s)).collect()
}

struct WindowTabs {
    tabs: Vec<(String, bool)>,
    url: Option<String>,
}

fn read_window(w: &WinInfo) -> CapResult<WindowTabs> {
    let (hwnd, pid) = (w.hwnd, w.pid);
    com::pool().run(PER_WINDOW + Duration::from_millis(500), move || {
        let u = uia::uia()?;
        let root = uia::element_for_window(&u, hwnd, pid).map_err(|e| uia::map_read_error(&e, "window", "The browser"))?;
        let source = uia::LiveSource::new(&u, Some(Instant::now() + PER_WINDOW), false);
        let mut queue = VecDeque::from([(root, 0usize)]);
        let mut visited = 0;
        let mut found = Vec::new();
        let (mut doc_url, mut address): (Option<String>, Option<String>) = (None, None);
        while let Some((n, depth)) = queue.pop_front() {
            if visited >= MAX_VISIT || source.should_stop() {
                break;
            }
            visited += 1;
            let Some(c) = source.computed(&n) else { continue };
            match c.facts.control_type {
                ct::DOCUMENT => {
                    // The page: its URL (active tab only), never its content.
                    if doc_url.is_none() && !c.offscreen {
                        doc_url = c.info.url.as_deref().and_then(clean_url);
                    }
                    continue;
                }
                ct::TAB_ITEM => {
                    let title = c.info.title.clone().unwrap_or_default();
                    let selected = c.info.value.as_deref() == Some("1");
                    let pos = c.info.frame.filter(|f| f.is_finite()).map(|f| (f.y, f.x));
                    found.push((pos, found.len(), title, selected));
                    continue;
                }
                ct::EDIT if address.is_none() => {
                    address = c.info.value.as_deref().and_then(address_url);
                }
                _ => {}
            }
            if depth < MAX_DEPTH {
                for k in source.children(&n) {
                    queue.push_back((k, depth + 1));
                }
            }
        }
        Ok(WindowTabs { tabs: order(found), url: doc_url.or(address) })
    })
}

/// Visible top-level windows of the supported browsers, front first.
pub fn browser_windows() -> Vec<(WinInfo, &'static str)> {
    let mut out = Vec::new();
    for w in apps::top_windows() {
        if w.layer() != 0 || w.class != "Chrome_WidgetWin_1" || w.title.trim().is_empty() {
            continue;
        }
        let Some(exe) = apps::app_for_window(&w).and_then(|a| a.bundle_id) else { continue };
        if let Some((_, b)) = BROWSERS.iter().find(|(e, _)| *e == exe) {
            out.push((w, *b));
        }
    }
    out
}

/// Every tab of every supported browser window. Empty when none is open.
pub fn tabs() -> Vec<Tab> {
    com::ensure_dpi_awareness();
    let mut out = Vec::new();
    for (wi, (w, browser)) in browser_windows().into_iter().enumerate() {
        let Ok(read) = read_window(&w) else { continue };
        for (i, (title, active)) in read.tabs.into_iter().enumerate() {
            let url = if active { read.url.clone().unwrap_or_default() } else { String::new() };
            out.push(Tab { window: wi, index: i, title, url, current: wi == 0 && active, active, browser });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(clean_url(" https://example.com/a?b#c ").as_deref(), Some("https://example.com/a?b#c"));
        assert_eq!(clean_url("https://user:pw@example.com/x").as_deref(), Some("https://example.com/x"));
        assert_eq!(clean_url("file:///C:/tmp/a.html").as_deref(), Some("file:///C:/tmp/a.html"));
        assert_eq!(clean_url("data:text/html,<p>hi</p>").as_deref(), Some("data:text/html,<p>hi</p>"));
        assert_eq!(clean_url("edge://newtab/").as_deref(), Some("edge://newtab/"));
        assert_eq!(clean_url("no scheme"), None);
        assert_eq!(clean_url("example.com"), None);
        assert_eq!(clean_url("1http://x"), None);
        assert_eq!(clean_url(&format!("data:,{}", "a".repeat(MAX_URL))), None);
        assert_eq!(address_url("example.com/path").as_deref(), Some("https://example.com/path"));
        assert_eq!(address_url("about:blank").as_deref(), Some("about:blank"));
        assert_eq!(address_url("C:/Users/a/tab.html").as_deref(), Some("file:///C:/Users/a/tab.html"));
        assert_eq!(address_url(r"D:\x\y.html").as_deref(), Some("file:///D:/x/y.html"));
        assert_eq!(address_url("data:text/html,<p>c</p>").as_deref(), Some("data:text/html,<p>c</p>"));
        assert_eq!(address_url("Search Google or type a URL"), None);
        assert_eq!(address_url(""), None);
    }

    #[test]
    fn visual_order() {
        let horizontal = vec![(Some((5.0, 300.0)), 0, "b".to_string(), false), (Some((5.0, 10.0)), 1, "a".into(), true)];
        assert_eq!(order(horizontal), vec![("a".to_string(), true), ("b".to_string(), false)]);
        let vertical = vec![(Some((90.0, 0.0)), 0, "y".to_string(), false), (Some((40.0, 0.0)), 1, "x".into(), false)];
        assert_eq!(order(vertical)[0].0, "x");
        let unknown = vec![(None, 0, "p".to_string(), false), (None, 1, "q".into(), false)];
        assert_eq!(order(unknown)[1].0, "q");
    }
}
