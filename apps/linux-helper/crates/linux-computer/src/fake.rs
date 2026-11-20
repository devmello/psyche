//! A fake desktop for the engine's tests (and the helper's own tests): a few apps, a tree, and a
//! log of every input call, so the checks below the model can be asserted without a display.

use crate::backend::{ActError, AppInfo, Backend, Described, ElementData, Frame, Hit, WinInfo};
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
    /// The document address a browser's document node exposes (`DocURL`).
    pub url: Option<String>,
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
    /// The Stop is not in place (X11: another client holds Escape).
    pub no_kill_switch: bool,
    /// After this many typed chunks, keyboard focus goes to an app the desktop cannot name (a
    /// terminal without AT-SPI): the focus pid becomes unknown.
    pub focus_lost_after_chunks: Option<usize>,
    /// Another client holds the keyboard (an X11 launcher such as dmenu); focus is unchanged.
    pub keyboard_grabbed: bool,
    /// After this many typed chunks, another client grabs the keyboard.
    pub keyboard_grabbed_after_chunks: Option<usize>,
    /// After this many key presses, another client grabs the keyboard (Alt+P opening dmenu).
    pub keyboard_grabbed_after_keys: Option<usize>,
    /// Desktop ids whose winning entry is one the agent could have written
    /// (`~/.local/share/applications`): `check_launch` and `launch` refuse them.
    pub untrusted_entries: Vec<String>,
}

pub struct Fake {
    pub s: Mutex<State>,
}

impl State {
    fn parent_of(&self, id: u32) -> Option<u32> {
        self.nodes
            .iter()
            .find(|(_, n)| n.children.contains(&id))
            .map(|(p, _)| *p)
    }

    fn is_window(&self, id: u32) -> bool {
        self.nodes
            .get(&id)
            .and_then(|n| n.data.as_ref())
            .is_some_and(|d| d.facts.top_level)
    }

    fn title(&self, id: u32) -> Option<String> {
        self.nodes
            .get(&id)
            .and_then(|n| n.data.as_ref())
            .and_then(|d| d.info.title.clone())
    }

    /// Labels of the ancestors of `id`, nearest first, up to (not including) the window; then the
    /// window's title and the nearest document address.
    fn describe(&self, id: u32) -> Described {
        let mut out = Described::default();
        let mut url = self.nodes.get(&id).and_then(|n| n.url.clone());
        let mut window = if self.is_window(id) {
            self.title(id)
        } else {
            None
        };
        let mut cur = self.parent_of(id);
        while let Some(p) = cur {
            url = url.or_else(|| self.nodes.get(&p).and_then(|n| n.url.clone()));
            if self.is_window(p) {
                window = self.title(p);
                break;
            }
            if let Some(t) = self.title(p) {
                out.ancestors.push(t);
            }
            cur = self.parent_of(p);
        }
        out.window = window;
        out.url = url;
        out
    }

    /// The deepest node under a point in `root`'s subtree (frames as the tree reports them).
    fn deepest_at(&self, root: u32, x: f64, y: f64) -> Option<u32> {
        let n = self.nodes.get(&root)?;
        if !n.frame.is_some_and(|f| f.contains(x, y)) {
            return None;
        }
        Some(
            n.children
                .iter()
                .rev()
                .find_map(|c| self.deepest_at(*c, x, y))
                .unwrap_or(root),
        )
    }
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
                url: None,
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

    pub fn set_url(&self, id: u32, url: &str) {
        self.s.lock().unwrap().nodes.get_mut(&id).unwrap().url = Some(url.to_string());
    }

    pub fn log(&self) -> Vec<String> {
        self.s.lock().unwrap().log.clone()
    }

    fn push(&self, line: String) {
        self.s.lock().unwrap().log.push(line);
    }

    fn trusted_entry(&self, id: &str) -> CapResult<()> {
        if self
            .s
            .lock()
            .unwrap()
            .untrusted_entries
            .iter()
            .any(|u| u.eq_ignore_ascii_case(id))
        {
            let file = format!("/home/me/.local/share/applications/{id}.desktop");
            return Err(crate::trust::untrusted_entry(
                id,
                std::path::Path::new(&file),
                &crate::trust::Untrusted::OwnedByHelper("/home/me".into()),
            ));
        }
        Ok(())
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
    fn keyboard_free(&self) -> CapResult<bool> {
        Ok(!self.s.lock().unwrap().keyboard_grabbed)
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
    fn check_launch(&self, id: &str) -> CapResult<()> {
        self.push(format!("check_launch {id}"));
        self.trusted_entry(id)
    }
    fn launch(&self, id: &str, url: Option<&str>) -> CapResult<Value> {
        self.trusted_entry(id)?;
        match url {
            Some(u) => self.push(format!("launch {id} {u}")),
            None => self.push(format!("launch {id}")),
        }
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
            .find(|w| !w.minimized && w.bounds.is_some_and(|b| b.contains(x, y)))?;
        let mut hit = Hit {
            pid: w.pid,
            secure: s.focus_secure && s.focused_element.is_some(),
            window: Some(w.title.clone()),
            ..Hit::default()
        };
        // The element there, when the window's app exposes a tree (frames are screen points).
        let el = s
            .app_roots
            .get(&w.pid)
            .into_iter()
            .flatten()
            .find_map(|r| s.deepest_at(*r, x, y));
        if let Some(id) = el {
            let d = s.nodes[&id].data.clone().unwrap();
            let ax = crate::roles::map_role(&d.facts);
            let around = s.describe(id);
            hit.role = Some(ax.role.to_string());
            hit.subrole = ax.subrole.map(str::to_string);
            hit.secure |= crate::roles::is_password(d.facts.role);
            if !d.facts.top_level {
                hit.labels = d.info.title.clone().into_iter().collect();
                hit.labels.extend(around.ancestors);
            }
            hit.window = around.window.or(hit.window);
            hit.url = around.url;
        }
        Some(hit)
    }
    fn describe(&self, e: &u32) -> Described {
        self.s.lock().unwrap().describe(*e)
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
        for (i, chunk) in crate::keychord::typing_chunks(text, 4).iter().enumerate() {
            stop.check()?;
            {
                let mut s = self.s.lock().unwrap();
                if s.focus_lost_after_chunks == Some(i) {
                    s.focus_pid = None;
                }
                if s.keyboard_grabbed_after_chunks == Some(i) {
                    s.keyboard_grabbed = true;
                }
            }
            before()?;
            self.s.lock().unwrap().typed.push_str(chunk);
        }
        self.push(format!("typed {}", text.chars().count()));
        Ok(())
    }
    fn key(&self, chord: &KeyChord, _stop: &StopSignal) -> CapResult<()> {
        self.push(format!("key {}", chord.name));
        let mut s = self.s.lock().unwrap();
        let keys = s.log.iter().filter(|l| l.starts_with("key ")).count();
        if s.keyboard_grabbed_after_keys == Some(keys) {
            s.keyboard_grabbed = true;
        }
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
    fn kill_switch_ready(&self) -> bool {
        !self.s.lock().unwrap().no_kill_switch
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
