//! The capabilities: ports of the Mac helper's `ComputerCapabilities.swift` and `Screenshots.swift`
//! (through the Windows crate), with the same checks in the same order
//! (session -> app -> tier / approval binding -> expectation -> risky label -> act -> verify) and
//! the same result shapes. Generic over a [`Backend`], so every check is unit-tested against a
//! fake desktop and runs unchanged on X11, a portal session and wlroots.
//!
//! **Below the model.** The engine is the dispatch layer: password fields (`PASSWORD_TEXT`) are
//! refused here and redacted from snapshots and screenshots whatever the Gateway sent; fixed caps
//! and tiers are applied again; a point must land in the app the approval named; keyboard input
//! goes only to the app's own focus and stops the moment focus leaves it.

use crate::backend::{ActError, AppInfo, Backend, ElementData, Frame, WinInfo};
use crate::error::{code, CapError, CapResult};
use crate::hygiene::{self, AppRef};
use crate::keychord::{send_keys, KeyChord, Mods};
use crate::snapshot::{
    text, Expectation, HeaderIdentity, Rect, RefTable, Resolution, Selector, Snapshot, SnapshotBuilder, SnapshotNode, SnapshotOptions,
};
use crate::tiers::{fixed_caps, risk_labels, ApprovalBinding, Intent, SessionLock, StopSignal, TierPolicy, TierSettings};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

// --- Receipts and outputs ------------------------------------------------------------------------

/// The node-side half of a `Receipt` (Mac `ReceiptDraft`).
#[derive(Debug, Clone, PartialEq)]
pub struct ReceiptDraft {
    /// `ok` | `failed` | `uncertain`.
    pub outcome: &'static str,
    pub summary: String,
    pub external_refs: Map<String, Value>,
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

struct Outcome {
    status: &'static str, // ok | unverified | ineffective
    method: &'static str, // ax | input | menu | keyboard
    detail: Option<String>,
    ref_: Option<String>,
    app: AppInfo,
}

impl Outcome {
    fn new(status: &'static str, method: &'static str, detail: Option<String>, ref_: Option<String>, app: &AppInfo) -> Outcome {
        Outcome { status, method, detail, ref_, app: app.clone() }
    }

    fn output(self, verb: &str) -> CapOutput {
        let mut o = Map::new();
        o.insert("status".into(), json!(self.status));
        o.insert("method".into(), json!(self.method));
        o.insert("app".into(), json!(self.app.id));
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
        refs.insert("app".into(), json!(self.app.id));
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

// --- Errors shared by several capabilities -----------------------------------------------------

fn stale(r: &str) -> CapError {
    CapError::new(code::NOT_FOUND, "stale_ref", format!("{r} no longer exists. Take a new snapshot with computer.ax_tree; refs are never reused."))
        .detail("ref", r)
}

fn not_responding(app: &str) -> CapError {
    CapError::unavailable("app_not_responding", format!("{app} is not responding")).retryable()
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

// --- The engine --------------------------------------------------------------------------------

/// A ref resolved to a live element, its owner and what it looks like now.
#[derive(Clone)]
struct Resolved<E> {
    element: E,
    ref_: String,
    data: ElementData,
    role_name: String,
    label: Option<String>,
    app: AppInfo,
}

type UserStopFn = Box<dyn Fn(Option<String>) + Send + Sync>;

/// Shared state for computer use: the backend, tier policy, session lock, stop signal and refs.
pub struct Engine<B: Backend> {
    pub backend: Arc<B>,
    pub policy: TierPolicy,
    pub sessions: SessionLock,
    pub stop: StopSignal,
    refs: Mutex<RefTable<B::Element>>,
    last: Mutex<(Vec<SnapshotNode>, SnapshotOptions)>,
    primed: Mutex<HashSet<u32>>,
    settings_path: PathBuf,
    on_user_stop: Mutex<Option<UserStopFn>>,
    own_pid: u32,
}

const SNAPSHOT_BUDGET: Duration = Duration::from_secs(12);

impl<B: Backend> Engine<B> {
    pub fn new(backend: Arc<B>, settings_path: PathBuf) -> Arc<Engine<B>> {
        let policy = TierPolicy::new(TierSettings::load(&settings_path), None, None);
        let b2 = backend.clone();
        let engine = Arc::new(Engine {
            backend,
            policy,
            sessions: SessionLock::new(120.0, None),
            stop: StopSignal::new(),
            refs: Mutex::new(RefTable::default()),
            last: Mutex::new((Vec::new(), SnapshotOptions::default())),
            primed: Mutex::new(HashSet::new()),
            settings_path,
            on_user_stop: Mutex::new(None),
            own_pid: std::process::id(),
        });
        // The owner's last input comes from the backend's stop source (X11) or is unknown.
        let weak = Arc::downgrade(&engine);
        b2.start_stop_source(Box::new(move || {
            if let Some(e) = weak.upgrade() {
                e.user_stopped();
            }
        }));
        engine
    }

    /// Told (on a helper thread) when the owner stopped computer use.
    pub fn set_on_user_stop(&self, f: impl Fn(Option<String>) + Send + Sync + 'static) {
        *self.on_user_stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(f));
    }

    /// The Stop: Escape on X11, the portal's `Closed` on Wayland. Cancels the in-flight action
    /// and ends the session for good.
    pub fn user_stopped(&self) {
        self.stop.trip();
        let stopped = self.sessions.stop_active();
        if let Some(f) = self.on_user_stop.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            f(stopped);
        }
    }

    pub fn reload_settings(&self) {
        self.policy.update(TierSettings::load(&self.settings_path));
    }

    /// Session lock for one mutating call. The Gateway must name the session (the run id).
    fn begin_action(&self, session: Option<&str>) -> CapResult<()> {
        match session {
            Some(s) if !s.is_empty() && s.chars().count() <= 128 => {
                self.reload_settings();
                self.backend.check_desktop()?;
                self.sessions.acquire(s)
            }
            _ => Err(CapError::invalid_params("session (the run id) is required for computer actions", Some("session"))),
        }
    }

    fn binding(&self, inv: &Invocation, params: &Value) -> Option<ApprovalBinding> {
        ApprovalBinding::from(inv.approval_id.as_deref(), params)
    }

    // --- Apps -------------------------------------------------------------------------------

    /// The app a call names (id or display name), else the focused one.
    pub fn find_app(&self, named: Option<&str>, pid: Option<i64>) -> CapResult<AppInfo> {
        let apps = self.backend.apps();
        if let Some(pid) = pid {
            return apps
                .into_iter()
                .find(|a| i64::from(a.pid) == pid)
                .ok_or_else(|| CapError::new(code::NOT_FOUND, "app_not_running", "No running app has that pid"));
        }
        match named.map(str::trim).filter(|s| !s.is_empty()) {
            Some(q) => {
                let id = crate::app_id::normalize(q);
                apps.iter()
                    .find(|a| a.id == id)
                    .or_else(|| apps.iter().find(|a| a.name.eq_ignore_ascii_case(q)))
                    .cloned()
                    .ok_or_else(|| {
                        CapError::new(code::NOT_FOUND, "app_not_running", format!("{q} is not running. Use apps.open first, or apps.list."))
                            .detail("app", q)
                    })
            }
            None => apps
                .iter()
                .find(|a| a.frontmost)
                .or_else(|| apps.first())
                .cloned()
                .ok_or_else(|| CapError::new(code::NOT_FOUND, "no_app", "No app is open")),
        }
    }

    fn app_for_pid(&self, pid: u32) -> Option<AppInfo> {
        self.backend.apps().into_iter().find(|a| a.pid == pid)
    }

    // --- Refs -------------------------------------------------------------------------------

    fn resolve(&self, r: &str) -> CapResult<Resolved<B::Element>> {
        let element = self
            .refs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .element(r)
            .ok_or_else(|| {
                CapError::new(
                    code::NOT_FOUND,
                    "unknown_ref",
                    format!("Unknown ref {r}. Take a new snapshot with computer.ax_tree; refs are never reused."),
                )
                .detail("ref", r)
            })?;
        let data = self.backend.data(&element).ok_or_else(|| stale(r))?;
        // The element's owner decides the tier: a ref never carries one app's approval to another.
        let app = self.app_for_pid(data.pid).ok_or_else(|| stale(r))?;
        let options = self.last.lock().unwrap_or_else(|e| e.into_inner()).1.clone();
        let mut scratch = RefTable::default();
        let label = SnapshotBuilder::new(&*self.backend, &mut scratch, options, None).label_for(&element);
        let ax = crate::roles::map_role(&data.facts);
        Ok(Resolved { role_name: text::role_name(ax.role, ax.subrole), label, data, element, ref_: r.to_string(), app })
    }

    fn resolve_selector(&self, sel: &Selector) -> CapResult<String> {
        let last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        match sel.resolve(&last.0) {
            Resolution::Ref(r) => Ok(r),
            Resolution::None => Err(CapError::new(code::NOT_FOUND, "selector_no_match", "No element in the last snapshot matches the selector exactly")),
            Resolution::Ambiguous(refs) => {
                Err(CapError::new(code::CONFLICT, "selector_ambiguous", "The selector matches several elements; use a ref").detail("candidates", json!(refs)))
            }
        }
    }

    // --- Snapshots --------------------------------------------------------------------------

    fn snapshot_on(&self, app: &AppInfo, window: Option<usize>, root: Option<&str>, options: SnapshotOptions) -> CapResult<Snapshot> {
        let b = &*self.backend;
        let windows = b.window_elements(app);
        let no_window = || CapError::new(code::NOT_FOUND, "no_window", format!("{} has no open window. Use root: \"app\" for menus and popups.", app.name));
        let root_el = match root {
            None | Some("window") => match window {
                Some(i) => windows.get(i).cloned().ok_or_else(no_window)?,
                None => windows.first().cloned().ok_or_else(no_window)?,
            },
            Some("app") => b.app_element(app),
            Some(r) => {
                let el = self.resolve(r)?;
                // A ref from another app must not bypass that app's tier.
                if el.app.pid != app.pid {
                    return Err(CapError::new(code::INVALID_PARAMS, "ref_other_app", format!("{r} belongs to {}, not {}", el.app.name, app.name)));
                }
                el.element
            }
        };
        if app.electron && self.primed.lock().unwrap_or_else(|e| e.into_inner()).insert(app.pid) {
            // Chromium builds its tree lazily once an assistive technology is announced; give it
            // a moment after the first snapshot request.
            b.pause(300, &self.stop).ok();
        }
        let focused = b.focused_element(Some(app));
        b.begin_walk(SNAPSHOT_BUDGET);
        let snap = {
            let mut refs = self.refs.lock().unwrap_or_else(|e| e.into_inner());
            SnapshotBuilder::new(b, &mut refs, options.clone(), focused).snapshot(
                &root_el,
                HeaderIdentity { app: &app.name, pid: app.pid, bundle_id: Some(&app.id), electron: app.electron },
                &[],
            )
        };
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = (snap.nodes.clone(), options);
        Ok(snap)
    }

    // --- Shared checks ----------------------------------------------------------------------

    /// Resolves the target element, checks the session, tier, expectation and risk.
    fn element(&self, inv: &Invocation, params: &Value, t: &TargetParams, intent: Intent, custom: Option<&str>) -> CapResult<Resolved<B::Element>> {
        self.begin_action(t.session.as_deref())?;
        let r = match (&t.ref_, &t.selector) {
            (Some(r), _) => r.clone(),
            (None, Some(sel)) => self.resolve_selector(sel)?,
            _ => return Err(CapError::invalid_params("ref or selector is required", Some("ref"))),
        };
        let el = self.resolve(&r)?;
        // A click or press on a menu-like element runs an app command (#266).
        let intent = intent.escalated(Some(ax_role_of(&el.data)));
        self.policy.authorize(intent, Some(&el.app.id), &el.app.name, self.binding(inv, params).as_ref())?;
        let expect = t
            .expect
            .as_ref()
            .ok_or_else(|| CapError::invalid_params("expect {role, label} from the snapshot is required with a ref", Some("expect")))?;
        let value = self.backend.current_value(&el.element);
        let secure = is_secure(&el.data);
        if let Some(why) = expect.mismatch(&el.role_name, el.label.as_deref(), if secure { None } else { value.as_deref() }) {
            return Err(CapError::new(code::CONFLICT, "expectation_failed", format!("{r} changed: {why}. Take a new snapshot."))
                .detail("ref", r.as_str())
                .detail("role", el.role_name.as_str())
                .detail("label", el.label.clone().map(Value::String).unwrap_or(Value::Null)));
        }
        if intent != Intent::Read && self.binding(inv, params).is_none() && risk_labels::is_risky(el.label.as_deref(), custom) {
            return Err(CapError::new(code::APPROVAL_REQUIRED, "risky_label", "This control may delete, send or create data; this action needs approval.")
                .detail("label", el.label.clone().or(custom.map(str::to_string)).unwrap_or_default())
                .detail("app", el.app.id.as_str()));
        }
        Ok(el)
    }

    /// Point target: authorizes the app under the point. Returns (x, y, app).
    fn point(&self, inv: &Invocation, params: &Value, t: &TargetParams, intent: Intent) -> CapResult<(f64, f64, AppInfo)> {
        self.begin_action(t.session.as_deref())?;
        let (Some(x), Some(y)) = (t.x.filter(|v| v.is_finite()), t.y.filter(|v| v.is_finite())) else {
            return Err(CapError::invalid_params("ref, selector or x/y is required", Some("ref")));
        };
        let named = t
            .app
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CapError::invalid_params("app (the desktop file id the point is in) is required with x/y", Some("app")))?;
        let named_id = crate::app_id::normalize(named);
        let app = if self.backend.window_geometry_known() {
            let win = self.window_at(x, y).ok_or_else(|| CapError::new(code::NOT_FOUND, "nothing_at_point", format!("No app owns the point {},{}", x as i64, y as i64)))?;
            let app = self.app_for_pid(win.pid).ok_or_else(|| CapError::new(code::NOT_FOUND, "nothing_at_point", format!("No app owns the point {},{}", x as i64, y as i64)))?;
            // The point must land in the app the call (and its approval) named (#267).
            if app.id != named_id {
                return Err(CapError::new(code::POLICY_DENIED, "app_mismatch", format!("The point is in {}, not {named}", app.name))
                    .detail("app", named)
                    .detail("appAtPoint", app.id.as_str()));
            }
            app
        } else {
            // The desktop does not tell clients where windows are (GNOME on Wayland), so the app
            // under a point cannot be verified. Allow it only into the focused app, and only with
            // an approval that names that app (the Gateway treats a bare point as risky anyway).
            let app = self.find_app(Some(named), None)?;
            if !self.backend.windows().iter().any(|w| w.focused && w.pid == app.pid) {
                return Err(CapError::new(
                    code::CONFLICT,
                    "focus_moved",
                    format!("{} is not the focused app, and this desktop cannot say which app is under a point", app.name),
                )
                .retryable());
            }
            if self.binding(inv, params).is_none() {
                return Err(CapError::new(
                    code::APPROVAL_REQUIRED,
                    "point_unverified",
                    "This desktop cannot say which app is under a screen point, so a click at a point needs approval.",
                )
                .detail("app", app.id.as_str())
                .detail("label", "a point on the screen"));
            }
            app
        };
        let role = self.backend.hit_test(x, y).and_then(|h| h.role);
        let intent = intent.escalated(role.as_deref());
        self.policy.authorize(intent, Some(&app.id), &app.name, self.binding(inv, params).as_ref())?;
        Ok((x, y, app))
    }

    fn window_at(&self, x: f64, y: f64) -> Option<WinInfo> {
        self.backend.windows().into_iter().find(|w| !w.minimized && w.bounds.is_some_and(|b| b.contains(x, y)))
    }

    /// Keyboard input goes only to `app`'s own focused element.
    fn ensure_keyboard_target(&self, app: &AppInfo) -> CapResult<()> {
        if let Some(p) = self.backend.keyboard_focus_pid() {
            if !app.owns(p) {
                return Err(CapError::new(code::CONFLICT, "focus_moved", format!("Keyboard focus is no longer in {}; input stopped", app.name)).retryable());
            }
        }
        Ok(())
    }

    /// Hit-tests a point before synthetic mouse input: it must land in `app` (and, for a ref, on
    /// that element or inside it), and on nothing secure or risky without approval.
    fn check_hit(&self, x: f64, y: f64, app: &AppInfo, el: Option<&Resolved<B::Element>>, approved: bool) -> CapResult<()> {
        let Some(hit) = self.backend.hit_test(x, y) else {
            // Without a hit test (no geometry) the caller already required an approval or acts
            // by ref on an element the tree placed there.
            return if self.backend.window_geometry_known() {
                Err(CapError::new(code::CONFLICT, "hit_test_failed", format!("Nothing to click at {},{}", x as i64, y as i64)))
            } else {
                Ok(())
            };
        };
        if hit.pid != app.pid {
            return Err(CapError::new(
                code::CONFLICT,
                "occluded",
                format!("Another window covers the target at {},{}; bring {} forward and re-snapshot", x as i64, y as i64, app.name),
            ));
        }
        if hit.secure {
            return Err(CapError::secure_refusal());
        }
        if el.is_none() && !approved && hit.labels.iter().any(|l| risk_labels::is_risky(Some(l), None)) {
            return Err(CapError::new(code::APPROVAL_REQUIRED, "risky_label", "The control at this point may delete, send or create data; this click needs approval."));
        }
        Ok(())
    }

    /// Screen centre of the element's frame. "No position" is an error the caller can route around.
    fn center(&self, el: &Resolved<B::Element>) -> CapResult<(f64, f64)> {
        match self.backend.frame(&el.element) {
            Some(f) if f.w > 0.0 && f.h > 0.0 && f.is_finite() && (f.x != 0.0 || f.y != 0.0 || self.backend.window_geometry_known()) => {
                Ok((f.mid_x(), f.mid_y()))
            }
            _ => Err(CapError::new(
                code::UNAVAILABLE,
                "no_position",
                format!("{} has no known position on this desktop; use a keyboard route (computer.press, computer.key) or pick a point from computer.screenshot", el.ref_),
            )),
        }
    }

    // --- Capabilities -----------------------------------------------------------------------

    fn ax_tree(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let p: SnapshotParams = decode(params)?;
        self.reload_settings();
        self.backend.check_desktop()?;
        let app = self.find_app(p.app.as_deref(), p.pid)?;
        self.policy.authorize(Intent::Read, Some(&app.id), &app.name, self.binding(inv, params).as_ref())?;
        let options = SnapshotOptions::clamped(p.max_visit, p.max_emit, p.text_max, p.value_max, p.clip);
        if p.window.is_some_and(|w| w < 0) {
            return Err(CapError::invalid_params("window must be >= 0", Some("window")));
        }
        let snap = self.snapshot_on(&app, p.window.map(|w| w as usize), p.root.as_deref(), options)?;
        let mut result = Map::new();
        result.insert("text".into(), json!(snap.render()));
        result.insert("header".into(), serde_json::to_value(&snap.header).unwrap_or(Value::Null));
        result.insert("provenance".into(), json!("untrusted"));
        result.insert("tier".into(), json!(self.policy.effective_tier(Some(&app.id)).as_str()));
        if p.format.as_deref() == Some("json") {
            result.insert("nodes".into(), serde_json::to_value(&snap.nodes).unwrap_or(json!([])));
        }
        if !self.backend.window_geometry_known() {
            result.insert(
                "positions".into(),
                json!("unknown: this desktop does not tell apps where their windows are; refs without an action are marked no-position"),
            );
        }
        if app.electron && (!snap.nodes.iter().any(|n| n.role == "webarea") || snap.nodes.len() < 10) {
            result.insert("hint".into(), json!("sparse_tree: bring the window to the front and retry, or use computer.screenshot"));
        }
        if snap.nodes.is_empty() {
            result.insert("hint".into(), json!(format!("{} exposes no accessibility tree (a toolkit without AT-SPI, or an app opened before Computer use was turned on); restart it, or use computer.screenshot", app.name)));
        }
        Ok(CapOutput::plain(Value::Object(result)))
    }

    fn check_target(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let p: CheckTargetParams = decode(params)?;
        let menu_path = p.menu_path.clone().unwrap_or_default();
        let is_menu = !menu_path.is_empty();
        if !is_menu && p.role.as_deref().unwrap_or("").is_empty() {
            return Err(CapError::invalid_params("role is required", Some("role")));
        }
        self.reload_settings();
        self.backend.check_desktop()?;
        let app = self.find_app(p.app.as_deref(), None)?;
        self.policy.authorize(Intent::Read, Some(&app.id), &app.name, self.binding(inv, params).as_ref())?;
        let options = SnapshotOptions::clamped(Some(8000), Some(2000), Some(400), Some(20), Some(true));
        let snap = self.snapshot_on(&app, None, is_menu.then_some("app"), options)?;
        let reply = |status: &str, extra: Vec<(&str, Value)>| {
            let mut o = Map::new();
            o.insert("status".into(), json!(status));
            o.insert("app".into(), json!(app.id));
            o.insert("stop".into(), json!(status != "found"));
            o.insert("provenance".into(), json!("untrusted"));
            for (k, v) in extra {
                o.insert(k.into(), v);
            }
            Ok(CapOutput::plain(Value::Object(o)))
        };
        // The app that answered is not the one the recording was made in: a stop.
        if let Some(wanted) = p.app.as_deref().map(crate::app_id::normalize).filter(|w| crate::app_id::is_app_id(w) && w.contains('.')) {
            if wanted != app.id {
                return reply("wrong_app", vec![("hint", json!("This is not the app the recording was made in. Ask the owner."))]);
            }
        }
        let query = crate::target_check::Query { role: p.role, name: p.name, identifier: p.identifier, menu_path };
        let mut outcome = crate::target_check::check(&snap.nodes, &query);
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
            crate::target_check::Outcome::Ambiguous(refs) => {
                reply("ambiguous", vec![("candidates", json!(refs)), ("hint", json!("Several elements match; do not pick one. Ask the owner."))])
            }
            crate::target_check::Outcome::Missing => reply("missing", vec![("hint", json!("The recorded element is not in the window. Ask the owner what to do."))]),
        }
    }

    fn ax_value(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let p: ValueParams = decode(params)?;
        let el = self.resolve(&p.ref_)?;
        self.policy.authorize(Intent::Read, Some(&el.app.id), &el.app.name, self.binding(inv, params).as_ref())?;
        if is_secure(&el.data) {
            return Err(CapError::secure_refusal());
        }
        let max = p.max.unwrap_or(50_000).clamp(1, 200_000) as usize;
        let value = self.backend.full_value(&el.element, max);
        Ok(CapOutput::plain(json!({"ref": p.ref_, "role": el.role_name, "value": value, "provenance": "untrusted"})))
    }

    fn click(&self, inv: &Invocation, params: &Value, count: u32, right: bool) -> CapResult<CapOutput> {
        let verb = if right { "right-click" } else if count == 2 { "double-click" } else { "click" };
        let p: ClickParams = decode(params)?;
        let mods = modifier_flags(&p.modifiers)?;
        let intent = if right {
            Intent::RightClick
        } else if mods.is_empty() {
            Intent::Click
        } else {
            Intent::ModifierClick
        };
        let approved = inv.approval_id.is_some();
        let b = &*self.backend;
        if p.t.ref_.is_some() || p.t.selector.is_some() {
            let el = self.element(inv, params, &p.t, intent, None)?;
            if is_secure(&el.data) {
                return Err(CapError::secure_refusal());
            }
            // 1. Semantic accessibility action first (no coordinates needed).
            let actions = crate::roles::actions(&el.data.facts, ax_role_of(&el.data));
            let semantic = if count == 1 && !right && mods.is_empty() && actions.iter().any(|a| a == "AXPress") {
                Some(("AXPress", "press; re-snapshot to confirm the effect"))
            } else if right && count == 1 && mods.is_empty() && actions.iter().any(|a| a == "AXShowMenu") {
                Some(("AXShowMenu", "show menu"))
            } else {
                None
            };
            if let Some((action, detail)) = semantic {
                match b.perform(&el.element, action) {
                    Ok(()) => return Ok(Outcome::new("ok", "ax", Some(detail.into()), Some(el.ref_.clone()), &el.app).output(verb)),
                    Err(e) if e.not_responding => return Err(not_responding(&el.app.name)),
                    Err(_) => {}
                }
            }
            // 2. A pointer click at the frame centre, app in front.
            match self.center(&el) {
                Ok((x, y)) => {
                    b.activate(&el.app, None, &self.stop)?;
                    self.check_hit(x, y, &el.app, Some(&el), approved)?;
                    b.click(x, y, count, right, mods, &self.stop)?;
                    Ok(Outcome::new("ok", "input", Some(format!("mouse {verb} at the element centre")), Some(el.ref_.clone()), &el.app).output(verb))
                }
                Err(no_pos) => {
                    // 3. No position (GNOME on Wayland): keyboard focus and Space, for plain
                    // clicks on controls that Space activates, verified by the focus landing there.
                    let simple = count == 1 && !right && mods.is_empty();
                    let space_ok = matches!(ax_role_of(&el.data), "AXButton" | "AXCheckBox" | "AXRadioButton");
                    if simple && space_ok && b.set_focus(&el.element).is_ok() {
                        b.pause(60, &self.stop)?;
                        if b.focused_element(Some(&el.app)).as_ref() == Some(&el.element) && !b.focused_is_secure(Some(&el.app)) {
                            self.ensure_keyboard_target(&el.app)?;
                            b.key(&KeyChord::parse("space")?, &self.stop)?;
                            return Ok(Outcome::new("unverified", "keyboard", Some("focused the control and pressed Space; re-snapshot to confirm".into()), Some(el.ref_.clone()), &el.app).output(verb));
                        }
                    }
                    Err(no_pos)
                }
            }
        } else {
            let (x, y, app) = self.point(inv, params, &p.t, intent)?;
            b.activate(&app, None, &self.stop)?;
            self.check_hit(x, y, &app, None, approved)?;
            b.click(x, y, count, right, mods, &self.stop)?;
            Ok(Outcome::new("ok", "input", Some(format!("mouse {verb} at {},{}", x as i64, y as i64)), None, &app).output(verb))
        }
    }

    fn press(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let p: PressParams = decode(params)?;
        let custom = p.action.strip_prefix("custom:").map(str::to_string);
        let mut intent = if p.action == "press" { Intent::Press } else { Intent::Menu };
        if intent == Intent::Press && p.t.selector.as_ref().and_then(|s| s.role.as_deref()).is_some_and(|r| r.starts_with("menu") || r == "popupbutton") {
            intent = Intent::Menu;
        }
        let el = self.element(inv, params, &p.t, intent, custom.as_deref())?;
        if is_secure(&el.data) {
            return Err(CapError::secure_refusal());
        }
        let raw = crate::roles::actions(&el.data.facts, ax_role_of(&el.data));
        if custom.is_some() {
            return Err(CapError::new(code::NOT_FOUND, "action_not_supported", format!("{} has no such custom action", el.ref_)));
        }
        let Some(ax) = press_action(&p.action).filter(|a| raw.iter().any(|r| r == a)) else {
            return Err(CapError::new(code::NOT_FOUND, "action_not_supported", format!("{} does not support {}", el.ref_, p.action)).detail("actions", json!(raw)));
        };
        match self.backend.perform(&el.element, ax) {
            Ok(()) => Ok(Outcome::new("ok", "ax", Some(format!("{}; re-snapshot to confirm the effect", p.action)), Some(el.ref_.clone()), &el.app).output(&p.action)),
            Err(e) if e.not_responding => Err(not_responding(&el.app.name)),
            Err(e) => Ok(Outcome::new("ineffective", "ax", Some(e.detail), Some(el.ref_.clone()), &el.app).output(&p.action)),
        }
    }

    /// Read back with backoff (providers like Chromium's can apply writes asynchronously).
    fn verify(&self, el: &Resolved<B::Element>, check: impl Fn(Option<&str>) -> bool) -> CapResult<Option<String>> {
        let waits = [50u64, 100, 200, 400];
        let totals = [50u64, 150, 350, 750];
        for (i, w) in waits.iter().enumerate() {
            self.backend.pause(*w, &self.stop)?;
            let now = self.backend.current_value(&el.element);
            if check(now.as_deref()) {
                return Ok(Some(format!("verified after {} ms", totals[i])));
            }
        }
        Ok(None)
    }

    fn set_value(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let p: SetParams = decode(params)?;
        let el = self.element(inv, params, &p.t, Intent::SetValue, None)?;
        if is_secure(&el.data) {
            return Err(CapError::secure_refusal());
        }
        if !crate::roles::value_settable(&el.data.facts) {
            return Err(CapError::new(
                code::CONFLICT,
                "not_settable",
                format!("{} ({}) has no settable value; click it and use computer.type", el.ref_, el.role_name),
            ));
        }
        if let Err(e) = self.backend.set_value(&el.element, &p.value) {
            return Ok(Outcome::new("ineffective", "ax", Some(e.detail), Some(el.ref_.clone()), &el.app).output("set value"));
        }
        let want = p.value.clone();
        let want_num: Option<f64> = want.trim().parse().ok();
        if let Some(how) = self.verify(&el, |now| now == Some(want.as_str()) || (want_num.is_some() && now.and_then(|n| n.parse::<f64>().ok()) == want_num))? {
            return Ok(Outcome::new("ok", "ax", Some(how), Some(el.ref_.clone()), &el.app).output("set value"));
        }
        Ok(Outcome::new("unverified", "ax", Some("read-back did not match after 750 ms".into()), Some(el.ref_.clone()), &el.app).output("set value"))
    }

    fn select(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let t: TargetParams = decode(params)?;
        let el = self.element(inv, params, &t, Intent::Click, None)?;
        if !el.data.facts.selectable && !el.data.facts.has_selection_parent {
            return Err(CapError::new(code::CONFLICT, "not_selectable", format!("{} cannot be selected through AT-SPI; use computer.click", el.ref_)));
        }
        if let Err(e) = self.backend.select(&el.element) {
            return Ok(Outcome::new("ineffective", "ax", Some(e.detail), Some(el.ref_.clone()), &el.app).output("select"));
        }
        self.backend.pause(50, &self.stop)?;
        let selected = self.backend.is_selected(&el.element);
        Ok(Outcome::new(if selected == Some(true) { "ok" } else { "unverified" }, "ax", None, Some(el.ref_.clone()), &el.app).output("select"))
    }

    fn type_text(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let p: TypeParams = decode(params)?;
        if p.text.is_empty() {
            return Err(CapError::invalid_params("text is empty", Some("text")));
        }
        if p.text.contains("{{cred:") {
            return Err(CapError::new(code::POLICY_DENIED, "credential_placeholder", "Credential placeholders are filled by the vault, never typed"));
        }
        let sends_line = send_keys::text_sends(&p.text);
        let (app, ref_) = if p.t.ref_.is_some() || p.t.selector.is_some() {
            let el = self.element(inv, params, &p.t, Intent::Type, None)?;
            if is_secure(&el.data) {
                return Err(CapError::secure_refusal());
            }
            let _ = self.backend.set_focus(&el.element);
            (el.app.clone(), Some(el.ref_.clone()))
        } else {
            self.begin_action(p.t.session.as_deref())?;
            let app = self.find_app(p.t.app.as_deref(), None)?;
            self.policy.authorize(Intent::Type, Some(&app.id), &app.name, self.binding(inv, params).as_ref())?;
            (app, None)
        };
        // #270: a line break in typed text presses Return, which sends in messaging and mail apps.
        if sends_line && send_keys::is_messaging_app(Some(&app.id)) && self.binding(inv, params).is_none() {
            return Err(CapError::new(code::APPROVAL_REQUIRED, "send_text", format!("Typing a line break sends in {}; sending needs your approval", app.name))
                .detail("app", app.id.as_str())
                .detail("sideEffect", "destructive"));
        }
        self.backend.activate(&app, None, &self.stop)?;
        // Checked before every chunk: Tab / Return can move focus (into a password field, or out
        // of the app), and the dispatch layer refuses secure fields below the model.
        if self.backend.focused_is_secure(Some(&app)) {
            return Err(CapError::secure_refusal());
        }
        let a = app.clone();
        self.backend.type_text(&p.text, &self.stop, &mut || {
            self.ensure_keyboard_target(&a)?;
            if self.backend.focused_is_secure(Some(&a)) {
                return Err(CapError::secure_refusal());
            }
            Ok(())
        })?;
        let n = unicode_segmentation::UnicodeSegmentation::graphemes(p.text.as_str(), true).count();
        Ok(Outcome::new("ok", "input", Some(format!("typed {n} characters")), ref_, &app).output("type"))
    }

    fn key(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let p: KeyParams = decode(params)?;
        let chord = KeyChord::parse(&p.keys)?;
        self.begin_action(p.session.as_deref())?;
        let app = self.find_app(p.app.as_deref(), None)?;
        self.policy.authorize(Intent::Key, Some(&app.id), &app.name, self.binding(inv, params).as_ref())?;
        if send_keys::is_messaging_app(Some(&app.id)) && send_keys::is_send_chord(&chord) && self.binding(inv, params).is_none() {
            return Err(CapError::new(code::APPROVAL_REQUIRED, "send_key", format!("That key sends in {}; sending needs your approval", app.name))
                .detail("app", app.id.as_str())
                .detail("sideEffect", "destructive"));
        }
        if chord.is_high_risk_in(Some(&app.id)) && self.binding(inv, params).is_none() {
            return Err(CapError::new(code::APPROVAL_REQUIRED, "risky_chord", "That chord can close windows, quit apps or delete; it needs approval"));
        }
        self.backend.activate(&app, None, &self.stop)?;
        // Esc and Tab may leave a password field; nothing else may be pressed while one has focus.
        if self.backend.focused_is_secure(Some(&app)) && !chord.is_bare_escape() && chord.keysym != crate::keychord::keysym::TAB {
            return Err(CapError::secure_refusal());
        }
        for _ in 0..p.repeat_count.unwrap_or(1).clamp(1, 50) {
            self.ensure_keyboard_target(&app)?;
            if !chord.is_escape_or_tab() && self.backend.focused_is_secure(Some(&app)) {
                return Err(CapError::secure_refusal());
            }
            self.backend.key(&chord, &self.stop)?;
        }
        Ok(Outcome::new("ok", "input", Some(p.keys.clone()), None, &app).output(&format!("key {}", p.keys)))
    }

    fn scroll(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let p: ScrollParams = decode(params)?;
        let dx = p.dx.unwrap_or(0).clamp(-200, 200) as i32;
        let dy = p.dy.unwrap_or(0).clamp(-200, 200) as i32;
        let (x, y, app, ref_) = if p.t.ref_.is_some() || p.t.selector.is_some() {
            let el = self.element(inv, params, &p.t, Intent::Scroll, None)?;
            let (x, y) = self.center(&el)?;
            (x, y, el.app.clone(), Some(el.ref_.clone()))
        } else {
            let (x, y, app) = self.point(inv, params, &p.t, Intent::Scroll)?;
            (x, y, app, None)
        };
        if self.backend.window_geometry_known() && self.window_at(x, y).map(|w| w.pid) != Some(app.pid) {
            return Err(CapError::new(code::CONFLICT, "occluded", format!("Another window covers the scroll point; bring {} forward", app.name)));
        }
        self.backend.scroll(x, y, dx, dy, &self.stop)?;
        Ok(Outcome::new("ok", "input", Some(format!("scrolled dx={dx} dy={dy}")), ref_, &app).output("scroll"))
    }

    fn drag(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let p: DragParams = decode(params)?;
        let resolve = |t: &TargetParams| -> CapResult<(f64, f64, AppInfo)> {
            let mut t = t.clone();
            t.session = p.session.clone();
            if t.ref_.is_some() || t.selector.is_some() {
                let el = self.element(inv, params, &t, Intent::Drag, None)?;
                let (x, y) = self.center(&el)?;
                return Ok((x, y, el.app.clone()));
            }
            self.point(inv, params, &t, Intent::Drag)
        };
        let (ax, ay, app_a) = resolve(&p.from)?;
        let (bx, by, app_b) = resolve(&p.to)?;
        if app_a.pid != app_b.pid {
            return Err(CapError::new(code::POLICY_DENIED, "cross_app_drag", "Drags between apps are not allowed"));
        }
        self.backend.activate(&app_a, None, &self.stop)?;
        self.check_hit(ax, ay, &app_a, None, inv.approval_id.is_some())?;
        self.backend.drag((ax, ay), (bx, by), &self.stop)?;
        Ok(Outcome::new("ok", "input", None, None, &app_a).output("drag"))
    }

    /// Walks the app's menu bar by label path, pressing each item (so submenus open).
    fn menu(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let p: MenuParams = decode(params)?;
        let path: Vec<String> = p.path.split('>').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        if path.is_empty() {
            return Err(CapError::invalid_params("path is empty", Some("path")));
        }
        self.begin_action(p.session.as_deref())?;
        let app = self.find_app(p.app.as_deref(), None)?;
        self.policy.authorize(Intent::Menu, Some(&app.id), &app.name, self.binding(inv, params).as_ref())?;
        if inv.approval_id.is_none() && path.iter().any(|s| risk_labels::is_risky(Some(s), None)) {
            return Err(CapError::new(code::APPROVAL_REQUIRED, "risky_label", "That menu item may delete, send or quit; it needs approval"));
        }
        let b = &*self.backend;
        b.begin_walk(Duration::from_secs(10));
        let wins = b.window_elements(app_ref(&app));
        let mut level: Vec<B::Element> = Vec::new();
        for w in &wins {
            if let Some(bar) = find_descendant(b, w, 8, |d| crate::roles::map_role(&d.facts).role == "AXMenuBar") {
                level.push(bar);
            }
        }
        if level.is_empty() {
            return Err(CapError::new(code::NOT_FOUND, "no_menu_bar", format!("{} exposes no menu bar", app.name)));
        }
        let want = |s: &str| crate::target_check::norm(Some(s));
        let mut last_title = String::new();
        for (i, seg) in path.iter().enumerate() {
            let mut hits: Vec<(B::Element, ElementData)> = Vec::new();
            for parent in &level {
                collect_items(b, parent, 3, &mut hits);
            }
            let found: Vec<_> = hits.into_iter().filter(|(e, d)| want(&item_title(b, e, d)) == want(seg)).collect();
            let [(el, data)] = found.as_slice() else {
                return Err(CapError::new(
                    if found.is_empty() { code::NOT_FOUND } else { code::CONFLICT },
                    if found.is_empty() { "menu_item_missing" } else { "menu_item_ambiguous" },
                    format!("Menu item {} was not found exactly once", i + 1),
                ));
            };
            last_title = item_title(b, el, data);
            if is_secure(data) {
                return Err(CapError::secure_refusal());
            }
            b.perform(el, "AXPress").map_err(|e| CapError::new(code::CONFLICT, "menu_press_failed", e.detail))?;
            if i + 1 < path.len() {
                b.pause(150, &self.stop)?;
                // The submenu is a child of the item (or a popup under the app root).
                level = vec![el.clone()];
                let popups = find_descendant(b, &b.app_element(&app), 4, |d| crate::roles::map_role(&d.facts).role == "AXMenu" && d.info.title.is_none());
                if let Some(p) = popups {
                    level.push(p);
                }
            }
        }
        Ok(Outcome::new("ok", "menu", Some(last_title), None, &app).output(&format!("menu {}", p.path)))
    }

    fn end_session(&self, params: &Value) -> CapResult<CapOutput> {
        let p: EndParams = decode(params)?;
        self.sessions.release(p.session.as_deref().unwrap_or("default"));
        if self.sessions.active_session().is_none() {
            self.backend.session_idle();
        }
        Ok(CapOutput::plain(json!({"released": true})))
    }

    // --- Screenshots ------------------------------------------------------------------------

    /// This process and every Psyche app.
    fn psyche_pids(&self) -> HashSet<u32> {
        let mut out = HashSet::from([self.own_pid]);
        for a in self.backend.apps() {
            if fixed_caps::category(Some(&a.id)) == Some(fixed_caps::Category::Psyche) {
                out.insert(a.pid);
            }
        }
        out
    }

    fn screenshot(&self, inv: &Invocation, params: &Value) -> CapResult<CapOutput> {
        let p: ShotParams = decode(params)?;
        self.reload_settings();
        let app = self.find_app(p.app.as_deref(), None)?;
        self.policy.authorize(Intent::Read, Some(&app.id), &app.name, self.binding(inv, params).as_ref())?;
        self.backend.check_desktop()?;
        // Below the model: no capture while any password field has focus.
        if self.backend.focused_is_secure(None) {
            return Err(CapError::new(code::POLICY_DENIED, "secure_field_focused", "A password field has focus; screenshots are suppressed until it loses focus."));
        }
        let running: Vec<AppRef> = self.backend.apps().into_iter().map(|a| AppRef { app_id: Some(a.id), pid: a.pid }).collect();
        let mut excluded = hygiene::excluded_pids(&running, self.own_pid, &self.policy);
        excluded.extend(self.psyche_pids());
        if excluded.contains(&app.pid) {
            return Err(CapError::new(code::POLICY_DENIED, "app_excluded", format!("{} is never captured", app.name)));
        }
        let windows = self.backend.windows();
        // Without window positions protected windows cannot be hidden: a capture would show them.
        let protected_open = windows.iter().any(|w| excluded.contains(&w.pid) && !w.minimized);
        if protected_open && !self.backend.window_geometry_known() {
            return Err(CapError::new(
                code::UNAVAILABLE,
                "redaction_unavailable",
                "This desktop does not tell Psyche where windows are, and a protected window (Psyche, a terminal, a password manager) is open, so a screenshot could show it. Close or minimize it, or use computer.ax_tree.",
            ));
        }
        let max_w = p.max_width.map(|v| v.clamp(320, 2560) as u32).unwrap_or(hygiene::DEFAULT_MAX_WIDTH);
        let max_h = p.max_height.map(|v| v.clamp(240, 1600) as u32).unwrap_or(hygiene::DEFAULT_MAX_HEIGHT);
        let png = p.format.as_deref() == Some("png");
        let mut frame = self.backend.capture(p.display.map(|d| d.max(0) as usize))?;
        let refs: Vec<hygiene::WindowRef> = windows
            .iter()
            .filter(|w| !w.minimized)
            .filter_map(|w| w.bounds.map(|b| hygiene::WindowRef { id: w.id, pid: w.pid, layer: w.layer, bounds: b, alpha: 1.0 }))
            .collect();
        for r in hygiene::redactions(&refs, &excluded, frame.screen) {
            let s = frame.scale.max(0.01);
            frame.fill_black(Rect::new((r.x - frame.screen.x) * s, (r.y - frame.screen.y) * s, r.w * s, r.h * s));
        }
        let mut screen = frame.screen;
        if p.window_only == Some(true) {
            let w = windows
                .iter()
                .filter(|w| w.pid == app.pid && w.layer == 0 && !w.minimized)
                .filter_map(|w| w.bounds)
                .max_by(|a, b| (a.w * a.h).partial_cmp(&(b.w * b.h)).unwrap_or(std::cmp::Ordering::Equal))
                .ok_or_else(|| CapError::new(code::NOT_FOUND, "no_window", format!("{} has no on-screen window with a known position", app.name)))?;
            let s = frame.scale.max(0.01);
            frame = crop(&frame, Rect::new((w.x - frame.screen.x) * s, (w.y - frame.screen.y) * s, w.w * s, w.h * s));
            screen = w;
        }
        let (w, h) = hygiene::scaled_size(frame.width, frame.height, max_w, max_h);
        let (data, mime, w, h) = encode(&frame, w, h, png)?;
        use base64::Engine as _;
        Ok(CapOutput::plain(json!({
            "image": base64::engine::general_purpose::STANDARD.encode(&data),
            "mimeType": mime,
            "width": w,
            "height": h,
            "screen": {"x": screen.x, "y": screen.y, "width": screen.w, "height": screen.h},
            "pointsPerPixel": screen.w / (w.max(1) as f64),
            "scaleFactor": frame.scale,
            "excludedApps": excluded.len().saturating_sub(1),
            "provenance": "untrusted",
        })))
    }

    // --- Dispatch ---------------------------------------------------------------------------

    /// Runs one capability. The node core calls this; it carries the receipt draft.
    pub fn invoke(&self, name: &str, params: &Value, inv: &Invocation) -> CapResult<CapOutput> {
        let body = || -> CapResult<CapOutput> {
            match name {
                "computer.ax_tree" => self.ax_tree(inv, params),
                "computer.check_target" => self.check_target(inv, params),
                "computer.ax_value" => self.ax_value(inv, params),
                "computer.click" => self.click(inv, params, 1, false),
                "computer.double_click" => self.click(inv, params, 2, false),
                "computer.right_click" => self.click(inv, params, 1, true),
                "computer.press" => self.press(inv, params),
                "computer.set_value" => self.set_value(inv, params),
                "computer.select" => self.select(inv, params),
                "computer.type" => self.type_text(inv, params),
                "computer.key" => self.key(inv, params),
                "computer.scroll" => self.scroll(inv, params),
                "computer.drag" => self.drag(inv, params),
                "computer.menu" => self.menu(inv, params),
                "computer.end_session" => self.end_session(params),
                "computer.screenshot" => self.screenshot(inv, params),
                _ => Err(CapError::new(code::NOT_IMPLEMENTED, "unknown_capability", "No such capability")),
            }
        };
        // Computer-use bodies run as one stoppable invocation (a Stop ends it, not later ones).
        if name.starts_with("computer.") && name != "computer.screenshot" && name != "computer.end_session" {
            self.stop.run(inv.cancel.clone(), body)
        } else {
            body()
        }
    }
}

fn app_ref(a: &AppInfo) -> &AppInfo {
    a
}

fn ax_role_of(d: &ElementData) -> &'static str {
    crate::roles::map_role(&d.facts).role
}

fn is_secure(d: &ElementData) -> bool {
    d.info.is_secure() || crate::roles::is_password(d.facts.role)
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

fn modifier_flags(names: &Option<Vec<String>>) -> CapResult<Mods> {
    match names {
        Some(n) if !n.is_empty() => Ok(KeyChord::parse(&(n.join("+") + "+a"))?.mods),
        _ => Ok(Mods::default()),
    }
}

fn find_descendant<B: Backend>(b: &B, root: &B::Element, depth: usize, pred: impl Fn(&ElementData) -> bool + Copy) -> Option<B::Element> {
    let data = b.data(root)?;
    if pred(&data) {
        return Some(root.clone());
    }
    if depth == 0 {
        return None;
    }
    b.children(root).iter().find_map(|c| find_descendant(b, c, depth - 1, pred))
}

fn collect_items<B: Backend>(b: &B, parent: &B::Element, depth: usize, out: &mut Vec<(B::Element, ElementData)>) {
    for c in b.children(parent) {
        let Some(d) = b.data(&c) else { continue };
        match crate::roles::map_role(&d.facts).role {
            "AXMenuItem" | "AXMenuBarItem" => out.push((c, d)),
            "AXMenu" | "AXMenuBar" if depth > 0 => collect_items(b, &c, depth - 1, out),
            _ => {}
        }
    }
}

fn item_title<B: Backend>(b: &B, e: &B::Element, d: &ElementData) -> String {
    let _ = (b, e);
    d.info.title.clone().or_else(|| d.info.description.clone()).unwrap_or_default()
}

fn crop(f: &Frame, r: Rect) -> Frame {
    let x0 = (r.x.max(0.0) as u32).min(f.width);
    let y0 = (r.y.max(0.0) as u32).min(f.height);
    let x1 = (r.max_x().max(0.0) as u32).min(f.width);
    let y1 = (r.max_y().max(0.0) as u32).min(f.height);
    let (w, h) = (x1.saturating_sub(x0), y1.saturating_sub(y0));
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for y in y0..y1 {
        let start = ((y * f.width + x0) * 4) as usize;
        rgba.extend_from_slice(&f.rgba[start..start + (w * 4) as usize]);
    }
    Frame { width: w, height: h, rgba, screen: Rect::new(f.screen.x + x0 as f64 / f.scale.max(0.01), f.screen.y + y0 as f64 / f.scale.max(0.01), w as f64 / f.scale.max(0.01), h as f64 / f.scale.max(0.01)), scale: f.scale }
}

/// Box-filter downscale to `w` x `h` and JPEG-encode, lowering the quality until the result fits
/// `MAX_ENCODED_BYTES` (a result must stay far below the 1 MiB frame limit after base64).
pub fn encode(frame: &Frame, w: u32, h: u32, _png: bool) -> CapResult<(Vec<u8>, &'static str, u32, u32)> {
    if w == 0 || h == 0 || frame.width == 0 || frame.height == 0 || w > u32::from(u16::MAX) || h > u32::from(u16::MAX) {
        return Err(CapError::unavailable("empty_frame", "The capture is empty"));
    }
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        let (y0, y1) = (y as u64 * frame.height as u64 / h as u64, ((y as u64 + 1) * frame.height as u64 / h as u64).max(y as u64 * frame.height as u64 / h as u64 + 1));
        for x in 0..w {
            let (x0, x1) = (x as u64 * frame.width as u64 / w as u64, ((x as u64 + 1) * frame.width as u64 / w as u64).max(x as u64 * frame.width as u64 / w as u64 + 1));
            let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
            for sy in y0..y1.min(frame.height as u64) {
                for sx in x0..x1.min(frame.width as u64) {
                    let i = ((sy * frame.width as u64 + sx) * 4) as usize;
                    r += u64::from(frame.rgba[i]);
                    g += u64::from(frame.rgba[i + 1]);
                    b += u64::from(frame.rgba[i + 2]);
                    n += 1;
                }
            }
            let n = n.max(1);
            rgb.extend_from_slice(&[(r / n) as u8, (g / n) as u8, (b / n) as u8]);
        }
    }
    let mut last = Vec::new();
    for q in [75u8, 60, 45, 30] {
        let mut out = Vec::new();
        jpeg_encoder::Encoder::new(&mut out, q)
            .encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
            .map_err(|e| CapError::internal(format!("jpeg: {e}")))?;
        if out.len() <= hygiene::MAX_ENCODED_BYTES {
            return Ok((out, "image/jpeg", w, h));
        }
        last = out;
    }
    Ok((last, "image/jpeg", w, h))
}

// --- Params --------------------------------------------------------------------------------------

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

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SnapshotParams {
    app: Option<String>,
    pid: Option<i64>,
    window: Option<i64>,
    root: Option<String>,
    max_visit: Option<i64>,
    max_emit: Option<i64>,
    text_max: Option<i64>,
    value_max: Option<i64>,
    clip: Option<bool>,
    format: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CheckTargetParams {
    app: Option<String>,
    role: Option<String>,
    name: Option<String>,
    identifier: Option<String>,
    menu_path: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct ValueParams {
    #[serde(rename = "ref")]
    ref_: String,
    max: Option<i64>,
}

#[derive(Deserialize, Default)]
struct ClickParams {
    #[serde(flatten)]
    t: TargetParams,
    modifiers: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct PressParams {
    #[serde(flatten)]
    t: TargetParams,
    action: String,
}

#[derive(Deserialize)]
struct SetParams {
    #[serde(flatten)]
    t: TargetParams,
    value: String,
}

#[derive(Deserialize)]
struct TypeParams {
    #[serde(flatten)]
    t: TargetParams,
    text: String,
}

#[derive(Deserialize)]
struct KeyParams {
    keys: String,
    app: Option<String>,
    session: Option<String>,
    #[serde(rename = "repeat")]
    repeat_count: Option<i64>,
}

#[derive(Deserialize)]
struct ScrollParams {
    #[serde(flatten)]
    t: TargetParams,
    dx: Option<i64>,
    dy: Option<i64>,
}

#[derive(Deserialize)]
struct DragParams {
    from: TargetParams,
    to: TargetParams,
    session: Option<String>,
}

#[derive(Deserialize)]
struct MenuParams {
    app: Option<String>,
    path: String,
    session: Option<String>,
}

#[derive(Deserialize)]
struct EndParams {
    session: Option<String>,
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
}

#[allow(dead_code)]
fn _act_error_is_used(_: ActError) {}
