//! The capabilities: ports of the mac helper's `ComputerCapabilities.swift`,
//! `Screenshots.swift` and `ScreenAskCapabilities.swift`, with the same checks in the same order
//! (session → app → tier / approval binding → UIPI → expectation → risky label → act → verify)
//! and the same result shapes.

use crate::error::{code, CapError, CapResult};
use crate::hygiene::{self, screen_ask, AppRef};
use crate::keychord::{send_keys, KeyChord, Mods};
use crate::snapshot::{
    text, Expectation, HeaderIdentity, RefTable, Resolution, Selector, Snapshot, SnapshotBuilder, SnapshotNode, SnapshotOptions,
};
use crate::tiers::{fixed_caps, risk_labels, ApprovalBinding, Intent, SessionLock, StopSignal, TierPolicy, TierSettings};
use crate::win::apps::{self, TargetApp};
use crate::win::uia::{self, Node, Resolved, Uia};
use crate::win::{capture, com, hooks, input, menu};
use base64::Engine as _;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

// MARK: - Receipts and outputs

/// The node-side half of a `Receipt` (mac `ReceiptDraft`).
#[derive(Debug, Clone, PartialEq)]
pub struct ReceiptDraft {
    /// `ok` | `failed` | `uncertain`.
    pub outcome: &'static str,
    pub summary: String,
    pub external_refs: Map<String, Value>,
}

impl ReceiptDraft {
    pub fn to_json(&self) -> Value {
        json!({"outcome": self.outcome, "summary": self.summary, "externalRefs": self.external_refs})
    }
}

/// What a capability returns: the result, plus a receipt draft for side-effecting calls.
#[derive(Debug, Clone, PartialEq)]
pub struct CapOutput {
    pub result: Value,
    pub receipt: Option<ReceiptDraft>,
}

impl CapOutput {
    fn plain(result: Value) -> CapOutput {
        CapOutput { result, receipt: None }
    }
}

/// Per-invocation context: the Gateway's `approvalId` and the node protocol's cancellation.
#[derive(Default, Clone)]
pub struct Invocation {
    pub approval_id: Option<String>,
    pub cancel: Option<Arc<AtomicBool>>,
}

/// What one mutating call did (spike 04 action ladder outcomes).
struct Outcome {
    status: &'static str, // ok | unverified | ineffective
    method: &'static str, // ax | sendinput | menu
    detail: Option<String>,
    ref_: Option<String>,
    app: TargetApp,
}

impl Outcome {
    fn new(status: &'static str, method: &'static str, detail: Option<String>, ref_: Option<String>, app: &TargetApp) -> Outcome {
        Outcome { status, method, detail, ref_, app: app.clone() }
    }

    fn output(self, verb: &str) -> CapOutput {
        let mut o = Map::new();
        o.insert("status".into(), json!(self.status));
        o.insert("method".into(), json!(self.method));
        o.insert("app".into(), json!(self.app.id()));
        if let Some(d) = &self.detail {
            o.insert("detail".into(), json!(d));
        }
        if let Some(r) = &self.ref_ {
            o.insert("ref".into(), json!(r));
        }
        let outcome = match self.status {
            "ok" => "ok",
            "ineffective" => "failed",
            _ => "uncertain",
        };
        let mut refs = Map::new();
        refs.insert("app".into(), json!(self.app.id()));
        refs.insert("method".into(), json!(self.method));
        if let Some(r) = &self.ref_ {
            refs.insert("ref".into(), json!(r));
        }
        CapOutput {
            result: Value::Object(o),
            receipt: Some(ReceiptDraft { outcome, summary: format!("{verb} in {}: {}", self.app.name, self.status), external_refs: refs }),
        }
    }
}

// MARK: - Shared state

/// The AX state: one ref table for the helper's lifetime (refs are server-side handles, spike 04
/// rule 1), the last snapshot's nodes for selectors, and the options it used.
struct Engine {
    refs: Mutex<RefTable<Node>>,
    last: Mutex<(Vec<SnapshotNode>, SnapshotOptions)>,
    primed: Mutex<HashSet<u32>>,
}

type UserStopFn = Box<dyn Fn(Option<String>) + Send + Sync>;

/// Shared state for computer use: engine, tier policy, session lock and Esc stop.
pub struct ComputerUse {
    pub policy: TierPolicy,
    pub sessions: SessionLock,
    pub stop: StopSignal,
    engine: Engine,
    settings_path: PathBuf,
    on_user_stop: Mutex<Option<UserStopFn>>,
}

static CU: OnceLock<ComputerUse> = OnceLock::new();

/// The process-wide computer-use state (created on first use).
pub fn cu() -> &'static ComputerUse {
    CU.get_or_init(|| {
        let settings_path = TierSettings::path();
        ComputerUse {
            policy: TierPolicy::new(TierSettings::load(&settings_path), None, Some(Box::new(hooks::last_owner_input))),
            sessions: SessionLock::new(120.0, None),
            stop: StopSignal::new(),
            engine: Engine {
                refs: Mutex::new(RefTable::default()),
                last: Mutex::new((Vec::new(), SnapshotOptions::default())),
                primed: Mutex::new(HashSet::new()),
            },
            settings_path,
            on_user_stop: Mutex::new(None),
        }
    })
}

impl ComputerUse {
    /// Notified (on a helper thread) when the user presses Esc during a session, with the
    /// stopped session id.
    pub fn set_on_user_stop(&self, f: impl Fn(Option<String>) + Send + Sync + 'static) {
        *self.on_user_stop.lock().unwrap() = Some(Box::new(f));
    }

    /// Installs the Esc and attention hooks (retried on each computer-use call until they run).
    pub fn ensure_esc_tap(&self) {
        if hooks::is_running() {
            return;
        }
        hooks::start(
            Box::new(|| cu().sessions.active_session().is_some()),
            Box::new(|| cu().stop.trip()),
            Box::new(|| {
                let c = cu();
                let stopped = c.sessions.stop_active();
                if let Some(f) = c.on_user_stop.lock().unwrap().as_ref() {
                    f(stopped);
                }
            }),
        );
    }

    pub fn reload_settings(&self) {
        self.policy.update(TierSettings::load(&self.settings_path));
    }

    /// Session lock for one mutating call. The Gateway must name the session (the run id).
    fn begin_action(&self, session: Option<&str>) -> CapResult<()> {
        match session {
            Some(s) if !s.is_empty() && s.chars().count() <= 128 => {
                self.ensure_esc_tap();
                self.reload_settings();
                apps::check_desktop()?;
                self.sessions.acquire(s)
            }
            _ => Err(CapError::invalid_params("session (the run id) is required for computer actions", Some("session"))),
        }
    }
}

const UIA_TIMEOUT: Duration = Duration::from_secs(10);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);
const SNAPSHOT_BUDGET: Duration = Duration::from_secs(12);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(20);

/// Runs `f` on a UIA worker with this thread's automation context.
fn run<T: Send + 'static>(timeout: Duration, f: impl FnOnce(&Uia) -> CapResult<T> + Send + 'static) -> CapResult<T> {
    com::pool().run(timeout, move || {
        let u = uia::uia()?;
        f(&u)
    })
}

fn decode<T: DeserializeOwned>(params: &Value) -> CapResult<T> {
    let v = if params.is_null() { Value::Object(Map::new()) } else { params.clone() };
    serde_json::from_value(v).map_err(|e| {
        let msg = e.to_string();
        if let Some(rest) = msg.strip_prefix("missing field `") {
            let field = rest.split('`').next().unwrap_or("");
            return CapError::invalid_params(format!("missing parameter {field}"), Some(field));
        }
        CapError::invalid_params("a parameter has the wrong type or is invalid", None)
    })
}

fn binding(inv: &Invocation, params: &Value) -> Option<ApprovalBinding> {
    ApprovalBinding::from(inv.approval_id.as_deref(), params)
}

// MARK: - Engine operations (on UIA workers)

fn engine() -> &'static Engine {
    &cu().engine
}

fn resolve_on(u: &Uia, r: &str) -> CapResult<Resolved> {
    let node = engine().refs.lock().unwrap().element(r).ok_or_else(|| {
        CapError::new(
            code::NOT_FOUND,
            "unknown_ref",
            format!("Unknown ref {r}. Take a new snapshot with computer.ax_tree; refs are never reused."),
        )
        .detail("ref", r)
    })?;
    let (node, root_hwnd, app_pid) = match &node {
        Node::App { pid, .. } => (node.clone(), 0, *pid),
        Node::El(el) => {
            let fresh = uia::refresh(u, el).map_err(|e| {
                let name = apps::app_for_pid(el.app_pid, None).map(|a| a.name).unwrap_or_else(|| "The app".into());
                uia::map_read_error(&e, r, &name)
            })?;
            (Node::El(fresh), el.root_hwnd, el.app_pid)
        }
    };
    let c = uia::compute(&node, true).ok_or_else(|| uia::stale(r))?;
    let host = apps::window_info(root_hwnd).filter(|w| w.owner_pid != w.pid).map(|w| w.owner_pid);
    let app = apps::app_for_pid(app_pid, host).ok_or_else(|| uia::stale(r))?;
    if matches!(node, Node::El(_)) && c.pid != 0 && !app.owns(c.pid) {
        return Err(uia::stale(r));
    }
    let options = engine().last.lock().unwrap().1.clone();
    let source = uia::LiveSource::new(u, None, false);
    let mut scratch = RefTable::default();
    let label = SnapshotBuilder::new(&source, &mut scratch, options, None).label_for(&node);
    Ok(Resolved {
        role_name: text::role_name(&c.info.role, c.info.subrole.as_deref()),
        label,
        info: c.info.clone(),
        facts: c.facts.clone(),
        node,
        ref_: r.to_string(),
        app,
        root_hwnd,
    })
}

fn element_for(r: &str) -> CapResult<Resolved> {
    let r = r.to_string();
    run(UIA_TIMEOUT, move |u| resolve_on(u, &r))
}

fn resolve_selector(sel: &Selector) -> CapResult<String> {
    let last = engine().last.lock().unwrap();
    match sel.resolve(&last.0) {
        Resolution::Ref(r) => Ok(r),
        Resolution::None => {
            Err(CapError::new(code::NOT_FOUND, "selector_no_match", "No element in the last snapshot matches the selector exactly"))
        }
        Resolution::Ambiguous(refs) => {
            Err(CapError::new(code::CONFLICT, "selector_ambiguous", "The selector matches several elements; use a ref")
                .detail("candidates", json!(refs)))
        }
    }
}

struct SnapshotRequest {
    app: TargetApp,
    window: Option<usize>,
    root: Option<String>,
    options: SnapshotOptions,
}

fn snapshot_on(u: &Uia, req: SnapshotRequest) -> CapResult<Snapshot> {
    let app = &req.app;
    apps::check_uipi(app)?;
    let windows = apps::app_windows(app);
    let no_window =
        || CapError::new(code::NOT_FOUND, "no_window", format!("{} has no open window. Use root: \"app\" for menus and popups.", app.name));
    let (root, root_hwnd) = match req.root.as_deref() {
        None | Some("window") => {
            let w = match req.window {
                Some(i) => windows.get(i).cloned().ok_or_else(no_window)?,
                None => apps::foreground_window()
                    .filter(|f| f.pid == app.pid)
                    .or_else(|| windows.iter().find(|w| w.layer() == 0).cloned())
                    .or_else(|| windows.first().cloned())
                    .ok_or_else(no_window)?,
            };
            let node = uia::element_for_window(u, w.hwnd, app.pid).map_err(|e| match uia::hr(&e) {
                uia::E_TIMEOUT => uia::not_responding(&app.name),
                _ => no_window(),
            })?;
            (node, w.hwnd)
        }
        Some("app") => (
            Node::App { pid: app.pid, name: app.name.clone(), windows: windows.iter().map(|w| w.hwnd).collect() },
            windows.first().map(|w| w.hwnd).unwrap_or(0),
        ),
        Some(r) => {
            let el = resolve_on(u, r)?;
            // A ref from another app must not bypass that app's tier.
            if el.app.pid != app.pid {
                return Err(CapError::new(
                    code::INVALID_PARAMS,
                    "ref_other_app",
                    format!("{r} belongs to {}, not {}", el.app.name, app.name),
                ));
            }
            (el.node, el.root_hwnd)
        }
    };
    if app.electron && engine().primed.lock().unwrap().insert(app.pid) {
        // Chromium builds its UIA tree lazily after the first client attaches.
        uia::wait_for_web_area(u, &root, Duration::from_secs(3));
    }
    let focused = unsafe { u.auto.GetFocusedElementBuildCache(&u.req_element) }.ok().and_then(|f| {
        let n = uia::node_for(f, None, false, app.pid, root_hwnd);
        let pid = uia::compute(&n, false)?.pid;
        app.owns(pid).then_some(n)
    });
    let source = uia::LiveSource::new(u, Some(Instant::now() + SNAPSHOT_BUDGET), req.options.clip);
    let snap = {
        let mut refs = engine().refs.lock().unwrap();
        SnapshotBuilder::new(&source, &mut refs, req.options.clone(), focused).snapshot(
            &root,
            HeaderIdentity { app: &app.name, pid: app.pid, bundle_id: app.bundle_id.as_deref(), electron: app.electron },
            &[],
        )
    };
    *engine().last.lock().unwrap() = (snap.nodes.clone(), req.options);
    Ok(snap)
}

// MARK: - Shared checks

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct TargetParams {
    #[serde(rename = "ref")]
    ref_: Option<String>,
    selector: Option<Selector>,
    x: Option<f64>,
    y: Option<f64>,
    expect: Option<Expectation>,
    session: Option<String>,
    app: Option<String>,
}

/// Resolves the target element, checks the session, tier, UIPI, expectation and risk.
fn element(
    c: &ComputerUse,
    inv: &Invocation,
    params: &Value,
    t: &TargetParams,
    intent: Intent,
    custom: Option<&str>,
) -> CapResult<Resolved> {
    c.begin_action(t.session.as_deref())?;
    let r = match (&t.ref_, &t.selector) {
        (Some(r), _) => r.clone(),
        (None, Some(sel)) => resolve_selector(sel)?,
        _ => return Err(CapError::invalid_params("ref or selector is required", Some("ref"))),
    };
    let el = element_for(&r)?;
    // A click or press on a menu-like element runs an app command (#266).
    let intent = intent.escalated(Some(&el.info.role));
    c.policy.authorize(intent, el.app.bundle_id.as_deref(), &el.app.name, binding(inv, params).as_ref())?;
    apps::check_uipi(&el.app)?;
    let expect = t
        .expect
        .as_ref()
        .ok_or_else(|| CapError::invalid_params("expect {role, label} from the snapshot is required with a ref", Some("expect")))?;
    let el2 = el.clone();
    let value = run(UIA_TIMEOUT, move |u| Ok(uia::current_value(u, &el2)))?;
    if let Some(why) = expect.mismatch(&el.role_name, el.label.as_deref(), if el.info.is_secure() { None } else { value.as_deref() }) {
        return Err(CapError::new(code::CONFLICT, "expectation_failed", format!("{r} changed: {why}. Take a new snapshot."))
            .detail("ref", r.as_str())
            .detail("role", el.role_name.as_str())
            .detail("label", el.label.clone().map(Value::String).unwrap_or(Value::Null)));
    }
    if intent != Intent::Read && binding(inv, params).is_none() && risk_labels::is_risky(el.label.as_deref(), custom) {
        return Err(CapError::new(
            code::APPROVAL_REQUIRED,
            "risky_label",
            "This control may delete, send or create data; this action needs approval.",
        )
        .detail("label", el.label.clone().or(custom.map(str::to_string)).unwrap_or_default())
        .detail("app", el.app.id()));
    }
    Ok(el)
}

fn same_app(named: &str, app: &TargetApp) -> bool {
    let n = named.to_lowercase();
    match app.bundle_id.as_deref() {
        Some(id) => id == n || id == format!("{n}.exe"),
        None => false,
    }
}

/// Point target: authorizes the app under the point. Returns (x, y, app, window).
fn point(c: &ComputerUse, inv: &Invocation, params: &Value, t: &TargetParams, intent: Intent) -> CapResult<(f64, f64, TargetApp, isize)> {
    c.begin_action(t.session.as_deref())?;
    let (Some(x), Some(y)) = (t.x.filter(|v| v.is_finite()), t.y.filter(|v| v.is_finite())) else {
        return Err(CapError::invalid_params("ref, selector or x/y is required", Some("ref")));
    };
    let win = apps::window_at(x, y)
        .ok_or_else(|| CapError::new(code::NOT_FOUND, "nothing_at_point", format!("No app owns the point {},{}", x as i64, y as i64)))?;
    let app = apps::app_for_window(&win)
        .ok_or_else(|| CapError::new(code::NOT_FOUND, "nothing_at_point", format!("No app owns the point {},{}", x as i64, y as i64)))?;
    // The point must land in the app the call (and its approval) named (#267).
    let named = t
        .app
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CapError::invalid_params("app (the executable name the point is in) is required with x/y", Some("app")))?;
    if !same_app(named, &app) {
        return Err(CapError::new(code::POLICY_DENIED, "app_mismatch", format!("The point is in {}, not {named}", app.name))
            .detail("app", named)
            .detail("appAtPoint", app.id()));
    }
    let role = run(UIA_TIMEOUT, move |u| Ok(uia::hit_test(u, x, y).and_then(|h| h.role)))?;
    let intent = intent.escalated(role.as_deref());
    c.policy.authorize(intent, app.bundle_id.as_deref(), &app.name, binding(inv, params).as_ref())?;
    apps::check_uipi(&app)?;
    Ok((x, y, app, win.hwnd))
}

/// Keyboard input goes only to `app`'s own focused element.
fn ensure_keyboard_target(app: &TargetApp) -> CapResult<()> {
    let front = apps::is_frontmost(app);
    let focus = apps::keyboard_focus_pid();
    if !front || focus.map(|p| !app.owns(p)).unwrap_or(false) {
        return Err(
            CapError::new(code::CONFLICT, "focus_moved", format!("Keyboard focus is no longer in {}; input stopped", app.name)).retryable()
        );
    }
    Ok(())
}

fn keyboard_focus_secure() -> CapResult<bool> {
    run(Duration::from_secs(3), |u| Ok(uia::keyboard_focus(u).1))
}

/// Hit-tests a point before synthetic mouse input: it must land in `app` (and, for a ref, on that
/// element or inside it), and on nothing secure or risky without approval.
fn check_hit(x: f64, y: f64, app: &TargetApp, el: Option<&Resolved>, approval_id: Option<&str>) -> CapResult<()> {
    let app2 = app.clone();
    let el2 = el.cloned();
    let approved = approval_id.is_some();
    run(UIA_TIMEOUT, move |u| {
        let hit = uia::hit_test(u, x, y)
            .ok_or_else(|| CapError::new(code::CONFLICT, "hit_test_failed", format!("Nothing to click at {},{}", x as i64, y as i64)))?;
        if hit.pid != app2.pid {
            return Err(CapError::new(
                code::CONFLICT,
                "occluded",
                format!("Another window covers the target at {},{}; bring {} forward and re-snapshot", x as i64, y as i64, app2.name),
            ));
        }
        if let Some(el) = &el2 {
            if !uia::is_inside(u, &hit, el) {
                return Err(CapError::new(code::CONFLICT, "occluded", format!("Something else covers {}; re-snapshot", el.ref_)));
            }
        }
        if hit.secure {
            return Err(CapError::secure_refusal());
        }
        if el2.is_none() && !approved && hit.labels.iter().any(|l| risk_labels::is_risky(Some(l), None)) {
            return Err(CapError::new(
                code::APPROVAL_REQUIRED,
                "risky_label",
                "The control at this point may delete, send or create data; this click needs approval.",
            ));
        }
        Ok(())
    })
}

fn center(el: &Resolved) -> CapResult<(f64, f64)> {
    let e = el.clone();
    let f = run(UIA_TIMEOUT, move |_| Ok(uia::frame(&e)))?;
    match f {
        Some(f) if f.w > 0.0 && f.h > 0.0 => Ok((f.mid_x(), f.mid_y())),
        _ => Err(CapError::new(
            code::UNAVAILABLE,
            "no_frame",
            format!("{} has no on-screen frame; scroll it into view and re-snapshot", el.ref_),
        )),
    }
}

fn modifier_flags(names: &Option<Vec<String>>) -> CapResult<Mods> {
    match names {
        Some(n) if !n.is_empty() => Ok(KeyChord::parse(&(n.join("+") + "+a"))?.mods),
        _ => Ok(Mods::default()),
    }
}

// MARK: - Read

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SnapshotParams {
    app: Option<String>,
    pid: Option<i64>,
    window: Option<i64>,
    root: Option<String>,
    #[allow(dead_code)]
    menubar: Option<bool>,
    max_visit: Option<i64>,
    max_emit: Option<i64>,
    text_max: Option<i64>,
    value_max: Option<i64>,
    clip: Option<bool>,
    format: Option<String>,
    #[allow(dead_code)]
    session: Option<String>,
}

fn ax_tree(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let p: SnapshotParams = decode(params)?;
    c.ensure_esc_tap();
    c.reload_settings();
    let app = apps::find_app(p.app.as_deref(), p.pid)?;
    c.policy.authorize(Intent::Read, app.bundle_id.as_deref(), &app.name, binding(inv, params).as_ref())?;
    let options = SnapshotOptions::clamped(p.max_visit, p.max_emit, p.text_max, p.value_max, p.clip);
    if let Some(w) = p.window {
        if w < 0 {
            return Err(CapError::invalid_params("window must be ≥ 0", Some("window")));
        }
    }
    let req = SnapshotRequest { app: app.clone(), window: p.window.map(|w| w as usize), root: p.root.clone(), options };
    let snap = run(SNAPSHOT_TIMEOUT, move |u| snapshot_on(u, req))?;
    let mut result = Map::new();
    result.insert("text".into(), json!(snap.render()));
    result.insert("header".into(), serde_json::to_value(&snap.header).unwrap_or(Value::Null));
    result.insert("provenance".into(), json!("untrusted"));
    result.insert("tier".into(), json!(c.policy.effective_tier(app.bundle_id.as_deref()).as_str()));
    if p.format.as_deref() == Some("json") {
        result.insert("nodes".into(), serde_json::to_value(&snap.nodes).unwrap_or(json!([])));
    }
    // Screenshot-fallback hint (spike 04 trigger 1: sparse Chromium trees).
    if app.electron && (!snap.nodes.iter().any(|n| n.role == "webarea") || snap.nodes.len() < 10) {
        result.insert("hint".into(), json!("sparse_tree: bring the window to the front and retry, or use computer.screenshot"));
    }
    Ok(CapOutput::plain(Value::Object(result)))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CheckTargetParams {
    app: Option<String>,
    role: Option<String>,
    name: Option<String>,
    identifier: Option<String>,
    menu_path: Option<Vec<String>>,
    #[allow(dead_code)]
    session: Option<String>,
}

/// Replay of a recorded step (teach by showing): is the recorded target in the app right now?
/// Read-only. Exact role and name; `missing` / `ambiguous` carry `stop` so the run asks the owner.
fn check_target(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let p: CheckTargetParams = decode(params)?;
    let menu_path = p.menu_path.clone().unwrap_or_default();
    let is_menu = !menu_path.is_empty();
    // A role is required (`generic` means any): a name alone would match the wrong kind of element.
    if !is_menu && p.role.as_deref().unwrap_or("").is_empty() {
        return Err(CapError::invalid_params("role is required", Some("role")));
    }
    c.ensure_esc_tap();
    c.reload_settings();
    let app = apps::find_app(p.app.as_deref(), None)?;
    c.policy.authorize(Intent::Read, app.bundle_id.as_deref(), &app.name, binding(inv, params).as_ref())?;
    let options = SnapshotOptions::clamped(Some(8000), Some(2000), Some(400), Some(20), Some(true));
    let req = SnapshotRequest { app: app.clone(), window: None, root: is_menu.then(|| "app".to_string()), options };
    let snap = run(SNAPSHOT_TIMEOUT, move |u| snapshot_on(u, req))?;
    let id = app.bundle_id.clone().unwrap_or_else(|| app.name.clone());
    let reply = |status: &str, extra: Vec<(&str, Value)>| {
        let mut o = Map::new();
        o.insert("status".into(), json!(status));
        o.insert("app".into(), json!(id));
        o.insert("stop".into(), json!(status != "found"));
        o.insert("provenance".into(), json!("untrusted"));
        for (k, v) in extra {
            o.insert(k.into(), v);
        }
        Ok(CapOutput::plain(Value::Object(o)))
    };
    // The app that answered is not the one the recording was made in: a stop.
    let wanted = p.app.as_deref().unwrap_or("").to_lowercase();
    if wanted.contains('.') && app.bundle_id.as_deref().map(str::to_lowercase).as_deref() != Some(wanted.as_str()) {
        return reply("wrong_app", vec![("hint", json!("This is not the app the recording was made in. Ask the owner."))]);
    }
    let query = crate::target_check::Query { role: p.role, name: p.name, identifier: p.identifier, menu_path: menu_path.clone() };
    let mut outcome = crate::target_check::check(&snap.nodes, &query);
    // A Win32 menu bar is not in the tree until it is opened: read it the way `computer.menu` does.
    if is_menu && outcome == crate::target_check::Outcome::Missing {
        let hwnd = apps::foreground_window()
            .filter(|w| w.pid == app.pid)
            .or_else(|| apps::app_windows(&app).into_iter().find(|w| w.layer() == 0))
            .map(|w| w.hwnd);
        if hwnd.is_some_and(|h| menu::win32_path_exists(h, &menu_path)) {
            return reply(
                "found",
                vec![
                    ("role", json!("menuitem")),
                    ("label", json!(menu_path.last().cloned().unwrap_or_default())),
                    ("next", json!("Use computer.act with the menu action and this path.")),
                ],
            );
        }
    }
    // A truncated snapshot cannot show that a match is the only one.
    if snap.header.truncated.is_some() {
        if let crate::target_check::Outcome::Found { ref_, .. } = &outcome {
            outcome = crate::target_check::Outcome::Ambiguous(vec![ref_.clone()]);
        }
    }
    match outcome {
        crate::target_check::Outcome::Found { ref_, role, label } => {
            let mut extra = vec![("ref", json!(ref_)), ("role", json!(role))];
            if let Some(l) = label {
                extra.push(("label", json!(l)));
            }
            reply("found", extra)
        }
        crate::target_check::Outcome::Ambiguous(refs) => reply(
            "ambiguous",
            vec![("candidates", json!(refs)), ("hint", json!("Several elements match; do not pick one. Ask the owner."))],
        ),
        crate::target_check::Outcome::Missing => {
            reply("missing", vec![("hint", json!("The recorded element is not in the window. Ask the owner what to do."))])
        }
    }
}

#[derive(Deserialize)]
struct ValueParams {
    #[serde(rename = "ref")]
    ref_: String,
    max: Option<i64>,
}

fn ax_value(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let p: ValueParams = decode(params)?;
    let el = element_for(&p.ref_)?;
    c.policy.authorize(Intent::Read, el.app.bundle_id.as_deref(), &el.app.name, binding(inv, params).as_ref())?;
    if el.info.is_secure() {
        return Err(CapError::secure_refusal());
    }
    let max = p.max.unwrap_or(50_000).clamp(1, 200_000) as usize;
    let e = el.clone();
    let value = run(UIA_TIMEOUT, move |_| Ok(uia::full_value(&e, max)))?;
    Ok(CapOutput::plain(json!({"ref": p.ref_, "role": el.role_name, "value": value, "provenance": "untrusted"})))
}

// MARK: - Element actions

#[derive(Deserialize, Default)]
struct ClickParams {
    #[serde(flatten)]
    t: TargetParams,
    modifiers: Option<Vec<String>>,
}

fn click(c: &ComputerUse, inv: &Invocation, params: &Value, count: u32, right: bool) -> CapResult<CapOutput> {
    let verb = if right {
        "right-click"
    } else if count == 2 {
        "double-click"
    } else {
        "click"
    };
    let p: ClickParams = decode(params)?;
    let mods = modifier_flags(&p.modifiers)?;
    let intent = if right {
        Intent::RightClick
    } else if mods.is_empty() {
        Intent::Click
    } else {
        Intent::ModifierClick
    };
    let approval_id = inv.approval_id.as_deref();
    if p.t.ref_.is_some() || p.t.selector.is_some() {
        let el = element(c, inv, params, &p.t, intent, None)?;
        // 1. Semantic UIA first.
        let actions = run(UIA_TIMEOUT, {
            let e = el.clone();
            move |_| Ok(crate::roles::actions(&e.facts, &e.info.role))
        })?;
        let semantic = if count == 1 && !right && mods.is_empty() && actions.iter().any(|a| a == "AXPress") {
            Some(("AXPress", "press; re-snapshot to confirm the effect"))
        } else if right && count == 1 && mods.is_empty() && actions.iter().any(|a| a == "AXShowMenu") {
            Some(("AXShowMenu", "show menu"))
        } else {
            None
        };
        if let Some((action, detail)) = semantic {
            let e = el.clone();
            if run(UIA_TIMEOUT, move |_| Ok(uia::perform(&e, action).is_ok()))? {
                return Ok(Outcome::new("ok", "ax", Some(detail.into()), Some(el.ref_.clone()), &el.app).output(verb));
            }
        }
        // 2. SendInput fallback at the frame centre, app in front.
        let (x, y) = center(&el)?;
        apps::activate(&el.app, Some(el.root_hwnd), &c.stop)?;
        check_hit(x, y, &el.app, Some(&el), approval_id)?;
        input::click(x, y, count, right, mods, &c.stop)?;
        return Ok(Outcome::new("ok", "sendinput", Some(format!("mouse {verb} at the element centre")), Some(el.ref_.clone()), &el.app)
            .output(verb));
    }
    let (x, y, app, hwnd) = point(c, inv, params, &p.t, intent)?;
    apps::activate(&app, Some(hwnd), &c.stop)?;
    check_hit(x, y, &app, None, approval_id)?;
    input::click(x, y, count, right, mods, &c.stop)?;
    Ok(Outcome::new("ok", "sendinput", Some(format!("mouse {verb} at {},{}", x as i64, y as i64)), None, &app).output(verb))
}

fn press_action(name: &str) -> Option<&'static str> {
    Some(match name {
        "press" => "AXPress",
        "confirm" => "AXConfirm",
        "cancel" => "AXCancel",
        "pick" => "AXPick",
        "inc" => "AXIncrement",
        "dec" => "AXDecrement",
        "raise" => "AXRaise",
        "menu" => "AXShowMenu",
        "open" => "AXOpen",
        _ => return None,
    })
}

#[derive(Deserialize)]
struct PressParams {
    #[serde(flatten)]
    t: TargetParams,
    action: String,
}

fn press(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let p: PressParams = decode(params)?;
    let custom = p.action.strip_prefix("custom:").map(str::to_string);
    // Plain press on a control is a click; menu items and other actions can run any app command.
    let mut intent = if p.action == "press" { Intent::Press } else { Intent::Menu };
    if let (Some(r), Intent::Press) = (&p.t.ref_, intent) {
        if let Ok(el) = element_for(r) {
            if ["AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXPopUpButton"].contains(&el.info.role.as_str()) {
                intent = Intent::Menu;
            }
        }
    } else if p.t.selector.as_ref().and_then(|s| s.role.as_deref()).map(|r| r.starts_with("menu") || r == "popupbutton").unwrap_or(false) {
        intent = Intent::Menu;
    }
    let el = element(c, inv, params, &p.t, intent, custom.as_deref())?;
    let raw = crate::roles::actions(&el.facts, &el.info.role);
    if custom.is_some() {
        // UI Automation has no custom actions (the Mac's `Name:…` actions).
        return Err(CapError::new(code::NOT_FOUND, "action_not_supported", format!("{} has no such custom action", el.ref_)));
    }
    let Some(ax) = press_action(&p.action).filter(|a| raw.iter().any(|r| r == a)) else {
        return Err(CapError::new(code::NOT_FOUND, "action_not_supported", format!("{} does not support {}", el.ref_, p.action))
            .detail("actions", json!(raw)));
    };
    let e = el.clone();
    let r = run(UIA_TIMEOUT, move |_| Ok(uia::perform(&e, ax)))?;
    match r {
        Ok(()) => {
            Ok(Outcome::new("ok", "ax", Some(format!("{}; re-snapshot to confirm the effect", p.action)), Some(el.ref_.clone()), &el.app)
                .output(&p.action))
        }
        Err(pe) if pe.not_responding() => Err(uia::not_responding(&el.app.name)),
        Err(pe) => Ok(Outcome::new("ineffective", "ax", Some(pe.detail()), Some(el.ref_.clone()), &el.app).output(&p.action)),
    }
}

/// Read back with backoff (UIA providers, like Chromium's, can apply writes asynchronously).
fn verify(c: &ComputerUse, el: &Resolved, check: impl Fn(Option<&str>) -> bool) -> CapResult<Option<String>> {
    let waits = [50u64, 100, 200, 400];
    let totals = [50u64, 150, 350, 750];
    for (i, w) in waits.iter().enumerate() {
        input::pause(*w, &c.stop)?;
        let e = el.clone();
        let now = run(UIA_TIMEOUT, move |u| Ok(uia::current_value(u, &e)))?;
        if check(now.as_deref()) {
            return Ok(Some(format!("verified after {} ms", totals[i])));
        }
    }
    Ok(None)
}

#[derive(Deserialize)]
struct SetParams {
    #[serde(flatten)]
    t: TargetParams,
    value: String,
}

fn set_value(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let p: SetParams = decode(params)?;
    let el = element(c, inv, params, &p.t, Intent::SetValue, None)?;
    if el.info.is_secure() {
        return Err(CapError::secure_refusal());
    }
    if !crate::roles::value_settable(&el.facts) {
        return Err(CapError::new(
            code::CONFLICT,
            "not_settable",
            format!("{} ({}) has no settable value; click it and use computer.type", el.ref_, el.role_name),
        ));
    }
    let (e, v) = (el.clone(), p.value.clone());
    let r = run(UIA_TIMEOUT, move |_| Ok(uia::set_value(&e, &v)))?;
    if let Err(pe) = r {
        return Ok(Outcome::new("ineffective", "ax", Some(pe.detail()), Some(el.ref_.clone()), &el.app).output("set value"));
    }
    let want = p.value.clone();
    // Sliders read back as numbers ("50" for "50.0").
    let want_num: Option<f64> = want.trim().parse().ok();
    if let Some(how) =
        verify(c, &el, |now| now == Some(want.as_str()) || (want_num.is_some() && now.and_then(|n| n.parse::<f64>().ok()) == want_num))?
    {
        return Ok(Outcome::new("ok", "ax", Some(how), Some(el.ref_.clone()), &el.app).output("set value"));
    }
    let detail = if el.app.electron {
        "read-back did not match after 750 ms (Chromium window in the background?)"
    } else {
        "read-back did not match after 750 ms"
    };
    Ok(Outcome::new("unverified", "ax", Some(detail.into()), Some(el.ref_.clone()), &el.app).output("set value"))
}

fn select(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let t: TargetParams = decode(params)?;
    let el = element(c, inv, params, &t, Intent::Click, None)?;
    if !el.facts.selection_item {
        return Err(CapError::new(
            code::CONFLICT,
            "not_selectable",
            format!("{} cannot be selected through UI Automation; use computer.click", el.ref_),
        ));
    }
    let e = el.clone();
    if let Err(pe) = run(UIA_TIMEOUT, move |_| Ok(uia::select(&e)))? {
        return Ok(Outcome::new("ineffective", "ax", Some(pe.detail()), Some(el.ref_.clone()), &el.app).output("select"));
    }
    input::pause(50, &c.stop)?;
    let e = el.clone();
    let selected = run(UIA_TIMEOUT, move |_| Ok(uia::is_selected(&e)))?;
    Ok(Outcome::new(if selected == Some(true) { "ok" } else { "unverified" }, "ax", None, Some(el.ref_.clone()), &el.app).output("select"))
}

#[derive(Deserialize)]
struct TypeParams {
    #[serde(flatten)]
    t: TargetParams,
    text: String,
}

fn type_text(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let p: TypeParams = decode(params)?;
    if p.text.is_empty() {
        return Err(CapError::invalid_params("text is empty", Some("text")));
    }
    let sends_line = send_keys::text_sends(&p.text);
    if p.text.contains("{{cred:") {
        return Err(CapError::new(
            code::POLICY_DENIED,
            "credential_placeholder",
            "Credential placeholders are filled by the vault, never typed",
        ));
    }
    let (app, ref_, hwnd) = if p.t.ref_.is_some() || p.t.selector.is_some() {
        let el = element(c, inv, params, &p.t, Intent::Type, None)?;
        if el.info.is_secure() {
            return Err(CapError::secure_refusal());
        }
        let e = el.clone();
        let _ = run(UIA_TIMEOUT, move |_| Ok(uia::set_focus(&e).is_ok()));
        (el.app.clone(), Some(el.ref_.clone()), Some(el.root_hwnd))
    } else {
        c.begin_action(p.t.session.as_deref())?;
        let app = apps::find_app(p.t.app.as_deref(), None)?;
        c.policy.authorize(Intent::Type, app.bundle_id.as_deref(), &app.name, binding(inv, params).as_ref())?;
        apps::check_uipi(&app)?;
        (app, None, None)
    };
    // #270: a line break in typed text presses Return, which sends in messaging and mail apps.
    if sends_line && send_keys::is_messaging_app(app.bundle_id.as_deref()) && binding(inv, params).is_none() {
        return Err(CapError::new(
            code::APPROVAL_REQUIRED,
            "send_text",
            format!("Typing a line break sends in {}; sending needs your approval", app.name),
        )
        .detail("app", app.id())
        .detail("sideEffect", "destructive"));
    }
    apps::activate(&app, hwnd, &c.stop)?;
    // Checked before every chunk: Tab / Return can move focus (into a password field, or out of
    // the app), and the dispatch layer refuses secure fields below the model.
    let a = app.clone();
    input::type_text(&p.text, &c.stop, &mut || {
        ensure_keyboard_target(&a)?;
        if keyboard_focus_secure()? {
            return Err(CapError::secure_refusal());
        }
        Ok(())
    })?;
    let n = unicode_segmentation::UnicodeSegmentation::graphemes(p.text.as_str(), true).count();
    Ok(Outcome::new("ok", "sendinput", Some(format!("typed {n} characters")), ref_, &app).output("type"))
}

#[derive(Deserialize)]
struct KeyParams {
    keys: String,
    app: Option<String>,
    session: Option<String>,
    #[serde(rename = "repeat")]
    repeat_count: Option<i64>,
}

fn key(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let p: KeyParams = decode(params)?;
    let chord = KeyChord::parse(&p.keys)?;
    c.begin_action(p.session.as_deref())?;
    let app = apps::find_app(p.app.as_deref(), None)?;
    c.policy.authorize(Intent::Key, app.bundle_id.as_deref(), &app.name, binding(inv, params).as_ref())?;
    apps::check_uipi(&app)?;
    // #270: Return / Enter / send chords in messaging and mail apps are destructive.
    if send_keys::is_messaging_app(app.bundle_id.as_deref()) && send_keys::is_send_chord(&chord) && binding(inv, params).is_none() {
        return Err(CapError::new(
            code::APPROVAL_REQUIRED,
            "send_key",
            format!("That key sends in {}; sending needs your approval", app.name),
        )
        .detail("app", app.id())
        .detail("sideEffect", "destructive"));
    }
    if chord.is_high_risk_in(app.bundle_id.as_deref()) && binding(inv, params).is_none() {
        return Err(CapError::new(
            code::APPROVAL_REQUIRED,
            "risky_chord",
            "That chord can close windows, quit apps or delete; it needs approval",
        ));
    }
    apps::activate(&app, None, &c.stop)?;
    let a = app.clone();
    if run(UIA_TIMEOUT, move |u| Ok(uia::focused_is_secure(u, Some(&a))))?
        && !chord.is_bare_escape()
        && chord.vk != crate::keychord::vk::TAB
    {
        return Err(CapError::secure_refusal()); // allow Esc and Tab to leave the field
    }
    for _ in 0..p.repeat_count.unwrap_or(1).clamp(1, 50) {
        ensure_keyboard_target(&app)?;
        if !chord.is_escape_or_tab() && keyboard_focus_secure()? {
            return Err(CapError::secure_refusal());
        }
        input::key(&chord, &c.stop)?;
    }
    Ok(Outcome::new("ok", "sendinput", Some(p.keys.clone()), None, &app).output(&format!("key {}", p.keys)))
}

#[derive(Deserialize)]
struct ScrollParams {
    #[serde(flatten)]
    t: TargetParams,
    dx: Option<i64>,
    dy: Option<i64>,
}

fn scroll(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let p: ScrollParams = decode(params)?;
    let dx = p.dx.unwrap_or(0).clamp(-200, 200) as i32;
    let dy = p.dy.unwrap_or(0).clamp(-200, 200) as i32;
    let (x, y, app, ref_) = if p.t.ref_.is_some() || p.t.selector.is_some() {
        let el = element(c, inv, params, &p.t, Intent::Scroll, None)?;
        let (x, y) = center(&el)?;
        (x, y, el.app.clone(), Some(el.ref_.clone()))
    } else {
        let (x, y, app, _) = point(c, inv, params, &p.t, Intent::Scroll)?;
        (x, y, app, None)
    };
    if apps::window_at(x, y).map(|w| w.pid) != Some(app.pid) {
        return Err(CapError::new(
            code::CONFLICT,
            "occluded",
            format!("Another window covers the scroll point; bring {} forward", app.name),
        ));
    }
    input::scroll(x, y, dx, dy, &c.stop)?;
    Ok(Outcome::new("ok", "sendinput", Some(format!("scrolled dx={dx} dy={dy}")), ref_, &app).output("scroll"))
}

#[derive(Deserialize)]
struct DragParams {
    from: TargetParams,
    to: TargetParams,
    session: Option<String>,
}

fn drag(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let p: DragParams = decode(params)?;
    let resolve = |t: &TargetParams| -> CapResult<(f64, f64, TargetApp, isize)> {
        let mut t = t.clone();
        t.session = p.session.clone();
        if t.ref_.is_some() || t.selector.is_some() {
            let el = element(c, inv, params, &t, Intent::Drag, None)?;
            let (x, y) = center(&el)?;
            return Ok((x, y, el.app.clone(), el.root_hwnd));
        }
        point(c, inv, params, &t, Intent::Drag)
    };
    let (ax, ay, app_a, hwnd) = resolve(&p.from)?;
    let (bx, by, app_b, _) = resolve(&p.to)?;
    if app_a.pid != app_b.pid {
        return Err(CapError::new(code::POLICY_DENIED, "cross_app_drag", "Drags between apps are not allowed"));
    }
    apps::activate(&app_a, Some(hwnd), &c.stop)?;
    check_hit(ax, ay, &app_a, None, inv.approval_id.as_deref())?;
    input::drag((ax, ay), (bx, by), &c.stop)?;
    Ok(Outcome::new("ok", "sendinput", None, None, &app_a).output("drag"))
}

#[derive(Deserialize)]
struct MenuParams {
    app: Option<String>,
    path: String,
    session: Option<String>,
}

fn menu_cap(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let p: MenuParams = decode(params)?;
    let path: Vec<String> = p.path.split('>').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if path.is_empty() {
        return Err(CapError::invalid_params("path is empty", Some("path")));
    }
    c.begin_action(p.session.as_deref())?;
    let app = apps::find_app(p.app.as_deref(), None)?;
    c.policy.authorize(Intent::Menu, app.bundle_id.as_deref(), &app.name, binding(inv, params).as_ref())?;
    apps::check_uipi(&app)?;
    if inv.approval_id.is_none() && path.iter().any(|s| risk_labels::is_risky(Some(s), None)) {
        return Err(CapError::new(code::APPROVAL_REQUIRED, "risky_label", "That menu item may delete, send or quit; it needs approval"));
    }
    let hwnd = apps::foreground_window()
        .filter(|w| w.pid == app.pid)
        .or_else(|| apps::app_windows(&app).into_iter().find(|w| w.layer() == 0))
        .map(|w| w.hwnd)
        .ok_or_else(|| CapError::new(code::NOT_FOUND, "no_window", format!("{} has no open window", app.name)))?;
    let a = app.clone();
    let title = run(UIA_TIMEOUT, move |u| menu::press_menu(u, &a, hwnd, &path))?;
    Ok(Outcome::new("ok", "menu", Some(title), None, &app).output(&format!("menu {}", p.path)))
}

#[derive(Deserialize)]
struct EndParams {
    session: Option<String>,
}

fn end_session(c: &ComputerUse, params: &Value) -> CapResult<CapOutput> {
    let p: EndParams = decode(params)?;
    c.sessions.release(p.session.as_deref().unwrap_or("default"));
    Ok(CapOutput::plain(json!({"released": true})))
}

// MARK: - Screenshots

/// This process and every Psyche app (the desktop shell and its helpers).
pub fn psyche_pids() -> HashSet<u32> {
    let mut out = HashSet::from([apps::own_pid()]);
    for a in apps::windowed_apps() {
        if fixed_caps::category(a.bundle_id.as_deref()) == Some(fixed_caps::Category::Psyche) {
            out.insert(a.pid);
            if let Some(h) = a.host_pid {
                out.insert(h);
            }
        }
    }
    out
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ShotParams {
    app: Option<String>,
    display: Option<i64>,
    window_only: Option<bool>,
    max_width: Option<i64>,
    max_height: Option<i64>,
    format: Option<String>,
    #[allow(dead_code)]
    session: Option<String>,
}

fn screenshot(c: &ComputerUse, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
    let p: ShotParams = decode(params)?;
    c.reload_settings();
    let app = apps::find_app(p.app.as_deref(), None)?;
    c.policy.authorize(Intent::Read, app.bundle_id.as_deref(), &app.name, binding(inv, params).as_ref())?;
    apps::check_desktop()?;
    // Below the model: no capture while any password field has focus.
    if run(UIA_TIMEOUT, |u| Ok(uia::focused_is_secure(u, None)))? {
        return Err(CapError::new(
            code::POLICY_DENIED,
            "secure_field_focused",
            "A password field has focus; screenshots are suppressed until it loses focus.",
        ));
    }
    let running: Vec<AppRef> = apps::windowed_apps()
        .into_iter()
        .flat_map(|a| {
            let mut v = vec![AppRef { bundle_id: a.bundle_id.clone(), pid: a.pid }];
            if let Some(h) = a.host_pid {
                v.push(AppRef { bundle_id: Some("applicationframehost.exe".into()), pid: h });
            }
            v
        })
        .collect();
    let mut excluded = hygiene::excluded_pids(&running, apps::own_pid(), &c.policy);
    excluded.extend(psyche_pids());
    if excluded.contains(&app.pid) {
        return Err(CapError::new(code::POLICY_DENIED, "app_excluded", format!("{} is never captured", app.name)));
    }
    let max_w = p.max_width.map(|v| v.clamp(320, 2560) as u32).unwrap_or(hygiene::DEFAULT_MAX_WIDTH);
    let max_h = p.max_height.map(|v| v.clamp(240, 1600) as u32).unwrap_or(hygiene::DEFAULT_MAX_HEIGHT);
    let png = p.format.as_deref() == Some("png");
    let windows = apps::top_windows();
    let (frame, screen, scale) = if p.window_only == Some(true) {
        let w = windows
            .iter()
            .filter(|w| w.pid == app.pid && w.layer() == 0 && !w.iconic)
            .max_by(|a, b| (a.rect.w * a.rect.h).partial_cmp(&(b.rect.w * b.rect.h)).unwrap_or(std::cmp::Ordering::Equal))
            .cloned()
            .ok_or_else(|| CapError::new(code::NOT_FOUND, "no_window", format!("{} has no on-screen window", app.name)))?;
        let hwnd = w.hwnd;
        let frame = run(CAPTURE_TIMEOUT, move |_| capture::capture_window(hwnd, true))?;
        let scale = capture::monitor_for_rect(w.rect).map(|m| m.scale).unwrap_or(1.0);
        (frame, w.rect, scale)
    } else {
        let monitors = capture::monitors();
        let m = match p.display {
            Some(i) => usize::try_from(i).ok().and_then(|i| monitors.get(i).cloned()),
            None => monitors.iter().find(|m| m.primary).cloned().or_else(|| monitors.first().cloned()),
        }
        .ok_or_else(|| CapError::new(code::NOT_FOUND, "no_display", "No such display"))?;
        let m2 = m.clone();
        let mut frame = run(CAPTURE_TIMEOUT, move |_| capture::capture_monitor(&m2, true))?;
        let refs: Vec<hygiene::WindowRef> = windows.iter().map(|w| w.window_ref()).collect();
        for r in hygiene::redactions(&refs, &excluded, m.rect) {
            frame.fill_black(crate::snapshot::Rect::new(r.x - m.rect.x, r.y - m.rect.y, r.w, r.h));
        }
        (frame, m.rect, m.scale)
    };
    let (w, h) = hygiene::scaled_size(frame.width, frame.height, max_w, max_h);
    let (data, mime, w, h) = run(CAPTURE_TIMEOUT, move |_| capture::encode(&frame, w, h, png))?;
    Ok(CapOutput::plain(json!({
        "image": b64(&data),
        "mimeType": mime,
        "width": w,
        "height": h,
        // Map image pixels back to screen coordinates for computer.click {x, y}.
        "screen": {"x": screen.x, "y": screen.y, "width": screen.w, "height": screen.h},
        "pointsPerPixel": screen.w / (w.max(1) as f64),
        "scaleFactor": scale,
        "excludedApps": excluded.len().saturating_sub(1),
        "provenance": "untrusted",
    })))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PickParams {
    max_width: Option<i64>,
    max_height: Option<i64>,
    timeout_seconds: Option<i64>,
}

fn screenshot_pick(params: &Value) -> CapResult<CapOutput> {
    let p: PickParams = decode(params)?;
    let timeout = Duration::from_secs(p.timeout_seconds.unwrap_or(120).clamp(10, 300) as u64);
    let (frame, _) = crate::win::picker::pick(timeout)?;
    let max_w = p.max_width.map(|v| v.clamp(320, 2560) as u32).unwrap_or(hygiene::DEFAULT_MAX_WIDTH);
    let max_h = p.max_height.map(|v| v.clamp(240, 1600) as u32).unwrap_or(hygiene::DEFAULT_MAX_HEIGHT);
    let (w, h) = hygiene::scaled_size(frame.width, frame.height, max_w, max_h);
    let (data, mime, w, h) = run(CAPTURE_TIMEOUT, move |_| capture::encode(&frame, w, h, false))?;
    Ok(CapOutput::plain(
        json!({"image": b64(&data), "mimeType": mime, "width": w, "height": h, "userInitiated": true, "provenance": "untrusted"}),
    ))
}

// MARK: - screen.context

#[derive(Deserialize)]
struct ScreenRectParam {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenContextParams {
    mode: String,
    rect: Option<ScreenRectParam>,
    max_width: Option<i64>,
    max_height: Option<i64>,
}

struct TextContext {
    app_name: String,
    bundle_id: Option<String>,
    window_title: Option<String>,
    selected_text: Option<String>,
    url: Option<String>,
}

impl TextContext {
    fn json(&self) -> Value {
        json!({
            "appName": self.app_name,
            "bundleId": self.bundle_id,
            "windowTitle": self.window_title,
            "selectedText": self.selected_text,
            "url": self.url,
        })
    }
}

/// `ScreenContextResult` with `refusal`, no image.
fn refused(ctx: &TextContext, refusal: &str, extra: Option<Value>) -> CapOutput {
    let mut o = json!({"context": ctx.json(), "width": 0, "height": 0, "image": null, "refusal": refusal});
    if let Some(e) = extra {
        o["win"] = e;
    }
    CapOutput::plain(o)
}

/// Selected text of one element (UIA TextPattern), never of a password field.
fn element_selection(e: &windows::Win32::UI::Accessibility::IUIAutomationElement) -> Option<String> {
    use windows::Win32::UI::Accessibility::*;
    unsafe {
        if e.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(true) {
            return None;
        }
        let tp: IUIAutomationTextPattern = e.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
        let ranges = tp.GetSelection().ok()?;
        let mut out = String::new();
        for i in 0..ranges.Length().unwrap_or(0).min(8) {
            if let Ok(r) = ranges.GetElement(i) {
                if let Ok(t) = r.GetText((screen_ask::MAX_SELECTED_TEXT * 2) as i32) {
                    out.push_str(&t.to_string());
                }
            }
        }
        screen_ask::selection(Some(&out))
    }
}

/// The selected text: the focused element's (when it belongs to `app`), else, when focus sits on
/// chrome (a menu bar after a menu command), the first selection among the window's text
/// controls. Never a password field's.
fn selection_on(u: &Uia, app: &TargetApp, hwnd: Option<isize>) -> Option<String> {
    use windows::Win32::UI::Accessibility::*;
    unsafe {
        let f = u.auto.GetFocusedElementBuildCache(&u.req_element).ok()?;
        if f.CachedIsPassword().map(|b| b.as_bool()).unwrap_or(true) || !app.owns(f.CachedProcessId().ok()? as u32) {
            return None;
        }
        if let Some(s) = element_selection(&f) {
            return Some(s);
        }
        let root = u.auto.ElementFromHandle(apps::hwnd(hwnd?)).ok()?;
        let mut v = windows::Win32::System::Variant::VARIANT::default();
        (*v.Anonymous.Anonymous).vt = windows::Win32::System::Variant::VT_BOOL;
        (*v.Anonymous.Anonymous).Anonymous.boolVal = windows::Win32::Foundation::VARIANT_TRUE;
        let cond = u.auto.CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &v).ok()?;
        let all = root.FindAll(TreeScope_Descendants, &cond).ok()?;
        (0..all.Length().unwrap_or(0).min(16)).filter_map(|i| all.GetElement(i).ok()).find_map(|e| element_selection(&e))
    }
}

/// The browser URL: the first web document's value under the window (breadth first, bounded),
/// else the address bar's (with `https://` when it shows no scheme).
fn browser_url_on(u: &Uia, hwnd: isize, pid: u32) -> Option<String> {
    let root = uia::element_for_window(u, hwnd, pid).ok()?;
    let source = uia::LiveSource::new(u, Some(Instant::now() + Duration::from_millis(1500)), false);
    let mut queue = std::collections::VecDeque::from([(root, 0usize)]);
    let mut visited = 0;
    let mut address: Option<String> = None;
    while let Some((n, depth)) = queue.pop_front() {
        if visited >= 400 || crate::snapshot::TreeSource::should_stop(&source) {
            break;
        }
        visited += 1;
        if let Some(c) = source.computed(&n) {
            if c.info.role == "AXWebArea" {
                if let Some(u) = screen_ask::url(c.info.url.as_deref()) {
                    return Some(u);
                }
            }
            if address.is_none() && c.info.role == "AXTextField" && c.facts.control_type == crate::roles::ct::EDIT {
                let v = c.info.value.clone().unwrap_or_default();
                if !v.contains(' ') && v.contains('.') {
                    address = Some(if v.contains("://") { v } else { format!("https://{v}") });
                }
            }
        }
        if depth < 14 {
            for k in crate::snapshot::TreeSource::children(&source, &n) {
                queue.push_back((k, depth + 1));
            }
        }
    }
    screen_ask::url(address.as_deref())
}

/// The focused element and a short UI excerpt (Windows extras, outside the protocol's
/// `ScreenContext`; the Gateway does not read them).
fn win_extras_on(u: &Uia, app: &TargetApp, hwnd: Option<isize>) -> Value {
    let focused = unsafe { u.auto.GetFocusedElementBuildCache(&u.req_element) }.ok().and_then(|f| {
        let n = uia::node_for(f, None, false, app.pid, hwnd.unwrap_or(0));
        let c = uia::compute(&n, false)?;
        if !app.owns(c.pid) {
            return None;
        }
        let label = if c.info.is_secure() { None } else { text::truncate(c.info.title.as_deref().or(c.info.description.as_deref()), 80) };
        Some(json!({"role": text::role_name(&c.info.role, c.info.subrole.as_deref()), "label": label, "secure": c.info.is_secure()}))
    });
    let excerpt = hwnd.and_then(|h| {
        let root = uia::element_for_window(u, h, app.pid).ok()?;
        let source = uia::LiveSource::new(u, Some(Instant::now() + Duration::from_millis(1500)), true);
        let options = SnapshotOptions { max_emit: 40, max_visit: 800, text_max: 60, value_max: 80, ..Default::default() };
        let mut scratch = RefTable::default();
        let snap = SnapshotBuilder::new(&source, &mut scratch, options, None).snapshot(
            &root,
            HeaderIdentity { app: &app.name, pid: app.pid, bundle_id: app.bundle_id.as_deref(), electron: app.electron },
            &[],
        );
        let lines: Vec<String> = snap
            .nodes
            .iter()
            .map(|n| {
                let mut l = format!("{}{}", "  ".repeat(n.depth), n.role);
                if let Some(x) = &n.label {
                    l.push_str(&format!(" \"{x}\""));
                }
                if let Some(x) = &n.value {
                    l.push_str(&format!(" =\"{x}\""));
                }
                l
            })
            .collect();
        Some(lines.join("\n"))
    });
    json!({"processName": app.bundle_id, "exePath": app.exe_path, "focused": focused, "excerpt": excerpt})
}

fn screen_context(params: &Value) -> CapResult<CapOutput> {
    let p: ScreenContextParams = decode(params)?;
    let region = match p.mode.as_str() {
        "window" => false,
        "region" => true,
        _ => return Err(CapError::invalid_params("mode must be window or region", Some("mode"))),
    };
    let settings = TierSettings::load(&TierSettings::path());
    let windows = apps::top_windows();
    let refs: Vec<hygiene::WindowRef> = windows.iter().map(|w| w.window_ref()).collect();
    let psyche = psyche_pids();
    let rect = p.rect.as_ref().map(|r| crate::snapshot::Rect::new(r.x, r.y, r.width, r.height));
    if region && rect.is_none() {
        return Err(CapError::invalid_params("Region mode needs a rect", Some("rect")));
    }
    let target = if region {
        let r = rect.unwrap();
        screen_ask::window_at(r.mid_x(), r.mid_y(), &refs, &psyche)
    } else {
        screen_ask::target_window(&refs, &psyche)
    }
    .cloned();
    let target_info = target.as_ref().and_then(|t| windows.iter().find(|w| w.hwnd == t.id).cloned());
    let app = target_info.as_ref().and_then(apps::app_for_window).or_else(|| apps::find_app(None, None).ok());
    let bundle_id = app.as_ref().and_then(|a| a.bundle_id.clone());
    let app_name = app.as_ref().map(|a| a.name.clone()).or(bundle_id.clone()).unwrap_or_else(|| "Unknown app".into());
    let mut ctx = TextContext { app_name, bundle_id: bundle_id.clone(), window_title: None, selected_text: None, url: None };
    // An excluded app gives its name and nothing else: no title, URL or selection.
    if screen_ask::is_excluded(bundle_id.as_deref(), &settings) {
        return Ok(refused(&ctx, "app_excluded", None));
    }
    let secure = run(Duration::from_secs(3), |u| Ok(uia::keyboard_focus(u).1)).unwrap_or(false);
    ctx.window_title = screen_ask::title(target_info.as_ref().map(|w| w.title.as_str()));
    let mut extras = None;
    if let Some(app) = app.clone() {
        let hwnd = target_info.as_ref().map(|w| w.hwnd);
        let browser = fixed_caps::category(app.bundle_id.as_deref()) == Some(fixed_caps::Category::Browser);
        let uipi_ok = apps::check_uipi(&app).is_ok();
        if uipi_ok {
            let r = run(Duration::from_secs(6), move |u| {
                let sel = if secure { None } else { selection_on(u, &app, hwnd) };
                let url = match (browser, hwnd) {
                    (true, Some(h)) => browser_url_on(u, h, app.pid),
                    _ => None,
                };
                Ok((sel, url, win_extras_on(u, &app, hwnd)))
            });
            if let Ok((sel, url, ex)) = r {
                ctx.selected_text = sel;
                ctx.url = url;
                extras = Some(ex);
            }
        }
    }
    if secure {
        return Ok(refused(&ctx, "secure_field", extras));
    }
    if !region && target.is_none() {
        return Ok(refused(&ctx, "no_window", extras));
    }
    if apps::secure_desktop_active() {
        return Ok(refused(&ctx, "secure_field", extras));
    }
    let max_w = p.max_width.map(|v| v.clamp(320, 2560) as u32).unwrap_or(screen_ask::DEFAULT_MAX_WIDTH);
    let max_h = p.max_height.map(|v| v.clamp(240, 1600) as u32).unwrap_or(screen_ask::DEFAULT_MAX_HEIGHT);
    let frame = if region {
        let monitors = capture::monitors();
        let rects: Vec<crate::snapshot::Rect> = monitors.iter().map(|m| m.rect).collect();
        let Some((i, local)) = screen_ask::region(rect.unwrap(), &rects) else { return Ok(refused(&ctx, "no_window", extras)) };
        let m = monitors[i].clone();
        let excluded: HashSet<u32> = apps::windowed_apps()
            .into_iter()
            .filter(|a| psyche.contains(&a.pid) || screen_ask::is_excluded(a.bundle_id.as_deref(), &settings))
            .map(|a| a.pid)
            .chain(psyche.iter().copied())
            .collect();
        let m2 = m.clone();
        let mut frame = match run(CAPTURE_TIMEOUT, move |_| capture::capture_monitor(&m2, false)) {
            Ok(f) => f,
            Err(_) => return Ok(refused(&ctx, "permission_missing", extras)),
        };
        for r in hygiene::redactions(&refs, &excluded, m.rect) {
            frame.fill_black(crate::snapshot::Rect::new(r.x - m.rect.x, r.y - m.rect.y, r.w, r.h));
        }
        frame.crop(local)
    } else {
        let hwnd = target.as_ref().map(|t| t.id).unwrap_or(0);
        match run(CAPTURE_TIMEOUT, move |_| capture::capture_window(hwnd, false)) {
            Ok(f) => f,
            Err(_) => return Ok(refused(&ctx, "permission_missing", extras)),
        }
    };
    let (w, h) = hygiene::scaled_size(frame.width, frame.height, max_w, max_h);
    let (data, _, w, h) = run(CAPTURE_TIMEOUT, move |_| capture::encode(&frame, w, h, false))?;
    let mut o = json!({"context": ctx.json(), "width": w, "height": h, "image": b64(&data)});
    if let Some(e) = extras {
        o["win"] = e;
    }
    Ok(CapOutput::plain(o))
}

// MARK: - Dispatch

/// Runs one capability. The node core should call this (it carries the receipt draft).
pub fn invoke(name: &str, params: &Value, inv: &Invocation) -> CapResult<CapOutput> {
    com::ensure_dpi_awareness();
    let c = cu();
    let body = || -> CapResult<CapOutput> {
        match name {
            "computer.ax_tree" => ax_tree(c, inv, params),
            "computer.check_target" => check_target(c, inv, params),
            "computer.ax_value" => ax_value(c, inv, params),
            "computer.click" => click(c, inv, params, 1, false),
            "computer.double_click" => click(c, inv, params, 2, false),
            "computer.right_click" => click(c, inv, params, 1, true),
            "computer.press" => press(c, inv, params),
            "computer.set_value" => set_value(c, inv, params),
            "computer.select" => select(c, inv, params),
            "computer.type" => type_text(c, inv, params),
            "computer.key" => key(c, inv, params),
            "computer.scroll" => scroll(c, inv, params),
            "computer.drag" => drag(c, inv, params),
            "computer.menu" => menu_cap(c, inv, params),
            "computer.end_session" => end_session(c, params),
            "computer.screenshot" => screenshot(c, inv, params),
            "computer.screenshot_pick" => screenshot_pick(params),
            "screen.context" => screen_context(params),
            _ => Err(CapError::new(code::NOT_IMPLEMENTED, "unknown_capability", "No such capability")),
        }
    };
    // Computer-use bodies run as one stoppable invocation (Esc stops it, not later ones).
    if name.starts_with("computer.") && name != "computer.screenshot" && name != "computer.screenshot_pick" {
        c.stop.run(inv.cancel.clone(), body)
    } else {
        body()
    }
}
