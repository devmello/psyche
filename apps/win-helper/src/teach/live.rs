//! The live source for "Record in an app": a port of the mac helper's `LiveAppTeachSource`
//! (`PsycheHelperSystem/Teach/LiveAppTeach.swift`) onto UI Automation and Win32 hooks.
//!
//! - **Presses** come from a listen-only `WH_MOUSE_LL` hook (the AX observer has no notification
//!   for a press on the Mac either). Injected input (`LLMHF_INJECTED`) is ignored, so neither the
//!   helper's own computer use or dictation nor any other program's synthetic input can write
//!   steps (stricter than the Mac, which exempts only its own events). A menu item is chosen at
//!   mouse-up, not on the press.
//! - **Focus and typing** are read from UI Automation: the hook thread only copies a key press
//!   into a channel as a *signal*; a worker thread then asks UI Automation which element has
//!   focus and, only for a field that passed the secret check, what it holds. It also polls every
//!   [`POLL`] (UIA events are polled rather than subscribed to, so a hung app cannot stall a
//!   COM callback). A key press's character is never captured, only the field's value.
//! - **Scope.** The recording is bound to the app's process (and its frame host) with its start
//!   time, and every loop re-checks that the pid still names the same process. Elements are
//!   described only when their process belongs to the app (`psyche_win_computer::TeachScope`).
//! - No screenshots are taken. Input on the secure desktop (UAC, the lock screen) never reaches
//!   the hooks, and an app running elevated cannot be recorded (UIPI): `start` refuses it.
//!
//! Not exercised by the pure unit tests (it needs a window and UI Automation); the decisions it
//! feeds are, with recorded events (`policy` tests), and `live_*` in `tests.rs` drives it against
//! a window the test owns.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use psyche_win_computer::win::apps::{self, TargetApp};
use psyche_win_computer::{TeachElement, TeachScope, teach_element_at, teach_focused};
use windows::Win32::Foundation::{CloseHandle, FILETIME, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentThreadId, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::*;

use super::controller::{Scope, Source};
use super::policy::{self, Element, Event, roles};
use crate::node::CapabilityError;

/// How often the worker re-reads the focused element when nothing else woke it.
const POLL: Duration = Duration::from_millis(600);
/// After a key press or a click, how long the app gets to apply it before the field is read.
const KEY_SETTLE: Duration = Duration::from_millis(60);
const CLICK_SETTLE: Duration = Duration::from_millis(150);
/// A menu trail (the menu-bar item or submenu just opened) is forgotten after this long.
const TRAIL_TTL: Duration = Duration::from_secs(60);

enum Raw {
    Down {
        x: i32,
        y: i32,
    },
    Up,
    /// A non-modifier key went down (the signal to re-read the field, never its character).
    Key,
}

/// The running recorder's channel (one recording at a time).
static SINK: Mutex<Option<Sender<Raw>>> = Mutex::new(None);
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);

fn send(raw: Raw) {
    if let Ok(g) = SINK.lock()
        && let Some(tx) = g.as_ref()
    {
        let _ = tx.send(raw);
    }
}

/// Modifier keys (and lock keys) are not input.
fn is_modifier(vk: u32) -> bool {
    matches!(vk, 0x10..=0x12 | 0x14 | 0x5B | 0x5C | 0x90 | 0x91 | 0xA0..=0xA5)
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let m = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        if m.flags & LLMHF_INJECTED == 0 {
            match wparam.0 as u32 {
                WM_LBUTTONDOWN => send(Raw::Down {
                    x: m.pt.x,
                    y: m.pt.y,
                }),
                WM_LBUTTONUP => send(Raw::Up),
                _ => {}
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let k = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let msg = wparam.0 as u32;
        let injected = k.flags.0 & LLKHF_INJECTED.0 != 0;
        if !injected && (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) && !is_modifier(k.vkCode) {
            send(Raw::Key);
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

// MARK: Process identity

/// A process and when it started: a reused pid names a different start time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Identity {
    pid: u32,
    created: u64,
}

impl Identity {
    fn capture(pid: u32) -> Option<Identity> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let (mut c, mut e, mut k, mut u) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            let r = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u);
            let _ = CloseHandle(h);
            r.ok()?;
            // An exited process has a nonzero exit time.
            if e.dwHighDateTime != 0 || e.dwLowDateTime != 0 {
                return None;
            }
            Some(Identity {
                pid,
                created: ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64,
            })
        }
    }

    fn still(&self) -> bool {
        Identity::capture(self.pid) == Some(*self)
    }
}

/// The processes an app's elements may come from: its own, its frame host, and any other process
/// running the same executable (an app that keeps its UI in a child process).
fn scope_of(app: &TargetApp) -> Scope {
    let (main, host, exe) = (
        app.pid,
        app.host_pid,
        app.exe_path.clone().map(|p| p.to_lowercase()),
    );
    let cache: Mutex<HashMap<u32, bool>> = Mutex::new(HashMap::new());
    Arc::new(move |pid| {
        if pid == main || Some(pid) == host {
            return true;
        }
        let Some(exe) = &exe else { return false };
        let mut c = cache.lock().unwrap_or_else(|p| p.into_inner());
        *c.entry(pid)
            .or_insert_with(|| apps::exe_path(pid).is_some_and(|p| p.to_lowercase() == *exe))
    })
}

// MARK: Describing elements

/// The recorder's element from UI Automation's: ancestors split into the path and the menu chain,
/// the window title and sibling labels kept as `context` only.
pub(crate) fn element_of(app_id: &str, app_name: &str, e: TeachElement) -> Element {
    let mut path = Vec::new();
    let mut menu = Vec::new();
    for (role, title) in &e.path {
        match role.as_str() {
            "AXMenuItem" | "AXMenuBarItem" | "AXMenuButton" | "AXMenu" => {
                if !title.is_empty() {
                    menu.push(title.clone());
                }
            }
            "AXMenuBar" => {}
            r => {
                if let Some(t) = roles::path_title(r, Some(title)) {
                    path.push(t);
                }
            }
        }
    }
    let mut menu_path = Vec::new();
    if roles::MENU_ITEMS.contains(&e.role.as_str()) {
        menu_path = menu;
        if let Some(own) = e.title.clone().filter(|t| !t.is_empty())
            && menu_path.last() != Some(&own)
        {
            menu_path.push(own);
        }
    }
    Element {
        bundle_id: app_id.to_owned(),
        app_name: app_name.to_owned(),
        role: e.role,
        subrole: e.subrole,
        title: e.title,
        description: e.description,
        identifier: e.identifier,
        placeholder: e.placeholder,
        label_text: e.label_text,
        path,
        menu_path,
        secure_input: e.secure_focus,
        nearby: Vec::new(),
        context: e.context,
        pid: e.pid,
    }
}

/// A Windows popup menu is named after the item that opened it, and each submenu is its own
/// window, so a menu item's own chain starts at its popup. The trail of what the owner just
/// opened (the menu-bar item, a submenu) completes it to the whole path from the menu bar.
pub(crate) fn merge_menu(trail: &[String], computed: &[String]) -> Vec<String> {
    if trail.is_empty() {
        return computed.to_vec();
    }
    let mut out = trail.to_vec();
    if computed.first().is_some_and(|c| out.last() == Some(c)) {
        out.pop();
    }
    out.extend(computed.iter().cloned());
    out
}

/// Whether the field's value may be read: a text field that passed the secret check (before any
/// value is kept; the mapper checks again).
fn may_read(e: &TeachElement) -> bool {
    let probe = Element {
        role: e.role.clone(),
        subrole: e.subrole.clone(),
        title: e.title.clone(),
        description: e.description.clone(),
        identifier: e.identifier.clone(),
        placeholder: e.placeholder.clone(),
        label_text: e.label_text.clone(),
        path: e
            .path
            .iter()
            .filter(|(r, _)| !matches!(r.as_str(), "AXWindow" | "AXApplication"))
            .map(|(_, t)| t.clone())
            .collect(),
        secure_input: e.secure_focus,
        context: e.context.clone(),
        ..Default::default()
    };
    !policy::is_secret(&probe)
}

// MARK: The worker

type OnEvent = Arc<dyn Fn(Event) + Send + Sync>;

struct Worker {
    app_id: String,
    app_name: String,
    scope: TeachScope,
    on_event: OnEvent,
    identity: Identity,
    host_identity: Option<Identity>,
    stop: Arc<AtomicBool>,
    /// The field that has focus (what `Focus` was last sent for) and the value last seen in it.
    focus: Option<Element>,
    last_value: Option<String>,
    /// A key went down since the field was last read (a secret field's change signal).
    typed: bool,
    menu_candidate: Option<Element>,
    trail: Option<(Vec<String>, Instant)>,
}

impl Worker {
    fn emit(&self, event: Event) {
        if !self.stop.load(Ordering::SeqCst) {
            (self.on_event)(event);
        }
    }

    fn element(&self, e: TeachElement) -> Element {
        element_of(&self.app_id, &self.app_name, e)
    }

    fn still_the_same_app(&self) -> bool {
        self.identity.still() && self.host_identity.is_none_or(|h| h.still())
    }

    fn down(&mut self, x: i32, y: i32) {
        let Some(te) = teach_element_at(x, y, &self.scope) else {
            return;
        };
        let expandable = te.expandable;
        let mut el = self.element(te);
        if roles::MENU_ITEMS.contains(&el.role.as_str()) {
            let trail = self
                .trail
                .as_ref()
                .filter(|(_, at)| at.elapsed() < TRAIL_TTL)
                .map(|(t, _)| t.clone())
                .unwrap_or_default();
            el.menu_path = merge_menu(&trail, &el.menu_path);
            if expandable {
                // A menu-bar item or a submenu opener: where the owner is, not a choice.
                self.trail = Some((el.menu_path.clone(), Instant::now()));
                self.menu_candidate = None;
            } else {
                self.menu_candidate = Some(el);
            }
        } else {
            self.trail = None;
            self.emit(Event::Press(el));
        }
    }

    fn up(&mut self) {
        if let Some(item) = self.menu_candidate.take() {
            self.trail = None;
            self.emit(Event::MenuChosen(item));
        }
    }

    /// Reads the focused element and sends what changed: a new focus (with the field's value as it
    /// was, for a field that is not secret), a changed value, or focus leaving the app.
    fn sync(&mut self) {
        let typed = std::mem::take(&mut self.typed);
        let Some(te) = teach_focused(&self.scope) else {
            if self.focus.take().is_some() {
                self.last_value = None;
                self.emit(Event::FocusCleared);
            }
            return;
        };
        let value = te.value.clone();
        let el = self.element(te);
        let changed_field = !self.focus.as_ref().is_some_and(|f| f.same_field(&el));
        if changed_field {
            self.focus = Some(el.clone());
            self.last_value = value.clone();
            self.emit(Event::Focus(el, value));
            return;
        }
        self.focus = Some(el.clone());
        if policy::is_secret(&el) {
            // A secret field: its value is not read. A key press in it is the signal; the mapper
            // makes one sensitive step per field.
            if typed && roles::TEXT_INPUTS.contains(&el.role.as_str()) {
                self.emit(Event::ValueChanged(el, None));
            }
        } else if let Some(v) = value
            && self.last_value.as_deref() != Some(v.as_str())
        {
            self.last_value = Some(v.clone());
            self.emit(Event::ValueChanged(el, Some(v)));
        }
    }
}

fn run(mut w: Worker, rx: Receiver<Raw>, on_end: Arc<dyn Fn() + Send + Sync>) {
    psyche_win_computer::win::com::init_worker_thread();
    // Where the owner already is: the focused field becomes the first typing target.
    w.sync();
    let mut deadline: Option<Instant> = None;
    let mut next_poll = Instant::now() + POLL;
    loop {
        if w.stop.load(Ordering::SeqCst) {
            return;
        }
        if !w.still_the_same_app() {
            if !w.stop.load(Ordering::SeqCst) {
                on_end();
            }
            return;
        }
        let now = Instant::now();
        let due = deadline.map_or(next_poll, |d| d.min(next_poll));
        match rx.recv_timeout(due.saturating_duration_since(now)) {
            Ok(Raw::Down { x, y }) => {
                w.down(x, y);
                deadline = Some(Instant::now() + CLICK_SETTLE);
            }
            Ok(Raw::Up) => {
                w.up();
                deadline = Some(Instant::now() + CLICK_SETTLE);
            }
            Ok(Raw::Key) => {
                w.typed = true;
                deadline = Some(Instant::now() + KEY_SETTLE);
            }
            Err(RecvTimeoutError::Timeout) => {
                if deadline.is_some_and(|d| Instant::now() >= d) || Instant::now() >= next_poll {
                    deadline = None;
                    next_poll = Instant::now() + POLL;
                    w.sync();
                }
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

// MARK: The source

/// The live source: the hooks plus the worker. `stop` never waits for either thread (it may run on
/// the worker itself, when a step limit or the app quitting ends the recording).
#[derive(Default)]
pub struct LiveSource {
    running: bool,
    stop: Option<Arc<AtomicBool>>,
}

impl Source for LiveSource {
    fn start(
        &mut self,
        bundle_id: &str,
        bind: Arc<dyn Fn(Scope) + Send + Sync>,
        on_event: OnEvent,
        on_end: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<(), CapabilityError> {
        let wire = |e: psyche_win_computer::CapError| CapabilityError::from_wire(&e.to_wire());
        apps::check_desktop().map_err(wire)?;
        let app = apps::find_app(Some(bundle_id), None).map_err(wire)?;
        if app.bundle_id.as_deref() != Some(bundle_id) {
            return Err(CapabilityError::unavailable(
                "app_not_running",
                "Open the app first, then record in it",
            )
            .retryable());
        }
        // UIPI: a hook and UI Automation from this process cannot reach an app run as administrator.
        apps::check_uipi(&app).map_err(wire)?;
        let identity = Identity::capture(app.pid).ok_or_else(|| {
            CapabilityError::unavailable("app_not_running", "Open the app first, then record in it")
                .retryable()
        })?;
        let host_identity = app.host_pid.and_then(Identity::capture);
        let scope = scope_of(&app);
        bind(scope.clone());
        // The first UI Automation use of a pool worker creates its client; do that here, before
        // the hooks and the worker run, so two first uses never race.
        let _ = teach_focused(&TeachScope {
            owns: scope.clone(),
            read_value: |_| false,
        });
        let (tx, rx) = channel::<Raw>();
        {
            let mut g = SINK.lock().unwrap_or_else(|p| p.into_inner());
            if g.is_some() {
                return Err(CapabilityError::new(
                    crate::node::ErrorCode::Conflict,
                    "teach_busy",
                    "A recording is already running",
                ));
            }
            *g = Some(tx);
        }
        let release = || *SINK.lock().unwrap_or_else(|p| p.into_inner()) = None;
        let (ready_tx, ready_rx) = channel::<bool>();
        let spawned = std::thread::Builder::new()
            .name("psyche-teach-hooks".into())
            .spawn(move || unsafe {
                let module = GetModuleHandleW(None)
                    .ok()
                    .map(|m| windows::Win32::Foundation::HINSTANCE(m.0));
                let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0);
                let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
                let ok = ms.is_ok() && kb.is_ok();
                if ok {
                    HOOK_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
                }
                let _ = ready_tx.send(ok);
                if ok {
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                if let Ok(h) = ms {
                    let _ = UnhookWindowsHookEx(h);
                }
                if let Ok(h) = kb {
                    let _ = UnhookWindowsHookEx(h);
                }
            })
            .is_ok();
        if !(spawned
            && ready_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap_or(false))
        {
            release();
            return Err(CapabilityError::permission_missing(
                crate::node::OsPermission::InputMonitoring,
            ));
        }
        let stop = Arc::new(AtomicBool::new(false));
        self.stop = Some(stop.clone());
        self.running = true;
        let owns = scope.clone();
        let worker = Worker {
            app_id: bundle_id.to_owned(),
            app_name: app.name.clone(),
            scope: TeachScope {
                owns: owns.clone(),
                read_value: |e| may_read(e),
            },
            on_event,
            identity,
            host_identity,
            stop,
            focus: None,
            last_value: None,
            typed: false,
            menu_candidate: None,
            trail: None,
        };
        let spawned = std::thread::Builder::new()
            .name("psyche-teach-lookup".into())
            .spawn(move || run(worker, rx, on_end));
        if spawned.is_err() {
            self.stop();
            return Err(CapabilityError::internal(
                "thread",
                "the recorder could not start",
            ));
        }
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(s) = self.stop.take() {
            s.store(true, Ordering::SeqCst);
        }
        if !std::mem::take(&mut self.running) {
            return;
        }
        // Dropping the sender ends the worker once it drained what was already queued.
        *SINK.lock().unwrap_or_else(|p| p.into_inner()) = None;
        let tid = HOOK_THREAD.swap(0, Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
}

impl Drop for LiveSource {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Whether a recorder's hooks are installed (tests, diagnostics).
pub fn is_recording() -> bool {
    HOOK_THREAD.load(Ordering::SeqCst) != 0
}

/// Feeds a press into the running recorder as if the hook had seen hardware input (live tests:
/// they cannot produce hardware input, and injected input is ignored by design).
#[cfg(test)]
pub(crate) fn simulate_down(x: i32, y: i32) {
    send(Raw::Down { x, y });
}

#[cfg(test)]
pub(crate) fn simulate_up() {
    send(Raw::Up);
}

#[cfg(test)]
pub(crate) fn simulate_key() {
    send(Raw::Key);
}
