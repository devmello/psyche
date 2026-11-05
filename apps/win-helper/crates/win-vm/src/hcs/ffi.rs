//! `computecore.dll` loaded at run time (it exists only when the Virtual Machine Platform /
//! Hyper-V feature is on), so the service starts everywhere and reports why HCS is unavailable.
//! Every call returns an operation; `run` waits for it and returns its result document.

use std::ffi::c_void;

use windows::Win32::Foundation::{FreeLibrary, HLOCAL, HMODULE, LocalFree};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW};
use windows::core::{HRESULT, HSTRING, PCSTR, PCWSTR, PWSTR};

use crate::error::{VmError, VmResult};

pub type Op = *mut c_void;
pub type Sys = *mut c_void;

#[repr(C)]
pub struct HcsEvent {
    pub ty: i32,
    pub data: PCWSTR,
    pub op: Op,
}

pub type EventCallback = unsafe extern "system" fn(*const HcsEvent, *const c_void);

pub const EVENT_SYSTEM_EXITED: i32 = 1;
pub const EVENT_SYSTEM_CRASH_INITIATED: i32 = 2;
pub const EVENT_SERVICE_DISCONNECT: i32 = 0x0200_0000;
pub const EVENT_OPTION_NONE: i32 = 0;
/// `GENERIC_ALL` for `HcsOpenComputeSystem`.
pub const GENERIC_ALL: u32 = 0x1000_0000;

type FnCreateOperation = unsafe extern "system" fn(*const c_void, *const c_void) -> Op;
type FnCloseOperation = unsafe extern "system" fn(Op);
type FnWait = unsafe extern "system" fn(Op, u32, *mut PWSTR) -> HRESULT;
type FnCreate = unsafe extern "system" fn(PCWSTR, PCWSTR, Op, *const c_void, *mut Sys) -> HRESULT;
type FnOpen = unsafe extern "system" fn(PCWSTR, u32, *mut Sys) -> HRESULT;
type FnClose = unsafe extern "system" fn(Sys);
pub type FnSysOp = unsafe extern "system" fn(Sys, Op, PCWSTR) -> HRESULT;
type FnModify = unsafe extern "system" fn(Sys, Op, PCWSTR, *mut c_void) -> HRESULT;
type FnSetCallback = unsafe extern "system" fn(Sys, i32, *const c_void, Option<EventCallback>) -> HRESULT;
type FnServiceProps = unsafe extern "system" fn(PCWSTR, *mut PWSTR) -> HRESULT;
type FnAccess = unsafe extern "system" fn(PCWSTR, PCWSTR) -> HRESULT;
type FnEnumerate = unsafe extern "system" fn(PCWSTR, Op) -> HRESULT;

pub struct Api {
    lib: HMODULE,
    create_operation: FnCreateOperation,
    close_operation: FnCloseOperation,
    wait: FnWait,
    pub create: FnCreate,
    pub open: FnOpen,
    pub close: FnClose,
    pub start: FnSysOp,
    pub shutdown: FnSysOp,
    pub terminate: FnSysOp,
    pub pause: FnSysOp,
    pub resume: FnSysOp,
    pub save: FnSysOp,
    pub properties: FnSysOp,
    pub modify: FnModify,
    pub set_callback: FnSetCallback,
    service_properties: FnServiceProps,
    grant: FnAccess,
    revoke: FnAccess,
    pub enumerate: FnEnumerate,
}

// SAFETY: the function pointers and module handle are process-global and thread-safe.
unsafe impl Send for Api {}
// SAFETY: as above.
unsafe impl Sync for Api {}

impl Drop for Api {
    fn drop(&mut self) {
        // SAFETY: the module was loaded by `load` and is released once.
        unsafe {
            let _ = FreeLibrary(self.lib);
        }
    }
}

fn wide_string(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    // SAFETY: HCS returns a NUL-terminated string allocated with LocalAlloc; freed here.
    unsafe {
        let s = p.to_string().unwrap_or_default();
        let _ = LocalFree(Some(HLOCAL(p.0 as *mut _)));
        s
    }
}

/// An HRESULT as an HCS error, with the result document's message when there is one.
pub fn hcs_error(what: &str, hr: HRESULT, doc: &str) -> VmError {
    let code = hr.0 as u32;
    // winerror.h HCS_E_* (0x8037_01xx) and the Win32 errors HCS passes through.
    let reason = match code {
        0x8007_0005 | 0x8037_011B => "hcs_access_denied",
        0x8037_0102 | 0x8037_0114 | 0x8037_011E => "hcs_unavailable",
        0x8037_0105 | 0x8037_010E | 0x8037_0110 => "vm_not_running",
        0x8037_0109 | 0x8037_0118 | 0x8007_05B4 => "hcs_timeout",
        0x8037_010F | 0x8007_00B7 => "vm_exists",
        0x8037_010D => "hcs_invalid_document",
        0x8037_0100 | 0x8037_0106 | 0x8037_011C => "guest_boot_failed",
        0x8007_0002 | 0x8007_0003 => "file_not_found",
        _ => "hcs_error",
    };
    let detail = serde_json::from_str::<serde_json::Value>(doc)
        .ok()
        .and_then(|v| v["ErrorMessage"].as_str().or(v["Error"].as_str()).map(str::to_owned))
        .unwrap_or_default();
    let msg =
        if detail.is_empty() { format!("{what} failed (HRESULT 0x{code:08X})") } else { format!("{what} failed: {detail} (0x{code:08X})") };
    VmError::unavailable(reason, msg).detail("hresult", format!("0x{code:08X}"))
}

macro_rules! sym {
    ($lib:expr, $name:literal, $ty:ty) => {{
        // SAFETY: the symbol has the documented signature of the type it is cast to.
        match unsafe { GetProcAddress($lib, PCSTR(concat!($name, "\0").as_ptr())) } {
            Some(f) => unsafe { std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(f) },
            None => {
                // SAFETY: releases the module loaded above.
                unsafe {
                    let _ = FreeLibrary($lib);
                }
                return Err(VmError::unavailable("hcs_unavailable", concat!("computecore.dll has no ", $name, " (Windows too old)")));
            }
        }
    }};
}

impl Api {
    pub fn load() -> VmResult<Api> {
        // SAFETY: loads a system DLL from System32 only.
        let lib = unsafe { LoadLibraryExW(&HSTRING::from("computecore.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32) }.map_err(|_| {
            VmError::unavailable(
                "hcs_unavailable",
                "The Host Compute Service is not installed. Turn on \"Virtual Machine Platform\" in Windows Features (it is on when WSL 2 works), then restart.",
            )
        })?;
        Ok(Api {
            lib,
            create_operation: sym!(lib, "HcsCreateOperation", FnCreateOperation),
            close_operation: sym!(lib, "HcsCloseOperation", FnCloseOperation),
            wait: sym!(lib, "HcsWaitForOperationResult", FnWait),
            create: sym!(lib, "HcsCreateComputeSystem", FnCreate),
            open: sym!(lib, "HcsOpenComputeSystem", FnOpen),
            close: sym!(lib, "HcsCloseComputeSystem", FnClose),
            start: sym!(lib, "HcsStartComputeSystem", FnSysOp),
            shutdown: sym!(lib, "HcsShutDownComputeSystem", FnSysOp),
            terminate: sym!(lib, "HcsTerminateComputeSystem", FnSysOp),
            pause: sym!(lib, "HcsPauseComputeSystem", FnSysOp),
            resume: sym!(lib, "HcsResumeComputeSystem", FnSysOp),
            save: sym!(lib, "HcsSaveComputeSystem", FnSysOp),
            properties: sym!(lib, "HcsGetComputeSystemProperties", FnSysOp),
            modify: sym!(lib, "HcsModifyComputeSystem", FnModify),
            set_callback: sym!(lib, "HcsSetComputeSystemCallback", FnSetCallback),
            service_properties: sym!(lib, "HcsGetServiceProperties", FnServiceProps),
            grant: sym!(lib, "HcsGrantVmAccess", FnAccess),
            revoke: sym!(lib, "HcsRevokeVmAccess", FnAccess),
            enumerate: sym!(lib, "HcsEnumerateComputeSystems", FnEnumerate),
        })
    }

    /// Creates an operation, lets `f` start the call on it, waits up to `timeout_ms` and returns
    /// the result document.
    pub fn run(&self, what: &str, timeout_ms: u32, f: impl FnOnce(Op) -> HRESULT) -> VmResult<String> {
        // SAFETY: a fresh operation without callback; closed on every path.
        let op = unsafe { (self.create_operation)(std::ptr::null(), std::ptr::null()) };
        if op.is_null() {
            return Err(VmError::unavailable("hcs_error", format!("{what}: could not create an HCS operation")));
        }
        let hr = f(op);
        if hr.is_err() {
            // SAFETY: closes the operation created above.
            unsafe { (self.close_operation)(op) };
            return Err(hcs_error(what, hr, ""));
        }
        let mut doc = PWSTR::null();
        // SAFETY: waits on our operation; the document is freed by `wide_string`.
        let hr = unsafe { (self.wait)(op, timeout_ms, &mut doc) };
        let text = wide_string(doc);
        // SAFETY: closes the operation created above.
        unsafe { (self.close_operation)(op) };
        if hr.is_err() {
            return Err(hcs_error(what, hr, &text));
        }
        Ok(text)
    }

    /// `HcsGetServiceProperties` (e.g. `{"PropertyTypes": ["Basic"]}`).
    pub fn service_properties(&self, query: &str) -> VmResult<serde_json::Value> {
        let mut out = PWSTR::null();
        let q = HSTRING::from(query);
        // SAFETY: plain call; the result is freed by `wide_string`.
        let hr = unsafe { (self.service_properties)(PCWSTR(q.as_ptr()), &mut out) };
        let text = wide_string(out);
        if hr.is_err() {
            return Err(hcs_error("HcsGetServiceProperties", hr, &text));
        }
        serde_json::from_str(&text).map_err(|_| VmError::unavailable("hcs_error", "HcsGetServiceProperties returned no JSON"))
    }

    pub fn grant_vm_access(&self, system_id: &str, path: &std::path::Path) -> VmResult<()> {
        let (id, p) = (HSTRING::from(system_id), HSTRING::from(path.as_os_str()));
        // SAFETY: plain call with NUL-terminated strings.
        let hr = unsafe { (self.grant)(PCWSTR(id.as_ptr()), PCWSTR(p.as_ptr())) };
        if hr.is_err() { Err(hcs_error("Granting the VM access", hr, "")) } else { Ok(()) }
    }

    pub fn revoke_vm_access(&self, system_id: &str, path: &std::path::Path) {
        let (id, p) = (HSTRING::from(system_id), HSTRING::from(path.as_os_str()));
        // SAFETY: plain call with NUL-terminated strings.
        let _ = unsafe { (self.revoke)(PCWSTR(id.as_ptr()), PCWSTR(p.as_ptr())) };
    }
}

/// A NUL-terminated wide string that lives as long as the value.
pub struct Wide(pub HSTRING);

impl Wide {
    pub fn new(s: &str) -> Wide {
        Wide(HSTRING::from(s))
    }
    pub fn ptr(&self) -> PCWSTR {
        PCWSTR(self.0.as_ptr())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_map_to_reasons() {
        assert_eq!(hcs_error("x", HRESULT(0x8007_0005u32 as i32), "").reason, "hcs_access_denied");
        assert_eq!(hcs_error("x", HRESULT(0x8037_011Bu32 as i32), "").reason, "hcs_access_denied");
        let e =
            hcs_error("Create", HRESULT(0x8037_0114u32 as i32), r#"{"Error": -2143878892, "ErrorMessage": "The service is unavailable"}"#);
        assert_eq!(e.reason, "hcs_unavailable");
        assert!(e.message.contains("The service is unavailable"));
        assert_eq!(e.details["hresult"], "0x80370114");
        assert_eq!(hcs_error("x", HRESULT(0x8037_0118u32 as i32), "").reason, "hcs_timeout");
    }

    /// Loads the DLL (present when WSL 2 works); the service query needs elevation, so only
    /// the outcome's shape is checked.
    #[test]
    fn computecore_loads_and_answers_or_refuses() {
        match Api::load() {
            Ok(api) => match api.service_properties(r#"{"PropertyTypes":["Basic"]}"#) {
                Ok(v) => assert!(v.is_object()),
                Err(e) => assert!(["hcs_access_denied", "hcs_error", "hcs_unavailable"].contains(&e.reason.as_str()), "{e}"),
            },
            Err(e) => assert_eq!(e.reason, "hcs_unavailable"),
        }
    }
}
