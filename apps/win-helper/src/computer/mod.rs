//! `computer.*` (wave 2): UI Automation snapshots and patterns (`computer.ax_tree`, `ax_value`,
//! `press`, `select`, `set_value`, `menu`), `SendInput` (`click`, `double_click`, `right_click`,
//! `type`, `key`, `scroll`, `drag`), `computer.screenshot`, `end_session`. Use
//! `crate::node::tiers` for per-app tiers (shared with `apps.*`) and keep the mac helper's names
//! and shapes. Registers nothing yet.

use crate::node::CapabilityRegistry;

pub fn register(_reg: &mut CapabilityRegistry) {}
