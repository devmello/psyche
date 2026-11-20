//! Remote mode (linux-helper-only design, track A): the helper dials the owner's Gateway over
//! `wss://`, proves the Gateway's identity before it signs anything, and serves the node
//! protocol as a "machine" under a ceiling the box's owner set (`policy.json`).

pub mod config;
pub mod daemon;
pub mod handshake;
pub mod link;
pub mod machine;
pub mod policy;
pub mod run;
pub mod tls;
pub mod transport;
pub mod verify;

#[cfg(test)]
pub mod testutil;
