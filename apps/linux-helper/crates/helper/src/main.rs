use std::process::ExitCode;
use std::sync::Arc;

use psyche_helper::buildinfo::BuildInfo;
use psyche_helper::capability::Registry;
use psyche_helper::cli::{parse_args, run_info, Command};
use psyche_helper::daemon::{Daemon, Exit};
use psyche_helper::hardening::{close_inherited_fds, mark_ready, refuse_injected_libraries};
use psyche_helper::idle::IdleTimer;
use psyche_helper::paths::{state_dir, ProcessEnv};
use psyche_helper::{identity, log};

fn main() -> ExitCode {
    // First of all: whatever descriptors the parent left open (a copy of the node socket, say)
    // are not ours to keep. A process that still holds one could be talking as this helper.
    close_inherited_fds();
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `--display auto|headless|desktop` (H1) is read before the command line is parsed.
    #[cfg(target_os = "linux")]
    let (args, display_flag) = match psyche_helper::headless::mode::extract_flag(&args) {
        Ok(x) => x,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let command = match parse_args(&args, &ProcessEnv) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    if matches!(
        command,
        Command::Pair { .. } | Command::Remote | Command::Status { .. } | Command::Unpair
    ) {
        // Remote mode holds a device key in memory: the same start-up check as serving.
        if !matches!(command, Command::Status { .. }) {
            if let Err(message) = refuse_injected_libraries(&ProcessEnv) {
                log(&message);
                return ExitCode::from(78);
            }
        }
        return psyche_helper::remote::run::dispatch(command, &ProcessEnv);
    }
    let Command::Serve { idle } = command else {
        return match run_info(&command, &ProcessEnv) {
            Ok(text) => {
                println!("{text}");
                ExitCode::SUCCESS
            }
            Err(message) => {
                eprintln!("psyche-helper: {message}");
                ExitCode::FAILURE
            }
        };
    };

    // Before anything is read or connected: a library injected into this process would run with
    // the handshake secret and the device key.
    if let Err(message) = refuse_injected_libraries(&ProcessEnv) {
        log(&message);
        return ExitCode::from(78);
    }
    // Headless: nothing the helper starts may gain privileges, however it was started.
    #[cfg(target_os = "linux")]
    let headless = match psyche_helper::headless::mode::is_headless(display_flag, &ProcessEnv) {
        Ok(h) => h,
        Err(message) => {
            log(&message);
            return ExitCode::from(2);
        }
    };
    #[cfg(target_os = "linux")]
    if headless {
        if let Err(message) = psyche_helper::headless::nnp::enforce() {
            log(&message);
            return ExitCode::from(78);
        }
        log("display: headless (the virtual screen is the only screen)");
    }
    // Hardening is done: say so, so the Gateway can tell this from a process still starting up.
    mark_ready();

    let identity = match identity::load_or_create(&state_dir(&ProcessEnv)) {
        Ok(identity) => identity,
        Err(e) => {
            log(&format!("identity: {e}"));
            return ExitCode::FAILURE;
        }
    };
    let idle = Arc::new(IdleTimer::new(idle));
    let mut registry = Registry::standard(BuildInfo::current());
    // Direct computer use (L5): registered here, connected to the desktop on the first call.
    psyche_helper::direct::register(&mut registry);
    // Virtual screens (L6).
    #[cfg(target_os = "linux")]
    let vscreen = psyche_helper::vscreen::register(&mut registry, &ProcessEnv, Arc::clone(&idle));
    // Headless: `apps.*` and `computer.*` act on the virtual screen.
    #[cfg(target_os = "linux")]
    if headless {
        psyche_helper::headless::install(std::sync::Arc::clone(&vscreen));
    }
    let mut daemon = Daemon::new(identity, registry, Box::new(ProcessEnv), idle);
    let exit = daemon.run();
    #[cfg(target_os = "linux")]
    vscreen.shutdown();
    match exit {
        Exit::Idle => log("exiting: idle"),
        Exit::Stopped => log("exiting: stopped"),
    }
    ExitCode::SUCCESS
}
