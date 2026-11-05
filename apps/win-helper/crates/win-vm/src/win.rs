//! Small Win32 helpers: OS randomness, host resources.

use std::path::Path;

use windows::Win32::Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom};
use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::core::HSTRING;

use crate::model::HostResources;

pub fn random_fill(buf: &mut [u8]) {
    // SAFETY: fills `buf` from the system RNG.
    let st = unsafe { BCryptGenRandom(None, buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    assert!(st.is_ok(), "BCryptGenRandom failed");
}

/// CPUs, physical memory and free space on the volume holding `path`.
pub fn host_resources(path: &Path) -> HostResources {
    let cpu_count = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(2);
    let mut mem = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    // SAFETY: `mem` is sized for the call.
    let memory_gb = if unsafe { GlobalMemoryStatusEx(&mut mem) }.is_ok() { (mem.ullTotalPhys >> 30) as u32 } else { 8 };
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        if !probe.pop() {
            break;
        }
    }
    let mut free = 0u64;
    // SAFETY: plain call with an out parameter.
    let _ = unsafe { GetDiskFreeSpaceExW(&HSTRING::from(probe.as_os_str()), Some(&mut free), None, None) };
    HostResources { cpu_count, memory_gb, free_disk_gb: free >> 30 }
}

#[cfg(test)]
mod tests {
    #[test]
    fn host_resources_are_plausible() {
        let h = super::host_resources(&std::env::temp_dir());
        assert!(h.cpu_count >= 1 && h.memory_gb >= 1 && h.free_disk_gb >= 1);
        let mut a = [0u8; 16];
        super::random_fill(&mut a);
        assert_ne!(a, [0u8; 16]);
    }
}
