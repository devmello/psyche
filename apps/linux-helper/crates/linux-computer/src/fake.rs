//! A fake desktop for the engine's tests (and the helper's own tests): a few apps, a tree, and a
//! log of every input call, so the checks below the model can be asserted without a display.

use crate::backend::{ActError, AppInfo, Backend, ElementData, Frame, Hit, WinInfo};
use crate::error::{code, CapError, CapResult};
use crate::keychord::{KeyChord, Mods};
use crate::roles::{role, AtspiFacts};
use crate::snapshot::{ElementInfo, Rect, TreeSource};
use crate::tiers::StopSignal;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Clone, Default)]
pub struct Node {
    pub data: Option<ElementData>,
    pub children: Vec<u32>,
    pub frame: Option<Rect>,
    pub value: Option<String>,
}

#[derive(Default)]
pub struct State {
    pub nodes: HashMap<u32, Node>,
    pub apps: Vec<AppInfo>,
    pub windows: Vec<WinInfo>,
    pub app_roots: HashMap<u32, Vec<u32>>,
    pub focus_pid: Option<u32>,
    pub focused_element: Option<u32>,
    pub focus_secure: bool,
    pub geometry_known: bool,
    pub log: Vec<String>,
    pub typed: String,
    pub next: u32,
    pub perform_fails: bool,
    ///  does not move keyboard focus (a desktop that denies it).
    pub focus_denied: bool,
    ///  on an element succeeds without the element taking focus.
    pub element_focus_ignored: bool,
}

pub struct Fake {
    pub s: Mutex<State>,
}

pub const EDITOR_PID: u32 = 100;
pub const TERMINAL_PID: u32 = 101;
pub const KEEPASS_PID: u32 = 102;
pub const MAIL_PID: u32 = 103;
pub const PSYCHE_PID: u32 = 104;

fn app(id: &str, name: &str, pid: u32) -> AppInfo {
    AppInfo {
        id: id.into(),
        name: name.into(),
        pid,
        electron: false,
        frontmost: false,
        windows: 1,
    }
}

impl Fake {
    pub fn new() -> Fake {
        let f = Fake {
            s: Mutex::new(State {
                next: 1,
                geometry_known: true,
                ..Default::default()
            }),
        };
        {
            let mut s = f.s.lock().unwrap();
            let mut editor = app("org.gnome.texteditor", "Text Editor", EDITOR_PID);
            editor.frontmost = true;
            s.apps = vec![
                editor,
                app("gnome-terminal", "Terminal", TERMINAL_PID),
                app("keepassxc", "KeePassXC", KEEPASS_PID),
                app("thunderbird", "Thunderbird", MAIL_PID),
                app("psyche", "Psyche", PSYCHE_PID),
            ];
            for (i, a) in s.apps.clone().iter().enumerate() {
                let x = 200.0 * i as f64;
                s.windows.push(WinInfo {
                    id: u64::from(a.pid),
                    pid: a.pid,
                    title: a.name.clone(),
                    bounds: Some(Rect::new(x, 0.0, 200.0, 200.0)),
                    layer: 0,
                    focused: i == 0,
                    minimized: false,
                });
            }
            s.focus_pid = Some(EDITOR_PID);
        }
        f
    }

    /// Adds a node and returns its id.
    pub fn add(
        &self,
        parent: Option<u32>,
        role: u32,
        name: &str,
        frame: Option<Rect>,
        tweak: impl FnOnce(&mut AtspiFacts, &mut ElementInfo),
    ) -> u32 {
        let mut s = self.s.lock().unwrap();
        let id = s.next;
        s.next += 1;
        let mut facts = AtspiFacts {
            role,
            ..Default::default()
        };
        let mut info = ElementInfo::new("AXUnknown");
        info.title = (!name.is_empty()).then(|| name.to_string());
        tweak(&mut facts, &mut info);
        let ax = crate::roles::map_role(&facts);
        info.role = ax.role.to_string();
        info.subrole = ax.subrole.map(str::to_string);
        info.frame = frame;
        let pid = parent
            .and_then(|p| s.nodes.get(&p).and_then(|n| n.data.as_ref().map(|d| d.pid)))
            .unwrap_or(EDITOR_PID);
        s.nodes.insert(
            id,
            Node {
                data: Some(ElementData { info, facts, pid }),
                children: vec![],
                frame,
                value: None,
            },
        );
        if let Some(p) = parent {
            s.nodes.get_mut(&p).unwrap().children.push(id);
        }
        id
    }

    pub fn set_pid(&self, id: u32, pid: u32) {
        self.s
            .lock()
            .unwrap()
            .nodes
            .get_mut(&id)
            .unwrap()
            .data
            .as_mut()
            .unwrap()
            .pid = pid;
    }

    /// A window for `pid` with a root node; returns the root id.
    pub fn window(&self, pid: u32, title: &str) -> u32 {
        let w = self.add(
            None,
            role::FRAME,
            title,
            Some(Rect::new(0.0, 0.0, 200.0, 200.0)),
            |f, _| f.top_level = true,
        );
        self.set_pid(w, pid);
        self.s
            .lock()
            .unwrap()
            .app_roots
            .entry(pid)
            .or_default()
            .push(w);
        w
    }

    pub fn child(
        &self,
        parent: u32,
        role: u32,
        name: &str,
        frame: Option<Rect>,
        tweak: impl FnOnce(&mut AtspiFacts, &mut ElementInfo),
    ) -> u32 {
        let id = self.add(Some(parent), role, name, frame, tweak);
        let pid = self.s.lock().unwrap().nodes[&parent]
            .data
            .as_ref()
            .unwrap()
            .pid;
        self.set_pid(id, pid);
        id
    }

    pub fn log(&self) -> Vec<String> {
        self.s.lock().unwrap().log.clone()
    }

    fn push(&self, line: String) {
        self.s.lock().unwrap().log.push(line);
    }
}

impl Default for Fake {
    fn default() -> Self {
        Fake::new()
    }
}

impl TreeSource for Fake {
    type Element = u32;
    fn info(&self, e: &u32) -> Option<ElementInfo> {
        self.s
            .lock()
            .unwrap()
            .nodes
            .get(e)
            .and_then(|n| n.data.as_ref().map(|d| d.info.clone()))
    }
    fn children(&self, e: &u32) -> Vec<u32> {
        self.s
            .lock()
            .unwrap()
            .nodes
            .get(e)
            .map(|n| n.children.clone())
            .unwrap_or_default()
    }
    fn actions(&self, e: &u32) -> Vec<String> {
        let s = self.s.lock().unwrap();
        let Some(d) = s.nodes.get(e).and_then(|n| n.data.as_ref()) else {
            return vec![];
        };
        crate::roles::actions(&d.facts, crate::roles::map_role(&d.facts).role)
    }
    fn is_value_settable(&self, e: &u32) -> bool {
        let s = self.s.lock().unwrap();
        s.nodes
            .get(e)
            .and_then(|n| n.data.as_ref())
            .is_some_and(|d| crate::roles::value_settable(&d.facts))
    }
}

impl Backend for Fake {
    fn check_desktop(&self) -> CapResult<()> {
        Ok(())
    }
    fn window_geometry_known(&self) -> bool {
        self.s.lock().unwrap().geometry_known
    }
    fn apps(&self) -> Vec<AppInfo> {
        self.s.lock().unwrap().apps.clone()
    }
    fn windows(&self) -> Vec<WinInfo> {
        self.s.lock().unwrap().windows.clone()
    }
    fn keyboard_focus_pid(&self) -> Option<u32> {
        self.s.lock().unwrap().focus_pid
    }
    fn activate(&self, app: &AppInfo, _w: Option<usize>, _stop: &StopSignal) -> CapResult<bool> {
        self.push(format!("activate {}", app.id));
        let mut s = self.s.lock().unwrap();
        if s.focus_denied {
            return Ok(false);
        }
        s.focus_pid = Some(app.pid);
        Ok(true)
    }
    fn launch(&self, id: &str, _url: Option<&str>) -> CapResult<Value> {
        self.push(format!("launch {id}"));
        Ok(json!({"bundleId": id}))
    }
    fn begin_walk(&self, _budget: Duration) {}
    fn window_elements(&self, app: &AppInfo) -> Vec<u32> {
        self.s
            .lock()
            .unwrap()
            .app_roots
            .get(&app.pid)
            .cloned()
            .unwrap_or_default()
    }
    fn app_element(&self, app: &AppInfo) -> u32 {
        self.s
            .lock()
            .unwrap()
            .app_roots
            .get(&app.pid)
            .and_then(|v| v.first().copied())
            .unwrap_or(0)
    }
    fn focused_element(&self, _app: Option<&AppInfo>) -> Option<u32> {
        self.s.lock().unwrap().focused_element
    }
    fn data(&self, e: &u32) -> Option<ElementData> {
        self.s
            .lock()
            .unwrap()
            .nodes
            .get(e)
            .and_then(|n| n.data.clone())
    }
    fn set_focus(&self, e: &u32) -> Result<(), ActError> {
        self.push(format!("focus {e}"));
        let mut s = self.s.lock().unwrap();
        if !s.element_focus_ignored {
            s.focused_element = Some(*e);
        }
        Ok(())
    }
    fn perform(&self, e: &u32, action: &str) -> Result<(), ActError> {
        self.push(format!("perform {e} {action}"));
        if self.s.lock().unwrap().perform_fails {
            return Err(ActError::new("the app refused"));
        }
        Ok(())
    }
    fn set_value(&self, e: &u32, value: &str) -> Result<(), ActError> {
        self.push(format!("set_value {e}"));
        self.s.lock().unwrap().nodes.get_mut(e).unwrap().value = Some(value.to_string());
        Ok(())
    }
    fn current_value(&self, e: &u32) -> Option<String> {
        self.s
            .lock()
            .unwrap()
            .nodes
            .get(e)
            .and_then(|n| n.value.clone())
    }
    fn full_value(&self, e: &u32, max: usize) -> Option<String> {
        self.current_value(e).map(|v| v.chars().take(max).collect())
    }
    fn select(&self, e: &u32) -> Result<(), ActError> {
        self.push(format!("select {e}"));
        Ok(())
    }
    fn is_selected(&self, _e: &u32) -> Option<bool> {
        Some(true)
    }
    fn frame(&self, e: &u32) -> Option<Rect> {
        self.s.lock().unwrap().nodes.get(e).and_then(|n| n.frame)
    }
    fn hit_test(&self, x: f64, y: f64) -> Option<Hit> {
        let s = self.s.lock().unwrap();
        let w = s
            .windows
            .iter()
            .find(|w| w.bounds.is_some_and(|b| b.contains(x, y)))?;
        Some(Hit {
            pid: w.pid,
            role: None,
            secure: s.focus_secure && s.focused_element.is_some(),
            labels: vec![],
        })
    }
    fn focused_is_secure(&self, _app: Option<&AppInfo>) -> bool {
        self.s.lock().unwrap().focus_secure
    }
    fn click(
        &self,
        x: f64,
        y: f64,
        count: u32,
        right: bool,
        _m: Mods,
        _stop: &StopSignal,
    ) -> CapResult<()> {
        self.push(format!(
            "click {x},{y} x{count}{}",
            if right { " right" } else { "" }
        ));
        Ok(())
    }
    fn type_text(
        &self,
        text: &str,
        stop: &StopSignal,
        before: &mut dyn FnMut() -> CapResult<()>,
    ) -> CapResult<()> {
        for chunk in crate::keychord::typing_chunks(text, 4) {
            stop.check()?;
            before()?;
            self.s.lock().unwrap().typed.push_str(&chunk);
        }
        self.push(format!("typed {}", text.chars().count()));
        Ok(())
    }
    fn key(&self, chord: &KeyChord, _stop: &StopSignal) -> CapResult<()> {
        self.push(format!("key {}", chord.name));
        Ok(())
    }
    fn scroll(&self, x: f64, y: f64, dx: i32, dy: i32, _stop: &StopSignal) -> CapResult<()> {
        self.push(format!("scroll {x},{y} {dx},{dy}"));
        Ok(())
    }
    fn drag(&self, a: (f64, f64), b: (f64, f64), _stop: &StopSignal) -> CapResult<()> {
        self.push(format!("drag {a:?}->{b:?}"));
        Ok(())
    }
    fn pause(&self, _ms: u64, stop: &StopSignal) -> CapResult<()> {
        stop.check()
    }
    fn capture(&self, _display: Option<usize>) -> CapResult<Frame> {
        // A white 1000x200 screen: five 200-wide windows side by side.
        Ok(Frame {
            width: 1000,
            height: 200,
            rgba: vec![255; 1000 * 200 * 4],
            screen: Rect::new(0.0, 0.0, 1000.0, 200.0),
            scale: 1.0,
        })
    }
    fn displays(&self) -> Vec<Rect> {
        vec![Rect::new(0.0, 0.0, 1000.0, 200.0)]
    }
}

pub fn err_reason(r: &CapResult<crate::engine::CapOutput>) -> (&'static str, String) {
    match r {
        Ok(_) => (code::INTERNAL, "ok".into()),
        Err(e) => (e.code, e.reason.clone()),
    }
}

#[allow(dead_code)]
fn _unused(_: CapError) {}
