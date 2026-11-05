//! The Wayland path through `xdg-desktop-portal` (linux-desktop design §6.2): one combined
//! RemoteDesktop + ScreenCast session, persisted with a restore token, so the owner approves
//! screen and input access once.
//!
//! **Flow.** `CreateSession` (RemoteDesktop), `SelectDevices` (keyboard + pointer,
//! `persist_mode = 2`, the stored `restore_token`), `ScreenCast.SelectSources` (one monitor,
//! cursor embedded), `Start`: the one owner dialog, which returns the PipeWire stream(s) and a
//! new restore token. Every call that answers later does so with a `Request.Response` signal;
//! the match is added before the call, so a fast answer is never missed.
//!
//! **Tokens.** A restore token is single use: each `Start` returns a new one, and only the
//! newest is kept (`$XDG_STATE_HOME/psyche-helper/portal.json`, 0600, the directory 0700). A
//! token the backend cannot restore is dropped and the owner sees the dialog again. Revoking
//! deletes the file.
//!
//! **Stop.** The compositor ends the session (`org.freedesktop.portal.Session.Closed`) when the
//! owner presses Stop in the shell's sharing indicator. That is this path's kill switch: the
//! callback registered with [`Portal::on_closed`] cancels the run.
//!
//! **Input.** Through the portal's `Notify*` methods (keysyms and absolute pointer motion
//! relative to the stream); libei is preferred where the portal offers `ConnectToEIS`
//! (see [`crate::eis`]).

use crate::backend::Frame;
use crate::error::{code, CapError, CapResult};
use crate::keychord::{keysym, KeyChord};
use crate::linux::RemotePath;
use crate::snapshot::Rect;
use crate::tiers::StopSignal;
use serde_json::{json, Value as Json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use zbus::blocking::Connection;
use zbus::zvariant::{OwnedFd, OwnedObjectPath, OwnedValue, Value};

const DESKTOP: &str = "org.freedesktop.portal.Desktop";
const DESKTOP_PATH: &str = "/org/freedesktop/portal/desktop";
const REMOTE: &str = "org.freedesktop.portal.RemoteDesktop";
const CAST: &str = "org.freedesktop.portal.ScreenCast";
/// How long the owner has to answer the portal's dialog.
pub const DIALOG_TIMEOUT: Duration = Duration::from_secs(180);
/// Longest token the helper stores (portal tokens are short opaque strings).
const MAX_TOKEN: usize = 512;

/// Linux evdev button codes the portal's `NotifyPointerButton` takes.
const BTN_LEFT: i32 = 0x110;
const BTN_RIGHT: i32 = 0x111;

#[derive(Debug, Clone, PartialEq)]
pub struct StreamInfo {
    pub node_id: u32,
    /// Logical position and size in the compositor's coordinate space.
    pub position: (i32, i32),
    pub size: (i32, i32),
}

struct Open {
    session: OwnedObjectPath,
    streams: Vec<StreamInfo>,
    remote_version: u32,
}

type ClosedFn = Box<dyn Fn() + Send + Sync>;

/// Opens and holds the portal session.
pub struct Portal {
    conn: Connection,
    token_path: PathBuf,
    state: Arc<Mutex<Option<Open>>>,
    on_closed: Arc<Mutex<Option<ClosedFn>>>,
    counter: AtomicU64,
    dialog_timeout: Duration,
    /// Session generation: a `Closed` for an older session must not end a newer one.
    generation: Arc<AtomicU64>,
}

fn dbus<E: std::fmt::Display>(what: &str, e: E) -> CapError {
    CapError::unavailable(
        "portal_unavailable",
        format!("The desktop portal did not answer {what}: {e}"),
    )
}

impl Portal {
    pub fn new(conn: Connection, token_path: PathBuf) -> Portal {
        Portal {
            conn,
            token_path,
            state: Arc::new(Mutex::new(None)),
            on_closed: Arc::new(Mutex::new(None)),
            counter: AtomicU64::new(0),
            dialog_timeout: DIALOG_TIMEOUT,
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    /// A portal client on the session bus (method calls time out after 10 s; the dialog is
    /// waited for through the `Response` signal, not a method reply).
    pub fn connect(token_path: PathBuf) -> CapResult<Portal> {
        let conn = zbus::blocking::connection::Builder::session()
            .and_then(|b| b.method_timeout(Duration::from_secs(10)).build())
            .map_err(|e| {
                CapError::unavailable(
                    "no_graphical_session",
                    format!("Needs a graphical session on this computer (no session bus: {e})"),
                )
            })?;
        Ok(Portal::new(conn, token_path))
    }

    pub fn with_dialog_timeout(mut self, t: Duration) -> Portal {
        self.dialog_timeout = t;
        self
    }

    pub fn token_path(&self) -> &std::path::Path {
        &self.token_path
    }

    // --- Token store ------------------------------------------------------------------------

    /// The stored restore token, if the file is sane.
    pub fn stored_token(&self) -> Option<String> {
        read_token(&self.token_path)
    }

    fn store_token(&self, token: &str) {
        if token.is_empty() || token.len() > MAX_TOKEN || token.chars().any(char::is_control) {
            return;
        }
        if let Err(e) = write_token(&self.token_path, token) {
            eprintln!("psyche-helper: could not store the portal permission: {e}");
        }
    }

    /// Forgets the stored permission and closes any session: the next one asks again.
    pub fn revoke(&self) -> bool {
        self.close();
        let had = self.token_path.exists();
        let _ = std::fs::remove_file(&self.token_path);
        had
    }

    // --- Requests ---------------------------------------------------------------------------

    fn token(&self, kind: &str) -> String {
        format!(
            "psyche_{kind}_{}_{}",
            std::process::id(),
            self.counter.fetch_add(1, Ordering::SeqCst)
        )
    }

    fn request_path(&self, token: &str) -> Option<String> {
        let me = self
            .conn
            .unique_name()?
            .as_str()
            .trim_start_matches(':')
            .replace('.', "_");
        Some(format!(
            "/org/freedesktop/portal/desktop/request/{me}/{token}"
        ))
    }

    /// Calls a portal method that answers with a `Request` handle, and waits for its
    /// `Response`. `build` receives the `handle_token` option's value.
    fn request(
        &self,
        iface: &str,
        member: &str,
        timeout: Duration,
        body: &(impl serde::Serialize + zbus::zvariant::DynamicType),
        token: &str,
    ) -> CapResult<(u32, HashMap<String, OwnedValue>)> {
        let path = self
            .request_path(token)
            .ok_or_else(|| dbus(member, "no bus name"))?;
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.freedesktop.portal.Request")
            .and_then(|b| b.member("Response"))
            .and_then(|b| b.path(path.as_str()))
            .map(|b| b.build())
            .map_err(|e| dbus(member, e))?;
        let mut iter = zbus::blocking::MessageIterator::for_match_rule(rule, &self.conn, Some(8))
            .map_err(|e| dbus(member, e))?;
        self.conn
            .call_method(Some(DESKTOP), DESKTOP_PATH, Some(iface), member, body)
            .map_err(|e| dbus(member, e))?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            if let Some(Ok(msg)) = iter.next() {
                let _ = tx.send(
                    msg.body()
                        .deserialize::<(u32, HashMap<String, OwnedValue>)>(),
                );
            }
        });
        match rx.recv_timeout(timeout) {
            Ok(Ok(r)) => Ok(r),
            Ok(Err(e)) => Err(dbus(member, e)),
            Err(_) => Err(CapError::unavailable(
                "portal_timeout",
                "The owner did not answer the screen and input permission dialog in time",
            )
            .retryable()),
        }
    }

    fn property_u32(&self, iface: &str, name: &str) -> Option<u32> {
        let msg = self
            .conn
            .call_method(
                Some(DESKTOP),
                DESKTOP_PATH,
                Some("org.freedesktop.DBus.Properties"),
                "Get",
                &(iface, name),
            )
            .ok()?;
        let v: OwnedValue = msg.body().deserialize().ok()?;
        u32::try_from(v).ok()
    }

    /// Whether the desktop offers what a combined session needs.
    pub fn available(&self) -> bool {
        self.property_u32(REMOTE, "version").is_some()
            && self.property_u32(CAST, "version").is_some()
    }

    // --- The session ------------------------------------------------------------------------

    fn open(&self, use_token: bool) -> CapResult<Open> {
        let remote_version = self.property_u32(REMOTE, "version").ok_or_else(|| {
            CapError::unavailable(
                "portal_unavailable",
                "This desktop has no RemoteDesktop portal, so Psyche cannot send input here",
            )
        })?;
        if self.property_u32(CAST, "version").is_none() {
            return Err(CapError::unavailable(
                "portal_unavailable",
                "This desktop has no ScreenCast portal, so Psyche cannot see the screen here",
            ));
        }
        let timeout = Duration::from_secs(30);
        let t = self.token("create");
        let session_token = self.token("session");
        let create: HashMap<&str, Value<'_>> = HashMap::from([
            ("handle_token", Value::from(t.as_str())),
            ("session_handle_token", Value::from(session_token.as_str())),
        ]);
        let (resp, results) = self.request(REMOTE, "CreateSession", timeout, &(create,), &t)?;
        if resp != 0 {
            return Err(CapError::unavailable(
                "portal_failed",
                "The desktop refused to start a remote-desktop session",
            ));
        }
        let session_str: String = results
            .get("session_handle")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| String::try_from(v).ok().or(None))
            .ok_or_else(|| {
                CapError::unavailable("portal_failed", "The portal returned no session")
            })?;
        let session = OwnedObjectPath::try_from(session_str.as_str())
            .map_err(|e| dbus("CreateSession", e))?;

        // Keyboard (1) and pointer (2); persistence until revoked (2); the stored token.
        let t = self.token("devices");
        let mut opts: HashMap<&str, Value<'_>> = HashMap::from([
            ("handle_token", Value::from(t.as_str())),
            ("types", Value::from(3u32)),
            ("persist_mode", Value::from(2u32)),
        ]);
        let stored = if use_token { self.stored_token() } else { None };
        if let Some(tok) = &stored {
            opts.insert("restore_token", Value::from(tok.as_str()));
        }
        let (resp, _) = self.request(REMOTE, "SelectDevices", timeout, &(&session, opts), &t)?;
        if resp != 0 {
            self.close_session(&session);
            return Err(CapError::unavailable(
                "portal_failed",
                "The desktop refused the keyboard and pointer request",
            ));
        }

        // One monitor, the cursor drawn into the frames.
        let t = self.token("sources");
        let opts: HashMap<&str, Value<'_>> = HashMap::from([
            ("handle_token", Value::from(t.as_str())),
            ("types", Value::from(1u32)),
            ("multiple", Value::from(false)),
            ("cursor_mode", Value::from(2u32)),
        ]);
        let (resp, _) = self.request(CAST, "SelectSources", timeout, &(&session, opts), &t)?;
        if resp != 0 {
            self.close_session(&session);
            return Err(CapError::unavailable(
                "portal_failed",
                "The desktop refused the screen request",
            ));
        }

        // The dialog (or, with a good token, none).
        let t = self.token("start");
        let opts: HashMap<&str, Value<'_>> =
            HashMap::from([("handle_token", Value::from(t.as_str()))]);
        let (resp, results) = match self.request(
            REMOTE,
            "Start",
            self.dialog_timeout,
            &(&session, "", opts),
            &t,
        ) {
            Ok(r) => r,
            Err(e) => {
                self.close_session(&session);
                return Err(e);
            }
        };
        match resp {
            0 => {}
            1 => {
                self.close_session(&session);
                return Err(CapError::new(
                    code::POLICY_DENIED,
                    "portal_denied",
                    "You did not allow Psyche to see the screen and use the keyboard and mouse. Computer use needs that on this desktop.",
                ));
            }
            _ => {
                self.close_session(&session);
                return Err(CapError::unavailable(
                    "portal_failed",
                    "The desktop could not start screen and input sharing",
                ));
            }
        }
        if let Some(tok) = results
            .get("restore_token")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| String::try_from(v).ok())
        {
            self.store_token(&tok);
        }
        let streams = results
            .get("streams")
            .map(parse_streams)
            .unwrap_or_default();
        if streams.is_empty() {
            self.close_session(&session);
            return Err(CapError::unavailable(
                "portal_failed",
                "The desktop shared no screen",
            ));
        }
        self.watch_closed(&session);
        Ok(Open {
            session,
            streams,
            remote_version,
        })
    }

    /// Listens for `Session.Closed` on its own thread: the owner pressed Stop.
    fn watch_closed(&self, session: &OwnedObjectPath) {
        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let Ok(rule) = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.freedesktop.portal.Session")
            .and_then(|b| b.member("Closed"))
            .and_then(|b| b.path(session.as_str()))
            .map(|b| b.build())
        else {
            return;
        };
        let Ok(iter) = zbus::blocking::MessageIterator::for_match_rule(rule, &self.conn, Some(4))
        else {
            return;
        };
        let on_closed = self.on_closed.clone();
        let generation = self.generation.clone();
        std::thread::spawn(move || {
            let mut iter = iter;
            if iter.next().is_some() && generation.load(Ordering::SeqCst) == gen {
                if let Some(f) = on_closed.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                    f();
                }
            }
        });
    }

    fn close_session(&self, session: &OwnedObjectPath) {
        let _ = self.conn.call_method(
            Some(DESKTOP),
            session.as_str(),
            Some("org.freedesktop.portal.Session"),
            "Close",
            &(),
        );
    }

    fn with_open<T>(&self, f: impl FnOnce(&Open) -> CapResult<T>) -> CapResult<T> {
        let g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match g.as_ref() {
            Some(o) => f(o),
            None => Err(
                CapError::unavailable("portal_closed", "Screen and input sharing ended")
                    .retryable(),
            ),
        }
    }

    // --- Notify* ----------------------------------------------------------------------------

    fn notify(
        &self,
        member: &str,
        body: &(impl serde::Serialize + zbus::zvariant::DynamicType),
    ) -> CapResult<()> {
        self.conn
            .call_method(Some(DESKTOP), DESKTOP_PATH, Some(REMOTE), member, body)
            .map(|_| ())
            .map_err(|e| {
                CapError::unavailable(
                    "portal_input_failed",
                    format!("The desktop refused input ({member}): {e}"),
                )
            })
    }

    fn key_sym(&self, sym: u32, press: bool) -> CapResult<()> {
        let s = self.with_open(|o| Ok(o.session.clone()))?;
        let opts: HashMap<&str, Value<'_>> = HashMap::new();
        self.notify(
            "NotifyKeyboardKeysym",
            &(&s, opts, sym as i32, u32::from(press)),
        )
    }

    fn pointer_to(&self, x: f64, y: f64) -> CapResult<()> {
        let (s, node, rel) = self.with_open(|o| {
            let st = o.streams.first().expect("streams are checked non-empty");
            Ok((
                o.session.clone(),
                st.node_id,
                (x - f64::from(st.position.0), y - f64::from(st.position.1)),
            ))
        })?;
        let opts: HashMap<&str, Value<'_>> = HashMap::new();
        self.notify(
            "NotifyPointerMotionAbsolute",
            &(&s, opts, node, rel.0, rel.1),
        )
    }

    fn button(&self, button: i32, press: bool) -> CapResult<()> {
        let s = self.with_open(|o| Ok(o.session.clone()))?;
        let opts: HashMap<&str, Value<'_>> = HashMap::new();
        self.notify("NotifyPointerButton", &(&s, opts, button, u32::from(press)))
    }

    fn tap_sym(&self, sym: u32, mods: &[u32]) -> CapResult<()> {
        let mut held = Vec::new();
        for m in mods {
            self.key_sym(*m, true)?;
            held.push(*m);
        }
        let r = self
            .key_sym(sym, true)
            .and_then(|_| self.key_sym(sym, false));
        for m in held.iter().rev() {
            let _ = self.key_sym(*m, false);
        }
        r
    }

    pub fn streams(&self) -> Vec<StreamInfo> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|o| o.streams.clone())
            .unwrap_or_default()
    }

    pub fn remote_version(&self) -> Option<u32> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|o| o.remote_version)
    }

    /// An fd for the PipeWire remote of the open session.
    pub fn pipewire_fd(&self) -> CapResult<OwnedFd> {
        let s = self.with_open(|o| Ok(o.session.clone()))?;
        let opts: HashMap<&str, Value<'_>> = HashMap::new();
        let msg = self
            .conn
            .call_method(
                Some(DESKTOP),
                DESKTOP_PATH,
                Some(CAST),
                "OpenPipeWireRemote",
                &(&s, opts),
            )
            .map_err(|e| dbus("OpenPipeWireRemote", e))?;
        msg.body()
            .deserialize::<OwnedFd>()
            .map_err(|e| dbus("OpenPipeWireRemote", e))
    }
}

fn parse_streams(v: &OwnedValue) -> Vec<StreamInfo> {
    let Ok(v) = v.try_clone() else { return vec![] };
    let Ok(list) = Vec::<(u32, HashMap<String, OwnedValue>)>::try_from(v) else {
        return vec![];
    };
    list.into_iter()
        .map(|(node_id, props)| {
            let pair = |k: &str| -> (i32, i32) {
                props
                    .get(k)
                    .and_then(|v| v.try_clone().ok())
                    .and_then(|v| <(i32, i32)>::try_from(v).ok())
                    .unwrap_or((0, 0))
            };
            StreamInfo {
                node_id,
                position: pair("position"),
                size: pair("size"),
            }
        })
        .collect()
}

// --- The token file -----------------------------------------------------------------------------

fn read_token(path: &std::path::Path) -> Option<String> {
    use std::io::Read;
    // A bounded read of a file only we write: anything big or odd is ignored.
    let mut buf = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(4096)
        .read_to_string(&mut buf)
        .ok()?;
    let v: Json = serde_json::from_str(&buf).ok()?;
    let t = v.get("restoreToken")?.as_str()?;
    (!t.is_empty() && t.len() <= MAX_TOKEN && !t.chars().any(char::is_control))
        .then(|| t.to_string())
}

fn write_token(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(json!({"restoreToken": token}).to_string().as_bytes())?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

/// Captures one frame of the open session (PipeWire in the helper).
pub type FramesFn = Box<dyn Fn(&Portal) -> CapResult<Frame> + Send + Sync>;

/// The `RemotePath` over the portal.
pub struct PortalPath {
    pub portal: Arc<Portal>,
    pub frames: FramesFn,
}

impl RemotePath for PortalPath {
    fn kind(&self) -> &'static str {
        "portal"
    }

    fn ready(&self) -> CapResult<()> {
        if self
            .portal
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
        {
            return Ok(());
        }
        // A stored token that no longer restores is dropped and the owner is asked again.
        let first = self.portal.open(true);
        let open = match first {
            Err(e)
                if self.portal.stored_token().is_some()
                    && matches!(e.reason.as_str(), "portal_failed") =>
            {
                let _ = std::fs::remove_file(&self.portal.token_path);
                self.portal.open(false)?
            }
            other => other?,
        };
        *self.portal.state.lock().unwrap_or_else(|e| e.into_inner()) = Some(open);
        Ok(())
    }

    fn click(
        &self,
        x: f64,
        y: f64,
        count: u32,
        right: bool,
        mods: &[u32],
        stop: &StopSignal,
    ) -> CapResult<()> {
        stop.check()?;
        self.portal.pointer_to(x, y)?;
        std::thread::sleep(Duration::from_millis(30));
        let b = if right { BTN_RIGHT } else { BTN_LEFT };
        for m in mods {
            self.portal.key_sym(*m, true)?;
        }
        let mut result = Ok(());
        for _ in 0..count {
            if let Err(e) = stop.check() {
                result = Err(e);
                break;
            }
            result = self
                .portal
                .button(b, true)
                .and_then(|_| self.portal.button(b, false));
            if result.is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        for m in mods.iter().rev() {
            let _ = self.portal.key_sym(*m, false);
        }
        result
    }

    fn type_text(
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
                self.portal.tap_sym(char_keysym(ch), &[])?;
                std::thread::sleep(Duration::from_millis(3));
            }
        }
        Ok(())
    }

    fn key(&self, chord: &KeyChord, stop: &StopSignal) -> CapResult<()> {
        stop.check()?;
        self.portal.tap_sym(chord.keysym, &chord.mods.keysyms())
    }

    fn scroll(&self, x: f64, y: f64, dx: i32, dy: i32, stop: &StopSignal) -> CapResult<()> {
        stop.check()?;
        self.portal.pointer_to(x, y)?;
        let s = self.portal.with_open(|o| Ok(o.session.clone()))?;
        // Axis 0 is vertical, 1 horizontal; positive steps scroll down/right. The Mac vocabulary
        // has dy > 0 scrolling up and dx > 0 left.
        for (axis, steps) in [(0u32, -dy), (1u32, -dx)] {
            if steps != 0 {
                let opts: HashMap<&str, Value<'_>> = HashMap::new();
                self.portal
                    .notify("NotifyPointerAxisDiscrete", &(&s, opts, axis, steps))?;
            }
        }
        Ok(())
    }

    fn drag(&self, from: (f64, f64), to: (f64, f64), stop: &StopSignal) -> CapResult<()> {
        stop.check()?;
        self.portal.pointer_to(from.0, from.1)?;
        std::thread::sleep(Duration::from_millis(40));
        self.portal.button(BTN_LEFT, true)?;
        let mut result = Ok(());
        for i in 1..=12 {
            if let Err(e) = stop.check() {
                result = Err(e);
                break;
            }
            let t = f64::from(i) / 12.0;
            if let Err(e) = self
                .portal
                .pointer_to(from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t)
            {
                result = Err(e);
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        let up = self.portal.button(BTN_LEFT, false);
        result.and(up)
    }

    fn capture(&self, _display: Option<usize>) -> CapResult<Frame> {
        self.ready()?;
        (self.frames)(&self.portal)
    }

    fn displays(&self) -> Vec<Rect> {
        self.portal
            .streams()
            .iter()
            .map(|s| {
                Rect::new(
                    f64::from(s.position.0),
                    f64::from(s.position.1),
                    f64::from(s.size.0),
                    f64::from(s.size.1),
                )
            })
            .collect()
    }

    fn on_closed(&self, f: Box<dyn Fn() + Send + Sync>) {
        let state = self.portal.state.clone();
        *self
            .portal
            .on_closed
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(Box::new(move || {
            // The session is gone: the next call opens a new one (and asks, if the token is spent).
            *state.lock().unwrap_or_else(|e| e.into_inner()) = None;
            f();
        }));
    }

    fn close(&self) {
        self.portal.close();
    }
}

impl Portal {
    /// Closes the open session, if any. Between sessions nothing is held.
    pub fn close(&self) {
        let open = self.state.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(o) = open {
            self.generation.fetch_add(1, Ordering::SeqCst);
            self.close_session(&o.session);
        }
    }

    /// Whether a session is open now.
    pub fn is_open(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
}

/// A keysym for one character: Latin-1 as is, Return/Tab for the controls, else the Unicode
/// keysym (`0x01000000 + code point`).
pub fn char_keysym(ch: char) -> u32 {
    match ch {
        '\n' | '\r' => keysym::RETURN,
        '\t' => keysym::TAB,
        c if (c as u32) < 0x100 => c as u32,
        c => 0x0100_0000 + c as u32,
    }
}
