//! The guest agent channel (mac `GuestAgent.swift`), Linux edition: the guest's agent listens on
//! vsock port 7000 (Hyper-V service `00001b58-facb-11e6-bd58-64006a7986d3`; only LocalSystem
//! may connect, per the compute system's HvSocket security descriptors) and answers wire `req` /
//! `res` frames, one JSON object per line:
//!
//! ```text
//! → {"type":"req","id":"g1","method":"guest.ping","params":{}}
//! ← {"type":"res","id":"g1","ok":true,"payload":{"version":"1", …}}
//! ← {"type":"res","id":"g1","ok":false,"error":{"code":"…","message":"…","details":{"reason":"…"}}}
//! ```
//!
//! Methods: `guest.ping` → `{version, …}`; `guest.shutdown` → `{ok}` (power off);
//! `guest.mount_shares {shares: [{name, readOnly, port, guestPath}]}` → `{ok}` (mount what is
//! listed, unmount other user shares; also re-read from the `psyche-meta` share at boot);
//! `guest.export {path, transferId}` → `{bytes}` (copy one guest file into
//! `/mnt/psyche/psyche-out/<transferId>/`); `guest.install_psyche {payload}` → `{ok}` (run
//! `apps/node/scripts/guest-bootstrap.sh` from the read-only payload share). The Linux guest
//! runs the agent as root, so no password travels (the mac guest needed one for sudo).

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Value, json};

use crate::conn::Conn;
use crate::error::{Code, VmError, VmResult};

pub const PING: &str = "guest.ping";
pub const SHUTDOWN: &str = "guest.shutdown";
pub const MOUNT_SHARES: &str = "guest.mount_shares";
pub const EXPORT: &str = "guest.export";
pub const INSTALL_PSYCHE: &str = "guest.install_psyche";

/// Largest accepted agent line (wire `MAX_FRAME_BYTES`).
const MAX_LINE: usize = 1 << 20;

pub struct AgentClient {
    conn: std::sync::Arc<dyn Conn>,
    state: Mutex<(u64, Vec<u8>)>,
}

fn closed() -> VmError {
    VmError::unavailable("guest_agent_closed", "The guest agent closed the connection").retryable()
}

impl AgentClient {
    pub fn new(conn: Box<dyn Conn>) -> AgentClient {
        AgentClient { conn: std::sync::Arc::from(conn), state: Mutex::new((0, Vec::new())) }
    }

    /// Sends `method` and waits up to `timeout` for its answer (one call at a time).
    pub fn call(&self, method: &str, params: Value, timeout: Duration) -> VmResult<Value> {
        let mut st = self.state.lock().unwrap();
        st.0 += 1;
        let id = format!("g{}", st.0);
        let mut line = serde_json::to_vec(&json!({"type": "req", "id": id, "method": method, "params": params})).unwrap_or_default();
        line.push(b'\n');
        self.conn.write_all(&line).map_err(|_| closed())?;
        // A watchdog ends the read when the deadline passes (blocking reads cannot time out).
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let timed_out = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (d, t, c) = (done.clone(), timed_out.clone(), self.conn.clone());
        let watchdog = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + timeout;
            while std::time::Instant::now() < deadline {
                if d.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            if !d.load(std::sync::atomic::Ordering::SeqCst) {
                t.store(true, std::sync::atomic::Ordering::SeqCst);
                c.shutdown();
            }
        });
        let result = (|| loop {
            let frame = self.read_line(&mut st.1)?;
            let Ok(v) = serde_json::from_slice::<Value>(&frame) else { continue };
            if v["type"] != "res" || v["id"] != id.as_str() {
                continue;
            }
            if v["ok"] == true {
                return Ok(v.get("payload").cloned().unwrap_or(Value::Null));
            }
            let err = &v["error"];
            let code = match err["code"].as_str().unwrap_or("") {
                "invalid_params" => Code::InvalidParams,
                "not_found" => Code::NotFound,
                "conflict" => Code::Conflict,
                "forbidden" => Code::Forbidden,
                "policy_denied" => Code::PolicyDenied,
                "timeout" => Code::Timeout,
                _ => Code::Unavailable,
            };
            let reason = err["details"]["reason"].as_str().or(err["code"].as_str()).unwrap_or("guest_error").to_owned();
            return Err(VmError::new(code, reason, err["message"].as_str().unwrap_or("Guest error").to_owned()));
        })();
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = watchdog.join();
        if timed_out.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(
                VmError::new(Code::Timeout, "guest_agent_timeout", format!("The guest agent did not answer {method} in time")).retryable()
            );
        }
        result
    }

    fn read_line(&self, buf: &mut Vec<u8>) -> VmResult<Vec<u8>> {
        loop {
            if let Some(i) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=i).collect();
                return Ok(line[..line.len() - 1].to_vec());
            }
            if buf.len() > MAX_LINE {
                return Err(VmError::unavailable("guest_agent_protocol", "The guest agent sent an oversized frame"));
            }
            let mut chunk = [0u8; 16 * 1024];
            let n = self.conn.read(&mut chunk).map_err(|_| closed())?;
            if n == 0 {
                return Err(closed());
            }
            buf.extend_from_slice(&chunk[..n]);
        }
    }

    pub fn close(&self) {
        self.conn.shutdown();
    }
}

impl Drop for AgentClient {
    fn drop(&mut self) {
        self.conn.shutdown();
    }
}

/// Serves agent requests on `conn` with `handle` until it closes (the fake guest in tests).
pub fn serve(conn: &dyn Conn, mut handle: impl FnMut(&str, &Value) -> Result<Value, Value>) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        while let Some(i) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=i).collect();
            let Ok(req) = serde_json::from_slice::<Value>(&line) else { continue };
            let id = req["id"].clone();
            let res = match handle(req["method"].as_str().unwrap_or(""), &req["params"]) {
                Ok(p) => json!({"type": "res", "id": id, "ok": true, "payload": p}),
                Err(e) => json!({"type": "res", "id": id, "ok": false, "error": e}),
            };
            let mut out = serde_json::to_vec(&res).unwrap_or_default();
            out.push(b'\n');
            if conn.write_all(&out).is_err() {
                return;
            }
        }
        match conn.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conn::MemConn;

    #[test]
    fn calls_round_trip_and_map_errors() {
        let (host, guest) = MemConn::pair();
        std::thread::spawn(move || {
            serve(&guest, |m, p| match m {
                PING => Ok(json!({"version": "1"})),
                EXPORT => Err(json!({"code": "not_found", "message": "no such file", "details": {"reason": "guest_path_missing"}})),
                "slow" => {
                    std::thread::sleep(Duration::from_millis(500));
                    Ok(json!({}))
                }
                _ => Ok(json!({"echo": p})),
            })
        });
        let c = AgentClient::new(Box::new(host));
        assert_eq!(c.call(PING, json!({}), Duration::from_secs(5)).unwrap()["version"], "1");
        let e = c.call(EXPORT, json!({"path": "/x"}), Duration::from_secs(5)).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (Code::NotFound, "guest_path_missing"));
        assert_eq!(c.call("other", json!({"a": 1}), Duration::from_secs(5)).unwrap()["echo"]["a"], 1);
        let t = c.call("slow", json!({}), Duration::from_millis(100)).unwrap_err();
        assert_eq!(t.reason, "guest_agent_timeout");
        assert_eq!(c.call(PING, json!({}), Duration::from_secs(1)).unwrap_err().reason, "guest_agent_closed");
    }
}
