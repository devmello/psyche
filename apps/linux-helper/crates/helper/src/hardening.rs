//! Start-up hardening (linux-desktop design §4.3).
//!
//! The Gateway's peer check proves which binary file is running, not that its code is
//! unmodified: a library preloaded into the process runs before `main`. So the helper refuses to
//! start when the dynamic loader was told to inject one. That is hygiene, not a defence: a
//! preload constructor runs before `main`, so the real check is the Gateway's, which reads
//! `/proc/<pid>/maps` and `/proc/<pid>/environ` of the connecting process. This does not stop a same-user attacker
//! who can edit the helper's start-up (they could start something else entirely); it removes the
//! cheapest way to run foreign code inside the real, root-owned binary.
//!
//! At the very start it also closes every inherited descriptor above stderr, so a parent that
//! connected to the Gateway's socket and then executed the helper cannot leave a second holder of
//! that socket behind.
//!
//! The helper deliberately does NOT call `prctl(PR_SET_DUMPABLE, 0)`: a non-dumpable process hides
//! `/proc/<pid>/fd` and `/proc/<pid>/exe` from its own user, and the Gateway reads exactly those
//! to verify the peer. Making the helper non-dumpable would make every pairing `unverified`.

use crate::paths::Env;

/// Closes every descriptor from 3 up, before anything else is opened.
pub fn close_inherited_fds() {
    close_fds_from(3, u32::MAX);
}

/// Closes the descriptors `first..=last`. Uses `close_range(2)`; where the kernel lacks it
/// (before Linux 5.9) it walks `/proc/self/fd` and closes what is listed in the range.
pub fn close_fds_from(first: u32, last: u32) {
    // SAFETY: close_range only closes descriptors of this process; nothing is read or written.
    let rc = unsafe { libc::syscall(libc::SYS_close_range, first, last, 0u32) };
    if rc == 0 {
        return;
    }
    let Ok(dir) = std::fs::read_dir("/proc/self/fd") else {
        return;
    };
    let fds: Vec<u32> = dir
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
        .filter(|fd| (first..=last).contains(fd))
        .collect();
    for fd in fds {
        // SAFETY: closing a descriptor number of this process; the directory handle used for the
        // listing is already dropped, and a number that is no longer open just fails.
        unsafe {
            libc::close(fd as libc::c_int);
        }
    }
}

/// The variables with which the dynamic loader loads code into a process.
const INJECTION_VARS: [&str; 2] = ["LD_PRELOAD", "LD_AUDIT"];

/// `Err` with a message naming the variable when one of them is set (non-empty).
pub fn refuse_injected_libraries(env: &dyn Env) -> Result<(), String> {
    for name in INJECTION_VARS {
        if env.get(name).is_some() {
            return Err(format!(
                "refusing to start: {name} is set, and a preloaded library would run inside the helper"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::os::fd::IntoRawFd;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn a_clean_environment_starts() {
        assert!(
            refuse_injected_libraries(&env(&[("HOME", "/h"), ("LD_LIBRARY_PATH", "/x")])).is_ok()
        );
        assert!(refuse_injected_libraries(&env(&[("LD_PRELOAD", "")])).is_ok());
    }

    fn is_open(fd: i32) -> bool {
        // SAFETY: F_GETFD only queries the descriptor.
        unsafe { libc::fcntl(fd, libc::F_GETFD) != -1 }
    }

    #[test]
    fn inherited_descriptors_in_the_range_are_closed() {
        let a = std::fs::File::open("/proc/self/stat")
            .unwrap()
            .into_raw_fd();
        let b = std::fs::File::open("/proc/self/stat")
            .unwrap()
            .into_raw_fd();
        assert!(is_open(a) && is_open(b));
        close_fds_from(a as u32, a as u32);
        assert!(!is_open(a), "the one in the range is closed");
        assert!(is_open(b), "the one outside it is left alone");
        close_fds_from(b as u32, b as u32);
        assert!(!is_open(b));
    }

    #[test]
    fn ld_preload_and_ld_audit_refuse() {
        for name in ["LD_PRELOAD", "LD_AUDIT"] {
            let err = refuse_injected_libraries(&env(&[(name, "/tmp/x.so")])).unwrap_err();
            assert!(err.contains(name), "{err}");
        }
    }
}
