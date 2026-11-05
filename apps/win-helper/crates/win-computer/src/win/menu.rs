//! `computer.menu`: choose a menu-bar item by path (mac `AXEngine.pressMenu`).
//!
//! - **Win32 menu bars** (`GetMenu`): walked without opening anything, like the Mac. The app gets
//!   `WM_INITMENU` / `WM_INITMENUPOPUP` first (so it updates enabled states, as when a user opens
//!   the menu), the item's state is checked, and its command is posted as `WM_COMMAND`.
//! - **Other menu bars** (XAML, WPF, WinForms, Office ribbons' menus): UI Automation. Each
//!   intermediate item is expanded (ExpandCollapse) and the submenu's items are matched, then the
//!   last item is invoked; anything opened is collapsed again on failure.
//!
//! Each segment must match exactly one item: case-insensitive, `&` accelerators, the
//! tab-separated shortcut text and a trailing `…` / `...` ignored.

use super::apps::TargetApp;
use super::uia::Uia;
use crate::error::{code, CapError, CapResult};
use crate::roles::ct;
use serde_json::Value;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::*;

/// Normalized menu title.
pub fn norm(s: &str) -> String {
    let s = s.split('\t').next().unwrap_or("");
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                chars.next();
                out.push('&');
            }
            continue;
        }
        out.push(c);
    }
    out.to_lowercase().trim().replace('…', "").replace("...", "").trim().to_string()
}

fn not_found(name: &str, available: &[String], ambiguous: bool) -> CapError {
    let avail: Vec<Value> = available.iter().filter(|s| !s.is_empty()).take(30).map(|s| Value::String(s.clone())).collect();
    let _ = name;
    if ambiguous {
        CapError::new(code::CONFLICT, "menu_item_ambiguous", "A menu item in the path is ambiguous").detail("available", avail)
    } else {
        CapError::new(code::NOT_FOUND, "menu_item_not_found", "A menu item in the path was not found").detail("available", avail)
    }
}

/// Presses `path` in `hwnd`'s menu bar; returns the last item's title.
pub fn press_menu(u: &Uia, app: &TargetApp, hwnd: isize, path: &[String]) -> CapResult<String> {
    let h = super::apps::hwnd(hwnd);
    let menu = unsafe { GetMenu(h) };
    if !menu.0.is_null() && unsafe { GetMenuItemCount(Some(menu)) } > 0 {
        return win32_menu(hwnd, menu, path);
    }
    uia_menu(u, app, hwnd, path)
}

fn menu_text(menu: HMENU, pos: u32) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetMenuStringW(menu, pos, Some(&mut buf), MF_BYPOSITION) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn send_timeout(hwnd: isize, msg: u32, w: usize, l: isize) {
    let mut result = 0usize;
    unsafe {
        let _ = SendMessageTimeoutW(super::apps::hwnd(hwnd), msg, WPARAM(w), LPARAM(l), SMTO_ABORTIFHUNG, 500, Some(&mut result));
    }
}

fn win32_menu(hwnd: isize, bar: HMENU, path: &[String]) -> CapResult<String> {
    send_timeout(hwnd, WM_INITMENU, bar.0 as usize, 0);
    let mut current = bar;
    let mut title = String::new();
    for (i, name) in path.iter().enumerate() {
        let count = unsafe { GetMenuItemCount(Some(current)) }.max(0) as u32;
        let titles: Vec<String> = (0..count).map(|p| menu_text(current, p)).collect();
        let hits: Vec<u32> = (0..count).filter(|p| norm(&titles[*p as usize]) == norm(name)).collect();
        if hits.len() != 1 {
            let clean: Vec<String> = titles.iter().map(|t| t.split('\t').next().unwrap_or("").replace('&', "")).collect();
            return Err(not_found(name, &clean, hits.len() > 1));
        }
        let pos = hits[0];
        title = titles[pos as usize].split('\t').next().unwrap_or("").replace('&', "");
        let sub = unsafe { GetSubMenu(current, pos as i32) };
        if i + 1 < path.len() {
            if sub.0.is_null() {
                return Err(not_found(&path[i + 1], &[], false));
            }
            send_timeout(hwnd, WM_INITMENUPOPUP, sub.0 as usize, pos as isize);
            current = sub;
            continue;
        }
        if !sub.0.is_null() {
            return Err(CapError::new(
                code::CONFLICT,
                "menu_item_is_submenu",
                "The last menu item in the path opens a submenu; name an item inside it",
            ));
        }
        let state = unsafe { GetMenuState(current, pos, MF_BYPOSITION) };
        if state & (MF_GRAYED.0 | MF_DISABLED.0) != 0 {
            return Err(CapError::new(code::CONFLICT, "menu_item_disabled", "The menu item is disabled"));
        }
        let id = unsafe { GetMenuItemID(current, pos as i32) };
        if id == u32::MAX {
            return Err(CapError::unavailable("ax_error", "The menu item has no command"));
        }
        unsafe { PostMessageW(Some(super::apps::hwnd(hwnd)), WM_COMMAND, WPARAM(id as usize), LPARAM(0)) }
            .map_err(|_| CapError::unavailable("ax_error", "Posting the menu command failed"))?;
    }
    Ok(title)
}

struct Item {
    e: IUIAutomationElement,
    name: String,
    enabled: bool,
}

fn cached_name(e: &IUIAutomationElement) -> String {
    unsafe { e.CachedName() }.map(|s| s.to_string()).unwrap_or_default()
}

fn cached_ct(e: &IUIAutomationElement) -> i32 {
    unsafe { e.CachedControlType() }.map(|c| c.0).unwrap_or(0)
}

fn children(u: &Uia, e: &IUIAutomationElement) -> Vec<IUIAutomationElement> {
    unsafe {
        let Ok(fresh) = e.BuildUpdatedCache(&u.req_children) else { return Vec::new() };
        let Ok(arr) = fresh.GetCachedChildren() else { return Vec::new() };
        (0..arr.Length().unwrap_or(0)).filter_map(|i| arr.GetElement(i).ok()).collect()
    }
}

fn menu_items(u: &Uia, container: &IUIAutomationElement) -> Vec<Item> {
    let mut out = Vec::new();
    for c in children(u, container) {
        match cached_ct(&c) {
            ct::MENU_ITEM => {
                out.push(Item { name: cached_name(&c), enabled: unsafe { c.CachedIsEnabled() }.map(|b| b.as_bool()).unwrap_or(true), e: c })
            }
            // A submenu presented as a Menu child (Win32 popups, some XAML flyouts).
            ct::MENU | ct::GROUP => out.extend(menu_items(u, &c)),
            _ => {}
        }
    }
    out
}

fn find_all(u: &Uia, root: &IUIAutomationElement, control_type: i32) -> Vec<IUIAutomationElement> {
    unsafe {
        let mut v = windows::Win32::System::Variant::VARIANT::default();
        (*v.Anonymous.Anonymous).vt = windows::Win32::System::Variant::VT_I4;
        (*v.Anonymous.Anonymous).Anonymous.lVal = control_type;
        let Ok(cond) = u.auto.CreatePropertyCondition(UIA_ControlTypePropertyId, &v) else { return Vec::new() };
        let Ok(arr) = root.FindAllBuildCache(TreeScope_Descendants, &cond, &u.req_element) else { return Vec::new() };
        (0..arr.Length().unwrap_or(0)).filter_map(|i| arr.GetElement(i).ok()).collect()
    }
}

/// Items of the submenu `item` opened: its own children, a Menu in the window, or a popup
/// menu at the desktop root owned by the app.
fn submenu_items(u: &Uia, app: &TargetApp, root: &IUIAutomationElement, item: &IUIAutomationElement) -> Vec<Item> {
    let own = menu_items(u, item);
    if !own.is_empty() {
        return own;
    }
    for m in find_all(u, root, ct::MENU) {
        let items = menu_items(u, &m);
        if !items.is_empty() {
            return items;
        }
    }
    if let Ok(desktop) = unsafe { u.auto.GetRootElement() } {
        for c in children(u, &desktop) {
            let pid = unsafe { c.CachedProcessId() }.unwrap_or(0) as u32;
            if cached_ct(&c) == ct::MENU && app.owns(pid) {
                let items = menu_items(u, &c);
                if !items.is_empty() {
                    return items;
                }
            }
        }
    }
    Vec::new()
}

fn expand(e: &IUIAutomationElement) -> bool {
    unsafe {
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
            return p.Expand().is_ok();
        }
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
            return p.Invoke().is_ok();
        }
    }
    false
}

fn collapse(e: &IUIAutomationElement) {
    unsafe {
        if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
            let _ = p.Collapse();
        }
    }
}

fn uia_menu(u: &Uia, app: &TargetApp, hwnd: isize, path: &[String]) -> CapResult<String> {
    let root = unsafe { u.auto.ElementFromHandleBuildCache(super::apps::hwnd(hwnd), &u.req_element) }
        .map_err(|_| CapError::new(code::NOT_FOUND, "no_menu_bar", format!("{} has no menu bar", app.name)))?;
    let bar = find_all(u, &root, ct::MENU_BAR)
        .into_iter()
        .find(|b| unsafe { b.CachedAutomationId() }.map(|s| s != "SystemMenuBar").unwrap_or(true))
        .ok_or_else(|| CapError::new(code::NOT_FOUND, "no_menu_bar", format!("{} has no menu bar", app.name)))?;
    let mut items = menu_items(u, &bar);
    let mut opened: Vec<IUIAutomationElement> = Vec::new();
    let result = (|| -> CapResult<String> {
        for (i, name) in path.iter().enumerate() {
            let hits: Vec<&Item> = items.iter().filter(|it| norm(&it.name) == norm(name)).collect();
            if hits.len() != 1 {
                let names: Vec<String> = items.iter().map(|i| i.name.clone()).collect();
                return Err(not_found(name, &names, hits.len() > 1));
            }
            let hit = hits[0];
            let title = hit.name.clone();
            if i + 1 < path.len() {
                let e = hit.e.clone();
                if !expand(&e) {
                    return Err(CapError::unavailable("ax_error", "Opening the menu failed"));
                }
                opened.push(e.clone());
                let deadline = Instant::now() + Duration::from_millis(1500);
                loop {
                    let next = submenu_items(u, app, &root, &e);
                    if !next.is_empty() {
                        items = next;
                        break;
                    }
                    if Instant::now() > deadline {
                        return Err(not_found(&path[i + 1], &[], false));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                continue;
            }
            if !hit.enabled {
                return Err(CapError::new(code::CONFLICT, "menu_item_disabled", "The menu item is disabled"));
            }
            unsafe {
                let e = &hit.e;
                let ok = if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                    p.Invoke().is_ok()
                } else if let Ok(p) = e.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
                    p.DoDefaultAction().is_ok()
                } else if e.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId).is_ok() {
                    return Err(CapError::new(
                        code::CONFLICT,
                        "menu_item_is_submenu",
                        "The last menu item in the path opens a submenu; name an item inside it",
                    ));
                } else {
                    false
                };
                if !ok {
                    return Err(CapError::unavailable("ax_error", "Pressing the menu item failed"));
                }
            }
            return Ok(title);
        }
        Err(CapError::invalid_params("path is empty", Some("path")))
    })();
    if result.is_err() {
        for e in opened.iter().rev() {
            collapse(e);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::norm;

    #[test]
    fn menu_titles_normalize() {
        assert_eq!(norm("&File"), "file");
        assert_eq!(norm("Save &As...\tCtrl+Shift+S"), "save as");
        assert_eq!(norm("Fish && Chips"), "fish & chips");
        assert_eq!(norm(" Rename… "), "rename");
        assert_eq!(norm("Select all"), norm("SELECT ALL"));
    }
}
