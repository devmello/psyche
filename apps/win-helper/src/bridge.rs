//! Glue for capability crates that expose blocking `invoke` functions (`psyche_win_computer`,
//! `psyche_win_dictation`): run the call on the blocking pool (COM MTA) and turn the node
//! protocol's cancellation into the crate's own stop signal.
//!
//! The session aborts a handler's future when the Gateway cancels the invocation, when the
//! connection drops and when the spec's timeout fires. A blocking thread cannot be aborted, so
//! [`blocking`] runs `on_abort` when its future is dropped before the call returned: the crate
//! sees its cancellation flag and stops at its next check.

use crate::node::{CapabilityError, ErrorCode};

struct OnDrop(Option<Box<dyn FnOnce() + Send>>);

impl Drop for OnDrop {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

/// Runs `f` on the blocking pool; `on_abort` runs only when the future is dropped first.
pub async fn blocking<T, F>(
    f: F,
    on_abort: impl FnOnce() + Send + 'static,
) -> Result<T, CapabilityError>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let mut guard = OnDrop(Some(Box::new(on_abort)));
    let joined = tokio::task::spawn_blocking(move || {
        crate::win::com::ensure_mta();
        f()
    })
    .await;
    guard.0 = None;
    match joined {
        Ok(v) => Ok(v),
        Err(e) if e.is_panic() => Err(CapabilityError::new(
            ErrorCode::Internal,
            "internal",
            "The capability panicked",
        )),
        Err(_) => Err(CapabilityError::cancelled()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn aborting_trips_the_flag_and_completion_does_not() {
        let done = Arc::new(AtomicBool::new(false));
        let d = done.clone();
        let r = blocking(|| 7, move || d.store(true, Ordering::SeqCst)).await;
        assert_eq!(r.unwrap(), 7);
        assert!(!done.load(Ordering::SeqCst));

        let stop = Arc::new(AtomicBool::new(false));
        let (s1, s2) = (stop.clone(), stop.clone());
        let task = tokio::spawn(async move {
            blocking(
                move || {
                    while !s1.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                },
                move || s2.store(true, Ordering::SeqCst),
            )
            .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        task.abort();
        let _ = task.await;
        for _ in 0..100 {
            if stop.load(Ordering::SeqCst) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("on_abort did not run");
    }
}
