//! The one Windows app identity: what the mac helper calls a bundle id, and what every
//! capability of the Windows helper reports as `bundleId` / `app` (`apps.*`, `computer.*`,
//! `screen.context`, `teach.*`, `dictation.*`, `chrome.*`). The Gateway matches approvals and
//! per-app tiers on it, so all of them must agree for the same window.
//!
//! **Rule.** The lowercase file name of the app process's executable: `notepad.exe`,
//! `calculatorapp.exe`, `chrome.exe`. A window belongs to the process that owns it, except the
//! frames `ApplicationFrameHost.exe` draws for packaged (UWP) apps (Calculator, Settings): those
//! belong to the hosted app's process (the frame's `Windows.UI.Core.CoreWindow`), never the host.
//!
//! AppUserModelIDs, package family names and full executable paths are reported next to the id
//! (`aumid`, `packageFamilyName`, `exe`), never as it.

/// The app id for an executable path (`C:\Windows\System32\notepad.exe` → `notepad.exe`).
pub fn app_id_from_exe(path: &str) -> Option<String> {
    let name = path.trim().trim_matches('"').rsplit(['\\', '/']).next()?.trim();
    (!name.is_empty()).then(|| name.to_lowercase())
}

/// Whether `query` names an app by its id (a plain executable file name, `notepad.exe`), as
/// opposed to a path, an AppUserModelID or a display name.
pub fn is_app_id(query: &str) -> bool {
    let q = query.trim();
    q.len() > 4 && q.to_lowercase().ends_with(".exe") && !q.contains(['\\', '/', '!', ':'])
}

/// The app process that owns a top-level window (the hosted app's for frame-host windows);
/// `None` when `hwnd` is not a window.
#[cfg(windows)]
pub fn app_pid_for_window(hwnd: isize) -> Option<u32> {
    crate::win::apps::app_pid_of(hwnd)
}

/// `top-level window → app pid` for every top-level window, from one z-order pass (cheaper than
/// [`app_pid_for_window`] per window when listing apps).
#[cfg(windows)]
pub fn app_pids_by_window() -> std::collections::HashMap<isize, u32> {
    crate::win::apps::app_pids_by_window()
}

/// The app id of a process (`None` when it is gone or its image path is unreadable).
#[cfg(windows)]
pub fn app_id_for_pid(pid: u32) -> Option<String> {
    crate::win::apps::exe_path(pid).and_then(|p| app_id_from_exe(&p))
}

/// The app id of the app that owns a top-level window.
#[cfg(windows)]
pub fn app_id_for_window(hwnd: isize) -> Option<String> {
    app_pid_for_window(hwnd).and_then(app_id_for_pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_lowercase_file_names() {
        assert_eq!(app_id_from_exe(r"C:\Windows\System32\notepad.exe").as_deref(), Some("notepad.exe"));
        assert_eq!(
            app_id_from_exe(r"C:\Program Files\WindowsApps\Microsoft.WindowsCalculator_11.2_x64__8wekyb3d8bbwe\CalculatorApp.exe")
                .as_deref(),
            Some("calculatorapp.exe")
        );
        assert_eq!(app_id_from_exe(r#""C:\Program Files\Code - Insiders\Code - Insiders.exe""#).as_deref(), Some("code - insiders.exe"));
        assert_eq!(app_id_from_exe("C:/tools/App.EXE").as_deref(), Some("app.exe"));
        assert_eq!(app_id_from_exe("chrome.exe").as_deref(), Some("chrome.exe"));
        assert_eq!(app_id_from_exe(r"C:\dir\"), None);
        assert_eq!(app_id_from_exe(""), None);
    }

    #[test]
    fn app_id_queries() {
        assert!(is_app_id("notepad.exe"));
        assert!(is_app_id("CalculatorApp.exe"));
        assert!(is_app_id("code - insiders.exe"));
        assert!(!is_app_id("notepad"));
        assert!(!is_app_id(".exe"));
        assert!(!is_app_id(r"C:\Windows\notepad.exe"));
        assert!(!is_app_id("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"));
    }

    #[cfg(windows)]
    #[test]
    fn own_process_id() {
        let me = app_id_for_pid(std::process::id()).unwrap();
        assert!(me.ends_with(".exe") && me == me.to_lowercase(), "{me}");
    }
}
