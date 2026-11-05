//! Reconnect delays. Exponential with jitter, capped, like `apps/node/src/backoff.ts`, plus the
//! fixed waits the Mac helper uses for a pending pairing and a denial.

use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Backoff {
    pub initial: Duration,
    pub max: Duration,
    /// While the owner has not approved the pairing yet.
    pub pending_retry: Duration,
    /// After the Gateway refused the connection: it only changes when a Gateway restarts or the
    /// owner acts, so there is no point in hammering it.
    pub denied_retry: Duration,
    attempt: u32,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            initial: Duration::from_millis(500),
            max: Duration::from_secs(30),
            pending_retry: Duration::from_secs(5),
            denied_retry: Duration::from_secs(300),
            attempt: 0,
        }
    }
}

impl Backoff {
    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    /// Delay after one more consecutive failure. `random` is a unit-interval sample; the delay is
    /// never below a tenth of the ceiling, so retries never spin.
    pub fn next_failure(&mut self, random: f64) -> Duration {
        let ceiling = self
            .max
            .as_secs_f64()
            .min(self.initial.as_secs_f64() * 2f64.powi(self.attempt.min(30) as i32));
        self.attempt = self.attempt.saturating_add(1);
        Duration::from_secs_f64(ceiling * (0.1 + 0.9 * random.clamp(0.0, 1.0)))
    }

    /// After a connection that was served: start over.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

/// A unit-interval random sample from the OS; `0.5` if none is available.
pub fn random_unit() -> f64 {
    let mut bytes = [0u8; 4];
    match getrandom::fill(&mut bytes) {
        Ok(()) => f64::from(u32::from_le_bytes(bytes)) / f64::from(u32::MAX),
        Err(_) => 0.5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ceiling_doubles_up_to_the_cap() {
        let mut b = Backoff::default();
        let delays: Vec<f64> = (0..10).map(|_| b.next_failure(1.0).as_secs_f64()).collect();
        assert_eq!(delays[0], 0.5);
        assert_eq!(delays[1], 1.0);
        assert_eq!(delays[2], 2.0);
        assert_eq!(delays[6], 30.0);
        assert!(delays.iter().all(|d| *d <= 30.0));
    }

    #[test]
    fn jitter_is_at_least_a_tenth_of_the_ceiling() {
        let mut b = Backoff::default();
        let low = b.next_failure(0.0).as_secs_f64();
        assert!((low - 0.05).abs() < 1e-9);
        b.reset();
        let mid = b.next_failure(0.5).as_secs_f64();
        assert!((mid - 0.5 * 0.55).abs() < 1e-9);
    }

    #[test]
    fn reset_starts_over_and_huge_attempt_counts_do_not_overflow() {
        let mut b = Backoff::default();
        for _ in 0..200 {
            b.next_failure(1.0);
        }
        assert_eq!(b.next_failure(1.0).as_secs(), 30);
        b.reset();
        assert_eq!(b.attempt(), 0);
        assert_eq!(b.next_failure(1.0).as_secs_f64(), 0.5);
    }

    #[test]
    fn random_unit_is_in_range() {
        for _ in 0..100 {
            let r = random_unit();
            assert!((0.0..=1.0).contains(&r));
        }
    }
}
