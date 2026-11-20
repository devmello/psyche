//! Command line. `--print-identity` and `--build-info` print one JSON object and exit; they are
//! what the desktop runs to learn which device the helper is and which build it is. They are
//! read-only: `--print-identity` never creates the identity, a directory or a socket.

use std::time::Duration;

use serde_json::json;

use crate::buildinfo::{BuildInfo, DEVICE_FAMILY, PLATFORM};
use crate::capability::Registry;
use crate::identity;
use crate::idle::{parse_idle_seconds, DEFAULT_IDLE};
use crate::paths::{state_dir, Env};

pub const USAGE: &str =
    "usage: psyche-helper [--idle-timeout <seconds>] [--manifest] [--build-info] [--print-identity]
       psyche-helper pair - | wss://<gateway> [--name N] [--replace]
       psyche-helper remote | status [--json] | unpair
       psyche-helper update [--check] [--rollback] [--from DIR]

  (no flags)        connect to the Gateway's node socket and serve (exits after 5 minutes idle)
  --idle-timeout N  exit after N seconds with no work; 0 never exits (default 300)
  --manifest        print the capability manifest as JSON and exit
  --build-info      print {name, version, build, commit?, platform, arch, protocolVersion} and exit
  --ceiling-owner   print who the limits count as owned by when this runs as the service (JSON)
  --print-identity  print {deviceId, publicKey, deviceFamily, platform} as JSON and exit: what the
                    Gateway will see (read-only; deviceId and publicKey are null until the helper
                    has run once)

A computer Psyche uses (it dials your Gateway; nothing listens here):
  pair -            read a psyche-machine: link (paste it, nothing is echoed, or pipe it in) and
                    pair with its one-time token; a link given as an argument works but shows
                    in `ps` and your shell history, and the helper warns
  pair wss://HOST   no link: shows the Gateway's fingerprint and a code; approve on the Mac
  remote            serve (what the service runs); exits 78 when it must not be restarted
  status [--json]   Gateway, fingerprint, connection, limits, account (read-only)
  unpair            remove this computer from the Gateway if reachable, then wipe its key
  update            fetch the newest signed release, check it, install it and restart the service;
                    --check only looks, --rollback goes back to the previous helper, --from DIR reads
                    the release files from a directory (a package install updates with apt or dnf)
";

/// What `pair` was given.
#[derive(Debug, PartialEq, Eq)]
pub enum PairTarget {
    /// A `psyche-machine:` link or a `wss://` address, as typed.
    Text(String),
    /// `-`: read the link from standard input.
    Stdin,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Serve {
        idle: Option<Duration>,
    },
    Pair {
        target: PairTarget,
        replace: bool,
        name: Option<String>,
    },
    Remote,
    Status {
        json: bool,
    },
    Unpair,
    Update {
        check: bool,
        rollback: bool,
        from: Option<std::path::PathBuf>,
    },
    PrintIdentity,
    BuildInfo,
    CeilingOwner,
    Manifest,
    Help,
}

fn parse_remote_command(verb: &str, rest: &[String]) -> Result<Command, String> {
    match verb {
        "remote" | "unpair" if !rest.is_empty() => {
            Err(format!("{verb} takes no arguments\n{USAGE}"))
        }
        "remote" => Ok(Command::Remote),
        "unpair" => Ok(Command::Unpair),
        "status" => match rest {
            [] => Ok(Command::Status { json: false }),
            [flag] if flag == "--json" => Ok(Command::Status { json: true }),
            _ => Err(format!("status takes only --json\n{USAGE}")),
        },
        "update" => {
            let (mut check, mut rollback, mut from) = (false, false, None);
            let mut iter = rest.iter();
            while let Some(arg) = iter.next() {
                match arg.as_str() {
                    "--check" => check = true,
                    "--rollback" => rollback = true,
                    "--from" => {
                        from = Some(std::path::PathBuf::from(
                            iter.next().ok_or("--from needs a directory")?,
                        ));
                    }
                    other => return Err(format!("unexpected argument {other}\n{USAGE}")),
                }
            }
            if rollback && (check || from.is_some()) {
                return Err(format!("--rollback stands alone\n{USAGE}"));
            }
            Ok(Command::Update {
                check,
                rollback,
                from,
            })
        }
        "pair" => {
            let mut target = None;
            let mut replace = false;
            let mut name = None;
            let mut iter = rest.iter();
            while let Some(arg) = iter.next() {
                match arg.as_str() {
                    "--replace" => replace = true,
                    "--name" => {
                        name = Some(iter.next().ok_or("--name needs a name")?.clone());
                    }
                    "-" if target.is_none() => target = Some(PairTarget::Stdin),
                    other if !other.starts_with('-') && target.is_none() => {
                        target = Some(PairTarget::Text(other.to_string()));
                    }
                    other => return Err(format!("unexpected argument {other}\n{USAGE}")),
                }
            }
            Ok(Command::Pair {
                target: target.ok_or("pair needs a psyche-machine: link or a wss:// address")?,
                replace,
                name,
            })
        }
        other => Err(format!("unknown command {other}\n{USAGE}")),
    }
}

pub fn parse_args(args: &[String], env: &dyn Env) -> Result<Command, String> {
    if let Some(first) = args.first() {
        if matches!(
            first.as_str(),
            "pair" | "remote" | "status" | "unpair" | "update"
        ) {
            return parse_remote_command(first, &args[1..]);
        }
    }
    let mut idle = match env.get("PSYCHE_HELPER_IDLE_SECS") {
        Some(text) => parse_idle_seconds(&text)
            .ok_or_else(|| "PSYCHE_HELPER_IDLE_SECS must be whole seconds".to_string())?,
        None => Some(DEFAULT_IDLE),
    };
    let mut info = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--print-identity" => info = Some(Command::PrintIdentity),
            "--build-info" => info = Some(Command::BuildInfo),
            "--ceiling-owner" => info = Some(Command::CeilingOwner),
            "--manifest" => info = Some(Command::Manifest),
            "--help" | "-h" => info = Some(Command::Help),
            "--idle-timeout" => {
                let value = iter
                    .next()
                    .ok_or("--idle-timeout needs a number of seconds")?;
                idle = parse_idle_seconds(value)
                    .ok_or_else(|| "--idle-timeout must be whole seconds".to_string())?;
            }
            other => return Err(format!("unknown argument {other}\n{USAGE}")),
        }
    }
    Ok(info.unwrap_or(Command::Serve { idle }))
}

/// Output of the one-shot commands. `Serve` has none.
pub fn run_info(command: &Command, env: &dyn Env) -> Result<String, String> {
    match command {
        Command::Help => Ok(USAGE.to_string()),
        Command::CeilingOwner => Ok(crate::update::ceiling_owner_json()),
        Command::BuildInfo => {
            serde_json::to_string(&BuildInfo::current()).map_err(|e| e.to_string())
        }
        Command::Manifest => {
            serde_json::to_string(&Registry::standard(BuildInfo::current()).manifest())
                .map_err(|e| e.to_string())
        }
        Command::PrintIdentity => {
            let loaded = identity::load(&state_dir(env)).map_err(|e| e.to_string())?;
            let value = json!({
                "deviceId": loaded.as_ref().map(|i| i.device_id()),
                "publicKey": loaded.as_ref().map(|i| i.public_key()),
                "deviceFamily": DEVICE_FAMILY,
                "platform": PLATFORM,
            });
            serde_json::to_string(&value).map_err(|e| e.to_string())
        }
        Command::Serve { .. }
        | Command::Pair { .. }
        | Command::Remote
        | Command::Status { .. }
        | Command::Unpair
        | Command::Update { .. } => Err("not a one-shot command".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }
    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_flags_and_defaults() {
        let e = env(&[]);
        assert_eq!(
            parse_args(&args(&[]), &e),
            Ok(Command::Serve {
                idle: Some(DEFAULT_IDLE)
            })
        );
        assert_eq!(
            parse_args(&args(&["--build-info"]), &e),
            Ok(Command::BuildInfo)
        );
        assert_eq!(
            parse_args(&args(&["--print-identity"]), &e),
            Ok(Command::PrintIdentity)
        );
        assert_eq!(
            parse_args(&args(&["--idle-timeout", "0"]), &e),
            Ok(Command::Serve { idle: None })
        );
        assert_eq!(
            parse_args(&args(&["--idle-timeout", "9"]), &e),
            Ok(Command::Serve {
                idle: Some(Duration::from_secs(9))
            })
        );
        assert!(parse_args(&args(&["--nope"]), &e).is_err());
        assert!(parse_args(&args(&["--idle-timeout"]), &e).is_err());
        assert!(parse_args(&args(&["--idle-timeout", "x"]), &e).is_err());
    }

    #[test]
    fn parses_the_remote_commands() {
        let e = env(&[]);
        assert_eq!(parse_args(&args(&["remote"]), &e), Ok(Command::Remote));
        assert_eq!(parse_args(&args(&["unpair"]), &e), Ok(Command::Unpair));
        assert_eq!(
            parse_args(&args(&["status"]), &e),
            Ok(Command::Status { json: false })
        );
        assert_eq!(
            parse_args(&args(&["status", "--json"]), &e),
            Ok(Command::Status { json: true })
        );
        assert_eq!(
            parse_args(&args(&["pair", "psyche-machine:v1:abc"]), &e),
            Ok(Command::Pair {
                target: PairTarget::Text("psyche-machine:v1:abc".into()),
                replace: false,
                name: None
            })
        );
        assert_eq!(
            parse_args(
                &args(&["pair", "wss://a.ts.net", "--replace", "--name", "lab"]),
                &e
            ),
            Ok(Command::Pair {
                target: PairTarget::Text("wss://a.ts.net".into()),
                replace: true,
                name: Some("lab".into())
            })
        );
        assert_eq!(
            parse_args(&args(&["pair", "-"]), &e),
            Ok(Command::Pair {
                target: PairTarget::Stdin,
                replace: false,
                name: None
            })
        );
        for bad in [
            &["pair"][..],
            &["pair", "a", "b"],
            &["pair", "--name"],
            &["pair", "--nope", "x"],
            &["remote", "x"],
            &["unpair", "x"],
            &["status", "x"],
        ] {
            assert!(parse_args(&args(bad), &e).is_err(), "{bad:?}");
        }
        // The old flags still work, and a remote verb is only a verb in first position.
        assert!(parse_args(&args(&["--idle-timeout", "5", "remote"]), &e).is_err());
    }

    #[test]
    fn parses_update() {
        let e = env(&[]);
        assert_eq!(
            parse_args(&args(&["update"]), &e),
            Ok(Command::Update {
                check: false,
                rollback: false,
                from: None
            })
        );
        assert_eq!(
            parse_args(&args(&["update", "--check", "--from", "/d"]), &e),
            Ok(Command::Update {
                check: true,
                rollback: false,
                from: Some("/d".into())
            })
        );
        for bad in [
            &["update", "--rollback", "--check"][..],
            &["update", "--from"],
            &["update", "x"],
        ] {
            assert!(parse_args(&args(bad), &e).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_idle_environment_variable_sets_the_default() {
        let e = env(&[("PSYCHE_HELPER_IDLE_SECS", "42")]);
        assert_eq!(
            parse_args(&args(&[]), &e),
            Ok(Command::Serve {
                idle: Some(Duration::from_secs(42))
            })
        );
        assert!(parse_args(&args(&[]), &env(&[("PSYCHE_HELPER_IDLE_SECS", "x")])).is_err());
    }

    #[test]
    fn print_identity_is_read_only_and_null_before_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let e = env(&[("PSYCHE_HELPER_STATE", state.to_str().unwrap())]);
        let out = run_info(&Command::PrintIdentity, &e).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v["deviceId"].is_null());
        assert_eq!(v["deviceFamily"], "linux-helper");
        assert!(!state.exists(), "--print-identity must not create anything");
    }

    #[test]
    fn print_identity_shows_the_existing_device() {
        let dir = tempfile::tempdir().unwrap();
        let e = env(&[("PSYCHE_HELPER_STATE", dir.path().to_str().unwrap())]);
        let made = identity::load_or_create(dir.path()).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&run_info(&Command::PrintIdentity, &e).unwrap()).unwrap();
        assert_eq!(v["deviceId"], made.device_id());
        assert_eq!(v["publicKey"], made.public_key());
    }

    #[test]
    fn build_info_and_manifest_print_json() {
        let e = env(&[]);
        let b: serde_json::Value =
            serde_json::from_str(&run_info(&Command::BuildInfo, &e).unwrap()).unwrap();
        assert_eq!(b["platform"], "linux");
        let m: serde_json::Value =
            serde_json::from_str(&run_info(&Command::Manifest, &e).unwrap()).unwrap();
        assert_eq!(m.as_array().unwrap().len(), 1);
        assert_eq!(m[0]["name"], "health");
    }
}
