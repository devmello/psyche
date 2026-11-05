//! A small cancellation token: set once, observed by async waiters and by polling.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

#[derive(Clone, Default)]
pub struct CancelToken {
    inner: Arc<(AtomicBool, Notify)>,
}

impl std::fmt::Debug for CancelToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CancelToken({})", self.is_cancelled())
    }
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.inner.0.store(true, Ordering::SeqCst);
        self.inner.1.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.0.load(Ordering::SeqCst)
    }

    /// Resolves once `cancel()` was called (immediately if it already was).
    pub async fn cancelled(&self) {
        loop {
            let notified = self.inner.1.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn wakes_waiters_and_late_callers() {
        let t = CancelToken::new();
        let w = t.clone();
        let h = tokio::spawn(async move { w.cancelled().await });
        tokio::task::yield_now().await;
        t.cancel();
        h.await.unwrap();
        t.cancelled().await;
        assert!(t.is_cancelled());
    }
}
