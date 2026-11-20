//! What a crashed helper leaves behind, cleared when the next one starts.
//!
//! Xvfb, the private bus and the accessibility launcher die with the helper (PDEATHSIG). Apps do
//! not (they are the owner's work, in their own scopes), and nothing removes the session dirs.
//!
//! Every scope and dir carries the tag of the helper that made it: `<pid ns>.<pid>.<start>`, in
//! hex, where `pid ns` is the inode of the helper's pid namespace and `start` its start time
//! (`/proc/<pid>/stat` field 22). Names: `psyche-vs-<tag>-...`, `vs-<tag>-...`,
//! `psyche-vscreen-<tag>-...`. The next helper removes only what carries a tag that:
//! - is from its own pid namespace (a helper in a toolbox or distrobox sharing this user manager
//!   has pids that mean nothing here: its things are never judged);
//! - is not its own;
//! - names a process that is gone: no process with that pid, or one that started at another
//!   time (the pid was reused). A process it cannot read counts as alive.
//!
//! When the helper cannot read its own tag (no `/proc`), it sweeps nothing.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Who made a scope or dir.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HelperTag {
    pub pid_ns: u64,
    pub pid: u32,
    pub start: u64,
}

impl HelperTag {
    /// `<pid ns>.<pid>.<start>` in lower-case hex: short, and valid in unit and file names.
    pub fn text(&self) -> String {
        format!("{:x}.{:x}.{:x}", self.pid_ns, self.pid, self.start)
    }

    pub fn parse(text: &str) -> Option<HelperTag> {
        let mut parts = text.split('.');
        let hex = |s: Option<&str>| -> Option<u64> {
            let s = s?;
            if s.is_empty() || s.len() > 16 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            u64::from_str_radix(s, 16).ok()
        };
        let tag = HelperTag {
            pid_ns: hex(parts.next())?,
            pid: u32::try_from(hex(parts.next())?).ok()?,
            start: hex(parts.next())?,
        };
        parts.next().is_none().then_some(tag)
    }
}

/// The start time (field 22) from a `/proc/<pid>/stat` line. The command name (field 2) is in
/// parentheses and may hold spaces and parentheses itself, so fields are counted after the last
/// `)`.
pub fn start_time_from_stat(stat: &str) -> Option<u64> {
    let after = &stat[stat.rfind(')')? + 1..];
    // After `)`: field 3 (state) is the first, so field 22 is the 20th.
    after.split_whitespace().nth(19)?.parse().ok()
}

/// The inode of a `/proc/<pid>/ns/pid` link target, `pid:[4026531836]`.
pub fn ns_inode(link: &str) -> Option<u64> {
    link.strip_prefix("pid:[")?.strip_suffix(']')?.parse().ok()
}

fn read_tag(pid: &str) -> Option<HelperTag> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let ns = std::fs::read_link(format!("/proc/{pid}/ns/pid")).ok()?;
    Some(HelperTag {
        pid_ns: ns_inode(&ns.to_string_lossy())?,
        pid: std::process::id(),
        start: start_time_from_stat(&stat)?,
    })
}

/// This helper's tag, `None` without `/proc`.
pub fn own_tag() -> Option<HelperTag> {
    static TAG: OnceLock<Option<HelperTag>> = OnceLock::new();
    *TAG.get_or_init(|| read_tag("self"))
}

/// The tag text this helper puts in its names: its own, or `0.<pid>.0` when it has none (such
/// names are never swept, since a helper without a tag sweeps nothing and the namespace never
/// matches a real one).
pub fn own_tag_text() -> String {
    own_tag().map(|t| t.text()).unwrap_or_else(|| {
        HelperTag {
            pid_ns: 0,
            pid: std::process::id(),
            start: 0,
        }
        .text()
    })
}

/// Whether the helper behind `tag` (from our pid namespace) still runs: the pid exists and
/// started at the tagged time. A process we cannot read counts as running.
pub fn tag_alive(tag: &HelperTag) -> bool {
    match std::fs::read_to_string(format!("/proc/{}/stat", tag.pid)) {
        Ok(stat) => start_time_from_stat(&stat).is_none_or(|start| start == tag.start),
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

/// The tag in `<prefix><tag>-<rest>`.
pub fn tag_of(name: &str, prefix: &str) -> Option<HelperTag> {
    let rest = name.strip_prefix(prefix)?;
    let (tag, tail) = rest.split_once('-')?;
    if tail.is_empty() {
        return None;
    }
    HelperTag::parse(tag)
}

/// The names a helper tagged `me` may remove: tagged, same pid namespace, not `me`, not alive.
pub fn stale<'a>(
    names: impl Iterator<Item = &'a str>,
    tag_of_name: impl Fn(&str) -> Option<HelperTag>,
    me: &HelperTag,
    alive: &dyn Fn(&HelperTag) -> bool,
) -> Vec<&'a str> {
    names
        .filter(|n| tag_of_name(n).is_some_and(|t| t.pid_ns == me.pid_ns && t != *me && !alive(&t)))
        .collect()
}

/// Removes `<base>/<prefix><tag>-*` directories of dead helpers, ours only (a real directory,
/// owned by this uid), with `rmtree`. Returns what it removed.
pub fn sweep_dirs(
    base: &Path,
    prefix: &str,
    me: &HelperTag,
    alive: &dyn Fn(&HelperTag) -> bool,
) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(base) else {
        return Vec::new();
    };
    let names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    // SAFETY: geteuid has no preconditions.
    let euid = unsafe { libc::geteuid() };
    let mut removed = Vec::new();
    for name in stale(
        names.iter().map(String::as_str),
        |n| tag_of(n, prefix),
        me,
        alive,
    ) {
        let path = base.join(name);
        let Ok(st) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !st.is_dir() || st.file_type().is_symlink() || st.uid() != euid {
            continue;
        }
        super::rmtree::remove_tree_logged(&path, "leftover session dir");
        if std::fs::symlink_metadata(&path).is_err() {
            removed.push(path);
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: HelperTag = HelperTag {
        pid_ns: 0xeffffffc,
        pid: 42,
        start: 1000,
    };

    fn tag(pid: u32, start: u64) -> String {
        HelperTag {
            pid_ns: ME.pid_ns,
            pid,
            start,
        }
        .text()
    }

    #[test]
    fn tags_round_trip_and_odd_ones_are_refused() {
        assert_eq!(ME.text(), "effffffc.2a.3e8");
        assert_eq!(HelperTag::parse("effffffc.2a.3e8"), Some(ME));
        for bad in [
            "",
            "1.2",
            "1.2.3.4",
            "g.1.1",
            "1..1",
            "1.100000000.1",
            "-1.2.3",
            "11111111111111111.1.1",
        ] {
            assert_eq!(HelperTag::parse(bad), None, "{bad}");
        }
        assert_eq!(tag_of("vs-effffffc.2a.3e8-abcdef", "vs-"), Some(ME));
        assert_eq!(
            tag_of("psyche-vs-effffffc.2a.3e8-bus-90-7.scope", "psyche-vs-"),
            Some(ME)
        );
        for bad in [
            "vs-abcdef",
            "vs-1.2.3",
            "vs-1.2.3-",
            "xvs-1.2.3-a",
            "vs-42-abcd",
        ] {
            assert_eq!(tag_of(bad, "vs-"), None, "{bad}");
        }
    }

    #[test]
    fn the_start_time_is_field_22_even_with_odd_command_names() {
        // Real layout: pid (comm) state ppid ... starttime is field 22.
        let fields_3_to_21 = "S 1 1 1 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0";
        let stat = format!("1234 (psyche-helper) {fields_3_to_21} 987654 12345 678\n");
        assert_eq!(start_time_from_stat(&stat), Some(987_654));
        // A command name with spaces and a `)` in it.
        let stat = format!("1234 (a) b (c)) {fields_3_to_21} 555 1 2\n");
        assert_eq!(start_time_from_stat(&stat), Some(555));
        assert_eq!(start_time_from_stat("1234 (x) S 1 2"), None);
        assert_eq!(start_time_from_stat("garbage"), None);
        assert_eq!(ns_inode("pid:[4026531836]"), Some(4_026_531_836));
        assert_eq!(ns_inode("net:[4026531836]"), None);
        assert_eq!(ns_inode("pid:[x]"), None);
    }

    #[test]
    fn only_a_dead_helper_from_our_pid_namespace_is_stale() {
        let alive = |t: &HelperTag| t.pid == 500 && t.start == 7;
        let other_ns = HelperTag {
            pid_ns: 0x1234,
            pid: 100,
            start: 7,
        }
        .text();
        let names = [
            format!("psyche-vs-{}-bus-90-1.scope", tag(100, 7)), // gone
            format!("psyche-vs-{}-bus-91-2.scope", tag(500, 7)), // a live helper
            format!("psyche-vs-{}-app-3.scope", tag(500, 8)),    // pid reused: started later
            format!("psyche-vs-{}-firefox-3.scope", ME.text()),  // ours
            format!("psyche-vs-{other_ns}-bus-92-4.scope"),      // another pid namespace
            "psyche-vs-display-90-7.scope".to_string(),          // untagged: not ours to judge
            "psyche-vs-100-bus-90-1.scope".to_string(),          // old format
        ];
        let got = stale(
            names.iter().map(String::as_str),
            |n| tag_of(n, "psyche-vs-"),
            &ME,
            &alive,
        );
        assert_eq!(got, [names[0].as_str(), names[2].as_str()]);
    }

    #[test]
    fn the_sweep_removes_dead_helpers_dirs_and_nothing_else() {
        let base = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep"), "owner's").unwrap();
        let dead = format!("vs-{}-aaaa", tag(100, 7));
        let live = format!("vs-{}-bbbb", tag(500, 7));
        let mine = format!("vs-{}-cccc", ME.text());
        for d in [&dead, &live, &mine, &"vs-dddd".to_string()] {
            std::fs::create_dir_all(base.path().join(d)).unwrap();
        }
        std::fs::create_dir_all(base.path().join(&dead).join("bus-dir")).unwrap();
        std::fs::write(base.path().join(&dead).join("bus-dir/f"), "x").unwrap();
        // A dead helper's name on a symlink: never followed, never swept as a dir.
        let link = format!("vs-{}-eeee", tag(101, 7));
        std::os::unix::fs::symlink(outside.path(), base.path().join(&link)).unwrap();
        // A file, not a dir.
        let file = format!("vs-{}-ffff", tag(102, 7));
        std::fs::write(base.path().join(&file), "x").unwrap();
        let removed = sweep_dirs(base.path(), "vs-", &ME, &|t| t.pid == 500);
        assert_eq!(removed, [base.path().join(&dead)]);
        for kept in [&live, &mine, &"vs-dddd".to_string(), &file, &link] {
            assert!(
                std::fs::symlink_metadata(base.path().join(kept)).is_ok(),
                "{kept}"
            );
        }
        assert!(outside.path().join("keep").is_file());
    }

    #[test]
    fn our_own_process_counts_as_alive() {
        if let Some(me) = own_tag() {
            assert!(tag_alive(&me));
            assert!(!tag_alive(&HelperTag {
                start: me.start + 1,
                ..me
            }));
        }
        assert!(!tag_alive(&HelperTag {
            pid_ns: 1,
            pid: u32::MAX - 1,
            start: 1,
        }));
        assert!(!own_tag_text().is_empty());
    }
}
