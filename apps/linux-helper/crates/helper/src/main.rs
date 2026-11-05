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
    let command = match parse_args(&args, &ProcessEnv) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
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
    // Hardening is done: say so, so the Gateway can tell this from a process still starting up.
    mark_ready();

    let identity = match identity::load_or_create(&state_dir(&ProcessEnv)) {
        Ok(identity) => identity,
        Err(e) => {
            log(&format!("identity: {e}"));
            return ExitCode::FAILURE;
        }
    };
    let registry = Registry::standard(BuildInfo::current());
    let mut daemon = Daemon::new(
        identity,
        registry,
        Box::new(ProcessEnv),
        Arc::new(IdleTimer::new(idle)),
    );
    match daemon.run() {
        Exit::Idle => log("exiting: idle"),
        Exit::Stopped => log("exiting: stopped"),
    }
    ExitCode::SUCCESS
}
