//! The guest control channel (mac `GuestAgent.swift`; guest side `psyche-control` in
//! `deploy/windows/guest-image`): the guest listens on vsock port 7000 (Hyper-V service
//! `00001b58-facb-11e6-bd58-64006a7986d3`; only LocalSystem may connect, per the compute
//! system's HvSocket security descriptors) and answers one NDJSON request per line, in order:
//!
//! ```text
//! → {"id": "g1", "op": "status"}
//! ← {"id": "g1", "result": {"version", "hostname", "kernel", "uptimeSeconds", "node", "session", "network", "shares"}}
//! ← {"id": "g1", "error": {"code": "invalid_params" | "not_found" | "conflict" | "internal", "message"}}
//! ```
//!
//! Ops the guest image has: `ping`, `status`, `mount {name, port, aname, readOnly, fsRoot,
//! restartNode}`, `umount {name, restartNode}`, `shares`, `restart_node`, `shutdown {reboot}`.
//! Ops the service also calls, answered `unknown op` by images that lack them (mapped to
//! `unsupported`): `export {path, transferId}` → `{bytes}` (copy one guest file into
//! `/mnt/psyche/psyche-out/<transferId>/`, for `copy_out`) and `install_psyche {payload, vsock}`
//! (run `apps/node/scripts/guest-bootstrap.sh` from the read-only payload share). The Linux guest
//! runs the agent as root, so no password travels (the mac guest needed one for sudo).

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::conn::Conn;
use crate::error::{Code, VmError, VmResult};

pub const PING: &str = "ping";
pub const STATUS: &str = "status";
pub const MOUNT: &str = "mount";
pub const UMOUNT: &str = "umount";
pub const SHARES: &str = "shares";
pub const RESTART_NODE: &str = "restart_node";
pub const SHUTDOWN: &str = "shutdown";
pub const EXPORT: &str = "export";
pub const INSTALL_PSYCHE: &str = "install_psyche";

/// Largest accepted agent line (wire `MAX_FRAME_BYTES`).
const MAX_LINE: usize = 1 << 20;

pub struct AgentClient {
    conn: std::sync::Arc<dyn Conn>,
    state: Mutex<(u64, Vec<u8>)>,
}

fn closed() -> VmError {
    VmError::unavailable("guest_agent_closed", "The guest control channel closed the connection").retryable()
}

/// `{"id", "op", ...params}` (params flattened next to the op).
pub fn request(id: &str, op: &str, params: &Value) -> Value {
    let mut o = Map::new();
    o.insert("id".into(), Value::String(id.to_owned()));
    o.insert("op".into(), Value::String(op.to_owned()));
    if let Value::Object(p) = params {
        for (k, v) in p {
            if k != "id" && k != "op" {
                o.insert(k.clone(), v.clone());
            }
        }
    }
    Value::Object(o)
}

/// A guest error as the service's: `unknown op` becomes `unsupported`.
fn guest_error(op: &str, err: &Value) -> VmError {
    let message = err["message"].as_str().unwrap_or("Guest error").to_owned();
    let code = err["code"].as_str().unwrap_or("");
    if code == "invalid_params" && message.starts_with("unknown op") {
        return VmError::unsupported(op, format!("This guest image has no `{op}` operation; update the guest image"));
    }
    let (c, reason) = match code {
        "invalid_params" => (Code::InvalidParams, "guest_invalid_params"),
        "not_found" => (Code::NotFound, "guest_not_found"),
        "conflict" => (Code::Conflict, "guest_conflict"),
        _ => (Code::Unavailable, "guest_error"),
    };
    let reason = err["details"]["reason"].as_str().unwrap_or(reason).to_owned();
    VmError::new(c, reason, message).detail("op", op)
}

impl AgentClient {
    pub fn new(conn: Box<dyn Conn>) -> AgentClient {
        AgentClient { conn: std::sync::Arc::from(conn), state: Mutex::new((0, Vec::new())) }
    }

    /// Sends `op` and waits up to `timeout` for its answer (one call at a time).
    pub fn call(&self, op: &str, params: Value, timeout: Duration) -> VmResult<Value> {
        let mut st = self.state.lock().unwrap();
        st.0 += 1;
        let id = format!("g{}", st.0);
        let mut line = serde_json::to_vec(&request(&id, op, &params)).unwrap_or_default();
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
        let result = (|| {
            loop {
                let frame = self.read_line(&mut st.1)?;
                let Ok(v) = serde_json::from_slice::<Value>(&frame) else { continue };
                if v["id"] != id.as_str() {
                    continue;
                }
                if let Some(err) = v.get("error") {
                    return Err(guest_error(op, err));
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
        })();
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = watchdog.join();
        if timed_out.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(VmError::new(Code::Timeout, "guest_agent_timeout", format!("The guest did not answer {op} in time")).retryable());
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
                return Err(VmError::unavailable("guest_agent_protocol", "The guest sent an oversized frame"));
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

/// Serves control requests on `conn` with `handle(op, request)` until it closes (the fake guest
/// in tests): `Ok(result)` or `Err({code, message})`.
pub fn serve(conn: &dyn Conn, mut handle: impl FnMut(&str, &Value) -> Result<Value, Value>) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        while let Some(i) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=i).collect();
            let Ok(req) = serde_json::from_slice::<Value>(&line) else { continue };
            let id = req["id"].clone();
            let res = match handle(req["op"].as_str().unwrap_or(""), &req) {
                Ok(r) => json!({"id": id, "result": r}),
                Err(e) => json!({"id": id, "error": e}),
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
    fn requests_flatten_params_next_to_the_op() {
        assert_eq!(
            request("g1", MOUNT, &json!({"name": "proj", "port": 564, "readOnly": true, "op": "evil"})),
            json!({"id": "g1", "op": "mount", "name": "proj", "port": 564, "readOnly": true})
        );
        assert_eq!(request("g2", PING, &Value::Null), json!({"id": "g2", "op": "ping"}));
    }

    #[test]
    fn calls_round_trip_and_map_errors() {
        let (host, guest) = MemConn::pair();
        std::thread::spawn(move || {
            serve(&guest, |op, req| match op {
                PING => Ok(json!({"pong": true})),
                UMOUNT => Err(json!({"code": "not_found", "message": "share proj is not mounted"})),
                "slow" => {
                    std::thread::sleep(Duration::from_millis(500));
                    Ok(json!({}))
                }
                MOUNT => Ok(json!({"name": req["name"], "path": "/mnt/psyche/proj", "readOnly": req["readOnly"]})),
                other => Err(json!({"code": "invalid_params", "message": format!("unknown op {other}")})),
            })
        });
        let c = AgentClient::new(Box::new(host));
        assert_eq!(c.call(PING, json!({}), Duration::from_secs(5)).unwrap(), json!({"pong": true}));
        let e = c.call(UMOUNT, json!({"name": "proj"}), Duration::from_secs(5)).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (Code::NotFound, "guest_not_found"));
        assert_eq!(c.call(MOUNT, json!({"name": "proj", "readOnly": true}), Duration::from_secs(5)).unwrap()["readOnly"], true);
        let u = c.call(EXPORT, json!({"path": "/x"}), Duration::from_secs(5)).unwrap_err();
        assert_eq!((u.reason.as_str(), u.details["feature"].as_str()), ("unsupported", Some("export")));
        let t = c.call("slow", json!({}), Duration::from_millis(100)).unwrap_err();
        assert_eq!(t.reason, "guest_agent_timeout");
        assert_eq!(c.call(PING, json!({}), Duration::from_secs(1)).unwrap_err().reason, "guest_agent_closed");
    }
}
