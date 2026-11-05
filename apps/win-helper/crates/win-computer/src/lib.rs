//! # psyche_win_computer
//!
//! The Windows computer-use and screen layer of Psyche's Windows helper: the counterpart of the
//! mac helper's `computer.*` and `screen.context` capabilities (apps/mac-helper
//! `PsycheHelperSystem/Computer`, `PsycheHelperCore/Computer`, `PsycheHelperCore/Screenshot`),
//! with the same names, input schemas, side effects, error codes and result shapes.
//!
//! ## API
//!
//! - [`specs()`] → [`CapSpecLite`] for each capability (name, description, side effect, target
//!   kind, input schema, permissions, receipt kind), mirroring the Swift `CapabilitySpec`.
//! - [`invoke`]`(name, params, &Invocation)` → [`CapOutput`] `{result, receipt}`: what the
//!   helper core should call. `Invocation` carries the Gateway's `approvalId` (bound to
//!   `params.approval {app, tier}`) and the node protocol's cancellation flag.
//! - One function per capability (`computer_click(params) -> Result<Value, CapError>`, …): the
//!   same call returning only the result. They read the approval id from the reserved
//!   `params.approvalId` key, so a caller without an [`Invocation`] can still pass one.
//! - [`set_on_user_stop`]: told when the user pressed Esc to stop computer use.
//! - [`element_at`] / [`focused_element`] → [`ElementTarget`]: one element described with the
//!   `ax_tree` mapping (AX role / subrole, label, identifier, app, window), never its value; and
//!   [`app_window_image`], an app's main window with screenshot hygiene (the teach recorder).
//! - [`app_id`]: the one Windows app identity (lowercase executable name, frame-host windows
//!   attributed to the hosted app) that every capability of the helper reports.
//! - [`browser::tabs`]: Chrome / Edge / Brave tabs through UI Automation (`chrome.tabs`).
//!
//! ## Threading
//!
//! Capability functions are synchronous and may be called from any thread (several at once).
//! Every UI Automation call runs on a pool of MTA worker threads with UIA connection /
//! transaction timeouts and a per-call deadline (`win::com`), so a hung app returns
//! `unavailable/app_not_responding` instead of wedging the helper. Input (`SendInput`) and its
//! 20 ms stop-check pauses run on the calling thread. The Esc / attention hooks run on their own
//! message-loop thread. The process is made per-monitor DPI aware (v2) on first use.
//!
//! ## Coordinates
//!
//! Physical pixels of the virtual desktop, origin at the primary monitor's top-left: snapshot
//! frames, `x`/`y` targets and screenshot `screen` rects all agree (see `hygiene.rs`).

// In the helper's workspace serde_json has `preserve_order` (the core's choice), which makes
// `Map`, and with it `CapError`, larger than clippy's 128-byte `Err` threshold. Errors are rare
// and returned once per call, so they stay unboxed.
#![allow(clippy::result_large_err)]

pub mod app_id;
pub mod error;
pub mod hygiene;
pub mod keychord;
pub mod roles;
pub mod snapshot;
pub mod spec;
pub mod tiers;

#[cfg(windows)]
pub mod browser;
#[cfg(windows)]
pub mod caps;
#[cfg(windows)]
pub mod element;
#[cfg(windows)]
pub mod win;

pub use app_id::{app_id_from_exe, is_app_id};
pub use error::{CapError, CapResult};
pub use spec::{specs, CapSpecLite};

#[cfg(windows)]
pub use app_id::{app_id_for_pid, app_id_for_window, app_pid_for_window, app_pids_by_window};
#[cfg(windows)]
pub use caps::{invoke, CapOutput, Invocation, ReceiptDraft};
#[cfg(windows)]
pub use element::{app_window_image, element_at, focused_element, ElementTarget};

#[cfg(windows)]
use serde_json::Value;

/// Calls `name` with the approval id taken from the reserved `params.approvalId` key.
#[cfg(windows)]
fn call(name: &str, params: Value) -> Result<Value, CapError> {
    let inv = Invocation { approval_id: params.get("approvalId").and_then(Value::as_str).map(str::to_string), cancel: None };
    invoke(name, &params, &inv).map(|o| o.result)
}

macro_rules! capability_fns {
    ($($(#[$doc:meta])* $fn_name:ident => $cap:literal;)*) => {
        $(
            $(#[$doc])*
            #[cfg(windows)]
            pub fn $fn_name(params: Value) -> Result<Value, CapError> {
                call($cap, params)
            }
        )*
    };
}

capability_fns! {
    /// `computer.ax_tree`: UI Automation snapshot (`{text, header, nodes?, tier, hint?, provenance}`).
    computer_ax_tree => "computer.ax_tree";
    /// `computer.ax_value`: full value of one ref (`{ref, role, value, provenance}`).
    computer_ax_value => "computer.ax_value";
    /// `computer.click`: UIA press first, mouse click fallback.
    computer_click => "computer.click";
    /// `computer.double_click`.
    computer_double_click => "computer.double_click";
    /// `computer.right_click`: show-menu first, mouse right-click fallback.
    computer_right_click => "computer.right_click";
    /// `computer.press`: a semantic action (press, menu, inc, dec, raise, open, …).
    computer_press => "computer.press";
    /// `computer.set_value`: Value / RangeValue pattern, read back.
    computer_set_value => "computer.set_value";
    /// `computer.select`: SelectionItem pattern, read back.
    computer_select => "computer.select";
    /// `computer.type`: unicode text through `SendInput`.
    computer_type => "computer.type";
    /// `computer.key`: a key chord (mac vocabulary; cmd = Ctrl).
    computer_key => "computer.key";
    /// `computer.scroll`: wheel lines over a ref or point.
    computer_scroll => "computer.scroll";
    /// `computer.drag`: left-button drag within one app.
    computer_drag => "computer.drag";
    /// `computer.menu`: a menu-bar item by path.
    computer_menu => "computer.menu";
    /// `computer.end_session`: release the session lock.
    computer_end_session => "computer.end_session";
    /// `computer.screenshot`: downscaled monitor or window capture with exclusions.
    computer_screenshot => "computer.screenshot";
    /// `computer.screenshot_pick`: user-picked capture through the system picker.
    computer_screenshot_pick => "computer.screenshot_pick";
    /// `screen.context`: Ask about my screen.
    screen_context => "screen.context";
}

/// Called (on a helper thread) with the stopped session id when the user presses Esc during a
/// computer-use session.
#[cfg(windows)]
pub fn set_on_user_stop(f: impl Fn(Option<String>) + Send + Sync + 'static) {
    caps::cu().set_on_user_stop(f);
}

/// Installs the Esc stop and attention hooks now (they are otherwise installed on the first
/// computer-use call). Returns whether they run.
#[cfg(windows)]
pub fn start_hooks() -> bool {
    win::com::ensure_dpi_awareness();
    caps::cu().ensure_esc_tap();
    win::hooks::is_running()
}
