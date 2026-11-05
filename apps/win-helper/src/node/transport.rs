//! Named-pipe transport to the Gateway's node endpoint.
//!
//! Before anything is written (the handshake secret is in the first frame), the helper checks who
//! serves the pipe: the server process must run as this same Windows user (token user SID). A
//! process that squats on the pipe name under another account never sees the secret. The client
//! opens the pipe with `SECURITY_IDENTIFICATION` QoS, so the server cannot impersonate the helper
//! beyond identifying it.

use std::io;
use std::time::Duration;

use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use windows::Win32::Foundation::{ERROR_PIPE_BUSY, HANDLE};
use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;

use crate::win::security;

#[derive(Debug)]
pub enum ConnectError {
    /// No pipe with that name: the Gateway is not running (or not yet listening).
    Missing,
    /// Every pipe instance is busy for longer than the retry window.
    Busy,
    /// The pipe's server is not this user.
    OwnerMismatch,
    Io(io::Error),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Missing => write!(f, "node pipe missing (is the Gateway running?)"),
            ConnectError::Busy => write!(f, "node pipe busy"),
            ConnectError::OwnerMismatch => write!(f, "refusing the node pipe: its server is not this Windows user"),
            ConnectError::Io(e) => write!(f, "node pipe I/O error: {}", e.kind()),
        }
    }
}

impl std::error::Error for ConnectError {}

/// Opens the pipe (retrying briefly while all instances are busy) and checks its server.
pub async fn connect(path: &str) -> Result<NamedPipeClient, ConnectError> {
    let mut attempts = 0;
    let client = loop {
        match ClientOptions::new().open(path) {
            Ok(c) => break c,
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY.0 as i32) => {
                attempts += 1;
                if attempts > 20 {
                    return Err(ConnectError::Busy);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(ConnectError::Missing),
            Err(e) => return Err(ConnectError::Io(e)),
        }
    };
    if !server_is_current_user(&client) {
        return Err(ConnectError::OwnerMismatch);
    }
    Ok(client)
}

fn server_is_current_user(client: &NamedPipeClient) -> bool {
    use std::os::windows::io::AsRawHandle;
    let handle = HANDLE(client.as_raw_handle());
    let mut pid = 0u32;
    // SAFETY: the handle is a live pipe client handle owned by `client`.
    if unsafe { GetNamedPipeServerProcessId(handle, &mut pid) }.is_err() || pid == 0 {
        return false;
    }
    match (security::process_user_sid(pid), security::current_user_sid()) {
        (Some(server), Some(me)) => server == me,
        _ => false,
    }
}
