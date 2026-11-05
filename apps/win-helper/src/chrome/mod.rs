//! `chrome.tabs` / `chrome.current_tab`: open tabs of Google Chrome, Microsoft Edge and Brave,
//! read through UI Automation (`psyche_win_computer::browser`); the mac helper reads Chrome via
//! AppleScript. Same names, side effect and result shapes (`{tabs: [SafariTabRecord]}`,
//! `{tab}`, `provenance: "untrusted"`), with these Windows differences:
//!
//! - All three browsers are listed; each tab adds `browser` (`chrome` | `edge` | `brave`) and
//!   `active` (the selected tab of its window). `window` 0 is the frontmost browser window.
//! - Only active tabs carry a `url`: UI Automation exposes no URL for background tabs, so theirs
//!   is `""`. Titles come from the tab strip and may carry Chromium's status suffixes.
//! - No Automation permission exists on Windows: nothing to grant, nothing prompts.

use std::time::Duration;

use psyche_win_computer::browser;
use serde_json::{Value, json};

use crate::node::{
    CapabilityError, CapabilityOutput, CapabilityRegistry, CapabilitySpec, SideEffect,
};

fn untrusted(mut o: Value) -> Value {
    o["provenance"] = json!("untrusted");
    o
}

pub fn register(reg: &mut CapabilityRegistry) {
    reg.add_blocking(
        CapabilitySpec::new(
            "chrome.tabs",
            "Open Google Chrome, Microsoft Edge and Brave tabs: window, index, title, URL (active tabs only; \"\" for background tabs on Windows), which is current, browser. Empty when no browser window is open. Page text is not available here: fetch the URL or use the agent browser.",
            SideEffect::Read,
        )
        .timeout(Duration::from_secs(30)),
        |_| {
            let tabs: Vec<Value> = browser::tabs().iter().map(browser::Tab::json).collect();
            Ok(CapabilityOutput::new(untrusted(json!({ "tabs": tabs }))))
        },
    );
    reg.add_blocking(
        CapabilitySpec::new(
            "chrome.current_tab",
            "The active tab of the frontmost Chrome, Edge or Brave window: title and URL.",
            SideEffect::Read,
        )
        .timeout(Duration::from_secs(30)),
        |_| {
            let tabs = browser::tabs();
            let tab = tabs
                .iter()
                .find(|t| t.current)
                .or(tabs.first())
                .ok_or_else(|| {
                    CapabilityError::not_found(
                        "no_tab",
                        "Chrome has no open tab (or is not running)",
                    )
                })?;
            Ok(CapabilityOutput::new(untrusted(
                json!({ "tab": tab.json() }),
            )))
        },
    );
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    use psyche_win_computer::browser;
    use serde_json::json;

    use crate::node::paths::Env;
    use crate::node::{CapabilityRegistry, InvocationContext, Runtime};

    fn registry() -> CapabilityRegistry {
        let mut reg = CapabilityRegistry::new(Runtime::offline(Env::default()));
        super::register(&mut reg);
        reg
    }

    #[test]
    fn specs_match_the_mac_helper() {
        let reg = registry();
        assert_eq!(reg.names(), ["chrome.tabs", "chrome.current_tab"]);
        for n in reg.names() {
            let m = reg.get(&n).unwrap().spec.manifest_entry();
            assert_eq!(m["sideEffect"], "read");
            assert!(m.get("targetKind").is_none());
            assert_eq!(m["inputSchema"]["additionalProperties"], false);
        }
    }

    /// Closes this test's Edge windows and ends its private profile's processes.
    struct EdgeGuard(PathBuf);
    impl Drop for EdgeGuard {
        fn drop(&mut self) {
            use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
            use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
            for (w, b) in browser::browser_windows() {
                if b == "edge" && w.title.contains("Psyche Tab") {
                    unsafe {
                        let _ = PostMessageW(
                            Some(HWND(w.hwnd as *mut _)),
                            WM_CLOSE,
                            WPARAM(0),
                            LPARAM(0),
                        );
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(2));
            let dir = self.0.display().to_string().replace('\'', "''");
            let _ = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command"])
                .arg(format!(
                    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object {{ $_.CommandLine -like '*{dir}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
                ))
                .status();
            std::thread::sleep(Duration::from_secs(1));
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Live: opens Edge (a private temporary profile) with two local files and a `data:` page,
    /// reads them back through `chrome.tabs` / `chrome.current_tab`, then closes it. Reads only:
    /// no input is sent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore]
    // Edge ends through the guard (WM_CLOSE, then its private profile's processes).
    #[allow(clippy::zombie_processes)]
    async fn live_reads_tabs_of_an_edge_window() {
        let edge = PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe");
        if !edge.exists() {
            eprintln!("skipped: Edge is not installed");
            return;
        }
        assert!(
            !browser::browser_windows().iter().any(|(_, b)| *b == "edge"),
            "an Edge window is already open; this test only reads windows it opens"
        );
        let dir = std::env::temp_dir().join(format!("psyche-edge-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _guard = EdgeGuard(dir.clone());
        let page = |n: &str| {
            let p = dir.join(format!("tab-{n}.html"));
            std::fs::write(
                &p,
                format!("<!doctype html><title>Psyche Tab {n}</title><p>{n}</p>"),
            )
            .unwrap();
            format!("file:///{}", p.display().to_string().replace('\\', "/"))
        };
        let (a, b) = (page("A"), page("B"));
        let c = "data:text/html,<title>Psyche Tab C</title>c".to_string();
        let profile = dir.join("profile");
        std::process::Command::new(&edge)
            .arg(format!("--user-data-dir={}", profile.display()))
            .args([
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-sync",
                "--new-window",
            ])
            .args([&a, &b, &c])
            .spawn()
            .expect("msedge");

        let started = Instant::now();
        let mut tabs = Vec::new();
        while started.elapsed() < Duration::from_secs(30) {
            tabs = tokio::task::spawn_blocking(browser::tabs).await.unwrap();
            let ours = tabs
                .iter()
                .filter(|t| t.title.contains("Psyche Tab"))
                .count();
            if ours == 3 && tabs.iter().any(|t| t.active && !t.url.is_empty()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let found_after = started.elapsed();
        let read = Instant::now();
        let again = tokio::task::spawn_blocking(browser::tabs).await.unwrap();
        println!(
            "tabs after {found_after:?}; one more read took {:?}",
            read.elapsed()
        );
        for t in &again {
            println!("{}", t.json());
        }
        let ours: Vec<_> = tabs
            .iter()
            .filter(|t| t.title.contains("Psyche Tab"))
            .collect();
        assert_eq!(ours.len(), 3, "{tabs:?}");
        assert!(
            ours.iter()
                .all(|t| t.browser == "edge" && t.window == ours[0].window)
        );
        assert_eq!(ours.iter().map(|t| t.index).collect::<Vec<_>>(), [0, 1, 2]);
        for (t, n) in ours.iter().zip(["A", "B", "C"]) {
            assert!(t.title.contains(&format!("Psyche Tab {n}")), "{t:?}");
        }
        let active: Vec<_> = ours.iter().filter(|t| t.active).collect();
        assert_eq!(active.len(), 1);
        let expected = [&a, &b, &c][active[0].index];
        assert_eq!(&active[0].url, expected);
        assert!(ours.iter().filter(|t| !t.active).all(|t| t.url.is_empty()));
        assert_eq!(active[0].current, active[0].window == 0);

        // Through the capabilities.
        let reg = registry();
        let tabs_cap = reg.get("chrome.tabs").unwrap();
        let r = (tabs_cap.handler)(InvocationContext::detached("chrome.tabs", json!({})))
            .await
            .unwrap();
        assert_eq!(r.result["provenance"], "untrusted");
        assert!(
            r.result["tabs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["url"] == json!(expected) && t["active"] == true)
        );
        let current = reg.get("chrome.current_tab").unwrap();
        let r = (current.handler)(InvocationContext::detached("chrome.current_tab", json!({})))
            .await
            .unwrap();
        assert_eq!(r.result["provenance"], "untrusted");
        let tab = &r.result["tab"];
        for k in ["window", "index", "title", "url", "current"] {
            assert!(tab.get(k).is_some(), "{k}");
        }
        if active[0].window == 0 {
            assert_eq!(tab["url"], json!(expected));
            assert_eq!(tab["current"], true);
        }
    }
}
