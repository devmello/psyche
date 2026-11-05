//! Dumps an app's `computer.ax_tree` snapshot as JSON, for manual debugging.
//!
//! ```text
//! cargo run --example probe                     # the foreground window, after a 3 s delay
//! cargo run --example probe -- notepad.exe      # a running app by executable or name
//! cargo run --example probe -- notepad.exe text # the text form the model sees
//! ```
//!
//! Computer-use tiers apply to reads too; the probe runs with `PSYCHE_HOME` pointing at a temp
//! settings file that sets every app to `read`, unless `PSYCHE_HOME` is already set.

use serde_json::json;

fn main() {
    let mut args = std::env::args().skip(1);
    let app = args.next().filter(|a| a != "-");
    if app.as_deref() == Some("--windows") {
        // Top-level windows front to back, with the app each is attributed to.
        for w in psyche_win_computer::win::apps::top_windows() {
            let app = psyche_win_computer::win::apps::app_for_window(&w);
            println!(
                "{:>10x} pid={:<6} owner={:<6} layer={} {:?} class={:?} title={:?} app={:?}",
                w.hwnd,
                w.pid,
                w.owner_pid,
                w.layer(),
                w.rect.ints(),
                w.class,
                w.title,
                app.and_then(|a| a.bundle_id)
            );
        }
        return;
    }
    let format = args.next().unwrap_or_else(|| "json".into());
    if std::env::var("PSYCHE_HOME").is_err() {
        let home = std::env::temp_dir().join("psyche-probe");
        std::fs::create_dir_all(home.join("config")).expect("temp dir");
        std::fs::write(home.join("config").join("computer-use.json"), r#"{"version":1,"default":"read","apps":{}}"#).expect("settings");
        std::env::set_var("PSYCHE_HOME", &home);
    }
    if app.is_none() {
        eprintln!("Snapshotting the foreground window in 3 seconds: switch to it now.");
        std::thread::sleep(std::time::Duration::from_secs(3));
    }
    let mut params = json!({"format": "json", "maxEmit": 2000, "maxVisit": 20000});
    if let Some(a) = &app {
        params["app"] = json!(a);
    }
    let started = std::time::Instant::now();
    match psyche_win_computer::computer_ax_tree(params) {
        Ok(r) => {
            if format == "text" {
                print!("{}", r["text"].as_str().unwrap_or(""));
            } else {
                println!("{}", serde_json::to_string_pretty(&r).unwrap());
            }
            eprintln!("snapshot in {} ms", started.elapsed().as_millis());
        }
        Err(e) => {
            eprintln!("{}", serde_json::to_string_pretty(&e.to_wire()).unwrap());
            std::process::exit(1);
        }
    }
}
