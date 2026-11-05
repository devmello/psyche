//! The hold-to-talk key watch: one `WH_KEYBOARD_LL` hook on a dedicated message-loop thread
//! (the mac's listen-only CGEvent tap). Starting a new watch ends the old one.
//!
//! The hook callback only feeds the pure [`KeySet`] and posts changes to a channel, so it stays
//! far below `LowLevelHooksTimeout`. Windows silently unhooks a callback that times out, so the
//! thread re-arms the hook every 30 s and on unlock / resume, and repairs key state from
//! `GetAsyncKeyState` (a key-up lost to the lock screen ends the hold). Keys are never
//! swallowed: every event goes on with `CallNextHookEx`. A Caps Lock hold toggles the lock like
//! any press, so its release taps Caps Lock once more (injected, so the watch ignores it) and the
//! lock state is what it was; a short tap still toggles it.

use super::input;
use crate::dictation::keys::{KeyChange, KeyEvent, KeySet, VK_CAPITAL, WatchedKey, caps_lock_needs_restore};
use crate::error::CapError;
use crate::time::iso8601_now;
use std::cell::RefCell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Instant;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::RemoteDesktop::{NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification, WTSUnRegisterSessionNotification};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT,
    KillTimer, LLKHF_INJECTED, LLKHF_UP, MSG, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PostThreadMessageW, RegisterClassW, SetTimer,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_KEYBOARD_LL, WINDOW_EX_STYLE, WM_POWERBROADCAST, WM_QUIT, WM_TIMER,
    WM_APP, WM_WTSSESSION_CHANGE, WNDCLASSW, WS_OVERLAPPED,
};
use windows::core::w;

const WATCHDOG_TIMER: usize = 1;
const MASK_TIMER: usize = 2;
const CAPS_TIMER: usize = 3;
const WATCHDOG_MS: u32 = 1000;
const REARM_TICKS: u32 = 30;
const MASK_AFTER_MS: u32 = 200;
const WTS_CONSOLE_CONNECT: usize = 0x1;
const WTS_REMOTE_CONNECT: usize = 0x3;
const WTS_SESSION_UNLOCK: usize = 0x8;

pub(crate) type Change = (KeyChange, String);

pub(crate) struct Watcher {
    current: Mutex<Option<Active>>,
}

struct Active {
    id: u64,
    thread_id: u32,
    join: JoinHandle<()>,
}

impl Active {
    fn finish(self) {
        // SAFETY: asks the hook thread's message loop to exit.
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        let _ = self.join.join();
    }
}

static WATCHER: OnceLock<Watcher> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) fn watcher() -> &'static Watcher {
    WATCHER.get_or_init(|| Watcher { current: Mutex::new(None) })
}

impl Watcher {
    /// Installs the hook for `keys` and returns the watch id and its changes; the channel closes
    /// when the watch is replaced or stopped.
    pub fn start(&self, keys: Vec<WatchedKey>) -> Result<(u64, Receiver<Change>), CapError> {
        let (tx, rx) = channel();
        let (ready_tx, ready_rx) = channel();
        let join = std::thread::Builder::new()
            .name("psyche-dictation-key".into())
            .spawn(move || hook_thread(keys, tx, ready_tx))
            .map_err(|e| CapError::internal(format!("cannot start the key watch thread: {e}")))?;
        let thread_id = match ready_rx.recv() {
            Ok(Ok(id)) => id,
            Ok(Err(e)) => {
                let _ = join.join();
                return Err(e);
            }
            Err(_) => return Err(CapError::internal("the key watch thread exited")),
        };
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let old = self.current.lock().unwrap_or_else(|e| e.into_inner()).replace(Active { id, thread_id, join });
        if let Some(old) = old {
            old.finish();
        }
        Ok((id, rx))
    }

    pub fn stop(&self) {
        let old = self.current.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(old) = old {
            old.finish();
        }
    }

    /// Stops the watch only if it is still `id` (a cancelled invocation never ends a newer one).
    pub fn stop_if(&self, id: u64) {
        let old = {
            let mut cur = self.current.lock().unwrap_or_else(|e| e.into_inner());
            if cur.as_ref().is_some_and(|a| a.id == id) { cur.take() } else { None }
        };
        if let Some(old) = old {
            old.finish();
        }
    }

    pub fn is_active(&self) -> bool {
        self.current.lock().unwrap_or_else(|e| e.into_inner()).is_some()
    }

    /// Test support: delivers `ev` to the hook thread's handler as a hardware event would arrive
    /// (SendInput can only make injected events, which the watch ignores).
    pub fn simulate(&self, ev: KeyEvent) -> bool {
        let Some(tid) = self.current.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|a| a.thread_id) else { return false };
        let w = WPARAM(ev.vk as usize | if ev.down { 1 << 16 } else { 0 } | if ev.injected { 1 << 17 } else { 0 });
        // SAFETY: a thread message the hook loop handles itself.
        unsafe { PostThreadMessageW(tid, WM_SIMULATED_KEY, w, LPARAM(ev.scan as isize)) }.is_ok()
    }
}

const WM_SIMULATED_KEY: u32 = WM_APP + 0x51;

/// Injected events the hook saw (and ignored) since the process started; test support.
pub(crate) static INJECTED_SEEN: AtomicU64 = AtomicU64::new(0);

struct HookState {
    keys: KeySet,
    tx: Sender<Change>,
    hook: HHOOK,
    hwnd: HWND,
    mask_vk: u16,
    stale_ticks: u32,
    ticks: u32,
    /// A watched Caps Lock is down: since when, and whether another key chorded it.
    caps_down: Option<(Instant, bool)>,
}

thread_local! {
    static STATE: RefCell<Option<HookState>> = const { RefCell::new(None) };
}

fn emit(tx: &Sender<Change>, changes: Vec<KeyChange>) {
    if changes.is_empty() {
        return;
    }
    let at = iso8601_now();
    for c in changes {
        let _ = tx.send((c, at.clone()));
    }
}

fn physically_down(vk: u16) -> bool {
    // SAFETY: plain key-state query.
    (unsafe { GetAsyncKeyState(vk as i32) }) < 0
}

unsafe extern "system" fn ll_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: for HC_ACTION, lparam points at the event's KBDLLHOOKSTRUCT.
        let k = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let ev = KeyEvent {
            vk: k.vkCode as u16,
            scan: k.scanCode,
            down: k.flags.0 & LLKHF_UP.0 == 0,
            injected: k.flags.0 & LLKHF_INJECTED.0 != 0,
        };
        on_key(&ev);
    }
    // SAFETY: always pass the event on (listen-only).
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// The hook's whole per-event work: feed the key set, arm the menu mask, post changes.
fn on_key(ev: &KeyEvent) {
    if ev.injected {
        INJECTED_SEEN.fetch_add(1, Ordering::Relaxed);
    }
    STATE.with(|s| {
        if let Ok(mut s) = s.try_borrow_mut()
            && let Some(st) = s.as_mut()
        {
            let changes = st.keys.handle(ev);
            caps_lock(st, ev, &changes);
            if changes.iter().any(|c| c.down) && st.keys.wants_menu_mask(ev.vk) {
                st.mask_vk = ev.vk;
                // SAFETY: a timer on this thread's window.
                unsafe { SetTimer(Some(st.hwnd), MASK_TIMER, MASK_AFTER_MS, None) };
            }
            emit(&st.tx, changes);
        }
    });
}

/// Tracks a watched Caps Lock press; its release (after a hold or a chord) asks for the tap that
/// puts the lock state back, from a timer so SendInput never runs inside the hook callback.
fn caps_lock(st: &mut HookState, ev: &KeyEvent, changes: &[KeyChange]) {
    if ev.injected || !st.keys.watched.iter().any(|w| w.vk == VK_CAPITAL) {
        return;
    }
    if ev.vk == VK_CAPITAL {
        if ev.down {
            st.caps_down.get_or_insert((Instant::now(), false));
        } else if let Some((at, chorded)) = st.caps_down.take() {
            let held = at.elapsed().as_millis() as u64;
            if caps_lock_needs_restore(true, held, chorded) {
                // SAFETY: a timer on this thread's window.
                unsafe { SetTimer(Some(st.hwnd), CAPS_TIMER, 1, None) };
            }
        }
    } else if ev.down
        && let Some((_, chorded)) = st.caps_down.as_mut()
        && changes.iter().any(|c| c.key.vk() == VK_CAPITAL && !c.down)
    {
        *chorded = true;
    }
}

fn install() -> Result<HHOOK, CapError> {
    // SAFETY: a global low-level hook owned by this thread.
    unsafe {
        let module = GetModuleHandleW(None).unwrap_or_default();
        SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_proc), Some(module.into()), 0)
            .map_err(|e| crate::error::win_err("hook_failed", "Windows refused the keyboard hook for hold-to-talk", &e))
    }
}

/// New hook first, then the old one goes: no event is lost and none is seen twice, since hook
/// calls only arrive while this thread pumps messages.
fn rearm(st: &mut HookState) {
    if let Ok(h) = install() {
        // SAFETY: the hook this thread installed earlier.
        unsafe {
            let _ = UnhookWindowsHookEx(st.hook);
        }
        st.hook = h;
    }
}

fn on_timer(id: usize) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(st) = s.as_mut() else { return };
        match id {
            CAPS_TIMER => {
                // SAFETY: the timer this thread set.
                unsafe {
                    let _ = KillTimer(Some(st.hwnd), CAPS_TIMER);
                }
                input::send_caps_lock_tap();
            }
            MASK_TIMER => {
                // SAFETY: the timer this thread set.
                unsafe {
                    let _ = KillTimer(Some(st.hwnd), MASK_TIMER);
                }
                if st.keys.wants_menu_mask(st.mask_vk) {
                    input::send_menu_mask();
                }
            }
            WATCHDOG_TIMER => {
                st.ticks += 1;
                if st.ticks % REARM_TICKS == 0 {
                    rearm(st);
                }
                // A pressed key that is physically up on two ticks in a row lost its key-up.
                let stale = st.keys.trackers().iter().any(|t| t.is_pressed() && !physically_down(t.vk));
                st.stale_ticks = if stale { st.stale_ticks + 1 } else { 0 };
                if st.stale_ticks >= 2 {
                    st.stale_ticks = 0;
                    let changes = st.keys.resync(physically_down);
                    emit(&st.tx, changes);
                }
            }
            _ => {}
        }
    });
}

/// Unlock, console connect, resume: Windows may have dropped the hook and key-ups.
fn on_wake() {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(st) = s.as_mut() else { return };
        rearm(st);
        let changes = st.keys.resync(physically_down);
        emit(&st.tx, changes);
    });
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TIMER => {
            on_timer(wparam.0);
            LRESULT(0)
        }
        WM_WTSSESSION_CHANGE => {
            if matches!(wparam.0, WTS_SESSION_UNLOCK | WTS_CONSOLE_CONNECT | WTS_REMOTE_CONNECT) {
                on_wake();
            }
            LRESULT(0)
        }
        WM_POWERBROADCAST => {
            if matches!(wparam.0 as u32, PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND) {
                on_wake();
            }
            LRESULT(1)
        }
        // SAFETY: default handling.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn hidden_window() -> HWND {
    // SAFETY: an invisible top-level window (message-only windows get no power or session
    // broadcasts) on this thread.
    unsafe {
        let instance = GetModuleHandleW(None).unwrap_or_default();
        let class = WNDCLASSW { lpfnWndProc: Some(wnd_proc), hInstance: instance.into(), lpszClassName: w!("PsycheDictationKeyWatch"), ..Default::default() };
        RegisterClassW(&class);
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("PsycheDictationKeyWatch"),
            w!("Psyche hold-to-talk"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .unwrap_or_default()
    }
}

fn hook_thread(keys: Vec<WatchedKey>, tx: Sender<Change>, ready: Sender<Result<u32, CapError>>) {
    let hwnd = hidden_window();
    let hook = match install() {
        Ok(h) => h,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    // SAFETY: window-bound notifications and a timer for this thread's window.
    unsafe {
        let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        SetTimer(Some(hwnd), WATCHDOG_TIMER, WATCHDOG_MS, None);
    }
    STATE.with(|s| {
        *s.borrow_mut() = Some(HookState { keys: KeySet::new(keys), tx, hook, hwnd, mask_vk: 0, stale_ticks: 0, ticks: 0, caps_down: None });
    });
    // SAFETY: thread id of this thread.
    let _ = ready.send(Ok(unsafe { GetCurrentThreadId() }));
    // SAFETY: the standard message loop; WM_QUIT (from Watcher::finish) ends it.
    unsafe {
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            if msg.message == WM_SIMULATED_KEY && msg.hwnd.is_invalid() {
                let w = msg.wParam.0;
                on_key(&KeyEvent { vk: (w & 0xFFFF) as u16, scan: msg.lParam.0 as u32, down: w & (1 << 16) != 0, injected: w & (1 << 17) != 0 });
                continue;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    let st = STATE.with(|s| s.borrow_mut().take());
    if let Some(st) = st {
        // SAFETY: tearing down what this thread created; dropping `tx` ends the watch stream.
        unsafe {
            let _ = UnhookWindowsHookEx(st.hook);
            let _ = KillTimer(Some(hwnd), WATCHDOG_TIMER);
            let _ = WTSUnRegisterSessionNotification(hwnd);
            let _ = DestroyWindow(hwnd);
        }
    }
}
