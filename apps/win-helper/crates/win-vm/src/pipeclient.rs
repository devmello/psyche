//! Named pipe clients: the Gateway's guest pipe (relay target) and a compute system's serial
//! console. Opened overlapped so one thread can read while another writes (synchronous pipe
//! handles serialize I/O and would deadlock a duplex relay).

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::Foundation::{CloseHandle, ERROR_IO_PENDING, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_OVERLAPPED, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_NONE, OPEN_EXISTING, ReadFile, SECURITY_IDENTIFICATION,
    SECURITY_SQOS_PRESENT, WriteFile,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::WaitNamedPipeW;
use windows::Win32::System::Threading::CreateEventW;
use windows::core::HSTRING;

use crate::conn::Conn;
use crate::error::{VmError, VmResult};
use crate::manager::GatewayConnector;

pub struct PipeConn {
    h: HANDLE,
    closed: AtomicBool,
}

// SAFETY: overlapped I/O on one handle from two threads, each with its own OVERLAPPED.
unsafe impl Send for PipeConn {}
// SAFETY: as above.
unsafe impl Sync for PipeConn {}

struct Event(HANDLE);
impl Event {
    fn new() -> std::io::Result<Event> {
        // SAFETY: a manual-reset, unnamed event.
        unsafe { CreateEventW(None, true, false, None) }.map(Event).map_err(std::io::Error::other)
    }
}
impl Drop for Event {
    fn drop(&mut self) {
        // SAFETY: closes our event once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

impl PipeConn {
    /// Opens a pipe client (identification-level QoS: the server cannot act as us).
    pub fn open(name: &str, wait_ms: u32) -> std::io::Result<PipeConn> {
        let w = HSTRING::from(name);
        for _ in 0..3 {
            // SAFETY: plain open; the handle is owned by the result.
            let r = unsafe {
                CreateFileW(
                    &w,
                    (GENERIC_READ | GENERIC_WRITE).0,
                    FILE_SHARE_NONE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAGS_AND_ATTRIBUTES(FILE_FLAG_OVERLAPPED.0 | SECURITY_SQOS_PRESENT.0 | SECURITY_IDENTIFICATION.0),
                    None,
                )
            };
            match r {
                Ok(h) => return Ok(PipeConn { h, closed: AtomicBool::new(false) }),
                Err(e) if e.code() == ERROR_PIPE_BUSY.to_hresult() => {
                    // SAFETY: plain wait.
                    let _ = unsafe { WaitNamedPipeW(&w, wait_ms) };
                }
                Err(e) => return Err(std::io::Error::from_raw_os_error(e.code().0 & 0xFFFF)),
            }
        }
        Err(std::io::Error::from_raw_os_error(ERROR_PIPE_BUSY.0 as i32))
    }

    pub fn handle(&self) -> HANDLE {
        self.h
    }

    fn io(&self, buf: *mut u8, len: usize, write: bool) -> std::io::Result<usize> {
        if self.closed.load(Ordering::SeqCst) {
            return if write { Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe)) } else { Ok(0) };
        }
        let ev = Event::new()?;
        let mut ov = OVERLAPPED { hEvent: ev.0, ..Default::default() };
        let len = len.min(u32::MAX as usize);
        // SAFETY: `buf` is valid for `len` bytes until the operation completes below.
        let started = unsafe {
            if write {
                WriteFile(self.h, Some(std::slice::from_raw_parts(buf, len)), None, Some(&mut ov))
            } else {
                ReadFile(self.h, Some(std::slice::from_raw_parts_mut(buf, len)), None, Some(&mut ov))
            }
        };
        if let Err(e) = started
            && e.code() != ERROR_IO_PENDING.to_hresult()
        {
            return if write || !e.code().is_err() { Err(std::io::Error::other(e)) } else { Ok(0) };
        }
        let mut n = 0u32;
        // SAFETY: waits for our own operation to finish.
        match unsafe { GetOverlappedResult(self.h, &ov, &mut n, true) } {
            Ok(()) => Ok(n as usize),
            Err(_) if !write => Ok(0), // broken pipe / cancelled: end of stream
            Err(e) => Err(std::io::Error::other(e)),
        }
    }
}

impl Conn for PipeConn {
    fn read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.io(buf.as_mut_ptr(), buf.len(), false)
    }

    fn write_all(&self, mut buf: &[u8]) -> std::io::Result<()> {
        while !buf.is_empty() {
            let n = self.io(buf.as_ptr() as *mut u8, buf.len(), true)?;
            if n == 0 {
                return Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
            }
            buf = &buf[n..];
        }
        Ok(())
    }

    fn shutdown(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            // SAFETY: cancels pending I/O on our handle (both directions).
            unsafe {
                let _ = CancelIoEx(self.h, None);
            }
        }
    }
}

impl Drop for PipeConn {
    fn drop(&mut self) {
        // SAFETY: closes our handle once.
        unsafe {
            let _ = CloseHandle(self.h);
        }
    }
}

/// The Gateway's guest pipe, opened as the owner; the server process must run as the owner.
pub struct GatewayPipe {
    pub owner_sid: String,
}

impl GatewayConnector for GatewayPipe {
    fn connect(&self, home: &Path) -> VmResult<Box<dyn Conn>> {
        let pointer = std::fs::read_to_string(crate::paths::guest_socket_pointer(home)).ok();
        let name = crate::paths::guest_pipe(home, pointer.as_deref());
        let conn = PipeConn::open(&name, 2000)
            .map_err(|e| VmError::unavailable("gateway_unavailable", format!("The Gateway guest pipe is not open: {e}")).retryable())?;
        let server_sid = crate::security::pipe_server_pid(conn.handle()).and_then(crate::security::process_user_sid);
        if !server_sid.as_deref().is_some_and(|s| s.eq_ignore_ascii_case(&self.owner_sid)) {
            return Err(VmError::policy_denied("gateway_not_owner", "The guest pipe is not served by the owner's Gateway"));
        }
        Ok(Box::new(conn))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test(flavor = "multi_thread")]
    async fn duplex_overlapped_client_and_gateway_owner_check() {
        let home = std::env::temp_dir().join(format!("psyche-vm-pipe-{}", std::process::id()));
        std::fs::create_dir_all(home.join("run")).unwrap();
        let name = format!(r"\\.\pipe\psyche-guest-test-{}", std::process::id());
        std::fs::write(crate::paths::guest_socket_pointer(&home), &name).unwrap();
        let mut server = tokio::net::windows::named_pipe::ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();
        let me = crate::security::current_user_sid().unwrap();
        let h = home.clone();
        let client = tokio::task::spawn_blocking(move || GatewayPipe { owner_sid: me }.connect(&h).map(std::sync::Arc::<dyn Conn>::from));
        server.connect().await.unwrap();
        let client = client.await.unwrap().unwrap();
        // A blocked read must not stop a write on the same handle.
        let c2 = client.clone();
        let reader = std::thread::spawn(move || {
            let mut buf = [0u8; 16];
            let n = c2.read(&mut buf).unwrap();
            buf[..n].to_vec()
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        client.write_all(b"from guest").unwrap();
        let mut got = [0u8; 10];
        server.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"from guest");
        server.write_all(b"to guest").await.unwrap();
        assert_eq!(reader.join().unwrap(), b"to guest");
        client.shutdown();
        let mut buf = [0u8; 4];
        assert_eq!(client.read(&mut buf).unwrap(), 0);
        // A server run by someone else is refused.
        let other = GatewayPipe { owner_sid: "S-1-5-21-1-2-3-4".into() };
        let mut s2 = tokio::net::windows::named_pipe::ServerOptions::new().create(&name).unwrap();
        let h = home.clone();
        let c = tokio::task::spawn_blocking(move || other.connect(&h).err().map(|e| e.reason));
        let _ = s2.connect().await;
        assert_eq!(c.await.unwrap().as_deref(), Some("gateway_not_owner"));
        let _ = s2.shutdown().await;
        let _ = std::fs::remove_dir_all(home);
    }
}
