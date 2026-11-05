//! `vm.*`: the sandbox PC. The mac helper's names and shapes, served by a client of
//! `psyche-vm-svc.exe`, the Hyper-V Host Compute Service wrapper that runs as a Windows service
//! (`PsycheVM-<owner SID>`). The helper starts the service on first use and forwards every call
//! over its control pipe; the service relays guest connections straight to the Gateway's guest
//! pipe (`$PSYCHE_HOME\run\guest-socket`), so the helper has no relay role on Windows.
//!
//! The group is advertised in full only when the service is installed. Before that only
//! `vm.status` exists and answers `service.state: "notInstalled"` with
//! `service.action: "turn_on_sandbox_pc"`. The manifest is built when the helper starts, so the
//! desktop restarts the helper after turning the sandbox PC on.

mod caps;
mod client;
mod policy;
mod service;

#[cfg(test)]
mod tests;

pub use caps::not_installed_status;
pub use client::{Endpoint, PIPE_OVERRIDE};
pub use service::{ServiceState, control_pipe, service_name};

use crate::node::CapabilityRegistry;

pub fn register(reg: &mut CapabilityRegistry) {
    caps::register(reg);
}
