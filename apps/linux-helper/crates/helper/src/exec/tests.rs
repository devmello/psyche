use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::sync::atomic::AtomicBool;

struct Box_ {
    dir: tempfile::TempDir,
}

impl Box_ {
    /// A fake home (under the system temp folder) with a secret, a project and a policy.
    fn new(exec: &str) -> Self {
        // Under the home folder of the account running the tests when it exists: `/tmp` is
        // replaced by a private tmpfs inside the sandbox, so a home under it would vanish.
        let base = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|h| h.is_dir() && !h.starts_with("/tmp"))
            .unwrap_or_else(std::env::temp_dir);
        let dir = tempfile::Builder::new()
            .prefix(".h5-exec-test-")
            .tempdir_in(base)
            .unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let b = Self { dir };
        for d in [
            "home/proj/sub",
            "home/.ssh",
            "home/.config/psyche-helper",
            "home/other",
            "home/agent",
        ] {
            std::fs::create_dir_all(b.p(d)).unwrap();
        }
        std::fs::write(b.p("home/.ssh/id_ed25519"), "PRIVATE-KEY").unwrap();
        // Executable, so a call naming it as argv[0] is judged by where it is, not its mode.
        std::fs::set_permissions(
            b.p("home/.ssh/id_ed25519"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        std::fs::write(b.p("home/.config/psyche-helper/remote.json"), "{}").unwrap();
        b.policy(exec);
        b
    }
    fn p(&self, rel: &str) -> PathBuf {
        self.dir.path().join(rel)
    }
    fn h(&self, rel: &str) -> String {
        self.p("home").join(rel).display().to_string()
    }
    fn policy(&self, exec: &str) {
        let p = self.p("user-policy.json");
        std::fs::write(&p, format!(r#"{{"exec":{exec}}}"#)).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn source(&self) -> Arc<PolicySource> {
        Arc::new(PolicySource {
            etc: self.p("absent/policy.json"),
            etc_owner: 0,
            user: self.p("user-policy.json"),
            home: self.p("home"),
        })
    }
    fn loaded(&self) -> Policy {
        self.source().load().policy
    }
    fn exec(&self, bwrap: Option<PathBuf>) -> ExecHost {
        ExecHost {
            source: self.source(),
            journal: Journal::off(),
            bwrap,
        }
    }
}

const CONTAINED: &str = r#"{"enabled":true,"contain":true,"network":false,"cwdRoots":["~"]}"#;
const FULL: &str = r#"{"enabled":true,"contain":false,"network":true,"cwdRoots":["~"]}"#;

fn reason(r: Result<Checked, CapabilityError>) -> String {
    match r {
        Ok(c) => format!("ok {}", c.executable.display()),
        Err(e) => e.reason,
    }
}

fn echo() -> &'static str {
    if Path::new("/bin/echo").exists() {
        "/bin/echo"
    } else {
        "/usr/bin/echo"
    }
}

#[test]
fn must_refuse_rows() {
    let b = Box_::new(CONTAINED);
    let p = b.loaded();
    let home = b.p("home");
    let other = format!("sha256:{}", "0".repeat(64));
    let base = |extra: Value| {
        let mut v = json!({ "argv": [echo(), "hi"], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "rw" });
        for (k, val) in extra.as_object().unwrap() {
            if val.is_null() {
                v.as_object_mut().unwrap().remove(k);
            } else {
                v[k] = val.clone();
            }
        }
        v
    };
    let rows: Vec<(Value, &str)> = vec![
        // Where.
        (base(json!({ "cwd": b.h("other") })), "outside_folder"),
        (
            base(json!({ "cwd": b.h(".ssh"), "folder": b.h(".ssh") })),
            "protected_path",
        ),
        (
            base(
                json!({ "cwd": b.h(".config/psyche-helper"), "folder": b.h(".config/psyche-helper") }),
            ),
            "protected_path",
        ),
        (
            base(json!({ "cwd": b.h(""), "folder": b.h("") })),
            "folder_holds_protected",
        ),
        (
            base(json!({ "cwd": b.h("proj"), "folder": b.h("") })),
            "folder_holds_protected",
        ),
        (
            base(json!({ "cwd": b.h(".config"), "folder": b.h(".config") })),
            "folder_holds_protected",
        ),
        (
            base(json!({ "cwd": "/etc", "folder": "/etc", "folderMode": "ro" })),
            "machine_policy",
        ),
        (base(json!({ "cwd": "proj" })), "invalid_params"),
        (
            base(json!({ "cwd": format!("{}/../other", b.h("proj")) })),
            "invalid_params",
        ),
        (base(json!({ "cwd": b.h("missing") })), "not_found"),
        (base(json!({ "cwd": null })), "invalid_params"),
        // What.
        (base(json!({ "argv": [] })), "invalid_params"),
        (base(json!({ "argv": [""] })), "invalid_params"),
        (base(json!({ "argv": ["ls", 5] })), "invalid_params"),
        (base(json!({ "argv": "ls -la" })), "invalid_params"),
        (
            base(json!({ "argv": ["no-such-program-psyche"] })),
            "not_found",
        ),
        (
            base(json!({ "argv": [b.h(".ssh/id_ed25519")] })),
            "protected_path",
        ),
        (base(json!({ "expectSha256": other })), "executable_changed"),
        // Environment.
        (base(json!({ "env": { "PATH": "/tmp" } })), "invalid_params"),
        (
            base(json!({ "env": { "LD_PRELOAD": "/tmp/x.so" } })),
            "invalid_params",
        ),
        (
            base(json!({ "env": { "SSH_AUTH_SOCK": "/tmp/a" } })),
            "invalid_params",
        ),
        (
            base(json!({ "env": { "DBUS_SESSION_BUS_ADDRESS": "unix:path=/x" } })),
            "invalid_params",
        ),
        (
            base(json!({ "env": { "BASH_ENV": "/tmp/x" } })),
            "invalid_params",
        ),
        (
            base(json!({ "env": { "PSYCHE_HOME": "/tmp" } })),
            "invalid_params",
        ),
        (base(json!({ "env": { "lower": "x" } })), "invalid_params"),
        (base(json!({ "env": { "A=B": "x" } })), "invalid_params"),
        (base(json!({ "env": { "FOO": 5 } })), "invalid_params"),
        // Shape.
        (base(json!({ "timeoutMs": 0 })), "invalid_params"),
        (
            base(json!({ "timeoutMs": EXEC_TIMEOUT_MS_MAX + 1 })),
            "invalid_params",
        ),
        (base(json!({ "shell": true })), "invalid_params"),
        (base(json!({ "folderMode": "rwx" })), "invalid_params"),
    ];
    for (params, want) in rows {
        assert_eq!(reason(check(&p, &home, &params)), want, "{params}");
    }
    // The switch.
    b.policy(r#"{"enabled":false,"contain":true,"network":false,"cwdRoots":["~"]}"#);
    assert_eq!(
        reason(check(&b.loaded(), &home, &base(json!({})))),
        "machine_policy"
    );
    // A root that doesn't hold the folder.
    b.policy(r#"{"enabled":true,"contain":true,"network":false,"cwdRoots":["~/other"]}"#);
    assert_eq!(
        reason(check(&b.loaded(), &home, &base(json!({})))),
        "machine_policy"
    );
    // A symlinked cwd that leads out of the folder.
    b.policy(CONTAINED);
    symlink(b.p("home/other"), b.p("home/proj/out")).unwrap();
    assert_eq!(
        reason(check(
            &b.loaded(),
            &home,
            &base(json!({ "cwd": b.h("proj/out") }))
        )),
        "outside_folder"
    );
}

#[test]
fn must_allow_rows() {
    let b = Box_::new(CONTAINED);
    let p = b.loaded();
    let home = b.p("home");
    let sha = sha256_file(&std::fs::canonicalize(echo()).unwrap()).unwrap();
    let rows: Vec<Value> = vec![
        json!({ "argv": [echo(), "hi"], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "rw" }),
        json!({ "argv": ["echo", "hi"], "cwd": b.h("proj/sub"), "folder": b.h("proj"), "folderMode": "rw" }),
        json!({ "argv": [echo()], "cwd": b.h("proj"), "folder": b.h("proj"), "env": { "FOO": "bar", "RUST_LOG": "x" } }),
        json!({ "argv": [echo()], "cwd": b.h("proj"), "folder": b.h("proj"), "expectSha256": sha }),
        // A read-only folder may hold the home folder: nothing is writable, secrets stay hidden.
        json!({ "argv": [echo()], "cwd": b.h("proj"), "folder": b.h(""), "folderMode": "ro" }),
        // No folder: the cwd is the folder, read-only.
        json!({ "argv": [echo()], "cwd": b.h("proj") }),
    ];
    for params in rows {
        let r = check(&p, &home, &params);
        assert!(r.is_ok(), "{params}: {}", reason(r));
    }
    let c = check(&p, &home, &json!({ "argv": ["echo"], "cwd": b.h("proj") })).unwrap();
    assert_eq!(c.sha256, sha);
    assert!(!c.writable);
    assert!(c.contain);
}

#[test]
fn reserved_env_names_and_near_misses() {
    for name in [
        "PATH",
        "HOME",
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "SSH_AUTH_SOCK",
        "GPG_AGENT_INFO",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "DISPLAY",
        "XAUTHORITY",
        "PSYCHE_X",
        "BASH_FUNC_x%%",
        "GIT_SSH_COMMAND",
        "SUDO_ASKPASS",
    ] {
        assert!(reserved_env(name), "{name}");
    }
    for name in [
        "PATHS",
        "HOMEPAGE",
        "LDFLAGS",
        "CI",
        "RUST_LOG",
        "NODE_ENV",
        "DISPLAY_NAME",
        "GIT_AUTHOR_NAME",
        "SSH_HOST",
    ] {
        assert!(!reserved_env(name), "{name}");
    }
}

#[test]
fn a_call_without_an_approval_is_refused() {
    let b = Box_::new(FULL);
    let exec = b.exec(None);
    for approval in [None, Some(String::new())] {
        let ctx = ctx_with(json!({ "argv": [echo()], "cwd": b.h("proj") }), approval);
        let e = exec.call(&ctx.0).unwrap_err();
        assert_eq!(e.code, ErrorCode::ApprovalRequired);
        assert_eq!(e.reason, "host_exec_always_asks");
    }
}

#[test]
fn a_missing_or_broken_bwrap_is_contain_unavailable_and_nothing_runs() {
    let b = Box_::new(CONTAINED);
    let marker = b.p("home/proj/ran");
    let touch = ["/usr/bin/touch", "/bin/touch"]
        .into_iter()
        .find(|p| Path::new(p).exists())
        .unwrap();
    let params = json!({ "argv": [touch, marker.display().to_string()], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "rw" });
    for bwrap in [
        None,
        Some(PathBuf::from("/nonexistent/bwrap")),
        Some(PathBuf::from("/usr/bin/false")),
    ] {
        let (ctx, _) = ctx_with(params.clone(), Some("apr_1".into()));
        let e = b.exec(bwrap.clone()).call(&ctx).unwrap_err();
        assert_eq!(e.code, ErrorCode::Unavailable, "{bwrap:?}");
        assert_eq!(e.reason, "contain_unavailable", "{bwrap:?}");
        assert!(!marker.exists(), "never run uncontained ({bwrap:?})");
    }
}

type Events = Arc<Mutex<Vec<Value>>>;

fn ctx_with(params: Value, approval: Option<String>) -> (InvocationContext, Events) {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    (
        InvocationContext {
            invocation_id: "inv".into(),
            capability: "exec.host".into(),
            params,
            approval_id: approval,
            emit: Arc::new(move |v| sink.lock().unwrap().push(v)),
            cancelled: Arc::new(AtomicBool::new(false)),
        },
        events,
    )
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;

    fn run_ok(exec: &ExecHost, params: Value) -> (Value, Events) {
        let (ctx, events) = ctx_with(params.clone(), Some("apr_1".into()));
        match exec.call(&ctx) {
            Ok(v) => (v, events),
            Err(e) => panic!("{params}: {} {}", e.reason, e.message),
        }
    }

    fn bin(name: &str) -> String {
        for d in ["/usr/bin", "/bin"] {
            let p = format!("{d}/{name}");
            if Path::new(&p).exists() {
                return p;
            }
        }
        panic!("{name} not installed");
    }

    /// The contained runs need a working bwrap. In the VM the suite runs with
    /// `PSYCHE_REQUIRE_BWRAP=1`, so a missing one fails instead of skipping.
    fn bwrap_or_skip() -> Option<PathBuf> {
        let found = contain::find_bwrap().filter(|b| contain::probe(b, false));
        if found.is_none() {
            assert!(
                std::env::var_os("PSYCHE_REQUIRE_BWRAP").is_none(),
                "bwrap is required here but cannot run"
            );
            eprintln!("skipping: bwrap is not usable on this machine");
        }
        found
    }

    #[test]
    fn output_streams_and_is_capped_and_the_env_is_scrubbed() {
        let b = Box_::new(FULL);
        let exec = b.exec(None);
        let (v, events) = run_ok(&exec, json!({ "argv": [echo(), "hi"], "cwd": b.h("proj") }));
        assert_eq!(v["exitCode"], 0);
        assert_eq!(v["stdout"], "hi\n");
        assert_eq!(v["contained"], false);
        assert!(v["executableSha256"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
        let ev = events.lock().unwrap();
        assert!(
            ev.iter()
                .any(|e| e["stream"] == "stdout" && e["text"] == "hi\n"),
            "{ev:?}"
        );
        drop(ev);
        // 300 KB of output: 128 KB kept, flagged truncated.
        let (v, _) = run_ok(
            &exec,
            json!({ "argv": [bin("head"), "-c", "300000", "/dev/zero"], "cwd": b.h("proj") }),
        );
        assert_eq!(v["truncated"], true);
        assert_eq!(v["stdout"].as_str().unwrap().len(), EXEC_OUTPUT_CAP_BYTES);
        // The helper's own bus and display variables never reach the command (the agent's socket
        // is checked by the contained test, which owns SSH_AUTH_SOCK).
        std::env::set_var("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1/bus");
        std::env::set_var("DISPLAY", ":99");
        let (v, _) = run_ok(
            &exec,
            json!({ "argv": [bin("env")], "cwd": b.h("proj"), "env": { "FOO": "bar" } }),
        );
        let names: Vec<&str> = v["stdout"]
            .as_str()
            .unwrap()
            .lines()
            .filter_map(|l| l.split('=').next())
            .collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(
            sorted,
            ["FOO", "HOME", "LANG", "LOGNAME", "PATH", "TMPDIR", "USER"],
            "{names:?}"
        );
    }

    #[test]
    fn timeout_and_cancel_kill_the_whole_process_group() {
        let b = Box_::new(FULL);
        let exec = b.exec(None);
        let (v, _) = run_ok(
            &exec,
            json!({ "argv": [bin("sleep"), "30"], "cwd": b.h("proj"), "timeoutMs": 300 }),
        );
        assert_eq!(v["timedOut"], true);
        assert!(v["durationMs"].as_u64().unwrap() < 5_000);
        // A grandchild in the same group dies with it on cancel (a revoke closes the
        // connection, which sets the same flag).
        let (ctx, events) = ctx_with(
            json!({ "argv": [bin("sh"), "-c", "sleep 31 & echo $!; wait"], "cwd": b.h("proj") }),
            Some("apr_1".into()),
        );
        let flag = Arc::clone(&ctx.cancelled);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            flag.store(true, Ordering::SeqCst);
        });
        let e = exec.call(&ctx).unwrap_err();
        t.join().unwrap();
        assert_eq!(e.code, ErrorCode::Cancelled);
        let pid: String = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| e["text"].as_str())
            .collect();
        let pid = pid.trim().to_string();
        assert!(!pid.is_empty());
        std::thread::sleep(Duration::from_millis(200));
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        assert!(
            stat.is_empty() || stat.contains(") Z "),
            "grandchild {pid} still alive: {stat}"
        );
    }

    #[test]
    fn sudo_fails_under_no_new_privileges_contained_or_not() {
        let Some(sudo) = ["/usr/bin/sudo", "/bin/sudo"]
            .into_iter()
            .find(|p| Path::new(p).exists())
        else {
            eprintln!("skipping: no sudo");
            return;
        };
        let outside = std::process::Command::new(sudo)
            .args(["-n", "true"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        eprintln!("passwordless sudo outside the helper: {outside}");
        let b = Box_::new(FULL);
        let (v, _) = run_ok(
            &b.exec(None),
            json!({ "argv": [sudo, "-n", "true"], "cwd": b.h("proj") }),
        );
        assert_ne!(v["exitCode"], 0, "{v}");
        if let Some(bwrap) = bwrap_or_skip() {
            b.policy(CONTAINED);
            let (v, _) = run_ok(
                &b.exec(Some(bwrap)),
                json!({ "argv": [sudo, "-n", "true"], "cwd": b.h("proj") }),
            );
            assert_ne!(v["exitCode"], 0, "{v}");
        }
    }

    #[test]
    fn a_contained_command_cannot_read_secrets_reach_the_agent_or_write_outside_its_folder() {
        let Some(bwrap) = bwrap_or_skip() else { return };
        let b = Box_::new(CONTAINED);
        let exec = b.exec(Some(bwrap));
        let sh = bin("sh");
        // A real listening socket standing in for ssh-agent, named by the helper's environment.
        let sock = b.p("home/agent/agent.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        std::env::set_var("SSH_AUTH_SOCK", &sock);
        let rw = |script: &str| json!({ "argv": [sh.clone(), "-c", script], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "rw" });
        // ~/.ssh is an empty folder inside.
        let (v, _) = run_ok(
            &exec,
            rw(&format!(
                "cat {}; ls -A {}",
                b.h(".ssh/id_ed25519"),
                b.h(".ssh")
            )),
        );
        assert_ne!(v["stdout"].as_str().unwrap().trim(), "PRIVATE-KEY");
        assert!(
            !v["stdout"].as_str().unwrap().contains("PRIVATE-KEY"),
            "{v}"
        );
        assert!(!v["stdout"].as_str().unwrap().contains("id_ed25519"), "{v}");
        // The helper's own files too.
        let (v, _) = run_ok(
            &exec,
            rw(&format!("ls -A {}", b.h(".config/psyche-helper"))),
        );
        assert_eq!(v["stdout"], "", "{v}");
        // The agent's socket is not a socket inside, and the variable is not set.
        let (v, _) = run_ok(
            &exec,
            rw(&format!(
                "test -S {} && echo REACHED; echo \"sock=$SSH_AUTH_SOCK\"",
                sock.display()
            )),
        );
        assert_eq!(v["stdout"], "sock=\n", "{v}");
        // Writes: the folder yes, anywhere else no, and /tmp is private.
        let tmp_name = format!("/tmp/psyche-exec-test-{}", std::process::id());
        let (v, _) = run_ok(
            &exec,
            rw(&format!(
                "touch ok.txt; touch {} 2>/dev/null; touch {} 2>/dev/null; echo x > {tmp_name}; cat {tmp_name}",
                b.h("other/escaped.txt"),
                b.h("escaped.txt")
            )),
        );
        assert_eq!(v["stdout"], "x\n", "{v}");
        assert!(b.p("home/proj/ok.txt").exists());
        assert!(!b.p("home/other/escaped.txt").exists());
        assert!(!b.p("home/escaped.txt").exists());
        assert!(!Path::new(&tmp_name).exists(), "/tmp inside is private");
        // A read-only folder: nothing written.
        let (v, _) = run_ok(
            &exec,
            json!({ "argv": [sh.clone(), "-c", "touch ro.txt 2>/dev/null || echo refused"], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "ro" }),
        );
        assert_eq!(v["stdout"], "refused\n");
        assert!(!b.p("home/proj/ro.txt").exists());
        // The user's runtime folder (session bus, keyring, user manager) is empty inside.
        // SAFETY: getuid cannot fail.
        let runtime = format!("/run/user/{}", unsafe { libc::getuid() });
        if Path::new(&runtime).is_dir() {
            let (v, _) = run_ok(&exec, rw(&format!("ls -A {runtime}")));
            assert_eq!(v["stdout"], "", "{v}");
        }
        assert_eq!(v["contained"], true);
        std::env::remove_var("SSH_AUTH_SOCK");
    }
}
