//! `psyche-vm-svc.exe`: the Psyche sandbox PC service.
//!
//! ```text
//! psyche-vm-svc install --owner-sid <SID> --home <PSYCHE_HOME> [--images <dir>]   (elevated)
//! psyche-vm-svc uninstall [--owner-sid <SID>]                                    (elevated; else a note, exit 5)
//! psyche-vm-svc start [--owner-sid <SID>]                     start the installed service (owner may)
//! psyche-vm-svc serve --owner-sid … --home … --images … --profile …   (the SCM runs this)
//! psyche-vm-svc run [--home <dir>] [--images <dir>] [--pipe <name>] [--backend hcs|fake] [--idle-secs N]
//!                                                              console mode for development and tests
//! psyche-vm-svc version
//! ```
//! Results print as one JSON line on stdout. Exit: 0 ok, 1 failed, 2 bad arguments,
//! 5 elevation required.

use std::path::PathBuf;
use std::process::ExitCode;

use psyche_win_vm::error::VmError;
use psyche_win_vm::{paths, security, service};
use serde_json::json;

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn fail(e: &VmError) -> ExitCode {
    println!("{}", json!({"ok": false, "error": e.to_wire()}));
    if e.reason == "elevation_required" { ExitCode::from(5) } else { ExitCode::from(1) }
}

fn usage() -> ExitCode {
    eprintln!(
        "usage: psyche-vm-svc install --owner-sid <SID> --home <PSYCHE_HOME> [--images <dir>] | uninstall [--owner-sid <SID>] | start | serve … | run [--home <dir>] [--images <dir>] [--pipe <name>] [--backend hcs|fake] | version"
    );
    ExitCode::from(2)
}

fn me() -> String {
    security::current_user_sid().unwrap_or_default()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().map(String::as_str) else { return usage() };
    match cmd {
        "version" | "--version" => {
            println!(
                "{}",
                json!({"version": env!("CARGO_PKG_VERSION"), "protocol": psyche_win_vm::protocol::PROTOCOL_VERSION, "elevated": security::is_elevated()})
            );
            ExitCode::SUCCESS
        }
        "install" => {
            let (Some(sid), Some(home)) = (arg(&args, "--owner-sid"), arg(&args, "--home")) else { return usage() };
            match service::install(&sid, &PathBuf::from(home), arg(&args, "--images").map(PathBuf::from).as_deref()) {
                Ok(v) => {
                    println!("{v}");
                    ExitCode::SUCCESS
                }
                Err(e) => fail(&e),
            }
        }
        "uninstall" => {
            let sid = arg(&args, "--owner-sid").unwrap_or_else(me);
            match service::uninstall(&sid) {
                Ok(v) => {
                    println!("{v}");
                    ExitCode::SUCCESS
                }
                Err(e) if e.reason == "elevation_required" => {
                    // Never fail silently: leave the user a note outside the app folder.
                    let note = service::uninstall_note(&sid);
                    let path = std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Psyche-sandbox-pc-uninstall.txt"));
                    if let Some(p) = &path {
                        let _ = std::fs::write(p, &note);
                    }
                    eprint!("{note}");
                    let e = e.detail("note", note).detail("notePath", path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default());
                    fail(&e)
                }
                Err(e) => fail(&e),
            }
        }
        "start" => {
            let sid = arg(&args, "--owner-sid").unwrap_or_else(me);
            match service::start_installed(&sid) {
                Ok(()) => {
                    println!("{}", json!({"started": true, "pipe": paths::control_pipe_name(&sid)}));
                    ExitCode::SUCCESS
                }
                Err(e) => fail(&e),
            }
        }
        "serve" => {
            let (Some(sid), Some(home), Some(images), Some(profile)) =
                (arg(&args, "--owner-sid"), arg(&args, "--home"), arg(&args, "--images"), arg(&args, "--profile"))
            else {
                return usage();
            };
            if !paths::is_valid_sid(&sid) {
                return usage();
            }
            match service::serve(service::ServeArgs { owner_sid: sid, home: home.into(), images: images.into(), profile: profile.into() }) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => fail(&e),
            }
        }
        "run" => {
            let sid = arg(&args, "--owner-sid").unwrap_or_else(me);
            let profile =
                service::profile_of(&sid).unwrap_or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default());
            let home = arg(&args, "--home")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("PSYCHE_HOME").map(PathBuf::from))
                .unwrap_or_else(|| profile.join(".psyche"));
            let images = arg(&args, "--images").map(PathBuf::from).unwrap_or_else(|| service::default_images_root(&profile));
            let backend = match arg(&args, "--backend").as_deref() {
                Some("fake") => service::Backend::Fake,
                None | Some("hcs") => service::Backend::Hcs,
                Some(_) => return usage(),
            };
            let idle = arg(&args, "--idle-secs").and_then(|s| s.parse().ok()).unwrap_or(600);
            let pipe = arg(&args, "--pipe");
            let (_tx, rx) = tokio::sync::watch::channel(false);
            let a = service::ServeArgs { owner_sid: sid.clone(), home: paths::absolute(&home), images, profile };
            let shown = pipe.clone().unwrap_or_else(|| paths::control_pipe_name(&sid));
            match service::run(a, rx, backend, pipe, std::time::Duration::from_secs(idle), || println!("{}", json!({"listening": shown}))) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => fail(&e),
            }
        }
        _ => usage(),
    }
}
