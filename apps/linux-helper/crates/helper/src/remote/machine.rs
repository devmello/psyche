//! What this computer offers as a machine: the remote-mode capability allowlist, the policy gate
//! at dispatch, and the read-only `machine.status` report (design §6.2, §9).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use psyche_protocol::SideEffect;
use serde_json::{json, Value};

use super::policy::{Owner, PolicySource, Source};
use crate::buildinfo::BuildInfo;
use crate::capability::{Capability, CapabilityError, CapabilitySpec, InvocationContext, Registry};

/// What the Gateway may ask a machine to do. The helper registers nothing else in remote mode:
/// no `notify.*`, `speech.*`, `keychain.*`, `presence.*`, `dictation.*`, `screen.*`, `teach.*`.
pub fn remote_allowed(name: &str) -> bool {
    matches!(
        name,
        "health"
            | "machine.status"
            | "a11y.status"
            | "portal.status"
            | "apps.list"
            | "apps.open"
            | "apps.focus"
            | "exec.host"
            | "fs.list"
            | "fs.stat"
            | "fs.read"
            | "fs.write"
            | "fs.mkdir"
            | "fs.remove"
    ) || name.strip_prefix("computer.").is_some_and(is_word)
        || name.strip_prefix("vscreen.").is_some_and(is_word)
}

fn is_word(rest: &str) -> bool {
    !rest.is_empty()
        && rest
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// One capability behind the ceiling: the policy file is read again for every invocation and
/// the call is refused before the capability sees it.
struct Gated {
    inner: Arc<dyn Capability>,
    source: Arc<PolicySource>,
}

impl Capability for Gated {
    fn spec(&self) -> CapabilitySpec {
        self.inner.spec()
    }

    fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
        let loaded = self.source.load();
        loaded
            .policy
            .check(&ctx.capability, &ctx.params, &self.source.home)?;
        self.inner.invoke(ctx)
    }
}

/// The registry a machine serves: the allowed capabilities of `full`, each behind the policy gate,
/// plus `machine.status`. Returns the names that were left out.
pub fn remote_registry(
    full: &Registry,
    source: Arc<PolicySource>,
    status: Arc<MachineStatus>,
) -> (Registry, Vec<String>) {
    let mut out = Registry::new();
    let mut dropped = Vec::new();
    for entry in full.manifest() {
        let name = entry.name;
        if name == "machine.status" || !remote_allowed(&name) {
            dropped.push(name);
            continue;
        }
        if let Some(inner) = full.get(&name) {
            out.register(Arc::new(Gated {
                inner: Arc::clone(inner),
                source: Arc::clone(&source),
            }));
        }
    }
    out.register(Arc::new(StatusCapability(status)));
    (out, dropped)
}

/// `sudo -n true`: whether this account can become root without a password. Reported to the
/// Gateway so Settings can say so; the helper itself never runs sudo for anything else.
pub fn passwordless_sudo(sudo: &std::path::Path) -> bool {
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new(sudo)
        .args(["-n", "true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_clear()
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// The `sudo` that is installed in a standard place. No `$PATH` search: a planted `sudo` earlier
/// on the path is not run.
pub fn find_sudo() -> Option<PathBuf> {
    ["/usr/bin/sudo", "/bin/sudo", "/usr/local/bin/sudo"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

const SUDO_CACHE: Duration = Duration::from_secs(300);

/// The data behind `machine.status`.
pub struct MachineStatus {
    source: Arc<PolicySource>,
    build: BuildInfo,
    sudo: Option<PathBuf>,
    account: &'static str,
    cache: Mutex<Option<(Instant, bool)>>,
}

impl MachineStatus {
    pub fn new(
        source: Arc<PolicySource>,
        build: BuildInfo,
        sudo: Option<PathBuf>,
        account: &'static str,
    ) -> Self {
        Self {
            source,
            build,
            sudo,
            account,
            cache: Mutex::new(None),
        }
    }

    fn sudo_report(&self) -> bool {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, value)) = *cache {
            if at.elapsed() < SUDO_CACHE {
                return value;
            }
        }
        let value = self.sudo.as_deref().is_some_and(passwordless_sudo);
        *cache = Some((Instant::now(), value));
        value
    }

    /// The report: what `MachineInfo` shows from the box's side. For display only; the Gateway
    /// never trusts it for a decision.
    pub fn report(&self) -> Value {
        let loaded = self.source.load();
        let p = &loaded.policy;
        let roots: Vec<Value> = p
            .files
            .roots
            .iter()
            .map(|r| json!({ "path": r.path, "mode": r.mode }))
            .collect();
        let mut surfaces = Vec::new();
        if p.surfaces.virtual_screen {
            surfaces.push("virtual_screen");
        }
        if p.surfaces.direct {
            surfaces.push("direct");
        }
        json!({
            "account": self.account,
            "policyOwner": match loaded.owner { Owner::Root => "root", Owner::User => "user" },
            "policyValid": !matches!(loaded.source, Source::Invalid(_)),
            "passwordlessSudo": self.sudo_report(),
            "exec": { "enabled": p.exec.enabled, "contained": p.exec.contain },
            "files": { "roots": roots },
            "surfaces": surfaces,
            "display": Value::Null,
            "helperVersion": self.build.version,
        })
    }
}

struct StatusCapability(Arc<MachineStatus>);

impl Capability for StatusCapability {
    fn spec(&self) -> CapabilitySpec {
        CapabilitySpec {
            name: "machine.status",
            description: "Reports this computer's limits, account and helper version. Read-only.",
            side_effect: SideEffect::None,
            target_kind: None,
            streaming: false,
        }
    }

    fn invoke(&self, _ctx: &InvocationContext) -> Result<Value, CapabilityError> {
        Ok(self.0.report())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::Registry;
    use psyche_protocol::ErrorCode;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::AtomicBool;

    struct Probe {
        name: &'static str,
        ran: Arc<AtomicBool>,
    }

    impl Capability for Probe {
        fn spec(&self) -> CapabilitySpec {
            CapabilitySpec {
                name: self.name,
                description: "test",
                side_effect: SideEffect::None,
                target_kind: None,
                streaming: false,
            }
        }
        fn invoke(&self, _ctx: &InvocationContext) -> Result<Value, CapabilityError> {
            self.ran.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(json!({"ran": true}))
        }
    }

    fn ctx(name: &str, params: Value) -> InvocationContext {
        InvocationContext {
            invocation_id: "i".into(),
            capability: name.into(),
            params,
            approval_id: None,
            emit: Arc::new(|_| {}),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    fn source(dir: &std::path::Path) -> Arc<PolicySource> {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        Arc::new(PolicySource {
            etc: dir.join("etc.json"),
            // Never root in a test: an absent /etc policy file is simply not there.
            etc_owner: 0,
            user: dir.join("user.json"),
            home: dir.join("home"),
        })
    }

    #[test]
    fn the_allowlist_is_exactly_the_design_list() {
        for name in [
            "health",
            "machine.status",
            "computer.click",
            "computer.snapshot",
            "apps.list",
            "apps.open",
            "apps.focus",
            "vscreen.start",
            "vscreen.frame",
            "vscreen.input",
            "a11y.status",
            "portal.status",
            "exec.host",
            "fs.list",
            "fs.stat",
            "fs.read",
            "fs.write",
            "fs.mkdir",
            "fs.remove",
        ] {
            assert!(remote_allowed(name), "{name}");
        }
        for name in [
            "notify.show",
            "speech.say",
            "keychain.get",
            "presence.verify",
            "dictation.start",
            "screen.capture",
            "teach.run",
            "a11y.enable",
            "portal.request",
            "apps.kill",
            "fs.rename",
            "fs.chmod",
            "exec.shell",
            "exec.",
            "computer.",
            "computer.click.x",
            "computer.Click",
            "vscreen.",
            "vscreen.a-b",
            "Health",
            "health ",
            "",
            "computer",
            "fs",
            "machine.status2",
        ] {
            assert!(!remote_allowed(name), "{name:?}");
        }
    }

    #[test]
    fn the_remote_registry_drops_everything_else_and_gates_what_stays() {
        let dir = tempfile::tempdir().unwrap();
        let ran = Arc::new(AtomicBool::new(false));
        let mut full = Registry::new();
        for name in [
            "notify.show",
            "computer.click",
            "keychain.get",
            "exec.host",
            "speech.say",
        ] {
            full.register(Arc::new(Probe {
                name,
                ran: Arc::clone(&ran),
            }));
        }
        let src = source(dir.path());
        let status = Arc::new(MachineStatus::new(
            Arc::clone(&src),
            BuildInfo::current(),
            None,
            "own",
        ));
        let (registry, dropped) = remote_registry(&full, Arc::clone(&src), status);
        let mut names: Vec<String> = registry.manifest().into_iter().map(|m| m.name).collect();
        names.sort();
        assert_eq!(names, vec!["computer.click", "exec.host", "machine.status"]);
        dropped.iter().for_each(|n| {
            assert!(["notify.show", "keychain.get", "speech.say"].contains(&n.as_str()))
        });
        // The Gateway cannot call what is not registered.
        assert!(registry.get("notify.show").is_none());

        // The default policy allows the private screen and refuses the shell.
        let click = registry.get("computer.click").unwrap();
        assert!(click
            .invoke(&ctx("computer.click", json!({"surface": "virtual_screen"})))
            .is_ok());
        assert!(ran.swap(false, std::sync::atomic::Ordering::SeqCst));
        let exec = registry.get("exec.host").unwrap();
        let err = exec
            .invoke(&ctx("exec.host", json!({"cwd":"~"})))
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Forbidden);
        assert_eq!(err.reason, "machine_policy");
        assert!(
            !ran.load(std::sync::atomic::Ordering::SeqCst),
            "the capability never saw the call"
        );
    }

    #[test]
    fn the_gate_reads_the_policy_again_for_each_call() {
        let dir = tempfile::tempdir().unwrap();
        let src = source(dir.path());
        let mut full = Registry::new();
        full.register(Arc::new(Probe {
            name: "computer.click",
            ran: Arc::new(AtomicBool::new(false)),
        }));
        let status = Arc::new(MachineStatus::new(
            Arc::clone(&src),
            BuildInfo::current(),
            None,
            "own",
        ));
        let (registry, _) = remote_registry(&full, Arc::clone(&src), status);
        let click = registry.get("computer.click").unwrap();
        assert!(click
            .invoke(&ctx("computer.click", json!({"surface": "virtual_screen"})))
            .is_ok());
        // The owner turns the screen off: the very next call is refused.
        std::fs::write(
            dir.path().join("user.json"),
            r#"{"surfaces":{"virtualScreen":false,"direct":false}}"#,
        )
        .unwrap();
        std::fs::set_permissions(
            dir.path().join("user.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(click
            .invoke(&ctx("computer.click", json!({"surface": "virtual_screen"})))
            .is_err());
        // The file is damaged: closed, not open.
        std::fs::write(dir.path().join("user.json"), "garbage").unwrap();
        assert!(click
            .invoke(&ctx("computer.click", json!({"surface": "virtual_screen"})))
            .is_err());
    }

    #[test]
    fn machine_status_reports_the_ceiling_and_the_sudo_probe() {
        let dir = tempfile::tempdir().unwrap();
        let src = source(dir.path());
        let status = MachineStatus::new(
            Arc::clone(&src),
            BuildInfo::current(),
            Some(PathBuf::from("/usr/bin/true")),
            "own",
        );
        let report = status.report();
        assert_eq!(report["account"], "own");
        assert_eq!(report["policyOwner"], "user");
        assert_eq!(report["policyValid"], true);
        assert_eq!(report["exec"]["enabled"], false);
        assert_eq!(report["surfaces"], json!(["virtual_screen"]));
        assert_eq!(report["files"]["roots"], json!([]));
        // `/usr/bin/true -n true` succeeds: the probe's exit status is the answer.
        assert_eq!(report["passwordlessSudo"], true);
        let no = MachineStatus::new(
            src,
            BuildInfo::current(),
            Some(PathBuf::from("/usr/bin/false")),
            "own",
        );
        assert_eq!(no.report()["passwordlessSudo"], false);
    }

    #[test]
    fn the_sudo_probe_fails_closed() {
        assert!(!passwordless_sudo(std::path::Path::new(
            "/nonexistent/sudo"
        )));
        assert!(passwordless_sudo(std::path::Path::new("/usr/bin/true")));
        assert!(!passwordless_sudo(std::path::Path::new("/usr/bin/false")));
        let none = MachineStatus::new(
            source(tempfile::tempdir().unwrap().path()),
            BuildInfo::current(),
            None,
            "own",
        );
        assert_eq!(none.report()["passwordlessSudo"], false);
    }

    #[test]
    fn a_broken_policy_is_reported_as_invalid() {
        let dir = tempfile::tempdir().unwrap();
        let src = source(dir.path());
        std::fs::write(dir.path().join("user.json"), "garbage").unwrap();
        std::fs::set_permissions(
            dir.path().join("user.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let status = MachineStatus::new(src, BuildInfo::current(), None, "own");
        let report = status.report();
        assert_eq!(report["policyValid"], false);
        assert_eq!(report["surfaces"], json!([]));
        assert_eq!(report["exec"]["enabled"], false);
    }
}
