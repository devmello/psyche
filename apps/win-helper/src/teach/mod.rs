//! `teach.*` (J8): the owner demonstrates a flow in a Windows app while the helper records their
//! clicks and typing, as UI Automation targets, into a skill draft. A port of the mac helper's
//! `TeachCapabilities.swift` (`TeachController`, the four capabilities, live screenshots); the
//! recording rules are in `session.rs`, the hooks in `recorder.rs`.
//!
//! Security model (as on the Mac; docs/design/teach-by-showing-2026.md): owner-only (the Gateway
//! never offers `teach.*` to the agent, and `nodes.invoke` does not reach the Host helper's
//! `teach.*`), one session at a time, refused while an agent's computer-use session holds the
//! computer, only the owner's real input (injected input is ignored), password fields and
//! off-limits apps never recorded, nothing written to disk: the draft goes back to whoever
//! started the session.
//!
//! Windows differences: when the `teach.start` invocation itself goes away (the Gateway cancels
//! it or the connection drops), the recording is cancelled instead of running on unobserved.

pub mod recorder;
pub mod session;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use self::session::{TeachInput, TeachSession, TeachStepRecord, render};
use crate::node::encoding::{b64, hex, random_bytes};
use crate::node::log::HelperLog;
use crate::node::time::iso8601;
use crate::node::{
    CapabilityError, CapabilityOutput, CapabilityRegistry, CapabilitySpec, ErrorCode, OsPermission,
    ReceiptDraft, SideEffect, schema,
};

pub type OnInput = Arc<dyn Fn(TeachInput, SystemTime) + Send + Sync>;

/// Source of owner input (live: `recorder::LiveTeachInput`; tests: a fake stream).
pub trait InputSource: Send {
    fn start(&mut self, on_input: OnInput) -> bool;
    /// Must not wait for the source's threads: it may be called from inside `on_input`.
    fn stop(&mut self);
}

/// A window screenshot after a click: (bytes, mime type), or `None` when not allowed.
pub type Screenshotter = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;
type MakeSource = Box<dyn Fn() -> Box<dyn InputSource> + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    Stop,
    Timeout,
    Limit,
    Cancel,
}

impl End {
    pub fn as_str(self) -> &'static str {
        match self {
            End::Stop => "stop",
            End::Timeout => "timeout",
            End::Limit => "limit",
            End::Cancel => "cancel",
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartParams {
    pub name: Option<String>,
    pub description: Option<String>,
    pub app: Option<String>,
    pub screenshots: Option<bool>,
    pub max_steps: Option<i64>,
    pub max_seconds: Option<i64>,
}

struct Active {
    session: Arc<TeachSession>,
    source: Option<Box<dyn InputSource>>,
    screenshots: bool,
    emit: Emit,
    waiters: Vec<oneshot::Sender<Value>>,
}

#[derive(Default)]
struct State {
    active: Option<Active>,
    /// The last few drafts, oldest first (`teach.stop` after the end stays idempotent).
    finished: VecDeque<(String, Value)>,
}

/// One teach session at a time; the draft lives in memory only.
pub struct TeachController {
    state: Mutex<State>,
    make_source: MakeSource,
    screenshot: Screenshotter,
    log: HelperLog,
    me: Weak<TeachController>,
}

const CLICK_KINDS: [&str; 3] = ["click", "double_click", "right_click"];

impl TeachController {
    pub fn new(
        make_source: impl Fn() -> Box<dyn InputSource> + Send + Sync + 'static,
        screenshot: Screenshotter,
        log: HelperLog,
    ) -> Arc<TeachController> {
        Arc::new_cyclic(|me| TeachController {
            state: Mutex::new(State::default()),
            make_source: Box::new(make_source),
            screenshot,
            log,
            me: me.clone(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn active_id(&self) -> Option<String> {
        self.lock().active.as_ref().map(|a| a.session.id.clone())
    }

    /// Starts recording and returns the session id; the draft comes from `wait`. Must run inside
    /// a Tokio runtime (the `maxSeconds` timer).
    pub fn begin(&self, p: StartParams, emit: Emit) -> Result<String, CapabilityError> {
        if let Some(n) = &p.name
            && !render::is_valid_name(n)
        {
            return Err(CapabilityError::invalid_params(
                "name must be lowercase letters, digits and single hyphens",
                Some("name"),
            ));
        }
        // The mac id: "teach-" + the first 12 characters of a lowercased UUID.
        let r = random_bytes::<4>();
        let id = format!("teach-{}-{}", hex(&r), &hex(&random_bytes::<2>())[..3]);
        let max_steps = p
            .max_steps
            .unwrap_or(TeachSession::DEFAULT_MAX_STEPS as i64)
            .clamp(1, 200) as usize;
        let session = Arc::new(TeachSession::new(
            &id,
            p.name.as_deref().unwrap_or(""),
            p.description.clone(),
            p.app.clone(),
            max_steps,
            SystemTime::now(),
        ));
        let screenshots = p.screenshots == Some(true);
        {
            let mut st = self.lock();
            if st.active.is_some() {
                return Err(CapabilityError::new(
                    ErrorCode::Conflict,
                    "teach_busy",
                    "A teach session is already recording",
                ));
            }
            st.active = Some(Active {
                session,
                source: None,
                screenshots,
                emit,
                waiters: Vec::new(),
            });
        }
        let mut source = (self.make_source)();
        let me = self.me.clone();
        let sid = id.clone();
        let started = source.start(Arc::new(move |input, at| {
            if let Some(c) = me.upgrade() {
                c.input(&sid, input, at);
            }
        }));
        if !started {
            self.lock().active = None;
            return Err(CapabilityError::permission_missing(
                OsPermission::Accessibility,
            ));
        }
        {
            let mut st = self.lock();
            match st.active.as_mut() {
                Some(a) if a.session.id == id => a.source = Some(source),
                // Ended while the hooks were starting: stop them again.
                _ => source.stop(),
            }
        }
        let seconds = p
            .max_seconds
            .unwrap_or(TeachSession::DEFAULT_MAX_SECONDS as i64)
            .clamp(10, 1800) as u64;
        let me = self.me.clone();
        let tid = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(seconds)).await;
            if let Some(c) = me.upgrade() {
                c.end(&tid, End::Timeout);
            }
        });
        self.log
            .info(format!("teach started id={id} screenshots={screenshots}"));
        Ok(id)
    }

    /// Waits until the session ends; returns its draft.
    pub async fn wait(&self, id: &str) -> Value {
        let rx = {
            let mut st = self.lock();
            if let Some((_, d)) = st.finished.iter().find(|(k, _)| k == id) {
                return d.clone();
            }
            match st.active.as_mut() {
                Some(a) if a.session.id == id => {
                    let (tx, rx) = oneshot::channel();
                    a.waiters.push(tx);
                    rx
                }
                _ => return json!({ "error": "no such session" }),
            }
        };
        rx.await
            .unwrap_or_else(|_| json!({ "error": "no such session" }))
    }

    /// Ends the session and returns the draft (also delivered to `wait`). Idempotent.
    pub fn end(&self, id: &str, how: End) -> Option<Value> {
        let ended = {
            let mut st = self.lock();
            match st.active.take() {
                Some(a) if a.session.id == id => {
                    let draft = draft(&a.session, how, SystemTime::now());
                    st.finished.push_back((id.to_owned(), draft.clone()));
                    if st.finished.len() > 8 {
                        st.finished.pop_front();
                    }
                    Some((a, draft))
                }
                other => {
                    st.active = other;
                    return st
                        .finished
                        .iter()
                        .find(|(k, _)| k == id)
                        .map(|(_, d)| d.clone());
                }
            }
        };
        let (mut a, draft) = ended?;
        if let Some(s) = a.source.as_mut() {
            s.stop();
        }
        for w in a.waiters.drain(..) {
            let _ = w.send(draft.clone());
        }
        self.log.info(format!(
            "teach ended id={id} by={} steps={}",
            how.as_str(),
            a.session.step_count()
        ));
        Some(draft)
    }

    pub fn status(&self) -> Value {
        let st = self.lock();
        match &st.active {
            None => json!({ "active": false }),
            Some(a) => json!({
                "active": true,
                "sessionId": a.session.id,
                "steps": a.session.step_count(),
                "startedAt": iso8601(a.session.started_at),
            }),
        }
    }

    fn input(&self, id: &str, input: TeachInput, at: SystemTime) {
        let (session, emit, screenshots) = {
            let st = self.lock();
            match &st.active {
                Some(a) if a.session.id == id => (a.session.clone(), a.emit.clone(), a.screenshots),
                _ => return,
            }
        };
        for step in session.handle(&input, at) {
            self.publish(&session, &emit, screenshots, step);
        }
        if session.limit_reached() {
            self.end(id, End::Limit);
        }
    }

    fn publish(
        &self,
        session: &Arc<TeachSession>,
        emit: &Emit,
        screenshots: bool,
        step: TeachStepRecord,
    ) {
        let mut json = step_json(&step);
        let event = |sid: &str, step: Value| json!({ "type": "teach.step", "sessionId": sid, "step": step });
        let app = step.target.as_ref().map(|t| t.app.clone());
        match app {
            Some(app) if screenshots && CLICK_KINDS.contains(&step.kind.as_str()) => {
                let (session, emit, shot) =
                    (session.clone(), emit.clone(), self.screenshot.clone());
                // Off the input path: the capture waits for the click's UI to settle.
                let _ = std::thread::Builder::new()
                    .name("psyche-teach-shot".into())
                    .spawn(move || {
                        crate::win::com::ensure_mta();
                        if let Some((data, mime)) = shot(&app) {
                            let path = format!(
                                "screens/step-{}.{}",
                                step.index,
                                if mime == "image/png" { "png" } else { "jpg" }
                            );
                            session.attach_screenshot(&path, step.index);
                            json["screenshot"] =
                                json!({ "path": path, "mimeType": mime, "base64": b64(&data) });
                        }
                        emit(event(&session.id, json));
                    });
            }
            _ => emit(event(&session.id, json)),
        }
    }
}

fn step_json(step: &TeachStepRecord) -> Value {
    let mut v = serde_json::to_value(step).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("screenshot");
    }
    v
}

/// The `TeachDraft`: steps without screenshot bytes, `SKILL.md` first, screenshots by path.
pub fn draft(s: &TeachSession, ended_by: End, at: SystemTime) -> Value {
    let steps = if ended_by == End::Cancel {
        Vec::new()
    } else {
        s.finish()
    };
    let apps: Vec<String> = render::app_names(&steps)
        .into_iter()
        .map(|(_, n)| n)
        .collect();
    let name = if s.name.is_empty() {
        render::default_name(&apps, s.started_at)
    } else {
        s.name.clone()
    };
    let description: String = match s.description.as_deref() {
        Some(d) if !d.is_empty() => d.to_owned(),
        _ => format!(
            "Repeat the {} flow the owner demonstrated",
            apps.first().map(String::as_str).unwrap_or("app")
        ),
    }
    .chars()
    .take(1024)
    .collect();
    let mut files = Vec::new();
    if ended_by != End::Cancel {
        files.push(json!({ "path": "SKILL.md", "text": render::skill_markdown(&name, &description, &steps, s.started_at) }));
        for step in &steps {
            if let Some(shot) = &step.screenshot {
                files.push(json!({ "path": shot, "fromStep": step.index }));
            }
        }
    }
    json!({
        "sessionId": s.id,
        "name": name,
        "description": description,
        "startedAt": iso8601(s.started_at),
        "endedAt": iso8601(at),
        "endedBy": ended_by.as_str(),
        "steps": steps.iter().map(step_json).collect::<Vec<_>>(),
        "files": files,
    })
}

/// Live screenshots: the target app's largest on-screen window, downscaled, after the click's
/// UI settled; never Psyche, terminals, password managers, finance or Off apps, and never while
/// a password field has focus.
fn live_screenshot() -> Screenshotter {
    Arc::new(|app: &str| {
        std::thread::sleep(Duration::from_millis(300));
        psyche_win_computer::app_window_image(app, 1280, 800).map(|(d, m)| (d, m.to_owned()))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    session_id: String,
}

/// Cancels the recording when the `teach.start` invocation is dropped before it finished.
struct CancelOnDrop {
    teach: Arc<TeachController>,
    id: Option<String>,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            self.teach.end(&id, End::Cancel);
        }
    }
}

pub fn register_with(reg: &mut CapabilityRegistry, teach: Arc<TeachController>) {
    let t = teach.clone();
    reg.add(
        CapabilitySpec::new(
            "teach.start",
            "Record the owner demonstrating a flow (clicks and typing as UI Automation targets, optional window screenshots) into a skill draft. Streams teach.step; returns the draft when recording ends (teach.stop, teach.cancel, maxSeconds or maxSteps). Password fields and off-limits apps are never recorded; nothing is saved.",
            SideEffect::Write,
        )
        .input(schema::object(
            vec![
                ("name", schema::string_max(None, 64)),
                ("description", schema::string_max(None, 1024)),
                ("app", schema::string(Some("Record only this app (executable name, e.g. notepad.exe)"))),
                ("screenshots", schema::boolean(None)),
                ("maxSteps", schema::integer(None, Some(1), Some(200))),
                ("maxSeconds", schema::integer(None, Some(10), Some(1800))),
            ],
            &[],
        ))
        .streaming()
        .permissions(&[OsPermission::Accessibility])
        .receipt("teach"),
        move |ctx| {
            let teach = t.clone();
            async move {
                let p: StartParams = ctx.decode()?;
                if crate::computer::session_active() {
                    return Err(CapabilityError::new(
                        ErrorCode::Conflict,
                        "computer_busy",
                        "The agent is using the computer; teach mode waits until it is done",
                    )
                    .retryable());
                }
                let c = ctx.clone();
                let id = teach.begin(p, Arc::new(move |v| c.emit(v)))?;
                let mut guard = CancelOnDrop { teach: teach.clone(), id: Some(id.clone()) };
                ctx.emit(json!({ "type": "teach.started", "sessionId": id }));
                let draft = teach.wait(&id).await;
                guard.id = None;
                let count = draft["steps"].as_array().map_or(0, Vec::len);
                Ok(CapabilityOutput::with_receipt(
                    draft,
                    ReceiptDraft::ok(format!("Recorded a demonstration ({count} steps)")),
                ))
            }
        },
    );
    let session_schema =
        || schema::object(vec![("sessionId", schema::string(None))], &["sessionId"]);
    let t = teach.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "teach.stop",
            "Stop recording and return the skill draft for review.",
            SideEffect::None,
        )
        .input(session_schema()),
        move |ctx| {
            let p: SessionParams = ctx.decode()?;
            t.end(&p.session_id, End::Stop)
                .map(CapabilityOutput::new)
                .ok_or_else(|| not_found(&p.session_id))
        },
    );
    let t = teach.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "teach.cancel",
            "Stop recording and discard everything recorded.",
            SideEffect::None,
        )
        .input(session_schema()),
        move |ctx| {
            let p: SessionParams = ctx.decode()?;
            t.end(&p.session_id, End::Cancel)
                .ok_or_else(|| not_found(&p.session_id))?;
            Ok(CapabilityOutput::new(json!({ "cancelled": true })))
        },
    );
    reg.add_blocking(
        CapabilitySpec::new(
            "teach.status",
            "Whether teach mode is recording, and how many steps so far.",
            SideEffect::Read,
        ),
        move |_| Ok(CapabilityOutput::new(teach.status())),
    );
}

fn not_found(id: &str) -> CapabilityError {
    CapabilityError::not_found("teach_not_found", format!("No teach session {id}"))
}

pub fn register(reg: &mut CapabilityRegistry) {
    let log = reg.runtime().log.clone();
    let teach = TeachController::new(
        || Box::new(recorder::LiveTeachInput::default()),
        live_screenshot(),
        log,
    );
    register_with(reg, teach);
}

#[cfg(test)]
mod tests;
