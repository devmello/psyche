//! The X11 path (linux-desktop design §6.4): XTest for input, MIT-SHM for capture, EWMH for
//! windows, and an `XGrabKey` on Escape as the kill switch during a session. X11 has no
//! permission model, so there is no dialog; Settings says so plainly.
//!
//! **Never used under Wayland.** [`X11::connect`] refuses when `WAYLAND_DISPLAY` is set: XTest
//! into Xwayland reaches only X apps (and recent Xwayland may route it through the portal), and
//! a half-working path that clicks the wrong window is worse than the portal's dialog.

use crate::backend::{Frame, WinInfo};
use crate::error::{code, CapError, CapResult};
use crate::keychord::{keysym, KeyChord};
use crate::snapshot::Rect;
use crate::tiers::StopSignal;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{self, AtomEnum, ConnectionExt as _, EventMask, GrabMode, ModMask};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::protocol::{shm, Event};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const MOTION_NOTIFY: u8 = 6;
/// Modifier masks to grab Escape under: none, Caps Lock, Num Lock, both.
const GRAB_MASKS: [u16; 4] = [0, 2, 16, 18];
/// How long the Escape grab outlives the last computer-use call (sessions lapse at 120 s).
const GRAB_LINGER: Duration = Duration::from_secs(130);

type StopFn = Box<dyn Fn() + Send + Sync>;

struct Atoms {
    client_list_stacking: u32,
    active_window: u32,
    wm_pid: u32,
    wm_name: u32,
    wm_state: u32,
    hidden: u32,
    above: u32,
    utf8: u32,
}

struct Keymap {
    min: u8,
    per: usize,
    syms: Vec<u32>,
    by_sym: HashMap<u32, (u8, bool)>,
    unused: Option<u8>,
}

pub struct X11 {
    conn: RustConnection,
    root: u32,
    atoms: Atoms,
    keymap: Mutex<Keymap>,
    /// The Escape key's keycode.
    esc: u8,
    grabbed: AtomicBool,
    last_touch: AtomicU64,
    started: Instant,
    on_stop: Arc<Mutex<Option<StopFn>>>,
    inject_esc: Arc<AtomicBool>,
    watcher: AtomicBool,
    last_owner: Arc<AtomicU64>,
    display: String,
}

fn xerr<E: std::fmt::Display>(e: E) -> CapError {
    CapError::unavailable("x11_error", format!("The X server refused a request: {e}"))
}

impl X11 {
    /// Connects to `$DISPLAY`. Refuses under Wayland and without XTEST.
    pub fn connect() -> CapResult<Arc<X11>> {
        if std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty()) {
            return Err(CapError::unavailable(
                "x11_under_wayland",
                "XTest is never used when a Wayland compositor is running",
            ));
        }
        let display = std::env::var("DISPLAY").unwrap_or_default();
        if display.is_empty() {
            return Err(CapError::unavailable(
                "no_graphical_session",
                "Needs a graphical session on this computer (no DISPLAY)",
            ));
        }
        let (conn, screen_num) = connect_display(&display).map_err(|e| {
            CapError::unavailable(
                "no_graphical_session",
                format!("Cannot open the display {display}: {e}"),
            )
        })?;
        let root = conn.setup().roots[screen_num].root;
        conn.xtest_get_version(2, 2)
            .map_err(xerr)?
            .reply()
            .map_err(|_| {
                CapError::unavailable(
                    "x11_no_xtest",
                    "The X server has no XTEST extension, so Psyche cannot send input",
                )
            })?;
        let atom = |name: &str| -> CapResult<u32> {
            Ok(conn
                .intern_atom(false, name.as_bytes())
                .map_err(xerr)?
                .reply()
                .map_err(xerr)?
                .atom)
        };
        let atoms = Atoms {
            client_list_stacking: atom("_NET_CLIENT_LIST_STACKING")?,
            active_window: atom("_NET_ACTIVE_WINDOW")?,
            wm_pid: atom("_NET_WM_PID")?,
            wm_name: atom("_NET_WM_NAME")?,
            wm_state: atom("_NET_WM_STATE")?,
            hidden: atom("_NET_WM_STATE_HIDDEN")?,
            above: atom("_NET_WM_STATE_ABOVE")?,
            utf8: atom("UTF8_STRING")?,
        };
        let setup = conn.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let map = conn
            .get_keyboard_mapping(min, max - min + 1)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        let per = map.keysyms_per_keycode as usize;
        let mut by_sym: HashMap<u32, (u8, bool)> = HashMap::new();
        let mut unused = None;
        for (i, chunk) in map.keysyms.chunks(per.max(1)).enumerate() {
            let kc = min + i as u8;
            if chunk.iter().all(|s| *s == 0) {
                unused = Some(kc);
            }
            if let Some(s) = chunk.first().filter(|s| **s != 0) {
                by_sym.entry(*s).or_insert((kc, false));
            }
            if let Some(s) = chunk.get(1).filter(|s| **s != 0) {
                by_sym.entry(*s).or_insert((kc, true));
            }
        }
        let esc = by_sym.get(&keysym::ESCAPE).map(|(k, _)| *k).unwrap_or(9);
        Ok(Arc::new(X11 {
            conn,
            root,
            atoms,
            keymap: Mutex::new(Keymap {
                min,
                per,
                syms: map.keysyms,
                by_sym,
                unused,
            }),
            esc,
            grabbed: AtomicBool::new(false),
            last_touch: AtomicU64::new(0),
            started: Instant::now(),
            on_stop: Arc::new(Mutex::new(None)),
            inject_esc: Arc::new(AtomicBool::new(false)),
            watcher: AtomicBool::new(false),
            last_owner: Arc::new(AtomicU64::new(0)),
            display,
        }))
    }

    pub fn display_name(&self) -> &str {
        &self.display
    }

    fn property(
        &self,
        win: u32,
        prop: impl Into<u32>,
        ty: impl Into<u32>,
        len: u32,
    ) -> Option<Vec<u8>> {
        let r = self
            .conn
            .get_property(false, win, prop.into(), ty.into(), 0, len)
            .ok()?
            .reply()
            .ok()?;
        (r.value_len > 0).then_some(r.value)
    }

    fn u32s(bytes: &[u8]) -> Vec<u32> {
        bytes
            .chunks_exact(4)
            .map(|c| u32::from_ne_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    }

    fn title(&self, win: u32) -> String {
        if let Some(v) = self.property(win, self.atoms.wm_name, self.atoms.utf8, 256) {
            return String::from_utf8_lossy(&v).into_owned();
        }
        self.property(win, AtomEnum::WM_NAME, AtomEnum::STRING, 256)
            .map(|v| String::from_utf8_lossy(&v).into_owned())
            .unwrap_or_default()
    }

    fn pid(&self, win: u32) -> Option<u32> {
        self.property(win, self.atoms.wm_pid, AtomEnum::CARDINAL, 1)
            .and_then(|v| Self::u32s(&v).first().copied())
    }

    fn rect(&self, win: u32) -> Option<Rect> {
        let g = self.conn.get_geometry(win).ok()?.reply().ok()?;
        let t = self
            .conn
            .translate_coordinates(win, self.root, 0, 0)
            .ok()?
            .reply()
            .ok()?;
        Some(Rect::new(
            f64::from(t.dst_x),
            f64::from(t.dst_y),
            f64::from(g.width),
            f64::from(g.height),
        ))
    }

    fn active(&self) -> Option<u32> {
        self.property(self.root, self.atoms.active_window, AtomEnum::WINDOW, 1)
            .and_then(|v| Self::u32s(&v).first().copied())
            .filter(|w| *w != 0)
    }

    /// Top-level windows with a pid, front to back.
    pub fn windows(&self) -> Vec<WinInfo> {
        let mut ids: Vec<u32> = self
            .property(
                self.root,
                self.atoms.client_list_stacking,
                AtomEnum::WINDOW,
                1024,
            )
            .map(|v| Self::u32s(&v))
            .unwrap_or_default();
        ids.reverse(); // bottom-to-top -> front-to-back
        if ids.is_empty() {
            // No EWMH window manager (a bare Xvfb): the root's mapped children, top first.
            if let Some(t) = self
                .conn
                .query_tree(self.root)
                .ok()
                .and_then(|c| c.reply().ok())
            {
                ids = t
                    .children
                    .into_iter()
                    .rev()
                    .filter(|w| self.is_viewable(*w))
                    .collect();
                // A child of the root may be a frame; look one level down for the client.
                ids = ids
                    .into_iter()
                    .filter_map(|w| {
                        if self.pid(w).is_some() {
                            Some(w)
                        } else {
                            self.client_below(w)
                        }
                    })
                    .collect();
            }
        }
        let active = self.active();
        ids.into_iter()
            .filter_map(|w| {
                let pid = self.pid(w)?;
                let state = self
                    .property(w, self.atoms.wm_state, AtomEnum::ATOM, 32)
                    .map(|v| Self::u32s(&v))
                    .unwrap_or_default();
                Some(WinInfo {
                    id: u64::from(w),
                    pid,
                    title: self.title(w),
                    bounds: self.rect(w),
                    layer: i32::from(state.contains(&self.atoms.above)),
                    focused: active == Some(w),
                    minimized: state.contains(&self.atoms.hidden),
                })
            })
            .collect()
    }

    fn is_viewable(&self, w: u32) -> bool {
        self.conn
            .get_window_attributes(w)
            .ok()
            .and_then(|c| c.reply().ok())
            .is_some_and(|a| a.map_state == xproto::MapState::VIEWABLE)
    }

    fn client_below(&self, w: u32) -> Option<u32> {
        let t = self.conn.query_tree(w).ok()?.reply().ok()?;
        t.children.into_iter().find(|c| self.pid(*c).is_some())
    }

    /// Top-left of the window of `pid` titled `title` (the only window of the pid when the
    /// titles do not tell), in screen points.
    pub fn window_origin(&self, pid: u32, title: &str) -> Option<(f64, f64)> {
        let wins: Vec<WinInfo> = self
            .windows()
            .into_iter()
            .filter(|w| w.pid == pid)
            .collect();
        let w = wins
            .iter()
            .find(|w| !title.is_empty() && w.title == title)
            .or(if wins.len() == 1 { wins.first() } else { None })?;
        w.bounds.map(|b| (b.x, b.y))
    }

    /// The pid that has keyboard focus.
    pub fn focus_pid(&self) -> Option<u32> {
        let mut w = self.conn.get_input_focus().ok()?.reply().ok()?.focus;
        for _ in 0..8 {
            if w == 0 || w == 1 || w == self.root {
                return self.active().and_then(|a| self.pid(a));
            }
            if let Some(p) = self.pid(w) {
                return Some(p);
            }
            w = self.conn.query_tree(w).ok()?.reply().ok()?.parent;
        }
        None
    }

    /// Raises and focuses a window of `pid` (EWMH `_NET_ACTIVE_WINDOW`). `Ok(true)` when it
    /// became the active window.
    pub fn activate(&self, pid: u32, index: Option<usize>) -> CapResult<bool> {
        let wins: Vec<WinInfo> = self
            .windows()
            .into_iter()
            .filter(|w| w.pid == pid && !w.minimized)
            .collect();
        let w = wins
            .get(index.unwrap_or(0))
            .or_else(|| wins.first())
            .ok_or_else(|| {
                CapError::new(
                    code::NOT_FOUND,
                    "no_window",
                    "The app has no window to bring forward",
                )
            })?;
        let win = w.id as u32;
        if self.active() == Some(win) {
            return Ok(true);
        }
        let ev =
            xproto::ClientMessageEvent::new(32, win, self.atoms.active_window, [2, 0, 0, 0, 0]);
        self.conn
            .send_event(
                false,
                self.root,
                EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                ev,
            )
            .map_err(xerr)?;
        self.conn
            .set_input_focus(xproto::InputFocus::POINTER_ROOT, win, x11rb::CURRENT_TIME)
            .map_err(xerr)?;
        self.conn.flush().map_err(xerr)?;
        std::thread::sleep(Duration::from_millis(80));
        Ok(self.active().is_none() || self.active() == Some(win))
    }

    // --- Input ------------------------------------------------------------------------------

    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> CapResult<()> {
        self.conn
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0)
            .map_err(xerr)?;
        Ok(())
    }

    pub fn move_to(&self, x: f64, y: f64) -> CapResult<()> {
        self.fake(MOTION_NOTIFY, 0, x.round() as i16, y.round() as i16)?;
        self.conn.flush().map_err(xerr)
    }

    fn button(&self, n: u8, press: bool) -> CapResult<()> {
        self.fake(if press { BUTTON_PRESS } else { BUTTON_RELEASE }, n, 0, 0)
    }

    pub fn click(
        &self,
        x: f64,
        y: f64,
        count: u32,
        right: bool,
        mods: &[u32],
        stop: &StopSignal,
    ) -> CapResult<()> {
        stop.check()?;
        self.move_to(x, y)?;
        std::thread::sleep(Duration::from_millis(20));
        let held = self.press_mods(mods)?;
        let b = if right { 3 } else { 1 };
        for _ in 0..count {
            stop.check().inspect_err(|_| self.release_mods(&held))?;
            self.button(b, true)?;
            self.button(b, false)?;
            self.conn.flush().map_err(xerr)?;
            std::thread::sleep(Duration::from_millis(40));
        }
        self.release_mods(&held);
        Ok(())
    }

    pub fn scroll(&self, x: f64, y: f64, dx: i32, dy: i32, stop: &StopSignal) -> CapResult<()> {
        stop.check()?;
        self.move_to(x, y)?;
        // Buttons 4/5 are up/down, 6/7 left/right. dy > 0 scrolls up, dx > 0 scrolls left.
        for (n, button) in [
            (dy.unsigned_abs(), if dy > 0 { 4 } else { 5 }),
            (dx.unsigned_abs(), if dx > 0 { 6 } else { 7 }),
        ] {
            for _ in 0..n.min(200) {
                stop.check()?;
                self.button(button, true)?;
                self.button(button, false)?;
                self.conn.flush().map_err(xerr)?;
                std::thread::sleep(Duration::from_millis(8));
            }
        }
        Ok(())
    }

    pub fn drag(&self, from: (f64, f64), to: (f64, f64), stop: &StopSignal) -> CapResult<()> {
        stop.check()?;
        self.move_to(from.0, from.1)?;
        std::thread::sleep(Duration::from_millis(40));
        self.button(1, true)?;
        let release = || {
            let _ = self.button(1, false);
            let _ = self.conn.flush();
        };
        for i in 1..=12 {
            if let Err(e) = stop.check() {
                release();
                return Err(e);
            }
            let t = f64::from(i) / 12.0;
            self.move_to(from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t)?;
            std::thread::sleep(Duration::from_millis(15));
        }
        release();
        Ok(())
    }

    fn lookup(&self, sym: u32) -> CapResult<(u8, bool, bool)> {
        // (keycode, needs shift, is scratch)
        {
            let km = self.keymap.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((kc, shift)) = km.by_sym.get(&sym) {
                return Ok((*kc, *shift, false));
            }
        }
        // Not on the keyboard: borrow an unused keycode for one keystroke (the xdotool trick).
        let (kc, per) = {
            let km = self.keymap.lock().unwrap_or_else(|e| e.into_inner());
            (
                km.unused.ok_or_else(|| {
                    CapError::unavailable(
                        "no_spare_keycode",
                        "No spare keycode to type that character",
                    )
                })?,
                km.per,
            )
        };
        self.conn
            .change_keyboard_mapping(1, kc, per as u8, &vec![sym; per])
            .map_err(xerr)?;
        self.conn.sync().map_err(xerr)?;
        Ok((kc, false, true))
    }

    fn restore_scratch(&self, kc: u8) {
        let km = self.keymap.lock().unwrap_or_else(|e| e.into_inner());
        let off = (kc - km.min) as usize * km.per;
        if let Some(orig) = km.syms.get(off..off + km.per) {
            let _ = self.conn.change_keyboard_mapping(1, kc, km.per as u8, orig);
            let _ = self.conn.sync();
        }
    }

    fn press_mods(&self, mods: &[u32]) -> CapResult<Vec<u8>> {
        let mut held = Vec::new();
        for m in mods {
            let (kc, ..) = self.lookup(*m)?;
            self.fake(KEY_PRESS, kc, 0, 0)?;
            held.push(kc);
        }
        Ok(held)
    }

    fn release_mods(&self, held: &[u8]) {
        for kc in held.iter().rev() {
            let _ = self.fake(KEY_RELEASE, *kc, 0, 0);
        }
        let _ = self.conn.flush();
    }

    /// One key (with the modifiers held around it).
    fn tap(&self, sym: u32, mods: &[u32]) -> CapResult<()> {
        let (kc, shift, scratch) = self.lookup(sym)?;
        let result = (|| {
            let mut all: Vec<u32> = mods.to_vec();
            if shift && !all.contains(&keysym::SHIFT_L) {
                all.push(keysym::SHIFT_L);
            }
            let held = self.press_mods(&all)?;
            let r = self
                .fake(KEY_PRESS, kc, 0, 0)
                .and_then(|_| self.fake(KEY_RELEASE, kc, 0, 0))
                .and_then(|_| self.conn.flush().map_err(xerr));
            self.release_mods(&held);
            r
        })();
        if scratch {
            self.restore_scratch(kc);
        }
        result
    }

    pub fn key(&self, chord: &KeyChord, stop: &StopSignal) -> CapResult<()> {
        stop.check()?;
        // Our own Escape must not fire our own kill switch.
        let esc = chord.keysym == keysym::ESCAPE;
        if esc {
            self.inject_esc.store(true, Ordering::SeqCst);
            self.ungrab();
        }
        let r = self.tap(chord.keysym, &chord.mods.keysyms());
        if esc {
            std::thread::sleep(Duration::from_millis(30));
            self.inject_esc.store(false, Ordering::SeqCst);
            self.touch();
        }
        r
    }

    pub fn type_text(
        &self,
        text: &str,
        stop: &StopSignal,
        before_chunk: &mut dyn FnMut() -> CapResult<()>,
    ) -> CapResult<()> {
        for chunk in crate::keychord::typing_chunks(text, 16) {
            stop.check()?;
            before_chunk()?;
            for ch in chunk.chars() {
                stop.check()?;
                let sym = match ch {
                    '\n' | '\r' => keysym::RETURN,
                    '\t' => keysym::TAB,
                    c if (c as u32) < 0x100 => c as u32,
                    c => 0x0100_0000 + c as u32,
                };
                self.tap(sym, &[])?;
                std::thread::sleep(Duration::from_millis(3));
            }
        }
        Ok(())
    }

    // --- The Escape kill switch -------------------------------------------------------------

    /// Registers the Stop callback and starts the watcher thread (once).
    pub fn set_on_stop(self: &Arc<X11>, f: Box<dyn Fn() + Send + Sync>) {
        *self.on_stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(f);
        if self.watcher.swap(true, Ordering::SeqCst) {
            return;
        }
        // A second connection reads the grabbed key; this one keeps injecting.
        let this = Arc::downgrade(self);
        std::thread::spawn(move || {
            loop {
                let Some(me) = this.upgrade() else { return };
                // Events for the grab arrive on the connection that made it; the grab is made on
                // `me.conn`, so poll it.
                let ev = me.conn.poll_for_event();
                match ev {
                    Ok(Some(Event::KeyPress(k)))
                        if k.detail == me.esc && !me.inject_esc.load(Ordering::SeqCst) =>
                    {
                        me.last_owner.store(me.now_ms(), Ordering::SeqCst);
                        if let Some(f) = me
                            .on_stop
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .as_ref()
                        {
                            f();
                        }
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => {
                        // Release the grab when no computer-use call has come for a while.
                        if me.grabbed.load(Ordering::SeqCst)
                            && me
                                .now_ms()
                                .saturating_sub(me.last_touch.load(Ordering::SeqCst))
                                > GRAB_LINGER.as_millis() as u64
                        {
                            me.ungrab();
                        }
                        drop(me);
                        std::thread::sleep(Duration::from_millis(15));
                    }
                    Err(_) => return,
                }
            }
        });
    }

    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64 + 1
    }

    /// A computer-use call is running: keep (or take) the Escape grab.
    pub fn touch(&self) {
        self.last_touch.store(self.now_ms(), Ordering::SeqCst);
        if !self.grabbed.swap(true, Ordering::SeqCst) {
            // Plain Escape, with and without Caps Lock and Num Lock. (AnyModifier would collide
            // with a window manager's own Alt+Escape and fail as a whole.)
            let r = GRAB_MASKS
                .iter()
                .try_for_each(|m| {
                    self.conn
                        .grab_key(
                            false,
                            self.root,
                            ModMask::from(*m),
                            self.esc,
                            GrabMode::ASYNC,
                            GrabMode::ASYNC,
                        )
                        .map_err(xerr)
                        .and_then(|c| c.check().map_err(xerr))
                })
                .and_then(|_| self.conn.flush().map_err(xerr));
            if r.is_err() {
                // Someone else holds Escape: no kill switch here, so be loud and stay ungrabbed.
                self.grabbed.store(false, Ordering::SeqCst);
                crate_log("could not grab Escape; the kill switch is not available this session");
            }
        }
    }

    pub fn ungrab(&self) {
        if self.grabbed.swap(false, Ordering::SeqCst) {
            for m in GRAB_MASKS {
                let _ = self.conn.ungrab_key(self.esc, self.root, ModMask::from(m));
            }
            let _ = self.conn.flush();
        }
    }

    pub fn escape_grabbed(&self) -> bool {
        self.grabbed.load(Ordering::SeqCst)
    }

    // --- Capture ----------------------------------------------------------------------------

    /// Screens (RANDR monitors, else the root).
    pub fn displays(&self) -> Vec<Rect> {
        use x11rb::protocol::randr::ConnectionExt as _;
        if let Some(m) = self
            .conn
            .randr_get_monitors(self.root, true)
            .ok()
            .and_then(|c| c.reply().ok())
        {
            let v: Vec<Rect> = m
                .monitors
                .iter()
                .map(|m| {
                    Rect::new(
                        f64::from(m.x),
                        f64::from(m.y),
                        f64::from(m.width),
                        f64::from(m.height),
                    )
                })
                .collect();
            if !v.is_empty() {
                return v;
            }
        }
        self.conn
            .get_geometry(self.root)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|g| vec![Rect::new(0.0, 0.0, f64::from(g.width), f64::from(g.height))])
            .unwrap_or_default()
    }

    /// The whole root window (all monitors), through MIT-SHM, falling back to `GetImage`.
    pub fn capture(&self) -> CapResult<Frame> {
        let g = self
            .conn
            .get_geometry(self.root)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        let (w, h) = (u32::from(g.width), u32::from(g.height));
        let bytes = self
            .get_image_shm(w, h)
            .or_else(|_| self.get_image_core(w, h))?;
        let mut rgba = Vec::with_capacity(bytes.len());
        for px in bytes.chunks_exact(4) {
            rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
        }
        Ok(Frame {
            width: w,
            height: h,
            rgba,
            screen: Rect::new(0.0, 0.0, f64::from(w), f64::from(h)),
            scale: 1.0,
        })
    }

    fn get_image_core(&self, w: u32, h: u32) -> CapResult<Vec<u8>> {
        // Requests are limited in size; fetch in bands.
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        let band = (1_000_000 / (w.max(1) * 4)).clamp(1, h.max(1));
        let mut y = 0;
        while y < h {
            let bh = band.min(h - y);
            let r = self
                .conn
                .get_image(
                    xproto::ImageFormat::Z_PIXMAP,
                    self.root,
                    0,
                    y as i16,
                    w as u16,
                    bh as u16,
                    !0,
                )
                .map_err(xerr)?
                .reply()
                .map_err(xerr)?;
            if r.depth < 24 {
                return Err(CapError::unavailable(
                    "x11_depth",
                    "The screen is not 24-bit colour; capture is not supported",
                ));
            }
            out.extend_from_slice(&r.data);
            y += bh;
        }
        Ok(out)
    }

    fn get_image_shm(&self, w: u32, h: u32) -> CapResult<Vec<u8>> {
        use x11rb::protocol::shm::ConnectionExt as _;
        let size = (w * h * 4) as usize;
        let unsupported = || CapError::unavailable("x11_no_shm", "MIT-SHM is not available");
        self.conn
            .shm_query_version()
            .map_err(|_| unsupported())?
            .reply()
            .map_err(|_| unsupported())?;
        // SAFETY: a private SysV segment, attached for this call and removed before returning.
        unsafe {
            let id = libc::shmget(libc::IPC_PRIVATE, size, libc::IPC_CREAT | 0o600);
            if id < 0 {
                return Err(unsupported());
            }
            let addr = libc::shmat(id, std::ptr::null(), 0);
            if addr as isize == -1 {
                libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
                return Err(unsupported());
            }
            let seg = self.conn.generate_id().map_err(xerr)?;
            let result = (|| -> CapResult<Vec<u8>> {
                self.conn
                    .shm_attach(seg, id as u32, false)
                    .map_err(xerr)?
                    .check()
                    .map_err(xerr)?;
                let r = self
                    .conn
                    .shm_get_image(
                        self.root,
                        0,
                        0,
                        w as u16,
                        h as u16,
                        !0,
                        xproto::ImageFormat::Z_PIXMAP.into(),
                        seg,
                        0,
                    )
                    .map_err(xerr)?
                    .reply()
                    .map_err(xerr)?;
                let _ = self.conn.shm_detach(seg);
                if r.depth < 24 {
                    return Err(CapError::unavailable(
                        "x11_depth",
                        "The screen is not 24-bit colour; capture is not supported",
                    ));
                }
                Ok(std::slice::from_raw_parts(addr as *const u8, size).to_vec())
            })();
            libc::shmdt(addr);
            libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
            result
        }
    }

    /// When the owner last pressed Escape through the grab (the only owner input X11 shows us
    /// without a heavier hook); `None` otherwise.
    pub fn last_owner_input_secs(&self) -> Option<f64> {
        None
    }
}

/// `RustConnection::connect`, plus the abstract-namespace socket for servers that could not
/// create `/tmp/.X11-unix/X<n>` (a read-only `/tmp/.X11-unix`, as in WSL and some containers).
/// The abstract path carries no Xauthority cookie, which is how such a server is run.
fn connect_display(display: &str) -> Result<(RustConnection, usize), Box<dyn std::error::Error>> {
    match RustConnection::connect(None) {
        Ok(c) => Ok(c),
        Err(first) => {
            let rest = display.strip_prefix(':').ok_or(first)?;
            let (num, screen) = match rest.split_once('.') {
                Some((n, s)) => (n, s.parse::<usize>().unwrap_or(0)),
                None => (rest, 0),
            };
            if num.is_empty() || !num.chars().all(|c| c.is_ascii_digit()) {
                return Err("unusable DISPLAY".into());
            }
            use std::os::linux::net::SocketAddrExt;
            let addr = std::os::unix::net::SocketAddr::from_abstract_name(format!(
                "/tmp/.X11-unix/X{num}"
            ))?;
            let stream = std::os::unix::net::UnixStream::connect_addr(&addr)?;
            let (stream, _) = x11rb::rust_connection::DefaultStream::from_unix_stream(stream)?;
            Ok((
                RustConnection::connect_to_stream_with_auth_info(
                    stream,
                    screen,
                    Vec::new(),
                    Vec::new(),
                )?,
                screen,
            ))
        }
    }
}

fn crate_log(msg: &str) {
    eprintln!("psyche-helper: {msg}");
}

#[allow(dead_code)]
fn _unused(_: shm::Seg) {}
