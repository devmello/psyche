//! The X side of the window manager: takes `SubstructureRedirect` on the root, turns X events
//! into `WmEvent`s for the state machine in `wm.rs`, and applies the `WmAction`s that come back.
//! It also keeps a table of the windows (title, pid) for the rest of the helper, and lets a
//! caller wait for the next window to be mapped.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    self, AtomEnum, ChangeWindowAttributesAux, ClientMessageEvent, ConfigWindow, ConfigureNotifyEvent,
    ConfigureWindowAux, ConnectionExt, EventMask, InputFocus, PropMode, StackMode, Window,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{atom_manager, CURRENT_TIME, NONE};

use super::wm::{FocusMethod, Rect, WinId, Wm, WindowInfo, WindowKind, WmAction, WmEvent};

atom_manager! {
    pub Atoms: AtomsCookie {
        WM_PROTOCOLS,
        WM_DELETE_WINDOW,
        WM_TAKE_FOCUS,
        WM_HINTS,
        UTF8_STRING,
        _NET_SUPPORTED,
        _NET_SUPPORTING_WM_CHECK,
        _NET_CLIENT_LIST,
        _NET_ACTIVE_WINDOW,
        _NET_CLOSE_WINDOW,
        _NET_WM_NAME,
        _NET_WM_PID,
        _NET_WM_WINDOW_TYPE,
        _NET_WM_WINDOW_TYPE_DIALOG,
        _NET_WM_WINDOW_TYPE_UTILITY,
        _NET_WM_WINDOW_TYPE_SPLASH,
        _NET_WM_WINDOW_TYPE_DOCK,
        _NET_WM_WINDOW_TYPE_DESKTOP,
        _NET_WM_WINDOW_TYPE_MENU,
        _NET_WM_WINDOW_TYPE_DROPDOWN_MENU,
        _NET_WM_WINDOW_TYPE_POPUP_MENU,
        _NET_WM_WINDOW_TYPE_TOOLTIP,
        _NET_WM_WINDOW_TYPE_NOTIFICATION,
        _NET_WM_WINDOW_TYPE_COMBO,
        _NET_WM_WINDOW_TYPE_DND,
        _NET_NUMBER_OF_DESKTOPS,
        _NET_CURRENT_DESKTOP,
        _NET_DESKTOP_GEOMETRY,
    }
}

/// What the rest of the helper knows about a mapped top-level.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowRecord {
    pub id: WinId,
    pub title: Option<String>,
    pub pid: Option<u32>,
    pub kind: WindowKind,
    pub transient_for: Option<WinId>,
    pub rect: Rect,
    /// Counts up with every window the manager mapped; lets a caller ask for "a new one".
    pub map_serial: u64,
}

#[derive(Default)]
struct Table {
    windows: Vec<WindowRecord>,
    serial: u64,
}

pub struct WmDriver {
    conn: Arc<RustConnection>,
    root: Window,
    atoms: Atoms,
    wm: Mutex<Wm>,
    table: Mutex<Table>,
    changed: Condvar,
    alive: AtomicBool,
}

fn utf8_or_latin1(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

impl WmDriver {
    /// Becomes the window manager of the display behind `conn` and starts its event thread.
    pub fn start(conn: Arc<RustConnection>, screen_num: usize) -> Result<Arc<WmDriver>, String> {
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let (w, h) = (u32::from(screen.width_in_pixels), u32::from(screen.height_in_pixels));
        let atoms = Atoms::new(&*conn)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        // Only one window manager may hold SubstructureRedirect; the server tells us if it is taken.
        conn.change_window_attributes(
            root,
            &ChangeWindowAttributesAux::new().event_mask(
                EventMask::SUBSTRUCTURE_REDIRECT
                    | EventMask::SUBSTRUCTURE_NOTIFY
                    | EventMask::PROPERTY_CHANGE,
            ),
        )
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| format!("another window manager is running: {e}"))?;
        let driver = Arc::new(WmDriver {
            conn,
            root,
            atoms,
            wm: Mutex::new(Wm::new(w, h)),
            table: Mutex::new(Table::default()),
            changed: Condvar::new(),
            alive: AtomicBool::new(true),
        });
        driver.advertise(w, h).map_err(|e| e.to_string())?;
        let thread_driver = Arc::clone(&driver);
        std::thread::Builder::new()
            .name("vscreen-wm".into())
            .spawn(move || thread_driver.run())
            .map_err(|e| e.to_string())?;
        Ok(driver)
    }

    fn advertise(&self, w: u32, h: u32) -> Result<(), Box<dyn std::error::Error>> {
        let c = &*self.conn;
        let a = &self.atoms;
        let check = c.generate_id()?;
        c.create_window(
            0,
            check,
            self.root,
            -10,
            -10,
            1,
            1,
            0,
            xproto::WindowClass::INPUT_ONLY,
            0,
            &xproto::CreateWindowAux::new(),
        )?;
        for win in [self.root, check] {
            c.change_property32(PropMode::REPLACE, win, a._NET_SUPPORTING_WM_CHECK, AtomEnum::WINDOW, &[check])?;
        }
        c.change_property8(PropMode::REPLACE, check, a._NET_WM_NAME, a.UTF8_STRING, b"psyche-vscreen")?;
        let supported = [
            a._NET_SUPPORTED,
            a._NET_SUPPORTING_WM_CHECK,
            a._NET_CLIENT_LIST,
            a._NET_ACTIVE_WINDOW,
            a._NET_CLOSE_WINDOW,
            a._NET_NUMBER_OF_DESKTOPS,
            a._NET_CURRENT_DESKTOP,
            a._NET_DESKTOP_GEOMETRY,
        ];
        c.change_property32(PropMode::REPLACE, self.root, a._NET_SUPPORTED, AtomEnum::ATOM, &supported)?;
        c.change_property32(PropMode::REPLACE, self.root, a._NET_NUMBER_OF_DESKTOPS, AtomEnum::CARDINAL, &[1])?;
        c.change_property32(PropMode::REPLACE, self.root, a._NET_CURRENT_DESKTOP, AtomEnum::CARDINAL, &[0])?;
        c.change_property32(PropMode::REPLACE, self.root, a._NET_DESKTOP_GEOMETRY, AtomEnum::CARDINAL, &[w, h])?;
        c.flush()?;
        Ok(())
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn run(&self) {
        loop {
            let event = match self.conn.wait_for_event() {
                Ok(e) => e,
                Err(_) => break,
            };
            self.dispatch(event);
            while let Ok(Some(e)) = self.conn.poll_for_event() {
                self.dispatch(e);
            }
            let _ = self.conn.flush();
        }
        self.alive.store(false, Ordering::SeqCst);
        self.changed.notify_all();
    }

    fn dispatch(&self, event: Event) {
        match event {
            Event::MapRequest(e) => {
                if let Some(info) = self.read_info(e.window) {
                    // Title and pid changes are worth hearing about.
                    let _ = self.conn.change_window_attributes(
                        e.window,
                        &ChangeWindowAttributesAux::new()
                            .event_mask(EventMask::PROPERTY_CHANGE | EventMask::STRUCTURE_NOTIFY),
                    );
                    self.feed(WmEvent::MapRequest(info));
                }
            }
            Event::ConfigureRequest(e) => {
                let mask = e.value_mask;
                let cur = self.geometry(e.window).unwrap_or(Rect::new(0, 0, 1, 1));
                let rect = Rect::new(
                    if mask.contains(ConfigWindow::X) { i32::from(e.x) } else { cur.x },
                    if mask.contains(ConfigWindow::Y) { i32::from(e.y) } else { cur.y },
                    if mask.contains(ConfigWindow::WIDTH) { u32::from(e.width) } else { cur.w },
                    if mask.contains(ConfigWindow::HEIGHT) { u32::from(e.height) } else { cur.h },
                );
                self.feed(WmEvent::ConfigureRequest { win: e.window, rect });
            }
            Event::UnmapNotify(e) => self.feed(WmEvent::Gone(e.window)),
            Event::DestroyNotify(e) => self.feed(WmEvent::Gone(e.window)),
            Event::PropertyNotify(e) => {
                let known = self.wm.lock().unwrap_or_else(|p| p.into_inner()).is_managed(e.window);
                if known {
                    if let Some(info) = self.read_info(e.window) {
                        self.feed(WmEvent::InfoChanged(info));
                    }
                }
            }
            Event::ClientMessage(e) => {
                if e.type_ == self.atoms._NET_ACTIVE_WINDOW {
                    self.feed(WmEvent::Activate(e.window));
                } else if e.type_ == self.atoms._NET_CLOSE_WINDOW {
                    self.feed(WmEvent::Close(e.window));
                }
            }
            _ => {}
        }
    }

    fn geometry(&self, win: Window) -> Option<Rect> {
        let g = self.conn.get_geometry(win).ok()?.reply().ok()?;
        Some(Rect::new(i32::from(g.x), i32::from(g.y), u32::from(g.width), u32::from(g.height)))
    }

    fn get_u32s(&self, win: Window, prop: u32, ty: impl Into<u32>, max: u32) -> Vec<u32> {
        self.conn
            .get_property(false, win, prop, ty, 0, max)
            .ok()
            .and_then(|c| c.reply().ok())
            .and_then(|r| r.value32().map(|v| v.collect()))
            .unwrap_or_default()
    }

    fn read_title(&self, win: Window) -> Option<String> {
        let a = &self.atoms;
        for (prop, ty) in [
            (a._NET_WM_NAME, a.UTF8_STRING),
            (AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()),
        ] {
            if let Some(r) = self
                .conn
                .get_property(false, win, prop, ty, 0, 256)
                .ok()
                .and_then(|c| c.reply().ok())
            {
                if !r.value.is_empty() {
                    return Some(utf8_or_latin1(&r.value));
                }
            }
        }
        None
    }

    fn read_info(&self, win: Window) -> Option<WindowInfo> {
        let a = &self.atoms;
        let requested = self.geometry(win)?;
        let types = self.get_u32s(win, a._NET_WM_WINDOW_TYPE, AtomEnum::ATOM, 16);
        let transient = self
            .get_u32s(win, AtomEnum::WM_TRANSIENT_FOR.into(), AtomEnum::WINDOW, 1)
            .first()
            .copied()
            .filter(|t| *t != NONE && *t != self.root);
        let kind = types
            .iter()
            .find_map(|t| {
                let t = *t;
                if t == a._NET_WM_WINDOW_TYPE_DIALOG || t == a._NET_WM_WINDOW_TYPE_UTILITY {
                    Some(WindowKind::Dialog)
                } else if t == a._NET_WM_WINDOW_TYPE_SPLASH {
                    Some(WindowKind::Splash)
                } else if t == a._NET_WM_WINDOW_TYPE_DOCK {
                    Some(WindowKind::Dock)
                } else if t == a._NET_WM_WINDOW_TYPE_DESKTOP {
                    Some(WindowKind::Desktop)
                } else if [
                    a._NET_WM_WINDOW_TYPE_MENU,
                    a._NET_WM_WINDOW_TYPE_DROPDOWN_MENU,
                    a._NET_WM_WINDOW_TYPE_POPUP_MENU,
                    a._NET_WM_WINDOW_TYPE_TOOLTIP,
                    a._NET_WM_WINDOW_TYPE_NOTIFICATION,
                    a._NET_WM_WINDOW_TYPE_COMBO,
                    a._NET_WM_WINDOW_TYPE_DND,
                ]
                .contains(&t)
                {
                    Some(WindowKind::Popup)
                } else {
                    None
                }
            })
            .unwrap_or(WindowKind::Normal);
        let hints = self.get_u32s(win, a.WM_HINTS, a.WM_HINTS, 9);
        // WM_HINTS: flags, then input. InputHint is bit 0.
        let input_hint = match (hints.first(), hints.get(1)) {
            (Some(flags), Some(input)) if flags & 1 != 0 => *input != 0,
            _ => true,
        };
        let protocols = self.get_u32s(win, a.WM_PROTOCOLS, AtomEnum::ATOM, 32);
        let mut info = WindowInfo::new(win, kind, requested);
        info.transient_for = transient;
        info.input_hint = input_hint;
        info.supports_take_focus = protocols.contains(&a.WM_TAKE_FOCUS);
        info.supports_delete = protocols.contains(&a.WM_DELETE_WINDOW);
        info.title = self.read_title(win);
        info.pid = self.get_u32s(win, a._NET_WM_PID, AtomEnum::CARDINAL, 1).first().copied();
        Some(info)
    }

    fn feed(&self, event: WmEvent) {
        let mapped = matches!(event, WmEvent::MapRequest(_));
        let gone = if let WmEvent::Gone(w) = &event { Some(*w) } else { None };
        let mut wm = self.wm.lock().unwrap_or_else(|p| p.into_inner());
        let actions = wm.handle(event);
        self.apply(&actions);
        // Refresh the table from the state machine.
        let mut table = self.table.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(g) = gone {
            table.windows.retain(|w| w.id != g);
        }
        for id in wm.client_list() {
            let (Some(info), Some(rect)) = (wm.info_of(id), wm.rect_of(id)) else {
                continue;
            };
            match table.windows.iter_mut().find(|w| w.id == id) {
                Some(rec) => {
                    rec.title = info.title.clone();
                    rec.pid = info.pid;
                    rec.rect = rect;
                }
                None => {
                    table.serial += 1;
                    let serial = table.serial;
                    table.windows.push(WindowRecord {
                        id,
                        title: info.title.clone(),
                        pid: info.pid,
                        kind: info.kind,
                        transient_for: info.transient_for,
                        rect,
                        map_serial: serial,
                    });
                }
            }
        }
        let _ = mapped;
        drop(table);
        drop(wm);
        self.changed.notify_all();
    }

    fn apply(&self, actions: &[WmAction]) {
        let c = &*self.conn;
        let a = &self.atoms;
        for action in actions {
            // A window can vanish between the event and the request; those errors are expected.
            match action {
                WmAction::Configure { win, rect } => {
                    let _ = c.configure_window(
                        *win,
                        &ConfigureWindowAux::new()
                            .x(rect.x)
                            .y(rect.y)
                            .width(rect.w)
                            .height(rect.h)
                            .border_width(0),
                    );
                }
                WmAction::SyntheticConfigureNotify { win, rect } => {
                    let ev = ConfigureNotifyEvent {
                        response_type: xproto::CONFIGURE_NOTIFY_EVENT,
                        sequence: 0,
                        event: *win,
                        window: *win,
                        above_sibling: NONE,
                        x: rect.x as i16,
                        y: rect.y as i16,
                        width: rect.w as u16,
                        height: rect.h as u16,
                        border_width: 0,
                        override_redirect: false,
                    };
                    let _ = c.send_event(false, *win, EventMask::STRUCTURE_NOTIFY, ev);
                }
                WmAction::Map(win) => {
                    let _ = c.map_window(*win);
                }
                WmAction::Raise(win) => {
                    let _ = c.configure_window(*win, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
                }
                WmAction::Lower(win) => {
                    let _ = c.configure_window(*win, &ConfigureWindowAux::new().stack_mode(StackMode::BELOW));
                }
                WmAction::Focus { win, method } => match method {
                    FocusMethod::SetInputFocus => {
                        let _ = c.set_input_focus(InputFocus::PARENT, *win, CURRENT_TIME);
                    }
                    FocusMethod::TakeFocus => {
                        self.send_protocol(*win, a.WM_TAKE_FOCUS);
                    }
                    FocusMethod::Nothing => {}
                },
                WmAction::RequestClose { win, supports_delete } => {
                    if *supports_delete {
                        self.send_protocol(*win, a.WM_DELETE_WINDOW);
                    } else {
                        let _ = c.kill_client(*win);
                    }
                }
                WmAction::Publish { client_list, active } => {
                    let _ = c.change_property32(PropMode::REPLACE, self.root, a._NET_CLIENT_LIST, AtomEnum::WINDOW, client_list);
                    let _ = c.change_property32(
                        PropMode::REPLACE,
                        self.root,
                        a._NET_ACTIVE_WINDOW,
                        AtomEnum::WINDOW,
                        &[active.unwrap_or(NONE)],
                    );
                }
            }
        }
        let _ = c.flush();
    }

    fn send_protocol(&self, win: Window, protocol: u32) {
        let ev = ClientMessageEvent::new(32, win, self.atoms.WM_PROTOCOLS, [protocol, CURRENT_TIME, 0, 0, 0]);
        let _ = self.conn.send_event(false, win, EventMask::NO_EVENT, ev);
        let _ = self.conn.flush();
    }

    // ---- what the rest of the helper uses ----

    /// Mapped top-levels, oldest first.
    pub fn windows(&self) -> Vec<WindowRecord> {
        self.table.lock().unwrap_or_else(|p| p.into_inner()).windows.clone()
    }

    pub fn active(&self) -> Option<WinId> {
        self.wm.lock().unwrap_or_else(|p| p.into_inner()).active()
    }

    /// The serial of the newest window ever mapped: the baseline for `wait_for_window`.
    pub fn serial(&self) -> u64 {
        self.table.lock().unwrap_or_else(|p| p.into_inner()).serial
    }

    /// Asks a window to close (`WM_DELETE_WINDOW`). It does not force anything when the window
    /// answers with a "Save changes?" dialog.
    pub fn request_close(&self, win: WinId) {
        let mut wm = self.wm.lock().unwrap_or_else(|p| p.into_inner());
        let actions = wm.handle(WmEvent::Close(win));
        self.apply(&actions);
    }

    /// Waits until a window newer than `after_serial` is mapped and `accept` likes it. Returns
    /// it, or `None` at the timeout or when the display went away.
    pub fn wait_for_window(
        &self,
        after_serial: u64,
        timeout: Duration,
        accept: impl Fn(&WindowRecord) -> bool,
    ) -> Option<WindowRecord> {
        let deadline = Instant::now() + timeout;
        let mut table = self.table.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            if let Some(w) = table
                .windows
                .iter()
                .find(|w| w.map_serial > after_serial && accept(w))
            {
                return Some(w.clone());
            }
            if !self.is_alive() {
                return None;
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            table = self
                .changed
                .wait_timeout(table, left.min(Duration::from_millis(250)))
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }
}
