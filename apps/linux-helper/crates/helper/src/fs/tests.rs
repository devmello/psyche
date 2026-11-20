use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

struct Box_ {
    dir: tempfile::TempDir,
}

impl Box_ {
    fn new(policy: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let b = Self { dir };
        for d in [
            "home/work/sub",
            "home/ro",
            "home/.ssh",
            "home/.config/Code",
            "outside",
        ] {
            std::fs::create_dir_all(b.p(d)).unwrap();
        }
        std::fs::write(b.p("home/work/a.txt"), "hello").unwrap();
        std::fs::write(b.p("home/ro/r.txt"), "ro").unwrap();
        std::fs::write(b.p("home/notes.txt"), "n").unwrap();
        std::fs::write(b.p("home/.ssh/id_ed25519"), "KEY").unwrap();
        std::fs::write(b.p("home/.bashrc"), "# rc").unwrap();
        std::fs::write(b.p("outside/secret"), "SECRET").unwrap();
        symlink(b.p("outside"), b.p("home/work/link")).unwrap();
        symlink(b.p("home/work/a.txt"), b.p("home/work/inside-link")).unwrap();
        std::fs::hard_link(b.p("outside/secret"), b.p("home/work/hard")).unwrap();
        let fifo = std::ffi::CString::new(b.p("home/work/fifo").to_str().unwrap()).unwrap();
        // SAFETY: a valid C string.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        b.policy(policy);
        b
    }
    fn p(&self, rel: &str) -> PathBuf {
        self.dir.path().join(rel)
    }
    fn h(&self, rel: &str) -> String {
        self.p("home").join(rel).display().to_string()
    }
    fn policy(&self, text: &str) {
        let p = self.p("user-policy.json");
        std::fs::write(&p, text).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn files(&self) -> Files {
        Files {
            source: Arc::new(PolicySource {
                etc: self.p("absent/policy.json"),
                etc_owner: 0,
                user: self.p("user-policy.json"),
                home: self.p("home"),
            }),
            journal: Journal::off(),
        }
    }
}

const ROOTS: &str = r#"{"files":{"roots":[{"path":"~/work","mode":"rw"},{"path":"~/ro","mode":"ro"},{"path":"~","mode":"ro"}]}}"#;
const HOME_RW: &str = r#"{"files":{"roots":[{"path":"~","mode":"rw"}]}}"#;

fn reason(r: Result<Value, CapabilityError>) -> String {
    match r {
        Ok(v) => format!("ok {v}"),
        Err(e) => e.reason,
    }
}

#[test]
fn must_allow_rows() {
    let b = Box_::new(ROOTS);
    let f = b.files();
    let rows: Vec<(Op, Value)> = vec![
        (Op::List, json!({ "path": b.h("work") })),
        (Op::List, json!({ "path": b.h("") })),
        (Op::Stat, json!({ "path": b.h("work/a.txt") })),
        (Op::Stat, json!({ "path": b.h("work") })),
        (Op::Read, json!({ "path": b.h("work/a.txt") })),
        (
            Op::Read,
            json!({ "path": b.h("ro/r.txt"), "encoding": "base64" }),
        ),
        (Op::Read, json!({ "path": b.h("notes.txt") })),
        (
            Op::Write,
            json!({ "path": b.h("work/new.txt"), "content": "x" }),
        ),
        (
            Op::Write,
            json!({ "path": b.h("work/d/e/f.txt"), "content": "aGk=", "encoding": "base64", "createParents": true }),
        ),
        (Op::Mkdir, json!({ "path": b.h("work/m") })),
        (Op::Mkdir, json!({ "path": b.h("work/m") })),
        (
            Op::Mkdir,
            json!({ "path": b.h("work/p/q"), "recursive": true }),
        ),
        (Op::Remove, json!({ "path": b.h("work/new.txt") })),
        (
            Op::Remove,
            json!({ "path": b.h("work/d"), "recursive": true }),
        ),
        // The link itself is removed, never followed.
        (Op::Remove, json!({ "path": b.h("work/link") })),
    ];
    for (op, params) in rows {
        let r = f.run(op, &params);
        assert!(r.is_ok(), "{op:?} {params}: {}", reason(r));
    }
    assert_eq!(std::fs::read(b.p("outside/secret")).unwrap(), b"SECRET");
    assert!(!b.p("home/work/d").exists());
    assert!(b.p("home/work/p/q").is_dir());
    let read = f
        .run(Op::Read, &json!({ "path": b.h("work/a.txt") }))
        .unwrap();
    assert_eq!(read["content"], "hello");
    assert_eq!(read["eof"], true);
}

#[test]
fn must_refuse_rows() {
    let b = Box_::new(ROOTS);
    let f = b.files();
    let stale = "0-0-0";
    let rows: Vec<(Op, Value, &str)> = vec![
        // Symbolic links below a root never lead anywhere, even back inside.
        (
            Op::Read,
            json!({ "path": b.h("work/link/secret") }),
            "symlink_escape",
        ),
        (
            Op::List,
            json!({ "path": b.h("work/link") }),
            "symlink_escape",
        ),
        (
            Op::Write,
            json!({ "path": b.h("work/link/new"), "content": "x" }),
            "symlink_escape",
        ),
        (
            Op::Read,
            json!({ "path": b.h("work/inside-link") }),
            "symlink_escape",
        ),
        (
            Op::Write,
            json!({ "path": b.h("work/inside-link"), "content": "x" }),
            "symlink_escape",
        ),
        // A hard link names a file that may live anywhere.
        (Op::Read, json!({ "path": b.h("work/hard") }), "hard_link"),
        (
            Op::Read,
            json!({ "path": b.h("work/fifo") }),
            "invalid_params",
        ),
        // Protected paths, under a root that holds them.
        (
            Op::Read,
            json!({ "path": b.h(".ssh/id_ed25519") }),
            "protected_path",
        ),
        (Op::List, json!({ "path": b.h(".ssh") }), "protected_path"),
        (Op::Stat, json!({ "path": b.h(".ssh") }), "protected_path"),
        (
            Op::Read,
            json!({ "path": b.h(".bashrc") }),
            "protected_path",
        ),
        (
            Op::Read,
            json!({ "path": b.h(".config/psyche-helper/policy.json") }),
            "protected_path",
        ),
        (
            Op::Read,
            json!({ "path": "/proc/self/environ" }),
            "protected_path",
        ),
        (
            Op::Read,
            json!({ "path": "/etc/psyche-helper/policy.json" }),
            "protected_path",
        ),
        // `ro` roots, including a read-only root inside a read-write one's parent.
        (
            Op::Write,
            json!({ "path": b.h("ro/x"), "content": "x" }),
            "read_only_root",
        ),
        (Op::Mkdir, json!({ "path": b.h("ro/m") }), "read_only_root"),
        (
            Op::Remove,
            json!({ "path": b.h("ro/r.txt") }),
            "read_only_root",
        ),
        (
            Op::Write,
            json!({ "path": b.h("notes.txt"), "content": "x" }),
            "read_only_root",
        ),
        (
            Op::Write,
            json!({ "path": b.h("workshop/a"), "content": "x" }),
            "read_only_root",
        ),
        // Outside every root.
        (Op::Read, json!({ "path": "/etc/passwd" }), "machine_policy"),
        (
            Op::Read,
            json!({ "path": b.p("outside/secret").display().to_string() }),
            "machine_policy",
        ),
        // Malformed paths and params.
        (
            Op::Read,
            json!({ "path": "~/work/a.txt" }),
            "invalid_params",
        ),
        (
            Op::Read,
            json!({ "path": format!("{}/../outside/secret", b.h("work")) }),
            "invalid_params",
        ),
        (Op::Read, json!({ "path": "work/a.txt" }), "invalid_params"),
        (Op::Read, json!({ "path": 5 }), "invalid_params"),
        (Op::Read, json!({}), "invalid_params"),
        (
            Op::Read,
            json!({ "path": b.h("work/a.txt"), "follow": true }),
            "invalid_params",
        ),
        (
            Op::Write,
            json!({ "path": b.h("work/a.txt") }),
            "invalid_params",
        ),
        // A root itself is never removed or overwritten.
        (Op::Remove, json!({ "path": b.h("work") }), "root"),
        (
            Op::Write,
            json!({ "path": b.h("work"), "content": "x" }),
            "invalid_params",
        ),
        // A stale etag.
        (
            Op::Read,
            json!({ "path": b.h("work/a.txt"), "etag": stale }),
            "etag_changed",
        ),
        (
            Op::Write,
            json!({ "path": b.h("work/a.txt"), "content": "y", "etag": stale }),
            "etag_changed",
        ),
    ];
    for (op, params, want) in rows {
        assert_eq!(reason(f.run(op, &params)), want, "{op:?} {params}");
    }
    assert_eq!(std::fs::read(b.p("home/work/a.txt")).unwrap(), b"hello");
    assert!(!b.p("outside/new").exists());
}

#[test]
fn a_read_write_home_still_refuses_protected_paths_and_folders_that_hold_them() {
    let b = Box_::new(HOME_RW);
    let f = b.files();
    let rows: Vec<(Op, Value, &str)> = vec![
        (
            Op::Write,
            json!({ "path": b.h(".bashrc"), "content": "x" }),
            "protected_path",
        ),
        (
            Op::Write,
            json!({ "path": b.h(".bash_profile"), "content": "x" }),
            "protected_path",
        ),
        (
            Op::Write,
            json!({ "path": b.h(".config/systemd/user/x.service"), "content": "x", "createParents": true }),
            "protected_path",
        ),
        (
            Op::Write,
            json!({ "path": b.h(".config/autostart/x.desktop"), "content": "x", "createParents": true }),
            "protected_path",
        ),
        (
            Op::Write,
            json!({ "path": b.h(".local/bin/ls"), "content": "x", "createParents": true }),
            "protected_path",
        ),
        (
            Op::Write,
            json!({ "path": b.h(".ssh/authorized_keys"), "content": "x" }),
            "protected_path",
        ),
        (
            Op::Mkdir,
            json!({ "path": b.h(".config/systemd") }),
            "protected_path",
        ),
        (
            Op::Remove,
            json!({ "path": b.h(".config"), "recursive": true }),
            "protected_path",
        ),
        (
            Op::Remove,
            json!({ "path": b.h(".ssh"), "recursive": true }),
            "protected_path",
        ),
        (Op::Remove, json!({ "path": b.h("") }), "root"),
    ];
    for (op, params, want) in rows {
        assert_eq!(reason(f.run(op, &params)), want, "{op:?} {params}");
    }
    assert!(b.p("home/.ssh/id_ed25519").exists());
    // Near misses that share a name are ordinary files.
    for (op, params) in [
        (
            Op::Write,
            json!({ "path": b.h(".bashrc.bak"), "content": "x" }),
        ),
        (
            Op::Write,
            json!({ "path": b.h(".config/Code/settings.json"), "content": "{}" }),
        ),
        (
            Op::Remove,
            json!({ "path": b.h(".config/Code"), "recursive": true }),
        ),
    ] {
        let r = f.run(op, &params);
        assert!(r.is_ok(), "{op:?} {params}: {}", reason(r));
    }
}

#[test]
fn reads_are_chunked_with_an_etag() {
    let b = Box_::new(ROOTS);
    let f = b.files();
    let big: Vec<u8> = (0..(2 * FS_READ_MAX_BYTES + 512))
        .map(|i| (i % 251) as u8)
        .collect();
    std::fs::write(b.p("home/work/big.bin"), &big).unwrap();
    let path = b.h("work/big.bin");
    let first = f
        .run(Op::Read, &json!({ "path": path, "encoding": "base64" }))
        .unwrap();
    assert_eq!(first["bytes"], FS_READ_MAX_BYTES);
    assert_eq!(first["truncated"], true);
    let etag = first["etag"].as_str().unwrap().to_string();
    let mut got = Vec::new();
    let mut offset = 0u64;
    loop {
        let r = f
            .run(
                Op::Read,
                &json!({ "path": path, "encoding": "base64", "offset": offset, "etag": etag }),
            )
            .unwrap();
        let chunk = base64::engine::general_purpose::STANDARD
            .decode(r["content"].as_str().unwrap())
            .unwrap();
        offset += chunk.len() as u64;
        got.extend(chunk);
        if r["eof"] == true {
            break;
        }
    }
    assert_eq!(got, big);
    // A smaller length, and the file changing under the reader.
    let r = f
        .run(Op::Read, &json!({ "path": path, "length": 10 }))
        .unwrap();
    assert_eq!(r["bytes"], 10);
    std::fs::write(b.p("home/work/big.bin"), b"changed").unwrap();
    let r = f.run(
        Op::Read,
        &json!({ "path": path, "offset": 0, "etag": etag }),
    );
    assert_eq!(reason(r), "etag_changed");
}

#[test]
fn the_ceiling_is_read_again_on_every_call() {
    let b = Box_::new(ROOTS);
    let f = b.files();
    let params = json!({ "path": b.h("work/x.txt"), "content": "1" });
    assert!(f.run(Op::Write, &params).is_ok());
    b.policy(r#"{"files":{"roots":[{"path":"~/work","mode":"ro"}]}}"#);
    assert_eq!(reason(f.run(Op::Write, &params)), "read_only_root");
    b.policy("not json");
    assert_eq!(
        reason(f.run(Op::Read, &json!({ "path": b.h("work/a.txt") }))),
        "machine_policy"
    );
}

/// #1512 review r1, finding 6: a read-only root is judged by its real path, whichever spelling
/// (a linked root) reaches it, and no remove takes a folder that holds a root.
#[test]
fn read_only_roots_hold_under_every_spelling_and_their_ancestors_are_not_removed() {
    let b = Box_::new(HOME_RW);
    for d in [
        "home/real/work/keep",
        "home/real/work/other",
        "home/w/a/keep",
        "home/w/b",
    ] {
        std::fs::create_dir_all(b.p(d)).unwrap();
    }
    std::fs::write(b.p("home/real/work/keep/k.txt"), "KEEP").unwrap();
    std::fs::write(b.p("home/w/a/keep/k.txt"), "KEEP").unwrap();
    std::fs::write(b.p("home/w/b/x"), "x").unwrap();
    symlink(b.p("home/real/work"), b.p("home/linkwork")).unwrap();
    b.policy(
        r#"{"files":{"roots":[
            {"path":"~/linkwork","mode":"rw"},
            {"path":"~/real/work/keep","mode":"ro"},
            {"path":"~/w","mode":"rw"},
            {"path":"~/w/a/keep","mode":"ro"}
        ]}}"#,
    );
    let f = b.files();
    let write =
        |p: &str| json!({ "path": b.h(p), "content": "OVERWRITTEN", "createParents": true });
    let remove = |p: &str| json!({ "path": b.h(p), "recursive": true });
    let must_refuse: Vec<(Op, Value, &str)> = vec![
        (Op::Write, write("linkwork/keep/k.txt"), "read_only_root"),
        (Op::Write, write("linkwork/keep/new.txt"), "read_only_root"),
        (Op::Write, write("real/work/keep/k.txt"), "read_only_root"),
        (Op::Write, write("w/a/keep/x"), "read_only_root"),
        (Op::Remove, remove("w/a"), "holds_root"),
        (Op::Remove, remove("w/a/keep"), "read_only_root"),
        (Op::Remove, remove("linkwork/keep"), "read_only_root"),
        (
            Op::Mkdir,
            json!({ "path": b.h("linkwork/keep/d") }),
            "read_only_root",
        ),
    ];
    for (op, params, want) in must_refuse {
        assert_eq!(reason(f.run(op, &params)), want, "{op:?} {params}");
    }
    assert_eq!(
        std::fs::read_to_string(b.p("home/real/work/keep/k.txt")).unwrap(),
        "KEEP"
    );
    assert!(b.p("home/w/a/keep/k.txt").exists());
    let must_allow: Vec<(Op, Value)> = vec![
        (Op::Write, write("linkwork/other/x")),
        (Op::Read, json!({ "path": b.h("w/a/keep/k.txt") })),
        (Op::Read, json!({ "path": b.h("linkwork/keep/k.txt") })),
        (Op::Remove, remove("w/b")),
    ];
    for (op, params) in must_allow {
        let r = f.run(op, &params);
        assert!(r.is_ok(), "{op:?} {params}: {}", reason(r));
    }
    assert!(b.p("home/real/work/other/x").exists());
    assert!(!b.p("home/w/b").exists());
}

/// #1512 review r1, finding 3: every read's result fits in one frame, whatever the bytes.
#[test]
fn every_read_fits_in_one_frame() {
    let b = Box_::new(ROOTS);
    let f = b.files();
    let frame = |r: &Value| {
        psyche_protocol::frame::req_line(
            "h1",
            "node.result",
            &json!({ "invocationId": "inv", "ok": true, "result": r }),
        )
    };
    for (name, bytes) in [
        ("nul.bin", vec![0u8; 1024 * 1024]),
        ("text.txt", b"line\n".repeat(220_000)),
        ("quote.txt", vec![b'"'; 1024 * 1024]),
    ] {
        std::fs::write(b.p("home/work").join(name), &bytes).unwrap();
        for encoding in ["utf8", "base64"] {
            let mut offset = 0u64;
            loop {
                let params = json!({ "path": b.h(&format!("work/{name}")), "encoding": encoding, "offset": offset });
                let r = f.run(Op::Read, &params).unwrap();
                assert!(frame(&r).is_ok(), "{name} {encoding} at {offset}");
                let n = r["bytes"].as_u64().unwrap();
                assert!(
                    n > 0 || r["eof"] == true,
                    "{name} {encoding} stuck at {offset}"
                );
                offset += n;
                if r["eof"] == true {
                    break;
                }
            }
            assert_eq!(offset, bytes.len() as u64, "{name} {encoding}");
        }
    }
}
