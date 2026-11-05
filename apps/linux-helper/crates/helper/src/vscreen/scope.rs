//! Apps run in transient systemd scopes inside `psyche-vscreen.slice` (linux-desktop design
//! §7.2). The slice is what the guard and the AT-SPI filter recognise, and what `MemoryHigh`
//! throttles, so a runaway app slows down instead of taking the machine with it.

use std::process::{Child, Command, Stdio};

use super::recipes::LaunchSpec;

pub const SLICE_NAME: &str = "psyche-vscreen.slice";
pub const DEFAULT_MEMORY_HIGH: &str = "2G";

pub trait ScopeRunner: Send + Sync {
    /// Starts `spec` in the scope `unit`. The child is the app itself (`systemd-run --scope`
    /// replaces itself with the command).
    fn spawn(&self, unit: &str, description: &str, spec: &LaunchSpec) -> Result<Child, String>;
    /// Stops the scope, which ends every process in it.
    fn stop(&self, unit: &str);
    /// Sets `MemoryHigh` on the slice.
    fn limit_slice(&self, memory_high: &str);
}

/// `psyche-vs-<app>-<n>` with the app id reduced to what a unit name allows.
pub fn unit_name(app_id: &str, n: u32) -> String {
    let clean: String = app_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let clean = clean.trim_matches('-');
    let clean = if clean.is_empty() { "app" } else { clean };
    let short: String = clean.chars().take(40).collect();
    format!("psyche-vs-{short}-{n}")
}

/// The `systemd-run` argument list (without the program name).
pub fn systemd_run_args(unit: &str, description: &str, argv: &[String]) -> Vec<String> {
    let mut args: Vec<String> = [
        "--user".to_string(),
        "--scope".into(),
        "--quiet".into(),
        format!("--slice={SLICE_NAME}"),
        format!("--unit={unit}"),
        format!("--description={description}"),
        "--".into(),
    ]
    .to_vec();
    args.extend(argv.iter().cloned());
    args
}

/// A `MemoryHigh` value systemd accepts: bytes, a K/M/G/T suffix, a percentage, or `infinity`.
pub fn parse_memory_high(text: &str) -> Option<String> {
    let t = text.trim();
    if t == "infinity" {
        return Some(t.to_string());
    }
    let digits = t.trim_end_matches(['K', 'M', 'G', 'T', '%']);
    if digits.is_empty()
        || digits.len() + 1 < t.len()
        || !digits.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    Some(t.to_string())
}

pub struct SystemdRunner;

impl ScopeRunner for SystemdRunner {
    fn spawn(&self, unit: &str, description: &str, spec: &LaunchSpec) -> Result<Child, String> {
        let mut cmd = Command::new("systemd-run");
        cmd.args(systemd_run_args(unit, description, &spec.argv))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for name in &spec.env_remove {
            cmd.env_remove(name);
        }
        for (k, v) in &spec.env_set {
            cmd.env(k, v);
        }
        cmd.spawn().map_err(|e| format!("systemd-run: {e}"))
    }

    fn stop(&self, unit: &str) {
        let _ = Command::new("systemctl")
            .args(["--user", "stop", &format!("{unit}.scope")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    fn limit_slice(&self, memory_high: &str) {
        let _ = Command::new("systemctl")
            .args(["--user", "set-property", "--runtime", SLICE_NAME])
            .arg(format!("MemoryHigh={memory_high}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_names_are_safe_and_short() {
        assert_eq!(
            unit_name("org.gnome.TextEditor", 3),
            "psyche-vs-org-gnome-TextEditor-3"
        );
        assert_eq!(unit_name("../../etc", 1), "psyche-vs-etc-1");
        assert_eq!(unit_name("", 2), "psyche-vs-app-2");
        assert!(unit_name(&"a".repeat(200), 1).len() < 60);
    }

    #[test]
    fn the_scope_goes_in_the_slice_with_the_app_after_a_double_dash() {
        let args = systemd_run_args(
            "psyche-vs-x-1",
            "Psyche virtual screen: X",
            &["app".into(), "--flag".into()],
        );
        assert_eq!(args[0], "--user");
        assert!(args.contains(&"--scope".to_string()));
        assert!(args.contains(&"--slice=psyche-vscreen.slice".to_string()));
        assert!(args.contains(&"--unit=psyche-vs-x-1".to_string()));
        let dash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(&args[dash + 1..], ["app", "--flag"]);
    }

    #[test]
    fn memory_settings_are_validated() {
        for ok in ["2G", "512M", "1048576", "infinity", " 4G "] {
            assert!(parse_memory_high(ok).is_some(), "{ok}");
        }
        for bad in ["", "G", "2 G", "2GB", "-1", "1;reboot", "MemoryMax=1"] {
            assert!(parse_memory_high(bad).is_none(), "{bad}");
        }
    }
}
