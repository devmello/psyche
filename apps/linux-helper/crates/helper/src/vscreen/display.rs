//! `VirtualDisplay`: one private X display, ready to use. This is the reusable backend (the
//! separate-desktop container runs the same thing inside the guest):
//!
//! - start an Xvfb on the first free display number (only a server that is provably our child
//!   is ever used, see `xvfb.rs`),
//! - act as its window manager (`wm.rs`, `wmdriver.rs`),
//! - capture frames (XShm, `capture.rs`),
//! - inject input (XTest, `input.rs`).
//!
//! It knows nothing about apps, systemd or the Gateway; `manager.rs` adds those.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use x11rb::rust_connection::{DefaultStream, RustConnection};

use super::capture::Capturer;
use super::input::{Button, Input};
use super::wmdriver::{WindowRecord, WmDriver};
use super::xauth::AUTH_NAME;
use super::xvfb::{connect_verified, XvfbConfig, XvfbServer};

pub use super::xvfb::XvfbConfig as DisplayConfig;

pub struct VirtualDisplay {
    xvfb: Mutex<XvfbServer>,
    driver: Arc<WmDriver>,
    capturer: Mutex<Capturer>,
    input: Mutex<Input>,
    pub display: String,
    pub xauthority: PathBuf,
    pub width: u32,
    pub height: u32,
    pub started_at: Instant,
}

fn connect(
    display_number: u32,
    server_pid: u32,
    cookie: [u8; 16],
) -> Result<Arc<RustConnection>, String> {
    let unix = connect_verified(display_number, server_pid)?;
    let (stream, _) = DefaultStream::from_unix_stream(unix).map_err(|e| e.to_string())?;
    RustConnection::connect_to_stream_with_auth_info(stream, 0, AUTH_NAME.to_vec(), cookie.to_vec())
        .map(Arc::new)
        .map_err(|e| e.to_string())
}

impl VirtualDisplay {
    pub fn start(config: &XvfbConfig) -> Result<VirtualDisplay, String> {
        let xvfb = XvfbServer::start(config)?;
        // From here on, dropping `xvfb` (an error below) stops the server again.
        let wm_conn = connect(xvfb.display_number, xvfb.pid(), xvfb.cookie)?;
        let driver = WmDriver::start(wm_conn, 0)?;
        let tool_conn = connect(xvfb.display_number, xvfb.pid(), xvfb.cookie)?;
        let capturer = Capturer::new(Arc::clone(&tool_conn), 0)?;
        let input = Input::new(tool_conn, 0)?;
        Ok(VirtualDisplay {
            display: xvfb.display(),
            xauthority: xvfb.xauthority.clone(),
            width: xvfb.width,
            height: xvfb.height,
            xvfb: Mutex::new(xvfb),
            driver,
            capturer: Mutex::new(capturer),
            input: Mutex::new(input),
            started_at: Instant::now(),
        })
    }

    pub fn is_alive(&self) -> bool {
        self.xvfb
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_running()
            && self.driver.is_alive()
    }

    pub fn xvfb_pid(&self) -> u32 {
        self.xvfb.lock().unwrap_or_else(|p| p.into_inner()).pid()
    }

    // ---- windows ----

    pub fn windows(&self) -> Vec<WindowRecord> {
        self.driver.windows()
    }

    pub fn window_serial(&self) -> u64 {
        self.driver.serial()
    }

    pub fn wait_for_window(
        &self,
        after_serial: u64,
        timeout: Duration,
        accept: impl Fn(&WindowRecord) -> bool,
    ) -> Option<WindowRecord> {
        self.driver.wait_for_window(after_serial, timeout, accept)
    }

    pub fn request_close(&self, window: u32) {
        self.driver.request_close(window);
    }

    // ---- frames ----

    /// The screen's change counter, capturing first when the last capture is older than `max_age`.
    pub fn frame_seq(&self, max_age: Duration) -> Result<u64, String> {
        self.capturer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .refresh(max_age)
    }

    /// `(seq, jpeg, width, height)` of the current screen, small enough for one helper message
    /// (`capture::MAX_FRAME_JPEG`).
    pub fn frame(
        &self,
        max_width: Option<u32>,
        max_age: Duration,
    ) -> Result<(u64, Vec<u8>, u32, u32), String> {
        let mut cap = self.capturer.lock().unwrap_or_else(|p| p.into_inner());
        let seq = cap.refresh(max_age)?;
        let (jpeg, w, h) = cap.jpeg(max_width)?;
        Ok((seq, jpeg, w, h))
    }

    pub fn uses_shm(&self) -> bool {
        self.capturer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .uses_shm()
    }

    // ---- input ----

    pub fn with_input<R>(&self, f: impl FnOnce(&mut Input) -> R) -> R {
        f(&mut self.input.lock().unwrap_or_else(|p| p.into_inner()))
    }

    pub fn click(&self, x: i32, y: i32, button: Button) -> Result<(), String> {
        self.with_input(|i| i.click(x, y, button))
    }

    pub fn type_text(&self, text: &str) -> Result<(), String> {
        self.with_input(|i| i.type_text(text))
    }

    /// Lets go of every key and button our input holds (a take-over ended mid-press).
    pub fn release_input(&self) -> Result<(), String> {
        self.with_input(|i| i.release_all())
    }

    /// Stops the server. Idempotent: the `Drop` of an old handle does nothing after a stop.
    pub fn stop(&self) {
        self.xvfb.lock().unwrap_or_else(|p| p.into_inner()).stop();
    }
}

impl Drop for VirtualDisplay {
    fn drop(&mut self) {
        self.stop();
    }
}
