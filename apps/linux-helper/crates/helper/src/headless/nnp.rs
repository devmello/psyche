//! `NoNewPrivileges` (helper-only design §3.3, §6.5): the flag is inherited across `fork` and
//! `exec`, so once the helper has it, nothing it starts (an app in a scope, a command) can gain
//! privileges through sudo, pkexec or a setuid file. The unit sets it; a helper started by hand
//! sets it on itself in headless mode, so the guarantee does not depend on how it was started.
//!
//! `systemd-run --user --scope` runs the command as the caller's child, so scopes inherit it too
//! (checked on Ubuntu 24.04 in the PR).

/// Reads `NoNewPrivs:` from the text of `/proc/<pid>/status`.
pub fn parse_status(status: &str) -> Option<bool> {
    status
        .lines()
        .find_map(|l| l.strip_prefix("NoNewPrivs:"))
        .map(|v| v.trim() == "1")
}

/// Whether process `pid` has the flag; `None` when its status cannot be read.
pub fn is_set_for(pid: u32) -> Option<bool> {
    parse_status(&std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?)
}

/// Sets the flag on this process (it cannot be cleared again) and checks that it took.
pub fn enforce() -> Result<(), String> {
    // SAFETY: prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) only sets a flag on this process.
    let rc = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if rc != 0 {
        return Err(format!(
            "cannot set NoNewPrivileges: {}",
            std::io::Error::last_os_error()
        ));
    }
    match is_set_for(std::process::id()) {
        Some(true) | None => Ok(()),
        Some(false) => Err("NoNewPrivileges did not take".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flag_is_read_from_proc_status() {
        assert_eq!(
            parse_status("Name:\tx\nNoNewPrivs:\t1\nSeccomp:\t0\n"),
            Some(true)
        );
        assert_eq!(parse_status("Name:\tx\nNoNewPrivs:\t0\n"), Some(false));
        assert_eq!(parse_status("Name:\tx\n"), None);
    }
}
