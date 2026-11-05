//! Hyper-V sockets (`AF_HYPERV`): the host side of the guest's `AF_VSOCK`. A Linux guest's
//! vsock port P is the service id `<P as 8 hex>-facb-11e6-bd58-64006a7986d3`; the host binds
//! `(VM runtime id, service id)` to accept the guest's connections and connects to the same
//! pair to reach a guest listener. The services are registered under
//! `HKLM\…\Virtualization\GuestCommunicationServices` at install.

use std::sync::Once;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use windows::Win32::Networking::WinSock::{
    AF_HYPERV, INVALID_SOCKET, SD_BOTH, SEND_RECV_FLAGS, SOCK_STREAM, SOCKADDR, SOCKET, WSADATA, WSAStartup, accept, bind, closesocket,
    connect, listen, recv, send, setsockopt, shutdown, socket,
};
use windows::Win32::System::Hypervisor::{HV_PROTOCOL_RAW, SOCKADDR_HV};
use windows::core::GUID;

use crate::conn::Conn;
use crate::error::{VmError, VmResult};

/// `HVSOCKET_CONNECT_TIMEOUT` (ms), level `HV_PROTOCOL_RAW`.
const HVSOCKET_CONNECT_TIMEOUT: i32 = 1;

/// Parses `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (braces optional).
pub fn parse_guid(s: &str) -> Option<GUID> {
    let t = s.trim().trim_start_matches('{').trim_end_matches('}');
    let parts: Vec<&str> = t.split('-').collect();
    if parts.len() != 5 || [8, 4, 4, 4, 12] != [parts[0].len(), parts[1].len(), parts[2].len(), parts[3].len(), parts[4].len()] {
        return None;
    }
    u128::from_str_radix(&parts.concat(), 16).ok().map(GUID::from_u128)
}

pub fn service_guid(port: u32) -> GUID {
    parse_guid(&crate::hcs::doc::vsock_service_id(port)).unwrap_or(GUID::zeroed())
}

fn startup() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let mut data = WSADATA::default();
        // SAFETY: initializes Winsock 2.2 once per process.
        unsafe {
            let _ = WSAStartup(0x0202, &mut data);
        }
    });
}

fn address(vm: GUID, service: GUID) -> SOCKADDR_HV {
    SOCKADDR_HV { Family: windows::Win32::Networking::WinSock::ADDRESS_FAMILY(AF_HYPERV), Reserved: 0, VmId: vm, ServiceId: service }
}

fn new_socket() -> VmResult<SOCKET> {
    startup();
    // SAFETY: plain socket creation.
    let s = unsafe { socket(AF_HYPERV as i32, SOCK_STREAM, HV_PROTOCOL_RAW as i32) }
        .map_err(|e| VmError::unavailable("hvsocket_unavailable", format!("Hyper-V sockets are unavailable: {e}")))?;
    if s == INVALID_SOCKET {
        return Err(VmError::unavailable("hvsocket_unavailable", "Hyper-V sockets are unavailable"));
    }
    Ok(s)
}

/// A connected Hyper-V socket.
pub struct HvStream {
    s: SOCKET,
    closed: AtomicBool,
}

// SAFETY: a SOCKET is usable from any thread; one reader and one writer at a time.
unsafe impl Send for HvStream {}
// SAFETY: as above.
unsafe impl Sync for HvStream {}

impl Conn for HvStream {
    fn read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
        // SAFETY: `buf` is valid for its length.
        let n = unsafe { recv(self.s, buf, SEND_RECV_FLAGS(0)) };
        if n < 0 { if self.closed.load(Ordering::SeqCst) { Ok(0) } else { Err(std::io::Error::last_os_error()) } } else { Ok(n as usize) }
    }

    fn write_all(&self, mut buf: &[u8]) -> std::io::Result<()> {
        while !buf.is_empty() {
            // SAFETY: `buf` is valid for its length.
            let n = unsafe { send(self.s, buf, SEND_RECV_FLAGS(0)) };
            if n <= 0 {
                return Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
            }
            buf = &buf[n as usize..];
        }
        Ok(())
    }

    fn shutdown(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            // SAFETY: ends both directions; a blocked recv returns.
            unsafe {
                let _ = shutdown(self.s, SD_BOTH);
            }
        }
    }
}

impl Drop for HvStream {
    fn drop(&mut self) {
        // SAFETY: closes our socket once.
        unsafe {
            let _ = closesocket(self.s);
        }
    }
}

/// Connects to `(vm, port)` with a timeout.
pub fn connect_vsock(vm: GUID, port: u32, timeout_ms: u32) -> VmResult<HvStream> {
    let s = new_socket()?;
    let t = timeout_ms.to_ne_bytes();
    // SAFETY: sets a 4-byte option on our socket.
    unsafe {
        let _ = setsockopt(s, HV_PROTOCOL_RAW as i32, HVSOCKET_CONNECT_TIMEOUT, Some(&t));
    }
    let addr = address(vm, service_guid(port));
    // SAFETY: `addr` is a SOCKADDR_HV of the size passed.
    let rc = unsafe { connect(s, &addr as *const _ as *const SOCKADDR, std::mem::size_of::<SOCKADDR_HV>() as i32) };
    if rc != 0 {
        // SAFETY: closes the socket we created.
        unsafe {
            let _ = closesocket(s);
        }
        return Err(VmError::unavailable(
            "guest_agent_unreachable",
            format!("Could not reach the guest on vsock port {port} (not listening yet?)"),
        )
        .retryable());
    }
    Ok(HvStream { s, closed: AtomicBool::new(false) })
}

/// A listener for one VM's vsock port; accepted streams go to `on_accept` on a thread.
pub struct HvListener {
    s: SOCKET,
    closed: std::sync::Arc<AtomicBool>,
    pub accepted: std::sync::Arc<AtomicUsize>,
}

// SAFETY: the socket is only closed once (Drop) after the accept thread is told to stop.
unsafe impl Send for HvListener {}
// SAFETY: as above.
unsafe impl Sync for HvListener {}

impl HvListener {
    pub fn bind(vm: GUID, port: u32, on_accept: impl Fn(HvStream) + Send + 'static) -> VmResult<HvListener> {
        let s = new_socket()?;
        let addr = address(vm, service_guid(port));
        // SAFETY: `addr` is a SOCKADDR_HV of the size passed.
        let ok =
            unsafe { bind(s, &addr as *const _ as *const SOCKADDR, std::mem::size_of::<SOCKADDR_HV>() as i32) == 0 && listen(s, 16) == 0 };
        if !ok {
            let err = std::io::Error::last_os_error();
            // SAFETY: closes the socket we created.
            unsafe {
                let _ = closesocket(s);
            }
            return Err(VmError::unavailable("hvsocket_bind", format!("Could not listen on vsock port {port}: {err}")));
        }
        let closed = std::sync::Arc::new(AtomicBool::new(false));
        let accepted = std::sync::Arc::new(AtomicUsize::new(0));
        let (c, a) = (closed.clone(), accepted.clone());
        let raw = s.0;
        std::thread::spawn(move || {
            loop {
                // SAFETY: accepts on our listening socket; fails once it is closed.
                let conn = unsafe { accept(SOCKET(raw), None, None) };
                match conn {
                    Ok(cs) if cs != INVALID_SOCKET => {
                        if c.load(Ordering::SeqCst) {
                            // SAFETY: closes a connection accepted after shutdown.
                            unsafe {
                                let _ = closesocket(cs);
                            }
                            return;
                        }
                        a.fetch_add(1, Ordering::SeqCst);
                        on_accept(HvStream { s: cs, closed: AtomicBool::new(false) });
                    }
                    _ => {
                        if c.load(Ordering::SeqCst) {
                            return;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
            }
        });
        Ok(HvListener { s, closed, accepted })
    }
}

impl Drop for HvListener {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        // SAFETY: closing the listening socket ends the blocked accept.
        unsafe {
            let _ = closesocket(self.s);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guids() {
        let g = parse_guid("00001f2c-facb-11e6-bd58-64006a7986d3").unwrap();
        assert_eq!(g, GUID::from_u128(0x00001f2c_facb_11e6_bd58_64006a7986d3));
        assert_eq!(service_guid(7980), g);
        assert_eq!(parse_guid("{e0e16197-dd56-4a10-9195-5ee7a155a838}").unwrap(), GUID::from_u128(0xe0e16197_dd56_4a10_9195_5ee7a155a838));
        assert!(parse_guid("nope").is_none());
        assert!(parse_guid("00001f2c-facb-11e6-bd58-64006a7986d").is_none());
    }

    /// Hyper-V socket loopback (`HV_GUID_LOOPBACK`): needs the service id registered under
    /// GuestCommunicationServices and usually elevation, so it is a live test.
    #[test]
    #[ignore]
    fn live_loopback_round_trip() {
        let loopback = parse_guid("e0e16197-dd56-4a10-9195-5ee7a155a838").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let _l = HvListener::bind(loopback, 7980, move |s| {
            let mut buf = [0u8; 5];
            let n = s.read(&mut buf).unwrap();
            s.write_all(&buf[..n]).unwrap();
            tx.send(()).unwrap();
        })
        .unwrap();
        let c = connect_vsock(loopback, 7980, 2000).unwrap();
        c.write_all(b"hello").unwrap();
        let mut buf = [0u8; 5];
        assert_eq!(c.read(&mut buf).unwrap(), 5);
        rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    }
}
