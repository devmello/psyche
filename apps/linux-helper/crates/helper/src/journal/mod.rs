//! The box's own trail (design §6.3): one line per command, file write or remove, sent to the
//! systemd journal with the identifier `psyche-helper`. Metadata only, never content: a program
//! name, an argv hash, a path, a byte count, an exit code. journald files the line in the user's
//! journal (`journalctl --user -t psyche-helper`), which this account can read but not edit.
//!
//! Spoken over journald's native datagram socket, so there is no libsystemd dependency. Values
//! are single-line (controls are replaced), so the simple `KEY=value\n` form is always correct.
//! No socket (a box without systemd, a test): the line goes nowhere, and the helper's own stderr
//! log still names the call.

use std::os::unix::net::UnixDatagram;
use std::path::{Path, PathBuf};

pub const IDENTIFIER: &str = "psyche-helper";
const SOCKET: &str = "/run/systemd/journal/socket";
/// A field longer than this is cut: a line is metadata, never a payload.
const MAX_VALUE: usize = 1024;

#[derive(Debug, Clone)]
pub struct Journal {
    socket: Option<PathBuf>,
}

impl Default for Journal {
    fn default() -> Self {
        Self::system()
    }
}

impl Journal {
    /// journald's socket.
    pub fn system() -> Self {
        Self {
            socket: Some(PathBuf::from(SOCKET)),
        }
    }

    /// A socket of the caller's choosing (tests).
    pub fn at(path: &Path) -> Self {
        Self {
            socket: Some(path.to_path_buf()),
        }
    }

    /// Nowhere.
    pub fn off() -> Self {
        Self { socket: None }
    }

    /// Sends one entry. Never fails the call it records: a journal that is down is logged.
    pub fn send(&self, event: &str, message: &str, fields: &[(&str, String)]) {
        let Some(path) = &self.socket else { return };
        let datagram = encode(event, message, fields);
        let sent = UnixDatagram::unbound().and_then(|s| s.send_to(datagram.as_bytes(), path));
        if let Err(e) = sent {
            crate::log(&format!("journal unavailable ({}): {event}", e.kind()));
        }
    }
}

fn clean(value: &str) -> String {
    let mut out: String = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if out.len() > MAX_VALUE {
        let mut end = MAX_VALUE;
        while !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
    }
    out
}

/// The datagram for one entry. Field names are upper-case ASCII as journald requires.
pub fn encode(event: &str, message: &str, fields: &[(&str, String)]) -> String {
    let mut out = String::new();
    let mut push = |key: &str, value: &str| {
        let key: String = key
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect();
        out.push_str(&key);
        out.push('=');
        out.push_str(&clean(value));
        out.push('\n');
    };
    push("SYSLOG_IDENTIFIER", IDENTIFIER);
    push("PRIORITY", "6");
    push("MESSAGE", message);
    push("PSYCHE_EVENT", event);
    for (k, v) in fields {
        push(&format!("PSYCHE_{k}"), v);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_is_single_line_fields_with_the_identifier() {
        let text = encode(
            "exec",
            "ran ls\nin /x",
            &[
                ("argv_sha256", "sha256:ab".into()),
                ("cwd", "/home/dev/p\r\n".into()),
            ],
        );
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "SYSLOG_IDENTIFIER=psyche-helper");
        assert!(lines.contains(&"MESSAGE=ran ls in /x"));
        assert!(lines.contains(&"PSYCHE_EVENT=exec"));
        assert!(lines.contains(&"PSYCHE_ARGV_SHA256=sha256:ab"));
        assert!(lines.contains(&"PSYCHE_CWD=/home/dev/p  "));
        assert!(lines.iter().all(|l| l.contains('=')));
        let long = encode("x", &"é".repeat(2000), &[]);
        assert!(long.lines().all(|l| l.len() <= MAX_VALUE + 20));
    }

    #[test]
    fn entries_reach_the_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.sock");
        let rx = UnixDatagram::bind(&path).unwrap();
        Journal::at(&path).send("fs.write", "wrote 3 bytes", &[("bytes", "3".into())]);
        let mut buf = [0u8; 4096];
        let n = rx.recv(&mut buf).unwrap();
        let got = String::from_utf8_lossy(&buf[..n]);
        assert!(got.contains("PSYCHE_EVENT=fs.write\n"), "{got}");
        assert!(got.contains("PSYCHE_BYTES=3\n"));
        // A missing socket does not fail the caller.
        Journal::at(&dir.path().join("absent")).send("x", "y", &[]);
        Journal::off().send("x", "y", &[]);
    }

    /// On a box with journald: `PSYCHE_JOURNAL_TOKEN=x cargo test -- --ignored journald`, then
    /// `journalctl -t psyche-helper PSYCHE_TOKEN=x` shows the entry.
    #[test]
    #[ignore = "writes to the real journal"]
    fn journald_receives_an_entry() {
        let token = std::env::var("PSYCHE_JOURNAL_TOKEN").unwrap_or_else(|_| "h5".into());
        Journal::system().send("test", "psyche-helper journal check", &[("token", token)]);
    }
}
