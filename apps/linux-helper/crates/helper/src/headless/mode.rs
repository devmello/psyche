//! Which screen the helper drives: `--display headless|desktop|auto`, or `PSYCHE_DISPLAY`, and
//! failing both, what the environment shows. A box with neither `DISPLAY` nor `WAYLAND_DISPLAY`
//! (a server, a VM, a unit under `systemd --user` with linger and nobody logged in) is headless.

use crate::paths::Env;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayMode {
    /// Decide from the environment.
    Auto,
    /// The helper's own virtual screen is the only screen.
    Headless,
    /// The owner's desktop session (direct computer use, L5).
    Desktop,
}

impl DisplayMode {
    pub fn parse(text: &str) -> Option<DisplayMode> {
        match text {
            "auto" => Some(DisplayMode::Auto),
            "headless" => Some(DisplayMode::Headless),
            "desktop" => Some(DisplayMode::Desktop),
            _ => None,
        }
    }
}

/// Takes `--display <mode>` or `--display=<mode>` out of the arguments (before the command line
/// is parsed), and says what it asked for. The last one wins. A missing or unknown value is an
/// error, not a silent default: a typo must not turn a headless box into a desktop one.
pub fn extract_flag(args: &[String]) -> Result<(Vec<String>, Option<DisplayMode>), String> {
    let mut rest = Vec::with_capacity(args.len());
    let mut mode = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let value = if arg == "--display" {
            Some(
                it.next()
                    .ok_or("--display needs a value: auto, headless or desktop")?
                    .as_str(),
            )
        } else {
            arg.strip_prefix("--display=")
        };
        match value {
            Some(v) => {
                mode =
                    Some(DisplayMode::parse(v).ok_or_else(|| {
                        format!("--display {v:?} is not auto, headless or desktop")
                    })?);
            }
            None => rest.push(arg.clone()),
        }
    }
    Ok((rest, mode))
}

/// Whether the helper runs headless: an explicit mode first (the flag, then `PSYCHE_DISPLAY`),
/// else no `DISPLAY` and no `WAYLAND_DISPLAY`. `desktop` stays `desktop` on a box with no
/// display, where direct computer use says there is no graphical session.
pub fn is_headless(flag: Option<DisplayMode>, env: &dyn Env) -> Result<bool, String> {
    let requested = match flag {
        Some(m) => m,
        None => match env.get("PSYCHE_DISPLAY") {
            Some(v) => DisplayMode::parse(v.trim())
                .ok_or_else(|| format!("PSYCHE_DISPLAY {v:?} is not auto, headless or desktop"))?,
            None => DisplayMode::Auto,
        },
    };
    Ok(match requested {
        DisplayMode::Headless => true,
        DisplayMode::Desktop => false,
        DisplayMode::Auto => {
            let set = |k: &str| env.get(k).is_some_and(|v| !v.trim().is_empty());
            !set("DISPLAY") && !set("WAYLAND_DISPLAY")
        }
    })
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

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_display_at_all_is_headless() {
        assert!(is_headless(None, &env(&[])).unwrap());
        // A user manager with linger has a runtime dir and a bus, but no display.
        assert!(is_headless(
            None,
            &env(&[
                ("XDG_RUNTIME_DIR", "/run/user/1000"),
                ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus")
            ])
        )
        .unwrap());
    }

    #[test]
    fn either_display_variable_means_a_desktop_session() {
        assert!(!is_headless(None, &env(&[("DISPLAY", ":0")])).unwrap());
        assert!(!is_headless(None, &env(&[("WAYLAND_DISPLAY", "wayland-0")])).unwrap());
    }

    #[test]
    fn an_empty_variable_is_not_a_display() {
        // `Env` for a process drops empty values; a map keeps them, so check the blank too.
        let blank = env(&[("DISPLAY", ""), ("WAYLAND_DISPLAY", " ")]);
        assert!(is_headless(None, &blank).unwrap());
    }

    #[test]
    fn an_explicit_mode_beats_the_environment() {
        let desk = env(&[("DISPLAY", ":0")]);
        assert!(is_headless(Some(DisplayMode::Headless), &desk).unwrap());
        assert!(!is_headless(Some(DisplayMode::Desktop), &env(&[])).unwrap());
        assert!(!is_headless(Some(DisplayMode::Auto), &desk).unwrap());
        // The flag beats PSYCHE_DISPLAY, which beats detection.
        let both = env(&[("DISPLAY", ":0"), ("PSYCHE_DISPLAY", "headless")]);
        assert!(is_headless(None, &both).unwrap());
        assert!(!is_headless(Some(DisplayMode::Desktop), &both).unwrap());
        assert!(is_headless(None, &env(&[("PSYCHE_DISPLAY", "bogus")])).is_err());
    }

    #[test]
    fn the_flag_is_taken_out_of_the_arguments() {
        let (rest, m) = extract_flag(&args(&["--idle", "5", "--display", "headless"])).unwrap();
        assert_eq!(rest, args(&["--idle", "5"]));
        assert_eq!(m, Some(DisplayMode::Headless));
        let (rest, m) = extract_flag(&args(&["--display=desktop", "status"])).unwrap();
        assert_eq!(rest, args(&["status"]));
        assert_eq!(m, Some(DisplayMode::Desktop));
        let (rest, m) = extract_flag(&args(&["status"])).unwrap();
        assert_eq!((rest, m), (args(&["status"]), None));
        // The last one wins.
        let (_, m) = extract_flag(&args(&["--display", "desktop", "--display=headless"])).unwrap();
        assert_eq!(m, Some(DisplayMode::Headless));
    }

    #[test]
    fn a_bad_flag_is_an_error_not_a_default() {
        assert!(extract_flag(&args(&["--display"])).is_err());
        assert!(extract_flag(&args(&["--display", "hedless"])).is_err());
        assert!(extract_flag(&args(&["--display="])).is_err());
    }
}
