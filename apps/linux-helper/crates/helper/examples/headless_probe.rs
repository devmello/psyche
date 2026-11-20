//! Headless end to end, by hand: with no `DISPLAY` or `WAYLAND_DISPLAY`, open an app on the
//! helper's own Xvfb, take its tree, type, read it back, take a screenshot, and print RSS. Not
//! shipped. `headless_probe <desktop-id> [text]`.
#![cfg(target_os = "linux")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use psyche_helper::headless::surface::HeadlessSurface;
use psyche_helper::idle::IdleTimer;
use psyche_helper::paths::ProcessEnv;
use psyche_helper::vscreen::{Config, Deps, VscreenManager};
use psyche_linux_computer::backend::Backend;
use psyche_linux_computer::engine::Invocation;
use serde_json::{json, Value};

fn rss_kb(pid: u32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|t| {
            t.lines().find_map(|l| {
                l.strip_prefix("VmRSS:")?
                    .trim()
                    .trim_end_matches("kB")
                    .trim()
                    .parse()
                    .ok()
            })
        })
        .unwrap_or(0)
}

fn main() {
    let app = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "org.gnome.TextEditor".into());
    let text = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "hello from headless".into());
    assert!(
        std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none(),
        "run this with no DISPLAY and no WAYLAND_DISPLAY"
    );
    println!(
        "NoNewPrivs self: {:?}",
        psyche_helper::headless::nnp::is_set_for(std::process::id())
    );
    psyche_helper::headless::nnp::enforce().expect("nnp");
    let idle = Arc::new(IdleTimer::new(Some(Duration::from_secs(600))));
    let manager = VscreenManager::new(Config::from_env(&ProcessEnv), Deps::real(), idle);
    manager.set_headless(true);
    if std::env::var("PROBE_RAW").is_ok_and(|v| !v.is_empty()) {
        // Browsers are read-only for the agent (the tier cap), so `apps.open` refuses them; the
        // owner's own `vscreen` path can still start one. This checks that it starts under the flag.
        let opened = manager.open_app(&app);
        println!("vscreen open_app({app}): {opened:?}");
        std::thread::sleep(Duration::from_secs(4));
        for p in std::fs::read_dir("/proc")
            .unwrap()
            .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok())
        {
            let comm = std::fs::read_to_string(format!("/proc/{p}/comm")).unwrap_or_default();
            if manager.app_of_pid(p).is_some() {
                println!(
                    "  scope member {p} {}: NoNewPrivs={:?} RSS={} kB",
                    comm.trim(),
                    psyche_helper::headless::nnp::is_set_for(p),
                    rss_kb(p)
                );
            }
        }
        manager.shutdown();
        return;
    }
    let surface = HeadlessSurface::new(Arc::clone(&manager));
    let engine = surface.engine().expect("engine");
    let inv = Invocation {
        approval_id: None,
        cancel: None,
    };
    let opened = engine
        .open_app(&json!({ "bundleId": app }), None)
        .expect("apps.open");
    println!("apps.open: {opened}");
    std::thread::sleep(Duration::from_secs(2));
    let apps = engine.backend.apps();
    println!("apps: {apps:?}");
    let call = |name: &str, p: Value| -> Result<Value, String> {
        engine
            .invoke(name, &p, &inv)
            .map(|o| o.result)
            .map_err(|e| format!("{}/{}: {}", e.code, e.reason, e.message))
    };
    let tree = call("computer.ax_tree", json!({ "app": app })).expect("ax_tree");
    let t = tree.to_string();
    println!("ax_tree: {} bytes", t.len());
    let typed = call(
        "computer.type",
        json!({ "app": app, "text": text, "session": "probe" }),
    );
    println!("type: {typed:?}");
    std::thread::sleep(Duration::from_millis(500));
    let tree = call("computer.ax_tree", json!({ "app": app })).expect("ax_tree 2");
    let found = tree.to_string().contains(&text);
    println!("read back: typed text found in tree = {found}");
    let shot = call("computer.screenshot", json!({ "app": app }));
    match &shot {
        Ok(v) => println!("screenshot ok: {} bytes of result", v.to_string().len()),
        Err(e) => println!("screenshot failed: {e}"),
    }
    if std::env::var("PROBE_TEXT").is_ok_and(|v| !v.is_empty()) {
        let r = call(
            "computer.type",
            json!({ "app": app, "text": "cafe-\u{e9}-\u{f1}-\u{20ac}5-na\u{ef}ve-\u{3a9}-\u{6f22}\u{5b57}-\u{1f600}-end", "session": "probe" }),
        );
        println!("TEXT non-keymap string: {r:?}");
        let started = Instant::now();
        let long = format!("a{}", "\u{301}".repeat(1500));
        let r = call(
            "computer.type",
            json!({ "app": app, "text": long, "session": "probe" }),
        );
        println!(
            "TEXT 1501-codepoint grapheme: {:?} in {:?}",
            r.is_ok() || r.is_err(),
            started.elapsed()
        );
    }
    // Stacking: an older tier-off window raised over a newer one must be redacted, and a click
    // on the raised window must resolve to it.
    if std::env::var("PROBE_STACK").is_ok_and(|v| !v.is_empty()) {
        let home = std::env::var("PSYCHE_HOME").unwrap();
        let cfg = format!("{home}/config/computer-use.json");
        let display = manager.status().display.expect("display");
        let auth = manager.xauthority().expect("xauthority");
        let calc = "org.gnome.Calculator";
        println!(
            "open calc: {:?}",
            engine.open_app(&json!({ "bundleId": calc }), None)
        );
        std::thread::sleep(Duration::from_secs(3));
        let raise = |name: &str| {
            let out = std::process::Command::new("xdotool")
                .args(["search", "--name", name])
                .env("DISPLAY", &display)
                .env("XAUTHORITY", &auth)
                .output()
                .unwrap();
            let id = String::from_utf8_lossy(&out.stdout)
                .lines()
                .last()
                .unwrap_or("")
                .to_string();
            let _ = std::process::Command::new("xdotool")
                .args(["windowactivate", &id])
                .env("DISPLAY", &display)
                .env("XAUTHORITY", &auth)
                .status();
        };
        raise("Calculator");
        std::thread::sleep(Duration::from_secs(1));
        // The editor is the newest window; the calculator is raised over it.
        let off = if std::env::var("PROBE_NOOFF").is_ok_and(|v| !v.is_empty()) {
            r#"{"version":1,"default":"interact"}"#
        } else {
            r#"{"version":1,"default":"interact","apps":{"org.gnome.calculator":"off"}}"#
        };
        std::fs::write(&cfg, off).unwrap();
        if let Ok(dir) = std::env::var("PSYCHE_HELPER_CONFIG") {
            if std::env::var("PROBE_DENY").is_ok_and(|v| !v.is_empty()) {
                use std::os::unix::fs::PermissionsExt;
                let file = format!("{dir}/policy.json");
                std::fs::write(
                    &file,
                    r#"{"apps":{"allow":["*"],"deny":["org.gnome.Calculator"]}}"#,
                )
                .unwrap();
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
        let shot = call("computer.screenshot", json!({ "app": app }));
        if let Ok(v) = &shot {
            // Whatever field carries the picture is written out for a pixel check.
            if let Some(o) = v.as_object() {
                for (k, val) in o {
                    if let Some(t) = val.as_str().filter(|t| t.len() > 1000) {
                        use base64::Engine as _;
                        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(t) {
                            let _ = std::fs::write("/tmp/h1-stack-shot.jpg", bytes);
                            println!("STACK picture field: {k}");
                        }
                    }
                }
            }
        }
        match &shot {
            Ok(v) => {
                let mut v = v.clone();
                if let Some(o) = v.as_object_mut() {
                    for k in ["image", "data", "base64"] {
                        o.remove(k);
                    }
                }
                println!("STACK screenshot result: {v}");
            }
            Err(e) => println!("STACK screenshot failed: {e}"),
        }
        std::fs::write(&cfg, r#"{"version":1,"default":"interact"}"#).unwrap();
        let click = call(
            "computer.click",
            json!({ "app": calc, "x": 640, "y": 400, "session": "probe" }),
        );
        println!("STACK click on the raised calculator: {click:?}");
    }
    // A foreign client takes the focus N ms into a long `computer.type`: nothing may reach it.
    if let Some(ms) = std::env::var("PROBE_STEAL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        let display = manager.status().display.expect("display");
        let auth = manager.xauthority().expect("xauthority");
        let out = "/tmp/h1-xterm.out";
        let _ = std::fs::remove_file(out);
        let mut xterm = std::process::Command::new("xterm")
            .args(["-e", "sh", "-c", &format!("stty raw -echo; cat > {out}")])
            .env("DISPLAY", &display)
            .env("XAUTHORITY", &auth)
            .spawn()
            .expect("xterm");
        std::thread::sleep(Duration::from_secs(2));
        let id = std::process::Command::new("xdotool")
            .args(["search", "--class", "xterm"])
            .env("DISPLAY", &display)
            .env("XAUTHORITY", &auth)
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .lines()
                    .last()
                    .unwrap_or("")
                    .to_string()
            })
            .unwrap();
        println!("xterm window {id}");
        let (d2, a2, id2) = (display.clone(), auth.clone(), id.clone());
        let thief = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            let _ = std::process::Command::new("xdotool")
                .args(["windowfocus", &id2])
                .env("DISPLAY", &d2)
                .env("XAUTHORITY", &a2)
                .status();
        });
        let long = format!("{}\n{}\n", "a".repeat(400), "b".repeat(400));
        let r = call(
            "computer.type",
            json!({ "app": app, "text": long, "session": "probe" }),
        );
        println!("steal type: {r:?}");
        thief.join().ok();
        std::thread::sleep(Duration::from_secs(1));
        let got = std::fs::read(out).unwrap_or_default();
        println!("STEAL leaked {} bytes into the xterm", got.len());
        let _ = xterm.kill();
        let _ = xterm.wait();
    }
    // The focus check, live: a second app takes the focus; typing into the first is refused.
    if let Some(other) = std::env::args().nth(3) {
        let o = engine
            .open_app(&json!({ "bundleId": other }), None)
            .expect("second app");
        println!("second app: {o}");
        std::thread::sleep(Duration::from_secs(2));
        let info = engine
            .backend
            .apps()
            .into_iter()
            .find(|a| a.id.eq_ignore_ascii_case(&app))
            .expect("first app listed");
        println!(
            "check_input_target(first app) while the second has focus: {:?}",
            engine
                .backend
                .check_input_target(&info)
                .map_err(|e| e.reason)
        );
        let blocked = call(
            "computer.key",
            json!({ "app": app, "keys": "a", "session": "probe" }),
        );
        println!("key after activate (activate moves focus back): {blocked:?}");
    }
    let me = std::process::id();
    println!("RSS helper (probe process): {} kB", rss_kb(me));
    for (name, pid) in std::fs::read_dir("/proc")
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter_map(|p| {
            let comm = std::fs::read_to_string(format!("/proc/{p}/comm")).ok()?;
            let comm = comm.trim().to_string();
            matches!(
                comm.as_str(),
                "Xvfb"
                    | "dbus-daemon"
                    | "at-spi-bus-laun"
                    | "gnome-text-edit"
                    | "firefox"
                    | "soffice.bin"
                    | "firefox-bin"
                    | "WebContent"
                    | "Isolated Web Co"
            )
            .then_some((comm, p))
        })
    {
        println!(
            "RSS {name} ({pid}): {} kB, NoNewPrivs={:?}",
            rss_kb(pid),
            psyche_helper::headless::nnp::is_set_for(pid)
        );
    }
    println!("stopping");
    manager.shutdown();
}
