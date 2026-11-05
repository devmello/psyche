//! # psyche_linux_computer
//!
//! Direct computer use for the Psyche Linux helper (linux-desktop design §5, §6): the counterpart
//! of the Mac helper's `computer.*` capabilities and the Windows `psyche_win_computer` crate,
//! with the same names, input schemas, side effects, error codes and result shapes, so
//! `apps/gateway/src/compose/computer.ts` needs no second driver.
//!
//! The crate is split like win-computer:
//!
//! - **Platform-neutral** (builds and unit-tests anywhere): [`snapshot`] (refs, budgets,
//!   pruning, rendering), [`roles`] (AT-SPI roles to the Mac role vocabulary), [`tiers`] (tiers,
//!   fixed caps, approvals, session lock, stop signal), [`keychord`], [`hygiene`] (redaction
//!   geometry), [`target_check`], [`app_id`] (desktop-file ids), [`spec`] (capability specs) and
//!   [`engine`] (the dispatcher, generic over the [`backend`] traits).
//! - **Linux backends** behind `cfg(target_os = "linux")`: `a11y` (AT-SPI over zbus), `x11`
//!   (XTest, XShm, the Escape grab), `portal` (RemoteDesktop + ScreenCast with restore tokens,
//!   PipeWire frames, EIS input), `wayland` (wlroots virtual pointer and keyboard).

// Errors are rare and returned once per call, so they stay unboxed.
#![allow(clippy::result_large_err)]

#[cfg(target_os = "linux")]
pub mod a11y;
pub mod app_id;
pub mod backend;
pub mod engine;
pub mod error;
#[cfg(any(test, feature = "fake"))]
pub mod fake;
pub mod hygiene;
pub mod keychord;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "linux")]
pub mod portal;
#[cfg(target_os = "linux")]
pub mod pw;
pub mod roles;
pub mod snapshot;
pub mod spec;
pub mod target_check;
pub mod tiers;
#[cfg(target_os = "linux")]
pub mod x11;

pub use error::{CapError, CapResult};
pub use spec::{specs, CapSpecLite};

#[cfg(test)]
mod engine_tests;
