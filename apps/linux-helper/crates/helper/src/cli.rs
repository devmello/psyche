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

  (no flags)        connect to the Gateway's node socket and serve (exits after 5 minutes idle)
  --idle-timeout N  exit after N seconds with no work; 0 never exits (default 300)
  --manifest        print the capability manifest as JSON and exit
  --build-info      print {name, version, build, commit?, platform, arch, protocolVersion} and exit
  --print-identity  print {deviceId, publicKey, deviceFamily, platform} as JSON and exit: what the
                    Gateway will see (read-only; deviceId and publicKey are null until the helper
                    has run once)
";

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Serve { idle: Option<Duration> },
    PrintIdentity,
    BuildInfo,
    Manifest,
    Help,
}

pub fn parse_args(args: &[String], env: &dyn Env) -> Result<Command, String> {
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
        Command::Serve { .. } => Err("not a one-shot command".into()),
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
