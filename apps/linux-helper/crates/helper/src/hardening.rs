//! Start-up hardening (linux-desktop design §4.3).
//!
//! The Gateway's peer check proves which binary file is running, not that its code is
//! unmodified: a library preloaded into the process runs before `main`. So the helper refuses to
//! start when the dynamic loader was told to inject one. This does not stop a same-user attacker
//! who can edit the helper's start-up (they could start something else entirely); it removes the
//! cheapest way to run foreign code inside the real, root-owned binary.
//!
//! The helper deliberately does NOT call `prctl(PR_SET_DUMPABLE, 0)`: a non-dumpable process hides
//! `/proc/<pid>/fd` and `/proc/<pid>/exe` from its own user, and the Gateway reads exactly those
//! to verify the peer. Making the helper non-dumpable would make every pairing `unverified`.

use crate::paths::Env;

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

    #[test]
    fn ld_preload_and_ld_audit_refuse() {
        for name in ["LD_PRELOAD", "LD_AUDIT"] {
            let err = refuse_injected_libraries(&env(&[(name, "/tmp/x.so")])).unwrap_err();
            assert!(err.contains(name), "{err}");
        }
    }
}
