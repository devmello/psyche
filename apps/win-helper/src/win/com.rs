//! COM apartment setup. Every runtime thread joins the multithreaded apartment once.

use std::cell::Cell;

use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

thread_local! {
    static MTA: Cell<bool> = const { Cell::new(false) };
}

/// Joins the MTA on this thread (idempotent; never uninitialized: the thread keeps it).
pub fn ensure_mta() {
    MTA.with(|done| {
        if !done.get() {
            // SAFETY: CoInitializeEx is safe to call on any thread; S_FALSE means already joined.
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            done.set(hr.is_ok());
        }
    });
}
