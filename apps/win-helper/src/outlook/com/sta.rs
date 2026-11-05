//! A dedicated single-threaded-apartment thread with a message pump, for Outlook's
//! apartment-threaded object model and its events.
//!
//! Callers hand it jobs with a deadline and wait (blocking) for the answer:
//!
//! - every COM call inside a job checks the deadline (`check_deadline`);
//! - when the deadline passes while a call is still blocked in Outlook (a security prompt or
//!   another modal dialog), the caller cancels it with `CoCancelCall` and reports
//!   `outlook_not_responding`;
//! - a job that had not started by its deadline is dropped, so a write never runs after its
//!   caller gave up;
//! - a thread stuck in one job for longer than `wedged` is abandoned and a fresh one (with a
//!   fresh Outlook connection) takes the next job.
//!
//! Between jobs the thread pumps window messages (Outlook delivers `Items` events that way) and
//! gives the session an idle tick.

use std::cell::Cell;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Com::{
    COINIT_APARTMENTTHREADED, CoCancelCall, CoEnableCallCancellation, CoInitializeEx,
    CoUninitialize,
};
use windows::Win32::System::Threading::{CreateEventW, GetCurrentThreadId, SetEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MSG, MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, PM_REMOVE,
    PeekMessageW, QS_ALLINPUT, TranslateMessage,
};

use super::super::errors;
use crate::node::capability::CapabilityError;
use crate::node::log::HelperLog;

thread_local! {
    static DEADLINE: Cell<Option<Instant>> = const { Cell::new(None) };
}

/// `outlook_not_responding` once the current job's deadline passed.
pub fn check_deadline() -> Result<(), CapabilityError> {
    match DEADLINE.with(Cell::get) {
        Some(d) if Instant::now() >= d => Err(errors::timed_out()),
        _ => Ok(()),
    }
}

/// Time left in the current job (a long default outside jobs).
pub fn remaining() -> Duration {
    DEADLINE
        .with(Cell::get)
        .map_or(Duration::from_secs(60), |d| {
            d.saturating_duration_since(Instant::now())
        })
}

fn pump() {
    let mut msg = MSG::default();
    // SAFETY: standard message loop on this thread's queue.
    unsafe {
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Pumps messages for `d` (waits between retries keep the apartment responsive).
pub fn pump_for(d: Duration) {
    let end = Instant::now() + d;
    loop {
        pump();
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        // SAFETY: waits on the message queue only.
        unsafe {
            MsgWaitForMultipleObjectsEx(
                None,
                left.as_millis() as u32,
                QS_ALLINPUT,
                MWMO_INPUTAVAILABLE,
            );
        }
    }
}

/// The state a session keeps on the STA thread.
pub trait StaSession: 'static {
    /// Called between jobs, at most every second (watch liveness checks).
    fn tick(&mut self) {}
}

type Job<S> = Box<dyn FnOnce(&mut S) + Send>;

struct Envelope<S> {
    deadline: Instant,
    job: Job<S>,
}

#[derive(Clone, Copy)]
struct EventHandle(isize);

impl EventHandle {
    fn set(self) {
        // SAFETY: the event lives as long as the process (never closed).
        unsafe {
            let _ = SetEvent(HANDLE(self.0 as *mut _));
        }
    }
}

struct Worker<S> {
    tx: Sender<Envelope<S>>,
    event: EventHandle,
    thread_id: u32,
    /// When the job now running started.
    busy: Arc<Mutex<Option<Instant>>>,
}

pub struct Sta<S: StaSession> {
    name: &'static str,
    make: Arc<dyn Fn() -> S + Send + Sync>,
    worker: Mutex<Option<Arc<Worker<S>>>>,
    wedged: Duration,
    log: HelperLog,
}

/// Extra time the caller waits after the deadline for a cancelled call to come back.
const CANCEL_GRACE: Duration = Duration::from_secs(3);

impl<S: StaSession> Sta<S> {
    pub fn new(
        name: &'static str,
        make: impl Fn() -> S + Send + Sync + 'static,
        wedged: Duration,
        log: HelperLog,
    ) -> Self {
        Sta {
            name,
            make: Arc::new(make),
            worker: Mutex::new(None),
            wedged,
            log,
        }
    }

    fn spawn(&self) -> Result<Arc<Worker<S>>, CapabilityError> {
        let (tx, rx) = mpsc::channel::<Envelope<S>>();
        // SAFETY: an unnamed auto-reset event.
        let ev = unsafe { CreateEventW(None, false, false, None) }.map_err(|e| {
            CapabilityError::os("sta_unavailable", "Could not start the Outlook thread", &e)
        })?;
        let event = EventHandle(ev.0 as isize);
        let busy = Arc::new(Mutex::new(None));
        let (id_tx, id_rx) = mpsc::channel();
        let make = self.make.clone();
        let busy2 = busy.clone();
        let log = self.log.clone();
        let name = self.name;
        std::thread::Builder::new()
            .name(format!("{name}-sta"))
            .spawn(move || {
                // SAFETY: this thread's apartment, for its whole life.
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                    let _ = CoEnableCallCancellation(None);
                    let _ = id_tx.send(GetCurrentThreadId());
                }
                {
                    let mut session = make();
                    run_loop(rx, event, &busy2, &mut session);
                }
                log.info(format!("{name} sta thread ended"));
                // SAFETY: balances CoInitializeEx; every COM object was dropped with the session.
                unsafe { CoUninitialize() };
            })
            .map_err(|_| {
                CapabilityError::internal("sta_unavailable", "Could not start the Outlook thread")
            })?;
        let thread_id = id_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| {
            CapabilityError::internal("sta_unavailable", "The Outlook thread did not start")
        })?;
        Ok(Arc::new(Worker {
            tx,
            event,
            thread_id,
            busy,
        }))
    }

    /// The live worker; a fresh one when there is none or the current one is wedged.
    fn worker(&self) -> Result<Arc<Worker<S>>, CapabilityError> {
        let mut slot = self.worker.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(w) = slot.as_ref() {
            let stuck = w
                .busy
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .is_some_and(|t| t.elapsed() > self.wedged);
            if !stuck {
                return Ok(w.clone());
            }
            self.log.error(format!(
                "{} sta thread wedged; starting a new one",
                self.name
            ));
        }
        let w = self.spawn()?;
        *slot = Some(w.clone());
        Ok(w)
    }

    /// Runs `f` on the STA thread within `timeout`.
    pub fn run<R: Send + 'static>(
        &self,
        timeout: Duration,
        f: impl FnOnce(&mut S) -> Result<R, CapabilityError> + Send + 'static,
    ) -> Result<R, CapabilityError> {
        let w = self.worker()?;
        let deadline = Instant::now() + timeout;
        let (rtx, rrx) = mpsc::sync_channel::<Result<R, CapabilityError>>(1);
        let job: Job<S> = Box::new(move |s| {
            let _ = rtx.send(f(s));
        });
        if w.tx.send(Envelope { deadline, job }).is_err() {
            return Err(CapabilityError::internal(
                "sta_unavailable",
                "The Outlook thread stopped",
            ));
        }
        w.event.set();
        match rrx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(RecvTimeoutError::Disconnected) => Err(errors::timed_out()),
            Err(RecvTimeoutError::Timeout) => {
                // A call blocked in Outlook: cancel it, give it a moment to come back.
                // SAFETY: cancels the outstanding outbound call of that thread, if any.
                unsafe {
                    let _ = CoCancelCall(w.thread_id, 0);
                }
                match rrx.recv_timeout(CANCEL_GRACE) {
                    Ok(Err(e)) => Err(e),
                    // It finished just now: its answer stands.
                    Ok(Ok(v)) => Ok(v),
                    Err(_) => Err(errors::timed_out()),
                }
            }
        }
    }

    /// Queues `f` without waiting (unsubscribing from events when a watch ends).
    pub fn post(&self, timeout: Duration, f: impl FnOnce(&mut S) + Send + 'static) {
        if let Some(w) = self
            .worker
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            && w.tx
                .send(Envelope {
                    deadline: Instant::now() + timeout,
                    job: Box::new(f),
                })
                .is_ok()
        {
            w.event.set();
        }
    }
}

fn run_loop<S: StaSession>(
    rx: Receiver<Envelope<S>>,
    event: EventHandle,
    busy: &Mutex<Option<Instant>>,
    session: &mut S,
) {
    let mut last_tick = Instant::now();
    loop {
        loop {
            match rx.try_recv() {
                Ok(env) => {
                    if Instant::now() >= env.deadline {
                        // The caller gave up before this started: never run it late.
                        continue;
                    }
                    *busy.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
                    DEADLINE.with(|d| d.set(Some(env.deadline)));
                    // A panic fails this job only (its caller sees the dropped answer as a
                    // timeout); the thread keeps serving.
                    let job = env.job;
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(session)));
                    DEADLINE.with(|d| d.set(None));
                    *busy.lock().unwrap_or_else(|p| p.into_inner()) = None;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        if last_tick.elapsed() >= Duration::from_secs(1) {
            last_tick = Instant::now();
            DEADLINE.with(|d| d.set(Some(Instant::now() + Duration::from_secs(10))));
            session.tick();
            DEADLINE.with(|d| d.set(None));
        }
        let handles = [HANDLE(event.0 as *mut _)];
        // SAFETY: waits on the job event and this thread's message queue.
        unsafe {
            MsgWaitForMultipleObjectsEx(Some(&handles), 1000, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        }
        pump();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    #[derive(Default)]
    struct Counter {
        jobs: u32,
        ticks: Arc<AtomicU32>,
    }

    impl StaSession for Counter {
        fn tick(&mut self) {
            self.ticks.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn sta(wedged: Duration) -> Sta<Counter> {
        Sta::new("test", Counter::default, wedged, HelperLog::quiet())
    }

    #[test]
    fn runs_jobs_in_order_on_one_sta_thread() {
        let s = sta(Duration::from_secs(60));
        let a = s.run(Duration::from_secs(5), |c| {
            c.jobs += 1;
            Ok((c.jobs, std::thread::current().name().map(String::from)))
        });
        let b = s.run(Duration::from_secs(5), |c| {
            c.jobs += 1;
            Ok(c.jobs)
        });
        let (n, name) = a.unwrap();
        assert_eq!(n, 1);
        assert_eq!(name.as_deref(), Some("test-sta"));
        assert_eq!(b.unwrap(), 2);
        // The apartment is single-threaded.
        let apt = s.run(Duration::from_secs(5), |_| {
            use windows::Win32::System::Com::{APTTYPE, APTTYPEQUALIFIER, CoGetApartmentType};
            let (mut t, mut q) = (APTTYPE(0), APTTYPEQUALIFIER(0));
            // SAFETY: plain query.
            unsafe { CoGetApartmentType(&mut t, &mut q).ok() };
            Ok(t.0)
        });
        // APTTYPE_STA, or APTTYPE_MAINSTA for the first STA of the process.
        assert!(matches!(apt.unwrap(), 0 | 3), "single-threaded apartment");
    }

    #[test]
    fn jobs_see_their_deadline() {
        let s = sta(Duration::from_secs(60));
        let r: Result<(), _> = s.run(Duration::from_millis(300), |_| {
            std::thread::sleep(Duration::from_millis(350));
            check_deadline()
        });
        assert_eq!(r.unwrap_err().reason, "outlook_not_responding");
        assert!(s.run(Duration::from_secs(5), |_| check_deadline()).is_ok());
    }

    #[test]
    fn a_job_queued_behind_a_slow_one_is_dropped_after_its_deadline() {
        let s = Arc::new(sta(Duration::from_secs(60)));
        let ran = Arc::new(AtomicBool::new(false));
        let s2 = s.clone();
        let slow = std::thread::spawn(move || {
            s2.run(Duration::from_secs(5), |_| {
                std::thread::sleep(Duration::from_millis(400));
                Ok(())
            })
        });
        std::thread::sleep(Duration::from_millis(50));
        let ran2 = ran.clone();
        let r = s.run(Duration::from_millis(100), move |_| {
            ran2.store(true, Ordering::SeqCst);
            Ok(())
        });
        assert_eq!(
            r.unwrap_err().code,
            crate::node::capability::ErrorCode::Timeout
        );
        slow.join().unwrap().unwrap();
        // The worker is free again and the late job never ran.
        s.run(Duration::from_secs(5), |_| Ok(())).unwrap();
        assert!(
            !ran.load(Ordering::SeqCst),
            "a write must never run after its caller gave up"
        );
    }

    #[test]
    fn a_wedged_thread_is_replaced() {
        let s = Arc::new(sta(Duration::from_millis(200)));
        let s2 = s.clone();
        let stuck = std::thread::spawn(move || {
            s2.run(Duration::from_millis(100), |_| {
                std::thread::sleep(Duration::from_millis(1500));
                Ok(0)
            })
        });
        std::thread::sleep(Duration::from_millis(400));
        // A fresh thread answers at once.
        let t = Instant::now();
        assert_eq!(s.run(Duration::from_secs(2), |c| Ok(c.jobs)).unwrap(), 0);
        assert!(t.elapsed() < Duration::from_millis(1000));
        // The stuck job's own answer arrives once it finishes (within the cancel grace).
        let _ = stuck.join().unwrap();
    }

    #[test]
    fn a_panicking_job_does_not_kill_the_thread() {
        let s = sta(Duration::from_secs(60));
        let r: Result<(), _> = s.run(Duration::from_secs(5), |_| panic!("boom"));
        assert!(r.is_err());
        assert_eq!(
            s.run(Duration::from_secs(5), |c| {
                c.jobs += 1;
                Ok(c.jobs)
            })
            .unwrap(),
            1
        );
    }

    #[test]
    fn idle_ticks_run_between_jobs() {
        let ticks = Arc::new(AtomicU32::new(0));
        let t2 = ticks.clone();
        let s = Sta::new(
            "tick",
            move || Counter {
                jobs: 0,
                ticks: t2.clone(),
            },
            Duration::from_secs(60),
            HelperLog::quiet(),
        );
        s.run(Duration::from_secs(5), |_| Ok(())).unwrap();
        std::thread::sleep(Duration::from_millis(2500));
        assert!(ticks.load(Ordering::SeqCst) >= 1);
        let posted = Arc::new(AtomicBool::new(false));
        let p2 = posted.clone();
        s.post(Duration::from_secs(5), move |_| {
            p2.store(true, Ordering::SeqCst)
        });
        std::thread::sleep(Duration::from_millis(300));
        assert!(posted.load(Ordering::SeqCst));
    }
}
