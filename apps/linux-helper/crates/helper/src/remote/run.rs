//! The track A commands (design §3.6): `pair`, `remote`, `status`, `unpair`.

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::config::{self, RemoteConfig};
use super::daemon::{attempt, AttemptError, Exit, Pins, RemoteDaemon, EXIT_CONFIG};
use super::handshake::{Failure, Verdict};
use super::link::{self, name_ok, parse_gateway_url, parse_machine_link};
use super::machine::{find_sudo, remote_registry, MachineStatus};
use super::policy::{Owner, PolicySource, Source};
use super::transport::{Target, TransportError};
use super::verify::fingerprint;
use crate::buildinfo::BuildInfo;
use crate::capability::Registry;
use crate::cli::{Command, PairTarget};
use crate::identity::{self, REMOTE_IDENTITY_FILE};
use crate::idle::IdleTimer;
use crate::paths::{state_dir, Env};

/// How long `pair` without a link waits for the owner to approve it on the Mac.
const APPROVAL_WAIT: Duration = Duration::from_secs(10 * 60);
const APPROVAL_POLL: Duration = Duration::from_secs(5);

#[cfg(test)]
thread_local! {
    /// Tests aim `pair` and `unpair` at a local fake Gateway (a link never names loopback).
    pub static TEST_TARGET: std::cell::RefCell<Option<Target>> = const { std::cell::RefCell::new(None) };
}

fn resolve_target(target: Target) -> Target {
    #[cfg(test)]
    if let Some(t) = TEST_TARGET.with(|c| c.borrow().clone()) {
        return t;
    }
    target
}

struct Dirs {
    config: PathBuf,
    state: PathBuf,
    home: PathBuf,
}

fn dirs(env: &dyn Env) -> Result<Dirs, String> {
    let home = env
        .home()
        .map(PathBuf::from)
        .filter(|h| h.is_absolute())
        .ok_or("no passwd entry with an absolute home for this account")?;
    Ok(Dirs {
        config: config::config_dir(env),
        state: state_dir(env),
        home,
    })
}

/// Declared when pairing: what a machine always offers. The full set is declared by `remote`.
fn pairing_capabilities(dirs: &Dirs, env: &dyn Env) -> Vec<psyche_protocol::NodeCapability> {
    let (registry, _) = machine_registry(&Registry::standard(BuildInfo::current()), dirs, env);
    registry.manifest()
}

fn policy_source(dirs: &Dirs) -> Arc<PolicySource> {
    Arc::new(PolicySource::standard(
        &dirs.config,
        dirs.home.clone(),
        None,
    ))
}

fn machine_registry(full: &Registry, dirs: &Dirs, env: &dyn Env) -> (Registry, Vec<String>) {
    let source = policy_source(dirs);
    let account = if env.get("PSYCHE_HELPER_ACCOUNT").as_deref() == Some("dedicated") {
        "dedicated"
    } else {
        "own"
    };
    let status = Arc::new(MachineStatus::new(
        Arc::clone(&source),
        BuildInfo::current(),
        find_sudo(),
        account,
    ));
    remote_registry(full, source, status)
}

/// This computer's name: the host name, cleaned to what a machine name may be.
pub fn default_machine_name() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its length; gethostname writes at most that many bytes.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len() - 1) };
    let raw = if rc == 0 {
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    } else {
        String::new()
    };
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' '))
        .take(64)
        .collect();
    let cleaned = cleaned.trim().to_string();
    if name_ok(&cleaned) {
        cleaned
    } else {
        "linux-box".to_string()
    }
}

pub fn dispatch(command: Command, env: &dyn Env) -> ExitCode {
    let dirs = match dirs(env) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("psyche-helper: {e}");
            return ExitCode::FAILURE;
        }
    };
    match command {
        Command::Pair {
            target,
            replace,
            name,
        } => finish(pair(&dirs, env, &target, replace, name)),
        Command::Remote => remote(&dirs, env),
        Command::Status { json } => finish(status(&dirs, env, json).map(|text| println!("{text}"))),
        Command::Unpair => finish(unpair(&dirs, env)),
        _ => ExitCode::FAILURE,
    }
}

/// The key's directory must be ours and not writable by others before a key is read, made or
/// wiped in it. A directory that does not exist yet is fine: it is created 0700.
fn state_ok(dirs: &Dirs) -> Result<(), String> {
    if dirs.state.exists() {
        config::check_dir(&dirs.state).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Reads one line from a terminal without echoing it (the link holds a one-time token).
fn prompt_no_echo(prompt: &str) -> Result<String, String> {
    eprint!("{prompt}");
    // SAFETY: termios calls on standard input with a zeroed, then filled, struct.
    let saved = unsafe {
        let mut t: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(0, &mut t) != 0 {
            return Err("could not read the terminal settings".into());
        }
        let saved = t;
        t.c_lflag &= !libc::ECHO;
        if libc::tcsetattr(0, libc::TCSANOW, &t) != 0 {
            return Err("could not turn off echo".into());
        }
        saved
    };
    let mut line = String::new();
    let read = std::io::stdin().read_line(&mut line);
    // SAFETY: restores the settings read above.
    unsafe {
        libc::tcsetattr(0, libc::TCSANOW, &saved);
    }
    eprintln!();
    read.map_err(|e| format!("could not read the link: {e}"))?;
    Ok(line)
}

fn finish(result: Result<(), String>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("psyche-helper: {message}");
            ExitCode::FAILURE
        }
    }
}

// ---------------------------------------------------------------------------------------------
// remote

fn remote(dirs: &Dirs, env: &dyn Env) -> ExitCode {
    let config = match config::load(&dirs.config) {
        Ok(Some(c)) => c,
        Ok(None) => {
            crate::log("this computer is not paired; run `psyche-helper pair` first");
            return ExitCode::from(EXIT_CONFIG);
        }
        Err(e) => {
            crate::log(&format!("remote.json: {e}"));
            return ExitCode::from(EXIT_CONFIG);
        }
    };
    if let Err(e) = state_ok(dirs) {
        crate::log(&format!("state directory: {e}"));
        return ExitCode::from(EXIT_CONFIG);
    }
    // Loaded, never created: a missing key means the pairing is gone, not "pair as someone new".
    let identity = match identity::load_file(&dirs.state, REMOTE_IDENTITY_FILE) {
        Ok(Some(i)) => i,
        Ok(None) => {
            crate::log("this computer has no key for its Gateway; run `psyche-helper pair` again");
            return ExitCode::from(EXIT_CONFIG);
        }
        Err(e) => {
            crate::log(&format!("identity: {e}"));
            return ExitCode::from(EXIT_CONFIG);
        }
    };

    // The same mode and NoNewPrivileges step as `serve`, before anything is registered.
    #[cfg(target_os = "linux")]
    let headless = match crate::headless::setup(true, env) {
        Ok(h) => h,
        Err((message, code)) => {
            crate::log(&message);
            return ExitCode::from(code);
        }
    };
    let idle = Arc::new(IdleTimer::new(None));
    #[allow(unused_mut)]
    let mut full = Registry::standard(BuildInfo::current());
    // Direct computer use: offered if the remote allowlist and the ceiling let it through.
    crate::direct::register(&mut full);
    #[cfg(target_os = "linux")]
    let vscreen = crate::vscreen::register(&mut full, env, Arc::clone(&idle));
    #[cfg(target_os = "linux")]
    if headless {
        crate::headless::install(Arc::clone(&vscreen));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = &idle;
    let (registry, dropped) = machine_registry(&full, dirs, env);
    if !dropped.is_empty() {
        crate::log(&format!("not offered to a Gateway: {}", dropped.join(", ")));
    }
    let mut daemon = match RemoteDaemon::new(
        config,
        identity,
        registry,
        dirs.config.clone(),
        dirs.state.clone(),
    ) {
        Ok(d) => d,
        Err(e) => {
            crate::log(&format!("remote.json: {e}"));
            return ExitCode::from(EXIT_CONFIG);
        }
    };
    let exit = daemon.run();
    #[cfg(target_os = "linux")]
    vscreen.shutdown();
    match exit {
        Exit::Stopped => ExitCode::SUCCESS,
        other => ExitCode::from(other.code()),
    }
}

// ---------------------------------------------------------------------------------------------
// pair

fn read_link_arg(target: &PairTarget) -> Result<PairInput, String> {
    match target {
        PairTarget::Stdin => {
            // SAFETY: isatty only inspects descriptor 0.
            if unsafe { libc::isatty(0) } == 1 {
                return Ok(PairInput::Link(prompt_no_echo(
                    "Paste the link from Psyche: ",
                )?));
            }
            let mut text = String::new();
            std::io::stdin()
                .take(4096)
                .read_to_string(&mut text)
                .map_err(|e| format!("could not read the link: {e}"))?;
            Ok(PairInput::Link(text))
        }
        PairTarget::Text(text) => {
            let lower = text.trim().to_ascii_lowercase();
            if lower.starts_with("psyche-machine:") {
                eprintln!(
                    "psyche-helper: a link on the command line is visible to other users in `ps` \
                     and stays in your shell history; its token works once for ten minutes. \
                     Prefer `psyche-helper pair -` and paste it."
                );
                Ok(PairInput::Link(text.clone()))
            } else if lower.starts_with("psyche-pair:") {
                Err(
                    "that is a link for a desktop or phone, not for a computer Psyche uses; \
                     make one under Computers Psyche can use"
                        .into(),
                )
            } else if lower.starts_with("wss://") {
                Ok(PairInput::Url(text.trim().to_string()))
            } else {
                Err("pair takes a psyche-machine: link, or a wss:// address".into())
            }
        }
    }
}

enum PairInput {
    Link(String),
    Url(String),
}

fn print_fingerprints(gateway_key: &str, identity: &identity::DeviceIdentity) {
    println!(
        "  Gateway key:  {}",
        fingerprint(gateway_key).unwrap_or_default()
    );
    println!("  This computer: {}", identity.device_id());
}

fn pair(
    dirs: &Dirs,
    env: &dyn Env,
    target: &PairTarget,
    replace: bool,
    name: Option<String>,
) -> Result<(), String> {
    // Everything that can be refused is refused before any state is touched or created.
    enum Parsed {
        Link(link::MachineLink),
        Url(link::Origin),
    }
    let parsed = match read_link_arg(target)? {
        PairInput::Link(text) => {
            Parsed::Link(parse_machine_link(&text).map_err(|e| e.to_string())?)
        }
        PairInput::Url(url) => Parsed::Url(parse_gateway_url(&url)?),
    };
    let machine_name = name.clone().unwrap_or_else(default_machine_name);
    if !name_ok(&machine_name) {
        return Err(
            "that name has hidden or control characters, or is not 1 to 64 characters".into(),
        );
    }
    state_ok(dirs)?;
    let existing = config::load(&dirs.config).map_err(|e| e.to_string())?;
    if let Some(existing) = existing {
        if !replace {
            return Err(format!(
                "this computer is already paired with {}; use --replace to pair with another Gateway",
                existing.gateway_url
            ));
        }
        unpair(dirs, env)?;
    }
    // A fresh key for every pairing. Whatever an earlier, unfinished attempt left is wiped.
    config::wipe(&dirs.config, &dirs.state).map_err(|e| e.to_string())?;
    config::ensure_private_dir(&dirs.state).map_err(|e| e.to_string())?;
    let identity = identity::load_or_create_file(&dirs.state, REMOTE_IDENTITY_FILE)
        .map_err(|e| e.to_string())?;
    let caps = pairing_capabilities(dirs, env);

    let result = match parsed {
        Parsed::Link(link) => {
            println!(
                "Pairing with {} at {} ...",
                link.host_name, link.gateway_url
            );
            let target = resolve_target(
                Target::from_origin(&link.gateway_url, link.cert_pin.as_deref())
                    .ok_or("the link names an address this helper will not dial")?,
            );
            let pins = Pins {
                gateway_key: Some(link.gateway_key.clone()),
                first_seen_key: None,
                cert_pin: link.cert_pin.clone(),
            };
            pair_loop(
                &target,
                &identity,
                &machine_name,
                &caps,
                pins,
                Some(&link.setup_token),
                false,
            )
            .map(|key| (link.gateway_url.clone(), key, link.cert_pin.clone()))
        }
        Parsed::Url(origin) => {
            println!("Pairing with {} ...", origin.https());
            let target = resolve_target(Target::of(&origin, None));
            pair_loop(
                &target,
                &identity,
                &machine_name,
                &caps,
                Pins::default(),
                None,
                true,
            )
            .map(|key| (origin.https(), key, None))
        }
    };
    match result {
        Ok((gateway_url, gateway_key, cert_pin)) => {
            let config = RemoteConfig::new(
                gateway_url,
                gateway_key.clone(),
                cert_pin,
                machine_name.clone(),
            );
            if let Err(e) = config::save(&dirs.config, &config) {
                let _ = config::wipe(&dirs.config, &dirs.state);
                return Err(format!("paired, but could not save remote.json: {e}"));
            }
            println!("Paired as {machine_name}.");
            print_fingerprints(&gateway_key, &identity);
            println!("Start it with `psyche-helper remote` (the systemd unit does).");
            Ok(())
        }
        Err(message) => {
            let _ = config::wipe(&dirs.config, &dirs.state);
            Err(message)
        }
    }
}

/// Connects until the Gateway says paired. A link pairs at once (its token is the owner's
/// approval); without one the owner approves on the Mac and this waits.
fn pair_loop(
    target: &Target,
    identity: &identity::DeviceIdentity,
    name: &str,
    caps: &[psyche_protocol::NodeCapability],
    mut pins: Pins,
    token: Option<&str>,
    trust_on_first_sight: bool,
) -> Result<String, String> {
    let deadline = Instant::now() + APPROVAL_WAIT;
    let mut announced = false;
    loop {
        match attempt(target, identity, name, caps.to_vec(), &pins, token) {
            Ok((key, verdict, session)) => {
                session.link.close();
                if trust_on_first_sight {
                    // Held in memory for this pairing only; written to remote.json once paired.
                    pins.first_seen_key = Some(key.clone());
                }
                match verdict {
                    Verdict::Paired => return Ok(key),
                    Verdict::Pending { code } => {
                        if !announced {
                            announced = true;
                            println!(
                                "Waiting for you to approve this computer in Psyche on the Mac."
                            );
                            print_fingerprints(&key, identity);
                            println!("  Code:         {}", code.as_deref().unwrap_or("?"));
                            println!("Compare the Gateway key and the code with the card, then tap Approve.");
                        }
                    }
                    Verdict::Denied { code, reason } => return Err(match code.as_deref() {
                        Some("setup_token_invalid") => {
                            "the link was already used, has expired or was revoked; make a new one"
                                .into()
                        }
                        Some("device_revoked") => "the Gateway has removed this computer".into(),
                        _ => format!("the Gateway refused: {}", reason.unwrap_or_default()),
                    }),
                }
            }
            Err(AttemptError::Handshake(Failure::Identity(e))) => {
                return Err(format!("not pairing: {e} ({})", e.code()))
            }
            Err(AttemptError::Dial(TransportError::PinMismatch)) => {
                return Err(
                    "not pairing: the Gateway's certificate is not the one in the link".into(),
                )
            }
            Err(AttemptError::Handshake(Failure::Gateway(code)))
                if code == "protocol_version_mismatch" =>
            {
                return Err(
                    "the Gateway and this helper share no protocol version; update the helper"
                        .into(),
                )
            }
            Err(e) => {
                if token.is_some() || Instant::now() >= deadline {
                    return Err(format!("could not reach the Gateway: {e}"));
                }
            }
        }
        if Instant::now() >= deadline {
            return Err("nobody approved this computer in time".into());
        }
        std::thread::sleep(APPROVAL_POLL);
    }
}

// ---------------------------------------------------------------------------------------------
// unpair

fn unpair(dirs: &Dirs, env: &dyn Env) -> Result<(), String> {
    state_ok(dirs)?;
    let config = config::load(&dirs.config).unwrap_or(None);
    let identity = identity::load_file(&dirs.state, REMOTE_IDENTITY_FILE).unwrap_or(None);
    let mut removed_on_gateway = false;
    if let (Some(config), Some(identity)) = (&config, &identity) {
        if let Ok(target) = config.target().map(resolve_target) {
            let pins = Pins {
                gateway_key: Some(config.gateway_key.clone()),
                first_seen_key: None,
                cert_pin: config.cert_pin.clone(),
            };
            let caps = pairing_capabilities(dirs, env);
            // The Gateway is verified like for any connection; nothing is sent to a stranger.
            if let Ok((_, Verdict::Paired, mut session)) =
                attempt(&target, identity, &config.machine_name, caps, &pins, None)
            {
                removed_on_gateway = session
                    .request("unpair", "node.unpair", &json!({}), Duration::from_secs(5))
                    .is_ok();
                session.link.close();
            }
        }
    }
    config::wipe(&dirs.config, &dirs.state).map_err(|e| e.to_string())?;
    if config.is_none() && identity.is_none() {
        println!("This computer was not paired.");
    } else if removed_on_gateway {
        println!("Removed from the Gateway, and this computer's key is gone.");
    } else {
        println!(
            "This computer's key is gone. The Gateway could not be reached to remove it: \
             remove this computer under Computers Psyche can use on the Mac."
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// status

fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists and may be signalled.
    pid != 0 && unsafe { libc::kill(pid as libc::pid_t, 0) } == 0
}

fn status(dirs: &Dirs, env: &dyn Env, as_json: bool) -> Result<String, String> {
    state_ok(dirs)?;
    let config = config::load(&dirs.config).map_err(|e| e.to_string())?;
    let Some(config) = config else {
        return Ok(if as_json {
            json!({ "paired": false }).to_string()
        } else {
            "Not paired. Run `psyche-helper pair '<link>'`.".to_string()
        });
    };
    let identity =
        identity::load_file(&dirs.state, REMOTE_IDENTITY_FILE).map_err(|e| e.to_string())?;
    let connection = match config::read_status(&dirs.state) {
        Some(s) if process_alive(s.pid) => {
            json!({ "state": s.state, "since": s.since, "detail": s.detail })
        }
        _ => json!({ "state": "not running" }),
    };
    let source = policy_source(dirs);
    let loaded = source.load();
    let sudo = find_sudo()
        .as_deref()
        .is_some_and(super::machine::passwordless_sudo);
    let policy_note = match &loaded.source {
        Source::File(p) => format!("{}", p.display()),
        Source::Default => "defaults (no policy.json)".to_string(),
        Source::Invalid(why) => format!("INVALID, everything is denied ({why})"),
    };
    let owner = match crate::update::ceiling_owner_reason(matches!(loaded.owner, Owner::Root)) {
        Some(_) => "root's file, but it limits what your account reaches and is not enforced against it",
        None => "your account",
    }
    .to_string();
    let account = if env.get("PSYCHE_HELPER_ACCOUNT").as_deref() == Some("dedicated") {
        "dedicated"
    } else {
        "own"
    };
    let value = json!({
        "paired": true,
        "gatewayUrl": config.gateway_url,
        "gatewayFingerprint": fingerprint(&config.gateway_key),
        "certificatePinned": config.cert_pin.is_some(),
        "machineName": config.machine_name,
        "deviceId": identity.as_ref().map(|i| i.device_id()),
        "connection": connection,
        "display": Value::Null,
        "account": account,
        "policy": {
            "source": policy_note,
            "ownedBy": owner,
            "surfaces": loaded.policy.surfaces,
            "exec": loaded.policy.exec,
            "files": loaded.policy.files,
            "apps": loaded.policy.apps,
        },
        "passwordlessSudo": sudo,
    });
    if as_json {
        return Ok(value.to_string());
    }
    let mut out = String::new();
    let mut line = |text: String| {
        out.push_str(&text);
        out.push('\n');
    };
    line(format!("Gateway:      {}", config.gateway_url));
    line(format!(
        "Fingerprint:  {}",
        fingerprint(&config.gateway_key).unwrap_or_default()
    ));
    line(format!(
        "Certificate:  {}",
        if config.cert_pin.is_some() {
            "pinned (local network)"
        } else {
            "public CA"
        }
    ));
    line(format!(
        "Machine:      {} ({})",
        config.machine_name,
        identity.map(|i| i.device_id()).unwrap_or_default()
    ));
    line(format!(
        "Connection:   {}",
        connection["state"].as_str().unwrap_or("unknown")
    ));
    line("Display:      unknown".to_string());
    line(format!("Account:      {account}"));
    line(format!("Limits:       {policy_note}, set by {owner}"));
    line(format!(
        "  private screen {}, direct screen {}, shell {}, files in {} root(s)",
        onoff(loaded.policy.surfaces.virtual_screen),
        onoff(loaded.policy.surfaces.direct),
        onoff(loaded.policy.exec.enabled),
        loaded.policy.files.roots.len()
    ));
    line(format!(
        "Passwordless sudo: {}",
        if sudo { "yes" } else { "no" }
    ));
    Ok(out.trim_end().to_string())
}

fn onoff(on: bool) -> &'static str {
    if on {
        "on"
    } else {
        "off"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::testutil::{FakeGateway, GatewayCfg, LanCert, Script};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use std::collections::HashMap;

    const TOKEN: &str = "pst_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

    struct Fx {
        _dir: tempfile::TempDir,
        env: HashMap<String, String>,
    }

    impl Fx {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let p = |n: &str| dir.path().join(n).display().to_string();
            let env = HashMap::from([
                ("HOME".to_string(), p("home")),
                ("PSYCHE_HELPER_CONFIG".to_string(), p("cfg")),
                ("PSYCHE_HELPER_STATE".to_string(), p("state")),
            ]);
            Self { _dir: dir, env }
        }
        fn dirs(&self) -> Dirs {
            dirs(&self.env).unwrap()
        }
        fn link(&self, gateway_key: &str, pin: &str, token: &str) -> String {
            let body = json!({
                "gatewayUrl": "https://192.168.1.4:7979", "gatewayKey": gateway_key,
                "certPin": pin, "setupToken": token, "hostName": "Studio Mac"
            });
            format!(
                "psyche-machine:v1:{}",
                URL_SAFE_NO_PAD.encode(body.to_string())
            )
        }
    }

    fn text(link: &str) -> PairTarget {
        PairTarget::Text(link.to_string())
    }

    fn aim(target: Target) {
        TEST_TARGET.with(|c| *c.borrow_mut() = Some(target));
    }

    fn lan_gateway(mut cfg: GatewayCfg) -> FakeGateway {
        cfg.lan_cert = LanCert::Served;
        FakeGateway::start_tls(Script::gateway(cfg))
    }

    #[test]
    fn pair_by_link_pins_the_gateway_saves_0600_files_and_presents_the_token_once() {
        let fx = Fx::new();
        let gateway = lan_gateway(GatewayCfg::new());
        aim(gateway.target_tls());
        let link = fx.link(&gateway.gateway_key(), &gateway.pin(), TOKEN);
        pair(
            &fx.dirs(),
            &fx.env,
            &text(&link),
            false,
            Some("lab-box".into()),
        )
        .unwrap();

        let saved = config::load(&fx.dirs().config).unwrap().unwrap();
        assert_eq!(saved.gateway_url, "https://192.168.1.4:7979");
        assert_eq!(saved.gateway_key, gateway.gateway_key());
        assert_eq!(saved.cert_pin.as_deref(), Some(gateway.pin().as_str()));
        assert_eq!(saved.machine_name, "lab-box");
        let key = fx.dirs().state.join(REMOTE_IDENTITY_FILE);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&key).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(
            !fx.dirs().home.join(".psyche").exists(),
            "nothing under ~/.psyche"
        );
        let frames = gateway.frames();
        let verifies: Vec<_> = frames
            .iter()
            .filter(|f| f["method"] == "connect.verify")
            .collect();
        assert_eq!(verifies.len(), 1);
        assert_eq!(verifies[0]["params"]["setupToken"], TOKEN);
        assert!(!frames[0].to_string().contains(TOKEN));

        // A second pair needs --replace.
        let err = pair(&fx.dirs(), &fx.env, &text(&link), false, None).unwrap_err();
        assert!(err.contains("--replace"), "{err}");
        // status reads, never writes, and never shows the token.
        let shown = status(&fx.dirs(), &fx.env, false).unwrap();
        assert!(
            shown.contains("pinned (local network)") && shown.contains("lab-box"),
            "{shown}"
        );
        assert!(!shown.contains(TOKEN));
        let v: Value = serde_json::from_str(&status(&fx.dirs(), &fx.env, true).unwrap()).unwrap();
        assert_eq!(v["paired"], true);
        assert_eq!(v["connection"]["state"], "not running");
        assert_eq!(v["policy"]["exec"]["enabled"], false);
    }

    #[test]
    fn a_failed_pairing_leaves_no_key_and_no_remote_json() {
        // A used or expired token.
        let fx = Fx::new();
        let mut cfg = GatewayCfg::new();
        cfg.verdict = json!({"phase":"denied","reason":"used","code":"setup_token_invalid"});
        let gateway = lan_gateway(cfg);
        aim(gateway.target_tls());
        let link = fx.link(&gateway.gateway_key(), &gateway.pin(), TOKEN);
        let err = pair(&fx.dirs(), &fx.env, &text(&link), false, None).unwrap_err();
        assert!(err.contains("already used"), "{err}");
        assert!(!fx.dirs().state.join(REMOTE_IDENTITY_FILE).exists());
        assert!(config::load(&fx.dirs().config).unwrap().is_none());

        // A link whose pinned key is not the key the Gateway proves: no signature, no token.
        let fx = Fx::new();
        let gateway = lan_gateway(GatewayCfg::new());
        aim(gateway.target_tls());
        let wrong = URL_SAFE_NO_PAD.encode([9u8; 32]);
        let link = fx.link(&wrong, &gateway.pin(), TOKEN);
        let err = pair(&fx.dirs(), &fx.env, &text(&link), false, None).unwrap_err();
        assert!(err.contains("gateway_identity_changed"), "{err}");
        assert!(gateway
            .frames()
            .iter()
            .all(|f| f["method"] != "connect.verify"));
        assert!(!fx.dirs().state.join(REMOTE_IDENTITY_FILE).exists());

        // A link whose certificate pin is not the certificate served: nothing is written to it.
        let fx = Fx::new();
        let gateway = lan_gateway(GatewayCfg::new());
        let mut target = gateway.target_tls();
        target.security =
            crate::remote::transport::Security::Pin(crate::remote::testutil::other_pin());
        aim(target);
        let link = fx.link(
            &gateway.gateway_key(),
            &crate::remote::testutil::other_pin(),
            TOKEN,
        );
        let err = pair(&fx.dirs(), &fx.env, &text(&link), false, None).unwrap_err();
        assert!(err.contains("certificate"), "{err}");
        assert_eq!(gateway.app_bytes_received(), 0);
        assert!(!fx.dirs().state.join(REMOTE_IDENTITY_FILE).exists());
    }

    #[test]
    fn links_for_other_things_and_bad_arguments_are_refused_before_any_key_is_made() {
        let fx = Fx::new();
        for bad in [
            "psyche-pair:v1:abc",
            "psyche-pair:v2:abc",
            "https://a.ts.net",
            "ws://a.ts.net",
            "psyche-machine:v1:!!",
            "psyche-machine:v2:abc",
            "",
        ] {
            assert!(
                pair(&fx.dirs(), &fx.env, &text(bad), false, None).is_err(),
                "{bad:?}"
            );
        }
        assert!(!fx.dirs().state.exists(), "no state was created");
        let link = fx.link(
            &URL_SAFE_NO_PAD.encode([1u8; 32]),
            &URL_SAFE_NO_PAD.encode([2u8; 32]),
            TOKEN,
        );
        let err = pair(
            &fx.dirs(),
            &fx.env,
            &text(&link),
            false,
            Some("bad\u{202e}name".into()),
        )
        .unwrap_err();
        assert!(err.contains("hidden"), "{err}");
        assert!(!fx.dirs().state.exists());
    }

    #[test]
    fn pair_without_a_link_saves_the_key_only_after_the_gateway_says_paired() {
        let fx = Fx::new();
        let gateway = FakeGateway::start(Script::gateway(GatewayCfg::new()));
        aim(gateway.target_plain());
        pair(
            &fx.dirs(),
            &fx.env,
            &text("wss://studio.ts.net"),
            false,
            Some("lab-box".into()),
        )
        .unwrap();
        let saved = config::load(&fx.dirs().config).unwrap().unwrap();
        assert_eq!(saved.gateway_url, "https://studio.ts.net");
        assert_eq!(saved.gateway_key, gateway.gateway_key());
        assert!(gateway
            .frames()
            .iter()
            .all(|f| !f.to_string().contains("setupToken")));
    }

    #[test]
    fn unpair_asks_the_gateway_to_remove_it_then_wipes_even_if_it_cannot() {
        let fx = Fx::new();
        let gateway = lan_gateway(GatewayCfg::new());
        aim(gateway.target_tls());
        let link = fx.link(&gateway.gateway_key(), &gateway.pin(), TOKEN);
        pair(
            &fx.dirs(),
            &fx.env,
            &text(&link),
            false,
            Some("lab-box".into()),
        )
        .unwrap();
        unpair(&fx.dirs(), &fx.env).unwrap();
        assert!(gateway
            .frames()
            .iter()
            .any(|f| f["method"] == "node.unpair"));
        // `devices.revokeSelf` needs a scope a machine does not have; it is never called.
        assert!(gateway
            .frames()
            .iter()
            .all(|f| f["method"] != "devices.revokeSelf"));
        assert!(config::load(&fx.dirs().config).unwrap().is_none());
        assert!(!fx.dirs().state.join(REMOTE_IDENTITY_FILE).exists());

        // Pair again, then make the Gateway unreachable.
        let gateway = lan_gateway(GatewayCfg::new());
        aim(gateway.target_tls());
        let link = fx.link(&gateway.gateway_key(), &gateway.pin(), TOKEN);
        pair(
            &fx.dirs(),
            &fx.env,
            &text(&link),
            false,
            Some("lab-box".into()),
        )
        .unwrap();
        drop(gateway);
        std::thread::sleep(Duration::from_millis(200));
        unpair(&fx.dirs(), &fx.env).unwrap();
        assert!(config::load(&fx.dirs().config).unwrap().is_none());
        assert!(!fx.dirs().state.join(REMOTE_IDENTITY_FILE).exists());
        // Unpairing an unpaired computer is fine.
        unpair(&fx.dirs(), &fx.env).unwrap();
        assert!(status(&fx.dirs(), &fx.env, false)
            .unwrap()
            .starts_with("Not paired"));
    }

    #[test]
    fn the_default_machine_name_is_a_valid_name() {
        assert!(name_ok(&default_machine_name()));
    }
}
