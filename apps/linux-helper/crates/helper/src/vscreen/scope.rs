//! Everything on the virtual screen runs in `psyche-vscreen.slice` (linux-desktop design §7.2,
//! §7.4): apps in transient `systemd-run --user --scope` units, the X server and the private bus
//! in their own scopes in the same slice. The slice is what the guard and the AT-SPI filter
//! recognise, and it carries hard caps:
//!
//! - `MemoryHigh` throttles, `MemoryMax` is the ceiling, `TasksMax` stops fork bombs, and
//!   `CPUQuota` leaves the owner most of the machine.
//! - The caps are set before the first process starts in the slice, and a failure to set them
//!   stops the start: the screen does not run uncapped.
//! - `infinity` is never accepted from the settings file or the environment.
//!
//! Apps get exactly the environment the recipe built (`recipes::app_environment`), nothing of
//! the helper's: `systemd-run` execs `env -i <allowlist> <app>`.

use std::process::{Child, Command, Stdio};

use super::recipes::LaunchSpec;

pub const SLICE_NAME: &str = "psyche-vscreen.slice";
pub const DEFAULT_MEMORY_HIGH: &str = "2G";
pub const DEFAULT_MEMORY_MAX: &str = "3G";
pub const DEFAULT_TASKS_MAX: u32 = 2048;

/// Checks `systemctl show` output (`MemoryHigh`, `MemoryMax`, `TasksMax`, `CPUQuotaPerSecUSec`)
/// against what was asked for: a `set-property` that exited 0 but did not take (a controller
/// that is not delegated to the user manager) leaves the slice uncapped, which must stop the
/// start. A percentage memory value only has to be finite.
pub fn check_limits_readback(show: &str, limits: &SliceLimits) -> Result<(), String> {
    let get = |key: &str| {
        show.lines()
            .find_map(|l| l.strip_prefix(key)?.strip_prefix('=').map(str::trim))
    };
    let high_asked = match (
        memory_bytes(&limits.memory_high),
        memory_bytes(&limits.memory_max),
    ) {
        (Some(h), Some(m)) => Some(h.min(m)),
        (h, _) => h,
    };
    let memory = |key: &str, want: Option<u64>| -> Result<(), String> {
        let got = get(key).ok_or_else(|| format!("{key} is not reported"))?;
        match (got.parse::<u64>(), want) {
            (Ok(g), Some(w)) if g == w => Ok(()),
            (Ok(_), None) => Ok(()),
            _ => Err(format!("{key} reads back as {got}")),
        }
    };
    memory("MemoryHigh", high_asked)?;
    memory("MemoryMax", memory_bytes(&limits.memory_max))?;
    let tasks = get("TasksMax").ok_or("TasksMax is not reported")?;
    if tasks.parse::<u32>().ok() != Some(limits.tasks_max) {
        return Err(format!("TasksMax reads back as {tasks}"));
    }
    let quota = get("CPUQuotaPerSecUSec").ok_or("CPUQuotaPerSecUSec is not reported")?;
    let want = f64::from(limits.cpu_quota_percent) * 10_000.0;
    let got = timespan_usec(quota).ok_or_else(|| format!("CPUQuota reads back as {quota}"))?;
    if (got - want).abs() > want * 0.01 + 1.0 {
        return Err(format!("CPUQuota reads back as {quota}"));
    }
    Ok(())
}

/// Microseconds of a systemd timespan such as `1s`, `1.5s`, `500ms` or `250us`; `None` for
/// `infinity` and anything else.
fn timespan_usec(text: &str) -> Option<f64> {
    let t = text.trim();
    let (num, mult) = if let Some(n) = t.strip_suffix("us") {
        (n, 1.0)
    } else if let Some(n) = t.strip_suffix("ms") {
        (n, 1_000.0)
    } else {
        (t.strip_suffix('s')?, 1_000_000.0)
    };
    let v: f64 = num.trim().parse().ok()?;
    (v.is_finite() && v >= 0.0).then_some(v * mult)
}

/// The slice's caps, as systemd properties.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SliceLimits {
    pub memory_high: String,
    pub memory_max: String,
    pub tasks_max: u32,
    /// Percent of one CPU (`CPUQuota=`); 200 is two cores.
    pub cpu_quota_percent: u32,
}

impl SliceLimits {
    /// Half the machine's CPUs, at least one.
    pub fn default_cpu_quota() -> u32 {
        let cpus = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(2);
        (cpus * 50).max(100)
    }

    pub fn defaults() -> Self {
        Self {
            memory_high: DEFAULT_MEMORY_HIGH.into(),
            memory_max: DEFAULT_MEMORY_MAX.into(),
            tasks_max: DEFAULT_TASKS_MAX,
            cpu_quota_percent: Self::default_cpu_quota(),
        }
    }

    /// The `systemctl set-property` assignments. `MemoryHigh` never exceeds `MemoryMax`.
    pub fn properties(&self) -> Vec<String> {
        let high = match (
            memory_bytes(&self.memory_high),
            memory_bytes(&self.memory_max),
        ) {
            (Some(h), Some(m)) if h > m => self.memory_max.clone(),
            _ => self.memory_high.clone(),
        };
        vec![
            format!("MemoryHigh={high}"),
            format!("MemoryMax={}", self.memory_max),
            format!("TasksMax={}", self.tasks_max),
            format!("CPUQuota={}%", self.cpu_quota_percent),
        ]
    }
}

pub trait ScopeRunner: Send + Sync {
    /// Starts `spec` in the scope `unit`. The child is the program itself (`systemd-run --scope`
    /// and `env` both replace themselves with the next command).
    fn spawn(&self, unit: &str, description: &str, spec: &LaunchSpec) -> Result<Child, String>;
    /// `spawn`, but the program dies with the helper (`PR_SET_PDEATHSIG` through
    /// `spawn::spawn_tied`, kept across both execs): for the session's own services, the private
    /// bus and the accessibility launcher.
    fn spawn_tied(&self, unit: &str, description: &str, spec: &LaunchSpec)
        -> Result<Child, String>;
    /// The user manager's `psyche-vs-*` scopes, loaded or running (for the startup sweep).
    fn list_scopes(&self) -> Vec<String> {
        Vec::new()
    }
    /// Moves a process this helper already started (the X server) into its own scope `unit` in
    /// the slice.
    fn adopt(&self, unit: &str, description: &str, pid: u32) -> Result<(), String>;
    /// Stops the scope, which ends every process in it.
    fn stop(&self, unit: &str);
    /// Sets the caps on the slice. An error means the slice is not capped.
    fn limit_slice(&self, limits: &SliceLimits) -> Result<(), String>;
}

/// `psyche-vs-<helper tag>-<app>-<n>` with the app id reduced to what a unit name allows. The tag
/// (`sweep::HelperTag`) lets the next helper tell its predecessor's leftovers from a live
/// helper's.
pub fn unit_name(helper_tag: &str, app_id: &str, n: u32) -> String {
    let clean: String = app_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let clean = clean.trim_matches('-');
    let clean = if clean.is_empty() { "app" } else { clean };
    let short: String = clean.chars().take(40).collect();
    format!("psyche-vs-{helper_tag}-{short}-{n}")
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

/// `env -i NAME=value ... argv...`: the program sees only `env`, none of the helper's own
/// variables. A program name `env` would read as a setting (it has `=`) is refused.
pub fn env_wrapped_argv(
    env_program: &str,
    env: &[(String, String)],
    argv: &[String],
) -> Result<Vec<String>, String> {
    let program = argv.first().ok_or("nothing to run")?;
    if program.contains('=') || program.is_empty() {
        return Err(format!("refusing to run {program:?}"));
    }
    let mut out = vec![env_program.to_string(), "-i".to_string()];
    for (name, value) in env {
        let ok = !name.is_empty()
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            && !name.as_bytes()[0].is_ascii_digit();
        if !ok || value.contains('\0') {
            return Err(format!("bad environment name {name:?}"));
        }
        out.push(format!("{name}={value}"));
    }
    out.extend(argv.iter().cloned());
    Ok(out)
}

/// What `systemd-run` itself needs to reach the user manager. None of it reaches the app (see
/// `env_wrapped_argv`).
pub const SYSTEMD_RUN_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
];

/// A memory value systemd accepts: bytes, a K/M/G/T suffix, or a percentage of RAM. Never
/// `infinity`, never zero, never over 100%.
pub fn parse_memory(text: &str) -> Option<String> {
    let t = text.trim();
    let digits = t.trim_end_matches(['K', 'M', 'G', 'T', '%']);
    if digits.is_empty()
        || digits.len() + 1 < t.len()
        || !digits.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let n: u64 = digits.parse().ok()?;
    if n == 0 || (t.ends_with('%') && n > 100) {
        return None;
    }
    Some(t.to_string())
}

/// Bytes of a `parse_memory` value; `None` for a percentage.
pub fn memory_bytes(text: &str) -> Option<u64> {
    let t = text.trim();
    let (digits, shift) = match t.chars().last()? {
        'K' => (&t[..t.len() - 1], 10),
        'M' => (&t[..t.len() - 1], 20),
        'G' => (&t[..t.len() - 1], 30),
        'T' => (&t[..t.len() - 1], 40),
        '%' => return None,
        _ => (t, 0),
    };
    digits.parse::<u64>().ok()?.checked_mul(1u64 << shift)
}

/// A `TasksMax` from settings: a plain number from 64 to 100000 (never `infinity`).
pub fn parse_tasks_max(text: &str) -> Option<u32> {
    let n: u32 = text.trim().parse().ok()?;
    (64..=100_000).contains(&n).then_some(n)
}

/// A `CPUQuota` from settings: `150%` or `150`, from 10 to 100 per CPU.
pub fn parse_cpu_quota(text: &str) -> Option<u32> {
    let t = text.trim();
    let n: u32 = t.strip_suffix('%').unwrap_or(t).parse().ok()?;
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1);
    (10..=100 * cpus).contains(&n).then_some(n)
}

/// `busctl` arguments for `StartTransientUnit` of a scope that adopts `pid`.
pub fn adopt_args(unit: &str, description: &str, pid: u32) -> Vec<String> {
    [
        "--user",
        "call",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "StartTransientUnit",
        "ssa(sv)a(sa(sv))",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([
        format!("{unit}.scope"),
        "fail".into(),
        "3".into(),
        "PIDs".into(),
        "au".into(),
        "1".into(),
        pid.to_string(),
        "Slice".into(),
        "s".into(),
        SLICE_NAME.into(),
        "Description".into(),
        "s".into(),
        description.into(),
        "0".into(),
    ])
    .collect()
}

pub struct SystemdRunner;

fn env_program() -> &'static str {
    if std::path::Path::new("/usr/bin/env").is_file() {
        "/usr/bin/env"
    } else {
        "/bin/env"
    }
}

fn run_checked(cmd: &mut Command, what: &str) -> Result<(), String> {
    let out = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("{what}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!(
            "{what}: {} ({})",
            out.status,
            err.trim().chars().take(300).collect::<String>()
        ))
    }
}

fn systemd_run_command(
    unit: &str,
    description: &str,
    spec: &LaunchSpec,
) -> Result<Command, String> {
    let argv = env_wrapped_argv(env_program(), &spec.env, &spec.argv)?;
    let mut cmd = Command::new("systemd-run");
    cmd.env_clear();
    for name in SYSTEMD_RUN_ENV {
        if let Ok(v) = std::env::var(name) {
            cmd.env(name, v);
        }
    }
    cmd.args(systemd_run_args(unit, description, &argv))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(cmd)
}

/// Unit names from `systemctl list-units --plain --no-legend` output (the first column).
pub fn parse_unit_list(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| l.split_whitespace().next())
        .filter(|u| u.starts_with("psyche-vs-") && u.ends_with(".scope"))
        .map(|u| u.to_string())
        .collect()
}

impl ScopeRunner for SystemdRunner {
    fn spawn(&self, unit: &str, description: &str, spec: &LaunchSpec) -> Result<Child, String> {
        systemd_run_command(unit, description, spec)?
            .spawn()
            .map_err(|e| format!("systemd-run: {e}"))
    }

    fn spawn_tied(
        &self,
        unit: &str,
        description: &str,
        spec: &LaunchSpec,
    ) -> Result<Child, String> {
        super::spawn::spawn_tied(systemd_run_command(unit, description, spec)?)
            .map_err(|e| format!("systemd-run: {e}"))
    }

    fn list_scopes(&self) -> Vec<String> {
        Command::new("systemctl")
            .args([
                "--user",
                "list-units",
                "--type=scope",
                "--all",
                "--plain",
                "--no-legend",
                "--no-pager",
                "psyche-vs-*",
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map(|o| parse_unit_list(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default()
    }

    fn adopt(&self, unit: &str, description: &str, pid: u32) -> Result<(), String> {
        run_checked(
            Command::new("busctl").args(adopt_args(unit, description, pid)),
            "busctl StartTransientUnit",
        )
    }

    fn stop(&self, unit: &str) {
        let _ = Command::new("systemctl")
            .args(["--user", "stop", &format!("{unit}.scope")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    fn limit_slice(&self, limits: &SliceLimits) -> Result<(), String> {
        run_checked(
            Command::new("systemctl")
                .args(["--user", "set-property", "--runtime", SLICE_NAME])
                .args(limits.properties()),
            "systemctl set-property",
        )?;
        // Read the caps back: exit 0 does not mean the controllers took them.
        let out = Command::new("systemctl")
            .args([
                "--user",
                "show",
                "-p",
                "MemoryHigh",
                "-p",
                "MemoryMax",
                "-p",
                "TasksMax",
                "-p",
                "CPUQuotaPerSecUSec",
                SLICE_NAME,
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| format!("systemctl show: {e}"))?;
        check_limits_readback(&String::from_utf8_lossy(&out.stdout), limits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_must_read_back_as_asked() {
        let l = SliceLimits {
            memory_high: "2G".into(),
            memory_max: "3G".into(),
            tasks_max: 2048,
            cpu_quota_percent: 150,
        };
        let ok = "MemoryHigh=2147483648\nMemoryMax=3221225472\nTasksMax=2048\nCPUQuotaPerSecUSec=1.5s\n";
        assert_eq!(check_limits_readback(ok, &l), Ok(()));
        let bad = [
            ok.replace("MemoryMax=3221225472", "MemoryMax=infinity"),
            ok.replace("MemoryHigh=2147483648", "MemoryHigh=infinity"),
            ok.replace("TasksMax=2048", "TasksMax=infinity"),
            ok.replace("TasksMax=2048", "TasksMax=4096"),
            ok.replace("1.5s", "infinity"),
            ok.replace("1.5s", "500ms"),
            "MemoryHigh=2147483648\nMemoryMax=3221225472\nTasksMax=2048\n".to_string(),
            String::new(),
        ];
        for b in bad {
            assert!(check_limits_readback(&b, &l).is_err(), "{b:?}");
        }
        let ms = ok.replace("1.5s", "1500ms");
        assert_eq!(check_limits_readback(&ms, &l), Ok(()));
        // MemoryHigh above MemoryMax is lowered to it.
        let capped = SliceLimits {
            memory_high: "4G".into(),
            ..l.clone()
        };
        let show = ok.replace("MemoryHigh=2147483648", "MemoryHigh=3221225472");
        assert_eq!(check_limits_readback(&show, &capped), Ok(()));
    }

    #[test]
    fn unit_names_are_safe_and_short() {
        assert_eq!(
            unit_name("effffffc.2a.3e8", "org.gnome.TextEditor", 3),
            "psyche-vs-effffffc.2a.3e8-org-gnome-TextEditor-3"
        );
        assert_eq!(unit_name("1.2.3", "../../etc", 1), "psyche-vs-1.2.3-etc-1");
        assert_eq!(unit_name("1.2.3", "", 2), "psyche-vs-1.2.3-app-2");
        let long_tag = "ffffffffffffffff.ffffffff.ffffffffffffffff";
        assert!(unit_name(long_tag, &"a".repeat(200), 1).len() < 120);
        // The tag the sweep reads back is the one that went in.
        let tag = super::super::sweep::HelperTag {
            pid_ns: 0xeffffffc,
            pid: 42,
            start: 1000,
        };
        assert_eq!(
            super::super::sweep::tag_of(&unit_name(&tag.text(), "org.x.Y", 1), "psyche-vs-"),
            Some(tag)
        );
    }

    #[test]
    fn listed_units_are_read_from_the_first_column() {
        let listed = "psyche-vs-77-bus-90-5.scope loaded active running Psyche bus\nfoo.scope loaded active running x\npsyche-vs-8-display-91-9.scope loaded inactive dead d\n";
        assert_eq!(
            parse_unit_list(listed),
            [
                "psyche-vs-77-bus-90-5.scope",
                "psyche-vs-8-display-91-9.scope"
            ]
        );
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
    fn the_app_runs_under_env_i_with_only_its_own_variables() {
        let env = vec![
            ("DISPLAY".to_string(), ":90".to_string()),
            ("HOME".to_string(), "/home/o".to_string()),
        ];
        let argv = env_wrapped_argv(
            "/usr/bin/env",
            &env,
            &["/usr/bin/app".into(), "--x=1".into()],
        )
        .unwrap();
        assert_eq!(
            argv,
            [
                "/usr/bin/env",
                "-i",
                "DISPLAY=:90",
                "HOME=/home/o",
                "/usr/bin/app",
                "--x=1"
            ]
        );
        // A program `env` would take for a setting, or a bad name, is refused.
        assert!(env_wrapped_argv("/usr/bin/env", &env, &["A=b".into()]).is_err());
        assert!(env_wrapped_argv("/usr/bin/env", &env, &[]).is_err());
        let bad = vec![("A B".to_string(), "x".to_string())];
        assert!(env_wrapped_argv("/usr/bin/env", &bad, &["app".into()]).is_err());
        let bad = vec![("1A".to_string(), "x".to_string())];
        assert!(env_wrapped_argv("/usr/bin/env", &bad, &["app".into()]).is_err());
    }

    #[test]
    fn systemd_run_gets_only_what_it_needs_to_reach_the_user_manager() {
        for secret in [
            "PSYCHE_HOME",
            "PSYCHE_NODE_SOCKET",
            "SSH_AUTH_SOCK",
            "GNOME_KEYRING_CONTROL",
        ] {
            assert!(!SYSTEMD_RUN_ENV.contains(&secret), "{secret}");
        }
    }

    #[test]
    fn memory_settings_are_validated_and_never_unlimited() {
        for ok in ["2G", "512M", "1048576", " 4G ", "50%"] {
            assert!(parse_memory(ok).is_some(), "{ok}");
        }
        for bad in [
            "",
            "G",
            "2 G",
            "2GB",
            "-1",
            "1;reboot",
            "MemoryMax=1",
            "infinity",
            "0",
            "0G",
            "101%",
        ] {
            assert!(parse_memory(bad).is_none(), "{bad}");
        }
        assert_eq!(memory_bytes("2G"), Some(2 << 30));
        assert_eq!(memory_bytes("512M"), Some(512 << 20));
        assert_eq!(memory_bytes("50%"), None);
    }

    #[test]
    fn tasks_and_cpu_settings_are_bounded() {
        assert_eq!(parse_tasks_max("2048"), Some(2048));
        for bad in ["infinity", "0", "10", "-5", "1e6", "200000"] {
            assert_eq!(parse_tasks_max(bad), None, "{bad}");
        }
        assert_eq!(parse_cpu_quota("50%"), Some(50));
        assert_eq!(parse_cpu_quota("80"), Some(80));
        for bad in ["infinity", "0%", "5%", "x", "999999%"] {
            assert_eq!(parse_cpu_quota(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_slice_gets_hard_caps_and_high_never_exceeds_max() {
        let l = SliceLimits {
            memory_high: "4G".into(),
            memory_max: "3G".into(),
            tasks_max: 2048,
            cpu_quota_percent: 200,
        };
        assert_eq!(
            l.properties(),
            [
                "MemoryHigh=3G",
                "MemoryMax=3G",
                "TasksMax=2048",
                "CPUQuota=200%"
            ]
        );
        let d = SliceLimits::defaults();
        assert!(d.properties().iter().all(|p| !p.contains("infinity")));
        assert!(d.cpu_quota_percent >= 100);
    }

    #[test]
    fn the_x_server_is_adopted_into_its_own_scope_in_the_slice() {
        let args = adopt_args(
            "psyche-vs-display-90",
            "Psyche virtual screen display",
            4242,
        );
        let tail: Vec<&str> = args.iter().map(String::as_str).skip(7).collect();
        assert_eq!(
            tail,
            [
                "psyche-vs-display-90.scope",
                "fail",
                "3",
                "PIDs",
                "au",
                "1",
                "4242",
                "Slice",
                "s",
                "psyche-vscreen.slice",
                "Description",
                "s",
                "Psyche virtual screen display",
                "0"
            ]
        );
    }
}
