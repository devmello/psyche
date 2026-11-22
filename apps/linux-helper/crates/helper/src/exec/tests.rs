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
        self.policy_raw(&format!(r#"{{"exec":{exec}}}"#));
    }
    fn policy_raw(&self, text: &str) {
        let p = self.p("user-policy.json");
        std::fs::write(&p, text).unwrap();
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
const CONTAINED_NET: &str = r#"{"enabled":true,"contain":true,"network":true,"cwdRoots":["~"]}"#;
const FULL: &str = r#"{"enabled":true,"contain":false,"network":true,"cwdRoots":["~"]}"#;

/// `params` with the executable's hash, as the Gateway sends it after `exec.resolve`.
fn bound(mut v: Value) -> Value {
    if v.get("expectSha256").is_none() {
        let argv0 = v["argv"][0].as_str().unwrap_or("").to_string();
        if let Some(cwd) = v["cwd"].as_str().map(PathBuf::from) {
            if let Ok(exe) = resolve_executable(&argv0, &cwd) {
                if let Ok(sha) = sha256_file(&exe) {
                    v["expectSha256"] = json!(sha);
                }
            }
        }
    }
    v
}

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
    symlink(b.p("home/proj"), b.p("home/projlink")).unwrap();
    let base = |extra: Value| {
        let explicit = extra.get("expectSha256").is_some();
        let mut v = json!({ "argv": [echo(), "hi"], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "rw" });
        for (k, val) in extra.as_object().unwrap() {
            if val.is_null() {
                v.as_object_mut().unwrap().remove(k);
            } else {
                v[k] = val.clone();
            }
        }
        if explicit {
            v
        } else {
            bound(v)
        }
    };
    let rows: Vec<(Value, &str)> = vec![
        // #1512 review r1: the card's binding, the network, a swapped folder.
        (base(json!({ "expectSha256": null })), "invalid_params"),
        (base(json!({ "network": true })), "machine_policy"),
        (base(json!({ "network": "yes" })), "invalid_params"),
        (
            base(json!({ "expectContained": false })),
            "containment_changed",
        ),
        (
            base(json!({ "folder": b.h("projlink"), "cwd": b.h("projlink") })),
            "folder_moved",
        ),
        (base(json!({ "folderId": "0:0" })), "folder_moved"),
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
    // A read-write folder inside a read-only file root (#1512 review r1, finding 7).
    b.policy_raw(&format!(
        r#"{{"exec":{CONTAINED},"files":{{"roots":[{{"path":"~","mode":"rw"}},{{"path":"~/proj","mode":"ro"}}]}}}}"#
    ));
    assert_eq!(
        reason(check(&b.loaded(), &home, &base(json!({})))),
        "read_only_root"
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
        // The folder still the one granted, the containment the card showed.
        json!({ "argv": [echo()], "cwd": b.h("proj"), "folderId": folder_id(&b.p("home/proj")) }),
        json!({ "argv": [echo()], "cwd": b.h("proj"), "expectContained": true, "network": false }),
    ];
    for params in rows {
        let params = bound(params);
        let r = check(&p, &home, &params);
        assert!(r.is_ok(), "{params}: {}", reason(r));
    }
    let c = check(
        &p,
        &home,
        &bound(json!({ "argv": ["echo"], "cwd": b.h("proj") })),
    )
    .unwrap();
    assert_eq!(c.sha256, sha);
    assert!(!c.writable);
    assert!(c.contain);
    assert!(!c.network);
    // The network, granted on the card, where the ceiling allows it; a deeper read-write root
    // inside a read-only one lets the folder write, and the read-only roots are kept for the
    // sandbox.
    b.policy_raw(&format!(
        r#"{{"exec":{CONTAINED_NET},"files":{{"roots":[{{"path":"~","mode":"ro"}},{{"path":"~/proj","mode":"rw"}},{{"path":"~/proj/sub","mode":"ro"}}]}}}}"#
    ));
    let c = check(
        &b.loaded(),
        &home,
        &bound(
            json!({ "argv": [echo()], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "rw", "network": true }),
        ),
    )
    .unwrap();
    assert!(c.network && c.writable);
    assert!(
        c.read_only.contains(&b.p("home/proj/sub")),
        "{:?}",
        c.read_only
    );
}

fn folder_id(p: &Path) -> String {
    let m = std::fs::metadata(p).unwrap();
    format!("{:x}:{:x}", m.dev(), m.ino())
}

#[test]
fn exec_resolve_names_the_file_and_its_hash_and_how_commands_run() {
    let b = Box_::new(CONTAINED);
    let home = b.p("home");
    let sha = sha256_file(&std::fs::canonicalize(echo()).unwrap()).unwrap();
    let v = resolve(
        &b.loaded(),
        &home,
        &json!({ "argv0": "echo", "cwd": b.h("proj") }),
    )
    .unwrap();
    assert_eq!(v["executableSha256"], sha);
    assert_eq!(
        v["executable"],
        std::fs::canonicalize(echo()).unwrap().display().to_string()
    );
    assert_eq!(v["contained"], true);
    assert_eq!(v["networkAllowed"], false);
    std::fs::write(b.p("home/proj/build.sh"), "#!/bin/sh\necho built\n").unwrap();
    std::fs::set_permissions(
        b.p("home/proj/build.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let v = resolve(
        &b.loaded(),
        &home,
        &json!({ "argv0": "./build.sh", "cwd": b.h("proj") }),
    )
    .unwrap();
    assert_eq!(
        v["executableSha256"],
        sha256_file(&b.p("home/proj/build.sh")).unwrap()
    );
    // must refuse
    let rows: Vec<(Value, &str)> = vec![
        (
            json!({ "argv0": b.h(".ssh/id_ed25519"), "cwd": b.h("proj") }),
            "protected_path",
        ),
        (
            json!({ "argv0": "echo", "cwd": b.h(".ssh") }),
            "protected_path",
        ),
        (json!({ "argv0": "echo", "cwd": "/etc" }), "machine_policy"),
        (
            json!({ "argv0": "nope-psyche", "cwd": b.h("proj") }),
            "not_found",
        ),
        (json!({ "argv0": "echo" }), "invalid_params"),
        (
            json!({ "argv0": "echo", "cwd": b.h("proj"), "x": 1 }),
            "invalid_params",
        ),
    ];
    for (params, want) in rows {
        let got = match resolve(&b.loaded(), &home, &params) {
            Ok(v) => format!("ok {v}"),
            Err(e) => e.reason,
        };
        assert_eq!(got, want, "{params}");
    }
    b.policy(r#"{"enabled":false,"cwdRoots":["~"]}"#);
    let e = resolve(
        &b.loaded(),
        &home,
        &json!({ "argv0": "echo", "cwd": b.h("proj") }),
    )
    .unwrap_err();
    assert_eq!(e.reason, "machine_policy");
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
    let params = bound(
        json!({ "argv": [touch, marker.display().to_string()], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "rw" }),
    );
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
        let params = bound(params);
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

    /// Contained runs one at a time: the launch stubs go only when the last read-write run ends
    /// (one count for the whole helper), so a run in another test would keep them.
    fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
        static ONE: Mutex<()> = Mutex::new(());
        ONE.lock().unwrap_or_else(|e| e.into_inner())
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
        // 300 KB of text: 128 KB kept, flagged truncated.
        let (v, _) = run_ok(
            &exec,
            json!({ "argv": [bin("sh"), "-c", "head -c 300000 /dev/zero | tr '\\0' a"], "cwd": b.h("proj") }),
        );
        assert_eq!(v["truncated"], true);
        assert_eq!(v["stdout"].as_str().unwrap().len(), EXEC_OUTPUT_CAP_BYTES);
        // 300 KB of NULs on both streams (#1512 review r1, finding 3): six bytes each as JSON,
        // so cut further, and the whole result still fits in one frame.
        let (v, _) = run_ok(
            &exec,
            json!({ "argv": [bin("sh"), "-c", "head -c 300000 /dev/zero; head -c 300000 /dev/zero >&2"], "cwd": b.h("proj") }),
        );
        assert_eq!(v["truncated"], true);
        assert!(v["stdout"].as_str().unwrap().len() * 6 <= EXEC_OUTPUT_JSON_BUDGET);
        let frame = psyche_protocol::frame::req_line(
            "h1",
            "node.result",
            &json!({ "invocationId": "inv", "ok": true, "result": v }),
        );
        assert!(frame.is_ok(), "the result must fit in one frame");
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
        // In a user scope (the full account), systemd-run needs the runtime folder's name, and
        // systemd names the scope's invocation.
        sorted.retain(|n| {
            !(v["tree"] == "scope" && matches!(*n, "XDG_RUNTIME_DIR" | "INVOCATION_ID"))
        });
        assert_eq!(
            sorted,
            ["FOO", "HOME", "LANG", "LOGNAME", "PATH", "TMPDIR", "USER"],
            "{names:?}"
        );
    }

    /// #1512 review r1, finding 11: on the full account a `setsid` child is in the command's
    /// scope and dies with it.
    #[test]
    fn a_setsid_child_does_not_outlive_a_full_account_command() {
        let b = Box_::new(FULL);
        let exec = b.exec(None);
        let (v, _) = run_ok(
            &exec,
            json!({ "argv": [bin("sh"), "-c", "setsid sleep 306 >/dev/null 2>&1 < /dev/null & echo $!"], "cwd": b.h("proj") }),
        );
        let pid = v["stdout"].as_str().unwrap().trim().to_string();
        assert!(!pid.is_empty(), "{v}");
        if v["tree"] != "scope" {
            assert!(
                std::env::var_os("PSYCHE_REQUIRE_BWRAP").is_none(),
                "the VM has a user manager: the scope must be used ({v})"
            );
            eprintln!("skipping: no user manager here ({})", v["tree"]);
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        assert!(
            stat.is_empty() || stat.contains(") Z "),
            "setsid child {pid} survived: {stat}"
        );
    }

    /// #1512 review r1, finding 10: what runs is the file that was hashed, even if the path is
    /// swapped between the check and the run.
    #[test]
    fn the_file_that_was_hashed_is_the_file_that_runs() {
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let b = Box_::new(CONTAINED);
        let script = b.p("home/proj/build.sh");
        std::fs::write(&script, "#!/bin/sh\necho approved\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let params = bound(
            json!({ "argv": ["./build.sh"], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "rw" }),
        );
        let evil = b.p("home/proj/evil.sh");
        let plant = || {
            std::fs::write(&evil, "#!/bin/sh\necho swapped\n").unwrap();
            std::fs::set_permissions(&evil, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        // The approved file moved away and another put at its path after the hash: the approved
        // one (the inode that was hashed) is what runs, at the path the command expects.
        let c = check(&b.loaded(), &b.p("home"), &params).unwrap();
        std::fs::rename(&script, b.p("home/proj/moved.sh")).unwrap();
        plant();
        std::fs::rename(&evil, &script).unwrap();
        let (ctx, _) = ctx_with(params.clone(), Some("apr_1".into()));
        let ran = run(&c, &b.p("home"), &ctx, Some(&bwrap)).unwrap();
        assert_eq!(ran.stdout, "approved\n", "{ran:?}");
        // Renamed over (the approved file is gone): nothing runs.
        std::fs::rename(b.p("home/proj/moved.sh"), &script).unwrap();
        let c = check(&b.loaded(), &b.p("home"), &params).unwrap();
        plant();
        std::fs::rename(&evil, &script).unwrap();
        let (ctx, _) = ctx_with(params, Some("apr_1".into()));
        let e = run(&c, &b.p("home"), &ctx, Some(&bwrap)).unwrap_err();
        assert_eq!(e.reason, "executable_changed");
        // And the next check refuses the new file against the old hash.
        let again = check(
            &b.loaded(),
            &b.p("home"),
            &json!({ "argv": ["./build.sh"], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "rw", "expectSha256": c.sha256 }),
        );
        assert_eq!(reason(again), "executable_changed");
    }

    fn python() -> Option<String> {
        ["/usr/bin/python3", "/bin/python3"]
            .into_iter()
            .find(|p| Path::new(p).exists())
            .map(str::to_string)
    }

    /// #1512 review r1, finding 1 and D2: with the network on, no unix socket can be made, so
    /// an abstract socket (an X server's) and a path socket under /run are out of reach; TCP
    /// sockets and socketpair still work. With it off, the network namespace is the sandbox's
    /// own and /run is empty.
    #[test]
    fn a_contained_command_reaches_no_unix_socket_outside_with_the_network_on_or_off() {
        use std::os::linux::net::SocketAddrExt;
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let Some(py) = python() else {
            eprintln!("skipping: no python3");
            return;
        };
        let b = Box_::new(CONTAINED_NET);
        let exec = b.exec(Some(bwrap));
        let name = format!("psyche-h5-test-{}", std::process::id());
        let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes()).unwrap();
        let _abstract = std::os::unix::net::UnixListener::bind_addr(&addr).unwrap();
        // A path socket under /run, as a system service's would be.
        // SAFETY: getuid cannot fail.
        let runtime = PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() }));
        let run_sock = runtime.join(format!("psyche-h5-test-{}.sock", std::process::id()));
        let _path = runtime
            .is_dir()
            .then(|| std::os::unix::net::UnixListener::bind(&run_sock).ok())
            .flatten();
        let probe = format!(
            r#"
import socket
def try_(f):
    try:
        f(); return "open"
    except OSError as e:
        return "refused"
def abstract():
    s = socket.socket(socket.AF_UNIX); s.connect("\0{name}")
def path():
    s = socket.socket(socket.AF_UNIX); s.connect("{sock}")
def tcp():
    socket.socket(socket.AF_INET, socket.SOCK_STREAM).close()
def pair():
    a, b = socket.socketpair(); a.send(b"x"); assert b.recv(1) == b"x"
print("abstract", try_(abstract)); print("path", try_(path))
print("tcp", try_(tcp)); print("pair", try_(pair))
"#,
            sock = run_sock.display()
        );
        for network in [true, false] {
            let (v, _) = run_ok(
                &exec,
                json!({ "argv": [py.clone(), "-c", probe.clone()], "cwd": b.h("proj"), "network": network }),
            );
            let out = v["stdout"].as_str().unwrap();
            assert!(out.contains("abstract refused"), "network {network}: {v}");
            assert!(out.contains("path refused"), "network {network}: {v}");
            assert!(out.contains("pair open"), "network {network}: {v}");
            if network {
                assert!(out.contains("tcp open"), "{v}");
                assert_eq!(v["network"], true);
            }
            // /run holds nothing but DNS's files.
            let (v, _) = run_ok(
                &exec,
                json!({ "argv": [bin("sh"), "-c", "ls -A /run; ls -A /run/systemd 2>/dev/null"], "cwd": b.h("proj"), "network": network }),
            );
            let listed: Vec<&str> = v["stdout"].as_str().unwrap().split_whitespace().collect();
            let allowed: &[&str] = if network {
                &["systemd", "resolve"]
            } else {
                &[]
            };
            assert!(
                listed.iter().all(|n| allowed.contains(n)),
                "network {network}: {listed:?}"
            );
        }
        let _ = std::fs::remove_file(&run_sock);
    }

    /// #1512 review r1, finding 7: git hooks and config, launch configs and read-only roots
    /// stay read-only in a read-write folder, missing ones cannot be created, and the stubs
    /// the sandbox needed are gone afterwards.
    #[test]
    fn a_contained_command_cannot_plant_code_in_its_read_write_folder() {
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let b = Box_::new(CONTAINED);
        b.policy_raw(&format!(
            r#"{{"exec":{CONTAINED},"files":{{"roots":[{{"path":"~","mode":"rw"}},{{"path":"~/proj/keep","mode":"ro"}}]}}}}"#
        ));
        for d in [
            "home/proj/.git/hooks",
            "home/proj/keep",
            "home/proj/sibling/.git",
        ] {
            std::fs::create_dir_all(b.p(d)).unwrap();
        }
        std::fs::write(b.p("home/proj/.git/config"), "[core]\n").unwrap();
        std::fs::write(b.p("home/proj/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let exec = b.exec(Some(bwrap));
        let script = [
            "for p in .git/hooks/post-checkout sibling/.git/hooks/post-checkout .envrc .vscode/tasks.json .claude/settings.json .mcp.json .npmrc keep/planted .git/config; do",
            // A missing file is /dev/null inside: what is written there goes nowhere.
            "  mkdir -p \"$(dirname \"$p\")\" 2>/dev/null; echo '#!/bin/sh' >> \"$p\" 2>/dev/null; chmod +x \"$p\" 2>/dev/null",
            "done",
            "echo ok > ok.txt && echo wrote-ok",
            "echo y > .git/HEAD && echo wrote-head",
        ]
        .join("\n");
        let (v, _) = run_ok(
            &exec,
            json!({ "argv": [bin("sh"), "-c", script], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "rw" }),
        );
        let out = v["stdout"].as_str().unwrap();
        // The folder itself stays writable, and so does git's own state.
        assert!(
            out.contains("wrote-ok") && out.contains("wrote-head"),
            "{v}"
        );
        assert!(b.p("home/proj/ok.txt").exists());
        assert_eq!(
            std::fs::read_to_string(b.p("home/proj/.git/config")).unwrap(),
            "[core]\n"
        );
        // The stubs the sandbox made are gone.
        for p in [
            ".envrc",
            ".vscode",
            ".claude",
            ".mcp.json",
            ".npmrc",
            "sibling/.git/hooks",
        ] {
            assert!(!b.p("home/proj").join(p).exists(), "{p} left behind");
        }
        assert!(!b.p("home/proj/keep/planted").exists());
        assert!(!b.p("home/proj/.git/hooks/post-checkout").exists());
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
            bound(
                json!({ "argv": [bin("sh"), "-c", "sleep 31 & echo $!; wait"], "cwd": b.h("proj") }),
            ),
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
        let _one = one_at_a_time();
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

    fn rw_in(b: &Box_, cwd: &str, script: &str) -> Value {
        json!({ "argv": [bin("sh"), "-c", script], "cwd": b.h(cwd), "folder": b.h("proj"), "folderMode": "rw" })
    }

    /// #1512 review r2, P1: `.git` (and the way to the working folder) can't be moved aside
    /// to make a fresh one the masks don't cover; git's own state stays writable.
    #[test]
    fn a_git_folder_or_the_way_to_the_working_folder_cannot_be_moved_aside() {
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let b = Box_::new(CONTAINED);
        std::fs::create_dir_all(b.p("home/proj/.git/hooks")).unwrap();
        std::fs::write(b.p("home/proj/.git/config"), "[core]\n").unwrap();
        std::fs::write(b.p("home/proj/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let exec = b.exec(Some(bwrap));
        let script = [
            "mv ../.git ../.git-old 2>/dev/null && echo moved-git",
            "mv ../sub ../sub2 2>/dev/null && echo moved-sub",
            "mkdir -p ../.git/hooks 2>/dev/null",
            "echo '#!/bin/sh' > ../.git/hooks/pre-commit 2>/dev/null && echo planted",
            "echo '  fsmonitor = /bin/true' >> ../.git/config 2>/dev/null && echo config",
            "echo idx > ../.git/index && echo wrote-index",
        ]
        .join("\n");
        let (v, _) = run_ok(&exec, rw_in(&b, "proj/sub", &script));
        assert_eq!(v["stdout"], "wrote-index\n", "{v}");
        assert!(!b.p("home/proj/.git-old").exists());
        assert!(!b.p("home/proj/sub2").exists());
        assert!(!b.p("home/proj/.git/hooks/pre-commit").exists());
        assert_eq!(
            std::fs::read_to_string(b.p("home/proj/.git/config")).unwrap(),
            "[core]\n"
        );
        assert_eq!(
            std::fs::read_to_string(b.p("home/proj/.git/index")).unwrap(),
            "idx\n"
        );
    }

    /// #1512 review r2, P2: a repository or launch config made one or two levels down is moved
    /// aside after the run (never deleted) and named in the result; old ones stay.
    #[test]
    fn new_repositories_and_launch_configs_below_the_folder_are_moved_aside() {
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let b = Box_::new(CONTAINED);
        std::fs::create_dir_all(b.p("home/proj/old/.git")).unwrap();
        let exec = b.exec(Some(bwrap));
        let script = "mkdir -p sub/.git newrepo/.git a/b/.vscode && echo '[core]' > sub/.git/config && echo '{}' > a/b/.vscode/tasks.json && echo made";
        let (v, _) = run_ok(&exec, rw_in(&b, "proj", script));
        assert_eq!(v["stdout"], "made\n", "{v}");
        let mut moved: Vec<String> = v["quarantined"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| {
                let (from, to) = (q["path"].as_str().unwrap(), q["movedTo"].as_str().unwrap());
                assert!(!Path::new(from).exists(), "{from} still there");
                assert!(Path::new(to).exists(), "{to} missing");
                assert!(
                    to.starts_with(&format!("{from}.psyche-quarantine-")),
                    "{to}"
                );
                from.to_string()
            })
            .collect();
        moved.sort();
        let mut want = vec![
            b.h("proj/a/b/.vscode"),
            b.h("proj/newrepo/.git"),
            b.h("proj/sub/.git"),
        ];
        want.sort();
        assert_eq!(moved, want, "{v}");
        assert!(b.p("home/proj/old/.git").is_dir());
        // The stubs at the top were not moved: they are gone.
        assert!(!b.p("home/proj/.git").exists());
        assert!(!b.p("home/proj/.vscode").exists());
    }

    /// #1512 review r2, P3: a read-only root's parent (or the root) can't be renamed by a run,
    /// and if one was moved anyway, nothing writes until the helper restarts.
    #[test]
    fn a_read_only_root_in_a_read_write_folder_cannot_be_moved_aside() {
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let b = Box_::new(CONTAINED);
        b.policy_raw(&format!(
            r#"{{"exec":{CONTAINED},"files":{{"roots":[{{"path":"~","mode":"rw"}},{{"path":"~/proj/a/keep","mode":"ro"}}]}}}}"#
        ));
        std::fs::create_dir_all(b.p("home/proj/a/keep")).unwrap();
        std::fs::write(b.p("home/proj/a/keep/k.txt"), "KEEP\n").unwrap();
        let exec = b.exec(Some(bwrap));
        let script = [
            "mv a a2 2>/dev/null && echo moved",
            "mv a/keep a/keep2 2>/dev/null && echo moved-keep",
            "echo X > a/keep/k.txt 2>/dev/null && echo wrote",
            "true",
        ]
        .join("\n");
        let (v, _) = run_ok(&exec, rw_in(&b, "proj", &script));
        assert_eq!(v["stdout"], "", "{v}");
        assert!(!b.p("home/proj/a2").exists());
        assert_eq!(
            std::fs::read_to_string(b.p("home/proj/a/keep/k.txt")).unwrap(),
            "KEEP\n"
        );
        // Moved aside from outside and a decoy made: writes and read-write runs are refused.
        std::fs::rename(b.p("home/proj/a"), b.p("home/proj/a2")).unwrap();
        std::fs::create_dir_all(b.p("home/proj/a/keep")).unwrap();
        let (p, home) = (b.loaded(), b.p("home"));
        assert_eq!(
            reason(check(&p, &home, &bound(rw_in(&b, "proj", "true")))),
            "read_only_root_moved"
        );
        let old = b.h("proj/a2/keep/k.txt");
        let write = crate::fs::locate(&p, &home, &old, true);
        assert_eq!(
            write.err().map(|e| e.reason).as_deref(),
            Some("read_only_root_moved")
        );
        // Reads still work.
        assert!(crate::fs::locate(&p, &home, &old, false).is_ok());
    }

    /// #1512 review r2, P5: a host daemon's path socket in the home folder is out of reach with
    /// the network off.
    #[test]
    fn a_host_daemon_socket_in_the_home_folder_is_out_of_reach() {
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let Some(py) = python() else {
            eprintln!("skipping: no python3");
            return;
        };
        let b = Box_::new(CONTAINED);
        std::fs::create_dir_all(b.p("home/.cache/svc")).unwrap();
        let sock = b.p("home/.cache/svc/daemon.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let exec = b.exec(Some(bwrap));
        let probe = format!(
            "import socket\ns = socket.socket(socket.AF_UNIX)\ntry:\n    s.connect({:?}); print('reached')\nexcept OSError:\n    print('refused')\n",
            sock.display().to_string()
        );
        let (v, _) = run_ok(
            &exec,
            json!({ "argv": [py, "-c", probe], "cwd": b.h("proj"), "network": false }),
        );
        assert_eq!(v["stdout"], "refused\n", "{v}");
    }

    fn call(exec: &ExecHost, params: Value) -> Result<Value, CapabilityError> {
        let (ctx, _) = ctx_with(bound(params), Some("apr_1".into()));
        exec.call(&ctx)
    }

    fn moved(v: &Value) -> Vec<String> {
        let mut out: Vec<String> = v["quarantined"]
            .as_array()
            .unwrap()
            .iter()
            .map(|q| q["path"].as_str().unwrap().to_string())
            .collect();
        out.sort();
        out
    }

    /// #1512 review r3, B1: a `commondir` (and `config.worktree`, `info`) written into an
    /// existing `.git` would send git to a config and hooks the command wrote: moved aside.
    #[test]
    fn git_redirects_written_into_an_existing_git_folder_are_moved_aside() {
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let b = Box_::new(CONTAINED);
        std::fs::create_dir_all(b.p("home/proj/.git/hooks")).unwrap();
        std::fs::write(b.p("home/proj/.git/config"), "[core]\n").unwrap();
        std::fs::write(b.p("home/proj/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let exec = b.exec(Some(bwrap));
        let script = [
            "mkdir -p .git/evil/objects .git/evil/refs .git/evil/hooks",
            "echo 'ref: refs/heads/main' > .git/evil/HEAD",
            "printf '[core]\\n\\tfsmonitor = /bin/true\\n' > .git/evil/config",
            "echo evil > .git/commondir && echo planted",
            "echo '[core]' > .git/config.worktree",
            "mkdir .git/info && echo '* filter=x' > .git/info/attributes",
        ]
        .join("\n");
        let (v, _) = run_ok(&exec, rw_in(&b, "proj", &script));
        assert_eq!(v["stdout"], "planted\n", "{v}");
        let want: Vec<String> = [".git/commondir", ".git/config.worktree", ".git/info"]
            .iter()
            .map(|p| b.h(&format!("proj/{p}")))
            .collect();
        assert_eq!(moved(&v), want, "{v}");
        for p in [".git/commondir", ".git/config.worktree", ".git/info"] {
            assert!(!b.p("home/proj").join(p).exists(), "{p} still in place");
        }
        assert_eq!(v["launchScanIncomplete"], false);
        // git's own state is untouched.
        assert_eq!(
            std::fs::read_to_string(b.p("home/proj/.git/config")).unwrap(),
            "[core]\n"
        );
    }

    /// #1512 review r3, B2 (b, c): guessed quarantine names and a name too long for a suffix
    /// don't leave a planted entry in place.
    #[test]
    fn guessed_quarantine_names_and_long_names_are_still_moved_aside() {
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let b = Box_::new(CONTAINED);
        let exec = b.exec(Some(bwrap));
        let long = format!("{}.code-workspace", "w".repeat(240));
        let script = format!(
            "mkdir -p sub/.git && echo '[core]' > sub/.git/config && t=$(date +%s) && for i in 0 1 2 3 4 5 6 7 8; do for n in '' -1 -2 -3; do touch sub/.git.psyche-quarantine-$((t+i))$n; done; done && echo '{{}}' > {long} && echo made"
        );
        let (v, _) = run_ok(&exec, rw_in(&b, "proj", &script));
        assert_eq!(v["stdout"], "made\n", "{v}");
        let mut want = vec![b.h("proj/sub/.git"), b.h(&format!("proj/{long}"))];
        want.sort();
        assert_eq!(moved(&v), want, "{v}");
        assert!(!b.p("home/proj/sub/.git").exists());
        assert!(!b.p("home/proj").join(&long).exists());
        assert_eq!(v["launchScanIncomplete"], false);
    }

    /// #1512 review r3, B2 (a) and N2: a run that leaves more than the scan can check is
    /// flagged, says so, names only what fits, and the folder takes no more read-write runs.
    #[test]
    fn a_folder_too_big_to_check_after_a_run_takes_no_more_read_write_runs() {
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let b = Box_::new(CONTAINED);
        let exec = b.exec(Some(bwrap));
        let script = "seq -f 'd%g/.git' 1 20100 | xargs mkdir -p && echo made";
        let (v, _) = run_ok(&exec, rw_in(&b, "proj", script));
        assert_eq!(v["stdout"], "made\n");
        assert_eq!(v["launchScanIncomplete"], true, "{}", v["launchScanNote"]);
        assert!(v["quarantinedCount"].as_u64().unwrap() > 19_000);
        assert!(v["quarantined"].as_array().unwrap().len() <= QUARANTINED_LISTED_MAX);
        assert_eq!(v["quarantinedTruncated"], true);
        assert!(v.to_string().len() < 1024 * 1024);
        let again = call(&exec, rw_in(&b, "proj/sub", "true"));
        assert_eq!(
            again.err().map(|e| e.reason).as_deref(),
            Some("launch_scan_incomplete")
        );
        // Read-only runs still work.
        let (v, _) = run_ok(
            &exec,
            json!({ "argv": [bin("sh"), "-c", "echo ro"], "cwd": b.h("proj"), "folder": b.h("proj"), "folderMode": "ro" }),
        );
        assert_eq!(v["stdout"], "ro\n");
    }

    /// #1512 review r3, B3: a pinned folder toggled between a folder and a link to outside
    /// while runs start never makes the outside writable.
    #[test]
    fn a_pinned_folder_swapped_for_a_link_never_leads_the_bind_outside() {
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let b = Box_::new(CONTAINED);
        let nd = b.p("home/proj/nd");
        std::fs::create_dir_all(&nd).unwrap();
        let exec = b.exec(Some(bwrap));
        let stop = Arc::new(AtomicBool::new(false));
        let toggler = {
            let (nd, stop) = (nd.clone(), Arc::clone(&stop));
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    let _ = std::fs::remove_dir(&nd);
                    let _ = symlink("../other", &nd);
                    std::thread::yield_now();
                    let _ = std::fs::remove_file(&nd);
                    let _ = std::fs::create_dir(&nd);
                    std::thread::yield_now();
                }
            })
        };
        let script = format!(
            "echo PWNED > {} 2>/dev/null; echo PWNED > nd/f 2>/dev/null; true",
            b.h("other/f")
        );
        let (mut ran, mut refused) = (0, 0);
        for _ in 0..300 {
            match call(&exec, rw_in(&b, "proj", &script)) {
                Ok(_) => ran += 1,
                Err(_) => refused += 1,
            }
            // A scan the toggling cut short flags the folder; as if the owner restarted.
            launch::Folders::global().unflag(&b.p("home/proj"));
        }
        stop.store(true, Ordering::SeqCst);
        toggler.join().unwrap();
        eprintln!("B3 race: {ran} ran, {refused} refused");
        assert!(
            !b.p("home/other/f").exists(),
            "outside written ({ran} ran, {refused} refused)"
        );
    }

    /// #1512 review r3, B4: two read-write runs in one folder take turns, so neither writes
    /// into the other's stubs, and what the first planted is moved aside.
    #[test]
    fn two_read_write_runs_in_one_folder_take_turns_and_leave_nothing_planted() {
        let _one = one_at_a_time();
        let Some(bwrap) = bwrap_or_skip() else { return };
        let b = Box_::new(CONTAINED);
        let exec = b.exec(Some(bwrap));
        let a_script = [
            "sleep 1",
            "mkdir -p sub/.vscode sub/.git",
            "echo '{}' > sub/.vscode/tasks.json",
            "printf '[core]\\n\\tfsmonitor = /bin/true\\n' > sub/.git/config",
            "echo a-done",
        ]
        .join("\n");
        std::thread::scope(|s| {
            let a = s.spawn(|| call(&exec, rw_in(&b, "proj", &a_script)));
            std::thread::sleep(Duration::from_millis(300));
            let t = Instant::now();
            let second = call(&exec, rw_in(&b, "proj/sub", "echo b-done")).unwrap();
            let first = a.join().unwrap().unwrap();
            assert!(t.elapsed() >= Duration::from_millis(500), "B waited for A");
            assert_eq!(first["stdout"], "a-done\n", "{first}");
            assert_eq!(second["stdout"], "b-done\n", "{second}");
            let mut want = vec![b.h("proj/sub/.git"), b.h("proj/sub/.vscode")];
            want.sort();
            assert_eq!(moved(&first), want, "{first}");
        });
        assert!(!b.p("home/proj/sub/.vscode/tasks.json").exists());
        assert!(!b.p("home/proj/sub/.git/config").exists());
        assert!(!b.p("home/proj/sub/.vscode").exists() && !b.p("home/proj/sub/.git").exists());
    }
}
