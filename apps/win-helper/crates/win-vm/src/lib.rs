//! Psyche sandbox PC for Windows: `psyche-vm-svc.exe`, a per-user LocalSystem service that runs
//! the Linux guest on the Hyper-V Host Compute Service and serves the mac helper's `vm.*`
//! methods over an owner-only named pipe. The Windows counterpart of the mac helper's
//! `PsycheHelperSystem/VM` + `PsycheHelperCore/VM`.
//!
//! - `model`, `paths`, `shares`, `snapshots`, `image`: the pure model (unit-tested).
//! - `manager`: every method, mac semantics, behind `backend::VmBackend` and `vhd::DiskOps`.
//! - `hcs` (computecore), `hcn` (computenetwork, NAT), `vhd` (virtdisk), `hvsock` (AF_HYPERV),
//!   `pipeclient` (Gateway guest pipe, serial console): Windows plumbing.
//! - `protocol`, `server`, `security`: the control pipe (NDJSON, DACL, token checks,
//!   impersonation).
//! - `service`: install / uninstall, the SCM entry point, idle self-stop.

// Errors carry the mac helper's details map; they are the rare path, as in the sibling crates.
#![allow(clippy::result_large_err)]

pub mod agent;
pub mod backend;
pub mod conn;
pub mod error;
pub mod events;
pub mod fsx;
pub mod granted;
pub mod hcn;
pub mod hcs;
pub mod hvsock;
pub mod image;
pub mod log;
pub mod manager;
pub mod model;
pub mod paths;
pub mod pipeclient;
pub mod protocol;
pub mod security;
pub mod server;
pub mod service;
pub mod shares;
pub mod snapshots;
pub mod vhd;
pub mod win;
