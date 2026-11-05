//! One helper per `$PSYCHE_HOME` (packaging contract): a named mutex
//! `Local\psyche-helper-<home hash>`. The kernel drops it with the process, so a crash never
//! leaves it stale.

use std::path::Path;

use windows::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, HANDLE};
use windows::Win32::System::Threading::CreateMutexW;
use windows::core::HSTRING;

use super::paths::home_hash;

pub struct SingleInstanceLock {
    handle: HANDLE,
}

// SAFETY: a mutex handle may be used and closed from any thread.
unsafe impl Send for SingleInstanceLock {}
unsafe impl Sync for SingleInstanceLock {}

impl SingleInstanceLock {
    pub fn name(home: &Path) -> String {
        format!(r"Local\psyche-helper-{}", home_hash(home))
    }

    /// Takes the lock, or `None` when another process holds it.
    pub fn acquire(home: &Path) -> Option<SingleInstanceLock> {
        let name = HSTRING::from(Self::name(home));
        // SAFETY: plain Win32 calls; the handle is closed on the failure path and in Drop.
        unsafe {
            let handle = CreateMutexW(None, true, &name).ok()?;
            if GetLastError() == ERROR_ALREADY_EXISTS {
                let _ = CloseHandle(handle);
                return None;
            }
            Some(SingleInstanceLock { handle })
        }
    }
}

impl Drop for SingleInstanceLock {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by this lock.
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_fails_until_release() {
        let home = std::env::temp_dir().join(format!("psyche-lock-{}", std::process::id()));
        let first = SingleInstanceLock::acquire(&home).expect("first");
        assert!(SingleInstanceLock::acquire(&home).is_none());
        drop(first);
        assert!(SingleInstanceLock::acquire(&home).is_some());
    }
}
