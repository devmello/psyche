//! COM apartments and the UI Automation worker pool.
//!
//! UI Automation client calls are cross-process COM calls into the target app, and a misbehaving
//! app can block them. So:
//! - every UIA call runs on a pool worker thread initialized as **MTA** (UIA clients must not run
//!   in an STA that also hosts UI) and per-monitor DPI aware v2;
//! - each worker's `IUIAutomation2` has `ConnectionTimeout` 1 s (the mac helper's AX messaging
//!   timeout) and `TransactionTimeout` 3 s, so most hangs end inside UIA with `UIA_E_TIMEOUT`;
//! - the caller waits for the job with its own deadline; a job that overruns it is abandoned
//!   (`unavailable/app_not_responding`), and its worker is replaced so the pool keeps serving.
//!   UIA client objects are free-threaded in the MTA, so elements move freely between workers.

use crate::error::{CapError, CapResult};
use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

type Job = Box<dyn FnOnce() + Send + 'static>;

struct Inner {
    queue: Mutex<(VecDeque<Job>, usize, usize)>, // (jobs, workers, idle)
    cv: Condvar,
    max_workers: usize,
}

pub struct Pool {
    inner: Arc<Inner>,
}

/// Initializes the calling thread for UIA: MTA and per-monitor DPI awareness v2.
pub fn init_worker_thread() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

/// Makes the process per-monitor DPI aware v2 (a no-op when the manifest or the core already
/// chose an awareness), and the calling thread too.
pub fn ensure_dpi_awareness() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    });
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

impl Pool {
    pub fn new(max_workers: usize) -> Pool {
        Pool { inner: Arc::new(Inner { queue: Mutex::new((VecDeque::new(), 0, 0)), cv: Condvar::new(), max_workers }) }
    }

    fn spawn_worker(inner: &Arc<Inner>) {
        let inner = inner.clone();
        let _ = std::thread::Builder::new().name("psyche-uia".into()).spawn(move || {
            init_worker_thread();
            loop {
                let job = {
                    let mut q = inner.queue.lock().unwrap();
                    loop {
                        if let Some(j) = q.0.pop_front() {
                            q.2 -= 1;
                            break j;
                        }
                        q = inner.cv.wait(q).unwrap();
                    }
                };
                job();
                let mut q = inner.queue.lock().unwrap();
                q.2 += 1;
            }
        });
    }

    fn submit(&self, job: Job) {
        let mut q = self.inner.queue.lock().unwrap();
        q.0.push_back(job);
        // Workers stuck in a hung app call never come back idle: add one while under the cap.
        if q.2 < q.0.len() && q.1 < self.inner.max_workers {
            q.1 += 1;
            q.2 += 1;
            Self::spawn_worker(&self.inner);
        }
        drop(q);
        self.inner.cv.notify_one();
    }

    /// Runs `f` on a worker, waiting at most `timeout`.
    pub fn run<T: Send + 'static>(&self, timeout: Duration, f: impl FnOnce() -> CapResult<T> + Send + 'static) -> CapResult<T> {
        let (tx, rx) = mpsc::sync_channel::<CapResult<T>>(1);
        self.submit(Box::new(move || {
            let r = catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|_| Err(CapError::internal("The UI Automation worker failed")));
            let _ = tx.send(r);
        }));
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                Err(CapError::new(crate::error::code::UNAVAILABLE, "app_not_responding", "The app is not responding to UI Automation")
                    .retryable())
            }
        }
    }
}

/// The process-wide pool (up to 6 workers: hung calls are abandoned, not waited for).
pub fn pool() -> &'static Pool {
    static POOL: OnceLock<Pool> = OnceLock::new();
    POOL.get_or_init(|| Pool::new(6))
}

/// A COM interface that UIA documents as free-threaded (agile in the MTA).
pub struct Agile<T>(pub T);
// SAFETY: UI Automation client objects (IUIAutomation, elements, patterns, cache requests)
// aggregate the free-threaded marshaler and may be used from any MTA thread; every use here is on
// an MTA pool worker.
unsafe impl<T> Send for Agile<T> {}
unsafe impl<T> Sync for Agile<T> {}
impl<T: Clone> Clone for Agile<T> {
    fn clone(&self) -> Self {
        Agile(self.0.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_runs_and_times_out_without_wedging() {
        let p = Pool::new(3);
        assert_eq!(p.run(Duration::from_secs(5), || Ok(7)).unwrap(), 7);
        let e = p.run(Duration::from_millis(50), || {
            std::thread::sleep(Duration::from_millis(400));
            Ok(())
        });
        assert_eq!(e.unwrap_err().reason, "app_not_responding");
        // The pool still serves while the slow job holds a worker.
        assert_eq!(p.run(Duration::from_secs(5), || Ok(8)).unwrap(), 8);
        let e = p.run(Duration::from_secs(5), || -> CapResult<()> { panic!("boom") });
        assert_eq!(e.unwrap_err().code, "internal");
    }
}
