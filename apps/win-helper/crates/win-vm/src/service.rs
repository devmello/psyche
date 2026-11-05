//! Install / uninstall and the SCM service.
//!
//! `install --owner-sid <SID> --home <PSYCHE_HOME> [--images <dir>]` (elevated, one UAC prompt):
//! copies this exe to `%ProgramFiles%\Psyche\vm-service\<SID>\psyche-vm-svc.exe` (admin-only
//! writable: the per-user app folder is not, and a LocalSystem service must not run a binary its
//! user can replace), creates or updates service `PsycheVM-<SID>` ("Psyche sandbox PC",
//! LocalSystem, demand start) with `serve --owner-sid … --home … --images … --profile …`, lets
//! the owner start, stop and query it, and registers the guest's vsock services under
//! `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices`.
//! `uninstall [--owner-sid <SID>]` reverses it; without elevation it prints a note (and writes
//! it to `%LOCALAPPDATA%\Psyche-sandbox-pc-uninstall.txt`) and exits 5, never silently.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;

use serde_json::{Value, json};
use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_SERVICE_DOES_NOT_EXIST, ERROR_SERVICE_NOT_ACTIVE};
use windows::Win32::Security::DACL_SECURITY_INFORMATION;
use windows::Win32::System::Registry::{
    HKEY, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegCloseKey,
    RegCreateKeyExW, RegDeleteTreeW, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, RegSetValueExW,
};
use windows::Win32::System::Services::*;
use windows::core::{HSTRING, PCWSTR, PWSTR};

use crate::error::{VmError, VmResult};
use crate::paths;
use crate::security::SecurityDescriptor;

pub const GUEST_SERVICES_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices";

/// Arguments the service runs with (from its command line).
#[derive(Debug, Clone, PartialEq)]
pub struct ServeArgs {
    pub owner_sid: String,
    pub home: PathBuf,
    pub images: PathBuf,
    pub profile: PathBuf,
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', ""))
}

/// The service's command line.
pub fn command_line(exe: &Path, a: &ServeArgs) -> String {
    format!(
        "{} serve --owner-sid {} --home {} --images {} --profile {}",
        quote(&exe.to_string_lossy()),
        a.owner_sid,
        quote(&a.home.to_string_lossy()),
        quote(&a.images.to_string_lossy()),
        quote(&a.profile.to_string_lossy())
    )
}

/// The service DACL: the defaults plus start / stop / query for the owner.
pub fn service_sddl(owner_sid: &str) -> String {
    format!(
        "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;CCLCSWRPWPLOCRRC;;;{owner_sid})"
    )
}

fn program_files() -> PathBuf {
    std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
}

pub fn installed_exe(owner_sid: &str) -> PathBuf {
    program_files().join("Psyche").join("vm-service").join(owner_sid).join("psyche-vm-svc.exe")
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: closes a key opened here.
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

fn reg_string(root: HKEY, sub: &str, value: &str) -> Option<String> {
    let mut buf = vec![0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    // SAFETY: `buf` holds `len` bytes; expandable strings are expanded by the call.
    let e = unsafe {
        RegGetValueW(
            root,
            &HSTRING::from(sub),
            &HSTRING::from(value),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut c_void),
            Some(&mut len),
        )
    };
    if e.0 != 0 {
        return None;
    }
    let n = (len as usize / 2).saturating_sub(1);
    Some(String::from_utf16_lossy(&buf[..n.min(buf.len())]))
}

/// `HKLM\…\ProfileList\<SID>\ProfileImagePath`.
pub fn profile_of(sid: &str) -> Option<PathBuf> {
    reg_string(HKEY_LOCAL_MACHINE, &format!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\{sid}"), "ProfileImagePath")
        .map(PathBuf::from)
}

pub fn default_images_root(profile: &Path) -> PathBuf {
    profile.join("AppData").join("Local").join("Psyche").join("vm-images")
}

fn set_string(key: HKEY, name: &str, value: &str) -> VmResult<()> {
    let w: Vec<u16> = value.encode_utf16().chain([0]).collect();
    // SAFETY: the data is a NUL-terminated UTF-16 string of the given byte length.
    let e = unsafe {
        RegSetValueExW(key, &HSTRING::from(name), Some(0), REG_SZ, Some(std::slice::from_raw_parts(w.as_ptr() as *const u8, w.len() * 2)))
    };
    if e.0 != 0 { Err(VmError::unavailable("registry", format!("Writing {name} failed ({})", e.0))) } else { Ok(()) }
}

/// Registers the guest's vsock services (Gateway node port, guest agent port).
pub fn register_guest_services() -> VmResult<()> {
    for (port, label) in [
        (crate::manager::GATEWAY_NODE_PORT, "Psyche sandbox PC: Gateway (vsock 7980)"),
        (crate::manager::GUEST_AGENT_PORT, "Psyche sandbox PC: guest agent (vsock 7000)"),
    ] {
        let sub = format!(r"{GUEST_SERVICES_KEY}\{}", crate::hcs::doc::vsock_service_id(port));
        let mut k = HKEY::default();
        // SAFETY: creates or opens the key; closed by `Key`.
        let e = unsafe {
            RegCreateKeyExW(
                HKEY_LOCAL_MACHINE,
                &HSTRING::from(sub.as_str()),
                None,
                None,
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                None,
                &mut k,
                None,
            )
        };
        if e.0 != 0 {
            return Err(VmError::unavailable("registry", format!("Registering the guest services failed ({})", e.0)));
        }
        let key = Key(k);
        set_string(key.0, "ElementName", label)?;
    }
    Ok(())
}

/// Other owners' services (`PsycheVM-*` under `HKLM\SYSTEM\CurrentControlSet\Services`).
fn other_psyche_services(except: &str) -> usize {
    let mut k = HKEY::default();
    // SAFETY: opens the Services key read-only; closed by `Key`.
    if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, &HSTRING::from(r"SYSTEM\CurrentControlSet\Services"), None, KEY_READ, &mut k) }.0 != 0 {
        return 0;
    }
    let key = Key(k);
    let mut count = 0;
    for i in 0.. {
        let mut name = [0u16; 256];
        let mut len = name.len() as u32;
        // SAFETY: `name` holds `len` characters.
        let e = unsafe { RegEnumKeyExW(key.0, i, Some(PWSTR(name.as_mut_ptr())), &mut len, None, None, None, None) };
        if e.0 != 0 {
            break;
        }
        let n = String::from_utf16_lossy(&name[..len as usize]);
        if n.starts_with("PsycheVM-") && !n.eq_ignore_ascii_case(except) {
            count += 1;
        }
    }
    count
}

fn unregister_guest_services() {
    for port in [crate::manager::GATEWAY_NODE_PORT, crate::manager::GUEST_AGENT_PORT] {
        let sub = format!(r"{GUEST_SERVICES_KEY}\{}", crate::hcs::doc::vsock_service_id(port));
        // SAFETY: deletes our own key tree.
        unsafe {
            let _ = RegDeleteTreeW(HKEY_LOCAL_MACHINE, &HSTRING::from(sub.as_str()));
        }
    }
}

struct Sc(SC_HANDLE);
impl Drop for Sc {
    fn drop(&mut self) {
        // SAFETY: closes a handle opened here.
        unsafe {
            let _ = CloseServiceHandle(self.0);
        }
    }
}

fn scm(access: u32) -> VmResult<Sc> {
    // SAFETY: plain call; the handle is owned by `Sc`.
    unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), access) }.map(Sc).map_err(|e| {
        if e.code() == ERROR_ACCESS_DENIED.to_hresult() {
            VmError::new(
                crate::error::Code::Forbidden,
                "elevation_required",
                "Installing or removing the sandbox PC service needs administrator rights",
            )
        } else {
            VmError::unavailable("scm", format!("The Service Control Manager is unavailable: {e}"))
        }
    })
}

fn stop_service(svc: &Sc) {
    let mut st = SERVICE_STATUS::default();
    // SAFETY: plain control call.
    if unsafe { ControlService(svc.0, SERVICE_CONTROL_STOP, &mut st) }.is_err() {
        return;
    }
    for _ in 0..60 {
        // SAFETY: plain query.
        if unsafe { QueryServiceStatus(svc.0, &mut st) }.is_err() || st.dwCurrentState == SERVICE_STOPPED {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

pub fn install(owner_sid: &str, home: &Path, images: Option<&Path>) -> VmResult<Value> {
    if !paths::is_valid_sid(owner_sid) {
        return Err(VmError::invalid_params("owner SID must look like S-1-5-21-…", "ownerSid"));
    }
    let home = PathBuf::from(
        crate::shares::canonical_host_path(&home.to_string_lossy())
            .map_err(|_| VmError::invalid_params("home must be absolute", "home"))?,
    );
    let profile = profile_of(owner_sid).ok_or_else(|| VmError::not_found("unknown_user", format!("No local profile for {owner_sid}")))?;
    let images = images.map(Path::to_path_buf).unwrap_or_else(|| default_images_root(&profile));
    let manager = scm(SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE)?;
    let name = paths::service_name(owner_sid);
    let exe = installed_exe(owner_sid);
    // SAFETY: plain calls; handles owned by `Sc`.
    let existing = unsafe { OpenServiceW(manager.0, &HSTRING::from(name.as_str()), SERVICE_ALL_ACCESS) }.ok().map(Sc);
    if let Some(s) = &existing {
        stop_service(s);
    }
    let me = std::env::current_exe().map_err(|e| VmError::io("exe", &e))?;
    std::fs::create_dir_all(exe.parent().unwrap_or(Path::new("."))).map_err(|e| VmError::io("Program Files", &e))?;
    if !me.as_path().eq(exe.as_path()) {
        // The old binary may still be mapped for a moment after the stop.
        let mut copied = std::fs::copy(&me, &exe);
        for _ in 0..20 {
            if copied.is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
            copied = std::fs::copy(&me, &exe);
        }
        copied.map_err(|e| VmError::io("copying the service binary", &e))?;
    }
    let args = ServeArgs { owner_sid: owner_sid.to_owned(), home, images: images.clone(), profile };
    let cmd = HSTRING::from(command_line(&exe, &args));
    let display = HSTRING::from(paths::SERVICE_DISPLAY_NAME);
    let svc = match existing {
        Some(s) => {
            // SAFETY: updates our own service's configuration.
            unsafe {
                ChangeServiceConfigW(
                    s.0,
                    SERVICE_WIN32_OWN_PROCESS,
                    SERVICE_DEMAND_START,
                    SERVICE_ERROR_NORMAL,
                    &cmd,
                    PCWSTR::null(),
                    None,
                    PCWSTR::null(),
                    PCWSTR::null(),
                    PCWSTR::null(),
                    &display,
                )
            }
            .map_err(|e| VmError::unavailable("scm", format!("Updating the service failed: {e}")))?;
            s
        }
        None => Sc(
            // SAFETY: creates the service (LocalSystem: no account name).
            unsafe {
                CreateServiceW(
                    manager.0,
                    &HSTRING::from(name.as_str()),
                    &display,
                    SERVICE_ALL_ACCESS,
                    SERVICE_WIN32_OWN_PROCESS,
                    SERVICE_DEMAND_START,
                    SERVICE_ERROR_NORMAL,
                    &cmd,
                    PCWSTR::null(),
                    None,
                    PCWSTR::null(),
                    PCWSTR::null(),
                    PCWSTR::null(),
                )
            }
            .map_err(|e| VmError::unavailable("scm", format!("Creating the service failed: {e}")))?,
        ),
    };
    let desc: Vec<u16> = "Runs the Psyche sandbox PC (a Linux virtual machine on the Hyper-V Host Compute Service) for one user."
        .encode_utf16()
        .chain([0])
        .collect();
    let info = SERVICE_DESCRIPTIONW { lpDescription: PWSTR(desc.as_ptr() as *mut u16) };
    // SAFETY: `info` points at a live NUL-terminated string.
    unsafe {
        let _ = ChangeServiceConfig2W(svc.0, SERVICE_CONFIG_DESCRIPTION, Some(&info as *const _ as *const c_void));
    }
    let sd = SecurityDescriptor::from_sddl(&service_sddl(owner_sid))?;
    // SAFETY: applies our descriptor to our own service.
    unsafe { SetServiceObjectSecurity(svc.0, DACL_SECURITY_INFORMATION, sd.0) }
        .map_err(|e| VmError::unavailable("scm", format!("Setting the service's access failed: {e}")))?;
    register_guest_services()?;
    let logs = paths::log_dir();
    let _ = std::fs::create_dir_all(&logs);
    crate::security::protect_admin_dir(&logs, owner_sid);
    Ok(json!({
        "installed": true, "service": name, "exe": exe.to_string_lossy(), "pipe": paths::control_pipe_name(owner_sid),
        "images": images.to_string_lossy(), "logs": logs.to_string_lossy(),
    }))
}

pub fn uninstall(owner_sid: &str) -> VmResult<Value> {
    if !paths::is_valid_sid(owner_sid) {
        return Err(VmError::invalid_params("owner SID must look like S-1-5-21-…", "ownerSid"));
    }
    let manager = scm(SC_MANAGER_CONNECT)?;
    let name = paths::service_name(owner_sid);
    // SAFETY: plain call; handle owned by `Sc`.
    match unsafe {
        OpenServiceW(manager.0, &HSTRING::from(name.as_str()), SERVICE_STOP | SERVICE_QUERY_STATUS | 0x0001_0000 /* DELETE */)
    } {
        Ok(h) => {
            let svc = Sc(h);
            stop_service(&svc);
            // SAFETY: marks our service for deletion.
            unsafe { DeleteService(svc.0) }.map_err(|e| {
                if e.code() == ERROR_ACCESS_DENIED.to_hresult() {
                    VmError::new(
                        crate::error::Code::Forbidden,
                        "elevation_required",
                        "Removing the sandbox PC service needs administrator rights",
                    )
                } else {
                    VmError::unavailable("scm", format!("Deleting the service failed: {e}"))
                }
            })?;
        }
        Err(e) if e.code() == ERROR_SERVICE_DOES_NOT_EXIST.to_hresult() => {}
        Err(e) if e.code() == ERROR_ACCESS_DENIED.to_hresult() => {
            return Err(VmError::new(
                crate::error::Code::Forbidden,
                "elevation_required",
                "Removing the sandbox PC service needs administrator rights",
            ));
        }
        Err(e) => return Err(VmError::unavailable("scm", format!("Opening the service failed: {e}"))),
    }
    let exe = installed_exe(owner_sid);
    let mut removed_exe = false;
    for _ in 0..20 {
        if exe.parent().map(|d| std::fs::remove_dir_all(d).is_ok()).unwrap_or(false) || !exe.exists() {
            removed_exe = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    if other_psyche_services(&name) == 0 {
        unregister_guest_services();
    }
    Ok(json!({"uninstalled": true, "service": name, "removedExe": removed_exe}))
}

/// The note left when uninstall cannot run elevated.
pub fn uninstall_note(owner_sid: &str) -> String {
    format!(
        "Psyche was removed, but its sandbox PC service ({}) needs administrator rights to remove.\r\n\
         Open an administrator command prompt and run:\r\n  \"{}\" uninstall --owner-sid {}\r\n\
         or remove it with: sc.exe delete {}\r\n",
        paths::service_name(owner_sid),
        installed_exe(owner_sid).display(),
        owner_sid,
        paths::service_name(owner_sid)
    )
}

// MARK: SCM

static SERVE_ARGS: Mutex<Option<ServeArgs>> = Mutex::new(None);
static STOP: Mutex<Option<tokio::sync::watch::Sender<bool>>> = Mutex::new(None);
static STATUS: Mutex<Option<usize>> = Mutex::new(None);

fn set_status(state: SERVICE_STATUS_CURRENT_STATE, exit: u32) {
    let Some(h) = *STATUS.lock().unwrap() else { return };
    let st = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING { SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN } else { 0 },
        dwWin32ExitCode: exit,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: 0,
        dwWaitHint: if state == SERVICE_RUNNING || state == SERVICE_STOPPED { 0 } else { 30_000 },
    };
    // SAFETY: the handle came from RegisterServiceCtrlHandlerExW.
    unsafe {
        let _ = SetServiceStatus(SERVICE_STATUS_HANDLE(h as *mut c_void), &st);
    }
}

unsafe extern "system" fn handler(control: u32, _ev: u32, _data: *mut c_void, _ctx: *mut c_void) -> u32 {
    match control {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
            set_status(SERVICE_STOP_PENDING, 0);
            if let Some(tx) = STOP.lock().unwrap().as_ref() {
                let _ = tx.send(true);
            }
            0
        }
        SERVICE_CONTROL_INTERROGATE => 0,
        _ => 120, // ERROR_CALL_NOT_IMPLEMENTED
    }
}

unsafe extern "system" fn service_main(_argc: u32, _argv: *mut PWSTR) {
    let Some(args) = SERVE_ARGS.lock().unwrap().clone() else { return };
    let name = HSTRING::from(paths::service_name(&args.owner_sid));
    // SAFETY: registers our handler for this service.
    let Ok(h) = (unsafe { RegisterServiceCtrlHandlerExW(&name, Some(handler), None) }) else { return };
    *STATUS.lock().unwrap() = Some(h.0 as usize);
    set_status(SERVICE_START_PENDING, 0);
    let (tx, rx) = tokio::sync::watch::channel(false);
    *STOP.lock().unwrap() = Some(tx);
    let code = match run(args, rx, Backend::Hcs, None, std::time::Duration::from_secs(600), || set_status(SERVICE_RUNNING, 0)) {
        Ok(()) => 0,
        Err(e) => {
            crate::log::error(&format!("service failed: {e}"));
            1
        }
    };
    set_status(SERVICE_STOPPED, code);
}

/// `serve`: hands the process to the SCM.
pub fn serve(args: ServeArgs) -> VmResult<()> {
    crate::log::init_file(paths::log_dir().join(format!("{}.log", args.owner_sid)));
    *SERVE_ARGS.lock().unwrap() = Some(args.clone());
    let name: Vec<u16> = paths::service_name(&args.owner_sid).encode_utf16().chain([0]).collect();
    let table = [
        SERVICE_TABLE_ENTRYW { lpServiceName: PWSTR(name.as_ptr() as *mut u16), lpServiceProc: Some(service_main) },
        SERVICE_TABLE_ENTRYW::default(),
    ];
    // SAFETY: the table outlives the dispatcher (it returns when the service stops).
    unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) }
        .map_err(|e| VmError::unavailable("scm", format!("Not started by the Service Control Manager: {e}")))
}

/// Starts the owner's service (the helper does this on first use; the owner may).
pub fn start_installed(owner_sid: &str) -> VmResult<()> {
    let manager = scm(SC_MANAGER_CONNECT)?;
    // SAFETY: plain calls; handle owned by `Sc`.
    let svc =
        unsafe { OpenServiceW(manager.0, &HSTRING::from(paths::service_name(owner_sid).as_str()), SERVICE_START | SERVICE_QUERY_STATUS) }
            .map(Sc)
            .map_err(|e| VmError::not_found("service_not_installed", format!("The sandbox PC service is not installed: {e}")))?;
    // SAFETY: plain call.
    match unsafe { StartServiceW(svc.0, None) } {
        Ok(()) => Ok(()),
        Err(e) if e.code().0 as u32 == 0x8007_0420 => Ok(()), // ERROR_SERVICE_ALREADY_RUNNING
        Err(e) if e.code() == ERROR_SERVICE_NOT_ACTIVE.to_hresult() => Ok(()),
        Err(e) => Err(VmError::unavailable("service_start_failed", format!("Starting the service failed: {e}"))),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Hcs,
    Fake,
}

/// Runs the control pipe until stopped or idle. `ready` runs once the pipe is listening.
pub fn run(
    args: ServeArgs,
    mut stop: tokio::sync::watch::Receiver<bool>,
    backend: Backend,
    pipe: Option<String>,
    idle: std::time::Duration,
    ready: impl FnOnce(),
) -> VmResult<()> {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| VmError::internal(e.to_string()))?;
    let backend_impl: Arc<dyn crate::backend::VmBackend> = match backend {
        Backend::Hcs => Arc::new(crate::hcs::HcsBackend::new(&args.owner_sid)),
        Backend::Fake => Arc::new(crate::backend::fake::FakeBackend::default()),
    };
    let disks: Arc<dyn crate::vhd::DiskOps> = match backend {
        Backend::Hcs => Arc::new(crate::vhd::VirtDisk),
        Backend::Fake => Arc::new(crate::vhd::FakeDisks),
    };
    let owner = Arc::new(crate::server::CachedOwner::default());
    let roots = sensitive_roots(&args);
    let home = args.home.clone();
    let manager = crate::manager::Manager::new(
        crate::manager::ManagerConfig {
            home: args.home.clone(),
            images_root: args.images.clone(),
            owner_sid: args.owner_sid.clone(),
            roots,
            version: env!("CARGO_PKG_VERSION").into(),
        },
        backend_impl,
        disks,
        Arc::new(crate::pipeclient::GatewayPipe { owner_sid: args.owner_sid.clone() }),
        owner.clone(),
        Box::new(move || crate::win::host_resources(&home)),
    );
    let activity = Arc::new(crate::server::Activity::default());
    let server = Arc::new(crate::server::Server {
        pipe_name: pipe.unwrap_or_else(|| paths::control_pipe_name(&args.owner_sid)),
        owner_sid: args.owner_sid.clone(),
        manager: manager.clone(),
        owner,
        activity: activity.clone(),
        require_impersonation: true,
    });
    crate::log::info(&format!(
        "service starting backend={backend:?} hcs={}",
        manager.backend().unavailable_reason().map(|e| e.reason).unwrap_or_else(|| "available".into())
    ));
    let result = rt.block_on(async {
        let (srv_stop_tx, srv_stop_rx) = tokio::sync::watch::channel(false);
        let srv = tokio::spawn(server.run(srv_stop_rx));
        ready();
        tokio::select! {
            _ = stop.changed() => {}
            _ = crate::server::idle_watch(manager.clone(), activity, idle, std::time::Duration::from_secs(15)) => {}
        }
        let _ = srv_stop_tx.send(true);
        match srv.await {
            Ok(r) => r.map_err(|e| VmError::unavailable("pipe", format!("Control pipe failed: {e}"))),
            Err(e) => Err(VmError::internal(e.to_string())),
        }
    });
    manager.stop_all();
    crate::log::info("service stopped");
    result
}

pub fn sensitive_roots(args: &ServeArgs) -> crate::shares::SensitiveRoots {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_owned());
    let canon = |p: &str| {
        crate::shares::canonical_host_path(p).map(|c| crate::shares::resolve_existing(&c).unwrap_or(c)).unwrap_or_else(|_| p.to_owned())
    };
    crate::shares::SensitiveRoots::new(
        &canon(&args.profile.to_string_lossy()),
        &canon(&args.home.to_string_lossy()),
        &canon(&env("SystemRoot", r"C:\Windows")),
        &[canon(&env("ProgramW6432", r"C:\Program Files")), canon(&env("ProgramFiles(x86)", r"C:\Program Files (x86)"))],
        &canon(&env("ProgramData", r"C:\ProgramData")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_and_sddl() {
        let a = ServeArgs {
            owner_sid: "S-1-5-21-1-2-3-1001".into(),
            home: r"C:\Users\o\.psyche".into(),
            images: r"C:\Users\o\AppData\Local\Psyche\vm-images".into(),
            profile: r"C:\Users\o".into(),
        };
        let c = command_line(Path::new(r"C:\Program Files\Psyche\vm-service\S-1-5-21-1-2-3-1001\psyche-vm-svc.exe"), &a);
        assert_eq!(
            c,
            r#""C:\Program Files\Psyche\vm-service\S-1-5-21-1-2-3-1001\psyche-vm-svc.exe" serve --owner-sid S-1-5-21-1-2-3-1001 --home "C:\Users\o\.psyche" --images "C:\Users\o\AppData\Local\Psyche\vm-images" --profile "C:\Users\o""#
        );
        let s = service_sddl("S-1-5-21-1-2-3-1001");
        assert!(s.ends_with("(A;;CCLCSWRPWPLOCRRC;;;S-1-5-21-1-2-3-1001)"));
        SecurityDescriptor::from_sddl(&service_sddl(&crate::security::current_user_sid().unwrap())).unwrap();
        assert!(installed_exe("S-1-5-21-9").ends_with(r"Psyche\vm-service\S-1-5-21-9\psyche-vm-svc.exe"));
        assert!(uninstall_note("S-1-5-21-9").contains("sc.exe delete PsycheVM-S-1-5-21-9"));
    }

    #[test]
    fn profile_lookup_and_defaults() {
        let me = crate::security::current_user_sid().unwrap();
        let p = profile_of(&me).unwrap();
        assert!(p.is_dir());
        assert!(default_images_root(&p).ends_with(r"AppData\Local\Psyche\vm-images"));
        assert!(profile_of("S-1-5-21-0-0-0-0").is_none());
    }

    /// Without elevation the SCM refuses: the error must say so (the desktop shows a note).
    #[test]
    fn install_without_elevation_is_refused_clearly() {
        if crate::security::is_elevated() {
            return;
        }
        let me = crate::security::current_user_sid().unwrap();
        let e = install(&me, &std::env::temp_dir(), None).unwrap_err();
        assert_eq!(e.reason, "elevation_required");
        assert_eq!(install("bogus", Path::new(r"C:\x"), None).unwrap_err().details["field"], "ownerSid");
    }
}
