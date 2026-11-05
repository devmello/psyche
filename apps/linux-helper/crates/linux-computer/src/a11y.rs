//! AT-SPI2 over D-Bus (linux-desktop design §6.1): the accessibility tree of every running app,
//! read through zbus's blocking API. The bus is found with `org.a11y.Bus.GetAddress` on the
//! session bus; applications are the children of `org.a11y.atspi.Registry`'s root accessible.
//!
//! Elements are `(bus name, object path)` pairs. Every call carries a method timeout, so a hung
//! app returns an error instead of wedging the helper. Calls are made lazily and sparingly: the
//! snapshot builder asks for the info of one element and for its children, nothing more.

use crate::app_id::{self, DesktopIndex, Evidence};
use crate::backend::{ActError, AppInfo, ElementData, Hit};
use crate::error::{code, CapError, CapResult};
use crate::roles::{self, role, AtspiFacts};
use crate::snapshot::{ElementInfo, Rect, TreeSource};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zbus::blocking::Connection;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

const CALL_TIMEOUT: Duration = Duration::from_secs(4);
const NULL_PATH: &str = "/org/a11y/atspi/null";
const ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";
const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";

/// `AtspiStateType` values the helper reads.
pub mod state {
    pub const ACTIVE: u32 = 1;
    pub const CHECKABLE: u32 = 41;
    pub const CHECKED: u32 = 4;
    pub const DEFUNCT: u32 = 6;
    pub const EDITABLE: u32 = 7;
    pub const ENABLED: u32 = 8;
    pub const EXPANDABLE: u32 = 9;
    pub const FOCUSED: u32 = 12;
    pub const HAS_POPUP: u32 = 42;
    pub const ICONIFIED: u32 = 15;
    pub const MODAL: u32 = 16;
    pub const MULTI_LINE: u32 = 17;
    pub const READ_ONLY: u32 = 43;
    pub const SELECTABLE: u32 = 22;
    pub const SELECTED: u32 = 23;
    pub const SENSITIVE: u32 = 24;
    pub const SHOWING: u32 = 25;

    pub fn has(words: &[u32], s: u32) -> bool {
        words.get((s / 32) as usize).is_some_and(|w| w & (1 << (s % 32)) != 0)
    }
}

/// One accessible object.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Acc {
    pub bus: Arc<str>,
    pub path: Arc<str>,
}

impl Acc {
    pub fn new(bus: &str, path: &str) -> Acc {
        Acc { bus: bus.into(), path: path.into() }
    }

    fn is_null(&self) -> bool {
        &*self.path == NULL_PATH || self.bus.is_empty()
    }
}

/// Where a window sits on screen: `(pid, accessible title) -> top-left`.
pub type OriginFn = Box<dyn Fn(u32, &str) -> Option<(f64, f64)> + Send + Sync>;

/// The connection to the accessibility bus.
pub struct A11y {
    conn: Connection,
    deadline: Mutex<Option<Instant>>,
    pids: Mutex<HashMap<String, u32>>,
    desktop: Mutex<DesktopIndex>,
    index_loaded: AtomicBool,
    env: Box<dyn Fn(&str) -> Option<String> + Send + Sync>,
    toolkits: Mutex<HashMap<String, String>>,
    cache: Mutex<HashMap<(Acc, bool), Option<ElementData>>>,
    address: String,
    toplevels: Mutex<HashMap<Acc, Option<Acc>>>,
    origins: Mutex<HashMap<Acc, Option<(f64, f64)>>>,
    origin_of: Mutex<Option<OriginFn>>,
    focus: Arc<Mutex<Option<Acc>>>,
    focus_started: AtomicBool,
}

impl A11y {
    /// Connects through the session bus's `org.a11y.Bus`. Refuses with
    /// `unavailable/no_a11y_bus` when there is no session bus or no accessibility bus.
    pub fn connect() -> CapResult<A11y> {
        let session = zbus::blocking::Connection::session()
            .map_err(|e| CapError::unavailable("no_a11y_bus", format!("Needs a graphical session on this computer (no session bus: {e})")))?;
        let reply = session
            .call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.a11y.Bus"), "GetAddress", &())
            .map_err(|e| CapError::unavailable("no_a11y_bus", format!("The accessibility bus is not running: {e}")))?;
        let address: String = reply.body().deserialize().map_err(|e| CapError::unavailable("no_a11y_bus", e.to_string()))?;
        Self::connect_address(&address)
    }

    pub fn connect_address(address: &str) -> CapResult<A11y> {
        let conn = zbus::blocking::connection::Builder::address(address)
            .map_err(|e| CapError::unavailable("no_a11y_bus", e.to_string()))?
            .method_timeout(CALL_TIMEOUT)
            .build()
            .map_err(|e| CapError::unavailable("no_a11y_bus", format!("Cannot connect to the accessibility bus: {e}")))?;
        Ok(A11y {
            conn,
            deadline: Mutex::new(None),
            pids: Mutex::new(HashMap::new()),
            desktop: Mutex::new(DesktopIndex::default()),
            index_loaded: AtomicBool::new(false),
            env: Box::new(|k| std::env::var(k).ok().filter(|v| !v.is_empty())),
            toolkits: Mutex::new(HashMap::new()),
            cache: Mutex::new(HashMap::new()),
            address: address.to_string(),
            toplevels: Mutex::new(HashMap::new()),
            origins: Mutex::new(HashMap::new()),
            origin_of: Mutex::new(None),
            focus: Arc::new(Mutex::new(None)),
            focus_started: AtomicBool::new(false),
        })
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    // --- Raw calls --------------------------------------------------------------------------

    fn call<T>(&self, acc: &Acc, iface: &str, member: &str, body: &(impl serde::Serialize + zbus::zvariant::DynamicType)) -> zbus::Result<T>
    where
        T: serde::de::DeserializeOwned + zbus::zvariant::Type,
    {
        let msg = self.conn.call_method(Some(&*acc.bus), &*acc.path, Some(iface), member, body)?;
        Ok(msg.body().deserialize::<T>()?)
    }

    fn prop<T>(&self, acc: &Acc, iface: &str, name: &str) -> Option<T>
    where
        T: TryFrom<OwnedValue>,
    {
        let msg = self
            .conn
            .call_method(Some(&*acc.bus), &*acc.path, Some("org.freedesktop.DBus.Properties"), "Get", &(iface, name))
            .ok()?;
        let v: OwnedValue = msg.body().deserialize().ok()?;
        T::try_from(v).ok()
    }

    pub fn children_of(&self, acc: &Acc) -> Vec<Acc> {
        let list: Vec<(String, OwnedObjectPath)> = self.call(acc, ACCESSIBLE, "GetChildren", &()).unwrap_or_default();
        list.into_iter().map(|(b, p)| Acc::new(&b, p.as_str())).filter(|a| !a.is_null()).collect()
    }

    pub fn role_of(&self, acc: &Acc) -> Option<u32> {
        self.call::<u32>(acc, ACCESSIBLE, "GetRole", &()).ok()
    }

    pub fn states_of(&self, acc: &Acc) -> Vec<u32> {
        self.call::<Vec<u32>>(acc, ACCESSIBLE, "GetState", &()).unwrap_or_default()
    }

    fn interfaces_of(&self, acc: &Acc) -> Vec<String> {
        self.call::<Vec<String>>(acc, ACCESSIBLE, "GetInterfaces", &()).unwrap_or_default()
    }

    pub fn name_of(&self, acc: &Acc) -> Option<String> {
        self.prop::<String>(acc, ACCESSIBLE, "Name").filter(|s| !s.is_empty())
    }

    fn parent_of(&self, acc: &Acc) -> Option<Acc> {
        let (b, p): (String, OwnedObjectPath) = self.prop::<zbus::zvariant::OwnedValue>(acc, ACCESSIBLE, "Parent").and_then(|v| {
            let s: zbus::zvariant::Structure = v.try_into().ok()?;
            let f = s.fields();
            let b: String = f.first()?.try_clone().ok()?.try_into().ok()?;
            let p: OwnedObjectPath = f.get(1)?.try_clone().ok()?.try_into().ok()?;
            Some((b, p))
        })?;
        let a = Acc::new(&b, p.as_str());
        (!a.is_null()).then_some(a)
    }

    /// The pid of the process behind a bus name, cached.
    pub fn pid_of_bus(&self, bus: &str) -> Option<u32> {
        if let Some(p) = self.pids.lock().unwrap_or_else(|e| e.into_inner()).get(bus) {
            return Some(*p);
        }
        let msg = self
            .conn
            .call_method(Some("org.freedesktop.DBus"), "/org/freedesktop/DBus", Some("org.freedesktop.DBus"), "GetConnectionUnixProcessID", &(bus,))
            .ok()?;
        let pid: u32 = msg.body().deserialize().ok()?;
        self.pids.lock().unwrap_or_else(|e| e.into_inner()).insert(bus.to_string(), pid);
        Some(pid)
    }

    // --- Registry and apps ------------------------------------------------------------------

    fn root() -> Acc {
        Acc::new("org.a11y.atspi.Registry", ROOT_PATH)
    }

    /// Every application on the accessibility bus.
    pub fn application_roots(&self) -> Vec<Acc> {
        self.children_of(&Self::root())
    }

    fn desktop_index(&self) -> DesktopIndex {
        if !self.index_loaded.swap(true, Ordering::SeqCst) {
            let dirs = DesktopIndex::default_dirs(&|k| (self.env)(k));
            *self.desktop.lock().unwrap_or_else(|e| e.into_inner()) = DesktopIndex::load(&dirs);
        }
        self.desktop.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Everything `/proc/<pid>` says about the app, for [`app_id::choose`].
    pub fn evidence(pid: u32) -> Evidence {
        let read = |f: &str| std::fs::read(format!("/proc/{pid}/{f}")).ok();
        let environ = read("environ").and_then(|b| {
            b.split(|c| *c == 0).find_map(|kv| kv.strip_prefix(b"GIO_LAUNCHED_DESKTOP_FILE=").map(|v| String::from_utf8_lossy(v).into_owned()))
        });
        Evidence {
            cgroup: read("cgroup").map(|b| String::from_utf8_lossy(&b).into_owned()),
            launched_desktop_file: environ,
            exe: std::fs::read_link(format!("/proc/{pid}/exe")).ok().map(|p| p.to_string_lossy().into_owned()),
            comm: read("comm").map(|b| String::from_utf8_lossy(&b).trim().to_string()),
        }
    }

    /// The desktop-file id of a process (strictest candidate wins, see [`app_id::choose`]).
    pub fn app_id_for_pid(&self, pid: u32) -> Option<String> {
        let ev = Self::evidence(pid);
        let cands = app_id::candidates(&ev, &self.desktop_index());
        app_id::choose(&cands).or_else(|| ev.comm.as_deref().map(app_id::normalize).filter(|c| app_id::is_app_id(c)))
    }

    fn display_name(&self, id: &str, accessible_name: Option<String>) -> String {
        self.desktop_index()
            .get(id)
            .and_then(|e| e.name.clone())
            .or(accessible_name)
            .unwrap_or_else(|| id.to_string())
    }

    /// Running apps. `active_pid` marks the frontmost one when the window system knows it;
    /// otherwise the app owning the window in the `ACTIVE` state is frontmost.
    pub fn apps(&self, active_pid: Option<u32>) -> Vec<AppInfo> {
        let mut out: Vec<AppInfo> = Vec::new();
        for root in self.application_roots() {
            let Some(pid) = self.pid_of_bus(&root.bus) else { continue };
            if pid == std::process::id() {
                continue;
            }
            let wins: Vec<Acc> = self.children_of(&root).into_iter().filter(|w| self.role_of(w).is_some_and(is_window_role)).collect();
            let Some(id) = self.app_id_for_pid(pid) else { continue };
            let active = match active_pid {
                Some(p) => p == pid,
                None => wins.iter().any(|w| state::has(&self.states_of(w), state::ACTIVE)),
            };
            let toolkit = self.toolkit(&root);
            let electron = {
                let t = toolkit.to_ascii_lowercase();
                t.contains("chrom") || t.contains("electron") || t.contains("cef")
            };
            let name = self.display_name(&id, self.name_of(&root));
            // A pid can own several accessible applications (a wrapper process); keep the first.
            if out.iter().any(|a| a.pid == pid) {
                continue;
            }
            out.push(AppInfo { id, name, pid, electron, frontmost: active, windows: wins.len() });
        }
        out
    }

    fn toolkit(&self, root: &Acc) -> String {
        if let Some(t) = self.toolkits.lock().unwrap_or_else(|e| e.into_inner()).get(&*root.bus) {
            return t.clone();
        }
        let t = self.prop::<String>(root, "org.a11y.atspi.Application", "ToolkitName").unwrap_or_default();
        self.toolkits.lock().unwrap_or_else(|e| e.into_inner()).insert(root.bus.to_string(), t.clone());
        t
    }

    /// The application root accessible of `pid`.
    pub fn app_root_for_pid(&self, pid: u32) -> Option<Acc> {
        self.application_roots().into_iter().find(|r| self.pid_of_bus(&r.bus) == Some(pid))
    }

    /// Top-level windows of an app (frames, dialogs, ...), in the order the app lists them.
    pub fn windows_of(&self, pid: u32) -> Vec<Acc> {
        let Some(root) = self.app_root_for_pid(pid) else { return vec![] };
        let mut wins: Vec<Acc> = self.children_of(&root).into_iter().filter(|w| self.role_of(w).is_some_and(is_window_role)).collect();
        // The active window first, so "window 0" is the one the owner is looking at.
        wins.sort_by_key(|w| !state::has(&self.states_of(w), state::ACTIVE));
        wins
    }

    // --- Element data -----------------------------------------------------------------------

    pub fn begin_walk(&self, budget: Duration) {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.toplevels.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.origins.lock().unwrap_or_else(|e| e.into_inner()).clear();
        *self.deadline.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now() + budget);
    }

    fn past_deadline(&self) -> bool {
        self.deadline.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|d| Instant::now() > d)
    }

    fn text_of(&self, acc: &Acc, ifaces: &[String], cap: usize) -> Option<String> {
        if !has_iface(ifaces, "Text") {
            return None;
        }
        let count: i32 = self.prop(acc, "org.a11y.atspi.Text", "CharacterCount")?;
        if count <= 0 {
            return Some(String::new());
        }
        let end = count.min(cap as i32);
        self.call::<String>(acc, "org.a11y.atspi.Text", "GetText", &(0i32, end)).ok()
    }

    fn actions_of(&self, acc: &Acc, ifaces: &[String]) -> Vec<String> {
        if !has_iface(ifaces, "Action") {
            return vec![];
        }
        // GetActions: a(sss) (name, localized name, key binding); the name is the stable one.
        let list: Vec<(String, String, String)> = self.call(acc, "org.a11y.atspi.Action", "GetActions", &()).unwrap_or_default();
        list.into_iter().map(|(n, ..)| n).collect()
    }

    fn value_of(&self, acc: &Acc) -> Option<f64> {
        self.prop::<f64>(acc, "org.a11y.atspi.Value", "CurrentValue")
    }

    /// Tells where windows sit on screen (the X11 window list). Without it extents are taken as
    /// the toolkit reports them in screen coordinates.
    pub fn set_origin_source(&self, f: OriginFn) {
        *self.origin_of.lock().unwrap_or_else(|e| e.into_inner()) = Some(f);
    }

    /// The top-level window an element sits in, found through its parents (memoized per walk).
    fn toplevel_of(&self, acc: &Acc, depth: usize) -> Option<Acc> {
        if let Some(t) = self.toplevels.lock().unwrap_or_else(|e| e.into_inner()).get(acc) {
            return t.clone();
        }
        let found = if self.role_of(acc).is_some_and(is_window_role) && self.parent_of(acc).is_some_and(|p| &*p.path == ROOT_PATH) {
            Some(acc.clone())
        } else if depth > 40 {
            None
        } else {
            self.parent_of(acc).and_then(|p| self.toplevel_of(&p, depth + 1))
        };
        self.toplevels.lock().unwrap_or_else(|e| e.into_inner()).insert(acc.clone(), found.clone());
        found
    }

    fn origin_of_toplevel(&self, top: &Acc) -> Option<(f64, f64)> {
        if let Some(o) = self.origins.lock().unwrap_or_else(|e| e.into_inner()).get(top) {
            return *o;
        }
        let pid = self.pid_of_bus(&top.bus)?;
        let title = self.name_of(top).unwrap_or_default();
        let o = self.origin_of.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|f| f(pid, &title));
        self.origins.lock().unwrap_or_else(|e| e.into_inner()).insert(top.clone(), o);
        o
    }

    /// Screen rectangle of an element. Toolkits disagree on screen coordinates (GTK 4 reports 0,0
    /// for most children), so where the window system says where the window is, the element's
    /// window-relative extents (coord type 1) are added to it; otherwise the toolkit's screen
    /// extents (coord type 0) are used as they are.
    fn extents(&self, acc: &Acc) -> Option<Rect> {
        let origin = self.toplevel_of(acc, 0).and_then(|t| self.origin_of_toplevel(&t));
        let coord = if origin.is_some() { 1u32 } else { 0u32 };
        let (x, y, w, h): (i32, i32, i32, i32) = self.call(acc, "org.a11y.atspi.Component", "GetExtents", &(coord,)).ok()?;
        let (ox, oy) = origin.unwrap_or((0.0, 0.0));
        Some(Rect::new(f64::from(x) + ox, f64::from(y) + oy, f64::from(w), f64::from(h)))
    }

    /// [`Self::read_uncached`], remembered until the next walk starts (the builder asks for
    /// the info, the actions and the settable flag of the same element).
    pub fn read(&self, acc: &Acc, with_frame: bool, value_cap: usize) -> Option<ElementData> {
        let key = (acc.clone(), with_frame);
        if let Some(hit) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            return hit.clone();
        }
        let d = self.read_uncached(acc, with_frame, value_cap);
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if cache.len() > 20_000 {
            cache.clear();
        }
        cache.insert(key, d.clone());
        d
    }

    /// Reads one element: AT-SPI facts, then the snapshot's view of them.
    pub fn read_uncached(&self, acc: &Acc, with_frame: bool, value_cap: usize) -> Option<ElementData> {
        if acc.is_null() {
            return None;
        }
        let role_n = self.role_of(acc)?;
        let states = self.states_of(acc);
        if state::has(&states, state::DEFUNCT) {
            return None;
        }
        let ifaces = self.interfaces_of(acc);
        let name = self.name_of(acc);
        let description = self.prop::<String>(acc, ACCESSIBLE, "Description").filter(|s| !s.is_empty());
        let attrs: HashMap<String, String> = self.call(acc, ACCESSIBLE, "GetAttributes", &()).unwrap_or_default();
        let parent_role = if role_n == role::MENU_ITEM { self.parent_of(acc).and_then(|p| self.role_of(&p)) } else { None };
        let action_names = self.actions_of(acc, &ifaces);
        let has_value = has_iface(&ifaces, "Value");
        let value_ro = has_value && self.prop::<bool>(acc, "org.a11y.atspi.Value", "ReadOnly").unwrap_or(false);
        let facts = AtspiFacts {
            role: role_n,
            parent_role,
            top_level: is_window_role(role_n) && self.parent_of(acc).is_some_and(|p| p.path.as_ref() == ROOT_PATH && p.bus.as_ref() == acc.bus.as_ref()),
            identifier: attrs.get("id").cloned().unwrap_or_default(),
            toolkit: attrs.get("toolkit").cloned().unwrap_or_default(),
            editable: state::has(&states, state::EDITABLE) && !state::has(&states, state::READ_ONLY),
            multi_line: state::has(&states, state::MULTI_LINE),
            checkable: state::has(&states, state::CHECKABLE),
            expandable: state::has(&states, state::EXPANDABLE),
            has_popup: state::has(&states, state::HAS_POPUP),
            modal: state::has(&states, state::MODAL),
            action_names,
            has_text: has_iface(&ifaces, "Text"),
            has_editable_text: has_iface(&ifaces, "EditableText"),
            has_value,
            value_read_only: value_ro,
            has_selection_parent: false,
            selectable: state::has(&states, state::SELECTABLE),
        };
        let ax = roles::map_role(&facts);
        // Never read the text of a password field.
        let secure = roles::is_password(role_n);
        let mut info = ElementInfo::new(ax.role);
        info.subrole = ax.subrole.map(str::to_string);
        let text_value = if secure {
            Some(String::new())
        } else if matches!(role_n, role::ENTRY | role::TEXT | role::TERMINAL | role::DOCUMENT_FRAME | role::DOCUMENT_TEXT | role::DOCUMENT_EMAIL | role::COMBO_BOX | role::SPIN_BUTTON | role::PARAGRAPH | role::HEADING | role::LINK)
            || facts.has_editable_text
        {
            self.text_of(acc, &ifaces, value_cap.max(160))
        } else {
            None
        };
        if ax.name_is_value {
            info.value = name.clone().or(text_value.clone()).filter(|v| !v.is_empty());
        } else if !ax.drop_name {
            info.title = name.clone();
            info.value = match (text_value, has_value, secure) {
                (Some(t), _, _) if !t.is_empty() || secure => Some(t),
                (_, true, _) => self.value_of(acc).map(roles::number_string),
                _ => None,
            };
            if matches!(role_n, role::CHECK_BOX | role::RADIO_BUTTON | role::TOGGLE_BUTTON | role::CHECK_MENU_ITEM | role::RADIO_MENU_ITEM)
                || (role_n == role::PUSH_BUTTON && facts.checkable)
            {
                info.value = Some(if state::has(&states, state::CHECKED) { "1" } else { "0" }.to_string());
            }
        }
        info.description = description;
        info.identifier = attrs.get("id").cloned();
        info.placeholder = attrs.get("placeholder-text").cloned();
        info.enabled = Some(state::has(&states, state::ENABLED) || state::has(&states, state::SENSITIVE));
        info.selected = Some(state::has(&states, state::SELECTED));
        if with_frame {
            info.frame = self.extents(acc).filter(|r| r.w > 0.0 && r.h > 0.0);
        }
        let pid = self.pid_of_bus(&acc.bus).unwrap_or(0);
        Some(ElementData { info, facts, pid })
    }

    // --- Actions ----------------------------------------------------------------------------

    fn do_action(&self, acc: &Acc, names: &[&str]) -> Result<(), ActError> {
        let list: Vec<(String, String, String)> = self.call(acc, "org.a11y.atspi.Action", "GetActions", &()).map_err(act_err)?;
        let idx = names
            .iter()
            .find_map(|want| list.iter().position(|(n, ..)| n.eq_ignore_ascii_case(want)))
            .ok_or_else(|| ActError::new("the element has no such action"))?;
        let ok: bool = self.call(acc, "org.a11y.atspi.Action", "DoAction", &(idx as i32,)).map_err(act_err)?;
        if ok {
            Ok(())
        } else {
            Err(ActError::new("the app declined the action"))
        }
    }

    pub fn perform(&self, acc: &Acc, ax_action: &str) -> Result<(), ActError> {
        match ax_action {
            "AXPress" | "AXOpen" => self.do_action(acc, &["click", "press", "activate", "toggle", "check", "uncheck", "select", "jump", "push", "invoke", "expand or contract", "open"]),
            "AXShowMenu" => self.do_action(acc, &["menu", "showmenu", "show menu", "popup", "open"]),
            "AXIncrement" | "AXDecrement" => {
                let cur = self.value_of(acc).ok_or_else(|| ActError::new("the element has no value"))?;
                let step = self.prop::<f64>(acc, "org.a11y.atspi.Value", "MinimumIncrement").filter(|s| *s > 0.0).unwrap_or(1.0);
                let next = if ax_action == "AXIncrement" { cur + step } else { cur - step };
                self.set_number(acc, next)
            }
            "AXRaise" => self.grab_focus(acc),
            other => Err(ActError::new(format!("{other} is not supported on Linux"))),
        }
    }

    fn set_number(&self, acc: &Acc, v: f64) -> Result<(), ActError> {
        // `SetCurrentValue` is a property write.
        self.conn
            .call_method(Some(&*acc.bus), &*acc.path, Some("org.freedesktop.DBus.Properties"), "Set", &("org.a11y.atspi.Value", "CurrentValue", zbus::zvariant::Value::from(v)))
            .map(|_| ())
            .map_err(act_err)
    }

    pub fn grab_focus(&self, acc: &Acc) -> Result<(), ActError> {
        let ok: bool = self.call(acc, "org.a11y.atspi.Component", "GrabFocus", &()).map_err(act_err)?;
        if ok {
            Ok(())
        } else {
            Err(ActError::new("the element did not take focus"))
        }
    }

    pub fn set_value(&self, acc: &Acc, value: &str) -> Result<(), ActError> {
        let ifaces = self.interfaces_of(acc);
        if has_iface(&ifaces, "EditableText") {
            let ok: bool = self.call(acc, "org.a11y.atspi.EditableText", "SetTextContents", &(value,)).map_err(act_err)?;
            return if ok { Ok(()) } else { Err(ActError::new("the field refused the text")) };
        }
        if has_iface(&ifaces, "Value") {
            let n: f64 = value.trim().parse().map_err(|_| ActError::new("a number is needed"))?;
            return self.set_number(acc, n);
        }
        Err(ActError::new("the element is not editable"))
    }

    pub fn current_value(&self, acc: &Acc) -> Option<String> {
        let ifaces = self.interfaces_of(acc);
        if has_iface(&ifaces, "Text") && !self.role_of(acc).is_some_and(roles::is_password) {
            return self.text_of(acc, &ifaces, 100_000);
        }
        if has_iface(&ifaces, "Value") {
            return self.value_of(acc).map(roles::number_string);
        }
        None
    }

    pub fn select(&self, acc: &Acc) -> Result<(), ActError> {
        // The parent's Selection interface chooses its child by index.
        let parent = self.parent_of(acc).ok_or_else(|| ActError::new("the element has no parent"))?;
        let idx: i32 = self.call(acc, ACCESSIBLE, "GetIndexInParent", &()).map_err(act_err)?;
        let pi = self.interfaces_of(&parent);
        if has_iface(&pi, "Selection") {
            let ok: bool = self.call(&parent, "org.a11y.atspi.Selection", "SelectChild", &(idx,)).map_err(act_err)?;
            if ok {
                return Ok(());
            }
        }
        self.do_action(acc, &["select", "click", "activate", "switch"])
    }

    pub fn is_selected(&self, acc: &Acc) -> Option<bool> {
        Some(state::has(&self.states_of(acc), state::SELECTED))
    }

    pub fn selected_text(&self, acc: &Acc) -> Option<String> {
        let n: i32 = self.call(acc, "org.a11y.atspi.Text", "GetNSelections", &()).ok()?;
        if n <= 0 {
            return None;
        }
        let (a, b): (i32, i32) = self.call(acc, "org.a11y.atspi.Text", "GetSelection", &(0i32,)).ok()?;
        self.call::<String>(acc, "org.a11y.atspi.Text", "GetText", &(a, b.min(a + 8000))).ok()
    }

    // --- Focus and hit tests ----------------------------------------------------------------

    /// Starts following `object:state-changed:focused` on its own connection, once. The focused
    /// element is then known without walking any tree.
    pub fn start_focus_tracker(&self) {
        if self.focus_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let address = self.address.clone();
        let focus = self.focus.clone();
        std::thread::spawn(move || {
            let Ok(conn) = zbus::blocking::connection::Builder::address(address.as_str()).and_then(|b| b.build()) else { return };
            // Toolkits emit an event class only when someone registered for it.
            let reg = |body: &dyn Fn() -> zbus::Result<zbus::Message>| {
                let _ = body();
            };
            reg(&|| {
                conn.call_method(
                    Some("org.a11y.atspi.Registry"),
                    "/org/a11y/atspi/registry",
                    Some("org.a11y.atspi.Registry"),
                    "RegisterEvent",
                    &("object:state-changed:focused", Vec::<String>::new(), ""),
                )
            });
            let Ok(rule) = zbus::MatchRule::builder()
                .msg_type(zbus::message::Type::Signal)
                .interface("org.a11y.atspi.Event.Object")
                .and_then(|b| b.member("StateChanged"))
                .map(|b| b.build())
            else {
                return;
            };
            let Ok(iter) = zbus::blocking::MessageIterator::for_match_rule(rule, &conn, None) else { return };
            for msg in iter.flatten() {
                let Ok((what, gained, _, _, _)) = msg.body().deserialize::<(String, i32, i32, zbus::zvariant::Value, HashMap<String, zbus::zvariant::Value>)>() else {
                    continue;
                };
                if what != "focused" {
                    continue;
                }
                let header = msg.header();
                let (Some(sender), Some(path)) = (header.sender(), header.path()) else { continue };
                let acc = Acc::new(sender.as_str(), path.as_str());
                let mut f = focus.lock().unwrap_or_else(|e| e.into_inner());
                if gained == 1 {
                    *f = Some(acc);
                } else if f.as_ref() == Some(&acc) {
                    *f = None;
                }
            }
        });
    }

    /// The focused element: the tracker's, checked to still exist, else a bounded search of the
    /// active windows (which then seeds the tracker).
    pub fn focused(&self, pid: Option<u32>) -> Option<Acc> {
        self.start_focus_tracker();
        let known = self.focus.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(a) = known.filter(|a| !state::has(&self.states_of(a), state::DEFUNCT) && self.role_of(a).is_some()) {
            if pid.is_none_or(|p| self.pid_of_bus(&a.bus) == Some(p)) {
                return Some(a);
            }
        }
        let roots: Vec<Acc> = match pid {
            Some(p) => self.windows_of(p),
            None => self.application_roots().into_iter().flat_map(|r| self.children_of(&r)).filter(|w| self.role_of(w).is_some_and(is_window_role) && state::has(&self.states_of(w), state::ACTIVE)).collect(),
        };
        for w in roots {
            if let Some(f) = self.find_focused(&w, 4000, Duration::from_millis(1500)) {
                *self.focus.lock().unwrap_or_else(|e| e.into_inner()) = Some(f.clone());
                return Some(f);
            }
        }
        None
    }

    /// Finds the element with the `FOCUSED` state under `root`, bounded in visits and time.
    pub fn find_focused(&self, root: &Acc, max_visits: usize, budget: Duration) -> Option<Acc> {
        let end = Instant::now() + budget;
        let mut stack = vec![root.clone()];
        let mut visits = 0;
        while let Some(a) = stack.pop() {
            visits += 1;
            if visits > max_visits || Instant::now() > end {
                return None;
            }
            let st = self.states_of(&a);
            if state::has(&st, state::FOCUSED) {
                return Some(a);
            }
            if state::has(&st, state::DEFUNCT) {
                continue;
            }
            stack.extend(self.children_of(&a).into_iter().rev());
        }
        None
    }

    /// The deepest element at a screen point inside `window` (X11 coordinates only).
    pub fn element_at(&self, window: &Acc, x: f64, y: f64) -> Option<Acc> {
        let mut cur = window.clone();
        for _ in 0..16 {
            let r: Result<(String, OwnedObjectPath), _> = self.call(&cur, "org.a11y.atspi.Component", "GetAccessibleAtPoint", &(x as i32, y as i32, 0u32));
            let Ok((b, p)) = r else { break };
            let next = Acc::new(&b, p.as_str());
            if next.is_null() || next == cur {
                break;
            }
            cur = next;
        }
        Some(cur)
    }

    /// Labels of `acc` and its ancestors up to (excluding) the window.
    pub fn labels_up(&self, acc: &Acc) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = Some(acc.clone());
        for _ in 0..8 {
            let Some(a) = cur else { break };
            if self.role_of(&a).is_some_and(is_window_role) {
                break;
            }
            if let Some(n) = self.name_of(&a) {
                out.push(n);
            }
            cur = self.parent_of(&a);
        }
        out
    }

    pub fn hit(&self, window: &Acc, x: f64, y: f64) -> Option<Hit> {
        let a = self.element_at(window, x, y)?;
        let role_n = self.role_of(&a)?;
        let ax = roles::map_role(&AtspiFacts { role: role_n, ..Default::default() });
        Some(Hit {
            pid: self.pid_of_bus(&a.bus)?,
            role: Some(ax.role.to_string()),
            secure: roles::is_password(role_n),
            labels: self.labels_up(&a),
        })
    }

    /// The focused password field check: the focused element's role.
    pub fn is_password(&self, acc: &Acc) -> bool {
        self.role_of(acc).is_some_and(roles::is_password)
    }

    // --- Turning accessibility on -----------------------------------------------------------

    /// `org.a11y.Status.IsEnabled` on the session bus.
    pub fn status_enabled() -> Option<bool> {
        let session = zbus::blocking::Connection::session().ok()?;
        let msg = session
            .call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.freedesktop.DBus.Properties"), "Get", &("org.a11y.Status", "IsEnabled"))
            .ok()?;
        let v: OwnedValue = msg.body().deserialize().ok()?;
        bool::try_from(v).ok()
    }

    pub fn set_status_enabled(on: bool) -> CapResult<()> {
        let session = zbus::blocking::Connection::session()
            .map_err(|e| CapError::unavailable("no_a11y_bus", format!("Needs a graphical session on this computer ({e})")))?;
        session
            .call_method(
                Some("org.a11y.Bus"),
                "/org/a11y/bus",
                Some("org.freedesktop.DBus.Properties"),
                "Set",
                &("org.a11y.Status", "IsEnabled", zbus::zvariant::Value::from(on)),
            )
            .map(|_| ())
            .map_err(|e| CapError::unavailable("a11y_status_failed", format!("Could not change the accessibility setting: {e}")))
    }
}

fn is_window_role(r: u32) -> bool {
    matches!(r, role::FRAME | role::WINDOW | role::DIALOG | role::ALERT | role::FILE_CHOOSER | role::COLOR_CHOOSER | role::INTERNAL_FRAME)
}

fn has_iface(ifaces: &[String], name: &str) -> bool {
    ifaces.iter().any(|i| i.rsplit('.').next() == Some(name))
}

fn act_err(e: zbus::Error) -> ActError {
    let text = e.to_string();
    ActError { not_responding: text.contains("Timeout") || text.contains("timed out") || text.contains("NoReply"), detail: text }
}

/// The tree as the snapshot builder walks it.
pub struct Tree<'a> {
    pub a11y: &'a A11y,
    pub with_frame: bool,
}

impl TreeSource for Tree<'_> {
    type Element = Acc;
    fn info(&self, e: &Acc) -> Option<ElementInfo> {
        let d = self.a11y.read(e, self.with_frame, 160)?;
        Some(d.info)
    }
    fn children(&self, e: &Acc) -> Vec<Acc> {
        self.a11y.children_of(e)
    }
    fn actions(&self, e: &Acc) -> Vec<String> {
        self.a11y.read(e, self.with_frame, 160).map(|d| roles::actions(&d.facts, roles::map_role(&d.facts).role)).unwrap_or_default()
    }
    fn is_value_settable(&self, e: &Acc) -> bool {
        self.a11y.read(e, self.with_frame, 160).is_some_and(|d| roles::value_settable(&d.facts))
    }
    fn should_stop(&self) -> bool {
        self.a11y.past_deadline()
    }
}

#[allow(dead_code)]
fn _code_is_used() -> &'static str {
    code::INTERNAL
}
