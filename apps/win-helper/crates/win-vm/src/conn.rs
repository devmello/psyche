//! Byte streams shared by two pump threads (a Hyper-V socket, an overlapped pipe client, or an
//! in-memory pair in tests), and the relay that joins two of them (mac `StreamRelay`).

use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

/// A duplex stream usable from two threads at once (one reading, one writing).
pub trait Conn: Send + Sync {
    /// Blocks until data arrives; `Ok(0)` at end of stream.
    fn read(&self, buf: &mut [u8]) -> io::Result<usize>;
    fn write_all(&self, buf: &[u8]) -> io::Result<()>;
    /// Ends both directions; a blocked `read` on either side returns.
    fn shutdown(&self);
}

/// In-memory duplex pair (tests and the fake backend).
pub struct MemConn {
    tx: Mutex<Option<Sender<Vec<u8>>>>,
    rx: Mutex<(Receiver<Vec<u8>>, Vec<u8>)>,
    closed: Arc<AtomicBool>,
    peer_closed: Arc<AtomicBool>,
}

impl MemConn {
    pub fn pair() -> (MemConn, MemConn) {
        let (atx, brx) = channel();
        let (btx, arx) = channel();
        let (ac, bc) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
        (
            MemConn { tx: Mutex::new(Some(atx)), rx: Mutex::new((arx, Vec::new())), closed: ac.clone(), peer_closed: bc.clone() },
            MemConn { tx: Mutex::new(Some(btx)), rx: Mutex::new((brx, Vec::new())), closed: bc, peer_closed: ac },
        )
    }
}

impl Conn for MemConn {
    fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut g = self.rx.lock().unwrap();
        loop {
            if !g.1.is_empty() {
                let n = buf.len().min(g.1.len());
                buf[..n].copy_from_slice(&g.1[..n]);
                g.1.drain(..n);
                return Ok(n);
            }
            if self.closed.load(Ordering::SeqCst) {
                return Ok(0);
            }
            match g.0.recv_timeout(std::time::Duration::from_millis(50)) {
                Ok(chunk) => g.1 = chunk,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if self.peer_closed.load(Ordering::SeqCst) {
                        // Drain what the peer sent before it closed.
                        if let Ok(chunk) = g.0.try_recv() {
                            g.1 = chunk;
                            continue;
                        }
                        return Ok(0);
                    }
                }
                Err(_) => return Ok(0),
            }
        }
    }

    fn write_all(&self, buf: &[u8]) -> io::Result<()> {
        if self.closed.load(Ordering::SeqCst) || self.peer_closed.load(Ordering::SeqCst) {
            return Err(io::Error::from(io::ErrorKind::BrokenPipe));
        }
        match self.tx.lock().unwrap().as_ref() {
            Some(tx) => tx.send(buf.to_vec()).map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe)),
            None => Err(io::Error::from(io::ErrorKind::BrokenPipe)),
        }
    }

    fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.tx.lock().unwrap().take();
    }
}

/// Bytes relayed each way.
#[derive(Default)]
pub struct RelayStats {
    pub a_to_b: AtomicU64,
    pub b_to_a: AtomicU64,
}

/// Copies bytes both ways until either side ends, then shuts both down and runs `on_close`
/// once. The Gateway still runs the full signed handshake on the relayed stream.
pub fn relay(a: Arc<dyn Conn>, b: Arc<dyn Conn>, on_close: impl FnOnce(&RelayStats) + Send + 'static) -> Arc<RelayStats> {
    let stats = Arc::new(RelayStats::default());
    let pump = |from: Arc<dyn Conn>, to: Arc<dyn Conn>, counter: Arc<RelayStats>, a_to_b: bool| {
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match from.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if to.write_all(&buf[..n]).is_err() {
                            break;
                        }
                        let c = if a_to_b { &counter.a_to_b } else { &counter.b_to_a };
                        c.fetch_add(n as u64, Ordering::Relaxed);
                    }
                }
            }
            from.shutdown();
            to.shutdown();
        })
    };
    let t1 = pump(a.clone(), b.clone(), stats.clone(), true);
    let t2 = pump(b, a, stats.clone(), false);
    let s = stats.clone();
    std::thread::spawn(move || {
        let _ = t1.join();
        let _ = t2.join();
        on_close(&s);
    });
    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_exact(c: &dyn Conn, n: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = [0u8; 64];
        while out.len() < n {
            let k = c.read(&mut buf).unwrap();
            if k == 0 {
                break;
            }
            out.extend_from_slice(&buf[..k]);
        }
        out
    }

    #[test]
    fn mem_pair_and_relay() {
        let (guest, relay_guest_side) = MemConn::pair();
        let (relay_gw_side, gateway) = MemConn::pair();
        let (done_tx, done_rx) = channel();
        let stats = relay(Arc::new(relay_guest_side), Arc::new(relay_gw_side), move |s| {
            done_tx.send((s.a_to_b.load(Ordering::SeqCst), s.b_to_a.load(Ordering::SeqCst))).unwrap();
        });
        guest.write_all(b"hello gateway").unwrap();
        assert_eq!(read_exact(&gateway, 13), b"hello gateway");
        gateway.write_all(b"hi").unwrap();
        assert_eq!(read_exact(&guest, 2), b"hi");
        guest.shutdown();
        let (ab, ba) = done_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!((ab, ba), (13, 2));
        assert_eq!(stats.a_to_b.load(Ordering::SeqCst), 13);
        let mut buf = [0u8; 4];
        assert_eq!(gateway.read(&mut buf).unwrap(), 0, "the far side sees the end");
    }
}
