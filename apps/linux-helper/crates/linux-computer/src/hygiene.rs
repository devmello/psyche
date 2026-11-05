//! Screenshot hygiene and Ask-about-my-screen rules (ports of `CaptureHygiene.swift` and
//! `ScreenAsk.swift`), plus the coordinate math every capture path needs.
//!
//! **Coordinates.** Screen points are pixels of the whole display area (X11: the root window;
//! Wayland: the logical coordinate space of the portal stream, origin at the top-left of the
//! stream's bounding box). A screenshot's `pointsPerPixel` maps image pixels back to those.

use crate::snapshot::Rect;
use crate::tiers::{fixed_caps, Tier, TierPolicy, TierSettings};
use unicode_segmentation::UnicodeSegmentation;

/// Default longest-edge bounds (the Claude app downsizes 3456×2234 to about 1372×887).
pub const DEFAULT_MAX_WIDTH: u32 = 1372;
pub const DEFAULT_MAX_HEIGHT: u32 = 887;
/// Encoded image budget so a result stays far below the 1 MiB frame limit after base64.
pub const MAX_ENCODED_BYTES: usize = 600_000;
pub const JPEG_QUALITY_LADDER: [f32; 4] = [0.75, 0.6, 0.45, 0.3];

#[derive(Debug, Clone, PartialEq)]
pub struct AppRef {
    pub app_id: Option<String>,
    pub pid: u32,
}

/// Pids whose windows must be left out of a capture: Psyche, terminals/IDEs, password managers,
/// finance, and every app whose tier is Off (unknown apps in `ask` count as Off until approved),
/// except the shell processes that draw shared chrome.
pub fn excluded_pids(running: &[AppRef], own_pid: u32, policy: &TierPolicy) -> std::collections::HashSet<u32> {
    use fixed_caps::Category::*;
    let mut out = std::collections::HashSet::from([own_pid]);
    for app in running {
        match fixed_caps::category(app.app_id.as_deref()) {
            Some(Psyche | TerminalOrIde | PasswordManager | Finance) => {
                out.insert(app.pid);
            }
            _ => {
                if policy.effective_tier(app.app_id.as_deref()) == Tier::Off && !is_system_ui(app.app_id.as_deref()) {
                    out.insert(app.pid);
                }
            }
        }
    }
    out
}

/// Shell processes that draw shared chrome; excluding them blanks the desktop.
pub fn is_system_ui(app_id: Option<&str>) -> bool {
    let Some(id) = app_id else { return true };
    ["gnome-shell", "org.gnome.shell", "plasmashell", "org.kde.plasmashell", "xfdesktop", "pcmanfm", "nemo-desktop", "mutter", "kwin_x11", "kwin_wayland"]
        .iter()
        .any(|s| s.eq_ignore_ascii_case(id))
}

/// Output size that fits `max_w`×`max_h`, preserving aspect ratio, never upscaling.
pub fn scaled_size(width: u32, height: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (0, 0);
    }
    let scale = 1f64.min((max_w as f64 / width as f64).min(max_h as f64 / height as f64));
    (((width as f64 * scale).round() as u32).max(1), ((height as f64 * scale).round() as u32).max(1))
}

/// Absolute pointer coordinates for a portal stream: `x`/`y` in screen points relative to the
/// stream's top-left corner at `origin`, clamped to the stream's size `(w, h)`.
pub fn stream_relative(x: f64, y: f64, origin: (f64, f64), size: (f64, f64)) -> (f64, f64) {
    ((x - origin.0).clamp(0.0, (size.0 - 1.0).max(0.0)), (y - origin.1).clamp(0.0, (size.1 - 1.0).max(0.0)))
}

/// `rect` minus every rectangle in `covers`: the parts of a window nothing in front of it hides.
pub fn visible_parts(rect: Rect, covers: &[Rect]) -> Vec<Rect> {
    let mut parts = vec![rect];
    for c in covers {
        let mut next = Vec::new();
        for p in parts {
            next.extend(subtract(p, *c));
        }
        parts = next;
        if parts.is_empty() {
            break;
        }
    }
    parts
}

fn subtract(a: Rect, b: Rect) -> Vec<Rect> {
    let Some(i) = a.intersection(&b).filter(|i| i.w > 0.0 && i.h > 0.0) else { return vec![a] };
    let mut out = Vec::with_capacity(4);
    if i.y > a.y {
        out.push(Rect::new(a.x, a.y, a.w, i.y - a.y)); // above
    }
    if i.max_y() < a.max_y() {
        out.push(Rect::new(a.x, i.max_y(), a.w, a.max_y() - i.max_y())); // below
    }
    if i.x > a.x {
        out.push(Rect::new(a.x, i.y, i.x - a.x, i.h)); // left
    }
    if i.max_x() < a.max_x() {
        out.push(Rect::new(i.max_x(), i.y, a.max_x() - i.max_x(), i.h)); // right
    }
    out
}

/// A window on screen, front to back.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowRef {
    pub id: u64,
    /// The app's pid.
    pub pid: u32,
    /// Normal (0) or floating / topmost (1): the Mac's window layer.
    pub layer: i32,
    pub bounds: Rect,
    pub alpha: f64,
}

/// Rectangles to black out of a monitor capture: the visible parts of windows owned by an
/// excluded pid, front to back (what is in front of an excluded window stays visible).
pub fn redactions(windows: &[WindowRef], excluded: &std::collections::HashSet<u32>, area: Rect) -> Vec<Rect> {
    let mut covered: Vec<Rect> = Vec::new();
    let mut out = Vec::new();
    for w in windows {
        let Some(b) = w.bounds.intersection(&area).filter(|b| b.w > 0.0 && b.h > 0.0) else { continue };
        if excluded.contains(&w.pid) {
            out.extend(visible_parts(b, &covered));
        }
        if w.alpha > 0.0 {
            covered.push(b);
        }
    }
    out
}

/// Ask about my screen (docs/design/screen-ask-2026.md §3.1).
pub mod screen_ask {
    use super::*;

    /// Longest selected text a capture carries (`SCREEN_SELECTED_TEXT_MAX`).
    pub const MAX_SELECTED_TEXT: usize = 4_000;
    pub const MAX_URL_LENGTH: usize = 2_048;
    /// Default output bounds: 1600 px on the long side (spec §3.1).
    pub const DEFAULT_MAX_WIDTH: u32 = 1_600;
    pub const DEFAULT_MAX_HEIGHT: u32 = 1_600;
    /// Windows smaller than this (tooltips, badges) are never the target.
    pub const MIN_WINDOW_SIDE: f64 = 40.0;

    /// Whether this app is never captured for an ask: Psyche, password managers, finance and
    /// system-authority apps, and any app the owner set to Off by name.
    pub fn is_excluded(app_id: Option<&str>, settings: &TierSettings) -> bool {
        use fixed_caps::Category::*;
        if matches!(fixed_caps::category(app_id), Some(Psyche | PasswordManager | Finance | SystemAuthority)) {
            return true;
        }
        let Some(id) = app_id else { return false };
        settings.explicit(id) == Some(crate::tiers::SettingValue::Off)
    }

    /// The window the owner is looking at: the frontmost normal window that isn't Psyche's own.
    pub fn target_window<'a>(windows: &'a [WindowRef], psyche_pids: &std::collections::HashSet<u32>) -> Option<&'a WindowRef> {
        windows.iter().find(|w| {
            w.layer == 0 && w.alpha > 0.0 && !psyche_pids.contains(&w.pid) && w.bounds.w >= MIN_WINDOW_SIDE && w.bounds.h >= MIN_WINDOW_SIDE
        })
    }

    /// The frontmost window under a point (region mode's text context).
    pub fn window_at<'a>(x: f64, y: f64, windows: &'a [WindowRef], psyche_pids: &std::collections::HashSet<u32>) -> Option<&'a WindowRef> {
        windows.iter().find(|w| w.layer == 0 && w.alpha > 0.0 && !psyche_pids.contains(&w.pid) && w.bounds.contains(x, y))
    }

    /// The display that holds most of `rect`, and `rect` clipped to it in display-local
    /// coordinates. `None` when the box misses every display or is too small to read.
    pub fn region(rect: Rect, displays: &[Rect]) -> Option<(usize, Rect)> {
        let r = standardized(rect);
        let mut best: Option<(usize, Rect, f64)> = None;
        for (i, d) in displays.iter().enumerate() {
            let Some(clip) = r.intersection(d) else { continue };
            if clip.w < 8.0 || clip.h < 8.0 {
                continue;
            }
            let area = clip.w * clip.h;
            if best.map(|b| area > b.2).unwrap_or(true) {
                best = Some((i, clip, area));
            }
        }
        let (i, clip, _) = best?;
        let d = displays[i];
        Some((i, Rect::new(clip.x - d.x, clip.y - d.y, clip.w, clip.h)))
    }

    fn standardized(r: Rect) -> Rect {
        let (x, w) = if r.w < 0.0 { (r.x + r.w, -r.w) } else { (r.x, r.w) };
        let (y, h) = if r.h < 0.0 { (r.y + r.h, -r.h) } else { (r.y, r.h) };
        Rect::new(x, y, w, h)
    }

    /// Selected text: trimmed, at most `MAX_SELECTED_TEXT` characters.
    pub fn selection(raw: Option<&str>) -> Option<String> {
        let s = raw?.trim();
        if s.is_empty() {
            return None;
        }
        if s.graphemes(true).count() > MAX_SELECTED_TEXT {
            return Some(s.graphemes(true).take(MAX_SELECTED_TEXT).collect());
        }
        Some(s.to_string())
    }

    /// A browser URL worth sending: http(s) only, without credentials, at most 2048 characters.
    pub fn url(raw: Option<&str>) -> Option<String> {
        let raw = raw?.trim();
        let (scheme, rest) = raw.split_once("://")?;
        let scheme_l = scheme.to_ascii_lowercase();
        if scheme_l != "http" && scheme_l != "https" {
            return None;
        }
        let (authority, tail) = match rest.find(['/', '?', '#']) {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        };
        let host_port = match authority.rfind('@') {
            Some(i) => &authority[i + 1..],
            None => authority,
        };
        if host_port.is_empty() || host_port.starts_with(':') || raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return None;
        }
        let s = format!("{scheme}://{host_port}{tail}");
        (s.chars().count() <= MAX_URL_LENGTH).then_some(s)
    }

    /// A window title worth sending (some apps report "" or whitespace).
    pub fn title(raw: Option<&str>) -> Option<String> {
        let s = raw?.trim();
        if s.is_empty() {
            return None;
        }
        Some(s.graphemes(true).take(512).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::screen_ask::*;
    use super::*;
    use serde_json::json;
    use std::collections::HashSet;

    #[test]
    fn scaled_size_never_upscales() {
        assert_eq!(scaled_size(3840, 2160, 1372, 887), (1372, 772));
        assert_eq!(scaled_size(800, 600, 1372, 887), (800, 600));
        assert_eq!(scaled_size(1000, 4000, 1600, 1600), (400, 1600));
        assert_eq!(scaled_size(0, 10, 100, 100), (0, 0));
    }

    #[test]
    fn stream_points_clamp_to_the_stream() {
        assert_eq!(stream_relative(100.0, 50.0, (0.0, 0.0), (1920.0, 1080.0)), (100.0, 50.0));
        assert_eq!(stream_relative(2000.0, -5.0, (0.0, 0.0), (1920.0, 1080.0)), (1919.0, 0.0));
        assert_eq!(stream_relative(1920.0, 10.0, (1920.0, 0.0), (1280.0, 720.0)), (0.0, 10.0));
    }

    #[test]
    fn visible_parts_subtract_covering_windows() {
        let parts = visible_parts(Rect::new(0., 0., 100., 100.), &[Rect::new(50., 0., 50., 100.)]);
        assert_eq!(parts, vec![Rect::new(0., 0., 50., 100.)]);
        let parts = visible_parts(Rect::new(0., 0., 100., 100.), &[Rect::new(25., 25., 50., 50.)]);
        let area: f64 = parts.iter().map(|r| r.w * r.h).sum();
        assert_eq!(area, 10_000.0 - 2_500.0);
        assert!(visible_parts(Rect::new(10., 10., 10., 10.), &[Rect::new(0., 0., 100., 100.)]).is_empty());
    }

    #[test]
    fn redactions_spare_what_is_in_front() {
        let w = |pid, x| WindowRef { id: pid as u64, pid, layer: 0, bounds: Rect::new(x, 0., 100., 100.), alpha: 1.0 };
        // Front: app 1 at x=0; behind: terminal (pid 2) at x=50.
        let windows = vec![w(1, 0.), w(2, 50.)];
        let red = redactions(&windows, &HashSet::from([2]), Rect::new(0., 0., 1000., 1000.));
        assert_eq!(red, vec![Rect::new(100., 0., 50., 100.)]);
    }

    #[test]
    fn excluded_pids_follow_caps_and_tiers() {
        let policy = TierPolicy::new(TierSettings::from_json(&json!({"default": "ask", "apps": {"org.gnome.TextEditor": "read"}})), None, None);
        let running = vec![
            AppRef { app_id: Some("org.gnome.TextEditor".into()), pid: 10 },
            AppRef { app_id: Some("gnome-terminal".into()), pid: 11 },
            AppRef { app_id: Some("unknown-app".into()), pid: 12 },
            AppRef { app_id: Some("gnome-shell".into()), pid: 13 },
            AppRef { app_id: Some("keepassxc".into()), pid: 14 },
            AppRef { app_id: Some("org.gnome.seahorse.Application".into()), pid: 15 },
        ];
        let ex = excluded_pids(&running, 1, &policy);
        assert_eq!(ex, HashSet::from([1, 11, 12, 14, 15]));
    }

    #[test]
    fn screen_ask_rules() {
        let s = TierSettings::from_json(&json!({"apps": {"gimp": "off", "org.gnome.TextEditor": "interact"}}));
        assert!(is_excluded(Some("keepassxc"), &s));
        assert!(is_excluded(Some("GIMP"), &s));
        assert!(!is_excluded(Some("org.gnome.TextEditor"), &s));
        assert!(!is_excluded(Some("unknown"), &s), "ask is about acting, not capture");
        assert!(!is_excluded(Some("firefox"), &s));
        let w = |id, pid, layer, x, size| WindowRef { id, pid, layer, bounds: Rect::new(x, 0., size, size), alpha: 1.0 };
        let windows = vec![w(1, 7, 0, 0., 500.), w(2, 8, 1, 0., 500.), w(3, 9, 0, 0., 20.), w(4, 10, 0, 0., 500.)];
        let psyche = HashSet::from([7]);
        assert_eq!(target_window(&windows, &psyche).map(|w| w.id), Some(4));
        assert_eq!(window_at(10., 10., &windows, &psyche).map(|w| w.id), Some(3));
        let displays = [Rect::new(0., 0., 1920., 1080.), Rect::new(1920., 0., 2560., 1440.)];
        assert_eq!(region(Rect::new(1900., 10., 100., 100.), &displays), Some((1, Rect::new(0., 10., 80., 100.))));
        assert_eq!(region(Rect::new(5000., 5000., 10., 10.), &displays), None);
        assert_eq!(selection(Some("  hi \n")).as_deref(), Some("hi"));
        assert_eq!(selection(Some(&"x".repeat(5000))).unwrap().len(), 4000);
        let with_creds = format!("https://{}:{}@example.com/a?b#c", "user", "pw");
        assert_eq!(url(Some(&with_creds)).as_deref(), Some("https://example.com/a?b#c"));
        assert_eq!(url(Some("about:config")), None);
        assert_eq!(title(Some("   ")), None);
    }
}
