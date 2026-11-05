//! `psyche-helper.exe`: the Windows node. By default it stays connected to the Gateway's node pipe
//! and serves capabilities, reconnecting when the Gateway restarts.

#![cfg_attr(not(windows), allow(unused))]

#[cfg(not(windows))]
fn main() {
    eprintln!("psyche-helper (win-helper) only runs on Windows");
    std::process::exit(64);
}

#[cfg(windows)]
fn main() {
    std::process::exit(app::run());
}

#[cfg(windows)]
mod app {
    use std::sync::Arc;
    use std::time::Duration;

    use psyche_win_helper::node::Runtime;
    use psyche_win_helper::node::channel::{FrameReader, spawn_writer};
    use psyche_win_helper::node::daemon::NodeDaemon;
    use psyche_win_helper::node::handshake::{
        Completion, HandshakeError, HandshakeOptions, perform,
    };
    use psyche_win_helper::node::identity::DpapiIdentityStore;
    use psyche_win_helper::node::instance::SingleInstanceLock;
    use psyche_win_helper::node::log::HelperLog;
    use psyche_win_helper::node::paths::{
        Env, log_path, node_pipe, psyche_home, read_handshake_secret,
    };
    use psyche_win_helper::node::registry::HELPER_VERSION;
    use psyche_win_helper::node::transport::{ConnectError, connect};
    use psyche_win_helper::{groups, permissions, presence, win};
    use serde_json::json;

    const USAGE: &str = "usage: psyche-helper [--handshake-only [--challenge-only]] [--timeout <seconds>] [--manifest] [--build-info] [--print-identity] [--keyboard-layout]

  (no flags)        stay connected to the Gateway and serve capabilities (reconnects)
  --handshake-only  connect, pair, print the phase and exit (smoke test)
  --challenge-only  with --handshake-only: stop after the challenge
  --manifest        print the capability manifest as JSON and exit
  --build-info      print {\"presenceFileFallback\": false} and exit
  --print-identity  print {deviceId, presenceKeyId, presenceKeyKind} as JSON and exit (never prompts;
                    presenceError when no Windows Hello presence key exists yet)
  --keyboard-layout print {layout, altGr} for the keyboard layout in use and exit (altGr: Right Alt
                    is AltGr there, a poor hold-to-talk key)

Environment: PSYCHE_HOME (default %USERPROFILE%\\.psyche), PSYCHE_NODE_SOCKET (a \\\\.\\pipe\\… path;
default: the pipe named in $PSYCHE_HOME\\run\\node-socket, else \\\\.\\pipe\\psyche-node-<hash>).
Exit codes (--handshake-only): 0 handshake done, 2 pipe missing, 3 denied, 4 timeout, 1 other errors.";

    struct Flags {
        timeout: Duration,
        handshake_only: bool,
        verify: bool,
        manifest: bool,
        build_info: bool,
        print_identity: bool,
        keyboard_layout: bool,
    }

    fn parse() -> Result<Flags, i32> {
        let mut f = Flags {
            timeout: Duration::from_secs(10),
            handshake_only: false,
            verify: true,
            manifest: false,
            build_info: false,
            print_identity: false,
            keyboard_layout: false,
        };
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--timeout" => match args
                    .next()
                    .and_then(|v| v.parse::<f64>().ok())
                    .filter(|v| *v > 0.0)
                {
                    Some(v) => f.timeout = Duration::from_secs_f64(v),
                    None => {
                        eprintln!("{USAGE}");
                        return Err(64);
                    }
                },
                "--handshake-only" => f.handshake_only = true,
                "--challenge-only" => {
                    f.handshake_only = true;
                    f.verify = false;
                }
                "--manifest" => f.manifest = true,
                "--build-info" => f.build_info = true,
                "--print-identity" => f.print_identity = true,
                "--keyboard-layout" => f.keyboard_layout = true,
                "-h" | "--help" => {
                    println!("{USAGE}");
                    return Err(0);
                }
                // COM launches the helper with -Embedding (toast activator, LocalServer32 command
                // line adds -ToastActivated); both just mean "start serving".
                a if a.eq_ignore_ascii_case("-embedding")
                    || a.eq_ignore_ascii_case("-toastactivated") => {}
                other => {
                    eprintln!("unknown argument: {other}\n{USAGE}");
                    return Err(64);
                }
            }
        }
        Ok(f)
    }

    fn tokio_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .on_thread_start(win::com::ensure_mta)
            .thread_name("psyche-helper")
            .build()
            .expect("tokio runtime")
    }

    pub fn run() -> i32 {
        let flags = match parse() {
            Ok(f) => f,
            Err(code) => return code,
        };
        win::com::ensure_mta();
        let env = Env::current();

        if flags.manifest {
            let reg = groups::build(Runtime::offline(env));
            println!(
                "{}",
                serde_json::to_string_pretty(&reg.manifest(HELPER_VERSION)).unwrap_or_default()
            );
            return 0;
        }
        if flags.keyboard_layout {
            println!("{}", psyche_win_dictation::keyboard_layout());
            return 0;
        }
        if flags.build_info {
            println!("{}", json!({ "presenceFileFallback": false }));
            return 0;
        }
        if flags.print_identity {
            let mut out = serde_json::Map::new();
            match DpapiIdentityStore::for_env(&env).load_or_create() {
                Ok(id) => {
                    out.insert("deviceId".into(), id.device_id().into());
                }
                Err(_) => {
                    eprintln!("could not load the device identity");
                    return 1;
                }
            }
            let rt = tokio_runtime();
            for (k, v) in rt.block_on(presence::identity_fields()) {
                out.insert(k, v);
            }
            println!("{}", serde_json::Value::Object(out));
            return 0;
        }

        let home = psyche_home(&env);
        let log = HelperLog::new(Some(log_path(&home)));

        // One helper per $PSYCHE_HOME, taken before the identity loads so a second copy touches nothing.
        let _lock = if flags.handshake_only {
            None
        } else {
            match SingleInstanceLock::acquire(&home) {
                Some(l) => Some(l),
                None => {
                    log.info("psyche-helper already running for this PSYCHE_HOME; exiting");
                    return 0;
                }
            }
        };

        let store = DpapiIdentityStore::for_env(&env);
        let identity = match store.load_or_create() {
            Ok(id) => id,
            Err(e) => {
                log.error(format!("could not load the device identity: {e}"));
                return 1;
            }
        };
        log.info(format!("identity_store={}", store.kind()));

        let rt = tokio_runtime();
        if flags.handshake_only {
            return rt.block_on(handshake_only(
                &env,
                &log,
                identity,
                flags.timeout,
                flags.verify,
            ));
        }

        rt.block_on(async {
            let preflight = Arc::new(permissions::LivePreflight::new());
            let runtime = Runtime::new(env.clone(), log.clone(), preflight, true);
            let registry = Arc::new(groups::build(runtime));
            let daemon = NodeDaemon::new(identity, registry.clone(), env.clone(), log.clone());
            let stop = daemon.stop_token();
            log.info(format!(
                "psyche-helper {HELPER_VERSION} started capabilities={}",
                registry.len()
            ));
            tokio::select! {
                _ = daemon.run() => {}
                _ = tokio::signal::ctrl_c() => {
                    log.info("stopping");
                    stop.cancel();
                }
            }
        });
        0
    }

    async fn handshake_only(
        env: &Env,
        log: &HelperLog,
        identity: psyche_win_helper::node::identity::DeviceIdentity,
        timeout: Duration,
        verify: bool,
    ) -> i32 {
        let pipe = node_pipe(env);
        let client = match connect(&pipe.path).await {
            Ok(c) => c,
            Err(e) => {
                log.error(e.to_string());
                return match e {
                    ConnectError::Missing => 2,
                    _ => 1,
                };
            }
        };
        let (r, w) = tokio::io::split(client);
        let mut reader = FrameReader::new(r);
        let (writer, _task) = spawn_writer(w);
        let options = HandshakeOptions {
            timeout,
            verify,
            handshake_secret: read_handshake_secret(env),
            ..HandshakeOptions::default()
        };
        match perform(&identity, &options, &mut reader, &writer, log).await {
            Ok(Completion::ChallengeOnly { nonce_bytes, .. }) => {
                log.info(format!("challenge ok nonceBytes={nonce_bytes}"));
                0
            }
            Ok(Completion::Completed(r)) => {
                if r.phase == "denied" {
                    3
                } else {
                    0
                }
            }
            Err(HandshakeError::TimedOut) => {
                log.error("handshake timed out");
                4
            }
            Err(e) => {
                log.error(e.to_string());
                1
            }
        }
    }
}
