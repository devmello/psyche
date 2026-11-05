//! The control pipe server: one owner, DACL owner + SYSTEM, a token check on every connection,
//! requests run concurrently on blocking threads as the owner, `watch` streams events, and the
//! service stops itself when idle (no connection, no running guest, nothing busy).

use std::os::windows::io::AsRawHandle;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{NamedPipeServer, PipeMode, ServerOptions};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use windows::Win32::Foundation::HANDLE;

use crate::error::VmError;
use crate::manager::{Manager, OwnerScope};
use crate::protocol;
use crate::security::{self, SecurityDescriptor, Token};

const MAX_LINE: usize = 1 << 20;

/// The owner's most recent token, for background work (a guest exiting, a guest connection).
#[derive(Default)]
pub struct CachedOwner(Mutex<Option<Arc<Token>>>);

impl CachedOwner {
    pub fn set(&self, t: Arc<Token>) {
        *self.0.lock().unwrap() = Some(t);
    }
}

impl OwnerScope for CachedOwner {
    fn run(&self, f: &mut dyn FnMut()) {
        let t = self.0.lock().unwrap().clone();
        match t {
            Some(t) => t.scope(f),
            None => crate::log::warn("background work skipped: no owner token yet"),
        }
    }
}

/// Connection count and last activity, for the idle self-stop.
#[derive(Default)]
pub struct Activity {
    pub connections: AtomicUsize,
    last: Mutex<Option<Instant>>,
}

impl Activity {
    pub fn touch(&self) {
        *self.last.lock().unwrap() = Some(Instant::now());
    }
    pub fn idle_for(&self) -> Duration {
        self.last.lock().unwrap().map(|t| t.elapsed()).unwrap_or(Duration::MAX)
    }
}

pub struct Server {
    pub pipe_name: String,
    pub owner_sid: String,
    pub manager: Arc<Manager>,
    pub owner: Arc<CachedOwner>,
    pub activity: Arc<Activity>,
    /// Skip the process-SID half of the check (tests run client and server in one process,
    /// where it holds trivially anyway).
    pub require_impersonation: bool,
}

fn create_instance(name: &str, sd: &SecurityDescriptor, first: bool) -> std::io::Result<NamedPipeServer> {
    let mut sa = sd.attributes();
    let mut opts = ServerOptions::new();
    opts.first_pipe_instance(first)
        .reject_remote_clients(true)
        .pipe_mode(PipeMode::Byte)
        .in_buffer_size(64 * 1024)
        .out_buffer_size(64 * 1024);
    // SAFETY: `sa` (and the descriptor it points to) outlive the call.
    unsafe { opts.create_with_security_attributes_raw(name, &mut sa as *mut _ as *mut std::ffi::c_void) }
}

impl Server {
    /// Accepts connections until `stop` resolves.
    pub async fn run(self: Arc<Self>, mut stop: tokio::sync::watch::Receiver<bool>) -> std::io::Result<()> {
        let sd = SecurityDescriptor::from_sddl(&security::pipe_sddl(&self.owner_sid)).map_err(|e| std::io::Error::other(e.message))?;
        // First instance: fails if another process already owns the name (no squatting).
        let mut next = create_instance(&self.pipe_name, &sd, true)?;
        loop {
            tokio::select! {
                r = next.connect() => {
                    r?;
                    let conn = std::mem::replace(&mut next, create_instance(&self.pipe_name, &sd, false)?);
                    let me = self.clone();
                    tokio::spawn(async move { me.handle(conn).await });
                }
                _ = stop.changed() => return Ok(()),
            }
        }
    }

    fn authenticate(&self, pipe: &NamedPipeServer) -> Result<Arc<Token>, VmError> {
        let h = HANDLE(pipe.as_raw_handle());
        let token = security::pipe_client_token(h)?;
        let process_sid = security::pipe_client_pid(h).and_then(security::process_user_sid);
        let level = if self.require_impersonation { token.impersonation_level() } else { Some(2) };
        security::check_client(token.user_sid().as_deref(), process_sid.as_deref(), level, &self.owner_sid)?;
        Ok(Arc::new(token))
    }

    async fn handle(self: Arc<Self>, pipe: NamedPipeServer) {
        self.activity.connections.fetch_add(1, Ordering::SeqCst);
        self.activity.touch();
        let auth = self.authenticate(&pipe);
        let (read, mut write) = tokio::io::split(pipe);
        let token = match auth {
            Ok(t) => t,
            Err(e) => {
                crate::log::warn(&format!("control pipe: refused a client reason={}", e.reason));
                let mut line = serde_json::to_vec(&protocol::error_response(&Value::Null, &e)).unwrap_or_default();
                line.push(b'\n');
                let _ = write.write_all(&line).await;
                let _ = write.flush().await;
                self.activity.connections.fetch_sub(1, Ordering::SeqCst);
                return;
            }
        };
        self.owner.set(token.clone());
        let (tx, mut rx) = unbounded_channel::<Value>();
        let writer = tokio::spawn(async move {
            while let Some(v) = rx.recv().await {
                let mut line = serde_json::to_vec(&v).unwrap_or_default();
                line.push(b'\n');
                if write.write_all(&line).await.is_err() {
                    break;
                }
            }
        });
        let mut watch: Option<(u64, tokio::task::JoinHandle<()>)> = None;
        let mut reader = BufReader::new(read);
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = match (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line).await {
                Ok(n) => n,
                Err(_) => break,
            };
            if n == 0 || line.len() > MAX_LINE {
                break;
            }
            self.activity.touch();
            if line.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }
            let req = match protocol::parse(&line) {
                Ok(r) => r,
                Err(resp) => {
                    let _ = tx.send(resp);
                    continue;
                }
            };
            match req.method.as_str() {
                "watch" => {
                    if watch.is_none() {
                        let (id, mut events) = self.manager.events.subscribe();
                        let _ = tx.send(protocol::response(&req.id, json!({"watching": true})));
                        let m = self.manager.clone();
                        let t = token.clone();
                        let status = tokio::task::spawn_blocking(move || t.scope(|| m.status())).await.unwrap_or(Value::Null);
                        let _ = tx.send(protocol::event("vm.status", json!({"type": "vm.status", "status": status})));
                        let tx2 = tx.clone();
                        let task = tokio::spawn(async move {
                            while let Some(ev) = events.recv().await {
                                let name = ev["type"].as_str().unwrap_or("vm.updated").to_owned();
                                if tx2.send(protocol::event(&name, ev)).is_err() {
                                    break;
                                }
                            }
                        });
                        watch = Some((id, task));
                    } else {
                        let _ = tx.send(protocol::response(&req.id, json!({"watching": true})));
                    }
                }
                "unwatch" => {
                    if let Some((id, task)) = watch.take() {
                        self.manager.events.unsubscribe(id);
                        task.abort();
                    }
                    let _ = tx.send(protocol::response(&req.id, json!({"closed": true})));
                }
                _ => self.spawn_request(req, token.clone(), tx.clone()),
            }
        }
        if let Some((id, task)) = watch.take() {
            self.manager.events.unsubscribe(id);
            task.abort();
        }
        drop(tx);
        let _ = writer.await;
        self.activity.connections.fetch_sub(1, Ordering::SeqCst);
        self.activity.touch();
    }

    fn spawn_request(&self, req: protocol::Request, token: Arc<Token>, tx: UnboundedSender<Value>) {
        let m = self.manager.clone();
        let activity = self.activity.clone();
        tokio::task::spawn_blocking(move || {
            let id = req.id.clone();
            let progress = req.progress;
            let ptx = tx.clone();
            let emit = move |ev: Value| {
                if progress {
                    let _ = ptx.send(protocol::progress_event(&id, ev));
                }
            };
            let result = token.scope(|| protocol::dispatch(&m, &req.method, &req.params, &emit));
            let resp = match result {
                Ok(v) => protocol::response(&req.id, v),
                Err(e) => {
                    crate::log::info(&format!("request {} failed reason={}", req.method, e.reason));
                    protocol::error_response(&req.id, &e)
                }
            };
            let _ = tx.send(resp);
            activity.touch();
        });
    }
}

/// Resolves when the service has been idle for `idle` (checked every `tick`).
pub async fn idle_watch(manager: Arc<Manager>, activity: Arc<Activity>, idle: Duration, tick: Duration) {
    activity.touch();
    loop {
        tokio::time::sleep(tick).await;
        let quiet = activity.connections.load(Ordering::SeqCst) == 0 && !manager.any_running() && !manager.is_busy();
        if !quiet {
            activity.touch();
        } else if activity.idle_for() >= idle {
            crate::log::info("idle: no clients and no running guest; stopping");
            return;
        }
    }
}
