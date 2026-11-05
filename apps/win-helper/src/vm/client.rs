//! A client of the service's control pipe (`\\.\pipe\psyche-vm-<owner SID>`): NDJSON requests
//! `{id, method, params}`, responses `{id, result}` / `{id, error}`, and unsolicited events
//! `{event, data}` after `watch`. Parameters and results cross unchanged.
//!
//! Trust: the pipe's DACL admits only the owner and SYSTEM, and the helper refuses a server that
//! is not the service process the Service Control Manager reports (pipe server pid == service pid),
//! so a process squatting on the name never sees a request. The pipe is opened with the default
//! (impersonation) security QoS: the service refuses identification-level clients. `PSYCHE_VM_PIPE` points the client at a
//! fake service for tests and development; then the server must be a process of this same user.

use std::collections::VecDeque;
use std::io;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use windows::Win32::Foundation::{ERROR_PIPE_BUSY, HANDLE};
use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;

use super::service::{self, ServiceInfo, ServiceState, StartError};
use crate::node::capability::CapabilityError;
use crate::node::ndjson::LineBuffer;
use crate::node::paths::Env;
use crate::win::security;

/// Environment override: the control pipe of a fake service (tests, development).
pub const PIPE_OVERRIDE: &str = "PSYCHE_VM_PIPE";

/// The most a single control-pipe line may carry.
/// `SECURITY_IMPERSONATION << 16`: the service refuses identification-level clients and runs the
/// request with the owner's own rights.
const SECURITY_IMPERSONATION: u32 = 2 << 16;

const MAX_LINE: usize = 16 * 1024 * 1024;

/// How long a call waits for the service to start and its pipe to appear.
const START_WAIT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Start {
    /// Never start the service (status polling).
    Never,
    /// Start it if it is stopped.
    IfNeeded,
}

#[derive(Clone, Debug)]
pub struct Endpoint {
    sid: String,
    pipe: String,
    overridden: bool,
}

pub fn not_installed() -> CapabilityError {
    CapabilityError::unavailable(
        "vm_not_installed",
        "The sandbox PC is not turned on. Turn it on in Settings → Sandbox PC (one administrator prompt).",
    )
    .with_detail("action", "turn_on_sandbox_pc")
}

impl Endpoint {
    /// The owner's endpoint (`None` when the process's own SID cannot be read).
    pub fn resolve(env: &Env) -> Option<Endpoint> {
        let sid = security::current_user_sid()?;
        Some(match env.get(PIPE_OVERRIDE) {
            Some(p) => Endpoint {
                sid,
                pipe: p.to_owned(),
                overridden: true,
            },
            None => Endpoint {
                pipe: service::control_pipe(&sid),
                sid,
                overridden: false,
            },
        })
    }

    pub fn owner_sid(&self) -> &str {
        &self.sid
    }

    pub fn pipe(&self) -> &str {
        &self.pipe
    }

    /// The service as the SCM sees it (a fake service always "runs").
    pub fn service(&self) -> ServiceInfo {
        if self.overridden {
            return ServiceInfo {
                state: ServiceState::Running,
                pid: None,
            };
        }
        service::query(&self.sid)
    }

    /// Whether the sandbox PC's service is installed (the group is advertised only then).
    pub fn installed(&self) -> bool {
        self.service().state.installed()
    }

    /// Connects to the control pipe, starting the service first when `start` allows it.
    pub async fn connect(&self, start: Start) -> Result<Conn, CapabilityError> {
        let mut info = self.service();
        match info.state {
            ServiceState::NotInstalled => return Err(not_installed()),
            ServiceState::AccessDenied => {
                return Err(CapabilityError::unavailable(
                    "vm_service_access_denied",
                    "This Windows account may not start the sandbox PC service. Turn the sandbox PC on again in Settings → Sandbox PC.",
                ));
            }
            _ => {}
        }
        let deadline = tokio::time::Instant::now() + START_WAIT;
        let mut started = false;
        while info.state != ServiceState::Running || info.pid.is_none() && !self.overridden {
            match info.state {
                ServiceState::Stopped | ServiceState::Unknown => {
                    if start == Start::Never {
                        return Err(CapabilityError::unavailable(
                            "vm_service_stopped",
                            "The sandbox PC service is not running",
                        ));
                    }
                    if !started {
                        service::start(&self.sid).map_err(start_error)?;
                        started = true;
                    }
                }
                ServiceState::NotInstalled => return Err(not_installed()),
                ServiceState::AccessDenied => {
                    return Err(CapabilityError::unavailable(
                        "vm_service_access_denied",
                        "This Windows account may not start the sandbox PC service",
                    ));
                }
                _ => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(CapabilityError::unavailable(
                    "vm_service_timeout",
                    "The sandbox PC service did not start in time",
                )
                .retryable());
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
            info = self.service();
        }
        // Running: wait for its pipe.
        let mut busy = 0;
        let pipe = loop {
            match ClientOptions::new()
                .security_qos_flags(SECURITY_IMPERSONATION)
                .open(&self.pipe)
            {
                Ok(c) => break c,
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY.0 as i32) && busy < 40 => {
                    busy += 1;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    if tokio::time::Instant::now() >= deadline || start == Start::Never && !started
                    {
                        return Err(CapabilityError::unavailable(
                            "vm_service_unreachable",
                            "The sandbox PC service is running but its control pipe is missing",
                        )
                        .retryable());
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
                Err(e) => {
                    return Err(CapabilityError::unavailable(
                        "vm_service_unreachable",
                        format!(
                            "Could not open the sandbox PC control pipe ({:?})",
                            e.kind()
                        ),
                    ));
                }
            }
        };
        if !self.server_is_trusted(&pipe, info.pid) {
            return Err(CapabilityError::unavailable(
                "vm_service_untrusted",
                "Refusing the sandbox PC control pipe: its server is not the installed service",
            ));
        }
        Ok(Conn::new(pipe))
    }

    fn server_is_trusted(&self, pipe: &NamedPipeClient, service_pid: Option<u32>) -> bool {
        use std::os::windows::io::AsRawHandle;
        let handle = HANDLE(pipe.as_raw_handle());
        let mut pid = 0u32;
        // SAFETY: a live pipe client handle owned by `pipe`.
        if unsafe { GetNamedPipeServerProcessId(handle, &mut pid) }.is_err() || pid == 0 {
            return false;
        }
        if self.overridden {
            return security::process_user_sid(pid).as_deref() == Some(self.sid.as_str());
        }
        service_pid == Some(pid)
    }

    /// One request/response.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        start: Start,
    ) -> Result<Value, CapabilityError> {
        let mut conn = self.connect(start).await?;
        conn.request(method, params, false, &mut |_| {}).await
    }

    /// A request with `"progress": true`: the service's progress events (VM state, image checks,
    /// snapshots, imports) arrive on the same connection before the response and are forwarded
    /// through `emit` as node events.
    pub async fn call_streaming(
        &self,
        method: &str,
        params: Value,
        emit: impl Fn(Value) + Send + Sync + 'static,
    ) -> Result<Value, CapabilityError> {
        let mut conn = self.connect(Start::IfNeeded).await?;
        conn.request(method, params, true, &mut |v| emit(v)).await
    }

    /// `vm.watch`: every `vm.status` / `vm.updated` / `vm.deleted` event until the service closes
    /// the pipe (it sends the current status itself right after `watch`).
    pub async fn watch(
        &self,
        emit: impl Fn(Value) + Send + Sync,
    ) -> Result<Value, CapabilityError> {
        let mut conn = self.connect(Start::IfNeeded).await?;
        conn.send("watch", "watch", &json!({}), false)
            .await
            .map_err(io_error)?;
        loop {
            match conn.next_value().await.map_err(io_error)? {
                None => return Ok(json!({"closed": true})),
                Some(v) => {
                    if let Some(e) = event_value(&v) {
                        emit(e);
                    }
                }
            }
        }
    }
}

/// `{event, data}` → `{type: event, …data}` (a node event as the mac helper streams them).
fn event_value(v: &Value) -> Option<Value> {
    let name = v.get("event")?.as_str()?;
    // `{event: "progress", data: {id, event: {...}}}`: the inner object is the progress event.
    if name == "progress" {
        return v
            .get("data")?
            .get("event")
            .cloned()
            .filter(Value::is_object);
    }
    let mut out = serde_json::Map::new();
    out.insert("type".into(), name.into());
    if let Some(d) = v.get("data").and_then(Value::as_object) {
        for (k, val) in d {
            if k != "type" {
                out.insert(k.clone(), val.clone());
            }
        }
    }
    Some(Value::Object(out))
}

fn start_error(e: StartError) -> CapabilityError {
    match e {
        StartError::NotInstalled => not_installed(),
        StartError::Denied => CapabilityError::unavailable(
            "vm_service_access_denied",
            "This Windows account may not start the sandbox PC service. Turn the sandbox PC on again in Settings → Sandbox PC.",
        ),
        StartError::Failed(code) => CapabilityError::unavailable(
            "vm_service_start_failed",
            "Windows could not start the sandbox PC service",
        )
        .with_detail("hresult", format!("0x{:08X}", code as u32)),
    }
}

fn io_error(e: io::Error) -> CapabilityError {
    CapabilityError::unavailable(
        "vm_service_closed",
        format!(
            "The sandbox PC service closed the connection ({:?})",
            e.kind()
        ),
    )
    .retryable()
}

/// One open control pipe.
pub struct Conn {
    pipe: NamedPipeClient,
    buffer: LineBuffer,
    queued: VecDeque<Vec<u8>>,
    seq: u64,
}

impl Conn {
    pub fn new(pipe: NamedPipeClient) -> Conn {
        Conn {
            pipe,
            buffer: LineBuffer::new(MAX_LINE),
            queued: VecDeque::new(),
            seq: 0,
        }
    }

    pub async fn send(
        &mut self,
        id: &str,
        method: &str,
        params: &Value,
        progress: bool,
    ) -> io::Result<()> {
        let mut body = json!({"id": id, "method": method, "params": params});
        if progress {
            body["progress"] = true.into();
        }
        let mut line =
            serde_json::to_vec(&body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        line.push(b'\n');
        self.pipe.write_all(&line).await?;
        self.pipe.flush().await
    }

    /// The next JSON line; `None` at end of stream.
    pub async fn next_value(&mut self) -> io::Result<Option<Value>> {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            while let Some(line) = self.queued.pop_front() {
                if let Ok(v) = serde_json::from_slice::<Value>(&line) {
                    return Ok(Some(v));
                }
            }
            let n = match self.pipe.read(&mut chunk).await {
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::BrokenPipe => 0,
                Err(e) => return Err(e),
            };
            if n == 0 {
                return Ok(None);
            }
            let lines = self
                .buffer
                .append(&chunk[..n])
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            self.queued.extend(lines);
        }
    }

    /// Sends one request and waits for its response; events that arrive meanwhile go to
    /// `on_event`.
    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
        progress: bool,
        on_event: &mut (dyn FnMut(Value) + Send),
    ) -> Result<Value, CapabilityError> {
        self.seq += 1;
        let id = format!("h{}", self.seq);
        self.send(&id, method, &params, progress)
            .await
            .map_err(io_error)?;
        loop {
            let Some(v) = self.next_value().await.map_err(io_error)? else {
                return Err(io_error(io::ErrorKind::UnexpectedEof.into()));
            };
            if v.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                    return Err(CapabilityError::from_wire(err));
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
            if let Some(e) = event_value(&v) {
                on_event(e);
            }
        }
    }
}
