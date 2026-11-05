//! Idle exit (linux-desktop design §4.4). The helper runs on demand, so it exits after a quiet
//! period instead of sitting in memory: psyched starts it again when computer use begins.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The default quiet period: 5 minutes with no invocation.
pub const DEFAULT_IDLE: Duration = Duration::from_secs(300);

#[derive(Debug)]
pub struct IdleTimer {
    /// `None`: never exit for idleness (`--idle-timeout 0`, or a service manager that owns the
    /// lifetime).
    timeout: Option<Duration>,
    last_activity: Mutex<Instant>,
}

impl IdleTimer {
    pub fn new(timeout: Option<Duration>) -> Self {
        Self {
            timeout,
            last_activity: Mutex::new(Instant::now()),
        }
    }

    pub fn touch(&self) {
        self.touch_at(Instant::now());
    }

    pub fn touch_at(&self, at: Instant) {
        *self.last_activity.lock().unwrap_or_else(|e| e.into_inner()) = at;
    }

    /// Whether the quiet period has run out at `now`. Work in flight is never idle.
    pub fn expired_at(&self, now: Instant, in_flight: usize) -> bool {
        let Some(timeout) = self.timeout else {
            return false;
        };
        if in_flight > 0 {
            return false;
        }
        let last = *self.last_activity.lock().unwrap_or_else(|e| e.into_inner());
        now.saturating_duration_since(last) >= timeout
    }

    pub fn expired(&self, in_flight: usize) -> bool {
        self.expired_at(Instant::now(), in_flight)
    }
}

/// Parses `--idle-timeout` / `PSYCHE_HELPER_IDLE_SECS`: whole seconds, `0` means never.
pub fn parse_idle_seconds(text: &str) -> Option<Option<Duration>> {
    let secs: u64 = text.trim().parse().ok()?;
    Some((secs > 0).then(|| Duration::from_secs(secs)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expires_only_after_the_quiet_period() {
        let timer = IdleTimer::new(Some(Duration::from_secs(10)));
        let t0 = Instant::now();
        timer.touch_at(t0);
        assert!(!timer.expired_at(t0 + Duration::from_secs(9), 0));
        assert!(timer.expired_at(t0 + Duration::from_secs(10), 0));
    }

    #[test]
    fn activity_resets_the_clock_and_work_in_flight_is_never_idle() {
        let timer = IdleTimer::new(Some(Duration::from_secs(10)));
        let t0 = Instant::now();
        timer.touch_at(t0);
        timer.touch_at(t0 + Duration::from_secs(8));
        assert!(!timer.expired_at(t0 + Duration::from_secs(15), 0));
        assert!(!timer.expired_at(t0 + Duration::from_secs(600), 1));
    }

    #[test]
    fn no_timeout_never_expires() {
        let timer = IdleTimer::new(None);
        assert!(!timer.expired_at(Instant::now() + Duration::from_secs(86_400), 0));
    }

    #[test]
    fn parses_seconds_with_zero_meaning_never() {
        assert_eq!(
            parse_idle_seconds("30"),
            Some(Some(Duration::from_secs(30)))
        );
        assert_eq!(parse_idle_seconds(" 0 "), Some(None));
        assert_eq!(parse_idle_seconds("abc"), None);
        assert_eq!(parse_idle_seconds("-1"), None);
    }
}
