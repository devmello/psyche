//! The sandbox PC's Windows service (`psyche-vm-svc.exe`, `PsycheVM-<owner SID>`) as the Service
//! Control Manager sees it: installed or not, running or not, its process id, and starting it.
//!
//! The service is installed once, elevated, by the desktop ("Turn on the sandbox PC"). Starting
//! it afterwards must not need an administrator, so the service's security descriptor has to
//! grant the owner SID `SERVICE_QUERY_STATUS | SERVICE_START` (SDDL `(A;;LCRPRC;;;<owner SID>)`;
//! see README). Nothing here ever stops, reconfigures or deletes the service.

use windows::Win32::Foundation::ERROR_ACCESS_DENIED;
use windows::Win32::System::Services::{
    CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatusEx, SC_HANDLE,
    SC_MANAGER_CONNECT, SC_STATUS_PROCESS_INFO, SERVICE_QUERY_STATUS, SERVICE_RUNNING,
    SERVICE_START, SERVICE_START_PENDING, SERVICE_STATUS_PROCESS, SERVICE_STOP_PENDING,
    SERVICE_STOPPED, StartServiceW,
};
use windows::core::{HRESULT, PCWSTR};

/// Service name prefix; the owner's SID follows.
pub const SERVICE_PREFIX: &str = "PsycheVM-";
/// Control pipe prefix; the owner's SID follows.
pub const PIPE_PREFIX: &str = r"\\.\pipe\psyche-vm-";

pub fn service_name(owner_sid: &str) -> String {
    format!("{SERVICE_PREFIX}{owner_sid}")
}

pub fn control_pipe(owner_sid: &str) -> String {
    format!("{PIPE_PREFIX}{owner_sid}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceState {
    NotInstalled,
    Stopped,
    Starting,
    Running,
    Stopping,
    /// Installed, but this user may not query or start it (the service's DACL is wrong).
    AccessDenied,
    Unknown,
}

impl ServiceState {
    pub fn as_str(self) -> &'static str {
        match self {
            ServiceState::NotInstalled => "notInstalled",
            ServiceState::Stopped => "stopped",
            ServiceState::Starting => "starting",
            ServiceState::Running => "running",
            ServiceState::Stopping => "stopping",
            ServiceState::AccessDenied => "accessDenied",
            ServiceState::Unknown => "unknown",
        }
    }

    pub fn installed(self) -> bool {
        self != ServiceState::NotInstalled
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ServiceInfo {
    pub state: ServiceState,
    /// The service process, while it runs (the control pipe's server must be this process).
    pub pid: Option<u32>,
}

struct Handle(SC_HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: opened by `open`, closed once.
        unsafe {
            let _ = CloseServiceHandle(self.0);
        }
    }
}

enum Opened {
    Service(Handle, Handle),
    Missing,
    Denied,
    Failed,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn open(owner_sid: &str, access: u32) -> Opened {
    // SAFETY: plain SCM calls; handles are closed by `Handle`.
    unsafe {
        let Ok(scm) = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT) else {
            return Opened::Failed;
        };
        let scm = Handle(scm);
        let name = wide(&service_name(owner_sid));
        match OpenServiceW(scm.0, PCWSTR(name.as_ptr()), access) {
            Ok(svc) => Opened::Service(scm, Handle(svc)),
            Err(e) if e.code() == HRESULT::from_win32(1060) => Opened::Missing,
            Err(e) if e.code() == HRESULT::from_win32(ERROR_ACCESS_DENIED.0) => Opened::Denied,
            Err(_) => Opened::Failed,
        }
    }
}

/// The service's state. Needs only the right to connect to the SCM and `SERVICE_QUERY_STATUS`.
pub fn query(owner_sid: &str) -> ServiceInfo {
    let (_scm, svc) = match open(owner_sid, SERVICE_QUERY_STATUS) {
        Opened::Service(a, b) => (a, b),
        Opened::Missing => {
            return ServiceInfo {
                state: ServiceState::NotInstalled,
                pid: None,
            };
        }
        Opened::Denied => {
            return ServiceInfo {
                state: ServiceState::AccessDenied,
                pid: None,
            };
        }
        Opened::Failed => {
            return ServiceInfo {
                state: ServiceState::Unknown,
                pid: None,
            };
        }
    };
    let mut buf = vec![0u8; std::mem::size_of::<SERVICE_STATUS_PROCESS>()];
    let mut needed = 0u32;
    // SAFETY: the buffer holds one SERVICE_STATUS_PROCESS.
    let ok = unsafe {
        QueryServiceStatusEx(svc.0, SC_STATUS_PROCESS_INFO, Some(&mut buf), &mut needed).is_ok()
    };
    if !ok {
        return ServiceInfo {
            state: ServiceState::Unknown,
            pid: None,
        };
    }
    // SAFETY: filled by QueryServiceStatusEx; unaligned read of a plain struct.
    let st = unsafe { std::ptr::read_unaligned(buf.as_ptr() as *const SERVICE_STATUS_PROCESS) };
    let state = match st.dwCurrentState {
        s if s == SERVICE_RUNNING => ServiceState::Running,
        s if s == SERVICE_STOPPED => ServiceState::Stopped,
        s if s == SERVICE_START_PENDING => ServiceState::Starting,
        s if s == SERVICE_STOP_PENDING => ServiceState::Stopping,
        _ => ServiceState::Unknown,
    };
    ServiceInfo {
        state,
        pid: (st.dwProcessId != 0).then_some(st.dwProcessId),
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    NotInstalled,
    Denied,
    Failed(i32),
}

/// `StartService`. Already running counts as started.
pub fn start(owner_sid: &str) -> Result<(), StartError> {
    let (_scm, svc) = match open(owner_sid, SERVICE_START | SERVICE_QUERY_STATUS) {
        Opened::Service(a, b) => (a, b),
        Opened::Missing => return Err(StartError::NotInstalled),
        Opened::Denied => return Err(StartError::Denied),
        Opened::Failed => return Err(StartError::Failed(0)),
    };
    // SAFETY: a valid service handle with SERVICE_START access.
    match unsafe { StartServiceW(svc.0, None) } {
        Ok(()) => Ok(()),
        Err(e) if e.code() == HRESULT::from_win32(1056) => Ok(()), // ERROR_SERVICE_ALREADY_RUNNING
        Err(e) if e.code() == HRESULT::from_win32(ERROR_ACCESS_DENIED.0) => Err(StartError::Denied),
        Err(e) => Err(StartError::Failed(e.code().0)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_owner_sid() {
        assert_eq!(
            service_name("S-1-5-21-1-2-3-1001"),
            "PsycheVM-S-1-5-21-1-2-3-1001"
        );
        assert_eq!(
            control_pipe("S-1-5-21-1-2-3-1001"),
            r"\\.\pipe\psyche-vm-S-1-5-21-1-2-3-1001"
        );
    }

    #[test]
    fn a_service_nobody_installed_is_not_installed() {
        let info = query("S-1-5-21-0-0-0-424242");
        assert_eq!(info.state, ServiceState::NotInstalled);
        assert!(info.pid.is_none());
        assert_eq!(
            start("S-1-5-21-0-0-0-424242"),
            Err(StartError::NotInstalled)
        );
    }
}
